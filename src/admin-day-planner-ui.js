/**
 * Admin Day Planner UI Controller
 *
 * Manages move-day, cascade time adjustment, schedule diff comparison,
 * and 1-click undo.
 */

import { $, makeElement, showToast, deepClone } from './admin-ui.js';
import { parseTimeRange, formatMinute } from './trip-v2-index.js';
import {
  planCardReorder,
  planCardMoveDay,
  planCascadeTimeAdjustment,
  applyDayPlan,
  undoDayPlan
} from './admin-day-planner.js';

export function previewCardReorder(store, fromIndex, toIndex, options = {}) {
  const state = store.getState();
  const dayKey = state.activeDayKey;
  const cards = state.activeTrip?.days?.[dayKey] || [];
  const plan = planCardReorder(cards, fromIndex, toIndex, { ...options, dayKey });

  const updatedTrip = deepClone(state.activeTrip);
  updatedTrip.days[dayKey] = plan.updatedCards;

  openPlannerCompareDialog(store, {
    title: `並べ替えの確認 (${dayKey.toUpperCase()})`,
    planResult: plan,
    updatedTrip,
    dayKey,
    isReorder: true,
    fromIndex,
    toIndex
  });
}

export function autoAdjustAndReplan(store) {
  const plan = store.getState().activePendingPlan;
  if (!plan?.isReorder) return;
  const { fromIndex, toIndex } = plan;
  previewCardReorder(store, fromIndex, toIndex, { autoAdjustCascade: true });
}

export function openMoveDayDialog(store, cardIndex) {
  const state = store.getState();
  const cards = state.activeTrip?.days?.[state.activeDayKey] || [];
  const card = cards[cardIndex];
  if (!card) return;

  $('move-day-card-index').value = String(cardIndex);
  $('move-day-card-summary').textContent = `対象: 「${card.title}」 (${card.time || '時刻未定'})${card.timeLocked ? ' 🔒 固定予定' : ''}`;
  $('move-day-allow-locked').checked = false;

  const targetSelect = $('move-day-target-select');
  targetSelect.replaceChildren();
  Object.keys(state.activeTrip?.days || {}).forEach((dk, i) => {
    if (dk !== state.activeDayKey) {
      const opt = document.createElement('option');
      opt.value = dk;
      opt.textContent = `${dk.toUpperCase()} · ${state.activeTrip.dayLabels?.[dk] || `DAY ${i + 1}`}`;
      targetSelect.append(opt);
    }
  });

  if (!targetSelect.options.length) {
    showToast('移動先となる他の日がありません。「+ 日を追加」してください。', true);
    return;
  }

  updateMoveDayPositionOptions(store);

  const range = parseTimeRange(card.time);
  $('move-day-start-time').value = range ? formatMinute(range.start) : '09:00';
  $('move-day-duration-minutes').value = range ? String(range.end - range.start) : '60';
  $('move-day-travel-minutes').value = card.travelMinutesFromPrevious ? String(card.travelMinutesFromPrevious) : '0';

  if ($('card-dialog')) $('card-dialog').close();
  $('move-day-dialog').showModal();
}

export function updateMoveDayPositionOptions(store) {
  const toDay = $('move-day-target-select').value;
  const targetCards = store.getState().activeTrip?.days?.[toDay] || [];
  const posSelect = $('move-day-position-select');
  posSelect.replaceChildren();

  const optStart = document.createElement('option');
  optStart.value = 'start';
  optStart.textContent = '日の先頭（1番目）';
  posSelect.append(optStart);

  targetCards.forEach((c, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx + 1);
    opt.textContent = `${idx + 1}. 「${c.title}」の後`;
    posSelect.append(opt);
  });

  const optEnd = document.createElement('option');
  optEnd.value = 'end';
  optEnd.textContent = '日の末尾に追加';
  optEnd.selected = true;
  posSelect.append(optEnd);
}

export function previewMoveDay(store, event) {
  event.preventDefault();
  const state = store.getState();
  const fromIndex = Number($('move-day-card-index').value);
  const fromDayKey = state.activeDayKey;
  const toDayKey = $('move-day-target-select').value;
  const toPosition = $('move-day-position-select').value;
  const startTime = $('move-day-start-time').value;
  const durationMinutes = Number($('move-day-duration-minutes').value);
  const travelMinutes = Number($('move-day-travel-minutes').value);
  const allowTimeLockedMove = $('move-day-allow-locked').checked;

  const plan = planCardMoveDay(state.activeTrip, fromDayKey, fromIndex, toDayKey, toPosition, {
    startTime,
    durationMinutes,
    travelMinutes,
    allowTimeLockedMove
  });

  $('move-day-dialog').close();

  openPlannerCompareDialog(store, {
    title: `別日移動の確認 (${fromDayKey.toUpperCase()} → ${toDayKey.toUpperCase()})`,
    planResult: plan,
    updatedTrip: plan.updatedTrip,
    dayKey: toDayKey
  });
}

