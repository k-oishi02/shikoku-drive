/**
 * Viewer App: Native ES Module Entry Point for SHIORI Participant Viewer
 */

import { createTripStore } from './trip-store.js';
import {
  setRouterCallbacks,
  initAppRouter,
  storedTripAccess,
  fetchTripConfig,
  handleTripLoadFailure
} from './viewer-router.js';
import { buildShioriUI, setupDaySwipe, resetDaySwipe } from './viewer-ui.js';
import { initWeatherService, refreshWeather, resetWeather, WEATHER_REFRESH_MS } from './weather-service.js';
import { initPwaUpdateManager } from './pwa-manager.js';
import { initErrorBoundary, reportAppError } from './error-boundary.js';

export const tripStore = createTripStore();
initErrorBoundary({ containerId: 'error-boundary-root', fallbackMessage: 'しおりの表示中に予期せぬエラーが発生しました。' });

let participantV2Runtime = null;
let weatherRefreshInterval = null;
let tripLoadRunId = 0;

export async function loadShioriData(tripId) {
  const currentLoadId = ++tripLoadRunId;
  const access = storedTripAccess(tripId);
  tripStore.setState({
    currentAccess: access ? { ...access, tripId } : { tripId },
    activeTrip: null
  });
  if (typeof window !== 'undefined') {
    window.currentTripId = tripId;
    window.currentTripLedgerToken = access?.ledger || '';
  }

  const syncStarted = typeof window !== 'undefined' && typeof window._initSyncEngine === 'function';
  if (syncStarted) window._initSyncEngine(tripId);

  try {
    const [rawData, v2Runtime] = await Promise.all([
      fetchTripConfig(tripId),
      import('./participant-v2.js')
    ]);
    if (currentLoadId !== tripLoadRunId || (typeof window !== 'undefined' && window.currentTripId !== tripId)) return;
    const data = v2Runtime.migrateParticipantTrip(rawData);
    participantV2Runtime = v2Runtime;
    tripStore.setState({ activeTrip: data });
    buildShioriUI(data);

    setupDaySwipe(() => tripStore.getSlice('activeTrip'));
    if (weatherRefreshInterval && typeof window !== 'undefined') window.clearInterval(weatherRefreshInterval);
    if (typeof window !== 'undefined') {
      weatherRefreshInterval = window.setInterval(refreshWeather, WEATHER_REFRESH_MS);
    }

    if (!syncStarted && typeof window !== 'undefined' && typeof window._initSyncEngine === 'function') {
      window._initSyncEngine(tripId);
    }
    if (typeof window !== 'undefined' && typeof window.initEnhancements === 'function') {
      window.initEnhancements();
    }
    v2Runtime.activateParticipantV2(data);
    initScrollStorytelling();
  } catch (error) {
    if (currentLoadId !== tripLoadRunId || (typeof window !== 'undefined' && window.currentTripId !== tripId)) return;
    reportAppError(error, { action: 'loadShioriData', tripId });
    handleTripLoadFailure(error);
  }
}

export function handlePauseTrip() {
  tripLoadRunId++;
  participantV2Runtime?.deactivateParticipantV2?.();
  participantV2Runtime = null;
  resetDaySwipe();
  if (weatherRefreshInterval && typeof window !== 'undefined') {
    window.clearInterval(weatherRefreshInterval);
    weatherRefreshInterval = null;
  }
  if (typeof window !== 'undefined' && window.nowModeInterval) {
    window.clearInterval(window.nowModeInterval);
    window.nowModeInterval = null;
  }
  resetWeather();
  if (typeof document !== 'undefined') delete document.documentElement.dataset.shioriAtmosphere;
  tripStore.setState({ activeTrip: null, currentAccess: null });
}

setRouterCallbacks({
  onOpenTrip: (tripId) => loadShioriData(tripId),
  onPauseTrip: () => handlePauseTrip()
});
initWeatherService(() => tripStore.getSlice('activeTrip'));

if (typeof window !== 'undefined') {
  window.tripStore = tripStore;
  window.loadShioriData = loadShioriData;
}

export function initScrollStorytelling() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const cards = document.querySelectorAll('.j-card');
  if (!cards.length) return;
  if ('IntersectionObserver' in window) {
    const viewObs = new IntersectionObserver(ents => ents.forEach(e => { if (e.isIntersecting) e.target.classList.add('is-in-view'); }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    cards.forEach(c => viewObs.observe(c));
    const actObs = new IntersectionObserver(ents => ents.forEach(e => {
      const id = e.target.dataset.cardId;
      if (e.isIntersecting) {
        document.querySelectorAll('.journey-chip').forEach(ch => ch.classList.toggle('active', ch.dataset.jumpCard === id));
        e.target.classList.add('is-spot-active');
      } else { e.target.classList.remove('is-spot-active'); }
    }), { rootMargin: '-18% 0px -55% 0px', threshold: 0 });
    cards.forEach(c => actObs.observe(c));
  } else { cards.forEach(c => c.classList.add('is-in-view')); }
  cards.forEach(c => {
    c.onclick = e => {
      if (e.target.closest('a, button, details, input')) return;
      c.classList.toggle('is-expanded');
      c.setAttribute('aria-expanded', String(c.classList.contains('is-expanded')));
    };
  });
  document.querySelectorAll('.journey-chip').forEach(ch => {
    ch.onclick = () => {
      const el = document.querySelector(`.j-card[data-card-id="${ch.dataset.jumpCard}"]`);
      if (el) { el.classList.add('is-expanded'); el.setAttribute('aria-expanded', 'true'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    };
  });
  document.querySelector('.journey-chip.active')?.scrollIntoView?.({ inline: 'center' });
}

export function initViewerApp() {
  if (typeof window !== 'undefined' && !window.appRouterPopstateBound) {
    window.appRouterPopstateBound = true;
    window.addEventListener('popstate', initAppRouter);
  }
  initAppRouter();
  initPwaUpdateManager();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initViewerApp);
  } else {
    initViewerApp();
  }
}
