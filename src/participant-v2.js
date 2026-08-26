import { getTripNowState, migrateTripToV2, settlementTransfers } from './trip-v2-index.js';

let activeTrip = null;
let nowTimer = null;
let notificationTimers = [];

const safeStorage = {
  get(key, fallback = '') {
    try { return localStorage.getItem(key) ?? fallback; } catch (error) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* Storage is optional. */ }
  }
};

function settingKey(name) {
  return `shiori-v2-${activeTrip?.tripId || 'default'}-${name}`;
}

function effectiveTheme(trip) {
  const saved = safeStorage.get(settingKey('theme'), trip.theme?.mode || 'auto');
  if (saved !== 'auto') return saved;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(trip) {
  const root = document.documentElement;
  const theme = effectiveTheme(trip);
  root.dataset.tripTheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f1ea' : '#242424');
  root.style.setProperty('--v2-accent', trip.theme?.accent || '#f4d35e');
  root.style.setProperty('--accent', trip.theme?.accent || '#f4d35e');
}

function formatClock(date) {
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' }).format(date);
}

function refreshNowAssistant() {
  if (!activeTrip || activeTrip.features?.nowMode === false) return;
  const state = getTripNowState(activeTrip, new Date());
  const card = document.getElementById('now-mode');
  const countdown = document.getElementById('now-countdown');
  if (!card || !countdown) return;
  card.classList.toggle('departure-late', state.departureLate);
  if (state.next?.card.travelMinutesFromPrevious && state.recommendedDeparture) {
    const prefix = state.departureLate ? '出発目安を過ぎています' : `${formatClock(state.recommendedDeparture)}までに出発`;
    countdown.textContent = `${prefix} · 移動約${state.next.card.travelMinutesFromPrevious}分`;
  }
}

function notificationId(item, minutes) {
  return `${activeTrip.tripId}:${item.dayKey}:${item.card.cardId}:${minutes}`;
}

async function showTripNotification(item, minutes) {
  const id = notificationId(item, minutes);
  if (safeStorage.get(`shiori-notified-${id}`)) return;
  safeStorage.set(`shiori-notified-${id}`, '1');
  const options = {
    body: `${item.card.time} ${item.card.title}${minutes ? `まであと${minutes}分` : 'の時間です'}`,
    icon: 'images/shiori-icon-v2-192.png',
    badge: 'images/shiori-icon-v2-192.png',
    tag: id,
    data: { url: location.href }
  };
  const registration = await navigator.serviceWorker?.ready.catch(() => null);
  if (registration?.showNotification) await registration.showNotification(activeTrip.title, options);
  else new Notification(activeTrip.title, options);
}

function clearNotificationTimers() {
  notificationTimers.forEach(timer => clearTimeout(timer));
  notificationTimers = [];
}

function scheduleNotifications() {
  clearNotificationTimers();
  if (!activeTrip?.features?.notifications || !('Notification' in window) || Notification.permission !== 'granted') return;
  const state = getTripNowState(activeTrip, new Date());
  const now = Date.now();
  state.timeline.forEach(item => {
    (item.card.notifyBeforeMinutes || []).forEach(minutes => {
      const delay = item.start.getTime() - Number(minutes) * 60000 - now;
      if (delay >= 0 && delay <= 86400000) notificationTimers.push(setTimeout(() => showTripNotification(item, minutes), delay));
    });
  });
}

async function setNotifications(enabled) {
  if (!('Notification' in window)) return false;
  if (enabled && Notification.permission !== 'granted') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') return false;
  }
  activeTrip.features.notifications = enabled;
  safeStorage.set(settingKey('notifications'), enabled ? '1' : '0');
  scheduleNotifications();
  return true;
}

