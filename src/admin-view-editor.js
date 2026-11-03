/**
 * Admin Editor View Controller (View 02: しおり編集・公開)
 */

import {
  $, makeElement, showToast, deepClone, text, formatTimestamp,
  switchEditorTab, updateEditorHeaderMeta, renderDayQuickTabs, buildEditorCardRow, syncCardDialogSections
} from './admin-ui.js';
import {
  migrateTripToV2, cleanCard, parseCardLinks, formatCardLinks, analyzeTrip, validateTripInput
} from './trip-v2-index.js';
import { validateMapFields } from './map-links.js';
import { reconcileAssignments, unassignCandidate } from './admin-candidate-state.js';
import { blankPlanning, blankTrip, normalizeTrip } from './admin-trip-service.js';
import { getDocs, collection } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';

export function syncEditorInputs(store) {
  if (!store.getState().activeTrip) return;
  readTripBasics(store); readTripPlanning(store); readDaySettings(store);
}

export function hasUnsavedChanges(store, session) {
  if (!store.getState().activeTrip) return false;
  syncEditorInputs(store);
  return store.getState().dirtyDialogs.size > 0 || session.isDirty(store.getState().activeTrip, store.getState().activePlanning);
}

export function updateSaveStatus(store, session) {
  const s = $('editor-save-status');
  const b = store.getState().tripWriteBusy;
  if (s) {
    const dirty = !b && hasUnsavedChanges(store, session);
    s.textContent = b ? '⏳ 保存中…' : dirty ? '● 未保存の変更あり' : '✓ 保存済み';
    s.dataset.state = b ? 'saving' : dirty ? 'dirty' : 'saved';
  }
  ['save-draft', 'publish-trip', 'reload-draft'].forEach(id => { if ($(id)) $(id).disabled = b; });
}

export function confirmEditorLeave(store, session) {
  if (store.getState().tripWriteBusy || session.saving) { showToast('保存が終わるまでお待ちください。', true); return false; }
  return !hasUnsavedChanges(store, session) || window.confirm('未保存の変更があります。保存せずに移動しますか？');
}

export function startEditorSession(store, session, saved = true, version = null) {
  store.getState().dirtyDialogs.clear();
  session.open({ trip: store.getState().activeTrip, planning: store.getState().activePlanning, version, saved });
  updateSaveStatus(store, session);
}

export function handleEditorInput(store, session, event) {
  if (!store.getState().activeTrip) return;
  const d = event?.target?.closest?.('#card-dialog, #candidate-dialog, #candidate-adopt-dialog');
  if (d) store.getState().dirtyDialogs.add(d.id);
  if (d || event?.target?.closest?.('#view-editor')) { store.setState(s => ({ editorInputRevision: s.editorInputRevision + 1 })); updateSaveStatus(store, session); }
}

export function closeEditingDialog(store, id) {
  if (store.getState().dirtyDialogs.has(id) && !window.confirm('この画面の未反映の入力を破棄しますか？')) return;
  $(id).close();
}

export function handleEditorUnload(store, session, event) {
  if (store.getState().tripWriteBusy || hasUnsavedChanges(store, session)) { event.preventDefault(); event.returnValue = ''; }
}

export function openTripEditor(store, session, callbacks = {}, tripId = '') {
  const state = store.getState();
  if (state.trips.get(tripId)?.loadError) return showToast('下書きに読込エラーがあります。元データを保管して修復してください。', true);
  if (!confirmEditorLeave(store, session)) return;
  store.setState({ lastDayPlanUndo: null }); if ($('undo-day-plan')) $('undo-day-plan').hidden = true;
  const isExisting = Boolean(tripId && state.trips.has(tripId));
  const activeTrip = isExisting ? deepClone(state.trips.get(tripId).trip) : blankTrip();
  const activePlanning = isExisting && state.trips.get(tripId).planning ? deepClone(state.trips.get(tripId).planning) : blankPlanning();
  store.setState({ activeTrip, activePlanning, activeDayKey: Object.keys(activeTrip.days)[0] || 'day1' });
  renderEditor(store, session, callbacks);
  switchEditorTab(isExisting ? 'itinerary' : 'basics');
  if (typeof callbacks.showView === 'function') callbacks.showView('editor');
  startEditorSession(store, session, isExisting, state.trips.get(tripId)?.version ?? null);
}