export function openCascadeAdjustDialog(store, cardIndex) {
  const state = store.getState();
  const cards = state.activeTrip?.days?.[state.activeDayKey] || [];
  const card = cards[cardIndex];
  if (!card) return;

  $('cascade-card-index').value = String(cardIndex);
  $('cascade-card-summary').textContent = `起点: 「${card.title}」 (${card.time || '時刻未定'})${card.timeLocked ? ' 🔒 固定予定' : ''}`;

  const range = parseTimeRange(card.time);
  $('cascade-start-time').value = range ? formatMinute(range.start) : '09:00';
  $('cascade-duration-minutes').value = range ? String(range.end - range.start) : '60';

  if ($('card-dialog')) $('card-dialog').close();
  $('cascade-adjust-dialog').showModal();
}

export function previewCascadeAdjust(store, event) {
  event.preventDefault();
  const cardIndex = Number($('cascade-card-index').value);
  const state = store.getState();
  const dayKey = state.activeDayKey;
  const cards = state.activeTrip?.days?.[dayKey] || [];
  const startTime = $('cascade-start-time').value;
  const durationMinutes = Number($('cascade-duration-minutes').value);

  const plan = planCascadeTimeAdjustment(cards, cardIndex, startTime, durationMinutes, { dayKey });

  const updatedTrip = deepClone(state.activeTrip);
  updatedTrip.days[dayKey] = plan.updatedCards;

  $('cascade-adjust-dialog').close();

  openPlannerCompareDialog(store, {
    title: `後続時刻調整の確認 (${dayKey.toUpperCase()})`,
    planResult: plan,
    updatedTrip,
    dayKey
  });
}

export function renderDiffList(diffs = [], container) {
  if (diffs.length === 0) {
    container.append(makeElement('div', 'empty-state', '差分はありません。'));
    return;
  }
  diffs.forEach(item => {
    const row = makeElement('div', `planner-diff-item ${item.type}`);
    const badge = makeElement('span', 'planner-diff-badge',
      item.type === 'added' ? '+ 追加' :
      item.type === 'modified' ? '~ 変更' :
      item.type === 'removed' ? '- 除外' : '= 変更なし'
    );
    const label = makeElement('span', '', item.title);
    const timeInfo = makeElement('small', 'muted',
      item.beforeTime && item.afterTime && item.beforeTime !== item.afterTime
        ? `${item.beforeTime} → ${item.afterTime}`
        : item.afterTime || item.beforeTime || '—'
    );
    row.append(badge, label, timeInfo);
    if (item.timeLocked) row.append(makeElement('span', 'time-locked-indicator', ' 🔒'));
    container.append(row);
  });
}

export function openPlannerCompareDialog(store, {
  title,
  planResult,
  updatedTrip,
  dayKey,
  isReorder = false,
  fromIndex = -1,
  toIndex = -1
}) {
  const state = store.getState();
  const activePendingPlan = {
    updatedTrip,
    planResult,
    dayKey,
    expectedBaseTrip: deepClone(state.activeTrip),
    isReorder,
    fromIndex,
    toIndex
  };
  store.setState({ activePendingPlan });

  $('planner-compare-title').textContent = title;
  $('planner-compare-summary').textContent = planResult.fromDayKey && planResult.toDayKey
    ? `移動元: ${planResult.fromDayKey.toUpperCase()} ➔ 移動先: ${planResult.toDayKey.toUpperCase()}`
    : `対象日: ${dayKey.toUpperCase()}`;

  const diffContainer = $('planner-compare-diff');
  diffContainer.replaceChildren();

  if (planResult.fromDiff && planResult.toDiff) {
    const fromHead = makeElement('h4', 'planner-diff-section-head', `【移動元】${planResult.fromDayKey.toUpperCase()}`);
    diffContainer.append(fromHead);
    renderDiffList(planResult.fromDiff.diffs, diffContainer);

    const toHead = makeElement('h4', 'planner-diff-section-head', `【移動先】${planResult.toDayKey.toUpperCase()}`);
    diffContainer.append(toHead);
    renderDiffList(planResult.toDiff.diffs, diffContainer);
  } else {
    const diffs = planResult.diff?.diffs || [];
    renderDiffList(diffs, diffContainer);
  }

  const alertContainer = $('planner-compare-alerts');
  alertContainer.replaceChildren();

  const errors = planResult.errors || [];
  const warnings = planResult.warnings || [];

  if (errors.length > 0) {
    alertContainer.className = 'adopt-preview-box has-conflict';
    errors.forEach(msg => {
      alertContainer.append(makeElement('div', 'adopt-preview-alert error', `⛔ ${msg}`));
    });
  } else if (warnings.length > 0) {
    alertContainer.className = 'adopt-preview-box has-conflict';
    warnings.forEach(msg => {
      alertContainer.append(makeElement('div', 'adopt-preview-alert warning', `⚠️ ${msg}`));
    });
  } else {
    alertContainer.className = 'adopt-preview-box is-valid';
    alertContainer.append(makeElement('div', 'adopt-preview-alert', '✅ 時間重複や制限エラーはありません。'));
  }

  $('planner-compare-auto-adjust').hidden = !(isReorder && planResult.canAutoAdjust);
  $('confirm-planner-compare').disabled = errors.length > 0;
  $('planner-compare-dialog').showModal();
}

