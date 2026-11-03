// Admin Distribution View Controller (View 03: メンバーへ共有)
import { collection, doc, getDoc, getDocs, onSnapshot, runTransaction, serverTimestamp, setDoc, writeBatch, deleteDoc, query, limit } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { $, makeElement, showToast, setBusy, copyText, formatTimestamp, formatAccessId, randomToken, randomAccessId, sha256, text } from './admin-ui.js';
import { cleanupRoomSuggestionsAndComments, KNOWN_MEMBERS_DOC_ID, collectKnownParticipants, syncKnownParticipantsDirectory, pushDistributionToMembers, revokeMemberInboxEntries } from './admin-trip-store.js';
import { renderDistributionLedger, deleteDocumentsInChunks, clearDistributionLedger, renderKnownMemberPicker, renderCardDirectShareBox, renderCardInviteAndAdvanced, renderParticipantDeviceList } from './admin-distribution-ledger.js';

let directorySyncTimer = null;
function knownListFromState(state, excludeTripId) { return collectKnownParticipants(state.distributions, state.knownMembersDirectory || {}, excludeTripId || ''); }

function syncUnpublishedHint(store) {
  if (typeof document === 'undefined') return;
  const hint = document.querySelector('[data-dist-unpublished-hint]');
  if (!hint) return;
  const state = store.getState();
  const tripId = $('distribution-trip')?.value || '';
  hint.hidden = !(tripId && state.trips.has(tripId) && !state.publishedIds.has(tripId));
}

function renderCreateMemberPickerUI(store) {
  const state = store.getState();
  if (!(state.createShareUids instanceof Set)) state.createShareUids = new Set();
  syncUnpublishedHint(store);
  renderKnownMemberPicker({
    container: $('distribution-known-members'),
    knownMembers: knownListFromState(state, $('distribution-trip')?.value || ''),
    selectedUids: state.createShareUids,
    onChange: () => {
      const capEl = $('distribution-capacity');
      if (capEl && state.createShareUids.size > 0 && Number(capEl.value) < state.createShareUids.size + 1) capEl.value = String(Math.min(50, state.createShareUids.size + 1));
      renderCreateMemberPickerUI(store);
    }
  });
}

function scheduleDirectorySync(db, store) {
  if (directorySyncTimer) clearTimeout(directorySyncTimer);
  directorySyncTimer = setTimeout(() => {
    const state = store.getState();
    const knownList = knownListFromState(state, '');
    if (!knownList.length) return;
    syncKnownParticipantsDirectory({ db, doc, getDoc, setDoc, serverTimestamp, knownList, existingDirectory: state.knownMembersDirectory })
      .then(merged => { state.knownMembersDirectory = merged; }).catch(() => {});
  }, 600);
}

export function populateTripSelects(store) {
  const select = $('distribution-trip');
  if (!select) return;
  const state = store.getState();
  const selected = select.value;
  select.replaceChildren();
  [...state.trips.entries()].sort((a, b) => text(b[1].trip.startDate).localeCompare(text(a[1].trip.startDate)))
    .forEach(([id, rec]) => {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = `${state.publishedIds.has(id) ? '🟢 公開中' : '🟠 未公開'}｜${rec.trip.title || id} (${id})`;
      select.append(opt);
    });
  if (select.querySelector(`option[value="${selected}"]`)) select.value = selected;
  renderCreateMemberPickerUI(store);
}

export function openDistribution(store, tripId = '', showView) {
  if (typeof showView === 'function' && showView('distribution') === false) return;
  if (tripId && store.getState().trips.has(tripId) && $('distribution-trip')) $('distribution-trip').value = tripId;
  renderCreateMemberPickerUI(store);
}

export function startDistributionListener(db, store, callbacks = {}) {
  const state = store.getState();
  state.distributionsUnsubscribe?.();
  if (!state.knownMembersDirectory) {
    getDoc(doc(db, 'accessGrants', KNOWN_MEMBERS_DOC_ID)).then(snap => {
      state.knownMembersDirectory = (snap.exists() && snap.data()?.members) ? snap.data().members : {};
      renderDistributions(db, store, callbacks);
    }).catch(() => { state.knownMembersDirectory = state.knownMembersDirectory || {}; });
  }
  state.distributionsUnsubscribe = onSnapshot(collection(db, 'adminDistributions'), snapshot => {
    const prevById = new Map(state.distributions.map(i => [i.id, i]));
    state.distributions = snapshot.docs.map(item => {
      const prev = prevById.get(item.id);
      return {
        id: item.id, ...item.data(),
        participants: prev?.participants || [], roomMembers: prev?.roomMembers || [],
        roomReady: prev?.roomReady === true, expenses: prev?.expenses || [],
        expensesReady: prev?.expensesReady === true, expensesError: prev?.expensesError || ''
      };
    }).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderDistributions(db, store, callbacks);
  }, error => { console.error(error); showToast('共有ルーム一覧を取得できませんでした。', true); });
}

