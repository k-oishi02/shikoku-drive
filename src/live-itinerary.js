import { formatMinute, parseTimeRange } from './trip-v2-core.js';
import { mapHref, resolveMapFields } from './map-links.js';
import {
  applyJourneyStatus,
  buildJourneyRecap,
  cleanJourneyStop,
  extractGoogleTimelineVisits,
  journeyDateForDay,
  journeyPhase,
  journeyRecapStorageKey,
  normalizeJourneyRecord,
  setJourneyNote
} from './journey-v4.js';

const LIVE_STATE_VERSION = 4;
const VALID_STATUS = new Set(['arrived', 'done', 'skipped']);
const MAX_TIMELINE_FILE_BYTES = 150 * 1024 * 1024;

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
  return `shiori-journey-v${LIVE_STATE_VERSION}:${tripId}`;
}

function legacyStateKey(tripId) {
  return `shiori-live-itinerary-v1:${tripId}`;
}

function emptyState(trip) {
  return {
    version: LIVE_STATE_VERSION,
    tripId: trip.tripId,
    selectedDay: '',
    days: {},
    records: {},
    history: [],
    updatedAt: ''
  };
}

function normalizeDayState(source, cards) {
  const extraCards = (Array.isArray(source?.extraCards) ? source.extraCards : [])
    .slice(0, 100)
    .map((card, index) => cleanJourneyStop(card, `extra-${index}`))
    .filter(Boolean);
  const ids = [...cards, ...extraCards].map(card => card.cardId);
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
  return { order, status, delay, extraCards };
}

function normalizeState(trip, stored) {
  const source = stored?.tripId === trip.tripId ? stored : null;
  const state = source
    ? { ...emptyState(trip), ...source }
    : emptyState(trip);
  state.version = LIVE_STATE_VERSION;
  state.days = {};
  Object.entries(trip.days || {}).forEach(([dayKey, cards]) => {
    state.days[dayKey] = normalizeDayState(source?.days?.[dayKey], cards);
  });
  state.history = Array.isArray(source?.history) ? source.history.slice(-10) : [];
  state.records = Object.fromEntries(Object.entries(source?.records || {})
    .filter(([cardId]) => /^[A-Za-z0-9_-]{1,120}$/.test(cardId))
    .map(([cardId, record]) => [cardId, normalizeJourneyRecord(record)]));
  if (!Object.hasOwn(state.days, state.selectedDay)) state.selectedDay = '';
  return state;
}

function snapshotState(state) {
  return { selectedDay: state.selectedDay, days: safeCopy(state.days), records: safeCopy(state.records), updatedAt: state.updatedAt };
}