export function readTripBasics(store) {
  const trip = store.getState().activeTrip;
  if (!trip) return;
  trip.tripId = $('trip-id').value.trim(); trip.title = $('trip-title').value.trim(); trip.subtitle = $('trip-subtitle').value.trim(); trip.catchphrase = $('trip-catchphrase').value.trim();
  trip.startDate = $('trip-start-date').value; trip.endDate = $('trip-end-date').value; trip.archived = $('trip-archived').checked;
  trip.theme = { mode: $('trip-theme-mode').value, accent: $('trip-theme-accent').value };
  trip.features = { nowMode: $('feature-now').checked, expenses: $('feature-expenses').checked, notifications: $('feature-notifications').checked };
  if (store.getState().activeDayKey) trip.dayLabels[store.getState().activeDayKey] = $('editor-day-label').value.trim();
}

export function readTripPlanning(store) {
  if (!store.getState().activePlanning) store.setState({ activePlanning: blankPlanning() });
  const notesInput = $('trip-planning-notes');
  if (notesInput) store.getState().activePlanning.notes = notesInput.value.trim();
}

export function readDaySettings(store) {
  const trip = store.getState().activeTrip;
  const dayKey = store.getState().activeDayKey;
  if (!trip || !dayKey) return;
  trip.daySettings ||= {};
  const departureTime = $('editor-day-departure').value;
  const note = $('editor-day-note').value.trim();
  if (departureTime || note) trip.daySettings[dayKey] = { departureTime, note };
  else delete trip.daySettings[dayKey];
}

export function renderEditor(store, session, callbacks = {}) {
  const trip = store.getState().activeTrip;
  if (!trip) return;
  store.setState({ activePlanning: reconcileAssignments(trip, store.getState().activePlanning || blankPlanning()), activeCandidateForAdopt: null });
  $('trip-id').value = trip.tripId; $('trip-title').value = trip.title; $('trip-subtitle').value = trip.subtitle;
  $('trip-catchphrase').value = trip.catchphrase; $('trip-start-date').value = trip.startDate; $('trip-end-date').value = trip.endDate;
  $('trip-archived').checked = trip.archived === true; $('trip-theme-mode').value = trip.theme?.mode || 'auto'; $('trip-theme-accent').value = trip.theme?.accent || '#f4d35e';
  $('feature-now').checked = trip.features?.nowMode !== false; $('feature-expenses').checked = trip.features?.expenses !== false; $('feature-notifications').checked = trip.features?.notifications === true;
  if ($('trip-planning-notes')) $('trip-planning-notes').value = store.getState().activePlanning?.notes || '';
  updateEditorHeaderMeta(trip, store.getState().activePlanning);
  renderDaySelect(store); renderEditorCards(store, callbacks);
  callbacks.renderCandidateList?.();
  hideEditorErrors(); renderTripAudit(store); renderPlanningCockpit(store);
  callbacks.refreshAdminDiscussionRooms?.();
}

export function renderDaySelect(store) {
  const select = $('editor-day-select');
  select.replaceChildren();
  const trip = store.getState().activeTrip;
  if (!trip) return;
  Object.keys(trip.days).forEach((dayKey, index) => {
    const opt = document.createElement('option');
    opt.value = dayKey; opt.textContent = `${index + 1}日目 · ${trip.dayLabels[dayKey] || `DAY ${index + 1}`}`;
    opt.selected = dayKey === store.getState().activeDayKey; select.append(opt);
  });
  $('editor-day-label').value = trip.dayLabels[store.getState().activeDayKey] || '';
  $('editor-day-departure').value = trip.daySettings?.[store.getState().activeDayKey]?.departureTime || '';
  $('editor-day-note').value = trip.daySettings?.[store.getState().activeDayKey]?.note || '';
  renderDayQuickTabs(store);
}

export function renderEditorCards(store, callbacks = {}) {
  const list = $('editor-card-list');
  list.replaceChildren();
  const state = store.getState();
  const cards = state.activeTrip?.days?.[state.activeDayKey] || [];
  updateEditorHeaderMeta(state.activeTrip, state.activePlanning);
  renderDayQuickTabs(store);
  if (!cards.length) return list.append(makeElement('div', 'empty-state', 'この日の予定はまだありません。右上の「＋ 予定を追加」からスポットを追加してください。'));
  cards.forEach((card, index) => {
    list.append(buildEditorCardRow({
      card, index, total: cards.length,
      onReorder: (from, to) => callbacks.previewCardReorder?.(from, to),
      onEdit: idx => openCardDialog(store, idx)
    }));
  });
}

