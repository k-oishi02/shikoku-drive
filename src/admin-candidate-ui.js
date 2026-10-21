/**
 * Admin Candidate Shelf UI Controller
 *
 * Manages candidate spot shelf, modal CRUD, filter toggles,
 * and day timeline adoption workflow with collision preview.
 */

import { $, makeElement, showToast, deepClone, text } from './admin-ui.js';
import { resolveMapFields, validateMapFields, mapHref, mapSearchQuery, mapRouteHref } from './map-links.js';
import { validateCandidateInput } from './draft-validation.js';
import { cleanCandidate, cleanCard, parseTimeRange, formatMinute } from './trip-v2-index.js';
import { inspectAssignment, unassignCandidate } from './admin-candidate-state.js';
import { validatePlacement } from './admin-placement.js';
import { blankPlanning } from './admin-trip-service.js';

export const CATEGORY_NAMES = {
  gourmet: '食事',
  sightseeing: '観光',
  hotel: '宿泊',
  transport: '交通',
  other: 'その他'
};

export const CATEGORY_BADGES = {
  gourmet: 'GOURMET',
  sightseeing: 'SPOT',
  hotel: 'HOTEL',
  transport: 'TRANSPORT',
  other: 'OTHER'
};

export const PRIORITY_NAMES = {
  high: '行きたい',
  normal: 'できれば',
  low: '時間があれば'
};

const btn = (cls, txt, fn, dis = false) => {
  const b = makeElement('button', cls, txt);
  b.type = 'button'; b.disabled = dis;
  if (fn) b.addEventListener('click', fn);
  return b;
};

export function renderCandidateList(store, callbacks = {}) {
  const list = $('editor-candidate-list');
  if (!list) return;
  list.replaceChildren();
  const state = store.getState();
  const candidates = state.activePlanning?.candidates || [];
  const filterStatus = state.candidateFilterStatus || 'all';
  const filterCategory = state.candidateFilterCategory || 'all';

  const filtered = candidates.filter(item => {
    if (filterStatus === 'draft' && item.status !== 'draft') return false;
    if (filterStatus === 'assigned' && item.status !== 'assigned') return false;
    if (filterCategory !== 'all' && item.category !== filterCategory) return false;
    return true;
  });

  if (!filtered.length) {
    const emptyMsg = candidates.length === 0
      ? '候補スポットはまだありません。「＋ 候補を追加」から行きたい場所やお店を登録できます。'
      : '条件に一致する候補スポットがありません。';
    list.append(makeElement('div', 'empty-state', emptyMsg));
    return;
  }

  filtered.forEach(candidate => {
    const isAssigned = candidate.status === 'assigned';
    const card = makeElement('article', `candidate-card ${isAssigned ? 'is-assigned' : ''}`);
    const header = makeElement('div', 'candidate-header');
    const titleWrap = makeElement('div', 'candidate-title-wrap');
    titleWrap.append(makeElement('strong', '', candidate.title));

    const badges = makeElement('div', 'candidate-badges');
    const catBadge = makeElement('span', 'candidate-badge', CATEGORY_NAMES[candidate.category] || candidate.category);
    catBadge.dataset.cat = candidate.category;
    badges.append(catBadge);

    const priBadge = makeElement('span', `candidate-priority-tag priority-${candidate.priority}`, PRIORITY_NAMES[candidate.priority] || candidate.priority);
    badges.append(priBadge);

    if (candidate.durationMinutes) {
      badges.append(makeElement('span', 'candidate-badge', `滞在 ${candidate.durationMinutes}分`));
    }

    const statusTag = makeElement(
      'span',
      `candidate-status-tag ${isAssigned ? 'status-assigned' : 'status-draft'}`,
      isAssigned ? `${(candidate.assignedDay || '').toUpperCase()} に追加済` : '未配置'
    );
    badges.append(statusTag);
    titleWrap.append(badges);
    header.append(titleWrap);
    card.append(header);

    if (candidate.notes) {
      card.append(makeElement('p', 'candidate-notes-preview', candidate.notes));
    }

    const actions = makeElement('div', 'candidate-card-actions');
    actions.append(btn('compact primary', isAssigned ? 'ADDED' : 'ADD TO DAY', () => openCandidateAdoptDialog(store, candidate.id), isAssigned));
    actions.append(btn('compact ghost', 'EDIT', () => openCandidateDialog(store, candidate.id)));
    if (isAssigned) actions.append(btn('compact ghost', 'REMOVE FROM DAY', () => resetCandidateStatus(store, candidate.id, callbacks)));
    const mapsUrl = mapHref(candidate);
    if (mapsUrl) {
      const mapsLink = makeElement('a', 'button compact ghost', 'MAP ↗');
      mapsLink.href = mapsUrl; mapsLink.target = '_blank'; mapsLink.rel = 'noopener noreferrer';
      actions.append(mapsLink);
    }
    actions.append(btn('compact danger', '削除', () => deleteCandidate(store, candidate.id, callbacks)));

    card.append(actions);
    list.append(card);
  });
}

