import { assertDraftVersion, draftVersion } from './admin-save-state.js';
import { applySuggestionAdopt, applySuggestionUnadopt } from './admin-candidate-state.js';
import { decodeDraftRecord } from './admin-draft-record.js';
import { cleanPlanning } from './trip-v2-core.js';
import { validateStoredDraftSize } from './draft-validation.js';

// Check the loaded version and commit every related write atomically.
export async function commitTripRecord({ db, runTransaction, reference, expectedVersion, data, writes = [], checks = [] }) {
  await runTransaction(db, async transaction => {
    const latest = await transaction.get(reference);
    assertDraftVersion(latest.exists() ? latest.data() : null, expectedVersion);
    for (const check of checks) {
      const snapshot = await transaction.get(check.reference);
      const actual = snapshot.exists() ? snapshot.data() : null;
      if (!actual || Object.entries(check.fields).some(([key, value]) => actual[key] !== value)) {
        const error = new Error('公開対象の配布設定が変更されています。最新状態で再試行してください。');
        error.code = 'distribution-conflict';
        throw error;
      }
    }
    transaction.set(reference, data, { merge: true });
    for (const write of writes) transaction.set(write.reference, write.data, { merge: write.merge === true });
  });
  return draftVersion(data);
}

function snapExists(snap) {
  if (!snap) return false;
  return typeof snap.exists === 'function' ? snap.exists() : Boolean(snap.exists);
}

function refPath(ref) { return typeof ref === 'string' ? ref : ref?.path; }
function scopeError() { const error = new Error('配布先・旅行・提案の参照が一致しないか、有効な配布ではありません。'); error.code = 'distribution-conflict'; return error; }
function segment(value) { return typeof value === 'string' && value.length > 0 && !value.includes('/'); }

async function checkSuggestionScope(tx, { db, doc, roomId, roomRef, suggestionRef, adminTripRef, tripId }) {
  if (typeof doc !== 'function' || !segment(roomId) || !segment(tripId) ||
      refPath(roomRef) !== `rooms/${roomId}` ||
      (adminTripRef && refPath(adminTripRef) !== `adminTrips/${tripId}`)) throw scopeError();
  const suggestionId = refPath(suggestionRef)?.split('/').at(-1);
  if (!segment(suggestionId) || refPath(suggestionRef) !== `rooms/${roomId}/suggestions/${suggestionId}`) throw scopeError();
  const room = await tx.get(roomRef);
  const distribution = await tx.get(doc(db, 'adminDistributions', roomId));
  if (!snapExists(room) || !snapExists(distribution)) throw scopeError();
  const r = room.data(), d = distribution.data();
  if (r.status !== 'active' || d.status !== 'active' || r.tripId !== tripId || d.tripId !== tripId ||
      d.roomId !== roomId || !segment(d.ledgerToken) || roomId !== `${tripId}_${d.ledgerToken}` ||
      !segment(d.grantId) || r.accessIdHash !== d.grantId) throw scopeError();
  const grant = await tx.get(doc(db, 'accessGrants', d.grantId));
  if (!snapExists(grant)) throw scopeError();
  const g = grant.data();
  if (g.status !== 'active' || g.tripId !== tripId || g.roomId !== roomId || g.ledgerToken !== d.ledgerToken) throw scopeError();
  const suggestion = await tx.get(suggestionRef);
  if (!snapExists(suggestion)) throw new Error('採用元提案が存在しません。');
  const data = suggestion.data();
  if (data.id !== suggestionId) throw scopeError();
  return data;
}

async function readSuggestionDraft(tx, args) {
  const path = refPath(args.adminTripRef);
  if (!path || !/^adminTrips\/[^/]+$/.test(path)) throw scopeError();
  const tripId = path.split('/')[1];
  const snap = await tx.get(args.adminTripRef);
  if (!snapExists(snap)) throw new Error('下書きデータが存在しません。');
  const data = snap.data();
  const decoded = decodeDraftRecord(data, tripId);
  if (data.tripId !== tripId) throw scopeError();
  const suggestion = await checkSuggestionScope(tx, { ...args, tripId });
  return { data, ...decoded, suggestion };
}

