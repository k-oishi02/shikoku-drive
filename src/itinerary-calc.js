import { formatMinute, parseTimeRange } from './trip-v2-core.js';
import { normalizeJourneyRecord } from './journey-v4.js';

function toText(value) {
  return value == null ? '' : String(value);
}

export function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

export function shiftedTime(card, offsetMinutes = 0) {
  const offset = Number(offsetMinutes) || 0;
  const range = parseTimeRange(card?.time);
  if (!range) {
    const rawTime = card?.time || '';
    return {
      time: rawTime,
      label: rawTime,
      start: null,
      end: null
    };
  }
  const start = range.start + offset;
  const end = range.end + offset;
  const formatted = `${formatMinute(start)} - ${formatMinute(end)}`;
  return {
    time: formatted,
    label: formatted,
    start,
    end
  };
}

export function cardMap(trip = {}, journeyState = {}, dayKey = '') {
  const tripCards = trip?.days?.[dayKey] || [];
  const extraCards = journeyState?.days?.[dayKey]?.extraCards || [];
  return new Map([...tripCards, ...extraCards].map(card => [card.cardId, card]));
}

export function buildTimeline(trip = {}, journeyState = {}, dayKey = '') {
  const day = journeyState?.days?.[dayKey] || {
    order: (trip?.days?.[dayKey] || []).map(card => card.cardId),
    status: {},
    delay: { minutes: 0, fromCardId: '' },
    extraCards: []
  };
  const cards = cardMap(trip, journeyState, dayKey);
  let offset = 0;
  let delayStarted = false;
  let previous = null;
  const conflicts = [];
  const baseCards = trip?.days?.[dayKey] || [];
  const suppliedOrder = Array.isArray(day.order) ? day.order : baseCards.map(c => c.cardId);
  const delay = day.delay || { minutes: 0, fromCardId: '' };
  const delayMinutes = Number(delay.minutes) || 0;
  const statusMap = day.status || {};
  const recordsMap = journeyState?.records || {};

  const items = suppliedOrder.map((id, orderIndex) => {
    const card = cards.get(id);
    if (!card) return null;
    if (id === delay.fromCardId) {
      delayStarted = true;
      offset = delayMinutes;
    }
    if (delayStarted && card.timeLocked) {
      offset = 0;
    }
    const time = shiftedTime(card, card.timeLocked ? 0 : offset);
    if (previous?.time?.end != null && time.start != null && previous.time.end > time.start) {
      conflicts.push(`${previous.card.title}と${card.title}が${previous.time.end - time.start}分重なります`);
    }
    const record = normalizeJourneyRecord(recordsMap[id]);
    const status = record.status || statusMap[id] || '';
    const item = { card, time, orderIndex, status, record, dayKey };
    previous = item;
    return item;
  }).filter(Boolean);

  return {
    items,
    timeline: items,
    conflicts
  };
}

export function activeItem(timeline, dateKey, nowTimestamp = new Date()) {
  const items = Array.isArray(timeline) ? timeline : (timeline?.items || timeline?.timeline || []);
  const pending = items.filter(item => !['done', 'skipped'].includes(item.status));
  if (!pending.length) return null;
  const arrived = pending.find(item => item.status === 'arrived');
  if (arrived) return arrived;

  const nowDate = nowTimestamp instanceof Date ? nowTimestamp : (nowTimestamp != null ? new Date(nowTimestamp) : new Date());
  const minute = nowDate.getHours() * 60 + nowDate.getMinutes();
  const todayKey = localDateKey(nowDate);

  if (dateKey === todayKey) {
    return pending.find(item => item.time?.start != null && minute >= item.time.start && minute < item.time.end)
      || pending.find(item => item.time?.start != null && item.time.start > minute)
      || pending[0];
  }
  return pending[0];
}

export function calculateNextAvailableTime(dayCards, travelMinutes = 0, defaultTime = '09:00') {
  const cards = Array.isArray(dayCards) ? dayCards : [];
  if (!cards.length) {
    return defaultTime || '09:00';
  }
  const lastCard = cards[cards.length - 1];
  const range = parseTimeRange(lastCard?.time);
  if (!range) return defaultTime || '09:00';
  const startMinute = range.end + Number(travelMinutes || 0);
  return formatMinute(startMinute);
}

export function parseCardLinks(value) {
  return toText(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const [label = '', url = '', androidUrl = '', iosUrl = '', icon = ''] = line.split('|').map(part => part.trim());
    const link = { label, url };
    if (label === 'ルート') link.kind = 'route';
    if (androidUrl) link.androidUrl = androidUrl;
    if (iosUrl) link.iosUrl = iosUrl;
    if (icon) link.icon = icon;
    return link;
  });
}

export function formatCardLinks(links) {
  return (Array.isArray(links) ? links : [])
    .map(link => [link?.label, link?.url, link?.androidUrl, link?.iosUrl, link?.icon]
      .map(value => toText(value).trim())
      .join(' | ')
      .replace(/(?:\s*\|\s*)+$/, ''))
    .join('\n');
}
