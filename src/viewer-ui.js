/**
 * Viewer UI: DOM Builders, Device App Intents, Tab Navigation & Swipe Gestures
 */

export const APP_ICONS = Object.freeze({
  ana: 'images/ana-app.jpg',
  helloCycling: 'images/hello-cycling-app.png',
  tabelog: 'images/tabelog.png',
  jalan: 'images/jalan-app.jpg',
  toyota: 'images/toyota-rent-app.png'
});

export const TOYOTA_RENTAL_APP = Object.freeze({
  webUrl: 'https://rent.toyota.co.jp/cp/18_ser_app01/',
  androidIntent: 'intent://#Intent;scheme=toyotaapp;package=jp.co.toyota.rent.app.android;S.browser_fallback_url=https%3A%2F%2Frent.toyota.co.jp%2Fcp%2F18_ser_app01%2F;end',
  iosUrl: 'toyotaapp://'
});

export const MOBILE_APP_TARGETS = Object.freeze({
  jalan: Object.freeze({ hostname: 'www.jalan.net', packageName: 'net.jalan.android', scheme: 'jalan', intentHost: '', iosUrl: 'universal-link' }),
  helloCycling: Object.freeze({ hostname: 'www.hellocycling.jp', packageName: 'jp.hellocycling.hellocycling', scheme: 'hellocycling', intentHost: 'main', iosUrl: 'hellocycling://main' })
});

export const IS_ANDROID_DEVICE = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
export const IS_IOS_DEVICE = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function safeExternalUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    const base = typeof window !== 'undefined' && window.location ? window.location.href : 'https://localhost/';
    const url = new URL(raw, base);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch { return ''; }
}

export function isValidDataKey(value) {
  const key = String(value || '');
  return /^[A-Za-z0-9_-]+$/.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key);
}

export function sortDayKeys(keys) {
  return (keys || []).filter(isValidDataKey).sort((a, b) => {
    const aNum = Number(String(a).match(/\d+/)?.[0]);
    const bNum = Number(String(b).match(/\d+/)?.[0]);
    if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
    return String(a).localeCompare(String(b), 'ja');
  });
}

export function stableStorageId(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}

export function formatTripDateRange(startDate, endDate) {
  const parse = s => {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : { raw: `${m[1]}.${m[2]}.${m[3]}`, short: `${m[2]}.${m[3]}`, year: m[1], dow: '日月火水木金土'[d.getUTCDay()] };
  };
  const s = parse(startDate), e = parse(endDate);
  if (!s && !e) return '--';
  if (s && (!e || startDate === endDate)) return `${s.raw} (${s.dow}) · 日帰り`;
  if (!s && e) return `${e.raw} (${e.dow})`;
  return `${s.raw} (${s.dow}) — ${s.year === e.year ? e.short : e.raw} (${e.dow})`;
}

