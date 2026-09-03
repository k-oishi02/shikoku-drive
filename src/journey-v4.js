const STATUS_VALUES = new Set(['arrived', 'done', 'skipped']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

function copy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function iso(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function clock(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo'
  }).format(date);
}

export function journeyRecapStorageKey(tripId) {
  return `shiori-recap-v4:${String(tripId || '').replace(/[^A-Za-z0-9_-]/g, '')}`;
}

export function journeyDateForDay(startDate, dayKey) {
  const day = Math.max(1, Number(String(dayKey).replace(/^day/, '')) || 1);
  const date = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + day - 1);
  return date.toISOString().slice(0, 10);
}

export function journeyPhase(trip, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  if (trip?.startDate && today < trip.startDate) return 'plan';
  if (trip?.endDate && today > trip.endDate) return 'recap';
  return 'live';
}

export function normalizeJourneyRecord(source = {}) {
  const status = STATUS_VALUES.has(source.status) ? source.status : '';
  return {
    status,
    arrivedAt: iso(source.arrivedAt),
    doneAt: iso(source.doneAt),
    skippedAt: iso(source.skippedAt),
    note: text(source.note, 500)
  };
}

export function applyJourneyStatus(records, cardId, status, at = new Date().toISOString()) {
  if (!ID_PATTERN.test(String(cardId || ''))) return copy(records || {});
  if (status && !STATUS_VALUES.has(status)) return copy(records || {});
  const next = copy(records || {});
  const record = normalizeJourneyRecord(next[cardId]);
  if (!status) {
    record.status = '';
    record.skippedAt = '';
  } else if (status === 'arrived') {
    record.status = status;
    record.arrivedAt ||= iso(at);
    record.skippedAt = '';
  } else if (status === 'done') {
    record.status = status;
    record.arrivedAt ||= iso(at);
    record.doneAt = iso(at);
    record.skippedAt = '';
  } else {
    record.status = status;
    record.skippedAt = iso(at);
    record.arrivedAt = '';
    record.doneAt = '';
  }
  next[cardId] = record;
  return next;
}

export function setJourneyNote(records, cardId, note) {
  if (!ID_PATTERN.test(String(cardId || ''))) return copy(records || {});
  const next = copy(records || {});
  next[cardId] = { ...normalizeJourneyRecord(next[cardId]), note: text(note, 500) };
  return next;
}

export function cleanJourneyStop(source = {}, fallbackId = '') {
  const cardId = ID_PATTERN.test(String(source.cardId || '')) ? String(source.cardId) : fallbackId;
  if (!ID_PATTERN.test(cardId)) return null;
  const title = text(source.title, 120);
  if (!title) return null;
  return {
    cardId,
    title,
    time: text(source.time, 40),
    badge: 'LIVE',
    desc: text(source.desc || source.note, 500),
    mapQuery: text(source.mapQuery, 200),
    mapUrl: text(source.mapUrl, 2000),
    addedAt: iso(source.addedAt) || new Date().toISOString(),
    isJourneyExtra: true
  };
}

export function buildJourneyRecap(trip, state, createdAt = new Date().toISOString()) {
  const records = state?.records || {};
  let actualCount = 0;
  let changeCount = 0;
  const highlights = [];
  const days = Object.entries(trip?.days || {}).map(([dayKey, plannedCards], index) => {
    const dayState = state?.days?.[dayKey] || {};
    const extras = (dayState.extraCards || []).map((item, itemIndex) => cleanJourneyStop(item, `extra-${index}-${itemIndex}`)).filter(Boolean);
    const byId = new Map([...plannedCards, ...extras].map(card => [card.cardId, card]));
    const plannedOrder = plannedCards.map(card => card.cardId);
    const order = [...new Set([...(dayState.order || []), ...plannedOrder, ...extras.map(card => card.cardId)])];
    const events = [];
    const changedPlans = [];
    order.forEach(cardId => {
      const card = byId.get(cardId);
      if (!card) return;
      const record = normalizeJourneyRecord(records[cardId]);
      const status = record.status || dayState.status?.[cardId] || '';
      if (status === 'skipped') {
        changedPlans.push(`見送り：${card.title}`);
        changeCount += 1;
        return;
      }
      if (!status && !card.isJourneyExtra) return;
      const time = clock(record.arrivedAt || record.doneAt || card.addedAt) || text(card.time, 40);
      const detail = record.note || card.desc || (card.isJourneyExtra ? '現地で追加した立ち寄り先' : '訪問済み');
      events.push({ time, title: card.title, detail });
      actualCount += 1;
      if (!highlights.includes(card.title) && highlights.length < 6) highlights.push(card.title);
      if (card.isJourneyExtra) {
        changedPlans.push(`現地で追加：${card.title}`);
        changeCount += 1;
      }
    });
    if (order.filter(id => plannedOrder.includes(id)).join('|') !== plannedOrder.join('|')) {
      changedPlans.push('当日に訪問順を変更');
      changeCount += 1;
    }
    if (Number(dayState.delay?.minutes || 0) > 0) {
      changedPlans.push(`当日に約${Number(dayState.delay.minutes)}分の遅れを反映`);
      changeCount += 1;
    }
    return {
      date: journeyDateForDay(trip.startDate, dayKey),
      label: trip.dayLabels?.[dayKey] || `${index + 1}日目`,
      events: events.slice(0, 100),
      changedPlans
    };
  });
  return {
    schema: 'shiori-recap-v1',
    visibility: 'local',
    id: `local-${trip.tripId}`,
    sourceTripId: trip.tripId,
    title: trip.title || '旅の記録',
    subtitle: trip.subtitle || '旅の記録 · RECAP',
    startDate: trip.startDate,
    endDate: trip.endDate,
    summary: `旅行前の計画を残しながら、実際に訪れた${actualCount}件と予定変更${changeCount}件を記録しました。`,
    highlights,
    days,
    sourceNote: 'このRECAPは、この端末で記録したARRIVE・DONE・SKIP・現地追加・メモから作成されました。',
    createdAt: iso(createdAt) || new Date().toISOString()
  };
}

export function extractGoogleTimelineVisits(payload, options = {}) {
  const startDate = text(options.startDate, 10);
  const endDate = text(options.endDate, 10);
  const segments = Array.isArray(payload?.semanticSegments) ? payload.semanticSegments : [];
  const seen = new Set();
  return segments.flatMap((segment, index) => {
    const visit = segment?.visit;
    const candidate = visit?.topCandidate;
    if (!visit || !candidate) return [];
    const startTime = iso(segment.startTime);
    const endTime = iso(segment.endTime);
    const date = startTime ? new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(startTime)) : '';
    if ((startDate && date < startDate) || (endDate && date > endDate)) return [];
    const placeId = text(candidate.placeId, 300);
    const latLng = text(candidate.placeLocation?.latLng || candidate.placeLocation?.LatLng, 200);
    const key = `${date}|${placeId || latLng}|${clock(startTime)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      id: `timeline-${index}`,
      date,
      startTime,
      endTime,
      time: clock(startTime),
      title: text(candidate.name || candidate.label, 120) || `Timeline訪問地点 ${seen.size}`,
      mapQuery: placeId ? `place_id:${placeId}` : latLng,
      placeId,
      latLng
    }];
  }).slice(0, 200);
}

