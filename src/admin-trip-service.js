/**
 * Admin Trip Service: Persistence, Draft Synchronization & Transfer Operations
 */

import { collection, doc, getDoc, getDocs, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import {
  migrateTripToV2,
  cleanPlanning,
  cleanCandidate,
  validateTripDraft,
  analyzeTrip,
  stripPlanningForPublication
} from './trip-v2-index.js';
import { decodeDraftRecord } from './admin-draft-record.js';
import { draftVersion } from './admin-save-state.js';
import { commitTripRecord } from './admin-trip-store.js';
import { buildTripExport, buildAdminBackup, parseTripImport } from './admin-transfer.js';
import { validateStoredDraftSize } from './draft-validation.js';
import { reconcileAssignments } from './admin-candidate-state.js';
import { $, setBusy, showToast, deepClone, text } from './admin-ui.js';

export function normalizeTrip(raw, fallbackId = '') {
  return migrateTripToV2(raw, fallbackId);
}

export function blankPlanning() {
  return cleanPlanning({
    schemaVersion: 3,
    candidates: [],
    notes: ''
  });
}

export function blankTrip() {
  return normalizeTrip({
    tripId: '',
    title: '旅行しおり',
    subtitle: '',
    catchphrase: '',
    startDate: '',
    endDate: '',
    dayLabels: { day1: 'DAY 1' },
    days: { day1: [] },
    weatherLocations: {},
    checklist: []
  });
}

export async function loadCloudTrips(db, store) {
  const [drafts, published] = await Promise.all([
    getDocs(collection(db, 'adminTrips')),
    getDocs(collection(db, 'publishedTrips'))
  ]);
  const publishedIds = new Set(published.docs.filter(item => item.data().published === true).map(item => item.id));
  const publishedTrips = new Map();
  const trips = new Map();

  published.forEach(item => {
    const data = item.data();
    try {
      const trip = normalizeTrip(JSON.parse(data.payloadJson), item.id);
      publishedTrips.set(item.id, deepClone(trip));
      trips.set(item.id, { trip, planning: blankPlanning(), source: 'published', updatedAt: data.publishedAt || null });
    } catch (error) {
      console.warn(`Invalid publishedTrips/${item.id}`, error);
    }
  });

  drafts.forEach(item => {
    const data = item.data();
    try {
      const { trip, planning } = decodeDraftRecord(data, item.id);
      trips.set(item.id, { trip, planning, source: 'cloud', version: draftVersion(data), updatedAt: data.updatedAt || null });
    } catch (error) {
      const trip = trips.get(item.id)?.trip || normalizeTrip({ tripId: item.id, title: data.title || item.id });
      trips.set(item.id, {
        trip,
        planning: null,
        source: 'cloud-error',
        version: draftVersion(data),
        loadError: error.message,
        rawDraft: { tripId: item.id, payloadJson: data.payloadJson, ...(data.planningJson !== undefined ? { planningJson: data.planningJson } : {}) }
      });
      console.warn(`Invalid adminTrips/${item.id}`, error);
    }
  });

  store.setState({
    publishedIds,
    publishedTrips,
    trips
  });
}

export async function persistTrip({ db, store, session, publish = false, hideEditorErrors, showEditorErrors, renderTripAudit, syncEditorInputs, updateSaveStatus, renderTripLibrary, populateTripSelects }) {
  const state = store.getState();
  if (state.tripWriteBusy || session.saving) return showToast('保存処理が実行中です。', true);
  if (typeof syncEditorInputs === 'function') syncEditorInputs();
  const draftErrors = validateTripDraft(state.activeTrip, state.activePlanning);
  if (draftErrors.length) {
    if (typeof showEditorErrors === 'function') showEditorErrors(draftErrors);
    return;
  }
  let cleanTrip = stripPlanningForPublication(state.activeTrip);
  if (publish) {
    const report = analyzeTrip(state.activeTrip);
    if (typeof renderTripAudit === 'function') renderTripAudit(report);
    if (report.errors.length) {
      if (typeof showEditorErrors === 'function') showEditorErrors(report.errors.map(item => item.message));
      return;
    }
    if (report.warnings.length && !window.confirm('警告が' + report.warnings.length + '件あります。確認済みとして公開しますか？')) return;
    cleanTrip = report.trip;
  }
  const button = publish ? $('publish-trip') : $('save-draft');
  let ticket;
  try {
    ticket = session.beginSave(state.activeTrip, state.activePlanning);
    store.setState({ tripWriteBusy: true });
    if (typeof hideEditorErrors === 'function') hideEditorErrors();
    setBusy(button, true, publish ? '公開中…' : '保存中…');
    if (typeof updateSaveStatus === 'function') updateSaveStatus();
    const tripId = ticket.tripId;
    const planning = cleanPlanning(ticket.planning);
    const payloadJson = JSON.stringify(cleanTrip);
    const planningJson = JSON.stringify(planning);
    const sizeErrors = validateStoredDraftSize({ payloadJson, planningJson });
    if (sizeErrors.length) throw new Error(sizeErrors.join('\n'));
    const data = {
      tripId,
      title: cleanTrip.title,
      status: publish || state.publishedIds.has(tripId) ? 'published' : 'draft',
      payloadJson,
      planningJson,
      revision: crypto.randomUUID(),
      updatedAt: serverTimestamp(),
      updatedBy: state.currentUser?.uid || 'admin'
    };
    const writes = [];
    const checks = [];
    if (publish) {
      const snapshot = await getDocs(collection(db, 'adminDistributions'));
      const distributions = snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
        .filter(item => item.tripId === tripId && item.status === 'active' && item.grantId);
      const grants = new Set();
      for (const distribution of distributions) {
        checks.push({
          reference: doc(db, 'adminDistributions', distribution.id),
          fields: { tripId, status: 'active', grantId: distribution.grantId }
        });
        if (grants.has(distribution.grantId)) continue;
        grants.add(distribution.grantId);
        writes.push({
          reference: doc(db, 'accessGrants', distribution.grantId),
          merge: true,
          data: { title: cleanTrip.title, payloadJson, publishedRevision: data.revision, updatedAt: serverTimestamp() }
        });
      }
      writes.push({ reference: doc(collection(db, 'tripHistories', tripId, 'versions')), data: { tripId, title: cleanTrip.title, payloadJson, schemaVersion: 2, revision: data.revision, publishedAt: serverTimestamp(), publishedBy: data.updatedBy } });
      writes.push({ reference: doc(db, 'publishedTrips', tripId), data: { tripId, title: cleanTrip.title, published: true, payloadJson, revision: data.revision, publishedAt: serverTimestamp(), updatedBy: data.updatedBy } });
    }
    const version = await commitTripRecord({
      db,
      runTransaction,
      reference: doc(db, 'adminTrips', tripId),
      expectedVersion: ticket.expectedVersion,
      data,
      writes,
      checks
    });
    state.trips.set(tripId, { trip: deepClone(cleanTrip), planning: deepClone(planning), source: 'cloud', version, updatedAt: new Date() });
    if (publish) {
      state.publishedIds.add(tripId);
      state.publishedTrips.set(tripId, deepClone(cleanTrip));
    }
    session.finishSave(ticket, version);
    if (typeof renderTripLibrary === 'function') renderTripLibrary();
    if (typeof populateTripSelects === 'function') populateTripSelects();
    showToast(publish ? '参加者ページへ公開しました。' : '下書きを保存しました。参加者ページは変わっていません。');
  } catch (error) {
    if (ticket) session.failSave(ticket);
    console.error(error);
    showToast((publish ? '公開' : '保存') + 'できませんでした: ' + error.message, true);
  } finally {
    store.setState({ tripWriteBusy: false });
    setBusy(button, false);
    if (typeof updateSaveStatus === 'function') updateSaveStatus();
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
  } finally { URL.revokeObjectURL(url); }
}

export function downloadDraftRecovery(store, tripId) {
  const raw = store.getState().trips.get(tripId)?.rawDraft;
  if (!raw || !window.confirm('元データには非公開メモが含まれます。共有せず保管し、JSONを修復してから読み込んでください。書き出しますか？')) return;
  const blob = new Blob([JSON.stringify({ format: 'shiori-draft-recovery', version: 1, ...raw }, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `${tripId.replace(/[^a-zA-Z0-9_-]/g, '_')}.draft-recovery.json`);
}

export function downloadActiveTrip({ store, adminBackup = false, syncEditorInputs }) {
  const state = store.getState();
  if (!state.activeTrip) return;
  if (state.dirtyDialogs.size) return showToast('開いている編集画面の入力を反映してから書き出してください。', true);
  if (adminBackup && !window.confirm('管理者専用バックアップには候補・非公開メモが含まれます。参加者などへ共有しないでください。書き出しますか？')) return;
  try {
    if (typeof syncEditorInputs === 'function') syncEditorInputs();
    const exportData = adminBackup ? buildAdminBackup(state.activeTrip, state.activePlanning) : buildTripExport(state.activeTrip);
    const blob = new Blob([`${JSON.stringify(exportData, null, 2)}\n`], { type: 'application/json' });
    const fileId = state.activeTrip.tripId.replace(/[^a-zA-Z0-9_-]/g, '_');
    triggerDownload(blob, `${fileId}${adminBackup ? '.admin-backup' : ''}.json`);
  } catch (error) {
    showToast(`書き出せません: ${error.message}`, true);
  }
}

export async function reloadActiveDraft({ db, store, session, confirmEditorLeave, syncEditorInputs, updateSaveStatus, renderEditor, startEditorSession, renderTripLibrary }) {
  const state = store.getState();
  if (!state.activeTrip?.tripId) return;
  if (typeof confirmEditorLeave === 'function' && !confirmEditorLeave()) return;
  if (typeof syncEditorInputs === 'function') syncEditorInputs();
  const tripId = state.activeTrip.tripId;
  const generation = session.generation;
  const inputRevision = state.editorInputRevision;
  const before = JSON.stringify({ trip: state.activeTrip, planning: state.activePlanning, dialogs: [...state.dirtyDialogs] });
  store.setState({ tripWriteBusy: true });
  if (typeof updateSaveStatus === 'function') updateSaveStatus();
  try {
    const snapshot = await getDoc(doc(db, 'adminTrips', tripId));
    if (!snapshot.exists()) throw new Error('クラウドに下書きがありません。現在の入力は保持しています。');
    const data = snapshot.data();
    const { trip, planning } = decodeDraftRecord(data, tripId);
    if (typeof syncEditorInputs === 'function') syncEditorInputs();
    const now = JSON.stringify({ trip: state.activeTrip, planning: state.activePlanning, dialogs: [...state.dirtyDialogs] });
    if (session.generation !== generation || state.editorInputRevision !== inputRevision || now !== before) {
      throw new Error('読込中に編集されたため中止しました。現在の入力は保持しています。');
    }
    const version = draftVersion(data);
    state.trips.set(tripId, { trip: deepClone(trip), planning: deepClone(planning), version, source: 'cloud', updatedAt: data.updatedAt || null });
    store.setState({
      activeTrip: trip,
      activePlanning: planning,
      activeDayKey: Object.keys(trip.days)[0] || 'day1'
    });
    if (typeof renderEditor === 'function') renderEditor();
    if (typeof startEditorSession === 'function') startEditorSession(true, version);
    if (typeof renderTripLibrary === 'function') renderTripLibrary();
    showToast('最新の下書きを読み込みました。');
  } catch (error) {
    showToast(`読み込めませんでした: ${error.message}`, true);
  } finally {
    store.setState({ tripWriteBusy: false });
    if (typeof updateSaveStatus === 'function') updateSaveStatus();
  }
}

export async function importTripFile({ file, store, session, confirmEditorLeave, renderEditor, startEditorSession }) {
  if (!file) return;
  const generation = session.generation;
  const state = store.getState();
  try {
    const imported = parseTripImport(JSON.parse(await file.text()));
    const parsed = imported.trip;
    const inputErrors = validateTripDraft(parsed, imported.planning || blankPlanning());
    if (inputErrors.length) throw new Error(inputErrors.join('\n'));
    if (session.generation !== generation) return showToast('編集対象が変わったため、JSON読込を中止しました。', true);
    if (typeof confirmEditorLeave === 'function' && !confirmEditorLeave()) return;
    if (imported.kind !== 'participant' && !window.confirm('管理者用データです。非公開の候補・メモもこの旅行の下書きへ読み込みます。続けますか？')) return;
    if (parsed.tripId !== state.activeTrip?.tripId && state.trips.has(parsed.tripId)
      && !window.confirm('同じIDの旅行が既にあります。その旅行の下書きとして読み込みますか？')) return;
    const trip = normalizeTrip(parsed);
    const planning = imported.planning || blankPlanning();
    store.setState({
      activeTrip: trip,
      activePlanning: planning,
      activeDayKey: Object.keys(trip.days)[0] || 'day1'
    });
    if (typeof renderEditor === 'function') renderEditor();
    if (typeof startEditorSession === 'function') {
      startEditorSession(false, state.trips.get(trip.tripId)?.version ?? null);
    }
    showToast('JSONを読み込みました。内容を確認して保存してください。');
  } catch (error) {
    showToast(`JSONを読み込めません: ${error.message}`, true);
  } finally {
    if ($('import-trip-file')) $('import-trip-file').value = '';
  }
}

export function duplicateTrip({ store, tripId, confirmEditorLeave, renderEditor, showView, startEditorSession }) {
  const state = store.getState();
  if (state.trips.get(tripId)?.loadError) return showToast('壊れた下書きは複製できません。元データを保管して修復してください。', true);
  if (typeof confirmEditorLeave === 'function' && !confirmEditorLeave()) return;
  const record = state.trips.get(tripId);
  const source = record?.trip;
  if (!source) return;
  const duplicate = migrateTripToV2(source);
  const suffix = crypto.randomUUID().slice(0, 8);
  duplicate.tripId = `${tripId.slice(0, 30)}-${suffix}`.slice(0, 40);
  duplicate.title = `${source.title} コピー`.slice(0, 120);
  duplicate.archived = false;

  let duplicatePlanning = blankPlanning();
  if (record.planning) {
    const cloned = deepClone(record.planning);
    cloned.candidates = (cloned.candidates || []).map((cand, i) => {
      const newCand = cleanCandidate(cand, i);
      newCand.id = `cand-${crypto.randomUUID()}`;
      return newCand;
    });
    duplicatePlanning = reconcileAssignments(duplicate, cleanPlanning(cloned));
  }

  store.setState({
    activeTrip: duplicate,
    activePlanning: duplicatePlanning,
    lastDayPlanUndo: null,
    activeDayKey: Object.keys(duplicate.days)[0] || 'day1'
  });
  if ($('undo-day-plan')) $('undo-day-plan').hidden = true;
  if (typeof renderEditor === 'function') renderEditor();
  if (typeof showView === 'function') showView('editor');
  if (typeof startEditorSession === 'function') startEditorSession(false);
  showToast('旅行を複製しました。日付と旅行IDを確認して下書き保存してください。');
}

export async function toggleTripArchive({ db, store, session, tripId, hasUnsavedChanges, updateSaveStatus, renderEditor, startEditorSession, renderTripLibrary }) {
  const state = store.getState();
  if (state.tripWriteBusy || session.saving) return showToast('保存が終わるまでお待ちください。', true);
  const record = state.trips.get(tripId);
  if (!record) return;
  if (record.loadError) return showToast('壊れた下書きは保管状態を変更できません。元データを保管して修復してください。', true);
  const errors = validateTripDraft(record.trip, record.planning || blankPlanning());
  if (errors.length) return showToast(errors.join('\n'), true);
  if (state.activeTrip?.tripId === tripId && typeof hasUnsavedChanges === 'function' && hasUnsavedChanges()) {
    return showToast('この旅行の未保存変更を先に保存してください。', true);
  }
  const generation = session.generation;
  const trip = migrateTripToV2(record.trip);
  const planning = cleanPlanning(record.planning || blankPlanning());
  trip.archived = !trip.archived;
  store.setState({ tripWriteBusy: true });
  if (typeof updateSaveStatus === 'function') updateSaveStatus();
  try {
    const data = {
      tripId,
      title: trip.title,
      status: state.publishedIds.has(tripId) ? 'published' : 'draft',
      payloadJson: JSON.stringify(stripPlanningForPublication(trip)),
      planningJson: JSON.stringify(planning),
      revision: crypto.randomUUID(),
      updatedAt: serverTimestamp(),
      updatedBy: state.currentUser?.uid || 'admin'
    };
    const version = await commitTripRecord({
      db,
      runTransaction,
      reference: doc(db, 'adminTrips', tripId),
      expectedVersion: record.version ?? null,
      data
    });
    state.trips.set(tripId, { trip, planning, version, source: 'cloud', updatedAt: new Date() });
    if (state.activeTrip?.tripId === tripId && session.generation === generation && !(typeof hasUnsavedChanges === 'function' && hasUnsavedChanges())) {
      store.setState({
        activeTrip: deepClone(trip),
        activePlanning: deepClone(planning)
      });
      if (typeof renderEditor === 'function') renderEditor();
      if (typeof startEditorSession === 'function') startEditorSession(true, version);
    }
    if (typeof renderTripLibrary === 'function') renderTripLibrary();
    showToast(trip.archived ? '思い出へアーカイブしました。' : '旅行一覧へ戻しました。');
  } catch (error) {
    showToast(`変更できません: ${error.message}`, true);
  } finally {
    store.setState({ tripWriteBusy: false });
    if (typeof updateSaveStatus === 'function') updateSaveStatus();
  }
}