function makePlanningUpdate(data, planning, nowIso, revision) {
  const planningJson = JSON.stringify(planning);
  const errors = validateStoredDraftSize({ payloadJson: data.payloadJson, planningJson });
  if (errors.length) throw new Error(errors.join('\n'));
  // Validate the complete saved record, not just its byte size.
  decodeDraftRecord({ ...data, planningJson }, data.tripId);
  return { planningJson, revision, updatedAt: nowIso };
}

export async function adoptSuggestionTransaction(args) {
  const { db, runTransaction, adminTripRef, expectedVersion, roomId, suggestionRef } = args;
  const nowIso = args.adoptedAt || new Date().toISOString();
  const revision = crypto.randomUUID();
  return runTransaction(db, async tx => {
    const { data, trip, planning, suggestion } = await readSuggestionDraft(tx, args);
    const matches = planning.candidates.filter(c => c.sourceSuggestion?.roomId === roomId && c.sourceSuggestion?.suggestionId === suggestion.id);
    if (matches.length > 1) throw new Error('採用元が重複しています。候補を確認してください。');
    if (suggestion.status === 'adopted' && matches.length === 1) {
      if (args.candidateId && matches[0].id !== args.candidateId) throw new Error('採用候補IDが一致しません。');
      return { trip, planning, candidate: matches[0], newVersion: draftVersion(data), isIdempotentReplay: true };
    }
    assertDraftVersion(data, expectedVersion);
    const adopted = applySuggestionAdopt({ planning, suggestion, roomId, candidateId: args.candidateId, adoptedAt: args.adoptedAt || nowIso });
    if (!adopted.ok) throw new Error(adopted.error);
    adopted.planning = cleanPlanning(adopted.planning);
    adopted.candidate = adopted.planning.candidates.find(c => c.id === adopted.candidate.id);
    const update = makePlanningUpdate(data, adopted.planning, nowIso, revision);
    tx.set(adminTripRef, update, { merge: true });
    tx.update(suggestionRef, { status: 'adopted', updatedAt: nowIso });
    return { trip, planning: adopted.planning, candidate: adopted.candidate, newVersion: draftVersion({ ...data, ...update }) };
  });
}

function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
}

export async function unadoptSuggestionTransaction(args) {
  const { db, runTransaction, adminTripRef, expectedVersion, roomId, suggestionRef, candidateId } = args;
  if (args.confirmed !== true || !args.expectedCandidate) throw new Error('採用取消する候補を確認してください。');
  const nowIso = new Date().toISOString();
  const revision = crypto.randomUUID();
  return runTransaction(db, async tx => {
    const { data, trip, planning, suggestion } = await readSuggestionDraft(tx, args);
    assertDraftVersion(data, expectedVersion);
    const candidate = planning.candidates.find(c => c.id === candidateId);
    if (!sameValue(candidate, args.expectedCandidate)) throw new Error('確認後に候補が変更されています。読み直して再確認してください。');
    const removed = applySuggestionUnadopt({ trip, planning, candidateId, suggestion, roomId });
    if (!removed.ok) throw new Error(removed.error);
    const update = makePlanningUpdate(data, removed.planning, nowIso, revision);
    tx.set(adminTripRef, update, { merge: true });
    if (suggestion.status === 'adopted') tx.update(suggestionRef, { status: 'open', updatedAt: nowIso });
    return { trip, planning: removed.planning, removedCandidate: removed.removedCandidate, newVersion: draftVersion({ ...data, ...update }) };
  });
}

export async function changeSuggestionStatusTransaction(args) {
  const { db, runTransaction, suggestionRef, nextStatus } = args;
  if (!['open', 'declined'].includes(nextStatus)) throw new Error('ステータス直接変更は open または declined のみ許可されています。');
  return runTransaction(db, async tx => {
    const current = await checkSuggestionScope(tx, args);
    if (!['open', 'declined'].includes(current.status)) throw new Error('採用済み・取下げ済みの提案のステータスは直接変更できません。');
    if (current.status === nextStatus) return current;
    const update = { status: nextStatus, updatedAt: new Date().toISOString() };
    tx.update(suggestionRef, update);
    return { ...current, ...update };
  });
}

