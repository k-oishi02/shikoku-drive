import { cleanPlanning, migrateTripToV2, validateTripDraft } from './trip-v2-core.js';
import { validateStoredDraftSize } from './draft-validation.js';

export function decodeDraftRecord(data, expectedId) {
  const planningJson = data.planningJson === undefined ? '{}' : data.planningJson;
  const sizeErrors = validateStoredDraftSize({ payloadJson: data.payloadJson, planningJson });
  if (sizeErrors.length) throw new Error(sizeErrors.join('\n'));
  let trip, planning;
  try { trip = JSON.parse(data.payloadJson); } catch { throw new Error('旅程JSONが壊れています。元データを保管して修復してください。'); }
  try { planning = JSON.parse(planningJson); } catch { throw new Error('候補・メモのJSONが壊れています。元データを保管して修復してください。'); }
  if (expectedId && trip?.tripId !== expectedId) throw new Error('下書きの保存先と旅行IDが一致していません。');
  const errors = validateTripDraft(trip, planning);
  if (errors.length) throw new Error(errors.join('\n'));
  return { trip: migrateTripToV2(trip), planning: cleanPlanning(planning) };
}
