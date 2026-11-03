/**
 * Admin UI Primitives, Formatting & Interactive Layout Helpers
 */

export const $ = id => document.getElementById(id);

export const deepClone = value => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

export function text(value) {
  return value == null ? '' : String(value);
}

let toastTimer = null;

export function showToast(message, error = false) {
  const toast = $('admin-toast');
  if (!toast) return;
  if (typeof window !== 'undefined') window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('visible');
  if (typeof window !== 'undefined') {
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3600);
  }
}

export function setBusy(button, busy, label = '') {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label || '処理中…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
  }
}

export async function copyText(value, successMessage = 'コピーしました') {
  try {
    await navigator.clipboard.writeText(value);
    showToast(successMessage);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    showToast(successMessage);
  }
}

export function formatTimestamp(value) {
  const date = value?.toDate?.() || (value ? new Date(value) : null);
  if (!date || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

export function formatYen(value) {
  const amount = Number(value);
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency', currency: 'JPY', maximumFractionDigits: 0
  }).format(Number.isFinite(amount) ? amount : 0);
}

export function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export const ACCESS_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomAccessId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(byte => ACCESS_ID_ALPHABET[byte % ACCESS_ID_ALPHABET.length]).join('');
}

export function formatAccessId(value) {
  const normalized = text(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.match(/.{1,4}/g)?.join('-') || '—';
}

export async function sha256(value) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function makeElement(tag, className = '', content = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== '') element.textContent = content;
  return element;
}

export function switchEditorTab(tabName = 'itinerary') {
  if (typeof document === 'undefined') return;
  const view = $('view-editor');
  if (view) view.dataset.activeTab = tabName;
  document.querySelectorAll('[data-editor-tab]').forEach(btn => {
    const active = btn.dataset.editorTab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-editor-section]').forEach(sec => {
    sec.hidden = sec.dataset.editorSection !== tabName;
  });
}

export function updateEditorHeaderMeta(trip, planning) {
  if (typeof document === 'undefined') return;
  const titleEl = document.querySelector('[data-editor-trip-title]');
  const idEl = document.querySelector('[data-editor-trip-id]');
  if (titleEl) titleEl.textContent = trip?.title?.trim() || '新しいしおり';
  if (idEl) idEl.textContent = trip?.tripId?.trim() || 'ID未設定';
  const totalCards = Object.values(trip?.days || {}).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
  const candCount = Array.isArray(planning?.candidates) ? planning.candidates.length : 0;
  const itBadge = document.querySelector('[data-tab-count="itinerary"]');
  const cdBadge = document.querySelector('[data-tab-count="candidates"]');
  if (itBadge) itBadge.textContent = String(totalCards);
  if (cdBadge) cdBadge.textContent = String(candCount);
}