export async function cleanupRoomSuggestionsAndComments({
  db,
  roomId,
  getDocs,
  collection,
  deleteDoc,
  writeBatch,
  query,
  limit,
  batchLimit = 400
}) {
  let deletedSuggestions = 0;
  let deletedComments = 0;

  const suggestionsCol = collection(db, 'rooms', roomId, 'suggestions');
  let hasMore = true;

  while (hasMore) {
    const sugQuery = query && limit ? query(suggestionsCol, limit(batchLimit)) : suggestionsCol;
    const sugSnap = await getDocs(sugQuery);
    if (sugSnap.empty) {
      break;
    }

    for (const sugDoc of sugSnap.docs) {
      const commentsCol = collection(db, 'rooms', roomId, 'suggestions', sugDoc.id, 'comments');
      let commentsRemaining = true;

      while (commentsRemaining) {
        const comQuery = query && limit ? query(commentsCol, limit(batchLimit)) : commentsCol;
        const comSnap = await getDocs(comQuery);
        if (comSnap.empty) {
          commentsRemaining = false;
          break;
        }

        const batch = writeBatch(db);
        let count = 0;
        for (const comDoc of comSnap.docs) {
          batch.delete(comDoc.ref);
          count++;
          if (count >= batchLimit) break;
        }
        await batch.commit();
        deletedComments += count;
        if (comSnap.docs.length < batchLimit) {
          commentsRemaining = false;
        }
      }

      // コメント削除後に親の提案を削除
      await deleteDoc(sugDoc.ref);
      deletedSuggestions++;
    }

    // 次のページ確認
    const nextCheck = await getDocs(sugQuery);
    if (nextCheck.empty) {
      hasMore = false;
    }
  }

  return { deletedSuggestions, deletedComments };
}

export const KNOWN_MEMBERS_DOC_ID = 'admin_known_members_v1';
const VALID_MEMBER_UID = /^[A-Za-z0-9_-]{6,128}$/;
const GENERIC_NICKNAMES = new Set(['', '名無し', '参加者情報のない端末']);

export async function computeParticipantInboxGrantId(uid, sha256Fn) {
  const cleanUid = String(uid || '').trim();
  if (!VALID_MEMBER_UID.test(cleanUid)) throw new Error('無効な参加者端末IDです。');
  if (typeof sha256Fn !== 'function') throw new Error('ハッシュ関数が指定されていません。');
  return sha256Fn(`shiori-member-inbox-v1:${cleanUid}`);
}

export function collectKnownParticipants(distributions = [], savedDirectory = {}, excludeTripId = '') {
  const byUid = new Map();
  const upsert = (uid, info) => {
    const cleanUid = String(uid || '').trim();
    if (!VALID_MEMBER_UID.test(cleanUid)) return;
    const nick = String(info.nickname || '').trim().slice(0, 40);
    const prev = byUid.get(cleanUid);
    const hasRealNick = !GENERIC_NICKNAMES.has(nick);
    const prevHasRealNick = prev && !GENERIC_NICKNAMES.has(prev.nickname);
    const ts = Number(info.lastActiveMs) || 0;
    if (!prev) {
      byUid.set(cleanUid, {
        uid: cleanUid,
        nickname: hasRealNick ? nick : '',
        lastTripId: String(info.lastTripId || ''),
        lastLabel: String(info.lastLabel || ''),
        lastActiveMs: ts,
        isRecent: Boolean(info.isRecent)
      });
      return;
    }
    const newer = ts >= prev.lastActiveMs;
    if (hasRealNick && (newer || !prevHasRealNick)) prev.nickname = nick;
    if (newer && info.lastTripId) {
      prev.lastTripId = String(info.lastTripId);
      prev.lastLabel = String(info.lastLabel || prev.lastLabel);
    }
    if (ts > prev.lastActiveMs) prev.lastActiveMs = ts;
    if (info.isRecent) prev.isRecent = true;
  };

  if (savedDirectory && typeof savedDirectory === 'object') {
    Object.entries(savedDirectory).forEach(([uid, entry]) => {
      if (entry && typeof entry === 'object') upsert(uid, entry);
    });
  }

  const sortedDists = [...(Array.isArray(distributions) ? distributions : [])]
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  const recentSource = sortedDists.find(d => (!excludeTripId || d.tripId !== excludeTripId) && (
    (Array.isArray(d.participants) && d.participants.length > 0) ||
    (d.sharedMembers && Object.keys(d.sharedMembers).length > 0)
  ));

  sortedDists.forEach(dist => {
    const isRecent = Boolean(recentSource && dist.id === recentSource.id);
    const distTs = (dist.createdAt?.seconds || 0) * 1000;
    const shared = (dist.sharedMembers && typeof dist.sharedMembers === 'object') ? dist.sharedMembers : {};
    Object.entries(shared).forEach(([uid, meta]) => {
      const parsedTs = Date.parse(meta?.sharedAt || '') || distTs;
      upsert(uid, { nickname: meta?.nickname, lastTripId: dist.tripId, lastLabel: dist.label, lastActiveMs: parsedTs, isRecent });
    });
    (Array.isArray(dist.participants) ? dist.participants : []).forEach(p => {
      const pTs = (p.lastActive?.seconds || p.joinedAt?.seconds || 0) * 1000 || distTs;
      upsert(p.uid, { nickname: p.nickname, lastTripId: dist.tripId, lastLabel: dist.label, lastActiveMs: pTs, isRecent });
    });
  });

  return [...byUid.values()]
    .filter(item => item.nickname)
    .sort((a, b) => (Number(b.isRecent) - Number(a.isRecent)) || (b.lastActiveMs - a.lastActiveMs) || a.nickname.localeCompare(b.nickname, 'ja'));
}

