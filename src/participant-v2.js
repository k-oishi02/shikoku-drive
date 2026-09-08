import { getTripNowState, migrateTripToV2, settlementTransfers } from './trip-v2-index.js';
import { resolveMapFields, mapHref, mapSearchQuery } from './map-links.js';
import { createDiscussionPanel } from './discussion-ui.js';
import { createLiveItineraryController } from './live-itinerary.js';
import { appleMapsUrl, buildNavigationTargets, navigationLaunchUrl, navigationPreference } from './navigation-picker.js';

window.shioriMapFields = resolveMapFields;
window.shioriMapHref = mapHref;
window.shioriMapSearchQuery = mapSearchQuery;

let activeTrip = null;
let nowTimer = null;
let notificationTimers = [];
const liveItinerary = createLiveItineraryController();
let navigationPicker = null;

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
      <label>MAPボタン<select id="participant-map"><option value="ask">毎回選ぶ</option><option value="google">Google Maps</option><option value="yahoo">Yahoo!カーナビ</option><option value="waze">Waze</option><option value="apple">Apple Maps（従来設定）</option></select></label>
      <label class="v2-settings-toggle"><input id="participant-notifications" type="checkbox"><span>予定前の通知を受け取る</span></label>
      <small>無料運用の端末内通知です。通知許可が必要で、しおりを開いている間だけ予定時刻をお知らせします。</small>
      <small>「毎回選ぶ」では、MAPを押すたびにGoogle Maps・Yahoo!カーナビ・Wazeから選択できます。</small>
    </div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#participant-theme').addEventListener('change', event => {
    safeStorage.set(settingKey('theme'), event.target.value);
    applyTheme(activeTrip);
  });
  dialog.querySelector('#participant-map').addEventListener('change', event => {
    safeStorage.set(settingKey('navigation-app'), event.target.value);
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
    const source = { mapQuery: card.dataset.mapQuery || '', mapUrl: card.dataset.mapUrl || '' };
    const maps = resolveMapFields(source);
    const query = maps.mapQuery;
    if (!query && !maps.mapUrl) return;
    const mapLink = [...card.querySelectorAll('a.j-btn')].find(link => link.querySelector('.j-btn-label')?.textContent === 'MAP');
    if (!mapLink) return;
    const google = mapHref(source);
    mapLink.href = maps.mapUrl || preferredMapUrl(query, google);
  });
}

function launchWithFallback(appUrl, webUrl) {
  if (!webUrl) return;
  if (!appUrl) {
    window.location.href = webUrl;
    return;
  }
  let appOpened = false;
  const detectBackground = () => { if (document.hidden) appOpened = true; };
  document.addEventListener('visibilitychange', detectBackground);
  window.location.href = appUrl;
  window.setTimeout(() => {
    document.removeEventListener('visibilitychange', detectBackground);
    if (!appOpened && !document.hidden) window.location.href = webUrl;
  }, 1200);
}

function openNavigationTarget(id, source) {
  if (id === 'apple') {
    const url = appleMapsUrl(source);
    if (url) window.location.href = url;
    return;
  }
  const target = buildNavigationTargets(source)[id];
  if (!target?.url) return;
  if (target.id === 'yahoo' && target.needsSearch && target.copyText && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(target.copyText).catch(() => {});
  }
  const launchUrl = navigationLaunchUrl(target, {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints
  });
  const usesAppLaunch = launchUrl && launchUrl !== target.url;
  launchWithFallback(usesAppLaunch ? launchUrl : '', target.url);
}