export function renderDayQuickTabs(store) {
  if (typeof document === 'undefined') return;
  const bar = document.querySelector('[data-day-quick-tabs]');
  const select = $('editor-day-select');
  const trip = store?.getState()?.activeTrip;
  if (!bar || !trip) return;
  bar.replaceChildren();
  const keys = Object.keys(trip.days || {});
  if (keys.length <= 1) { bar.hidden = true; return; }
  bar.hidden = false;
  const activeKey = store.getState().activeDayKey;
  keys.forEach((dayKey, idx) => {
    const label = trip.dayLabels?.[dayKey] || `${idx + 1}日目`;
    const count = Array.isArray(trip.days[dayKey]) ? trip.days[dayKey].length : 0;
    const pill = makeElement('button', `day-quick-pill${dayKey === activeKey ? ' active' : ''}`, `${idx + 1}日目: ${label} (${count})`);
    pill.type = 'button';
    pill.addEventListener('click', () => {
      if (select && select.value !== dayKey) {
        select.value = dayKey;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    bar.append(pill);
  });
}

export function buildEditorCardRow({ card, index, total, onReorder, onEdit }) {
  const row = makeElement('article', 'editor-card');
  row.draggable = true; row.dataset.cardIndex = String(index);
  row.addEventListener('dragstart', e => { row.classList.add('is-dragging'); e.dataTransfer.setData('text/plain', String(index)); });
  row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
  row.addEventListener('dragover', e => e.preventDefault());
  row.addEventListener('drop', e => {
    e.preventDefault();
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (Number.isInteger(from) && from !== index && onReorder) onReorder(from, index);
  });
  const timeCol = makeElement('div', 'editor-card-time');
  timeCol.append(makeElement('span', 'drag-grip', '⋮⋮'), makeElement('strong', '', card.time || '時刻未定'));
  if (card.travelMinutesFromPrevious) timeCol.append(makeElement('small', 'travel-chip', `🚗 前から${card.travelMinutesFromPrevious}分`));
  const copy = makeElement('div', 'editor-card-body');
  const meta = makeElement('div', 'editor-card-badges');
  meta.append(makeElement('span', 'card-badge-chip', card.badge || 'SPOT'));
  if (card.timeLocked) meta.append(makeElement('span', 'time-locked-indicator', '🔒 固定'));
  if (card.expenseShortcut) meta.append(makeElement('span', 'card-tag-note', '💴 立替ボタン'));
  if (card.reservation?.number || card.reservation?.phone || card.constraints?.reservationAt) meta.append(makeElement('span', 'card-tag-note', '🎫 予約あり'));
  copy.append(meta, makeElement('strong', 'editor-card-title', card.title || 'タイトル未設定'));
  if (card.desc) copy.append(makeElement('p', 'editor-card-desc', card.desc));
  const actions = makeElement('div', 'actions');
  if (index > 0) {
    const up = makeElement('button', 'button compact ghost icon-move', '↑');
    up.type = 'button'; up.title = '1つ上へ移動'; up.addEventListener('click', () => onReorder?.(index, index - 1));
    actions.append(up);
  }
  if (index < total - 1) {
    const down = makeElement('button', 'button compact ghost icon-move', '↓');
    down.type = 'button'; down.title = '1つ下へ移動'; down.addEventListener('click', () => onReorder?.(index, index + 1));
    actions.append(down);
  }
  const edit = makeElement('button', 'button compact', '編集');
  edit.type = 'button'; edit.addEventListener('click', () => onEdit(index));
  actions.append(edit);
  row.append(timeCol, copy, actions);
  return row;
}

export function updateCharCounter(inputId, counterAttr) {
  if (typeof document === 'undefined') return;
  const el = $(inputId);
  const counter = document.querySelector(`[${counterAttr}]`);
  if (el && counter) counter.textContent = `${el.value.length} / 75文字`;
}

export function syncCardDialogSections(rawCard) {
  if (typeof document === 'undefined') return;
  const card = rawCard || {};
  updateCharCounter('card-desc', 'data-desc-count');
  const hasLinks = Boolean(card.mapUrl || card.routeHint || card.waypoints || card.official || card.officialLabel || card.tabelog || card.jalan || card.asoview || card.image || (Array.isArray(card.links) && card.links.length > 0));
  const hasTime = Boolean(card.travelMinutesFromPrevious || (Array.isArray(card.notifyBeforeMinutes) && card.notifyBeforeMinutes.length > 0) || card.constraints?.opensAt || card.constraints?.closesAt || card.constraints?.reservationAt || card.constraints?.lastEntryAt || card.constraints?.departureBy || card.constraints?.arrivalBufferMinutes);
  const hasRes = Boolean(card.reservation?.number || card.reservation?.name || card.reservation?.phone || card.reservation?.deadline || card.reservation?.url || card.reservation?.note);
  Object.entries({ links: hasLinks, time: hasTime, reservation: hasRes }).forEach(([key, open]) => {
    const det = document.querySelector(`[data-card-section="${key}"]`);
    if (det) det.open = open;
  });
}

export function bindAdminUxEnhancements() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('[data-editor-tab]').forEach(btn => btn.addEventListener('click', () => switchEditorTab(btn.dataset.editorTab)));
  document.querySelectorAll('[data-switch-editor-tab]').forEach(btn => btn.addEventListener('click', () => switchEditorTab(btn.dataset.switchEditorTab)));
  document.querySelectorAll('[data-set-badge]').forEach(btn => btn.addEventListener('click', () => {
    const input = $('card-badge');
    if (input) { input.value = btn.dataset.setBadge; input.dispatchEvent(new Event('input', { bubbles: true })); }
  }));
  $('card-desc')?.addEventListener('input', () => updateCharCounter('card-desc', 'data-desc-count'));
  $('adopt-card-desc')?.addEventListener('input', () => updateCharCounter('adopt-card-desc', 'data-adopt-desc-count'));
  $('trip-title')?.addEventListener('input', e => { const el = document.querySelector('[data-editor-trip-title]'); if (el) el.textContent = e.target.value.trim() || '新しいしおり'; });
  $('trip-id')?.addEventListener('input', e => { const el = document.querySelector('[data-editor-trip-id]'); if (el) el.textContent = e.target.value.trim() || 'ID未設定'; });
  $('card-form')?.addEventListener('invalid', e => { const details = e.target?.closest?.('details'); if (details && !details.open) details.open = true; }, true);
  document.addEventListener('click', e => {
    document.querySelectorAll('details.editor-more-menu[open], details.card-more-menu[open]').forEach(menu => {
      if (!menu.contains(e.target) || e.target.closest?.('.menu-action-item')) menu.open = false;
    });
  });
}