export function participantAppUrl() { const u = new URL('./', window.location.href); u.search = ''; u.hash = ''; return u.toString(); }
export function participantRegistrationUrl(accessId) { const u = new URL('./', window.location.href); u.search = ''; u.hash = `join=${encodeURIComponent(text(accessId).toUpperCase().replace(/[^A-Z0-9]/g, ''))}`; return u.toString(); }
export function normalizeParticipantName(v) { return text(v).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ja-JP'); }

export async function shareDistributionDirectly(db, store, distribution, targets, button) {
  if (!Array.isArray(targets) || !targets.length) return showToast('共有するメンバーを選択してください。', true);
  setBusy(button, true, '共有中…');
  try {
    const state = store.getState();
    await pushDistributionToMembers({ db, doc, runTransaction, serverTimestamp, sha256Fn: sha256, distribution, membersToShare: targets, adminUid: state.currentUser?.uid || 'admin' });
    state.cardShareUids?.get(distribution.id)?.clear();
    showToast(`「${targets.map(t => t.nickname).join('・')}」のしおり棚へ直接共有しました！相手がアプリを開くだけで表示されます。`);
  } catch (error) { console.error(error); showToast(`直接共有できません: ${error.message}`, true); }
  finally { setBusy(button, false); }
}

export async function createDistribution(db, store) {
  const state = store.getState();
  const tripId = $('distribution-trip').value;
  const label = $('distribution-label').value.trim() || 'メンバー共有';
  const rawCap = Number($('distribution-capacity').value);
  if (!tripId || !state.trips.has(tripId)) return showToast('共有する旅行を選択してください。', true);
  if (label.length > 40) return showToast('グループ名は40文字以内で入力してください。', true);
  if (!Number.isInteger(rawCap) || rawCap < 1 || rawCap > 50) return showToast('端末上限は1〜50台の整数で入力してください。', true);
  if (!state.publishedIds.has(tripId)) return showToast('先に「② しおり編集・公開」で「🚀 参加者へ公開」を押してください。', true);
  const selectedMembers = knownListFromState(state, tripId).filter(m => state.createShareUids?.has(m.uid));
  const capacity = Math.min(50, Math.max(rawCap, selectedMembers.length));
  const button = $('create-distribution'); setBusy(button, true, '作成中…');
  const ledgerToken = randomToken();
  const roomId = `${tripId}_${ledgerToken}`;
  const trip = state.publishedTrips.get(tripId);
  if (!trip) { showToast('公開済みデータを取得できません。旅行をもう一度公開してください。', true); setBusy(button, false); return; }
  try {
    let accessId = '';
    let grantId = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      accessId = randomAccessId(); grantId = await sha256(accessId);
      if (!(await getDoc(doc(db, 'accessGrants', grantId))).exists()) break;
      accessId = '';
    }
    if (!accessId) throw new Error('共有IDを生成できませんでした。もう一度お試しください。');
    const distDoc = { roomId, tripId, label, ledgerToken, accessId, grantId, status: 'active', capacity, createdAt: serverTimestamp(), createdBy: state.currentUser.uid };
    const batch = writeBatch(db);
    batch.set(doc(db, 'rooms', roomId), { schemaVersion: 2, tripId, label, status: 'active', capacity, members: {}, accessIdHash: grantId, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: state.currentUser.uid });
    batch.set(doc(db, 'adminDistributions', roomId), distDoc);
    batch.set(doc(db, 'accessGrants', grantId), { tripId, roomId, ledgerToken, status: 'active', title: trip.title, payloadJson: JSON.stringify(trip), createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: state.currentUser.uid });
    await batch.commit();
    if (selectedMembers.length) {
      await pushDistributionToMembers({ db, doc, runTransaction, serverTimestamp, sha256Fn: sha256, distribution: { id: roomId, ...distDoc }, membersToShare: selectedMembers, adminUid: state.currentUser?.uid || 'admin' });
      state.createShareUids?.clear();
    }
    $('distribution-label').value = '';
    showToast(`共有ルーム「${label}」を作成しました${selectedMembers.length ? `（${selectedMembers.map(m => m.nickname).join('・')}へ自動共有済み）` : ''}！`);
  } catch (error) { console.error(error); showToast(`共有ルームを作成できません: ${error.message}`, true); }
  finally { setBusy(button, false); renderCreateMemberPickerUI(store); }
}