export async function syncKnownParticipantsDirectory({ db, doc, getDoc, setDoc, serverTimestamp, knownList = [], existingDirectory = null }) {
  const ref = doc(db, 'accessGrants', KNOWN_MEMBERS_DOC_ID);
  let base = existingDirectory;
  if (!base) {
    const snap = await getDoc(ref);
    base = (snapExists(snap) && snap.data()?.members && typeof snap.data().members === 'object') ? snap.data().members : {};
  }
  const merged = { ...base };
  let changed = false;
  knownList.forEach(item => {
    if (!item?.uid || !VALID_MEMBER_UID.test(item.uid) || !item.nickname) return;
    const cur = merged[item.uid];
    const nextEntry = {
      nickname: String(item.nickname).slice(0, 40),
      lastTripId: String(item.lastTripId || cur?.lastTripId || '').slice(0, 40),
      lastLabel: String(item.lastLabel || cur?.lastLabel || '').slice(0, 40),
      lastActiveMs: Math.max(Number(item.lastActiveMs) || 0, Number(cur?.lastActiveMs) || 0)
    };
    if (!cur || cur.nickname !== nextEntry.nickname || cur.lastTripId !== nextEntry.lastTripId || cur.lastActiveMs < nextEntry.lastActiveMs) {
      merged[item.uid] = nextEntry;
      changed = true;
    }
  });
  if (changed) {
    await setDoc(ref, {
      kind: 'knownMembersDirectory',
      status: 'directory',
      members: merged,
      updatedAt: serverTimestamp()
    }, { merge: true });
  }
  return merged;
}