export function openCandidateDialog(store, candidateId = '') {
  const state = store.getState();
  if (!state.activePlanning) {
    store.setState({ activePlanning: blankPlanning() });
  }
  const candidates = store.getState().activePlanning?.candidates || [];
  const candidate = candidateId ? candidates.find(c => c.id === candidateId) : null;

  $('candidate-id').value = candidate?.id || '';
  $('candidate-dialog-title').textContent = candidate ? '候補を編集' : '候補を追加';
  $('candidate-category').value = candidate?.category || 'sightseeing';
  $('candidate-priority').value = candidate?.priority || 'normal';
  $('candidate-duration').value = String(candidate?.durationMinutes ?? 60);
  const maps = resolveMapFields(candidate);
  $('candidate-map-query').value = maps.mapQuery;
  $('candidate-map-url').value = maps.mapUrl;
  ['title', 'official', 'officialLabel', 'tabelog', 'jalan', 'notes'].forEach(k => {
    $(`candidate-${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`).value = text(candidate?.[k]);
  });

  $('delete-candidate').hidden = !candidate;
  $('reset-candidate-status').hidden = !(candidate && candidate.status === 'assigned');

  $('candidate-dialog').showModal();
}

export function saveCandidate(store, event, callbacks = {}) {
  event.preventDefault();
  const state = store.getState();
  if (!state.activePlanning) {
    store.setState({ activePlanning: blankPlanning() });
  }
  const candidateId = $('candidate-id').value.trim();
  const candidates = store.getState().activePlanning.candidates;
  const existing = candidateId ? candidates.find(c => c.id === candidateId) : null;
  if (candidateId && !existing) return showToast('候補が見つかりません。開き直してください。', true);

  const raw = {
    ...existing, id: candidateId || `cand-${crypto.randomUUID()}`,
    title: $('candidate-title').value.trim(), category: $('candidate-category').value, priority: $('candidate-priority').value,
    durationMinutes: $('candidate-duration').value.trim() === '' ? NaN : Number($('candidate-duration').value),
    mapQuery: $('candidate-map-query').value.trim(), mapUrl: $('candidate-map-url').value.trim(),
    official: $('candidate-official').value.trim(), officialLabel: $('candidate-official-label').value.trim(),
    tabelog: $('candidate-tabelog').value.trim(), jalan: $('candidate-jalan').value.trim(), notes: $('candidate-notes').value.trim(),
    status: existing?.status || 'draft', assignedDay: existing?.assignedDay, assignedCardId: existing?.assignedCardId,
    createdAt: existing?.createdAt, updatedAt: new Date().toISOString()
  };

  const mapErrors = [...validateCandidateInput(raw), ...validateMapFields(raw, { allowLegacy: false })];
  if (mapErrors.length) return showToast(mapErrors.join('\n'), true);
  const cleaned = cleanCandidate(raw, candidates.length);
  if (!cleaned || !cleaned.title) {
    showToast('場所名・スポット名を入力してください。', true);
    return;
  }

  if (existing) {
    const index = candidates.findIndex(c => c.id === candidateId);
    if (index >= 0) candidates[index] = cleaned;
  } else {
    candidates.push(cleaned);
  }

  $('candidate-dialog').close();
  renderCandidateList(store, callbacks);
  showToast('候補を反映しました。下書き保存でクラウドに保存してください。');
}

