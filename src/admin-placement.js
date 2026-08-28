import { parseTimeRange, formatMinute } from './trip-v2-core.js';

function strictInteger(value, min, max) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

// Shared by preview and confirmation. Never mutates the supplied schedule.
export function validatePlacement(params = {}) {
  const { cards, position, startTime, durationMinutes, travelMinutes } = params && typeof params === 'object' ? params : {};
  const errors = [];
  const warnings = [];
  const list = Array.isArray(cards) ? cards : [];
  if (!Array.isArray(cards)) errors.push('既存カードの一覧が不正です。');
  const insertIndex = position === 'start' ? 0 : position === 'end' ? list.length : strictInteger(position, 0, list.length);
  if (insertIndex === null) errors.push('挿入位置を選び直してください。');
  const match = typeof startTime === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.exec(startTime);
  const start = match ? Number(match[1]) * 60 + Number(match[2]) : null;
  if (start === null) errors.push('開始時刻を00:00〜23:59で入力してください。');
  const duration = strictInteger(durationMinutes, 1, 1440);
  const travel = strictInteger(travelMinutes, 0, 1440);
  if (duration === null) errors.push('滞在時間は1〜1440分の整数で入力してください。');
  if (travel === null) errors.push('移動時間を確認し、0〜1440分の整数で入力してください。');
  const end = start !== null && duration !== null ? start + duration : null;
  if (end !== null && end >= 1440) errors.push('終了が24:00以降になる配置には対応していません。時刻を調整してください。');
  const ranges = Array.from(list, card => typeof card?.time === 'string' ? parseTimeRange(card.time) : null);
  if (ranges.some(range => !range)) errors.push('既存カードの時刻が未定または不正です。配置前に確認してください。');
  if (start !== null && end !== null && end < 1440) {
    ranges.forEach((range, index) => {
      if (range && Math.max(start, range.start) < Math.min(end, range.end)) {
        errors.push(`「${list[index].title || '既存の予定'}」と時間が重複しています。`);
      }
    });
  }
  const prevCard = insertIndex !== null && insertIndex > 0 ? list[insertIndex - 1] ?? null : null;
  const nextCard = insertIndex !== null ? list[insertIndex] ?? null : null;
  const prevRange = insertIndex !== null ? ranges[insertIndex - 1] : null;
  const nextRange = insertIndex !== null ? ranges[insertIndex] : null;
  if (prevRange && start !== null) {
    const gap = start - prevRange.end;
    if (gap < 0) errors.push('前の予定の終了より前に開始する配置はできません。');
    else if (travel !== null && gap < travel) warnings.push(`移動${travel}分に対し、前の予定からの空き時間は${gap}分しかありません。`);
  }
  if (nextRange && end !== null && end > nextRange.start) errors.push('次の予定の開始より後に終了する配置はできません。');
  if (nextCard) warnings.push('次の場所への移動時間は未確認です。Google Mapsで確認してください。');
  const time = errors.length === 0 ? `${formatMinute(start)} - ${formatMinute(end)}` : '';
  return { errors, warnings, insertIndex, start, end, time, prevCard, nextCard };
}
