import { resolveMapFields } from './map-links.js';
import { validateTripInput, validatePlanningInput, validateStoredDraftSize } from './draft-validation.js';

export const SHIORI_SCHEMA_VERSION = 2;

const DAY_KEY_PATTERN = /^day\d+$/;
const TRIP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const TIME_PATTERN = /^(\d{2}):(\d{2}) - (\d{2}):(\d{2})$/;
const LEGACY_FIELDS = new Set([
  'OPTIONAL', 'MOVE', 'ferryLegs', 'fixed', 'rigid', 'lat', 'lon', 'mapCenter',
  'mapZoom', 'wallet', 'id', 'map', 'mapLabel', 'optionalRules', 'detourSuggestions'
]);

const DEFAULT_THEME = Object.freeze({ mode: 'auto', accent: '#f4d35e' });
const DEFAULT_FEATURES = Object.freeze({ nowMode: true, expenses: true, notifications: false });

function copy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function string(value, max = 10000) {
  return String(value ?? '').trim().slice(0, max);
}

function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

export function parseTimeRange(value) {
  const match = string(value, 32).match(TIME_PATTERN);
  if (!match) return null;
  const [startHour, startMinute, endHour, endMinute] = match.slice(1).map(Number);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null;
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return end > start ? { start, end } : null;
}

export function formatMinute(value) {
  const minute = ((Number(value) % 1440) + 1440) % 1440;
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function cleanUrl(value, { allowAppScheme = false } = {}) {
  const url = string(value, 2000);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return url;
    const blockedSchemes = new Set(['javascript:', 'data:', 'file:', 'blob:', 'about:', 'vbscript:']);
    if (allowAppScheme && !blockedSchemes.has(parsed.protocol) && /^[a-z][a-z0-9+.-]{1,31}:$/.test(parsed.protocol)) return url;
  } catch (error) {
    return '';
  }
  return '';
}

function cleanReservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const reservation = {};
  const fields = { number: 120, name: 120, phone: 40, deadline: 40, note: 240 };
  Object.entries(fields).forEach(([key, max]) => {
    const item = string(value[key], max);
    if (item) reservation[key] = item;
  });
  const url = cleanUrl(value.url);
  if (url) reservation.url = url;
  return Object.keys(reservation).length ? reservation : undefined;
}

function cleanLink(link) {
  if (!link || typeof link !== 'object' || Array.isArray(link)) return null;
  const label = string(link.label, 40);
  const url = cleanUrl(link.webUrl || link.url);
  if (!label || !url) return null;
  const cleaned = { label, url };
  if (link.kind === 'route') cleaned.kind = 'route';
  const androidUrl = cleanUrl(link.androidUrl, { allowAppScheme: true });
  const iosUrl = cleanUrl(link.iosUrl, { allowAppScheme: true });
  const icon = string(link.icon, 60);
  if (androidUrl) cleaned.androidUrl = androidUrl;
  if (iosUrl) cleaned.iosUrl = iosUrl;
  if (icon) cleaned.icon = icon;
  return cleaned;
}