export function deleteCandidate(store, candidateId, callbacks = {}) {
  const state = store.getState();
  if (!state.activePlanning) return;
  const candidates = state.activePlanning.candidates;
  const index = candidates.findIndex(c => c.id === candidateId);
  if (index < 0) return;
  const target = candidates[index];
  const msg = target.status === 'assigned'
    ? `「${target.title}」は日程に組み込まれています。候補リストから削除しますか？（日程のカードは残ります）`
    : `「${target.title}」を候補から削除しますか？`;
  if (!window.confirm(msg)) return;
  candidates.splice(index, 1);
  if ($('candidate-dialog').open) $('candidate-dialog').close();
  renderCandidateList(store, callbacks);
  showToast('候補スポットを削除しました。');
}

export function resetCandidateStatus(store, candidateId, callbacks = {}) {
  const state = store.getState();
  const assignment = inspectAssignment(state.activeTrip, state.activePlanning, candidateId);
  if (assignment.error) return showToast(`${assignment.error}日程カードを確認してください。`, true);
  if (!window.confirm(`「${assignment.card.title}」のカードを日程から取り除き、候補に戻しますか？`)) return;
  const result = unassignCandidate(state.activeTrip, state.activePlanning, candidateId);
  if (result.error) return showToast(result.error, true);
  store.setState({
    activeTrip: result.trip,
    activePlanning: result.planning
  });
  if ($('candidate-dialog').open) $('candidate-dialog').close();
  if (typeof callbacks.renderEditor === 'function') {
    callbacks.renderEditor();
  }
  showToast(result.warnings.join(' ') || '日程への追加を取り消しました。下書き保存してください。');
}

export function calculateNextAvailableTime(store, dayKey, travelMinutes = 0) {
  const cards = store.getState().activeTrip?.days?.[dayKey] || [];
  if (!cards.length) return store.getState().activeTrip?.daySettings?.[dayKey]?.departureTime || '09:00';
  const range = parseTimeRange(cards[cards.length - 1].time);
  return range ? formatMinute(range.end + travelMinutes) : '09:00';
}

export function openCandidateAdoptDialog(store, candidateId) {
  const state = store.getState();
  if (!state.activePlanning) return;
  const candidate = state.activePlanning.candidates.find(c => c.id === candidateId);
  if (!candidate) return;
  if (candidate.status === 'assigned') return showToast('この候補は追加済みです。変更する場合は日程カードを編集してください。', true);
  store.setState({ activeCandidateForAdopt: candidate });

  $('adopt-candidate-id').value = candidate.id;
  const summaryBox = $('adopt-candidate-summary');
  summaryBox.replaceChildren();
  summaryBox.append(makeElement('strong', '', `候補: ${candidate.title}`), makeElement('p', '', `分類: ${CATEGORY_NAMES[candidate.category] || candidate.category} · 想定滞在時間: ${candidate.durationMinutes || 60}分${candidate.priority ? ' · 優先度: ' + PRIORITY_NAMES[candidate.priority] : ''}`));

  const daySelect = $('adopt-day-select');
  daySelect.replaceChildren();
  const dayKeys = Object.keys(state.activeTrip?.days || {});
  dayKeys.forEach((dayKey, i) => {
    const opt = document.createElement('option');
    opt.value = dayKey; opt.textContent = `${dayKey.toUpperCase()} · ${state.activeTrip.dayLabels?.[dayKey] || 'DAY ' + (i + 1)}`;
    if (dayKey === (candidate.assignedDay || state.activeDayKey || dayKeys[0])) opt.selected = true;
    daySelect.append(opt);
  });

  updateAdoptPositionOptions(store);

  const duration = candidate.durationMinutes || 60;
  $('adopt-duration-minutes').value = String(duration);
  $('adopt-travel-minutes').value = '0';
  $('adopt-card-desc').value = '';

  const initialDay = daySelect.value;
  const initialStartTime = calculateNextAvailableTime(store, initialDay, 0);
  $('adopt-start-time').value = initialStartTime;

  updateAdoptPreview(store);
  $('candidate-adopt-dialog').showModal();
}