export function confirmPlannerCompare(store, event, callbacks = {}) {
  event.preventDefault();
  const state = store.getState();
  if (!state.activePendingPlan?.planResult) return;

  const res = applyDayPlan({
    currentTrip: state.activeTrip,
    currentPlanning: state.activePlanning,
    planResult: state.activePendingPlan.planResult,
    expectedBaseTrip: state.activePendingPlan.expectedBaseTrip,
    dayKey: state.activePendingPlan.dayKey
  });

  if (res.error) {
    showToast(`変更を適用できません: ${res.error}`, true);
    return;
  }

  store.setState({
    activeTrip: res.trip,
    activePlanning: res.planning,
    lastDayPlanUndo: res.undoSnapshot,
    activePendingPlan: null
  });

  if ($('undo-day-plan')) $('undo-day-plan').hidden = false;
  $('planner-compare-dialog').close();
  if (typeof callbacks.renderEditorCards === 'function') callbacks.renderEditorCards();
  if (typeof callbacks.renderCandidateList === 'function') callbacks.renderCandidateList();
  if (typeof callbacks.renderTripAudit === 'function') callbacks.renderTripAudit();
  showToast('日程の変更案を適用しました。内容を確認して下書き保存してください。');
}

export function undoLastDayPlan(store, callbacks = {}) {
  const state = store.getState();
  if (!state.lastDayPlanUndo) return;
  const res = undoDayPlan({
    currentTrip: state.activeTrip,
    currentPlanning: state.activePlanning,
    undoSnapshot: state.lastDayPlanUndo
  });

  if (res.error) {
    showToast(`取り消しできません: ${res.error}`, true);
    return;
  }

  store.setState({
    activeTrip: res.trip,
    activePlanning: res.planning,
    lastDayPlanUndo: null
  });
  if ($('undo-day-plan')) $('undo-day-plan').hidden = true;

  if (typeof callbacks.renderEditorCards === 'function') callbacks.renderEditorCards();
  if (typeof callbacks.renderCandidateList === 'function') callbacks.renderCandidateList();
  if (typeof callbacks.renderTripAudit === 'function') callbacks.renderTripAudit();
  showToast('直前の日程変更を取り消しました。');
}

export function initDayPlannerUI({ store, callbacks = {} }) {
  if ($('undo-day-plan')) $('undo-day-plan').addEventListener('click', () => undoLastDayPlan(store, callbacks));

  if ($('close-move-day-dialog')) $('close-move-day-dialog').addEventListener('click', () => $('move-day-dialog').close());
  if ($('cancel-move-day')) $('cancel-move-day').addEventListener('click', () => $('move-day-dialog').close());
  if ($('move-day-form')) $('move-day-form').addEventListener('submit', event => previewMoveDay(store, event));
  if ($('move-day-target-select')) $('move-day-target-select').addEventListener('change', () => updateMoveDayPositionOptions(store));

  if ($('close-cascade-dialog')) $('close-cascade-dialog').addEventListener('click', () => $('cascade-adjust-dialog').close());
  if ($('cancel-cascade')) $('cancel-cascade').addEventListener('click', () => $('cascade-adjust-dialog').close());
  if ($('cascade-adjust-form')) $('cascade-adjust-form').addEventListener('submit', event => previewCascadeAdjust(store, event));

  if ($('planner-compare-auto-adjust')) $('planner-compare-auto-adjust').addEventListener('click', () => autoAdjustAndReplan(store));
  if ($('close-planner-compare')) $('close-planner-compare').addEventListener('click', () => $('planner-compare-dialog').close());
  if ($('cancel-planner-compare')) $('cancel-planner-compare').addEventListener('click', () => $('planner-compare-dialog').close());
  if ($('planner-compare-form')) $('planner-compare-form').addEventListener('submit', event => confirmPlannerCompare(store, event, callbacks));
}
