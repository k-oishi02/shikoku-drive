import { formatMinute, parseTimeRange } from './trip-v2-core.js';
import { mapHref, resolveMapFields } from './map-links.js';

const LIVE_STATE_VERSION = 1;
const VALID_STATUS = new Set(['arrived', 'done', 'skipped']);

function safeCopy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value == null ? fallback : value;
  } catch (error) {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* Optional device state. */ }
}

function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function dayNumber(dayKey) {
  return Math.max(1, Number(String(dayKey).replace(/^day/, '')) || 1);
}

function dateForDay(startDate, dayKey) {
  const date = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + dayNumber(dayKey) - 1);
  return date.toISOString().slice(0, 10);
}

function stateKey(tripId) {
  return `shiori-live-itinerary-v${LIVE_STATE_VERSION}:${tripId}`;
}

function emptyState(trip) {
  return {
    version: LIVE_STATE_VERSION,
    tripId: trip.tripId,
    selectedDay: '',
    days: {},
    history: [],
    updatedAt: ''
  };
}

function normalizeDayState(source, cards) {
  const ids = cards.map(card => card.cardId);
  const known = new Set(ids);
  const suppliedOrder = Array.isArray(source?.order) ? source.order.filter(id => known.has(id)) : [];
  const order = [...new Set([...suppliedOrder, ...ids])];
  const status = {};
  Object.entries(source?.status || {}).forEach(([id, value]) => {
    if (known.has(id) && VALID_STATUS.has(value)) status[id] = value;
  });
  const delay = source?.delay && Number.isFinite(Number(source.delay.minutes))
    ? {
        minutes: Math.max(0, Math.min(240, Math.round(Number(source.delay.minutes)))),
        fromCardId: known.has(source.delay.fromCardId) ? source.delay.fromCardId : order.find(id => !status[id]) || order[0] || ''
      }
    : { minutes: 0, fromCardId: '' };
  return { order, status, delay };
}

function normalizeState(trip, stored) {
  const state = stored?.version === LIVE_STATE_VERSION && stored?.tripId === trip.tripId
    ? { ...emptyState(trip), ...stored }
    : emptyState(trip);
  state.days = {};
  Object.entries(trip.days || {}).forEach(([dayKey, cards]) => {
    state.days[dayKey] = normalizeDayState(stored?.days?.[dayKey], cards);
  });
  state.history = Array.isArray(stored?.history) ? stored.history.slice(-10) : [];
  if (!Object.hasOwn(state.days, state.selectedDay)) state.selectedDay = '';
  return state;
}

function snapshotState(state) {
  return { selectedDay: state.selectedDay, days: safeCopy(state.days), updatedAt: state.updatedAt };
}

function cardMap(trip, dayKey) {
  return new Map((trip.days?.[dayKey] || []).map(card => [card.cardId, card]));
}