export function updateAdoptPositionOptions(store) {
  const dayKey = $('adopt-day-select').value, posSelect = $('adopt-position-select');
  posSelect.replaceChildren();
  const cards = store.getState().activeTrip?.days?.[dayKey] || [];
  if (!cards.length) {
    const opt = document.createElement('option'); opt.value = 'end'; opt.textContent = '先頭に追加（1番目のカード）';
    posSelect.append(opt); return;
  }
  const startOpt = document.createElement('option'); startOpt.value = 'start'; startOpt.textContent = '先頭に追加'; posSelect.append(startOpt);
  cards.forEach((card, i) => {
    const opt = document.createElement('option'); opt.value = String(i + 1); opt.textContent = `${i + 1}. 「${card.title || '無題'}」の後に追加`; posSelect.append(opt);
  });
  const endOpt = document.createElement('option'); endOpt.value = 'end'; endOpt.textContent = `末尾に追加（${cards.length + 1}番目）`; endOpt.selected = true; posSelect.append(endOpt);
}

export function readAdoptPlacement(store) {
  const dayKey = $('adopt-day-select').value;
  return validatePlacement({
    cards: store.getState().activeTrip?.days?.[dayKey],
    position: $('adopt-position-select').value,
    startTime: $('adopt-start-time').value,
    durationMinutes: $('adopt-duration-minutes').value,
    travelMinutes: $('adopt-travel-minutes').value
  });
}

export function updateAdoptPreview(store) {
  const candidate = store.getState().activeCandidateForAdopt;
  const result = readAdoptPlacement(store);
  const previewBox = $('adopt-preview');
  previewBox.replaceChildren();
  if (!candidate) result.errors.push('候補を選び直してください。');
  if (candidate?.status === 'assigned') result.errors.push('この候補は日程に追加済みです。');
  $('adopt-end-time').value = result.time ? result.time.slice(-5) : '';
  $('confirm-adopt').disabled = result.errors.length > 0;
  const addRow = (time, title) => {
    const row = makeElement('div', 'adopt-preview-item');
    row.append(makeElement('span', 'adopt-preview-time', time || '未定'), makeElement('span', 'adopt-preview-title', title));
    previewBox.append(row);
  };
  if (result.prevCard) addRow(result.prevCard.time, `前: ${result.prevCard.title}`);
  addRow(result.time, `追加: ${candidate?.title || '未選択'}`);
  if (result.nextCard) addRow(result.nextCard.time, `次: ${result.nextCard.title}`);
  result.errors.forEach(message => previewBox.append(makeElement('div', 'adopt-preview-alert error', message)));
  result.warnings.forEach(message => previewBox.append(makeElement('div', 'adopt-preview-alert warning', message)));
  previewBox.classList.toggle('has-conflict', result.errors.length > 0);
  previewBox.classList.toggle('is-valid', result.errors.length === 0 && result.warnings.length === 0);
  if (!result.errors.length && !result.warnings.length) previewBox.append(makeElement('div', 'adopt-preview-alert is-ok', '前後の予定との重複はありません。'));
  const routeLink = $('adopt-maps-route-link');
  const routeUrl = mapRouteHref(result.prevCard, candidate);
  routeLink.hidden = !routeUrl;
  routeLink.href = routeUrl || '#';
  return result;
}

