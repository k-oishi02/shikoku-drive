/**
 * Weather Service: Open-Meteo REST Client, Condition Parser & Local Storage Caching
 */

export const WEATHER_REFRESH_MS = 30 * 60 * 1000;
export const WEATHER_CACHE_KEY_PREFIX = 'shiori-weather-cache-v1:';

let weatherCache = {};
let weatherRefreshInterval = null;
let activeWeatherKey = '';
let weatherRequestId = 0;
let weatherAbort = null;
let currentTripGetter = null;

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

function isValidDataKey(value) {
  const key = String(value || '');
  return /^[A-Za-z0-9_-]+$/.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key);
}

export function readLocalWeatherCache(locKey) {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(`${WEATHER_CACHE_KEY_PREFIX}${locKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function writeLocalWeatherCache(locKey, entry) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(`${WEATHER_CACHE_KEY_PREFIX}${locKey}`, JSON.stringify(entry));
  } catch {}
}
export const loadWeatherCache = readLocalWeatherCache;
export const saveWeatherCache = writeLocalWeatherCache;

export function getWeatherCondition(code) {
  const value = Number(code);
  if (!Number.isFinite(value)) return { cond: '取得不能', icon: 'ERR' };
  if (value === 0) return { cond: '快晴', icon: 'SUN' };
  if (value <= 3) return { cond: '晴れ・曇り', icon: 'CLOUD' };
  if (value === 45 || value === 48) return { cond: '霧', icon: 'FOG' };
  if (value >= 51 && value <= 67) return { cond: value <= 57 ? '霧雨' : '雨', icon: 'RAIN' };
  if ([71, 73, 75, 77, 85, 86].includes(value)) return { cond: '雪', icon: 'SNOW' };
  if (value >= 80 && value <= 82) return { cond: 'にわか雨', icon: 'RAIN' };
  if (value >= 95) return { cond: '雷雨', icon: 'STORM' };
  return { cond: '天候不明', icon: '--' };
}

export function parseWeatherData(apiData, targetDate) {
  const dates = Array.isArray(apiData?.daily?.time) ? apiData.daily.time : [];
  const requestedIndex = targetDate ? dates.indexOf(targetDate) : 0;
  if (requestedIndex < 0 || !apiData?.daily || !Number.isFinite(apiData.daily.temperature_2m_max?.[requestedIndex])) {
    return {
      unavailable: true,
      temp: '—',
      range: '旅行日の予報はまだ未提供',
      pop: '—',
      cond: '出発前に再取得',
      icon: '⏳',
      sunset: '—',
      updated: '予報対象外（出発前に自動更新）'
    };
  }
  const index = requestedIndex;
  const tempMax = apiData.daily.temperature_2m_max[index];
  const tempMin = apiData.daily.temperature_2m_min[index];
  const weatherCode = apiData.daily.weather_code?.[index] ?? apiData.daily.weathercode?.[index];
  const sunsetValue = apiData.daily.sunset?.[index];
  const pop = apiData.daily.precipitation_probability_max?.[index];
  const { cond, icon } = getWeatherCondition(weatherCode);

  return {
    forecastDate: dates[index],
    temp: `${Math.round(tempMax)}°C`,
    range: `${Math.round(tempMin)}°C / ${Math.round(tempMax)}°C`,
    pop: Number.isFinite(pop) ? `${Math.round(pop)}%` : '—',
    cond,
    icon,
    sunset: sunsetValue ? String(sunsetValue).slice(11, 16) : '—',
    updated: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  };
}

export function renderWeather(w, locationLabel = '') {
  if (typeof document === 'undefined') return;
  const summary = document.getElementById('weather-summary');
  if (summary) {
    const locPrefix = locationLabel ? `${locationLabel} ` : '';
    const datePart = w.forecastDate ? `${w.forecastDate.slice(5).replace('-', '/')} · ` : '';
    const offlineBadge = w.isOffline ? '📴 ' : '';
    summary.textContent = `${offlineBadge}${locPrefix}${datePart}${w.unavailable ? w.range : `${w.cond} ${w.temp} / 雨 ${w.pop}`}`;
  }
  const map = { 'w-temp': w.temp, 'w-range': w.range, 'w-pop': w.pop, 'w-sunset': w.sunset, 'w-cond': w.cond, 'w-icon': w.icon, 'w-updated': w.updated };
  for (const [id, val] of Object.entries(map)) { const el = document.getElementById(id); if (el) el.textContent = val; }
}

export function fetchWeather(locKey, latitude, longitude, targetDate, activeTrip) {
  const trip = activeTrip || (currentTripGetter ? currentTripGetter() : null);
  const requestId = ++weatherRequestId;
  if (weatherAbort) weatherAbort.abort();
  weatherAbort = new AbortController();
  const controller = weatherAbort;
  const isCurrent = () => requestId === weatherRequestId && activeWeatherKey === locKey;
  const label = trip?.weatherLocations?.[locKey]?.label || '';

  const isDeviceOffline = typeof navigator !== 'undefined' && !navigator.onLine;
  if (isDeviceOffline) {
    if (!isCurrent()) return Promise.resolve();
    const cached = weatherCache[locKey] || readLocalWeatherCache(locKey);
    if (cached?.data) {
      renderWeather({ ...cached.data, isOffline: true, updated: `${cached.data.updated}取得分・オフライン表示（再試行できます）` }, label);
      return Promise.resolve();
    }
    renderWeather({
      temp: '—', range: 'オフラインのため予報を取得できません', pop: '—', cond: 'オフライン',
      icon: '📴', sunset: '—', updated: 'オンライン復帰時に自動取得します', isOffline: true
    }, label);
    return Promise.resolve();
  }

  const updatedEl = typeof document !== 'undefined' ? document.getElementById('w-updated') : null;
  if (updatedEl) updatedEl.textContent = '更新中…';

  const lat = Number(latitude), lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    if (activeWeatherKey === locKey) {
      renderWeather({ temp: '—', range: '地点情報が不正です', pop: '—', cond: '取得不能', icon: '⚠️', sunset: '—', updated: '旅程データを確認してください' });
    }
    return Promise.resolve();
  }

  const query = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunset',
    timezone: 'Asia/Tokyo', forecast_days: '16'
  });

  const timeout = typeof window !== 'undefined' ? window.setTimeout(() => controller.abort(), 12000) : null;
  return fetch(`https://api.open-meteo.com/v1/forecast?${query}`, { cache: 'no-store', signal: controller.signal })
    .then(res => { if (!res.ok) throw new Error(`Weather request failed: ${res.status}`); return res.json(); })
    .then(data => {
      if (!isCurrent()) return;
      const wData = parseWeatherData(data, targetDate);
      const cacheEntry = { timestamp: Date.now(), cachedAt: new Date().toISOString(), data: wData };
      weatherCache[locKey] = cacheEntry;
      writeLocalWeatherCache(locKey, cacheEntry);
      if (activeWeatherKey === locKey) renderWeather(wData, label);
    })
    .catch(() => {
      if (!isCurrent()) return;
      const cached = weatherCache[locKey] || readLocalWeatherCache(locKey);
      if (cached?.data) {
        renderWeather({ ...cached.data, isOffline: true, updated: `${cached.data.updated}取得分・オフライン表示（再試行できます）` }, label);
        return;
      }
      renderWeather({ temp: '—', range: '予報を取得できません', pop: '—', cond: '取得失敗', icon: '⚠️', sunset: '—', updated: '通信状態を確認し「更新」を押してください', isOffline: true }, label);
    })
    .finally(() => { if (timeout && typeof window !== 'undefined') window.clearTimeout(timeout); });
}

export function updateWeather(locKey, btnEl, activeTrip) {
  const trip = activeTrip || (currentTripGetter ? currentTripGetter() : null);
  if (!isValidDataKey(locKey) || !trip?.weatherLocations) return;
  const loc = trip.weatherLocations[locKey];
  if (!loc) return;
  activeWeatherKey = locKey;

  if (typeof document !== 'undefined') {
    document.querySelectorAll('.w-tab').forEach(btn => {
      const match = btn === btnEl || btn.getAttribute('data-weather-key') === locKey;
      btn.classList.toggle('active', match);
      btn.setAttribute('aria-pressed', String(match));
    });
    const fallbackLink = safeExternalUrl(loc.link) || 'https://weathernews.jp/';
    const wAppLink = document.getElementById('w-app-link');
    if (wAppLink) wAppLink.href = fallbackLink;
    const wLoc = document.getElementById('w-location');
    if (wLoc) wLoc.textContent = String(loc.label || locKey);
  }

  const cached = weatherCache[locKey] || readLocalWeatherCache(locKey);
  const isDeviceOffline = typeof navigator !== 'undefined' && !navigator.onLine;

  if (cached && (isDeviceOffline || (Date.now() - cached.timestamp < WEATHER_REFRESH_MS))) {
    weatherCache[locKey] = cached;
    const isStale = isDeviceOffline || (Date.now() - cached.timestamp >= WEATHER_REFRESH_MS);
    const renderData = isStale ? { ...cached.data, isOffline: true, updated: `${cached.data.updated}取得分・オフライン表示（再試行できます）` } : cached.data;
    renderWeather(renderData, loc.label || '');
    if (isDeviceOffline) return;
  } else {
    fetchWeather(locKey, loc.lat, loc.lon, loc.tripDate, trip);
  }
}

export function refreshWeather(activeTrip) {
  const trip = activeTrip || (currentTripGetter ? currentTripGetter() : null);
  if (typeof document === 'undefined') return;
  const activeTab = document.querySelector('.w-tab.active');
  const locKey = activeTab?.getAttribute('data-weather-key') || activeWeatherKey;
  const loc = locKey && trip?.weatherLocations?.[locKey];
  if (loc) fetchWeather(locKey, loc.lat, loc.lon, loc.tripDate, trip);
}

export function resetWeather() {
  if (weatherAbort) { weatherAbort.abort(); weatherAbort = null; }
  if (weatherRefreshInterval && typeof window !== 'undefined') {
    window.clearInterval(weatherRefreshInterval);
    weatherRefreshInterval = null;
  }
  weatherCache = {};
  activeWeatherKey = '';
  weatherRequestId++;
}

export function initWeatherService(getTripFn) {
  currentTripGetter = getTripFn;
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => refreshWeather());
    window.updateWeather = (k, btn) => updateWeather(k, btn);
    window.refreshWeather = () => refreshWeather();
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshWeather();
    });
  }
}