export function addDay(store, callbacks = {}) {
  readTripBasics(store); readDaySettings(store);
  const trip = store.getState().activeTrip;
  const numbers = Object.keys(trip.days).map(key => Number((key.match(/\d+/) || [0])[0]));
  const next = Math.max(0, ...numbers) + 1;
  const dayKey = `day${next}`;
  trip.days[dayKey] = []; trip.dayLabels[dayKey] = `DAY ${next}`;
  store.setState({ activeDayKey: dayKey });
  renderDaySelect(store); renderEditorCards(store, callbacks);
}

export const BUTTON_PRESETS = {
  route: 'ルート | https://www.google.com/maps/dir/?api=1',
  ana: 'ANA | https://www.ana.co.jp/ | intent://#Intent;scheme=https;package=jp.co.ana.android.travel;end | anaapp:// | ana',
  toyota: 'TOYOTA | https://rent.toyota.co.jp/cp/18_ser_app01/ | intent://#Intent;scheme=toyotaapp;package=jp.co.toyota.rent.app.android;S.browser_fallback_url=https%3A%2F%2Frent.toyota.co.jp%2Fcp%2F18_ser_app01%2F;end | toyotaapp:// | toyota',
  jalan: 'じゃらん | https://www.jalan.net/ | intent://#Intent;scheme=jalan;package=net.jalan.android;S.browser_fallback_url=https%3A%2F%2Fwww.jalan.net%2F;end | https://www.jalan.net/ | jalan',
  'hello-cycling': '自転車 | https://www.hellocycling.jp/ | intent://main/#Intent;scheme=hellocycling;package=jp.hellocycling.hellocycling;S.browser_fallback_url=https%3A%2F%2Fwww.hellocycling.jp%2F;end | hellocycling://main | helloCycling'
};

export function addPresetLink(presetKey) {
  const preset = BUTTON_PRESETS[presetKey]; if (!preset) return;
  const current = $('card-links').value.trim();
  $('card-links').value = current ? `${current}\n${preset}` : preset;
  $('card-links').dispatchEvent(new Event('input', { bubbles: true }));
}

export function cardFieldMap() {
  return {
    time: $('card-time').value.trim(), badge: $('card-badge').value.trim(), title: $('card-title').value.trim(),
    desc: $('card-desc').value.trim(), mapQuery: $('card-map-query').value.trim(), mapUrl: $('card-map-url').value.trim(), routeHint: $('card-route-hint')?.value.trim() || '', waypoints: $('card-waypoints')?.value.trim() || '',
    official: $('card-official').value.trim(), officialLabel: $('card-official-label').value.trim(), tabelog: $('card-tabelog').value.trim(),
    jalan: $('card-jalan').value.trim(), asoview: $('card-asoview')?.value.trim() || '', image: $('card-image').value.trim(), links: parseCardLinks($('card-links').value),
    timeLocked: $('card-time-locked').checked, expenseShortcut: $('card-expense').checked, travelMinutesFromPrevious: Number($('card-travel-minutes').value),
    notifyBeforeMinutes: $('card-notify').value.split(',').filter(v => v.trim() !== '').map(v => Number(v.trim())),
    constraints: { opensAt: $('card-opens-at').value, closesAt: $('card-closes-at').value, reservationAt: $('card-reservation-at').value, lastEntryAt: $('card-last-entry-at').value, departureBy: $('card-departure-by').value, arrivalBufferMinutes: Number($('card-arrival-buffer').value) },
    reservation: { number: $('card-reservation-number').value.trim(), name: $('card-reservation-name').value.trim(), phone: $('card-reservation-phone').value.trim(), deadline: $('card-reservation-deadline').value.trim(), url: $('card-reservation-url').value.trim(), note: $('card-reservation-note').value.trim() }
  };
}

