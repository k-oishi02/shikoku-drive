/**
 * Admin Distribution View Controller (View 03: DISTRIBUTE)
 * Manages access ID generation, real-time listeners, shared ledger, device removal & deletion.
 */
import {
  collection, doc, getDoc, getDocs, onSnapshot, runTransaction,
  serverTimestamp, writeBatch, deleteDoc, query, limit
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import {
  $, makeElement, showToast, setBusy, copyText,
  formatTimestamp, formatYen, formatAccessId, randomToken, randomAccessId, sha256, text
} from './admin-ui.js';
import { cleanupRoomSuggestionsAndComments } from './admin-trip-store.js';
import { renderDistributionLedger, deleteDocumentsInChunks, clearDistributionLedger } from './admin-distribution-ledger.js';

const btn = (cls, txt, fn, dis = false) => {
  const b = makeElement('button', cls, txt);
  b.type = 'button'; b.disabled = dis;
  if (fn) b.addEventListener('click', fn);
  return b;
};

export function populateTripSelects(store) {
  const select = $('distribution-trip');
  if (!select) return;
  const selected = select.value;
  select.replaceChildren();
  [...store.getState().trips.entries()].sort((a, b) => text(a[1].trip.startDate).localeCompare(text(b[1].trip.startDate)))
    .forEach(([id, rec]) => {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = `${rec.trip.title} (${id})`;
      select.append(opt);
    });
  if (select.querySelector(`option[value="${selected}"]`)) select.value = selected;
}

export function openDistribution(store, tripId = '', showView) {
  if (typeof showView === 'function' && showView('distribution') === false) return;
  if (tripId && store.getState().trips.has(tripId) && $('distribution-trip')) $('distribution-trip').value = tripId;
}

export function startDistributionListener(db, store, callbacks = {}) {
  const state = store.getState();
  state.distributionsUnsubscribe?.();
  state.distributionsUnsubscribe = onSnapshot(collection(db, 'adminDistributions'), snapshot => {
    const prevParts = new Map(state.distributions.map(i => [i.id, i.participants || []]));
    const prevRooms = new Map(state.distributions.map(i => [i.id, i.roomMembers || []]));
    const prevReady = new Map(state.distributions.map(i => [i.id, i.roomReady === true]));
    const prevExp = new Map(state.distributions.map(i => [i.id, i.expenses || []]));
    const prevExpSt = new Map(state.distributions.map(i => [i.id, { ready: i.expensesReady === true, error: i.expensesError || '' }]));
    state.distributions = snapshot.docs.map(item => ({
      id: item.id, ...item.data(),
      participants: prevParts.get(item.id) || [], roomMembers: prevRooms.get(item.id) || [],
      roomReady: prevReady.get(item.id) === true, expenses: prevExp.get(item.id) || [],
      expensesReady: prevExpSt.get(item.id)?.ready === true, expensesError: prevExpSt.get(item.id)?.error || ''
    })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderDistributions(db, store, callbacks);
  }, error => { console.error(error); showToast('配布先一覧を取得できませんでした。', true); });
}

export const participantAppUrl = () => {
  const u = new URL('./', window.location.href);
  u.search = ''; u.hash = ''; return u.toString();
};

export const participantRegistrationUrl = accessId => {
  const u = new URL('./', window.location.href);
  u.search = ''; u.hash = `join=${encodeURIComponent(text(accessId).toUpperCase().replace(/[^A-Z0-9]/g, ''))}`;
  return u.toString();
};

export const normalizeParticipantName = v => text(v).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ja-JP');

export async function createDistribution(db, store) {
  const state = store.getState(), tripId = $('distribution-trip').value, label = $('distribution-label').value.trim(), capacity = Number($('distribution-capacity').value);
  if (!tripId || !state.trips.has(tripId)) return showToast('配布する旅行を選択してください。', true);
  if (!label || label.length > 40) return showToast('配布先名は1〜40文字で入力してください。', true);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) return showToast('端末枠は1〜50台の整数で入力してください。', true);
  if (!state.publishedIds.has(tripId)) return showToast('配布IDを発行する前に、この旅行を参加者へ公開してください。', true);
  const button = $('create-distribution'); setBusy(button, true, '発行中…');
  const ledgerToken = randomToken(), roomId = `${tripId}_${ledgerToken}`, trip = state.publishedTrips.get(tripId);
  if (!trip) { showToast('公開済みデータを取得できません。旅行をもう一度公開してください。', true); setBusy(button, false); return; }
  try {
    let accessId = '', grantId = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      accessId = randomAccessId(); grantId = await sha256(accessId);
      if (!(await getDoc(doc(db, 'accessGrants', grantId))).exists()) break;
      accessId = '';
    }
    if (!accessId) throw new Error('配布IDを生成できませんでした。もう一度お試しください。');
    const batch = writeBatch(db);
    batch.set(doc(db, 'rooms', roomId), { schemaVersion: 2, tripId, label, status: 'active', capacity, members: {}, accessIdHash: grantId, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: state.currentUser.uid });
    batch.set(doc(db, 'adminDistributions', roomId), { roomId, tripId, label, ledgerToken, accessId, grantId, status: 'active', capacity, createdAt: serverTimestamp(), createdBy: state.currentUser.uid });
    batch.set(doc(db, 'accessGrants', grantId), { tripId, roomId, ledgerToken, status: 'active', title: trip.title, payloadJson: JSON.stringify(trip), createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: state.currentUser.uid });
    await batch.commit();
    $('distribution-label').value = '';
    showToast(`配布ID ${formatAccessId(accessId)} を発行しました。登録リンクを配布先カードからコピーできます。`);
  } catch (error) { console.error(error); showToast(`配布IDを発行できません: ${error.message}`, true); }
  finally { setBusy(button, false); }
}