function ensureSettingsDialog() {
  let dialog = document.getElementById('trip-settings-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'trip-settings-dialog';
  dialog.className = 'v2-settings-dialog';
  dialog.innerHTML = `
    <div class="v2-settings-head"><h2>しおり設定</h2><button type="button" class="v2-settings-button" data-close>閉じる</button></div>
    <div class="v2-settings-body">
      <label>表示テーマ<select id="participant-theme"><option value="auto">端末に合わせる</option><option value="dark">ダーク</option><option value="light">ライト</option></select></label>
      <label>地図アプリ<select id="participant-map"><option value="google">Google Maps</option><option value="apple">Apple Maps</option></select></label>
      <label class="v2-settings-toggle"><input id="participant-notifications" type="checkbox"><span>予定前の通知を受け取る</span></label>
      <small>無料運用の端末内通知です。通知許可が必要で、しおりを開いている間だけ予定時刻をお知らせします。</small>
    </div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#participant-theme').addEventListener('change', event => {
    safeStorage.set(settingKey('theme'), event.target.value);
    applyTheme(activeTrip);
  });
  dialog.querySelector('#participant-map').addEventListener('change', event => {
    safeStorage.set(settingKey('map'), event.target.value);
    applyMapPreference();
  });
  dialog.querySelector('#participant-notifications').addEventListener('change', async event => {
    const accepted = await setNotifications(event.target.checked);
    event.target.checked = accepted && event.target.checked;
  });
  return dialog;
}

function applyMapPreference() {
  document.querySelectorAll('.j-card[data-map-query]').forEach(card => {
    const query = card.dataset.mapQuery || '';
    if (!query) return;
    const mapLink = [...card.querySelectorAll('a.j-btn')].find(link => link.querySelector('.j-btn-label')?.textContent === 'MAP');
    if (!mapLink) return;
    const google = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    mapLink.href = preferredMapUrl(query, google);
  });
}

function installSettingsButton() {
  const actions = document.querySelector('.now-actions');
  if (!actions || actions.querySelector('.v2-settings-button')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'v2-settings-button';
  button.textContent = '設定';
  button.addEventListener('click', () => {
    const dialog = ensureSettingsDialog();
    dialog.querySelector('#participant-theme').value = safeStorage.get(settingKey('theme'), activeTrip.theme?.mode || 'auto');
    dialog.querySelector('#participant-map').value = safeStorage.get(settingKey('map'), /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'apple' : 'google');
    dialog.querySelector('#participant-notifications').checked = activeTrip.features?.notifications === true && 'Notification' in window && Notification.permission === 'granted';
    dialog.showModal();
  });
  actions.append(button);
}

function renderExpenseParticipants() {
  const container = document.getElementById('expense-participants');
  const mode = document.getElementById('expense-split-mode')?.value || 'equal';
  if (!container) return;
  container.hidden = mode === 'equal';
  const members = Array.isArray(window.currentTripMembers) ? window.currentTripMembers : [];
  const checked = new Set([...container.querySelectorAll('input:checked')].map(input => input.value));
  container.replaceChildren(...members.map(member => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = member.id;
    input.checked = checked.size ? checked.has(member.id) : true;
    label.append(input, document.createTextNode(member.name));
    return label;
  }));
  updateExpenseSplitPreview();
}

function updateExpenseSplitPreview() {
  const mode = document.getElementById('expense-split-mode')?.value || 'equal';
  const amount = Math.max(0, Math.round(Number(document.getElementById('expense-amount')?.value) || 0));
  const members = Array.isArray(window.currentTripMembers) ? window.currentTripMembers : [];
  const selected = mode === 'selected'
    ? [...document.querySelectorAll('#expense-participants input:checked')]
    : members.map(member => ({ value: member.id }));
  const names = mode === 'selected'
    ? [...document.querySelectorAll('#expense-participants input:checked')].map(input => input.parentElement?.textContent?.trim()).filter(Boolean)
    : members.map(member => member.name);
  const help = document.getElementById('expense-split-help');
  const preview = document.getElementById('expense-split-preview');
  if (help) help.textContent = mode === 'selected'
    ? 'この支出を負担する人だけにチェックしてください。2人だけの割り勘にも対応しています。'
    : '登録メンバー全員で同額ずつ負担します。';
  if (!preview) return;
  if (!selected.length) {
    preview.textContent = '負担するメンバーを1人以上選んでください。';
    preview.dataset.state = 'warning';
    return;
  }
  preview.dataset.state = 'ready';
  const share = amount ? Math.floor(amount / selected.length) : 0;
  const remainder = amount ? amount - share * selected.length : 0;
  const amountText = amount ? `1人あたり約${new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(amount / selected.length)}` : '金額を入力すると1人分を表示します';
  preview.textContent = `${names.join('・')}の${selected.length}人で負担 · ${amountText}${remainder ? `（端数${remainder}円は精算時に調整）` : ''}`;
}

function handleExpenseSplitModeChange() {
  renderExpenseParticipants();
}

export function migrateParticipantTrip(raw) {
  activeTrip = migrateTripToV2(raw, raw?.tripId || 'trip');
  window.shioriPreferredMapUrl = preferredMapUrl;
  return activeTrip;
}

export function activateParticipantV2(raw) {
  activeTrip = raw === activeTrip ? activeTrip : migrateParticipantTrip(raw);
  const savedNotifications = safeStorage.get(settingKey('notifications'));
  if (savedNotifications) activeTrip.features.notifications = savedNotifications === '1';
  applyTheme(activeTrip);
  applyMapPreference();
  installSettingsButton();
  document.getElementById('now-mode')?.toggleAttribute('hidden', activeTrip.features?.nowMode === false);
  document.getElementById('btn-expenses')?.toggleAttribute('hidden', activeTrip.features?.expenses === false);
  nowTimer && clearInterval(nowTimer);
  refreshNowAssistant();
  nowTimer = setInterval(refreshNowAssistant, 30000);
  scheduleNotifications();
  document.getElementById('expense-split-mode')?.removeEventListener('change', handleExpenseSplitModeChange);
  document.getElementById('expense-split-mode')?.addEventListener('change', handleExpenseSplitModeChange);
  document.getElementById('expense-amount')?.removeEventListener('input', updateExpenseSplitPreview);
  document.getElementById('expense-amount')?.addEventListener('input', updateExpenseSplitPreview);
  document.getElementById('expense-participants')?.removeEventListener('change', updateExpenseSplitPreview);
  document.getElementById('expense-participants')?.addEventListener('change', updateExpenseSplitPreview);
  window.removeEventListener('shiori-members-changed', renderExpenseParticipants);
  window.addEventListener('shiori-members-changed', renderExpenseParticipants);
  renderExpenseParticipants();
  return activeTrip;
}

export function deactivateParticipantV2() {
  if (nowTimer) clearInterval(nowTimer);
  nowTimer = null;
  clearNotificationTimers();
  document.getElementById('expense-split-mode')?.removeEventListener('change', handleExpenseSplitModeChange);
  document.getElementById('expense-amount')?.removeEventListener('input', updateExpenseSplitPreview);
  document.getElementById('expense-participants')?.removeEventListener('change', updateExpenseSplitPreview);
  window.removeEventListener('shiori-members-changed', renderExpenseParticipants);
  activeTrip = null;
}

export function preferredMapUrl(query, fallbackUrl = '') {
  const preference = safeStorage.get(settingKey('map'), /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'apple' : 'google');
  return preference === 'apple' && query
    ? `https://maps.apple.com/?q=${encodeURIComponent(query)}`
    : fallbackUrl;
}

window.shioriSettlementTransfers = settlementTransfers;
window.shioriRenderExpenseParticipants = renderExpenseParticipants;