export function cleanCard(card, dayKey = 'day1', index = 0) {
  const source = card && typeof card === 'object' && !Array.isArray(card) ? card : {};
  const cleaned = {};
  ['time', 'badge', 'title', 'desc', 'mapQuery', 'official', 'officialLabel', 'tabelog', 'jalan', 'image'].forEach(key => {
    const max = key === 'desc' ? 240 : key === 'title' ? 120 : key === 'time' ? 17 : 2000;
    const value = string(source[key], max);
    if (value) cleaned[key] = value;
  });
  const existingId = string(source.cardId, 80);
  delete cleaned.mapQuery;
  const mapFields = resolveMapFields(source);
  if (mapFields.mapQuery) cleaned.mapQuery = mapFields.mapQuery;
  if (mapFields.mapUrl) cleaned.mapUrl = mapFields.mapUrl;
  cleaned.cardId = /^[a-z0-9][a-z0-9_-]{5,79}$/i.test(existingId)
    ? existingId
    : `${dayKey}-${String(index + 1).padStart(2, '0')}-${stableHash(`${dayKey}|${cleaned.time}|${cleaned.title}`)}`;
  const links = (Array.isArray(source.links) ? source.links : []).map(cleanLink).filter(Boolean);
  if (links.length) cleaned.links = links;
  if (source.expenseShortcut === true) cleaned.expenseShortcut = true;
  const travelMinutes = integer(source.travelMinutesFromPrevious, 0, 1440);
  if (travelMinutes) cleaned.travelMinutesFromPrevious = travelMinutes;
  const notify = Array.from(new Set((Array.isArray(source.notifyBeforeMinutes) ? source.notifyBeforeMinutes : [])
    .map(value => integer(value, 0, 10080)).filter(value => value != null))).sort((a, b) => b - a);
  if (notify.length) cleaned.notifyBeforeMinutes = notify;
  const reservation = cleanReservation(source.reservation);
  if (reservation) cleaned.reservation = reservation;
  if (source.constraints && typeof source.constraints === 'object' && !Array.isArray(source.constraints)) {
    const constraints = {};
    ['opensAt', 'closesAt', 'reservationAt', 'lastEntryAt', 'departureBy'].forEach(key => {
      const value = string(source.constraints[key], 5);
      if (/^\d{2}:\d{2}$/.test(value)) constraints[key] = value;
    });
    const buffer = integer(source.constraints.arrivalBufferMinutes, 0, 360);
    if (buffer != null) constraints.arrivalBufferMinutes = buffer;
    if (Object.keys(constraints).length) cleaned.constraints = constraints;
  }
  if (source.timeLocked === true) cleaned.timeLocked = true;
  return cleaned;
}

function cleanDaySettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  Object.entries(value).forEach(([dayKey, source]) => {
    if (!DAY_KEY_PATTERN.test(dayKey) || !source || typeof source !== 'object' || Array.isArray(source)) return;
    const item = {};
    const departureTime = string(source.departureTime, 5);
    const note = string(source.note, 160);
    if (/^\d{2}:\d{2}$/.test(departureTime)) item.departureTime = departureTime;
    if (note) item.note = note;
    if (Object.keys(item).length) result[dayKey] = item;
  });
  return result;
}

export function migrateTripToV2(raw, fallbackId = '') {
  const source = copy(raw) || {};
  const trip = {
    schemaVersion: SHIORI_SCHEMA_VERSION,
    tripId: string(source.tripId || fallbackId, 40),
    title: string(source.title || '旅行しおり', 120),
    subtitle: string(source.subtitle, 160),
    catchphrase: string(source.catchphrase, 200),
    startDate: string(source.startDate, 10),
    endDate: string(source.endDate, 10),
    archived: source.archived === true,
    theme: { ...DEFAULT_THEME, ...(source.theme && typeof source.theme === 'object' ? source.theme : {}) },
    features: { ...DEFAULT_FEATURES, ...(source.features && typeof source.features === 'object' ? source.features : {}) },
    dayLabels: {},
    daySettings: cleanDaySettings(source.daySettings),
    days: {},
    weatherLocations: source.weatherLocations && typeof source.weatherLocations === 'object' && !Array.isArray(source.weatherLocations) ? source.weatherLocations : {},
    checklist: Array.isArray(source.checklist) ? source.checklist : []
  };
  trip.theme.mode = ['auto', 'dark', 'light'].includes(trip.theme.mode) ? trip.theme.mode : 'auto';
  trip.theme.accent = /^#[0-9a-f]{6}$/i.test(string(trip.theme.accent, 7)) ? trip.theme.accent : DEFAULT_THEME.accent;
  delete trip.theme.coverImage;
  delete trip.features.offline;
  Object.keys(trip.features).forEach(key => { trip.features[key] = trip.features[key] !== false; });

  const days = source.days && typeof source.days === 'object' && !Array.isArray(source.days) ? source.days : { day1: [] };
  Object.keys(days).filter(key => DAY_KEY_PATTERN.test(key)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))).forEach(dayKey => {
    const cards = Array.isArray(days[dayKey]) ? days[dayKey] : [];
    trip.days[dayKey] = cards.map((card, index) => cleanCard(card, dayKey, index));
    trip.dayLabels[dayKey] = string(source.dayLabels?.[dayKey] || dayKey.toUpperCase(), 80);
  });
  if (!Object.keys(trip.days).length) {
    trip.days.day1 = [];
    trip.dayLabels.day1 = 'DAY 1';
  }
  return trip;
}

export const PLANNING_SCHEMA_VERSION = 3;