export async function pushDistributionToMembers({
  db, doc, runTransaction, serverTimestamp, sha256Fn, distribution, membersToShare = [], adminUid = 'admin'
}) {
  const roomId = String(distribution?.roomId || distribution?.id || '').trim();
  const distId = String(distribution?.id || roomId).trim();
  if (!segment(roomId) || !segment(distId)) throw new Error('配布先IDが不正です。');
  const seen = new Set();
  const targets = [];
  for (const m of membersToShare) {
    const uid = String(m?.uid || '').trim();
    if (!VALID_MEMBER_UID.test(uid) || seen.has(uid)) continue;
    seen.add(uid);
    const inboxId = await computeParticipantInboxGrantId(uid, sha256Fn);
    targets.push({ uid, nickname: String(m?.nickname || '参加者').trim().slice(0, 40) || '参加者', inboxId });
  }
  if (!targets.length) throw new Error('共有するメンバーを1名以上選択してください。');

  const nowIso = new Date().toISOString();
  const roomRef = doc(db, 'rooms', roomId);
  const distRef = doc(db, 'adminDistributions', distId);
  const inboxRefs = targets.map(t => doc(db, 'accessGrants', t.inboxId));

  return runTransaction(db, async tx => {
    const [roomSnap, distSnap, ...inboxSnaps] = await Promise.all([
      tx.get(roomRef),
      tx.get(distRef),
      ...inboxRefs.map(r => tx.get(r))
    ]);
    if (!snapExists(roomSnap) || !snapExists(distSnap)) throw new Error('配布ルームが見つかりません。');
    const roomData = roomSnap.data() || {};
    const distData = distSnap.data() || {};
    if (roomData.status !== 'active' || distData.status !== 'active') {
      throw new Error('有効な配布先のみ直接共有できます。再開してから実行してください。');
    }
    const tripId = String(distData.tripId || distribution.tripId || '');
    const ledgerToken = String(distData.ledgerToken || distribution.ledgerToken || '');
    const accessId = String(distData.accessId || distribution.accessId || '');
    const grantId = String(distData.grantId || distribution.grantId || '');
    if (!tripId || !ledgerToken || !accessId || !grantId) {
      throw new Error('この配布先には配布ID情報がないため直接共有できません。新しく発行してください。');
    }

    const roomMembers = { ...(roomData.members || {}) };
    const sharedMembers = { ...(distData.sharedMembers || {}) };
    targets.forEach(t => {
      roomMembers[t.uid] = true;
      sharedMembers[t.uid] = { nickname: t.nickname, sharedAt: nowIso };
    });

    const totalDevices = Object.keys(roomMembers).length;
    if (totalDevices > 50) throw new Error('1つの配布先に登録できる上限（50台）を超えています。');
    const currentCap = Number.isInteger(Number(roomData.capacity)) ? Number(roomData.capacity) : 2;
    const nextCapacity = Math.max(currentCap, totalDevices);

    tx.update(roomRef, { members: roomMembers, capacity: nextCapacity, updatedAt: serverTimestamp() });
    tx.update(distRef, { sharedMembers, capacity: nextCapacity, updatedAt: serverTimestamp() });

    targets.forEach((t, idx) => {
      const prev = snapExists(inboxSnaps[idx]) ? (inboxSnaps[idx].data() || {}) : {};
      const prevItems = (prev.items && typeof prev.items === 'object') ? prev.items : {};
      tx.set(inboxRefs[idx], {
        kind: 'participantInbox',
        targetUid: t.uid,
        status: 'active',
        items: {
          ...prevItems,
          [roomId]: {
            tripId,
            roomId,
            ledgerToken,
            accessId,
            grantId,
            label: String(distData.label || distribution.label || '').slice(0, 40),
            sharedAt: nowIso
          }
        },
        updatedAt: serverTimestamp(),
        updatedBy: String(adminUid || 'admin')
      });
    });

    return { sharedCount: targets.length, capacity: nextCapacity, sharedUids: targets.map(t => t.uid) };
  });
}

export async function revokeMemberInboxEntries({ db, doc, getDoc, setDoc, serverTimestamp, sha256Fn, uids = [], roomId }) {
  const cleanRoomId = String(roomId || '').trim();
  if (!segment(cleanRoomId)) return 0;
  let updated = 0;
  for (const rawUid of new Set(uids)) {
    const uid = String(rawUid || '').trim();
    if (!VALID_MEMBER_UID.test(uid)) continue;
    try {
      const inboxId = await computeParticipantInboxGrantId(uid, sha256Fn);
      const ref = doc(db, 'accessGrants', inboxId);
      const snap = await getDoc(ref);
      if (!snapExists(snap)) continue;
      const data = snap.data() || {};
      const items = (data.items && typeof data.items === 'object') ? { ...data.items } : {};
      if (!Object.prototype.hasOwnProperty.call(items, cleanRoomId)) continue;
      delete items[cleanRoomId];
      await setDoc(ref, {
        kind: 'participantInbox',
        targetUid: uid,
        status: 'active',
        items,
        updatedAt: serverTimestamp()
      });
      updated++;
    } catch {
      // Best-effort cleanup; accessGrants/{grantId} revocation still enforces security.
    }
  }
  return updated;
}
