/**
 * Viewer Router: Trip Access Persistence, Join Token Redemption & Shelf Portal Dashboard
 */

import { escapeHtml, isValidDataKey } from './viewer-ui.js';

export const TRIP_ACCESS_KEY = 'participant-trip-access-v1';
export const PENDING_ACCESS_ID_KEY = 'participant-pending-access-id-v1';
export const MANAGED_TRIP_CACHE_PREFIX = 'managed-trip-cache-v2:';
export const LEDGER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ACCESS_ID_PATTERN = /^[A-Z2-9]{12}$/;

let portalTripsCache = [], currentPortalCategory = 'upcoming', portalLoadRunId = 0, automaticAccessId = '', routerCallbacks = {};

export function setRouterCallbacks(callbacks) { routerCallbacks = callbacks || {}; }
export function normalizeAccessId(val) { return String(val || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
export function buildTripHref(id) { return `?trip=${encodeURIComponent(String(id || ''))}`; }
export function tokyoDateKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function readStoredObject(key) {
  try {
    if (typeof localStorage === 'undefined') return {};
    const parsed = JSON.parse(localStorage.getItem(key) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function capturePendingAccessId() {
  if (typeof window === 'undefined') return '';
  const saved = normalizeAccessId(sessionStorage.getItem(PENDING_ACCESS_ID_KEY));
  const hashParams = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
  const linked = normalizeAccessId(hashParams.get('join'));
  if (ACCESS_ID_PATTERN.test(linked)) sessionStorage.setItem(PENDING_ACCESS_ID_KEY, linked);
  if (hashParams.has('join')) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.hash = '';
    history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}`);
  }
  return ACCESS_ID_PATTERN.test(linked) ? linked : (ACCESS_ID_PATTERN.test(saved) ? saved : '');
}

export function storedTripAccess(tripId) {
  const allAccess = readStoredObject(TRIP_ACCESS_KEY);
  const saved = allAccess[tripId];
  const migratedAccessId = normalizeAccessId(saved?.accessId || saved?.invite);
  if (!LEDGER_TOKEN_PATTERN.test(String(saved?.ledger || '')) || !ACCESS_ID_PATTERN.test(migratedAccessId)) return null;
  const normalized = { ledger: saved.ledger, accessId: migratedAccessId, grantId: saved.grantId || '' };
  if (saved.accessId !== migratedAccessId || Object.prototype.hasOwnProperty.call(saved, 'invite')) {
    allAccess[tripId] = normalized;
    if (typeof localStorage !== 'undefined') localStorage.setItem(TRIP_ACCESS_KEY, JSON.stringify(allAccess));
  }
  return normalized;
}

export function managedTripCacheKey(tripId, access = storedTripAccess(tripId)) {
  return access ? `${MANAGED_TRIP_CACHE_PREFIX}${tripId}:${access.grantId || access.ledger}` : '';
}

export function readCachedTripConfig(tripId) {
  const key = managedTripCacheKey(tripId);
  if (!key || typeof localStorage === 'undefined') return null;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    return validTripConfig(cached, tripId) ? cached : null;
  } catch { return null; }
}

export function saveTripAccess(tripId, details) {
  const access = readStoredObject(TRIP_ACCESS_KEY);
  access[tripId] = { ledger: details.ledger, accessId: details.accessId, grantId: details.grantId || '' };
  if (typeof localStorage !== 'undefined') localStorage.setItem(TRIP_ACCESS_KEY, JSON.stringify(access));
}

export function forgetTripAccess(tripId) {
  if (typeof localStorage === 'undefined') return;
  const access = readStoredObject(TRIP_ACCESS_KEY);
  delete access[tripId];
  localStorage.setItem(TRIP_ACCESS_KEY, JSON.stringify(access));
  const prefixes = [`${MANAGED_TRIP_CACHE_PREFIX}${tripId}:`, `shiori-journey-v4:${tripId}`, `shiori-live-itinerary-v1:${tripId}`, `shiori-recap-v4:${tripId}`, `expenses-${tripId}-`, `checklist-${tripId}-`, `shiori-device-owner-v2-${tripId}-`];
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i) || '';
    if (prefixes.some(p => k === p || k.startsWith(p))) localStorage.removeItem(k);
  }
}

export function validTripConfig(val, tripId) {
  const days = val?.days;
  if (val?.tripId !== tripId || !days || typeof days !== 'object' || Array.isArray(days)) return false;
  const keys = Object.keys(days);
  return keys.length > 0 && keys.every(k => isValidDataKey(k) && Array.isArray(days[k]));
}

export async function fetchTripConfig(tripId) {
  if (!isValidDataKey(tripId)) throw new Error('Invalid trip ID');
  const access = storedTripAccess(tripId);
  if (!access) { const err = new Error('Access ID required'); err.code = 'access/id-required'; throw err; }
  const key = managedTripCacheKey(tripId, access);
  try {
    if (typeof window === 'undefined' || typeof window._fetchManagedTripConfig !== 'function') throw new Error('Access service is not ready');
    const managedTrip = await window._fetchManagedTripConfig(tripId, access);
    if (!validTripConfig(managedTrip, tripId)) throw new Error('Invalid managed trip');
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(managedTrip));
    return managedTrip;
  } catch (error) {
    if (String(error?.code || '').includes('access/revoked') || String(error?.code || '').includes('access/invalid')) {
      forgetTripAccess(tripId);
      throw error;
    }
    const cached = readCachedTripConfig(tripId);
    if (cached) return cached;
    throw error;
  }
}

export function accessRegistrationErrorMessage(error) {
  return String(error?.code || '').includes('access/full')
    ? 'この配布先は定員に達しています。管理者へ連絡してください。'
    : '配布IDが無効か、管理者によって停止されています。';
}

export async function redeemAndStoreAccess(accessId) {
  if (typeof window === 'undefined' || typeof window._redeemAccessId !== 'function') {
    throw new Error('配布ID確認サービスを準備しています。少し待って再度お試しください。');
  }
  const result = await window._redeemAccessId(accessId);
  saveTripAccess(result.tripId, { ledger: result.ledgerToken, accessId, grantId: result.grantId });
  if (typeof localStorage !== 'undefined') localStorage.setItem(`${MANAGED_TRIP_CACHE_PREFIX}${result.tripId}:${result.grantId}`, JSON.stringify(result.trip));
  return result;
}

export async function beginAutomaticAccessRegistration(accessId) {
  if (automaticAccessId === accessId || typeof document === 'undefined') return;
  automaticAccessId = accessId;
  pauseTripRuntime();
  document.getElementById('portal-overlay')?.classList.add('active');
  const shiori = document.getElementById('shiori-content'); if (shiori) shiori.style.display = 'none';
  const cards = document.getElementById('portal-cards'); if (cards) cards.innerHTML = '<div style="color:var(--text-sub); font-size:0.88rem; padding:12px 0;">登録リンクを確認中…</div>';
  try {
    const result = await redeemAndStoreAccess(accessId);
    sessionStorage.removeItem(PENDING_ACCESS_ID_KEY); automaticAccessId = '';
    if (typeof history !== 'undefined') history.replaceState(null, '', buildTripHref(result.tripId));
    initAppRouter();
  } catch (error) {
    sessionStorage.removeItem(PENDING_ACCESS_ID_KEY); automaticAccessId = '';
    if (typeof history !== 'undefined') history.replaceState(null, '', './');
    renderPortalDashboard(); showAddTripInput();
    const input = document.getElementById('new-trip-id'); if (input) input.value = accessId;
    const errEl = document.getElementById('add-trip-error');
    if (errEl) { errEl.textContent = accessRegistrationErrorMessage(error); errEl.style.display = 'block'; }
  }
}

export function handleOnboardingSubmit(event) {
  if (event?.preventDefault) event.preventDefault();
  const input = typeof document !== 'undefined' ? document.getElementById('welcome-nickname') : null;
  const nick = input ? input.value.trim() : '';
  if (!nick) return;
  if (typeof localStorage !== 'undefined') localStorage.setItem('user_nickname', nick);
  initAppRouter();
}

export function publicRecapSummaries(joined = []) {
  const recaps = (typeof window !== 'undefined' && Array.isArray(window.shioriPublicRecaps)) ? window.shioriPublicRecaps : [];
  return recaps.map(r => {
    const o = joined.find(t => t.recapId === r.id);
    return { id: `recap-${r.id}`, title: r.title, subtitle: r.subtitle, date: `${r.startDate} - ${r.endDate}`, href: o ? `${r.href}&trip=${encodeURIComponent(o.id)}` : r.href, sourceTripId: o?.id || '', isPast: true, isRecap: true };
  });
}

export function localRecapSummaries(joined = [], publicRecaps = []) {
  if (typeof localStorage === 'undefined') return [];
  const pubIds = new Set(publicRecaps.map(r => r.sourceTripId).filter(Boolean));
  return joined.filter(t => t.isPast && !pubIds.has(t.id)).flatMap(t => {
    try {
      const r = JSON.parse(localStorage.getItem(`shiori-recap-v4:${t.id}`) || 'null');
      if (r?.schema !== 'shiori-recap-v1' || r.visibility !== 'local' || r.sourceTripId !== t.id) return [];
      return [{ id: `local-recap-${t.id}`, title: r.title || t.title, subtitle: 'この端末で作った旅の記録 · RECAP', date: `${r.startDate || t.startDate} - ${r.endDate || t.endDate}`, href: `./recap.html?local=${encodeURIComponent(t.id)}`, sourceTripId: t.id, isPast: true, isRecap: true }];
    } catch { return []; }
  });
}

export function combinePortalTrips(joined = []) {
  const pub = publicRecapSummaries(joined), loc = localRecapSummaries(joined, pub);
  const recapIds = new Set([...pub, ...loc].map(r => r.sourceTripId).filter(Boolean));
  return joined.filter(t => !(t.isPast && recapIds.has(t.id))).concat(pub, loc);
}

export function portalTripSummary(tripId, data, todayStr = tokyoDateKey()) {
  if (!validTripConfig(data, tripId)) return null;
  const recap = (typeof window !== 'undefined' && window.shioriFindRecapForTrip) ? window.shioriFindRecapForTrip(data) : null;
  return { id: tripId, title: data.title, subtitle: data.subtitle || '', date: `${data.startDate} - ${data.endDate}`, startDate: data.startDate || '', endDate: data.endDate || '', recapId: recap?.id || '', isPast: data.archived === true || (data.endDate ? data.endDate < todayStr : false) };
}

export function updatePortalOwnerLabel() {
  const nick = (typeof localStorage !== 'undefined' && localStorage.getItem('user_nickname')) || '';
  const titleEl = typeof document !== 'undefined' ? document.querySelector('.portal-sub') : null;
  if (titleEl) titleEl.textContent = `${nick} さんのしおり棚`;
}

export function showPortalStatus(msg = '') {
  const s = typeof document !== 'undefined' ? document.getElementById('portal-status') : null;
  if (s) { s.textContent = msg; s.hidden = !msg; }
}

export function renderPortalDashboard() {
  if (typeof document === 'undefined') return;
  const loadId = ++portalLoadRunId;
  showPortalStatus('');
  const joined = Object.keys(readStoredObject(TRIP_ACCESS_KEY)).filter(id => isValidDataKey(id) && storedTripAccess(id));
  const todayStr = tokyoDateKey();
  const cached = joined.map(id => portalTripSummary(id, readCachedTripConfig(id), todayStr)).filter(Boolean);
  portalTripsCache = combinePortalTrips(cached);
  updatePortalOwnerLabel();
  if (portalTripsCache.length || !joined.length) filterAndRenderPortalCards();
  else { const c = document.getElementById('portal-cards'); if (c) c.innerHTML = '<div style="color:var(--text-sub); font-size:0.88rem; padding:12px 0;">読み込み中...</div>'; }

  Promise.all(joined.map(id => fetchTripConfig(id).then(d => portalTripSummary(id, d, todayStr)).catch(err => {
    const c = String(err?.code || '');
    if (c.includes('access/revoked') || c.includes('access/invalid') || c.includes('access/id-required')) return null;
    return portalTripSummary(id, readCachedTripConfig(id), todayStr) || { id, title: `旅程 ID: ${id}`, subtitle: '通信できないため詳細を読み込めませんでした。', date: '--', isPast: false };
  }))).then(trips => {
    if (loadId !== portalLoadRunId) return;
    portalTripsCache = combinePortalTrips(trips.filter(Boolean));
    updatePortalOwnerLabel();
    filterAndRenderPortalCards();
  });
}

export function switchPortalCategory(cat) {
  currentPortalCategory = cat;
  if (typeof document !== 'undefined') {
    document.getElementById('portal-tab-upcoming')?.classList.toggle('active', cat === 'upcoming');
    document.getElementById('portal-tab-past')?.classList.toggle('active', cat === 'past');
  }
  filterAndRenderPortalCards();
}

export function filterAndRenderPortalCards() {
  if (typeof document === 'undefined') return;
  const container = document.getElementById('portal-cards');
  if (!container) return;
  const filtered = portalTripsCache.filter(t => currentPortalCategory === 'past' ? t.isPast : !t.isPast);
  if (!filtered.length) {
    const msg = currentPortalCategory === 'past' ? '過去の旅行履歴はまだありません。' : 'これからの旅行予定はまだありません。';
    container.innerHTML = `<div style="color:var(--text-sub); font-size:0.85rem; padding:24px 0; text-align:center; font-style:italic;">${msg}</div>`;
    return;
  }
  container.innerHTML = filtered.map(t =>
    `<a href="${escapeHtml(t.href || buildTripHref(t.id))}" class="portal-card"><div class="portal-card-title">${escapeHtml(t.title)}</div><div class="portal-card-meta">${escapeHtml(t.subtitle ? t.subtitle + ' — ' : '')}${escapeHtml(t.date)}</div><div class="portal-card-arrow" aria-label="${t.isRecap ? '旅の記録を開く' : t.isPast ? '思い出を開く' : 'しおりを開く'}">${t.isRecap ? 'OPEN RECAP →' : t.isPast ? 'OPEN MEMORY →' : 'OPEN SHIORI →'}</div></a>`
  ).join('');
}

export function showAddTripInput() {
  if (typeof document === 'undefined') return;
  const s = (id, d) => { const el = document.getElementById(id); if (el) el.style.display = d; };
  s('btn-show-add-trip', 'none'); s('add-trip-container', 'block'); s('add-trip-error', 'none');
  const input = document.getElementById('new-trip-id'); if (input) { input.value = ''; input.focus(); }
}

export function hideAddTripInput() {
  if (typeof document === 'undefined') return;
  const s = (id, d) => { const el = document.getElementById(id); if (el) el.style.display = d; };
  s('btn-show-add-trip', 'block'); s('add-trip-container', 'none');
}

export async function handleAddTripSubmit(e) {
  if (e?.preventDefault) e.preventDefault();
  if (typeof document === 'undefined') return;
  const input = document.getElementById('new-trip-id'), errEl = document.getElementById('add-trip-error');
  const accessId = normalizeAccessId(input?.value), btn = e?.currentTarget?.querySelector?.('button[type="submit"]');
  if (!ACCESS_ID_PATTERN.test(accessId)) {
    if (errEl) { errEl.textContent = '配布IDは12文字です。管理者から届いたIDを確認してください。'; errEl.style.display = 'block'; }
    return;
  }
  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = '確認中…'; }
  try {
    const res = await redeemAndStoreAccess(accessId);
    hideAddTripInput();
    if (typeof history !== 'undefined') history.pushState(null, '', buildTripHref(res.tripId));
    initAppRouter();
  } catch (error) {
    if (errEl) { errEl.textContent = accessRegistrationErrorMessage(error); errEl.style.display = 'block'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'ADD'; }
  }
}

export function pauseTripRuntime() {
  if (typeof routerCallbacks.onPauseTrip === 'function') routerCallbacks.onPauseTrip();
  if (typeof window !== 'undefined') {
    window._stopSyncEngine?.();
    window.currentTripId = ''; window.currentTripLedgerToken = ''; window.currentTripData = null;
  }
}

export function backToPortal() {
  if (typeof history !== 'undefined') history.pushState(null, '', './');
  initAppRouter();
}

export function handleTripLoadFailure(error) {
  console.error('Error loading trip config:', error);
  const code = String(error?.code || '');
  pauseTripRuntime();
  if (typeof history !== 'undefined') history.replaceState(null, '', './');
  if (typeof document !== 'undefined') {
    document.getElementById('portal-overlay')?.classList.add('active');
    const c = document.getElementById('shiori-content'); if (c) c.style.display = 'none';
  }
  renderPortalDashboard();
  showPortalStatus(code.includes('access/revoked') || code.includes('access/invalid') ? 'このしおりの配布は停止されたか、配布IDが無効です。管理者から新しい配布IDを受け取ってください。' : 'しおりを読み込めませんでした。通信状態を確認して再度開いてください。オフライン利用には、一度オンラインでしおりを開いておく必要があります。');
}

export function initAppRouter() {
  if (typeof document === 'undefined') return;
  const nickname = (typeof localStorage !== 'undefined' && localStorage.getItem('user_nickname')) || '';
  const pendingId = capturePendingAccessId();
  const rawId = (typeof window !== 'undefined' && window.location) ? new URLSearchParams(window.location.search).get('trip') : null;
  const tripId = isValidDataKey(rawId) ? rawId : null;
  if (!nickname) {
    document.getElementById('welcome-overlay')?.classList.add('active');
    document.getElementById('portal-overlay')?.classList.remove('active');
    const c = document.getElementById('shiori-content'); if (c) c.style.display = 'none';
    return;
  }
  document.getElementById('welcome-overlay')?.classList.remove('active');
  if (pendingId) return beginAutomaticAccessRegistration(pendingId);
  if (tripId && storedTripAccess(tripId)) {
    document.getElementById('portal-overlay')?.classList.remove('active');
    const c = document.getElementById('shiori-content'); if (c) c.style.display = 'block';
    if (typeof routerCallbacks.onOpenTrip === 'function') routerCallbacks.onOpenTrip(tripId);
    return;
  }
  pauseTripRuntime();
  if (rawId && typeof history !== 'undefined') history.replaceState(null, '', './');
  document.getElementById('portal-overlay')?.classList.add('active');
  const c = document.getElementById('shiori-content'); if (c) c.style.display = 'none';
  renderPortalDashboard();
}

if (typeof window !== 'undefined') {
  Object.assign(window, {
    handleOnboardingSubmit, switchPortalCategory, showAddTripInput, hideAddTripInput, handleAddTripSubmit, backToPortal
  });
}
