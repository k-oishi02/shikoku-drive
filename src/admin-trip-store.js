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
    const adopted = applySuggestionAdopt({ planning, suggestion, roomId, candidateId: args.candidateId, adoptedAt: nowIso });
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