function cardMap(trip, state, dayKey) {
  return new Map([...(trip.days?.[dayKey] || []), ...(state.days?.[dayKey]?.extraCards || [])].map(card => [card.cardId, card]));
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
  const cards = cardMap(trip, state, dayKey);
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
    const record = normalizeJourneyRecord(state.records?.[id]);
    const item = { card, time, orderIndex, status: record.status || day.status[id] || '', record, dayKey };
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

function actualRecordLabel(record) {
  const values = [];
  const time = value => value
    ? new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' }).format(new Date(value))
    : '';
  if (record?.arrivedAt) values.push(`ARRIVE ${time(record.arrivedAt)}`);
  if (record?.doneAt) values.push(`DONE ${time(record.doneAt)}`);
  if (record?.skippedAt) values.push(`SKIP ${time(record.skippedAt)}`);
  if (record?.note) values.push(record.note);
  return values.join(' · ');
}

export function createLiveItineraryController() {
  let trip = null;
  let state = null;
  let bindings = null;
  let timer = null;
  let syncOffline = false;
  let root = null;
  let dialog = null;

  function renderNetworkState() {
    const note = root?.querySelector('[data-live="offline-note"]');
    if (note) note.hidden = navigator.onLine && !syncOffline;
  }

  function handleLedgerAccess(event) {
    syncOffline = event?.detail?.live === false && event?.detail?.reason === 'offline';
    renderNetworkState();
  }

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
      state.records = applyJourneyStatus(state.records, cardId, status, new Date().toISOString());
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
    state.records = previous.snapshot.records || {};
    state.updatedAt = new Date().toISOString();
    persist();
    render();
  }

  function resetDay() {
    const dayKey = selectedDayKey();
    if (!window.confirm('この端末で行った当日の変更を元に戻しますか？公開済みの旅程は変わりません。')) return;
    mutate('当日の変更をリセット', () => {
      const affectedIds = new Set([
        ...(trip.days?.[dayKey] || []).map(card => card.cardId),
        ...(state.days?.[dayKey]?.extraCards || []).map(card => card.cardId)
      ]);
      state.records = Object.fromEntries(Object.entries(state.records || {}).filter(([cardId]) => !affectedIds.has(cardId)));
      state.days[dayKey] = normalizeDayState({}, trip.days[dayKey] || []);
    });
  }

  function editJourneyItem(item) {
    if (!item?.card?.cardId) return;
    const card = item.card;
    if (card.isJourneyExtra) {
      const title = window.prompt('立ち寄り先の名称', card.title);
      if (title == null || !title.trim()) return;
      const note = window.prompt('食べたもの・印象など', item.record?.note || card.desc || '');
      if (note == null) return;
      mutate('現地追加を編集', () => {
        const target = state.days[item.dayKey].extraCards.find(candidate => candidate.cardId === card.cardId);
        if (target) target.title = title.trim().slice(0, 120);
        state.records = setJourneyNote(state.records, card.cardId, note);
      });
      return;
    }
    const note = window.prompt(`${card.title}の旅メモ`, item.record?.note || '');
    if (note == null) return;
    mutate('旅メモを更新', () => {
      state.records = setJourneyNote(state.records, card.cardId, note);
    });
  }

  function removeExtraItem(item) {
    if (!item?.card?.isJourneyExtra) return;
    mutate('現地追加を削除', () => {
      const day = state.days[item.dayKey];
      day.extraCards = day.extraCards.filter(card => card.cardId !== item.card.cardId);
      day.order = day.order.filter(cardId => cardId !== item.card.cardId);
      delete day.status[item.card.cardId];
      delete state.records[item.card.cardId];
    });
  }

  function addStop(form) {
    const dayKey = selectedDayKey();
    const title = form.querySelector('[data-live="add-stop-title"]')?.value.trim() || '';
    if (!title) return;
    const now = new Date();
    const added = cleanJourneyStop({
      cardId: `live-${crypto.randomUUID()}`,
      title,
      time: new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' }).format(now),
      desc: form.querySelector('[data-live="add-stop-note"]')?.value || '',
      mapQuery: form.querySelector('[data-live="add-stop-map"]')?.value || '',
      addedAt: now.toISOString()
    });
    if (!added) return;
    mutate('現地で立ち寄り先を追加', () => {
      state.days[dayKey].extraCards.push(added);
      state.days[dayKey].order.push(added.cardId);
      state.days[dayKey].status[added.cardId] = 'done';
      state.records = applyJourneyStatus(state.records, added.cardId, 'done', added.addedAt);
      if (added.desc) state.records = setJourneyNote(state.records, added.cardId, added.desc);
    });
    form.reset();
  }

  async function importTimeline(file, output) {
    if (!file) return;
    if (file.size > MAX_TIMELINE_FILE_BYTES) {
      output.textContent = '150MB以下のTimeline JSONを選択してください。';
      return;
    }
    try {
      const payload = JSON.parse(await file.text());
      const visits = extractGoogleTimelineVisits(payload, { startDate: trip.startDate, endDate: trip.endDate });
      if (!visits.length) {
        output.textContent = '旅行期間内の訪問候補を見つけられませんでした。';
        return;
      }
      if (!window.confirm(`${visits.length}件の訪問候補を端末内の実績へ追加します。よろしいですか？`)) {
        output.textContent = '取り込みをキャンセルしました。';
        return;
      }
      let addedCount = 0;
      mutate('Google Timelineを取り込み', () => {
        visits.forEach((visit, index) => {
          const dayKey = Object.keys(trip.days || {}).find(key => journeyDateForDay(trip.startDate, key) === visit.date);
          if (!dayKey) return;
          const day = state.days[dayKey];
          if (day.extraCards.some(card => card.mapQuery === visit.mapQuery && card.time === visit.time)) return;
          const added = cleanJourneyStop({
            cardId: `timeline-${crypto.randomUUID()}`,
            title: visit.title || `Timeline訪問地点 ${index + 1}`,
            time: visit.time,
            mapQuery: visit.mapQuery,
            desc: 'Google Maps Timelineから取り込み',
            addedAt: visit.startTime
          });
          if (!added) return;
          day.extraCards.push(added);
          day.order.push(added.cardId);
          day.status[added.cardId] = 'done';
          state.records = applyJourneyStatus(state.records, added.cardId, 'done', added.addedAt);
          addedCount += 1;
        });
      });
      output.textContent = `${addedCount}件を追加しました。名称やメモはEDITから整えられます。`;
    } catch (error) {
      output.textContent = 'JSONを読み込めませんでした。Google Maps Timelineの書き出しファイルを確認してください。';
    }
  }

  function openRecap() {
    const hasActual = Object.values(state.records || {}).some(record => record?.status)
      || Object.values(state.days || {}).some(day => day.extraCards?.length);
    const publicRecap = window.shioriFindRecapForTrip?.(trip);
    if (!hasActual && publicRecap) {
      location.href = `${publicRecap.href}&trip=${encodeURIComponent(trip.tripId)}`;
      return;
    }
    if (!hasActual) {
      window.alert('まだ実際の記録がありません。ARRIVE・DONE・SKIP、またはADD STOPで旅の記録を残してください。');
      dialog?.showModal();
      return;
    }
    const recap = buildJourneyRecap(trip, state);
    writeJson(journeyRecapStorageKey(trip.tripId), recap);
    location.href = `./recap.html?local=${encodeURIComponent(trip.tripId)}`;
  }

  function openDay(dayKey) {
    const button = document.querySelector(`[aria-controls="tab-${dayKey}"]`);
    window.switchTab?.(`tab-${dayKey}`, button);
    button?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    document.getElementById(`tab-${dayKey}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openActiveMemo() {
    const dayKey = selectedDayKey();
    const timeline = buildTimeline(trip, state, dayKey);
    const item = activeItem(timeline, dateForDay(trip.startDate, dayKey)) || timeline.items.at(-1);
    if (item) editJourneyItem(item);
  }

  function openCosts() {
    const button = document.getElementById('btn-expenses');
    if (!button) return;
    window.switchTab?.('tab-expenses', button);
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
      const actual = actualRecordLabel(item.record);
      if (actual) copy.append(element('span', 'live-plan-record', actual));
      const actions = element('div', 'live-plan-row-actions');
      const up = element('button', 'live-mini-action', 'UP');
      up.type = 'button'; up.disabled = index === 0; up.setAttribute('aria-label', `${item.card.title}を上へ移動`);
      up.addEventListener('click', () => moveCard(item.card.cardId, -1), { signal: bindings.signal });
      const down = element('button', 'live-mini-action', 'DOWN');
      down.type = 'button'; down.disabled = index === timeline.items.length - 1; down.setAttribute('aria-label', `${item.card.title}を下へ移動`);
      down.addEventListener('click', () => moveCard(item.card.cardId, 1), { signal: bindings.signal });
      const toggleLabel = item.card.isJourneyExtra ? 'REMOVE' : item.status === 'skipped' ? 'RESTORE' : 'SKIP';
      const toggle = element('button', 'live-mini-action', toggleLabel);
      toggle.type = 'button';
      toggle.setAttribute('aria-label', item.card.isJourneyExtra ? `${item.card.title}を現地追加から削除` : item.status === 'skipped' ? `${item.card.title}を予定へ戻す` : `${item.card.title}をスキップ`);
      toggle.addEventListener('click', () => item.card.isJourneyExtra ? removeExtraItem(item) : setStatus(item.card.cardId, item.status === 'skipped' ? '' : 'skipped'), { signal: bindings.signal });
      const edit = element('button', 'live-mini-action', 'EDIT');
      edit.type = 'button'; edit.setAttribute('aria-label', `${item.card.title}の名称または旅メモを編集`);
      edit.addEventListener('click', () => editJourneyItem(item), { signal: bindings.signal });
      actions.append(up, down, toggle, edit);
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
    const phase = journeyPhase(trip);
    const isPlan = phase === 'plan';
    root.dataset.phase = phase;
    root.querySelector('[data-live="phase"]').textContent = phase === 'plan' ? 'PLAN · 旅の準備' : phase === 'recap' ? 'RECAP · 旅の振り返り' : 'LIVE · 旅行中';
    const recapButton = root.querySelector('[data-live="recap"]');
    recapButton.textContent = phase === 'recap' ? 'CREATE RECAP' : 'RECAP';
    recapButton.hidden = isPlan;
    root.querySelector('[data-live="memo"]').hidden = isPlan;
    root.querySelector('[data-live="cost"]').hidden = !document.getElementById('btn-expenses');
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
      route.textContent = isPlan ? 'MAP' : 'DRIVE';
      if (url) route.href = url;
      arrive.hidden = isPlan || active.status === 'arrived';
      done.hidden = isPlan; skip.hidden = isPlan;
      arrive.dataset.cardId = active.card.cardId;
      done.dataset.cardId = active.card.cardId;
      skip.dataset.cardId = active.card.cardId;
      if (isPlan) status.textContent = '旅行前はPLANで順序や立ち寄り先を確認できます。実績の記録は旅行開始後に表示します。';
    }
    root.querySelector('[data-live="delay-badge"]').hidden = !delay;
    root.querySelector('[data-live="delay-badge"]').textContent = delay ? `+${delay} MIN` : '';
    renderNetworkState();
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
    root.querySelector('[data-live="memo"]').addEventListener('click', openActiveMemo, options);
    root.querySelector('[data-live="cost"]').addEventListener('click', openCosts, options);
    root.querySelector('[data-live="recap"]').addEventListener('click', openRecap, options);
    dialog.querySelector('[data-live="close"]').addEventListener('click', () => dialog.close(), options);
    dialog.querySelector('[data-live="day-select"]').addEventListener('change', event => {
      state.selectedDay = event.target.value;
      persist(); render();
    }, options);
    dialog.querySelectorAll('[data-live-delay]').forEach(button => button.addEventListener('click', () => setDelay(Number(button.dataset.liveDelay)), options));
    dialog.querySelector('[data-live="undo"]').addEventListener('click', undo, options);
    dialog.querySelector('[data-live="reset"]').addEventListener('click', resetDay, options);
    dialog.querySelector('[data-live="add-stop-form"]').addEventListener('submit', event => {
      event.preventDefault();
      addStop(event.currentTarget);
    }, options);
    dialog.querySelector('[data-live="timeline-file"]').addEventListener('change', event => {
      const output = dialog.querySelector('[data-live="timeline-result"]');
      importTimeline(event.target.files?.[0], output).finally(() => { event.target.value = ''; });
    }, options);
    window.addEventListener('online', render, options);
    window.addEventListener('offline', render, options);
    window.addEventListener('pageshow', render, options);
    window.addEventListener('shiori-ledger-access', handleLedgerAccess, options);
    document.addEventListener('visibilitychange', render, options);
  }

  function activate(nextTrip) {
    trip = nextTrip;
    root = document.getElementById('live-itinerary');
    dialog = document.getElementById('live-plan-dialog');
    if (!root || !dialog) return;
    state = normalizeState(trip, readJson(stateKey(trip.tripId), null) || readJson(legacyStateKey(trip.tripId), null));
    syncOffline = window.currentLedgerAccess?.live === false && window.currentLedgerAccess?.reason === 'offline';
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
    syncOffline = false;
    document.querySelectorAll('.j-card[data-card-id]').forEach(card => card.classList.remove('live-done', 'live-skipped', 'live-arrived'));
    const legacy = document.getElementById('legacy-now-body');
    if (legacy) legacy.hidden = false;
    if (root) root.hidden = true;
    trip = null; state = null; root = null; dialog = null;
  }

  return {
    activate,
    deactivate,
    render,
    getState: () => safeCopy(state),
    buildRecap: () => trip && state ? buildJourneyRecap(trip, state) : null
  };
}