export function subscribeDistributionParticipants(db, store, distribution, callbacks = {}) {
  const state = store.getState();
  if (state.participantUnsubscribers.has(distribution.id)) return;
  const ref = collection(db, 'rooms', distribution.roomId || distribution.id, 'participants');
  state.participantUnsubscribers.set(distribution.id, onSnapshot(ref, snap => {
    const cur = state.distributions.find(i => i.id === distribution.id);
    if (cur) cur.participants = snap.docs.map(i => ({ uid: i.id, ...i.data() }));
    renderDistributions(db, store, callbacks);
  }, err => console.warn('participants/' + distribution.id, err)));
}

export function subscribeDistributionRoom(db, store, distribution, callbacks = {}) {
  const state = store.getState();
  if (state.roomUnsubscribers.has(distribution.id)) return;
  const ref = doc(db, 'rooms', distribution.roomId || distribution.id);
  state.roomUnsubscribers.set(distribution.id, onSnapshot(ref, snap => {
    const cur = state.distributions.find(i => i.id === distribution.id);
    if (cur) {
      const roomData = snap.data() || {};
      cur.roomMembers = Object.keys(roomData.members || {});
      cur.roomReady = true;
      cur.capacity = Number.isInteger(Number(roomData.capacity)) ? Number(roomData.capacity) : cur.capacity;
    }
    renderDistributions(db, store, callbacks);
  }, err => console.warn('room/' + distribution.id, err)));
}

