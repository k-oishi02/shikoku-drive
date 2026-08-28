import { stripPlanningForPublication } from './trip-v2-core.js';
import { validateTripInput } from './draft-validation.js';
import { decodeDraftRecord } from './admin-draft-record.js';

function validateTripObject(trip, errorLabel = '旅程データ') {
  if (!trip || typeof trip !== 'object' || Array.isArray(trip)) {
    throw new Error(`${errorLabel}はオブジェクトである必要があります。`);
  }
  if (typeof trip.tripId !== 'string' || trip.tripId.trim() === '') {
    throw new Error(`${errorLabel}に有効な tripId が含まれていません。`);
  }
}

function validatePlanningObject(planning, errorLabel = '計画データ') {
  if (!planning || typeof planning !== 'object' || Array.isArray(planning)) {
    throw new Error(`${errorLabel}はオブジェクトである必要があります。`);
  }
  if (!Array.isArray(planning.candidates)) {
    throw new Error(`${errorLabel}の候補一覧（candidates）は配列である必要があります。`);
  }
  if (typeof planning.notes !== 'string') {
    throw new Error(`${errorLabel}のメモ（notes）は文字列である必要があります。`);
  }
  for (let i = 0; i < planning.candidates.length; i++) {
    const c = planning.candidates[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error(`${errorLabel}の候補[${i}]が不正な形式です（オブジェクトが必要です）。`);
    }
  }
}

export function buildTripExport(trip) {
  validateTripObject(trip, '旅程データ');
  const errors = validateTripInput(trip);
  if (errors.length) throw new Error(errors.join('\n'));
  return stripPlanningForPublication(trip);
}

export function buildAdminBackup(trip, planning) {
  validateTripObject(trip, '旅程データ');
  validatePlanningObject(planning, '計画データ');
  return {
    format: 'shiori-admin-backup',
    version: 1,
    trip: buildTripExport(trip),
    planning: structuredClone(planning)
  };
}

export function parseTripImport(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('JSONの解析に失敗しました。正しいJSON形式を指定してください。');
    }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('インポートデータはオブジェクトである必要があります。');
  }

  if (data.format === 'shiori-draft-recovery') {
    if (data.version !== 1) throw new Error('未対応の修復ファイル形式です。');
    validateTripObject({ tripId: data.tripId });
    return { ...decodeDraftRecord(data, data.tripId), kind: 'admin-backup' };
  }
  if (data.format !== undefined || data.version !== undefined) {
    if (data.format !== 'shiori-admin-backup') {
      throw new Error('未知のバックアップ形式です。');
    }
    if (data.version !== 1) {
      throw new Error('サポートされていないバックアップバージョンです（version 1 のみ対応）。');
    }
    validateTripObject(data.trip, 'バックアップ内の旅程データ');
    if (
      data.trip.planning !== undefined ||
      data.trip.candidates !== undefined ||
      data.trip.planningJson !== undefined
    ) {
      throw new Error('バックアップ内の旅程データに非公開の計画フィールドが含まれています。');
    }
    validatePlanningObject(data.planning, 'バックアップ内の計画データ');

    return {
      trip: structuredClone(data.trip),
      planning: structuredClone(data.planning),
      kind: 'admin-backup'
    };
  }

  validateTripObject(data, '旅程データ');

  if (data.planning !== undefined) {
    if (data.candidates !== undefined || data.planningJson !== undefined) {
      throw new Error('形式が曖昧な計画データが含まれているためインポートできません。');
    }
    validatePlanningObject(data.planning, 'レガシー計画データ');
    const tripCopy = structuredClone(data);
    delete tripCopy.planning;
    return {
      trip: tripCopy,
      planning: structuredClone(data.planning),
      kind: 'legacy-admin-backup'
    };
  }

  if (data.candidates !== undefined || data.planningJson !== undefined) {
    throw new Error('形式が曖昧な計画データが含まれているためインポートできません。');
  }

  return {
    trip: structuredClone(data),
    planning: null,
    kind: 'participant'
  };
}