export function subscribeDistributionParticipants(db, store, distribution, callbacks = {}) {
  const state = store.getState();
  if (state.participantUnsubscribers.has(distribution.id)) return;
  state.participantUnsubscribers.set(distribution.id, onSnapshot(collection(db, 'rooms', distribution.roomId || distribution.id, 'participants'), snap => {
    const cur = state.distributions.find(i => i.id === distribution.id);
    if (cur) cur.participants = snap.docs.map(i => ({ uid: i.id, ...i.data() }));
    scheduleDirectorySync(db, store); renderDistributions(db, store, callbacks);
  }, err => console.warn('participants/' + distribution.id, err)));
}

export function subscribeDistributionRoom(db, store, distribution, callbacks = {}) {
  const state = store.getState();
  if (state.roomUnsubscribers.has(distribution.id)) return;
  state.roomUnsubscribers.set(distribution.id, onSnapshot(doc(db, 'rooms', distribution.roomId || distribution.id), snap => {
    const cur = state.distributions.find(i => i.id === distribution.id);
    if (cur) {
      const roomData = snap.data() || {};
      cur.roomMembers = Object.keys(roomData.members || {}); cur.roomReady = true;
      cur.capacity = Number.isInteger(Number(roomData.capacity)) ? Number(roomData.capacity) : cur.capacity;
    }
    renderDistributions(db, store, callbacks);
  }, err => console.warn('room/' + distribution.id, err)));
}