export function subscribeDistributionExpenses(db, store, distribution, callbacks = {}) {
  const state = store.getState();
  if (state.expenseUnsubscribers.has(distribution.id)) return;
  const ref = collection(db, 'rooms', distribution.roomId || distribution.id, 'expenses');
  state.expenseUnsubscribers.set(distribution.id, onSnapshot(ref, snap => {
    const cur = state.distributions.find(i => i.id === distribution.id);
    if (cur) {
      cur.expenses = snap.docs.map(item => {
        const d = item.data() || {};
        return {
          id: item.id, amount: Number(d.amount) || 0, payer: text(d.payer), category: text(d.category || 'その他'),
          note: [text(d.note), text(d.comment)].map(v => v.trim()).filter(Boolean).join(' — ').slice(0, 120),
          createdAt: text(d.createdAt), creatorUid: text(d.creatorUid)
        };
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      cur.expensesReady = true; cur.expensesError = '';
    }
    renderDistributions(db, store, callbacks);
  }, err => {
    console.warn('expenses/' + distribution.id, err);
    const cur = state.distributions.find(i => i.id === distribution.id);
    if (cur) { cur.expensesReady = true; cur.expensesError = '共有台帳を取得できません'; }
    renderDistributions(db, store, callbacks);
  }));
}

export async function deleteDistribution(db, store, distribution, button) {
  const state = store.getState();
  if (state.currentRole !== 'owner') return showToast('配布先の完全削除はオーナーだけが実行できます。', true);
  if (distribution.status === 'active') return showToast('先に配布を停止してください。', true);
  const initialRef = doc(db, 'adminDistributions', distribution.id);
  try {
    const initSnap = await getDoc(initialRef);
    if (!initSnap.exists()) return showToast('この配布先はすでに削除されています。');
    const initData = initSnap.data() || {};
    if (initData.status === 'active') throw new Error('配布が再開されています。先に停止してください。');
    const roomId = initData.roomId || distribution.roomId || distribution.id, roomRef = doc(db, 'rooms', roomId);
    const [pSnap, eSnap] = await Promise.all([getDocs(collection(roomRef, 'participants')), getDocs(collection(roomRef, 'expenses'))]);
    const label = initData.label || distribution.label || '名称未設定';
    if (!window.confirm(`「${label}」を完全削除しますか？\n\n参加者 ${pSnap.size}名、共有支出 ${eSnap.size}件、提案やコメント、配布ID・同期ルームを削除します。元に戻せません。`)) return;
    setBusy(button, true, '削除中…');
    await runTransaction(db, async tr => {
      const [lDist, lRoom] = await Promise.all([tr.get(initialRef), tr.get(roomRef)]);
      if (!lDist.exists()) throw new Error('この配布先はすでに削除されています。');
      if (lDist.data()?.status === 'active' || lRoom.data()?.status === 'active') throw new Error('配布が再開されたため削除を中止しました。');
      tr.update(initialRef, { status: 'deleting', updatedAt: serverTimestamp() });
      if (lRoom.exists()) tr.update(roomRef, { status: 'deleting', updatedAt: serverTimestamp() });
    });
    await cleanupRoomSuggestionsAndComments({ db, roomId, getDocs, collection, deleteDoc, writeBatch, query, limit });
    const [delParts, delExp] = await Promise.all([getDocs(collection(roomRef, 'participants')), getDocs(collection(roomRef, 'expenses'))]);
    await deleteDocumentsInChunks(db, [...delParts.docs, ...delExp.docs]);
    const latestData = (await getDoc(initialRef)).data() || initData;
    const finalBatch = writeBatch(db);
    finalBatch.delete(roomRef); finalBatch.delete(initialRef);
    const grantId = latestData.grantId || distribution.grantId;
    if (grantId) finalBatch.delete(doc(db, 'accessGrants', grantId));
    await finalBatch.commit();
    showToast(`「${label}」を完全削除しました。`);
  } catch (error) { console.error(error); showToast(`配布先を削除できません: ${error.message}`, true); setBusy(button, false); }
}

export { clearDistributionLedger };

export async function migrateParticipantExpenseReferences(db, expensesRef, uid, replacementUid) {
  const snapshot = await getDocs(expensesRef);
  const migrations = snapshot.docs.filter(item => { const d = item.data() || {}; return d.payer === uid || d.creatorUid === uid; });
  if (!replacementUid || !migrations.length) return migrations.length;
  for (let offset = 0; offset < migrations.length; offset += 400) {
    const batch = writeBatch(db);
    migrations.slice(offset, offset + 400).forEach(item => {
      const d = item.data() || {}, upd = {};
      if (d.payer === uid) upd.payer = replacementUid;
      if (d.creatorUid === uid) upd.creatorUid = replacementUid;
      batch.update(item.ref, upd);
    });
    await batch.commit();
  }
  return migrations.length;
}

export async function removeParticipantDevice(db, distribution, uid, button) {
  const roomId = distribution.roomId || distribution.id, roomRef = doc(db, 'rooms', roomId);
  const participantRef = doc(roomRef, 'participants', uid), participantsRef = collection(roomRef, 'participants'), expensesRef = collection(roomRef, 'expenses');
  try {
    const [roomSnap, partSnap, partsSnap, expSnap] = await Promise.all([getDoc(roomRef), getDoc(participantRef), getDocs(participantsRef), getDocs(expensesRef)]);
    if (!roomSnap.exists()) throw new Error('配布ルームが見つかりません。');
    const roomMembers = roomSnap.data()?.members || {};
    if (!roomMembers[uid] && !partSnap.exists()) return showToast('この端末はすでに解除されています。');
    const target = partSnap.data() || {}, targetName = text(target.nickname).trim();
    const candidates = partsSnap.docs.filter(i => i.id !== uid && roomMembers[i.id]).map(i => ({ uid: i.id, ...i.data() }))
      .filter(i => targetName && normalizeParticipantName(i.nickname) === normalizeParticipantName(targetName))
      .sort((a, b) => (a.joinedAt?.seconds || Number.MAX_SAFE_INTEGER) - (b.joinedAt?.seconds || Number.MAX_SAFE_INTEGER) || a.uid.localeCompare(b.uid));
    const replacement = candidates[0] || null;
    const refExpenses = expSnap.docs.filter(i => { const d = i.data() || {}; return d.payer === uid || d.creatorUid === uid; });
    if (refExpenses.length && !replacement) return showToast('この端末を参照する支出があります。同じ表示名の新端末を登録してから解除してください。', true);
    const displayName = targetName || '参加者情報のない端末', note = replacement ? '\n同じ表示名の端末へ支払者・登録者を移行します。' : '';
    if (!window.confirm(`「${displayName}」端末 …${uid.slice(-6)} を配布先から解除しますか？${note}`)) return;
    setBusy(button, true, '解除中…');
    if (replacement) await migrateParticipantExpenseReferences(db, expensesRef, uid, replacement.uid);
    await runTransaction(db, async tr => {
      const snap = await tr.get(roomRef);
      if (!snap.exists()) throw new Error('配布ルームが見つかりません。');
      const members = { ...(snap.data()?.members || {}) };
      if (Object.prototype.hasOwnProperty.call(members, uid)) { delete members[uid]; tr.update(roomRef, { members, updatedAt: serverTimestamp() }); }
    });
    const remCount = await migrateParticipantExpenseReferences(db, expensesRef, uid, replacement?.uid || '');
    if (remCount && !replacement) throw new Error('解除中にこの端末の支出が追加されました。再試行してください。');
    const finalBatch = writeBatch(db);
    finalBatch.delete(participantRef);
    await finalBatch.commit();
    showToast(replacement ? '支出の支払者・登録者を同名端末へ移行し、参加端末を解除しました。' : '参加端末を解除しました。');
  } catch (error) { console.error(error); showToast(`参加端末を解除できません: ${error.message}`, true); setBusy(button, false); }
}

export function renderDistributions(db, store, callbacks = {}) {
  if (typeof callbacks.refreshAdminDiscussionRooms === 'function') callbacks.refreshAdminDiscussionRooms();
  const list = $('distribution-list');
  if (!list) return;
  list.replaceChildren();
  const state = store.getState();
  $('metric-distributions').textContent = String(state.distributions.filter(item => item.status === 'active').length);
  $('distribution-count').textContent = `${state.distributions.length}件`;
  const activeIds = new Set(state.distributions.map(item => item.id));
  [state.participantUnsubscribers, state.roomUnsubscribers, state.expenseUnsubscribers].forEach(m => {
    [...m.entries()].forEach(([id, unsub]) => { if (!activeIds.has(id)) { unsub(); m.delete(id); } });
  });
  if (!state.distributions.length) {
    list.append(makeElement('div', 'empty-state', '配布先はまだありません。旅行を選び、配布IDを発行してください。'));
    return;
  }
  state.distributions.forEach(dist => {
    subscribeDistributionParticipants(db, store, dist, callbacks);
    subscribeDistributionRoom(db, store, dist, callbacks);
    subscribeDistributionExpenses(db, store, dist, callbacks);
    const card = makeElement('article', 'distribution-card'), head = makeElement('div', 'distribution-head'), left = makeElement('div');
    const isDeleting = dist.status === 'deleting', statusLabel = dist.status === 'active' ? '有効' : isDeleting ? '削除中' : '停止';
    left.append(makeElement('span', `pill ${dist.status === 'active' ? '' : 'draft'}`, statusLabel), makeElement('h3', '', dist.label || '名称未設定'), makeElement('span', 'muted small', `${dist.tripId} · ${formatTimestamp(dist.createdAt)}`));
    const partDocs = Array.isArray(dist.participants) ? dist.participants : [], partByUid = new Map(partDocs.map(p => [p.uid, p]));
    const memberIds = dist.roomReady ? [...new Set(Array.isArray(dist.roomMembers) ? dist.roomMembers : [])] : [...new Set(partDocs.map(p => p.uid))];
    const memberSet = new Set(memberIds), listedIds = [...new Set([...memberIds, ...partDocs.map(p => p.uid)])];
    const uniqueNames = new Set(); let unnamed = 0;
    memberIds.forEach(uid => { const k = normalizeParticipantName(partByUid.get(uid)?.nickname); if (k) uniqueNames.add(k); else unnamed += 1; });
    const capacity = Number.isInteger(Number(dist.capacity)) ? Number(dist.capacity) : 2;
    head.append(left, makeElement('strong', '', `${uniqueNames.size + unnamed}名（${memberIds.length}/${capacity}端末）`));
    const accessId = dist.accessId ? formatAccessId(dist.accessId) : '配布IDなし：この配布先を削除し、新しく発行してください';
    const accessIdCode = makeElement('code', 'distribution-id', accessId);
    const participants = makeElement('div', 'participant-list participant-device-list');
    if (listedIds.length) {
      listedIds.forEach(uid => {
        const p = partByUid.get(uid), label = p?.nickname || '参加者情報のない端末';
        const item = makeElement('span', 'participant participant-device'), copy = makeElement('span', 'participant-device-copy');
        copy.append(makeElement('strong', '', label), makeElement('small', '', `…${uid.slice(-6)}${p?.joinedAt ? ' · ' + formatTimestamp(p.joinedAt) : ''}${memberSet.has(uid) ? '' : ' · 配布枠外'}`));
        const remBtn = btn('compact danger', '解除', () => removeParticipantDevice(db, dist, uid, remBtn));
        item.append(copy, remBtn); participants.append(item);
      });
    } else { participants.append(makeElement('span', 'muted small', 'まだ参加端末はありません')); }
    participants.append(makeElement('p', 'participant-merge-note', '同じ表示名は同一人物として割り勘集計します。別人なら表示名を変えてください。'));
    const capCtrl = makeElement('div', 'capacity-control'), capLabel = makeElement('label', '', '端末枠'), capInput = document.createElement('input');
    capInput.type = 'number'; capInput.min = String(Math.max(1, memberIds.length)); capInput.max = '50'; capInput.step = '1'; capInput.value = String(capacity); capInput.disabled = isDeleting;
    const updCap = btn('compact ghost', 'DEVICE LIMIT', () => updateDistributionCapacity(db, dist, Number(capInput.value), updCap), isDeleting);
    capLabel.append(capInput); capCtrl.append(capLabel, updCap);
    const actions = makeElement('div', 'trip-actions');
    actions.append(
      btn('compact primary', 'COPY LINK', () => copyText(participantRegistrationUrl(dist.accessId), '自動登録リンクをコピーしました。'), dist.status !== 'active' || !dist.accessId),
      btn('compact ghost', 'COPY ID', () => copyText(formatAccessId(dist.accessId), '配布IDをコピーしました。'), dist.status !== 'active' || !dist.accessId),
      btn('compact ghost', 'COPY APP URL', () => copyText(participantAppUrl(), '空の参加者アプリURLをコピーしました。')),
      btn(`compact ${dist.status === 'active' ? 'danger' : ''}`, dist.status === 'active' ? '配布を停止' : '再開', () => toggleDistribution(db, store, dist), isDeleting)
    );
    if (dist.status !== 'active') actions.append(btn('compact danger', isDeleting ? '削除を再試行' : '完全削除', () => deleteDistribution(db, store, dist, actions.lastChild)));
    card.append(head, accessIdCode, participants, renderDistributionLedger(db, dist), capCtrl, actions);
    list.append(card);
  });
}

export async function updateDistributionCapacity(db, distribution, capacity, button) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) return showToast('端末枠は1〜50台の整数で入力してください。', true);
  setBusy(button, true, '変更中…');
  try {
    const roomRef = doc(db, 'rooms', distribution.roomId || distribution.id);
    const roomSnap = await getDoc(roomRef);
    if (!roomSnap.exists()) throw new Error('配布ルームが見つかりません。');
    const count = Object.keys(roomSnap.data()?.members || {}).length;
    if (capacity < count) throw new Error(`現在${count}台の端末が登録済みです。端末枠をそれ未満にはできません。`);
    await runTransaction(db, async tr => {
      const snap = await tr.get(roomRef);
      if (!snap.exists()) throw new Error('配布ルームが見つかりません。');
      const latestCount = Object.keys(snap.data()?.members || {}).length;
      if (capacity < latestCount) throw new Error(`現在${latestCount}台の端末が登録済みです。端末枠をそれ未満にはできません。`);
      tr.update(roomRef, { capacity, updatedAt: serverTimestamp() });
      tr.update(doc(db, 'adminDistributions', distribution.id), { capacity, updatedAt: serverTimestamp() });
    });
    showToast(`端末枠を${capacity}台へ変更しました。`);
  } catch (error) { console.error(error); showToast(`端末枠を変更できません: ${error.message}`, true); }
  finally { setBusy(button, false); }
}

