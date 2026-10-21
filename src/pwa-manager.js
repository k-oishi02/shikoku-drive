/**
 * PWA Store-style Manual Update Manager & Native App Launcher
 */

let newWorkerWaiting = null;
let pwaReloading = false;
let pwaUpdateRequested = false;
let pwaHadController = typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller);
const PWA_UPDATE_THROTTLE_MS = 30 * 60 * 1000;
let lastPwaUpdateCheckTime = 0;

function safeExternalUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    const base = typeof window !== 'undefined' && window.location ? window.location.href : 'https://localhost/';
    const url = new URL(raw, base);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export function showPwaUpdate(worker) {
  newWorkerWaiting = worker;
  if (typeof document !== 'undefined') {
    document.getElementById('update-prompt')?.classList.add('active');
  }
}

export function initPwaUpdateManager() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!pwaHadController) {
      pwaHadController = true;
      return;
    }
    if (!pwaUpdateRequested) {
      showPwaUpdate(null);
      return;
    }
    if (pwaReloading) return;
    pwaReloading = true;
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  });

  navigator.serviceWorker.register('./sw.js').then((registration) => {
    if (registration.waiting) showPwaUpdate(registration.waiting);

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          showPwaUpdate(installing);
        }
      });
    });

    lastPwaUpdateCheckTime = Date.now();
    registration.update().catch(() => {});

    const checkThrottledUpdate = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastPwaUpdateCheckTime < PWA_UPDATE_THROTTLE_MS) return;
      lastPwaUpdateCheckTime = now;
      registration.update().catch(() => {});
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', checkThrottledUpdate);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', checkThrottledUpdate);
      window.addEventListener('online', checkThrottledUpdate);
    }
  }).catch((error) => console.warn('Service worker registration failed', error));
}

export async function triggerPwaUpdate() {
  if (typeof window !== 'undefined' && !window.confirm('更新するとこの画面を再読み込みします。未保存の入力を保存してから更新してください。続けますか？')) {
    return;
  }
  pwaUpdateRequested = true;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    if (typeof window !== 'undefined') window.location.reload();
    return;
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const waiting = newWorkerWaiting || registration?.waiting;
    if (waiting) {
      if (typeof document !== 'undefined') {
        document.getElementById('update-prompt')?.classList.remove('active');
      }
      waiting.postMessage({ action: 'SKIP_WAITING' });
      return;
    }
    await registration?.update();
  } catch (error) {
    console.warn('Service worker update failed', error);
  }
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}

export function openAppWithFallback(event, anchor) {
  if (!anchor || typeof anchor.getAttribute !== 'function') return;
  const appUrl = anchor.getAttribute('data-app-url');
  const webUrl = safeExternalUrl(anchor.href);
  if (!appUrl || !webUrl) return;
  if (event && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }

  let appOpened = false;
  const detectBackground = () => {
    if (typeof document !== 'undefined' && document.hidden) appOpened = true;
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', detectBackground);
  }
  if (typeof window !== 'undefined') {
    window.location.href = appUrl;
    window.setTimeout(() => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', detectBackground);
      }
      if (!appOpened && typeof document !== 'undefined' && !document.hidden) {
        window.location.href = webUrl;
      }
    }, 1200);
  }
}

if (typeof window !== 'undefined') {
  window.triggerPwaUpdate = triggerPwaUpdate;
  window.openAppWithFallback = openAppWithFallback;
}