export function subscribeDistributionExpenses(db, store, distribution, callbacks = {}) {
  const state = store.getState();
  if (state.expenseUnsubscribers.has(distribution.id)) return;
  state.expenseUnsubscribers.set(distribution.id, onSnapshot(collection(db, 'rooms', distribution.roomId || distribution.id, 'expenses'), snap => {
    const cur = state.distributions.find(i => i.id === distribution.id);
    if (cur) {
      cur.expenses = snap.docs.map(item => {
        const d = item.data() || {};
        return { id: item.id, amount: Number(d.amount) || 0, payer: text(d.payer), category: text(d.category || 'その他'), note: [text(d.note), text(d.comment)].map(v => v.trim()).filter(Boolean).join(' — ').slice(0, 120), createdAt: text(d.createdAt), creatorUid: text(d.creatorUid) };
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
  if (state.currentRole !== 'owner') return showToast('完全削除はオーナー権限のみ実行できます。', true);
  if (distribution.status === 'active') return showToast('先に共有を一時停止してください。', true);
  const initialRef = doc(db, 'adminDistributions', distribution.id);
  try {
    const initSnap = await getDoc(initialRef);
    if (!initSnap.exists()) return showToast('この共有ルームはすでに削除されています。');
    const initData = initSnap.data() || {};
    if (initData.status === 'active') throw new Error('共有が再開されています。先に停止してください。');
    const roomId = initData.roomId || distribution.roomId || distribution.id;
    const roomRef = doc(db, 'rooms', roomId);
    const [pSnap, eSnap] = await Promise.all([getDocs(collection(roomRef, 'participants')), getDocs(collection(roomRef, 'expenses'))]);
    const label = initData.label || distribution.label || '名称未設定';
    if (!window.confirm(`「${label}」を完全削除しますか？\n\n参加者 ${pSnap.size}名、共有支出 ${eSnap.size}件、相談コメント、招待コードを削除します。元に戻せません。`)) return;
    setBusy(button, true, '削除中…');
    await runTransaction(db, async tr => {
      const [lDist, lRoom] = await Promise.all([tr.get(initialRef), tr.get(roomRef)]);
      if (!lDist.exists()) throw new Error('この共有ルームはすでに削除されています。');
      if (lDist.data()?.status === 'active' || lRoom.data()?.status === 'active') throw new Error('共有が再開されたため削除を中止しました。');
      tr.update(initialRef, { status: 'deleting', updatedAt: serverTimestamp() });
      if (lRoom.exists()) tr.update(roomRef, { status: 'deleting', updatedAt: serverTimestamp() });
    });
    await cleanupRoomSuggestionsAndComments({ db, roomId, getDocs, collection, deleteDoc, writeBatch, query, limit });
    const [delParts, delExp] = await Promise.all([getDocs(collection(roomRef, 'participants')), getDocs(collection(roomRef, 'expenses'))]);
    const cleanupUids = [...delParts.docs.map(d => d.id), ...(distribution.roomMembers || []), ...Object.keys(initData.sharedMembers || {})];
    await revokeMemberInboxEntries({ db, doc, getDoc, setDoc, serverTimestamp, sha256Fn: sha256, uids: cleanupUids, roomId });
    await deleteDocumentsInChunks(db, [...delParts.docs, ...delExp.docs]);
    const latestData = (await getDoc(initialRef)).data() || initData;
    const finalBatch = writeBatch(db);
    finalBatch.delete(roomRef); finalBatch.delete(initialRef);
    const grantId = latestData.grantId || distribution.grantId;
    if (grantId) finalBatch.delete(doc(db, 'accessGrants', grantId));
    await finalBatch.commit();
    showToast(`「${label}」を完全削除しました。`);
  } catch (error) { console.error(error); showToast(`削除できません: ${error.message}`, true); setBusy(button, false); }
}

export { clearDistributionLedger };

export async function migrateParticipantExpenseReferences(db, expensesRef, uid, replacementUid) {
  const snapshot = await getDocs(expensesRef);
  const migrations = snapshot.docs.filter(item => { const d = item.data() || {}; return d.payer === uid || d.creatorUid === uid; });
  if (!replacementUid || !migrations.length) return migrations.length;
  for (let offset = 0; offset < migrations.length; offset += 400) {
    const batch = writeBatch(db);
    migrations.slice(offset, offset + 400).forEach(item => {
      const d = item.data() || {};
      const upd = {};
      if (d.payer === uid) upd.payer = replacementUid;
      if (d.creatorUid === uid) upd.creatorUid = replacementUid;
      batch.update(item.ref, upd);
    });
    await batch.commit();
  }
  return migrations.length;
}

export async function removeParticipantDevice(db, distribution, uid, button) {
  const roomId = distribution.roomId || distribution.id;
  const roomRef = doc(db, 'rooms', roomId);
  const distRef = doc(db, 'adminDistributions', distribution.id);
  const participantRef = doc(roomRef, 'participants', uid);
  const participantsRef = collection(roomRef, 'participants');
  const expensesRef = collection(roomRef, 'expenses');
  try {
    const [roomSnap, partSnap, partsSnap, expSnap] = await Promise.all([getDoc(roomRef), getDoc(participantRef), getDocs(participantsRef), getDocs(expensesRef)]);
    if (!roomSnap.exists()) throw new Error('共有ルームが見つかりません。');
    const roomMembers = roomSnap.data()?.members || {};
    if (!roomMembers[uid] && !partSnap.exists() && !distribution.sharedMembers?.[uid]) return showToast('この端末はすでに解除されています。');
    const targetName = text((partSnap.data() || {}).nickname || distribution.sharedMembers?.[uid]?.nickname).trim();
    const replacement = partsSnap.docs.filter(i => i.id !== uid && roomMembers[i.id]).map(i => ({ uid: i.id, ...i.data() }))
      .filter(i => targetName && normalizeParticipantName(i.nickname) === normalizeParticipantName(targetName))
      .sort((a, b) => (a.joinedAt?.seconds || Number.MAX_SAFE_INTEGER) - (b.joinedAt?.seconds || Number.MAX_SAFE_INTEGER) || a.uid.localeCompare(b.uid))[0] || null;
    if (expSnap.docs.some(i => { const d = i.data() || {}; return d.payer === uid || d.creatorUid === uid; }) && !replacement) {
      return showToast('この端末を参照する支出があります。同じ表示名の新端末を登録してから解除してください。', true);
    }
    if (!window.confirm(`「${targetName || '名称未設定の端末'}」（…${uid.slice(-6)}）の共有を解除しますか？${replacement ? '\n同じ表示名の端末へ支払者・登録者を移行します。' : ''}`)) return;
    setBusy(button, true, '解除中…');
    if (replacement) await migrateParticipantExpenseReferences(db, expensesRef, uid, replacement.uid);
    await runTransaction(db, async tr => {
      const [snap, dSnap] = await Promise.all([tr.get(roomRef), tr.get(distRef)]);
      if (!snap.exists()) throw new Error('共有ルームが見つかりません。');
      const members = { ...(snap.data()?.members || {}) };
      if (Object.prototype.hasOwnProperty.call(members, uid)) { delete members[uid]; tr.update(roomRef, { members, updatedAt: serverTimestamp() }); }
      if (dSnap.exists() && dSnap.data()?.sharedMembers?.[uid]) {
        const sharedMembers = { ...(dSnap.data()?.sharedMembers || {}) };
        delete sharedMembers[uid]; tr.update(distRef, { sharedMembers, updatedAt: serverTimestamp() });
      }
    });
    await revokeMemberInboxEntries({ db, doc, getDoc, setDoc, serverTimestamp, sha256Fn: sha256, uids: [uid], roomId });
    if ((await migrateParticipantExpenseReferences(db, expensesRef, uid, replacement?.uid || '')) && !replacement) throw new Error('解除中にこの端末の支出が追加されました。再試行してください。');
    if (partSnap.exists()) { const finalBatch = writeBatch(db); finalBatch.delete(participantRef); await finalBatch.commit(); }
    showToast(replacement ? '支出データを同名端末へ引き継ぎ、端末を解除しました。' : '端末の共有を解除しました。');
  } catch (error) { console.error(error); showToast(`端末を解除できません: ${error.message}`, true); setBusy(button, false); }
}

export function renderDistributions(db, store, callbacks = {}) {
  if (typeof callbacks.refreshAdminDiscussionRooms === 'function') callbacks.refreshAdminDiscussionRooms();
  if (store.getState().currentView === 'overview' && typeof callbacks.renderTripLibrary === 'function') callbacks.renderTripLibrary();
  renderCreateMemberPickerUI(store);
  const list = $('distribution-list');
  if (!list) return;
  list.replaceChildren();
  const state = store.getState();
  if (!(state.cardShareUids instanceof Map)) state.cardShareUids = new Map();
  $('metric-distributions').textContent = String(state.distributions.filter(item => item.status === 'active').length);
  $('distribution-count').textContent = `${state.distributions.length}件`;
  const activeIds = new Set(state.distributions.map(item => item.id));
  [state.participantUnsubscribers, state.roomUnsubscribers, state.expenseUnsubscribers].forEach(m => {
    [...m.entries()].forEach(([id, unsub]) => { if (!activeIds.has(id)) { unsub(); m.delete(id); } });
  });
  if (!state.distributions.length) return list.append(makeElement('div', 'empty-state', '共有ルームはまだありません。上の「共有ルームを作成する」から作成できます。'));
  const allKnown = knownListFromState(state, '');
  state.distributions.forEach(dist => {
    subscribeDistributionParticipants(db, store, dist, callbacks);
    subscribeDistributionRoom(db, store, dist, callbacks);
    subscribeDistributionExpenses(db, store, dist, callbacks);
    const card = makeElement('article', 'distribution-card');
    const head = makeElement('div', 'distribution-head');
    const left = makeElement('div', 'distribution-title-block');
    const isDeleting = dist.status === 'deleting';
    const isActive = dist.status === 'active';
    const tripTitle = state.trips.get(dist.tripId)?.trip?.title || dist.tripId;
    left.append(makeElement('span', `pill ${isActive ? 'status-published' : 'draft'}`, isActive ? '🟢 共有中' : isDeleting ? '削除中' : '🟠 停止中'), makeElement('h3', '', dist.label || 'メンバー共有'), makeElement('span', 'muted small', `対象しおり: ${tripTitle} (${dist.tripId}) · 作成 ${formatTimestamp(dist.createdAt)}`));
    const partDocs = Array.isArray(dist.participants) ? dist.participants : [];
    const partByUid = new Map(partDocs.map(p => [p.uid, p]));
    const sharedMap = (dist.sharedMembers && typeof dist.sharedMembers === 'object') ? dist.sharedMembers : {};
    const memberIds = dist.roomReady ? [...new Set(Array.isArray(dist.roomMembers) ? dist.roomMembers : [])] : [...new Set([...partDocs.map(p => p.uid), ...Object.keys(sharedMap)])];
    const memberSet = new Set(memberIds);
    const listedIds = [...new Set([...memberIds, ...partDocs.map(p => p.uid)])];
    const uniqueNames = new Set(); let unnamed = 0;
    memberIds.forEach(uid => { const k = normalizeParticipantName(partByUid.get(uid)?.nickname || sharedMap[uid]?.nickname); if (k) uniqueNames.add(k); else unnamed += 1; });
    const capacity = Number.isInteger(Number(dist.capacity)) ? Number(dist.capacity) : 2;
    head.append(left, makeElement('strong', 'dist-count-chip', `参加 ${uniqueNames.size + unnamed}名（${memberIds.length}/${capacity}台）`));
    if (!state.cardShareUids.has(dist.id)) state.cardShareUids.set(dist.id, new Set());
    const directBox = renderCardDirectShareBox({
      distribution: dist, knownMembers: allKnown, memberSet, selectedUids: state.cardShareUids.get(dist.id),
      onChange: () => renderDistributions(db, store, callbacks),
      onPush: (pushBtn, targets) => shareDistributionDirectly(db, store, dist, targets, pushBtn)
    });
    const { inviteBox, adv } = renderCardInviteAndAdvanced({
      dist, isActive, isDeleting, capacity, memberCount: memberIds.length,
      onCopyLink: () => copyText(participantRegistrationUrl(dist.accessId), '招待リンクをコピーしました！LINE等でそのまま送れます。'),
      onCopyId: () => copyText(formatAccessId(dist.accessId), '12桁コードをコピーしました。'),
      onCopyAppUrl: () => copyText(participantAppUrl(), '参加者アプリのトップURLをコピーしました。'),
      onUpdateCap: (val, b) => updateDistributionCapacity(db, dist, val, b),
      onToggle: () => toggleDistribution(db, store, dist),
      onDelete: b => deleteDistribution(db, store, dist, b)
    });
    const participants = renderParticipantDeviceList({ listedIds, partByUid, sharedMap, memberSet, onRemove: (uid, remBtn) => removeParticipantDevice(db, dist, uid, remBtn) });
    card.append(head, ...(directBox ? [directBox] : []), inviteBox, participants, renderDistributionLedger(db, dist), adv);
    list.append(card);
  });
}

export async function updateDistributionCapacity(db, distribution, capacity, button) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) return showToast('端末上限は1〜50台の整数で入力してください。', true);
  setBusy(button, true, '変更中…');
  try {
    const roomRef = doc(db, 'rooms', distribution.roomId || distribution.id);
    const roomSnap = await getDoc(roomRef);
    if (!roomSnap.exists()) throw new Error('共有ルームが見つかりません。');
    const count = Object.keys(roomSnap.data()?.members || {}).length;
    if (capacity < count) throw new Error(`現在${count}台の端末が参加中です。それ未満にはできません。`);
    await runTransaction(db, async tr => {
      const snap = await tr.get(roomRef);
      if (!snap.exists()) throw new Error('共有ルームが見つかりません。');
      const latestCount = Object.keys(snap.data()?.members || {}).length;
      if (capacity < latestCount) throw new Error(`現在${latestCount}台の端末が参加中です。それ未満にはできません。`);
      tr.update(roomRef, { capacity, updatedAt: serverTimestamp() });
      tr.update(doc(db, 'adminDistributions', distribution.id), { capacity, updatedAt: serverTimestamp() });
    });
    showToast(`端末上限を${capacity}台へ変更しました。`);
  } catch (error) { console.error(error); showToast(`端末上限を変更できません: ${error.message}`, true); }
  finally { setBusy(button, false); }
}

export async function toggleDistribution(db, store, distribution) {
  if (distribution.status === 'deleting') return showToast('削除処理中のため再開できません。完全削除を再試行してください。', true);
  const status = distribution.status === 'active' ? 'revoked' : 'active';
  if (status === 'revoked' && !window.confirm('この共有ルームを一時停止しますか？停止中は参加者が閲覧・同期できなくなります。')) return;
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
    showToast(status === 'active' ? '共有を再開しました。' : '共有を一時停止しました。');
  } catch (error) { console.error(error); showToast(`状態を変更できません: ${error.message}`, true); }
}

export function initDistributionView({ db, store }) {
  if ($('create-distribution')) $('create-distribution').addEventListener('click', () => createDistribution(db, store));
  if ($('distribution-trip')) $('distribution-trip').addEventListener('change', () => renderCreateMemberPickerUI(store));
}