function ensureNavigationPicker() {
  if (navigationPicker) return navigationPicker;
  const dialog = document.createElement('dialog');
  dialog.id = 'navigation-picker-dialog';
  dialog.className = 'v2-navigation-picker';
  dialog.innerHTML = `
    <div class="v2-navigation-head"><div><small>NAVIGATION</small><h2>ナビを選ぶ</h2><p>この目的地を開くアプリを選択してください</p></div><button type="button" class="v2-navigation-close" data-close aria-label="閉じる">×</button></div>
    <div class="v2-navigation-body">
      <p class="v2-navigation-destination" data-destination></p>
      <button type="button" class="v2-navigation-option google" data-navigation="google"><span class="v2-navigation-brand">G</span><span class="v2-navigation-copy"><strong>Google Maps</strong><small>施設情報も一緒に確認</small></span><span class="v2-navigation-arrow">↗</span></button>
      <button type="button" class="v2-navigation-option yahoo" data-navigation="yahoo"><span class="v2-navigation-brand">Y!</span><span class="v2-navigation-copy"><strong>Yahoo!カーナビ</strong><small data-yahoo-note>日本の道路案内を重視</small></span><span class="v2-navigation-arrow">↗</span></button>
      <button type="button" class="v2-navigation-option waze" data-navigation="waze"><span class="v2-navigation-brand">W</span><span class="v2-navigation-copy"><strong>Waze</strong><small>渋滞・事故情報を重視</small></span><span class="v2-navigation-arrow">↗</span></button>
      <label class="v2-navigation-remember"><input type="checkbox" data-remember><span>次回からこのアプリを使う</span></label>
      <small class="v2-navigation-safety">運転中は操作せず、安全な場所に停車して選択してください。</small>
    </div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
    const button = event.target.closest('[data-navigation]');
    if (!button || !dialog._navigationSource) return;
    const id = button.dataset.navigation;
    if (dialog.querySelector('[data-remember]').checked) safeStorage.set(settingKey('navigation-app'), id);
    const source = dialog._navigationSource;
    dialog.close();
    openNavigationTarget(id, source);
  });
  navigationPicker = dialog;
  return dialog;
}

function showNavigationPicker(source) {
  const dialog = ensureNavigationPicker();
  const targets = buildNavigationTargets(source);
  dialog._navigationSource = source;
  dialog.querySelector('[data-destination]').textContent = source.title || source.mapQuery || '目的地';
  dialog.querySelector('[data-yahoo-note]').textContent = targets.yahoo.note;
  dialog.querySelector('[data-remember]').checked = false;
  dialog.showModal();
}

function handleMapButtonClick(event) {
  const link = event.target.closest('a.j-btn');
  if (!link || link.querySelector('.j-btn-label')?.textContent !== 'MAP') return;
  const card = link.closest('.j-card');
  if (!card) return;
  const source = {
    title: card.dataset.mapTitle || '',
    mapQuery: card.dataset.mapQuery || '',
    mapUrl: card.dataset.mapUrl || link.href
  };
  const preference = navigationPreference(safeStorage.get(settingKey('navigation-app'), 'ask'));
  event.preventDefault();
  if (preference === 'ask') showNavigationPicker(source);
  else openNavigationTarget(preference, source);
}
function installSettingsButton() {
  const actions = document.querySelector('.now-actions');
  if (!actions || actions.querySelector('.v2-settings-button')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'v2-settings-button';
  button.textContent = 'SETTINGS';
  button.setAttribute('aria-label', 'しおり設定を開く');
  button.addEventListener('click', () => {
    const dialog = ensureSettingsDialog();
    dialog.querySelector('#participant-theme').value = safeStorage.get(settingKey('theme'), activeTrip.theme?.mode || 'auto');
    dialog.querySelector('#participant-map').value = navigationPreference(safeStorage.get(settingKey('navigation-app'), 'ask'));
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


let discussionPanel = null;
function refreshParticipantDiscussion() {
  if (!discussionPanel || !activeTrip) return;
  const service = window.suggestionSyncService;
  const context = service?.getCurrentContext();
  if (context?.tripId === activeTrip.tripId) discussionPanel.connect({ service, context });
  else discussionPanel.disconnect('共有の相談には、有効な配布先への接続が必要です。');
  discussionPanel.setVisible(document.getElementById('tab-talk')?.classList.contains('active') === true);
}
function handleDiscussionState(event) {
  if (!discussionPanel) return;
  discussionPanel.onConnection(event.detail?.state || 'stopped');
}
function handleDiscussionOnline() {
  reconnectDiscussionIfNeeded();
}
function handleDiscussionVisibility() {
  if (document.visibilityState === 'visible') reconnectDiscussionIfNeeded();
}
function reconnectDiscussionIfNeeded() {
  if (!activeTrip?.tripId) return;
  const expectedTripId = activeTrip.tripId;
  const current = window.suggestionSyncService?.getCurrentContext?.();
  if (current?.tripId === expectedTripId) {
    refreshParticipantDiscussion();
    return;
  }
  const initialize = window._initSyncEngine;
  if (typeof initialize !== 'function') {
    refreshParticipantDiscussion();
    return;
  }
  Promise.resolve(initialize(expectedTripId)).finally(() => {
    if (activeTrip?.tripId === expectedTripId) refreshParticipantDiscussion();
  });
}
function activateDiscussion() {
  if (!discussionPanel) discussionPanel = createDiscussionPanel(document.getElementById('participant-discussion'), {
    getName: () => safeStorage.get('user_nickname', '参加者'),
    onReconnect: () => { if (activeTrip?.tripId) window._initSyncEngine?.(activeTrip.tripId); }
  });
  window.removeEventListener('shiori-suggestions-ready', refreshParticipantDiscussion);
  window.removeEventListener('shiori-tab-changed', refreshParticipantDiscussion);
  window.removeEventListener('shiori-suggestions-state', handleDiscussionState);
  window.removeEventListener('online', handleDiscussionOnline);
  document.removeEventListener('visibilitychange', handleDiscussionVisibility);
  window.addEventListener('shiori-suggestions-ready', refreshParticipantDiscussion);
  window.addEventListener('shiori-tab-changed', refreshParticipantDiscussion);
  window.addEventListener('shiori-suggestions-state', handleDiscussionState);
  window.addEventListener('online', handleDiscussionOnline);
  document.addEventListener('visibilitychange', handleDiscussionVisibility);
  refreshParticipantDiscussion();
}

export function activateParticipantV2(raw) {
  activeTrip = raw === activeTrip ? activeTrip : migrateParticipantTrip(raw);
  const savedNotifications = safeStorage.get(settingKey('notifications'));
  if (savedNotifications) activeTrip.features.notifications = savedNotifications === '1';
  applyTheme(activeTrip);
  applyMapPreference();
  installSettingsButton();
  document.removeEventListener('click', handleMapButtonClick);
  document.addEventListener('click', handleMapButtonClick);
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
  activateDiscussion();
  liveItinerary.activate(activeTrip);
  return activeTrip;
}

export function deactivateParticipantV2() {
  window.removeEventListener('shiori-suggestions-ready', refreshParticipantDiscussion);
  window.removeEventListener('shiori-tab-changed', refreshParticipantDiscussion);
  window.removeEventListener('shiori-suggestions-state', handleDiscussionState);
  window.removeEventListener('online', handleDiscussionOnline);
  document.removeEventListener('visibilitychange', handleDiscussionVisibility);
  discussionPanel?.destroy();
  discussionPanel = null;
  if (nowTimer) clearInterval(nowTimer);
  nowTimer = null;
  clearNotificationTimers();
  document.getElementById('expense-split-mode')?.removeEventListener('change', handleExpenseSplitModeChange);
  document.getElementById('expense-amount')?.removeEventListener('input', updateExpenseSplitPreview);
  document.getElementById('expense-participants')?.removeEventListener('change', updateExpenseSplitPreview);
  window.removeEventListener('shiori-members-changed', renderExpenseParticipants);
  document.removeEventListener('click', handleMapButtonClick);
  if (navigationPicker?.open) navigationPicker.close();
  liveItinerary.deactivate();
  activeTrip = null;
}

export function preferredMapUrl(query, fallbackUrl = '') {
  const preference = navigationPreference(safeStorage.get(settingKey('navigation-app'), 'ask'));
  const isDrivingRoute = /\/maps\/dir\//.test(String(fallbackUrl));
  if (preference === 'yahoo' || preference === 'waze') {
    const targets = buildNavigationTargets({ mapQuery: query });
    return targets[preference]?.appUrl || targets[preference]?.url || fallbackUrl;
  }
  return preference === 'apple' && query
    ? isDrivingRoute
      ? `https://maps.apple.com/?daddr=${encodeURIComponent(query)}&dirflg=d`
      : `https://maps.apple.com/?q=${encodeURIComponent(query)}`
    : fallbackUrl;
}

window.shioriSettlementTransfers = settlementTransfers;
window.shioriRenderExpenseParticipants = renderExpenseParticipants;