function routeForCard(card) {
  const route = (card.links || []).find(link => link.kind === 'route' || link.label === 'ルート');
  if (route?.url) return route.url;
  const maps = resolveMapFields(card);
  if (!maps.mapQuery && !maps.mapUrl) return '';
  const google = maps.mapQuery
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(maps.mapQuery)}&travelmode=driving`
    : mapHref(card);
  return window.shioriPreferredMapUrl?.(maps.mapQuery, google) || maps.mapUrl || google;
}

function shiftedTime(card, offset) {
  const range = parseTimeRange(card.time);
  if (!range) return { label: card.time || '', start: null, end: null };
  return {
    label: `${formatMinute(range.start + offset)} - ${formatMinute(range.end + offset)}`,
    start: range.start + offset,
    end: range.end + offset
  };
}

function buildTimeline(trip, state, dayKey) {
  const day = state.days[dayKey];
  const cards = cardMap(trip, dayKey);
  let offset = 0;
  let delayStarted = false;
  let previous = null;
  const conflicts = [];
  const items = day.order.map((id, orderIndex) => {
    const card = cards.get(id);
    if (!card) return null;
    if (id === day.delay.fromCardId) {
      delayStarted = true;
      offset = day.delay.minutes;
    }
    if (delayStarted && card.timeLocked) offset = 0;
    const time = shiftedTime(card, card.timeLocked ? 0 : offset);
    if (previous?.time.end != null && time.start != null && previous.time.end > time.start) {
      conflicts.push(`${previous.card.title}と${card.title}が${previous.time.end - time.start}分重なります`);
    }
    const item = { card, time, orderIndex, status: day.status[id] || '', dayKey };
    previous = item;
    return item;
  }).filter(Boolean);
  return { items, conflicts };
}

function activeItem(timeline, dateKey, now = new Date()) {
  const pending = timeline.items.filter(item => !['done', 'skipped'].includes(item.status));
  if (!pending.length) return null;
  const arrived = pending.find(item => item.status === 'arrived');
  if (arrived) return arrived;
  const minute = now.getHours() * 60 + now.getMinutes();
  if (dateKey === localDateKey(now)) {
    return pending.find(item => item.time.start != null && minute >= item.time.start && minute < item.time.end)
      || pending.find(item => item.time.start != null && item.time.start > minute)
      || pending[0];
  }
  return pending[0];
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function createLiveItineraryController() {
  let trip = null;
  let state = null;
  let bindings = null;
  let timer = null;
  let root = null;
  let dialog = null;

  function persist() {
    state.updatedAt = new Date().toISOString();
    writeJson(stateKey(trip.tripId), state);
  }

  function remember(label) {
    state.history.push({ label, snapshot: snapshotState(state), at: new Date().toISOString() });
    state.history = state.history.slice(-10);
  }

  function mutate(label, callback) {
    remember(label);
    callback();
    persist();
    render();
  }

  function defaultDayKey() {
    const keys = Object.keys(trip.days || {}).sort((a, b) => dayNumber(a) - dayNumber(b));
    const today = localDateKey();
    return keys.find(key => dateForDay(trip.startDate, key) === today)
      || keys.find(key => dateForDay(trip.startDate, key) > today)
      || keys.at(-1)
      || '';
  }

  function selectedDayKey() {
    return state.selectedDay || defaultDayKey();
  }

  function setStatus(cardId, status) {
    const dayKey = selectedDayKey();
    mutate(status === 'skipped' ? '予定をスキップ' : status === 'done' ? '予定を完了' : '到着を記録', () => {
      if (status) state.days[dayKey].status[cardId] = status;
      else delete state.days[dayKey].status[cardId];
    });
  }

  function setDelay(minutes) {
    const dayKey = selectedDayKey();
    const timeline = buildTimeline(trip, state, dayKey);
    const active = activeItem(timeline, dateForDay(trip.startDate, dayKey));
    mutate(minutes ? `${minutes}分の遅れを反映` : '遅れを解除', () => {
      state.days[dayKey].delay = {
        minutes,
        fromCardId: minutes ? active?.card.cardId || state.days[dayKey].order[0] || '' : ''
      };
    });
  }

  function moveCard(cardId, direction) {
    const day = state.days[selectedDayKey()];
    const index = day.order.indexOf(cardId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= day.order.length) return;
    mutate('予定の順番を変更', () => {
      [day.order[index], day.order[nextIndex]] = [day.order[nextIndex], day.order[index]];
    });
  }

  function undo() {
    const previous = state.history.pop();
    if (!previous) return;
    state.selectedDay = previous.snapshot.selectedDay || '';
    state.days = previous.snapshot.days;
    state.updatedAt = new Date().toISOString();
    persist();
    render();
  }

  function resetDay() {
    const dayKey = selectedDayKey();
    if (!window.confirm('この端末で行った当日の変更を元に戻しますか？公開済みの旅程は変わりません。')) return;
    mutate('当日の変更をリセット', () => {
      state.days[dayKey] = normalizeDayState({}, trip.days[dayKey] || []);
    });
  }

  function openDay(dayKey) {
    const button = document.querySelector(`[aria-controls="tab-${dayKey}"]`);
    window.switchTab?.(`tab-${dayKey}`, button);
    button?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    document.getElementById(`tab-${dayKey}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderCards(timeline) {
    document.querySelectorAll('.j-card[data-card-id]').forEach(cardNode => {
      const id = cardNode.dataset.cardId;
      const item = timeline.items.find(candidate => candidate.card.cardId === id);
      cardNode.classList.toggle('live-done', item?.status === 'done');
      cardNode.classList.toggle('live-skipped', item?.status === 'skipped');
      cardNode.classList.toggle('live-arrived', item?.status === 'arrived');
    });
  }

  function renderDialog(timeline) {
    if (!dialog) return;
    const dayKey = selectedDayKey();
    const select = dialog.querySelector('[data-live="day-select"]');
    select.replaceChildren(...Object.keys(trip.days || {}).sort((a, b) => dayNumber(a) - dayNumber(b)).map(key => {
      const option = new Option(`${key.toUpperCase()} · ${trip.dayLabels?.[key] || ''}`, key);
      option.selected = key === dayKey;
      return option;
    }));
    dialog.querySelectorAll('[data-live-delay]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.liveDelay) === state.days[dayKey].delay.minutes));
    });
    const list = dialog.querySelector('[data-live="plan-list"]');
    list.replaceChildren(...timeline.items.map((item, index) => {
      const row = element('li', `live-plan-row ${item.status ? `is-${item.status}` : ''}`);
      const copy = element('div', 'live-plan-copy');
      copy.append(element('span', 'live-plan-time', item.time.label), element('strong', '', item.card.title));
      const actions = element('div', 'live-plan-row-actions');
      const up = element('button', 'live-mini-action', 'UP');
      up.type = 'button'; up.disabled = index === 0; up.setAttribute('aria-label', `${item.card.title}を上へ移動`);
      up.addEventListener('click', () => moveCard(item.card.cardId, -1), { signal: bindings.signal });
      const down = element('button', 'live-mini-action', 'DOWN');
      down.type = 'button'; down.disabled = index === timeline.items.length - 1; down.setAttribute('aria-label', `${item.card.title}を下へ移動`);
      down.addEventListener('click', () => moveCard(item.card.cardId, 1), { signal: bindings.signal });
      const toggle = element('button', 'live-mini-action', item.status === 'skipped' ? 'RESTORE' : 'SKIP');
      toggle.type = 'button'; toggle.setAttribute('aria-label', item.status === 'skipped' ? `${item.card.title}を予定へ戻す` : `${item.card.title}をスキップ`);
      toggle.addEventListener('click', () => setStatus(item.card.cardId, item.status === 'skipped' ? '' : 'skipped'), { signal: bindings.signal });
      actions.append(up, down, toggle);
      row.append(copy, actions);
      return row;
    }));
    const conflict = dialog.querySelector('[data-live="conflict"]');
    conflict.hidden = !timeline.conflicts.length;
    conflict.textContent = timeline.conflicts.length ? `要確認：${timeline.conflicts.join('／')}` : '';
    const undoButton = dialog.querySelector('[data-live="undo"]');
    undoButton.disabled = !state.history.length;
  }

  function render() {
    if (!trip || !root) return;
    const dayKey = selectedDayKey();
    if (!dayKey || !state.days[dayKey]) {
      root.hidden = true;
      return;
    }
    state.selectedDay = dayKey;
    const timeline = buildTimeline(trip, state, dayKey);
    const active = activeItem(timeline, dateForDay(trip.startDate, dayKey));
    const dayLabel = root.querySelector('[data-live="day"]');
    const title = root.querySelector('[data-live="title"]');
    const time = root.querySelector('[data-live="time"]');
    const status = root.querySelector('[data-live="status"]');
    const route = root.querySelector('[data-live="route"]');
    const arrive = root.querySelector('[data-live="arrive"]');
    const done = root.querySelector('[data-live="done"]');
    const skip = root.querySelector('[data-live="skip"]');
    const delay = state.days[dayKey].delay.minutes;
    dayLabel.textContent = `${dayKey.toUpperCase()} · ${trip.dayLabels?.[dayKey] || ''}`;
    if (!active) {
      title.textContent = '今日の予定は完了しました';
      time.textContent = 'ALL DONE';
      status.textContent = '実際に回った記録は、この端末に保存されています。';
      route.hidden = true; arrive.hidden = true; done.hidden = true; skip.hidden = true;
    } else {
      title.textContent = active.card.title;
      time.textContent = active.time.label || 'TIME TBD';
      status.textContent = active.status === 'arrived'
        ? '到着済みです。楽しんだらDONEへ。'
        : delay ? `${delay}分の遅れを反映中。固定予定は動かしません。` : '公開旅程を元に、この端末で柔軟に変更できます。';
      const url = routeForCard(active.card);
      route.hidden = !url;
      if (url) route.href = url;
      arrive.hidden = active.status === 'arrived';
      done.hidden = false; skip.hidden = false;
      arrive.dataset.cardId = active.card.cardId;
      done.dataset.cardId = active.card.cardId;
      skip.dataset.cardId = active.card.cardId;
    }
    root.querySelector('[data-live="delay-badge"]').hidden = !delay;
    root.querySelector('[data-live="delay-badge"]').textContent = delay ? `+${delay} MIN` : '';
    root.querySelector('[data-live="offline-note"]').hidden = navigator.onLine;
    renderCards(timeline);
    renderDialog(timeline);
  }

  function bind() {
    bindings?.abort();
    bindings = new AbortController();
    const options = { signal: bindings.signal };
    root.querySelector('[data-live="arrive"]').addEventListener('click', event => setStatus(event.currentTarget.dataset.cardId, 'arrived'), options);
    root.querySelector('[data-live="done"]').addEventListener('click', event => setStatus(event.currentTarget.dataset.cardId, 'done'), options);
    root.querySelector('[data-live="skip"]').addEventListener('click', event => setStatus(event.currentTarget.dataset.cardId, 'skipped'), options);
    root.querySelector('[data-live="today"]').addEventListener('click', () => openDay(selectedDayKey()), options);
    root.querySelector('[data-live="plan"]').addEventListener('click', () => dialog?.showModal(), options);
    dialog.querySelector('[data-live="close"]').addEventListener('click', () => dialog.close(), options);
    dialog.querySelector('[data-live="day-select"]').addEventListener('change', event => {
      state.selectedDay = event.target.value;
      persist(); render();
    }, options);
    dialog.querySelectorAll('[data-live-delay]').forEach(button => button.addEventListener('click', () => setDelay(Number(button.dataset.liveDelay)), options));
    dialog.querySelector('[data-live="undo"]').addEventListener('click', undo, options);
    dialog.querySelector('[data-live="reset"]').addEventListener('click', resetDay, options);
    window.addEventListener('online', render, options);
    window.addEventListener('offline', render, options);
  }

  function activate(nextTrip) {
    trip = nextTrip;
    root = document.getElementById('live-itinerary');
    dialog = document.getElementById('live-plan-dialog');
    if (!root || !dialog) return;
    state = normalizeState(trip, readJson(stateKey(trip.tripId), null));
    const legacy = document.getElementById('legacy-now-body');
    if (legacy) legacy.hidden = true;
    root.hidden = false;
    bind();
    render();
    if (timer) clearInterval(timer);
    timer = setInterval(render, 30000);
  }

  function deactivate() {
    bindings?.abort();
    bindings = null;
    if (timer) clearInterval(timer);
    timer = null;
    document.querySelectorAll('.j-card[data-card-id]').forEach(card => card.classList.remove('live-done', 'live-skipped', 'live-arrived'));
    const legacy = document.getElementById('legacy-now-body');
    if (legacy) legacy.hidden = false;
    if (root) root.hidden = true;
    trip = null; state = null; root = null; dialog = null;
  }

  return { activate, deactivate, render };
}