export function openCardDialog(store, index = -1) {
  const cards = store.getState().activeTrip.days[store.getState().activeDayKey] || [];
  const card = index >= 0 ? cards[index] : {};
  $('card-index').value = String(index);
  $('card-dialog-title').textContent = index >= 0 ? '予定カードを編集' : '予定カードを追加';
  ['time', 'badge', 'title', 'desc', 'mapQuery', 'mapUrl', 'routeHint', 'waypoints', 'official', 'officialLabel', 'tabelog', 'jalan', 'asoview', 'image'].forEach(k => { const el = $(`card-${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`); if (el) el.value = text(card[k]); });
  ['opensAt', 'closesAt', 'reservationAt', 'lastEntryAt', 'departureBy'].forEach(k => { $(`card-${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`).value = card.constraints?.[k] || ''; });
  ['number', 'name', 'phone', 'deadline', 'url', 'note'].forEach(k => { $(`card-reservation-${k}`).value = card.reservation?.[k] || ''; });
  $('card-links').value = formatCardLinks(card.links);
  $('card-time-locked').checked = card.timeLocked === true; $('card-expense').checked = card.expenseShortcut === true;
  $('card-travel-minutes').value = card.travelMinutesFromPrevious || ''; $('card-notify').value = (card.notifyBeforeMinutes || []).join(', ');
  $('card-arrival-buffer').value = card.constraints?.arrivalBufferMinutes || '';
  $('delete-card').hidden = index < 0; $('move-card-up').hidden = index <= 0; $('move-card-down').hidden = index < 0 || index >= cards.length - 1;
  $('open-move-day').hidden = index < 0; $('open-cascade-adjust').hidden = index < 0;
  syncCardDialogSections(card);
  $('card-dialog').showModal();
}

export function saveCard(store, event, callbacks = {}) {
  event.preventDefault();
  const index = Number($('card-index').value);
  const dayKey = store.getState().activeDayKey;
  const cards = store.getState().activeTrip.days[dayKey] || [];
  const base = index >= 0 ? cards[index] : {};
  const raw = { ...base, ...cardFieldMap(), cardId: base.cardId || `card-${crypto.randomUUID()}` };
  const mapErrors = [...validateTripInput({ tripId: store.getState().activeTrip.tripId, title: store.getState().activeTrip.title, days: { [dayKey]: [raw] } }), ...validateMapFields(raw, { allowLegacy: false })];
  if (mapErrors.length) return showToast(mapErrors.join('\n'), true);
  const next = cleanCard(raw, dayKey, index >= 0 ? index : cards.length);
  if (!next.title || !next.desc) return showToast('タイトルと説明を入力してください。', true);
  const beforeTime = base.time || '';
  const afterTime = next.time || '';
  if (index >= 0 && base.timeLocked === true && beforeTime !== afterTime) {
    const msg = afterTime ? `「${base.title || 'この予定'}」は固定予定です。時刻を「${beforeTime || '未定'}」から「${afterTime}」へ変更しますか？` : `「${base.title || 'この予定'}」は固定予定です。設定時刻（${beforeTime}）を削除して未定にしますか？`;
    if (!window.confirm(msg)) return;
  }
  if (index >= 0) cards[index] = next; else cards.push(next);
  $('card-dialog').close();
  renderEditorCards(store, callbacks); callbacks.renderTripAudit?.();
}

export function deleteCard(store, callbacks = {}) {
  const index = Number($('card-index').value);
  const state = store.getState();
  const cards = state.activeTrip?.days?.[state.activeDayKey];
  if (!Array.isArray(cards) || !Number.isInteger(index) || index < 0 || index >= cards.length) return;
  if (!window.confirm('この予定カードを削除しますか？')) return;
  const target = cards[index];
  const candidate = target.cardId && state.activePlanning?.candidates?.find(item => item.assignedCardId === target.cardId);
  const result = candidate ? unassignCandidate(state.activeTrip, state.activePlanning, candidate.id) : null;
  if (result && !result.error) {
    state.activeTrip = result.trip; state.activePlanning = result.planning;
  } else {
    cards.splice(index, 1);
    if (cards[index]) delete cards[index].travelMinutesFromPrevious;
    state.activePlanning = reconcileAssignments(state.activeTrip, state.activePlanning);
  }
  state.activeCandidateForAdopt = null;
  $('card-dialog').close();
  callbacks.renderCandidateList?.(); renderEditorCards(store, callbacks); callbacks.renderTripAudit?.();
  if (result?.warnings?.length) showToast(result.warnings.join(' '));
}

export function moveCard(store, direction, callbacks = {}) {
  const index = Number($('card-index').value);
  const cards = store.getState().activeTrip?.days?.[store.getState().activeDayKey] || [];
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= cards.length) return;
  $('card-dialog').close();
  callbacks.previewCardReorder?.(index, destination);
}

export function hideEditorErrors() {
  if ($('editor-errors')) { $('editor-errors').hidden = true; $('editor-errors').textContent = ''; }
}