export async function toggleDistribution(db, store, distribution) {
  if (distribution.status === 'deleting') return showToast('削除処理中の配布先は再開できません。完全削除を再試行してください。', true);
  const status = distribution.status === 'active' ? 'revoked' : 'active';
  if (status === 'revoked' && !window.confirm('この配布IDを停止しますか？オンライン接続中の参加者は閲覧・同期できなくなります。')) return;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'adminDistributions', distribution.id), { status, updatedAt: serverTimestamp() });
    batch.update(doc(db, 'rooms', distribution.roomId || distribution.id), { status, updatedAt: serverTimestamp() });
    if (distribution.grantId) {
      const trip = store.getState().publishedTrips.get(distribution.tripId);
      const grantUpd = { status, updatedAt: serverTimestamp() };
      if (status === 'active' && trip) { grantUpd.title = trip.title; grantUpd.payloadJson = JSON.stringify(trip); }
      batch.update(doc(db, 'accessGrants', distribution.grantId), grantUpd);
    }
    await batch.commit();
    showToast(status === 'active' ? '配布を再開しました。' : '配布を停止しました。');
  } catch (error) { console.error(error); showToast(`配布状態を変更できません: ${error.message}`, true); }
}

export function initDistributionView({ db, store }) {
  if ($('create-distribution')) $('create-distribution').addEventListener('click', () => createDistribution(db, store));
}
