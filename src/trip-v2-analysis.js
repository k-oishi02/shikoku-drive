import { formatMinute, migrateTripToV2, parseTimeRange } from './trip-v2-core.js';

const TRIP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif|svg)$/i;
const LEGACY_FIELDS = new Set([
  'OPTIONAL', 'MOVE', 'ferryLegs', 'fixed', 'rigid', 'lat', 'lon', 'mapCenter',
  'mapZoom', 'wallet', 'id', 'map', 'mapLabel', 'optionalRules', 'detourSuggestions'
]);

function text(value, max = 10000) {
  return String(value ?? '').trim().slice(0, max);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(value, 10))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validHttpsUrl(value) {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch (error) {
    return false;
  }
}

function dayCount(startDate, endDate) {
  if (!validDate(startDate) || !validDate(endDate)) return null;
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
}

function clockMinute(value) {
  if (!/^\d{2}:\d{2}$/.test(text(value, 5))) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

function issue(level, code, message, path = '') {
  return { level, code, message, path };
}

export function analyzeTrip(raw) {
  const trip = migrateTripToV2(raw, raw?.tripId || 'trip');
  const issues = [];
  if (!TRIP_ID_PATTERN.test(trip.tripId)) issues.push(issue('error', 'trip-id', '旅行IDは英小文字・数字・_・-で3〜40文字にしてください。', 'tripId'));
  if (!trip.title) issues.push(issue('error', 'title', '旅行タイトルを入力してください。', 'title'));
  if (!validDate(trip.startDate)) issues.push(issue('error', 'start-date', '開始日を正しい日付で入力してください。', 'startDate'));
  if (!validDate(trip.endDate)) issues.push(issue('error', 'end-date', '終了日を正しい日付で入力してください。', 'endDate'));
  if (validDate(trip.startDate) && validDate(trip.endDate) && trip.startDate > trip.endDate) issues.push(issue('error', 'date-order', '終了日は開始日以降にしてください。'));
  const expectedDays = dayCount(trip.startDate, trip.endDate);
  const actualDays = Object.keys(trip.days).length;
  if (expectedDays && expectedDays !== actualDays) issues.push(issue('warning', 'day-count', `旅行期間は${expectedDays}日ですが、日程は${actualDays}日分です。`));

  Object.entries(trip.days).forEach(([dayKey, cards]) => {
    let previousEnd = null;
    cards.forEach((card, index) => {
      const path = `days.${dayKey}.${index}`;
      const label = `${dayKey.toUpperCase()}「${card.title || `カード${index + 1}`}」`;
      const range = parseTimeRange(card.time);
      if (!range) issues.push(issue('error', 'time', `${label}: 時刻は「09:00 - 10:00」形式で入力してください。`, `${path}.time`));
      if (!card.title) issues.push(issue('error', 'card-title', `${label}: タイトルがありません。`, `${path}.title`));
      if (!card.badge) issues.push(issue('error', 'badge', `${label}: バッジがありません。`, `${path}.badge`));
      if (!card.desc) issues.push(issue('error', 'description', `${label}: 説明がありません。`, `${path}.desc`));
      if (range && previousEnd != null) {
        const gap = range.start - previousEnd;
        if (gap < 0) issues.push(issue('error', 'overlap', `${label}: 前の予定と${Math.abs(gap)}分重複しています。`, path));
        if (card.travelMinutesFromPrevious && gap < card.travelMinutesFromPrevious) {
          issues.push(issue('warning', 'travel-buffer', `${label}: 空き時間${Math.max(0, gap)}分に対し、設定した移動時間は${card.travelMinutesFromPrevious}分です。`, path));
        }
      }
      if (range) previousEnd = Math.max(previousEnd ?? 0, range.end);

      const constraints = card.constraints || {};
      if (range) {
        const opensAt = clockMinute(constraints.opensAt);
        const closesAt = clockMinute(constraints.closesAt);
        const reservationAt = clockMinute(constraints.reservationAt);
        const lastEntryAt = clockMinute(constraints.lastEntryAt);
        const departureBy = clockMinute(constraints.departureBy);
        if (opensAt != null && range.start < opensAt) issues.push(issue('warning', 'before-open', `${label}: 開店${constraints.opensAt}より前に始まっています。`, path));
        if (closesAt != null && range.end > closesAt) issues.push(issue('warning', 'after-close', `${label}: 閉店${constraints.closesAt}を過ぎています。`, path));
        if (reservationAt != null && range.start > reservationAt) issues.push(issue('warning', 'reservation-late', `${label}: 予約${constraints.reservationAt}より後に始まっています。`, path));
        if (lastEntryAt != null && range.start > lastEntryAt) issues.push(issue('warning', 'last-entry', `${label}: 最終入場${constraints.lastEntryAt}より後に始まっています。`, path));
        if (departureBy != null && range.end > departureBy) issues.push(issue('warning', 'departure-deadline', `${label}: 出発期限${constraints.departureBy}を過ぎています。`, path));
      }
      if (index === 0 && !/出発|\d{1,2}:\d{2}.*発/.test(card.desc) && !['FLIGHT', 'AIRPORT'].includes(card.badge)) {
        issues.push(issue('info', 'first-departure', `${label}: その日の出発時刻が分かると、旅行中に迷いにくくなります。`, path));
      }
      if (/空港/.test(card.title) && card.badge === 'FLIGHT' && !/(便|から.+へ)/.test(card.desc)) {
        issues.push(issue('warning', 'airport-badge', `${label}: 空港滞在ならAIRPORT、搭乗区間ならFLIGHTが自然です。`, `${path}.badge`));
      }
      if (/タクシー|TAXI/i.test(`${card.title} ${card.desc}`)) issues.push(issue('error', 'taxi', `${label}: タクシー利用が残っています。`, path));
      if (/へ移動$|移動のみ/.test(card.title)) issues.push(issue('warning', 'move-card', `${label}: 移動専用カードは目的地カードへ統合してください。`, path));
      if (/レンタカー/.test(`${card.title} ${card.desc}`) && /フェリー.*(載|乗せ)|車両航送/.test(card.desc)) issues.push(issue('error', 'car-ferry', `${label}: レンタカーをフェリーへ載せる記述があります。`, path));
      if (card.image && !IMAGE_PATTERN.test(card.image)) issues.push(issue('error', 'image', `${label}: 画像ファイル名が不正です。`, `${path}.image`));
      ['official', 'tabelog', 'jalan'].forEach(key => {
        if (!validHttpsUrl(card[key])) issues.push(issue('error', 'url', `${label}: ${key}はHTTPS URLにしてください。`, `${path}.${key}`));
      });
      (card.links || []).forEach((link, linkIndex) => {
        if (!link.label || !validHttpsUrl(link.url)) issues.push(issue('error', 'link', `${label}: 追加リンク${linkIndex + 1}が不正です。`, `${path}.links.${linkIndex}`));
      });
      Object.keys(card).filter(key => LEGACY_FIELDS.has(key)).forEach(key => issues.push(issue('error', 'legacy', `${label}: 旧フィールド「${key}」を削除してください。`, `${path}.${key}`)));
    });
  });
  try {
    if (new TextEncoder().encode(JSON.stringify(trip)).length > 900000) issues.push(issue('error', 'size', '旅程データが900,000バイトを超えています。'));
  } catch (error) {
    issues.push(issue('error', 'json', '旅程データをJSONへ変換できません。'));
  }
  return {
    trip,
    issues,
    errors: issues.filter(item => item.level === 'error'),
    warnings: issues.filter(item => item.level === 'warning'),
    info: issues.filter(item => item.level === 'info')
  };
}

function dateForDay(startDate, dayKey) {
  const dayNumber = Number(String(dayKey).slice(3));
  if (!validDate(startDate) || !Number.isInteger(dayNumber) || dayNumber < 1) return '';
  const date = new Date(`${startDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayNumber - 1);
  return date.toISOString().slice(0, 10);
}

export function getTripNowState(raw, now = new Date()) {
  const trip = migrateTripToV2(raw, raw?.tripId || 'trip');
  const timeline = [];
  Object.entries(trip.days).forEach(([dayKey, cards]) => {
    const date = dateForDay(trip.startDate, dayKey);
    cards.forEach((card, index) => {
      const range = parseTimeRange(card.time);
      if (!date || !range) return;
      const start = new Date(`${date}T${formatMinute(range.start)}:00+09:00`);
      const end = new Date(`${date}T${formatMinute(range.end)}:00+09:00`);
      timeline.push({ dayKey, index, card, range, start, end });
    });
  });
  timeline.sort((a, b) => a.start - b.start);
  if (!timeline.length) return { phase: 'empty', current: null, next: null, timeline };
  const current = timeline.find(item => now >= item.start && now < item.end) || null;
  const next = timeline.find(item => item.start > now) || null;
  const phase = now < timeline[0].start ? 'before' : now >= timeline.at(-1).end ? 'complete' : current ? 'current' : 'between';
  const action = current || next || timeline.at(-1);
  const travelMinutes = next?.card.travelMinutesFromPrevious || 0;
  const recommendedDeparture = next ? new Date(next.start.getTime() - travelMinutes * 60000) : null;
  return {
    phase,
    current,
    next,
    action,
    timeline,
    minutesUntilNext: next ? Math.ceil((next.start - now) / 60000) : null,
    recommendedDeparture,
    departureLate: Boolean(recommendedDeparture && now > recommendedDeparture && now < next.start)
  };
}

export function settlementTransfers(members, expenses) {
  const list = Array.isArray(members) ? members : [];
  const ids = list.map(member => text(member?.id || member?.uid, 128)).filter(Boolean);
  const names = new Map(list.map(member => [text(member?.id || member?.uid, 128), text(member?.name || member?.nickname || '参加者', 40)]));
  const balance = new Map(ids.map(id => [id, 0]));
  (Array.isArray(expenses) ? expenses : []).forEach(expense => {
    const amount = Math.max(0, Math.round(Number(expense?.amount) || 0));
    const payer = text(expense?.payer, 128);
    if (!amount || !balance.has(payer)) return;
    const selected = Array.isArray(expense.participantIds)
      ? expense.participantIds.map(id => text(id, 128)).filter(id => balance.has(id))
      : ids;
    if (!selected.length) return;
    balance.set(payer, balance.get(payer) + amount);
    if (expense.splitMode === 'custom' && expense.shares && typeof expense.shares === 'object') {
      selected.forEach(id => balance.set(id, balance.get(id) - Math.max(0, Number(expense.shares[id]) || 0)));
    } else {
      const share = amount / selected.length;
      selected.forEach(id => balance.set(id, balance.get(id) - share));
    }
  });
  const creditors = [...balance].filter(([, value]) => value > 0.5).map(([id, value]) => ({ id, value }));
  const debtors = [...balance].filter(([, value]) => value < -0.5).map(([id, value]) => ({ id, value: -value }));
  const transfers = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = Math.min(debtor.value, creditor.value);
    if (amount >= 0.5) transfers.push({
      from: debtor.id,
      fromName: names.get(debtor.id) || debtor.id,
      to: creditor.id,
      toName: names.get(creditor.id) || creditor.id,
      amount: Math.round(amount)
    });
    debtor.value -= amount;
    creditor.value -= amount;
    if (debtor.value < 0.5) debtorIndex += 1;
    if (creditor.value < 0.5) creditorIndex += 1;
  }
  return transfers;
}