export function showEditorErrors(errors) {
  if (errors.some(msg => /ID|タイトル|開始日|終了日/.test(msg))) switchEditorTab('basics');
  if ($('editor-errors')) {
    $('editor-errors').hidden = false;
    $('editor-errors').textContent = `⚠️ 保存前に確認してください\n・${errors.join('\n・')}`;
    $('editor-errors').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

export function renderTripAudit(store, report = analyzeTrip(store.getState().activeTrip || {})) {
  const panel = $('trip-audit');
  if (!panel) return;
  const hasProblems = report.errors.length > 0 || report.warnings.length > 0;
  panel.classList.toggle('is-clean', !hasProblems);
  const head = makeElement('div', 'v2-audit-head');
  const counts = makeElement('div', 'v2-audit-counts');
  if (report.errors.length) counts.append(makeElement('span', 'error', `要修正 ${report.errors.length}件`));
  if (report.warnings.length) counts.append(makeElement('span', 'warning', `確認 ${report.warnings.length}件`));
  if (!hasProblems) {
    head.append(makeElement('strong', 'v2-audit-clean-msg', '✅ 公開前チェックOK — このまま「🚀 参加者へ公開」を押せます'), counts);
    panel.replaceChildren(head);
    return;
  }
  head.append(makeElement('strong', '', '📋 公開前チェック（時刻の重なり・入力確認）'), counts);
  const list = makeElement('ul', 'v2-audit-list');
  report.issues.filter(i => i.level !== 'info').slice(0, 12).forEach(item => { const r = makeElement('li', '', item.message); r.dataset.level = item.level; list.append(r); });
  panel.replaceChildren(head, list);
}

export function renderPlanningCockpit(store) {
  const panel = $('planning-cockpit');
  const trip = store.getState().activeTrip;
  if (!panel || !trip) return;
  updateEditorHeaderMeta(trip, store.getState().activePlanning);
}

export function applyTripTemplate(store) {
  const state = store.getState();
  if (!state.activeTrip) return;
  if (state.activeTrip.checklist?.length && !window.confirm('現在の持ち物リストをテンプレートで置き換えますか？')) return;
  const templates = {
    domestic: [{ category: 'DOCUMENTS', items: [{ name: '航空券・予約確認' }, { name: '本人確認書類' }, { name: '保険証・常備薬' }] }, { category: 'POWER', items: [{ name: 'スマートフォン充電器' }, { name: 'モバイルバッテリー' }] }],
    drive: [{ category: 'DRIVE', items: [{ name: '運転免許証' }, { name: 'ETCカード' }, { name: '車載充電器・スマホホルダー' }] }, { category: 'TRAVEL', items: [{ name: '予約確認' }, { name: '保険証・常備薬' }, { name: 'モバイルバッテリー' }] }],
    rail: [{ category: 'TICKETS', items: [{ name: '乗車券・指定席予約' }, { name: '交通系ICカード' }, { name: '本人確認書類' }] }, { category: 'TRAVEL', items: [{ name: '時刻表・乗換確認' }, { name: 'モバイルバッテリー' }, { name: '常備薬' }] }]
  };
  const type = $('trip-template').value;
  state.activeTrip.checklist = deepClone(templates[type] || templates.domestic);
  state.activeTrip.theme.accent = type === 'drive' ? '#f4d35e' : type === 'rail' ? '#77b7ff' : '#eab8c9';
  $('trip-theme-accent').value = state.activeTrip.theme.accent;
  showToast('持ち物リストのテンプレートを反映しました。');
}

export function showTripPreview(store) {
  readTripBasics(store); readDaySettings(store);
  const trip = migrateTripToV2(store.getState().activeTrip);
  const phone = makeElement('div', 'v2-phone');
  const header = makeElement('header', 'v2-phone-header');
  header.append(makeElement('small', '', 'SHIORI プレビュー'), makeElement('h3', '', trip.title), makeElement('span', 'muted small', `${trip.startDate || '日付未設定'} — ${trip.endDate || ''}`));
  phone.append(header);
  Object.entries(trip.days).forEach(([dayKey, cards]) => {
    phone.append(makeElement('div', 'v2-preview-day', trip.dayLabels[dayKey] || dayKey.toUpperCase()));
    cards.forEach(card => {
      const item = makeElement('article', 'v2-preview-card');
      item.append(makeElement('time', '', card.time), makeElement('strong', '', `${card.badge} · ${card.title}`), makeElement('p', '', card.desc)); phone.append(item);
    });
  });
  $('preview-content').replaceChildren(phone);
  $('preview-dialog').showModal();
}

export async function showPublishHistory(store, db, session, confirmLeave, callbacks = {}) {
  const state = store.getState();
  if (!state.activeTrip?.tripId) return showToast('しおりIDを保存してから履歴を確認してください。', true);
  const generation = session.generation;
  const content = $('history-content');
  content.textContent = '公開履歴を読み込んでいます…'; $('history-dialog').showModal();
  try {
    const snapshot = await getDocs(collection(db, 'tripHistories', state.activeTrip.tripId, 'versions'));
    const versions = snapshot.docs.map(item => ({ id: item.id, ...item.data() })).sort((a, b) => (b.publishedAt?.toMillis?.() || 0) - (a.publishedAt?.toMillis?.() || 0));
    const list = makeElement('div', 'v2-history-list');
    if (!versions.length) list.append(makeElement('div', 'empty-state', 'まだ公開履歴はありません。次回公開から自動で記録されます。'));
    versions.forEach((version, index) => {
      const row = makeElement('article', 'v2-history-item');
      const copy = makeElement('div');
      const restore = makeElement('button', 'button compact', 'この版を下書きに復元');
      copy.append(makeElement('strong', '', `公開版 #${versions.length - index}`), makeElement('small', '', formatTimestamp(version.publishedAt)));
      restore.type = 'button';
      restore.addEventListener('click', () => {
        try {
          if (session.generation !== generation) return showToast('編集対象が変わっています。履歴を開き直してください。', true);
          if (typeof confirmLeave === 'function' && !confirmLeave()) return;
          store.setState({ activeTrip: normalizeTrip(JSON.parse(version.payloadJson), store.getState().activeTrip.tripId), activeDayKey: Object.keys(store.getState().activeTrip.days)[0] || 'day1' });
          renderEditor(store, session, callbacks); $('history-dialog').close(); updateSaveStatus(store, session);
          showToast('選択した公開版を下書きへ復元しました。保存・公開するまで本番は変わりません。');
        } catch { showToast('履歴を復元できません。', true); }
      });
      row.append(copy, restore); list.append(row);
    });
    content.replaceChildren(list);
  } catch (error) { content.textContent = `履歴を読み込めません: ${error.message}`; }
}

export function initEditorView({ store, session, db, callbacks = {} }) {
  $('editor-day-select').addEventListener('change', e => {
    readTripBasics(store); readDaySettings(store); store.setState({ activeDayKey: e.target.value });
    $('editor-day-label').value = store.getState().activeTrip.dayLabels?.[e.target.value] || '';
    $('editor-day-departure').value = store.getState().activeTrip.daySettings?.[e.target.value]?.departureTime || '';
    $('editor-day-note').value = store.getState().activeTrip.daySettings?.[e.target.value]?.note || '';
    renderEditorCards(store, callbacks);
  });
  $('editor-day-departure').addEventListener('input', () => readDaySettings(store)); $('editor-day-note').addEventListener('input', () => readDaySettings(store));
  $('editor-day-label').addEventListener('input', e => { const t = store.getState().activeTrip; if (t && store.getState().activeDayKey) { t.dayLabels[store.getState().activeDayKey] = e.target.value; renderDayQuickTabs(store); } });
  const clickMap = {
    'add-day': () => addDay(store, callbacks), 'apply-template': () => applyTripTemplate(store),
    'add-card': () => openCardDialog(store, -1), 'close-card-dialog': () => closeEditingDialog(store, 'card-dialog'),
    'delete-card': () => deleteCard(store, callbacks), 'move-card-up': () => moveCard(store, -1, callbacks),
    'move-card-down': () => moveCard(store, 1, callbacks), 'open-move-day': () => callbacks.openMoveDayDialog?.(Number($('card-index').value)),
    'open-cascade-adjust': () => callbacks.openCascadeAdjustDialog?.(Number($('card-index').value)),
    'preview-trip': () => showTripPreview(store), 'history-trip': () => showPublishHistory(store, db, session, () => confirmEditorLeave(store, session), callbacks),
    'close-preview': () => $('preview-dialog').close(), 'close-history': () => $('history-dialog').close()
  };
  Object.entries(clickMap).forEach(([id, handler]) => { $(id)?.addEventListener('click', handler); });
  $('card-form')?.addEventListener('submit', e => saveCard(store, e, callbacks));
  document.querySelectorAll('[data-add-preset]').forEach(btn => btn.addEventListener('click', () => addPresetLink(btn.dataset.addPreset)));
}