export function androidCustomSchemeIntent(value, app) {
  if (!IS_ANDROID_DEVICE || !app) return '';
  const href = safeExternalUrl(value);
  if (!href) return '';
  const url = new URL(href);
  if (url.protocol !== 'https:' || url.hostname !== app.hostname) return '';
  const intentAuthority = app.intentHost ? `//${app.intentHost}/` : '//';
  return `intent:${intentAuthority}#Intent;scheme=${app.scheme};package=${app.packageName};S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
}

export function iosAppLaunchUrl(value, app) {
  if (!IS_IOS_DEVICE || !app?.iosUrl) return '';
  const href = safeExternalUrl(value);
  if (!href) return '';
  const url = new URL(href);
  if (url.protocol !== 'https:' || url.hostname !== app.hostname) return '';
  return app.iosUrl === 'universal-link' ? url.href : app.iosUrl;
}

export function mobileAppLaunchUrl(value, app) {
  return androidCustomSchemeIntent(value, app) || iosAppLaunchUrl(value, app);
}

export const ACTION_LABELS = Object.freeze({
  '地図': '地図', '港': '地図', '乗り場': '地図', 'バス停': '地図', '駐車場': '地図',
  '候補': '地図', 'ホテル': '地図', '駅': '地図', '返却店': '地図', '空港': '地図',
  '公式': '公式', '公式サイト': '公式', 'ナイト公式案内': '公式',
  'ANA': 'ANA', 'レンタカー': 'レンタカー', '配船': 'フェリー',
  '潮見表': '潮見表', '時刻表': '時刻表', '店舗情報': '店舗',
  '街歩き': '案内', '入浴案内': '入浴', '朝食': '朝食',
  '施設案内': '案内', '空港案内': '空港',
  'お弁当予約': '弁当予約', '駅弁候補': '駅弁', 'ルート': 'ルート',
  '自転車': '自転車', '返却予約': '返却', '徒歩予備': '徒歩',
  'プログラム': '予定表', 'チケット': 'チケット', '館内案内': '館内図',
  '乗換': '乗換', '予約確認': '予約', '食事・買い物': 'グルメ',
  '公式Instagram': 'インスタ', 'Instagram': 'インスタ', 'インスタ': 'インスタ',
  'アソビュー': 'アソビュー', 'asoview': 'アソビュー', 'WEBチケット': 'チケット'
});

export function actionLabel(rawLabel, fallback = '詳細') {
  const raw = String(rawLabel || '').trim();
  if (!raw) return fallback;
  if (ACTION_LABELS[raw]) return ACTION_LABELS[raw];
  if (/instagram|インスタ/i.test(raw)) return 'インスタ';
  if (/公式/.test(raw)) return '公式';
  return raw.length <= 6 ? raw : fallback;
}

export function renderActionLink(url, rawLabel, options = {}) {
  const href = safeExternalUrl(url);
  if (!href) return '';
  const visibleLabel = options.visibleLabel || actionLabel(rawLabel, options.fallback || '詳細');
  const ariaLabel = options.ariaLabel || `${String(rawLabel || visibleLabel).trim()}を開く`;
  const classes = ['j-btn', options.primary ? 'primary' : '', options.className || ''].filter(Boolean).join(' ');
  const isAndroidIntent = typeof options.appUrl === 'string' && options.appUrl.startsWith('intent://');
  const linkHref = isAndroidIntent ? options.appUrl : href;
  const appAttrs = options.appUrl && !isAndroidIntent ? ` data-app-url="${escapeHtml(options.appUrl)}" onclick="openAppWithFallback(event, this)"` : '';
  const targetAttr = options.sameContext || isAndroidIntent ? '' : ' target="_blank"';
  return `<a href="${escapeHtml(linkHref)}"${appAttrs}${targetAttr} rel="noopener noreferrer" class="${classes}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(String(rawLabel || visibleLabel))}">${options.iconHtml || ''}<span class="j-btn-label">${escapeHtml(visibleLabel)}</span><span class="j-btn-mark" aria-hidden="true">↗</span></a>`;
}

export function buildShioriUI(data) {
  if (!data || typeof document === 'undefined') return;
  const weatherPanel = document.querySelector('.weather-disclosure');
  const itineraryNav = document.getElementById('nav-bar');
  if (weatherPanel && itineraryNav) itineraryNav.before(weatherPanel);

  document.getElementById('hero-title').textContent = data.title || '';
  document.getElementById('hero-catchphrase').textContent = data.catchphrase || '';
  document.getElementById('hero-date').textContent = `日程: ${formatTripDateRange(data.startDate, data.endDate)}`;

  const wNav = document.getElementById('weather-nav-container');
  let wHtml = '';
  if (data.weatherLocations) {
    Object.keys(data.weatherLocations).filter(isValidDataKey).forEach((k, idx) => {
      const loc = data.weatherLocations[k];
      wHtml += `<button type="button" class="w-tab ${idx === 0 ? 'active' : ''}" data-weather-key="${escapeHtml(k)}" aria-pressed="${idx === 0}" onclick="updateWeather('${k}', this)">${escapeHtml(String(loc.label || k).split(' ').pop())}</button>`;
    });
  }
  if (wNav) wNav.innerHTML = wHtml;
  const firstWeatherKey = data.weatherLocations ? Object.keys(data.weatherLocations).filter(isValidDataKey)[0] : null;
  if (firstWeatherKey && typeof window !== 'undefined' && window.updateWeather) window.updateWeather(firstWeatherKey, wNav?.querySelector('.w-tab'));
  if (weatherPanel) weatherPanel.hidden = !firstWeatherKey;

  const navBar = document.getElementById('nav-bar');
  let tabHeadersHtml = '';
  const dayKeys = sortDayKeys(Object.keys(data.days || {}));
  dayKeys.forEach((key, idx) => {
    const dayNum = idx + 1;
    tabHeadersHtml += `<button type="button" id="btn-${key}" class="j-tab-btn ${idx === 0 ? 'active' : ''}" role="tab" aria-selected="${idx === 0}" aria-controls="tab-${key}" onclick="switchTab('tab-${key}', this)" aria-label="${dayNum}日目">${dayNum}日目</button>`;
  });
  tabHeadersHtml += `<button type="button" id="btn-checklist" class="j-tab-btn" role="tab" aria-selected="false" aria-controls="tab-checklist" onclick="switchTab('tab-checklist', this)" aria-label="持ち物">持ち物</button>`;
  if (data.features?.expenses !== false) {
    tabHeadersHtml += `<button type="button" id="btn-expenses" class="j-tab-btn" role="tab" aria-selected="false" aria-controls="tab-expenses" onclick="switchTab('tab-expenses', this)" aria-label="精算">精算</button>`;
  }
  tabHeadersHtml += `<button type="button" id="btn-talk" class="j-tab-btn" role="tab" aria-selected="false" aria-controls="tab-talk" onclick="switchTab('tab-talk', this)" aria-label="相談・提案">相談</button>`;
  const publicRecap = (typeof window !== 'undefined' && window.shioriFindRecapForTrip) ? window.shioriFindRecapForTrip(data) : null;
  if (publicRecap) {
    tabHeadersHtml += `<button type="button" id="btn-recap" class="j-tab-btn" role="tab" aria-selected="false" aria-controls="tab-recap" onclick="switchTab('tab-recap', this)" aria-label="旅の記録">旅の記録</button>`;
  }
  if (navBar) navBar.innerHTML = tabHeadersHtml;

  const recapPanel = document.getElementById('tab-recap');
  const recapPreview = document.getElementById('recap-preview');
  if (recapPanel && recapPreview) {
    recapPanel.hidden = !publicRecap;
    recapPreview.replaceChildren();
    if (publicRecap) {
      const title = document.createElement('strong');
      title.textContent = `${publicRecap.title}の旅の記録`;
      const copy = document.createElement('p');
      copy.textContent = '予定から変わった時間も、その場で見つけた味も、実際に歩いた旅の記録として残しました。';
      const link = document.createElement('a');
      link.className = 'j-btn primary';
      link.href = publicRecap.href;
      link.textContent = '旅の記録を開く →';
      link.setAttribute('aria-label', '旅の記録を開く');
      recapPreview.append(title, copy, link);
    }
  }

  const panelsContainer = document.getElementById('day-panels-container');
  let panelsHtml = '';
  dayKeys.forEach((key, idx) => {
    const dayNum = idx + 1;
    const label = data.dayLabels?.[key] || `${dayNum}日目`;
    let cardsHtml = '';
    (Array.isArray(data.days[key]) ? data.days[key] : []).forEach((card, cardIndex) => {
      const cardTitle = String(card?.title || '');
      const rawDesc = String(card?.desc || '').trim();
      const cardDesc = rawDesc.length > 75 ? `${rawDesc.slice(0, 75).trimEnd()}…` : rawDesc;
      const imgHtml = card.image ? `<img class="j-card-img" src="images/${escapeHtml(card.image)}" alt="${escapeHtml(cardTitle)}" loading="lazy">` : '';
      const mapFields = (typeof window !== 'undefined' && window.shioriMapFields) ? window.shioriMapFields(card) : { mapQuery: '', mapUrl: '' };
      const mapQuery = mapFields.mapQuery, mapSharedUrl = mapFields.mapUrl;
      const travelMin = Math.max(0, Math.round(Number(card.travelMinutesFromPrevious) || 0));
      const sMatch = String(card.time || '').match(/^(\d{2}):(\d{2})/);
      const sMin = sMatch ? Number(sMatch[1]) * 60 + Number(sMatch[2]) : null;
      const depMin = sMin == null ? null : sMin - travelMin;
      const depLabel = depMin == null ? '' : `${String(Math.floor((depMin + 1440) % 1440 / 60)).padStart(2, '0')}:${String((depMin + 1440) % 60).padStart(2, '0')}までに出発`;
      const routeHint = String(card?.routeHint || '').trim(), waypoints = String(card?.waypoints || '').trim();
      const routeHintChip = routeHint ? `<span class="v2-route-chip">経由: ${escapeHtml(routeHint)}</span>` : '';
      const travelHintHtml = cardIndex > 0 && (travelMin || routeHint) ? `<div class="v2-travel-hint">${travelMin ? `<strong>移動 約${travelMin}分</strong>` : ''}${depLabel ? `<span>${depLabel}</span>` : ''}${routeHintChip}</div>` : '';

      let resHtml = '';
      if (card.reservation && typeof card.reservation === 'object') {
        const res = card.reservation;
        const rows = [['予約番号', res.number], ['予約名義', res.name], ['電話', res.phone], ['キャンセル期限', res.deadline], ['メモ', res.note]]
          .filter(([, v]) => v).map(([l, v]) => `<div class="v2-reservation-row"><span>${l}</span><strong>${escapeHtml(v)}</strong></div>`).join('');
        const resUrl = safeExternalUrl(res.url), phone = String(res.phone || '').replace(/[^0-9+]/g, '');
        const actions = [
          phone ? `<a class="j-btn" href="tel:${escapeHtml(phone)}" aria-label="電話をかける">電話する</a>` : '',
          resUrl ? `<a class="j-btn" href="${escapeHtml(resUrl)}" target="_blank" rel="noopener noreferrer" aria-label="予約を確認">予約確認 ↗</a>` : ''
        ].join('');
        resHtml = `<details class="v2-reservation"><summary>予約情報</summary><div class="v2-reservation-body">${rows}${actions ? `<div class="v2-reservation-actions">${actions}</div>` : ''}</div></details>`;
      }

      const cardLinks = Array.isArray(card.links) ? card.links : [];
      const routeLink = cardLinks.find(link => (link?.kind === 'route' || link?.label === 'ルート') && safeExternalUrl(link?.url));
      let linksHtml = '';
      if (routeLink) {
        linksHtml += renderActionLink(routeLink.url, routeLink.label, { primary: true, visibleLabel: 'ルート', ariaLabel: `${cardTitle || '目的地'}までのルートを開く` });
      } else if (mapQuery || mapSharedUrl) {
        const defMapUrl = (typeof window !== 'undefined' && window.shioriMapHref) ? window.shioriMapHref(card) : '';
        const wpUrl = mapQuery && waypoints ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(mapQuery)}&waypoints=${encodeURIComponent(waypoints)}&travelmode=driving` : defMapUrl;
        const prefMapUrl = (typeof window !== 'undefined' && window.shioriPreferredMapUrl) ? window.shioriPreferredMapUrl(mapQuery, wpUrl) : wpUrl;
        linksHtml += renderActionLink(mapSharedUrl || prefMapUrl, '地図', { primary: true, visibleLabel: '地図', ariaLabel: `${cardTitle || '目的地'}を地図で開く` });
      }
      if (card.tabelog && safeExternalUrl(card.tabelog)) {
        linksHtml += renderActionLink(card.tabelog, '食べログ', { visibleLabel: '食べログ', className: 'app-accent', ariaLabel: '食べログを開く', iconHtml: `<img src="${APP_ICONS.tabelog}" class="j-app-icon" alt="">` });
      }
      if (card.jalan && safeExternalUrl(card.jalan)) {
        linksHtml += renderActionLink(card.jalan, 'じゃらん', { visibleLabel: 'じゃらん', className: 'app-accent', ariaLabel: 'じゃらんを開く', appUrl: mobileAppLaunchUrl(card.jalan, MOBILE_APP_TARGETS.jalan), sameContext: true, iconHtml: `<img src="${APP_ICONS.jalan}" class="j-app-icon" alt="">` });
      }
      if (card.asoview && safeExternalUrl(card.asoview)) {
        linksHtml += renderActionLink(card.asoview, 'アソビュー', { visibleLabel: 'アソビュー', className: 'app-accent', ariaLabel: 'アソビューを開く' });
      }
      const offUrl = safeExternalUrl(card.official);
      if (offUrl && !cardLinks.some(l => safeExternalUrl(l?.url) && new URL(safeExternalUrl(l.url)).origin === new URL(offUrl).origin)) {
        linksHtml += renderActionLink(offUrl, card.officialLabel || '公式');
      }
      cardLinks.forEach(link => {
        if (link === routeLink || !link?.label) return;
        const sUrl = safeExternalUrl(link.url);
        const isBike = link.label === '自転車' && sUrl && new URL(sUrl).hostname === MOBILE_APP_TARGETS.helloCycling.hostname;
        const confIcon = typeof link.icon === 'string' && Object.hasOwn(APP_ICONS, link.icon) ? APP_ICONS[link.icon] : '';
        const appIcon = confIcon || (link.label === 'ANA' ? APP_ICONS.ana : link.label === 'TOYOTA' ? APP_ICONS.toyota : isBike ? APP_ICONS.helloCycling : '');
        const genAppUrl = link.androidUrl || link.iosUrl ? (IS_ANDROID_DEVICE ? link.androidUrl || '' : IS_IOS_DEVICE ? link.iosUrl || '' : '') : '';
        const appUrl = genAppUrl || (link.label === 'TOYOTA' && sUrl === TOYOTA_RENTAL_APP.webUrl ? (IS_ANDROID_DEVICE ? TOYOTA_RENTAL_APP.androidIntent : IS_IOS_DEVICE ? TOYOTA_RENTAL_APP.iosUrl : '') : isBike ? mobileAppLaunchUrl(sUrl, MOBILE_APP_TARGETS.helloCycling) : '');
        linksHtml += renderActionLink(link.url, link.label, { appUrl, visibleLabel: isBike ? '自転車' : undefined, sameContext: isBike, className: appIcon ? 'app-accent' : '', iconHtml: appIcon ? `<img src="${appIcon}" class="j-app-icon" alt="">` : '' });
      });

      const cst = card.constraints || {};
      const cstBadges = [
        cst.reservationAt ? `予約 ${cst.reservationAt}` : '',
        cst.departureBy ? `出発期限 ${cst.departureBy}` : '',
        cst.lastEntryAt ? `最終受付/L.O. ${cst.lastEntryAt}` : '',
        cst.closesAt ? `営業〜${cst.closesAt}` : ''
      ].filter(Boolean).map(b => `<span class="j-constraint-pill">${escapeHtml(b)}</span>`).join('');
      const btnRowHtml = linksHtml ? `<div class="j-btn-row">${linksHtml}</div>` : '';
      cardsHtml += `
        ${travelHintHtml}
        <div class="j-card" data-card-id="${escapeHtml(card.cardId || '')}" data-map-title="${escapeHtml(cardTitle)}" data-map-query="${escapeHtml(mapQuery)}" data-map-url="${escapeHtml(mapSharedUrl)}" data-route-hint="${escapeHtml(routeHint)}" data-waypoints="${escapeHtml(waypoints)}" data-travel-minutes="${travelMin}" data-expense-shortcut="${card.expenseShortcut === true ? 'true' : 'false'}">
          <div class="j-card-time-row"><span class="j-card-time">${escapeHtml(card.time)}</span>${cstBadges}</div>
          <div class="j-card-ttl"><span class="j-tag-badge">${escapeHtml(card.badge)}</span>${escapeHtml(cardTitle)}</div>
          <div class="j-card-desc">${escapeHtml(cardDesc)}</div>
          ${resHtml}${imgHtml}${btnRowHtml}
        </div>`;
    });

    panelsHtml += `
      <div id="tab-${key}" class="j-tab-panel ${idx === 0 ? 'active' : ''} j-tab-pnl" role="tabpanel" aria-labelledby="btn-${key}" aria-hidden="${idx !== 0}">
        <section class="j-sec-header">
          <h2 class="j-sec-en">${dayNum}日目の旅程</h2>
          <div class="j-sec-ja"><span>${escapeHtml(label)}</span><i class="j-sec-line"></i></div>
        </section>
        ${cardsHtml}
      </div>`;
  });
  if (panelsContainer) panelsContainer.innerHTML = panelsHtml;

  const checklistContainer = document.getElementById('checklist-grid-container');
  const categoryLabels = { DRIVE: 'ドライブ・車まわり', TRAVEL: '旅の持ち物', CHECKLIST: '持ち物リスト' };
  let checklistHtml = '';
  (Array.isArray(data.checklist) ? data.checklist : []).forEach(group => {
    let itemsHtml = '';
    const category = String(group?.category || 'CHECKLIST');
    (Array.isArray(group?.items) ? group.items : []).forEach(item => {
      const name = String(item?.name || item || '');
      if (!name) return;
      const suppliedId = String(item?.id || '');
      const checkId = isValidDataKey(suppliedId) ? suppliedId : `check-${stableStorageId(`${category}:${name}`)}`;
      itemsHtml += `<label class="checklist-item"><input type="checkbox" data-check-id="${escapeHtml(checkId)}"><span>${escapeHtml(name)}</span></label>`;
    });
    checklistHtml += `<div class="checklist-group"><div class="checklist-group-title">${escapeHtml(categoryLabels[category] || category)}</div>${itemsHtml}</div>`;
  });
  if (checklistContainer) checklistContainer.innerHTML = checklistHtml;

  const deviceOwner = document.getElementById('device-owner');
  const expensePayer = document.getElementById('expense-payer');
  let ownerOptions = '';
  (Array.isArray(data.members) ? data.members : []).forEach(m => {
    const mId = String(m?.id || '');
    if (isValidDataKey(mId)) ownerOptions += `<option value="${escapeHtml(mId)}">${escapeHtml(String(m?.name || mId))}</option>`;
  });
  if (deviceOwner) deviceOwner.innerHTML = ownerOptions;
  if (expensePayer) expensePayer.innerHTML = ownerOptions;
}