const VALID_CATEGORIES = new Set(['gourmet', 'sightseeing', 'hotel', 'transport', 'other']);
const VALID_PRIORITIES = new Set(['high', 'normal', 'low']);
const VALID_STATUSES = new Set(['draft', 'assigned']);

export function cleanCandidate(source, index = 0) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const title = string(source.title, 120);
  if (!title) return null;
  const existingId = string(source.id || source.candidateId, 80);
  const id = /^[a-z0-9][a-z0-9_-]{3,79}$/i.test(existingId)
    ? existingId
    : `cand-${globalThis.crypto.randomUUID()}`;

  const category = VALID_CATEGORIES.has(source.category) ? source.category : 'sightseeing';
  const priority = VALID_PRIORITIES.has(source.priority) ? source.priority : 'normal';
  const status = VALID_STATUSES.has(source.status) ? source.status : 'draft';
  const durationMinutes = integer(source.durationMinutes, 0, 1440) ?? 60;
  const { mapQuery, mapUrl } = resolveMapFields(source);
  const official = cleanUrl(source.official);
  const officialLabel = string(source.officialLabel, 40);
  const tabelog = cleanUrl(source.tabelog);
  const jalan = cleanUrl(source.jalan);
  const notes = string(source.notes, 2000);
  const assignedDay = string(source.assignedDay, 20);
  const assignedCardId = string(source.assignedCardId, 80);
  const createdAt = string(source.createdAt, 40) || new Date().toISOString();
  const updatedAt = string(source.updatedAt, 40) || createdAt;

  const cleaned = {
    id,
    title,
    category,
    priority,
    durationMinutes,
    status,
    createdAt,
    updatedAt
  };

  if (mapQuery) cleaned.mapQuery = mapQuery;
  if (mapUrl) cleaned.mapUrl = mapUrl;
  if (official) cleaned.official = official;
  if (officialLabel) cleaned.officialLabel = officialLabel;
  if (tabelog) cleaned.tabelog = tabelog;
  if (jalan) cleaned.jalan = jalan;
  if (notes) cleaned.notes = notes;
  if (status === 'assigned' || assignedCardId) {
    if (assignedDay) cleaned.assignedDay = assignedDay;
    if (assignedCardId) cleaned.assignedCardId = assignedCardId;
    if (source.placementUndo && typeof source.placementUndo === 'object' && !Array.isArray(source.placementUndo)) cleaned.placementUndo = copy(source.placementUndo);
  }
  if (source.sourceSuggestion && typeof source.sourceSuggestion === 'object' && !Array.isArray(source.sourceSuggestion)) {
    const roomId = string(source.sourceSuggestion.roomId, 160);
    const suggestionId = string(source.sourceSuggestion.suggestionId, 80);
    const adoptedAt = string(source.sourceSuggestion.adoptedAt, 40) || new Date().toISOString();
    if (roomId && suggestionId) {
      cleaned.sourceSuggestion = { roomId, suggestionId, adoptedAt };
    }
  }

  return cleaned;
}

export function cleanPlanning(raw) {
  const source = copy(raw) || {};
  const candidates = Array.isArray(source.candidates)
    ? source.candidates.map((item, index) => cleanCandidate(item, index)).filter(Boolean)
    : [];
  return {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    candidates,
    notes: string(source.notes, 5000),
    lastSavedAt: string(source.lastSavedAt, 40) || new Date().toISOString()
  };
}

export function stripPlanningForPublication(trip) {
  const clean = migrateTripToV2(trip);
  delete clean.planning;
  delete clean.candidates;
  delete clean.planningJson;
  return clean;
}

export function validateTripDraft(trip, planning) {
  const errors = [...validateTripInput(trip), ...validatePlanningInput(planning)];
  if (errors.length) return errors;
  try {
    errors.push(...validateStoredDraftSize({
      payloadJson: JSON.stringify(stripPlanningForPublication(trip)),
      planningJson: JSON.stringify(cleanPlanning(planning))
    }));
    // Also reject oversized raw input before normalization removes legacy fields.
    errors.push(...validateStoredDraftSize({ payloadJson: JSON.stringify(trip), planningJson: JSON.stringify(planning) }));
  } catch {
    errors.push('下書きデータをJSONへ変換できません。');
  }
  return [...new Set(errors)];
}