export function confirmAdoptCandidate(store, event, callbacks = {}) {
  event.preventDefault();
  const state = store.getState();
  const candidate = state.activeCandidateForAdopt;
  if (!candidate || !state.activePlanning?.candidates.includes(candidate)) return;
  const result = updateAdoptPreview(store);
  if (result.errors.length) return showToast(result.errors[0], true);
  const desc = $('adopt-card-desc').value.trim();
  if (!desc) return showToast('参加者向けの説明文を入力してください。', true);
  if (result.warnings.length && !window.confirm(`${result.warnings.join('\n')}\n内容を確認して追加しますか？`)) return;
  const dayKey = $('adopt-day-select').value;
  const newCard = cleanCard({
    cardId: `card-${crypto.randomUUID()}`, time: result.time, badge: CATEGORY_BADGES[candidate.category] || 'SPOT',
    title: candidate.title, desc, mapQuery: mapSearchQuery(candidate), mapUrl: resolveMapFields(candidate).mapUrl,
    official: candidate.official, officialLabel: candidate.officialLabel, tabelog: candidate.tabelog, jalan: candidate.jalan,
    travelMinutesFromPrevious: Number($('adopt-travel-minutes').value) || undefined
  });
  if (result.nextCard) {
    const nextBefore = deepClone(result.nextCard);
    delete result.nextCard.travelMinutesFromPrevious;
    candidate.placementUndo = {
      dayKey,
      previousCardId: result.prevCard?.cardId || null,
      nextCardId: result.nextCard.cardId,
      nextBefore,
      nextAfter: deepClone(result.nextCard)
    };
  } else {
    delete candidate.placementUndo;
  }
  state.activeTrip.days[dayKey].splice(result.insertIndex, 0, newCard);
  candidate.status = 'assigned';
  candidate.assignedDay = dayKey;
  candidate.assignedCardId = newCard.cardId;
  if (typeof callbacks.readDaySettings === 'function') callbacks.readDaySettings();
  $('candidate-adopt-dialog').close();
  store.setState({ activeDayKey: dayKey });
  if (typeof callbacks.renderDaySelect === 'function') callbacks.renderDaySelect();
  if (typeof callbacks.renderEditorCards === 'function') callbacks.renderEditorCards();
  renderCandidateList(store, callbacks);
  if (typeof callbacks.renderTripAudit === 'function') callbacks.renderTripAudit();
  showToast(`「${candidate.title}」を日程に追加しました。下書き保存で確定してください。`);
}

export function initCandidateShelf({ store, callbacks = {}, closeEditingDialog }) {
  const clickMap = {
    'add-candidate': () => openCandidateDialog(store, ''),
    'close-candidate-dialog': () => closeEditingDialog('candidate-dialog'),
    'delete-candidate': () => deleteCandidate(store, $('candidate-id').value, callbacks),
    'reset-candidate-status': () => resetCandidateStatus(store, $('candidate-id').value, callbacks),
    'close-adopt-dialog': () => closeEditingDialog('candidate-adopt-dialog'),
    'cancel-adopt': () => closeEditingDialog('candidate-adopt-dialog')
  };
  Object.entries(clickMap).forEach(([id, fn]) => $(id)?.addEventListener('click', fn));
  $('candidate-form')?.addEventListener('submit', e => saveCandidate(store, e, callbacks));
  $('candidate-adopt-form')?.addEventListener('submit', e => confirmAdoptCandidate(store, e, callbacks));
  if ($('candidate-filter-status')) {
    $('candidate-filter-status').addEventListener('change', e => { store.setState({ candidateFilterStatus: e.target.value }); renderCandidateList(store, callbacks); });
  }
  if ($('candidate-filter-category')) {
    $('candidate-filter-category').addEventListener('change', e => { store.setState({ candidateFilterCategory: e.target.value }); renderCandidateList(store, callbacks); });
  }
  document.querySelectorAll('[data-set-duration]').forEach(btn => {
    btn.addEventListener('click', () => { $('candidate-duration').value = btn.dataset.setDuration; $('candidate-duration').dispatchEvent(new Event('input', { bubbles: true })); });
  });
  if ($('adopt-day-select')) $('adopt-day-select').addEventListener('change', () => { updateAdoptPositionOptions(store); updateAdoptPreview(store); });
  ['adopt-position-select', 'adopt-start-time', 'adopt-duration-minutes', 'adopt-travel-minutes'].forEach(id => {
    $(id)?.addEventListener('input', () => updateAdoptPreview(store));
    $(id)?.addEventListener('change', () => updateAdoptPreview(store));
  });
}