export function switchTab(panelId, btnEl) {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('.j-tab-panel').forEach(panel => {
    const isTarget = panel.id === panelId;
    panel.classList.toggle('active', isTarget);
    panel.setAttribute('aria-hidden', String(!isTarget));
  });
  document.querySelectorAll('.j-tab-btn').forEach(button => {
    const isTarget = button === btnEl || button.getAttribute('aria-controls') === panelId;
    button.classList.toggle('active', isTarget);
    button.setAttribute('aria-selected', String(isTarget));
  });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('shiori-tab-changed', { detail: { panelId } }));
  const navEl = document.getElementById('nav-bar');
  if (navEl && typeof window !== 'undefined') {
    window.scrollTo({ top: navEl.getBoundingClientRect().top + window.pageYOffset - 10, behavior: 'smooth' });
  }
}

let daySwipeInitialized = false;

export function setupDaySwipe(getTripDataFn) {
  if (daySwipeInitialized || typeof document === 'undefined') return;
  const surface = document.getElementById('day-panels-container');
  if (!surface) return;
  daySwipeInitialized = true;
  let startX = 0, startY = 0, startTime = 0, tracking = false;

  surface.addEventListener('touchstart', (event) => {
    tracking = !event.target.closest('a, button, input, select, textarea, label');
    if (!tracking) return;
    startX = event.touches[0].clientX; startY = event.touches[0].clientY; startTime = Date.now();
  }, { passive: true });

  surface.addEventListener('touchend', (event) => {
    if (!tracking) return;
    tracking = false;
    const activePanel = surface.querySelector('.j-tab-panel.active');
    const tripData = getTripDataFn ? getTripDataFn() : (typeof window !== 'undefined' ? window.currentTripData : null);
    const dayPanelIds = sortDayKeys(Object.keys(tripData?.days || {})).map(key => 'tab-' + key);
    const currentIndex = dayPanelIds.indexOf(activePanel?.id);
    const deltaX = event.changedTouches[0].clientX - startX, deltaY = event.changedTouches[0].clientY - startY;
    const elapsed = Date.now() - startTime;
    if (currentIndex < 0 || elapsed > 900 || Math.abs(deltaX) < 60 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) return;
    const nextIndex = deltaX < 0 ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex < 0 || nextIndex >= dayPanelIds.length) return;
    const nextPanelId = dayPanelIds[nextIndex];
    const nextButton = document.querySelector(`[aria-controls="${nextPanelId}"]`);
    switchTab(nextPanelId, nextButton);
    nextButton?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, { passive: true });
}

export function resetDaySwipe() { daySwipeInitialized = false; }

if (typeof window !== 'undefined') { window.switchTab = switchTab; }
