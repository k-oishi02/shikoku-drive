import { parseTimeRange, formatMinute } from './trip-v2-core.js';
import { validatePlacement } from './admin-placement.js';
import { reconcileAssignments } from './admin-candidate-state.js';

function strictInteger(value, min, max) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

function parseClockToMinute(value) {
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function clone(val) {
  return structuredClone(val);
}

function cardFingerprint(card) {
  if (!card || typeof card !== 'object') return '';
  return [
    card.title || '',
    card.badge || '',
    card.desc || '',
    card.official || '',
    card.officialLabel || '',
    card.mapQuery || '',
    card.mapUrl || '',
    card.image || ''
  ].join(':::');
}

/**
 * beforeList と afterList のカードを正確に対応付ける (3-pass matching)
 * 1. cardId が一致
 * 2. 同一オブジェクト参照 (===)
 * 3. コンテンツのフィンガープリントが一致（クローン対応）
 */
function matchCardLists(beforeList, afterList) {
  const matchedBefore = new Map(); // afterIndex -> beforeIndex
  const matchedAfter = new Map();  // beforeIndex -> afterIndex
  const usedBefore = new Set();
  const usedAfter = new Set();

  // Pass 1: exact cardId match
  for (let a = 0; a < afterList.length; a++) {
    const aCard = afterList[a];
    if (aCard && typeof aCard.cardId === 'string' && aCard.cardId) {
      for (let b = 0; b < beforeList.length; b++) {
        if (!usedBefore.has(b) && beforeList[b] && beforeList[b].cardId === aCard.cardId) {
          matchedBefore.set(a, b);
          matchedAfter.set(b, a);
          usedBefore.add(b);
          usedAfter.add(a);
          break;
        }
      }
    }
  }

  // Pass 2: exact object reference
  for (let a = 0; a < afterList.length; a++) {
    if (usedAfter.has(a)) continue;
    const aCard = afterList[a];
    if (!aCard) continue;
    for (let b = 0; b < beforeList.length; b++) {
      if (!usedBefore.has(b) && beforeList[b] === aCard) {
        matchedBefore.set(a, b);
        matchedAfter.set(b, a);
        usedBefore.add(b);
        usedAfter.add(a);
        break;
      }
    }
  }

  // Pass 3: content fingerprint match for cloned or ID-less cards
  for (let a = 0; a < afterList.length; a++) {
    if (usedAfter.has(a)) continue;
    const aCard = afterList[a];
    if (!aCard) continue;
    const aFp = cardFingerprint(aCard);
    for (let b = 0; b < beforeList.length; b++) {
      if (!usedBefore.has(b)) {
        const bFp = cardFingerprint(beforeList[b]);
        if (aFp === bFp) {
          matchedBefore.set(a, b);
          matchedAfter.set(b, a);
          usedBefore.add(b);
          usedAfter.add(a);
          break;
        }
      }
    }
  }

  return { matchedBefore, matchedAfter };
}

/**
 * 直前のカードIDが変化したカードの travelMinutesFromPrevious をクリアする
 */
export function cleanTravelTimesOnReorder(beforeCards = [], afterCards = []) {
  const beforeList = Array.isArray(beforeCards) ? beforeCards : [];
  const afterList = Array.isArray(afterCards) ? afterCards : [];
  const { matchedBefore } = matchCardLists(beforeList, afterList);

  for (let i = 0; i < afterList.length; i++) {
    const card = afterList[i];
    if (!card || typeof card !== 'object') continue;

    // 先頭カードは常に直前の移動時間を保持しない
    if (i === 0) {
      delete card.travelMinutesFromPrevious;
      continue;
    }

    const beforeIdx = matchedBefore.get(i);
    if (beforeIdx === undefined) {
      delete card.travelMinutesFromPrevious;
      continue;
    }

    const prevBeforeIdx = beforeIdx > 0 ? (beforeIdx - 1) : null;
    const prevAfterBeforeIdx = matchedBefore.get(i - 1);

    const samePredecessor = prevBeforeIdx !== null && prevAfterBeforeIdx !== undefined && prevBeforeIdx === prevAfterBeforeIdx;

    if (!samePredecessor) {
      delete card.travelMinutesFromPrevious;
    }
  }
}

/**
 * 比較用スナップショットデータの生成
 */
export function compareScheduleChanges(beforeCards = [], afterCards = [], dayKey) {
  if (!dayKey) {
    throw new Error('compareScheduleChanges: dayKey is required');
  }
  const listBefore = Array.isArray(beforeCards) ? beforeCards : [];
  const listAfter = Array.isArray(afterCards) ? afterCards : [];

  const { matchedBefore, matchedAfter } = matchCardLists(listBefore, listAfter);

  const diffs = [];

  listAfter.forEach((afterCard, newIndex) => {
    const beforeIndex = matchedBefore.get(newIndex);
    const id = (afterCard && afterCard.cardId) || (beforeIndex !== undefined ? `card-${beforeIndex}` : `new-${newIndex}`);

    if (beforeIndex === undefined) {
      diffs.push({
        type: 'added',
        cardId: id,
        title: (afterCard && afterCard.title) || '無題',
        afterIndex: newIndex,
        beforeTime: null,
        afterTime: afterCard ? afterCard.time : undefined,
        timeLocked: Boolean(afterCard && afterCard.timeLocked)
      });
    } else {
      const beforeCard = listBefore[beforeIndex];
      const timeChanged = beforeCard.time !== afterCard.time;
      const orderChanged = beforeIndex !== newIndex;
      const lockChanged = beforeCard.timeLocked !== afterCard.timeLocked;
      const travelChanged = beforeCard.travelMinutesFromPrevious !== afterCard.travelMinutesFromPrevious;
      const titleChanged = beforeCard.title !== afterCard.title;

      if (timeChanged || orderChanged || lockChanged || travelChanged || titleChanged) {
        diffs.push({
          type: 'modified',
          cardId: id,
          title: (afterCard && afterCard.title) || '無題',
          beforeIndex,
          afterIndex: newIndex,
          beforeTime: beforeCard.time,
          afterTime: afterCard.time,
          timeChanged,
          orderChanged,
          lockChanged,
          travelChanged,
          titleChanged,
          timeLocked: afterCard.timeLocked === true
        });
      } else {
        diffs.push({
          type: 'unchanged',
          cardId: id,
          title: (afterCard && afterCard.title) || '無題',
          index: newIndex,
          time: afterCard.time,
          timeLocked: afterCard.timeLocked === true
        });
      }
    }
  });

  listBefore.forEach((beforeCard, oldIndex) => {
    if (!matchedAfter.has(oldIndex)) {
      const id = (beforeCard && beforeCard.cardId) || `card-${oldIndex}`;
      diffs.push({
        type: 'removed',
        cardId: id,
        title: (beforeCard && beforeCard.title) || '無題',
        beforeIndex: oldIndex,
        beforeTime: beforeCard.time,
        timeLocked: beforeCard.timeLocked === true
      });
    }
  });

  return { dayKey, diffs, totalBefore: listBefore.length, totalAfter: listAfter.length };
}

/**
 * 同一日のカード並べ替え変更案の生成
 */
export function planCardReorder(dayCards = [], fromIndex, toIndex, options = {}) {
  const dayKey = options.dayKey || 'day1';
  const errors = [];
  const warnings = [];
  const list = Array.isArray(dayCards) ? clone(dayCards) : [];

  if (!Array.isArray(dayCards)) errors.push('カード一覧が不正です。');
  if (fromIndex < 0 || fromIndex >= list.length) errors.push('移動元のカードが見つかりません。');
  if (toIndex < 0 || toIndex >= list.length) errors.push('移動先の位置が不正です。');

  if (errors.length > 0) {
    return { errors, warnings, updatedCards: list, diff: null, dayKey };
  }

  let movedCard = null;
  if (fromIndex !== toIndex) {
    [movedCard] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, movedCard);

    // 直前カードIDが変化したカードの古い移動時間を正確にクリア
    cleanTravelTimesOnReorder(dayCards, list);

    // 移動したカードの注意
    warnings.push(`「${movedCard.title || 'カード'}」の位置が変更されました。前後の移動時間をGoogle Mapsで再確認してください。`);

    // 時刻ロックされたカードのチェック
    if (movedCard.timeLocked) {
      warnings.push(`「${movedCard.title || 'カード'}」は固定予定（timeLocked）です。`);
    }

    // 自動カスケード調整が有効な場合
    if (options.autoAdjustCascade && toIndex >= 0) {
      if (movedCard.timeLocked) {
        errors.push(`「${movedCard.title}」は固定予定（timeLocked）のため、自動時間調整は行えません。`);
        const diff = compareScheduleChanges(dayCards, list, dayKey);
        return { errors, warnings, updatedCards: list, diff, dayKey, canAutoAdjust: false };
      }

      const prev = toIndex > 0 ? list[toIndex - 1] : null;
      const prevRange = prev ? parseTimeRange(prev.time) : null;
      const movedRange = parseTimeRange(movedCard.time);
      const duration = movedRange ? movedRange.end - movedRange.start : 60;

      let newStart = 540; // 09:00 default
      if (prevRange) {
        newStart = prevRange.end;
      }
      const cascadeRes = planCascadeTimeAdjustment(list, toIndex, formatMinute(newStart), duration, { dayKey });
      // 操作前の元配列 dayCards と最終結果 cascadeRes.updatedCards を比較して差分を再生成
      const reorderDiff = compareScheduleChanges(dayCards, cascadeRes.updatedCards, dayKey);
      const combinedWarnings = Array.from(new Set([...warnings, ...(cascadeRes.warnings || [])]));
      return {
        errors: cascadeRes.errors,
        warnings: combinedWarnings,
        updatedCards: cascadeRes.updatedCards,
        diff: reorderDiff,
        dayKey,
        canAutoAdjust: false
      };
    }
  }

  // 時間整合性のチェック
  const ranges = list.map(c => parseTimeRange(c.time));
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (!range) continue;
    if (i > 0) {
      const prevRange = ranges[i - 1];
      if (prevRange) {
        const gap = range.start - prevRange.end;
        if (gap < 0) {
          errors.push(`「${list[i - 1].title}」と「${list[i].title}」の時間が${Math.abs(gap)}分重複しています（順序逆転または重複）。`);
        } else {
          const travel = Number(list[i].travelMinutesFromPrevious) || 0;
          if (travel > 0 && gap < travel) {
            warnings.push(`「${list[i].title}」の設定移動時間(${travel}分)に対し、空き時間は${gap}分しかありません。`);
          }
        }
      }
    }
  }

  const diff = compareScheduleChanges(dayCards, list, dayKey);
  return { errors, warnings, updatedCards: list, diff, dayKey, canAutoAdjust: errors.length > 0 && !(movedCard?.timeLocked) };
}

/**
 * 後続時刻調整案の生成（カスケード時間シフト）
 */
export function planCascadeTimeAdjustment(dayCards = [], targetIndex, newStartTimeStr, newDurationMinutes, options = {}) {
  const dayKey = options.dayKey || 'day1';
  const errors = [];
  const warnings = [];
  const list = Array.isArray(dayCards) ? clone(dayCards) : [];

  if (!Array.isArray(dayCards)) errors.push('カード一覧が不正です。');
  if (targetIndex < 0 || targetIndex >= list.length) errors.push('対象カードが見つかりません。');

  const startMinute = parseClockToMinute(newStartTimeStr);
  if (startMinute === null) errors.push('開始時刻を正しい形式(HH:mm)で指定してください。');
  const duration = strictInteger(newDurationMinutes, 1, 1440);
  if (duration === null) errors.push('滞在時間を1〜1440分で指定してください。');

  if (errors.length > 0) {
    return { errors, warnings, updatedCards: list, diff: null, dayKey };
  }

  const targetCard = list[targetIndex];

  // 直前のカードとの重複チェック
  if (targetIndex > 0) {
    const prevCard = list[targetIndex - 1];
    const prevRange = parseTimeRange(prevCard.time);
    if (prevRange) {
      if (startMinute < prevRange.end) {
        errors.push(`直前の「${prevCard.title}」(${prevCard.time})と開始時刻が重複しています（${prevRange.end - startMinute}分重複）。`);
      } else {
        const gap = startMinute - prevRange.end;
        const travel = Number(targetCard.travelMinutesFromPrevious) || 0;
        if (travel > 0 && gap < travel) {
          warnings.push(`直前からの移動時間(${travel}分)に対し、空き時間は${gap}分しかありません。`);
        }
      }
    }
  }

  if (targetCard.timeLocked) {
    warnings.push(`「${targetCard.title}」は固定予定（timeLocked）です。手動設定が適用されます。`);
  }

  // 起点カードの時刻設定 (24:00=1440分ちょうどおよびそれ以上は日跨ぎエラー)
  const targetEndMinute = startMinute + duration;
  if (targetEndMinute >= 1440) {
    errors.push(`「${targetCard.title}」の終了時刻が24:00以降になります。日跨ぎはできません。`);
  }
  targetCard.time = `${formatMinute(startMinute)} - ${formatMinute(targetEndMinute >= 1440 ? 1439 : targetEndMinute)}`;

  let currentEnd = targetEndMinute;

  // 後続カードの時刻を順次シフト
  for (let i = targetIndex + 1; i < list.length; i++) {
    const card = list[i];
    const currentRange = parseTimeRange(card.time);
    const cardDuration = currentRange ? currentRange.end - currentRange.start : 60;
    const travel = Number(card.travelMinutesFromPrevious) || 0;

    const proposedStart = currentEnd + travel;
    const proposedEnd = proposedStart + cardDuration;

    if (card.timeLocked) {
      // 固定カードに到達した場合、その固定予定は動かさず、固定予定以降の自動変更を安全に停止
      if (currentRange) {
        if (currentRange.start < currentEnd) {
          errors.push(`固定予定「${card.title}」(${card.time})の開始前に直前の予定が終わりません（${currentEnd - currentRange.start}分衝突）。`);
        } else {
          const actualGap = currentRange.start - currentEnd;
          if (travel > 0 && actualGap < travel) {
            warnings.push(`固定予定「${card.title}」までの移動時間(${travel}分)に対し、空き時間は${actualGap}分しかありません。`);
          }
        }
      }
      warnings.push(`固定予定「${card.title}」に到達したため、これ以降の予定の自動調整を停止しました。`);
      break; // 固定予定以降の変更を停止
    }

    if (proposedEnd >= 1440) {
      errors.push(`後続の「${card.title}」の終了時刻が24:00以降になります。日跨ぎはできません。`);
      break;
    }

    card.time = `${formatMinute(proposedStart)} - ${formatMinute(proposedEnd)}`;
    currentEnd = proposedEnd;
  }

  const diff = compareScheduleChanges(dayCards, list, dayKey);
  return { errors, warnings, updatedCards: list, diff, dayKey };
}

/**
 * 別日移動変更案の生成
 */
export function planCardMoveDay(trip, fromDayKey, fromIndex, toDayKey, toPosition, placementParams = {}) {
  const errors = [];
  const warnings = [];

  if (!fromDayKey || !toDayKey) {
    return { errors: ['移動元または移動先の日が指定されていません。'], warnings: [], updatedTrip: trip, diff: null };
  }

  if (!trip || typeof trip !== 'object' || !trip.days) {
    return { errors: ['旅行データが不正です。'], warnings: [], updatedTrip: trip, diff: null };
  }

  const newTrip = clone(trip);
  const fromCards = newTrip.days[fromDayKey];
  const toCards = newTrip.days[toDayKey];

  if (!Array.isArray(fromCards) || fromIndex < 0 || fromIndex >= fromCards.length) {
    errors.push('移動元のカードが見つかりません。');
  }
  if (!Array.isArray(toCards)) {
    errors.push('移動先の日が見つかりません。');
  }

  if (errors.length > 0) {
    return { errors, warnings, updatedTrip: trip, diff: null };
  }

  const movedCard = fromCards[fromIndex];
  if (!movedCard) {
    return { errors: ['移動元のカードが見つかりません。'], warnings, updatedTrip: trip, diff: null };
  }

  // 固定予定（timeLocked）の保護
  if (movedCard.timeLocked === true && !placementParams.allowTimeLockedMove) {
    errors.push(`「${movedCard.title || 'カード'}」は固定予定（timeLocked）です。別日へ移動するには固定を解除するか移動を許可してください。`);
  }

  // 移動元からカードを除去
  fromCards.splice(fromIndex, 1);

  // 移動元の後続カードの移動時間をクリア（前スポットが変わったため）
  if (fromCards[fromIndex]) {
    delete fromCards[fromIndex].travelMinutesFromPrevious;
  }

  // 移動先での配置検証
  const { startTime, durationMinutes, travelMinutes } = placementParams;
  const placementRes = validatePlacement({
    cards: toCards,
    position: toPosition,
    startTime: startTime || '09:00',
    durationMinutes: durationMinutes || 60,
    travelMinutes: travelMinutes || 0
  });

  if (placementRes.errors.length > 0) {
    errors.push(...placementRes.errors);
  }
  if (placementRes.warnings.length > 0) {
    warnings.push(...placementRes.warnings);
  }

  if (errors.length === 0) {
    const updatedMovedCard = {
      ...movedCard,
      time: placementRes.time,
      travelMinutesFromPrevious: placementRes.insertIndex > 0 ? (strictInteger(travelMinutes, 0, 1440) || undefined) : undefined
    };
    toCards.splice(placementRes.insertIndex, 0, updatedMovedCard);

    // 移動先で挿入位置の後続カードの移動時間をクリア
    if (toCards[placementRes.insertIndex + 1]) {
      delete toCards[placementRes.insertIndex + 1].travelMinutesFromPrevious;
    }
  }

  // 移動元・移動先の移動時間再確認警告
  warnings.push(`${fromDayKey.toUpperCase()}の移動元、および${toDayKey.toUpperCase()}の移動先の移動時間をGoogle Mapsで再確認してください。`);

  const fromDiff = compareScheduleChanges(trip.days[fromDayKey], newTrip.days[fromDayKey], fromDayKey);
  const toDiff = compareScheduleChanges(trip.days[toDayKey], newTrip.days[toDayKey], toDayKey);

  return {
    errors,
    warnings,
    updatedTrip: errors.length === 0 ? newTrip : trip,
    fromDayKey,
    toDayKey,
    fromDiff,
    toDiff,
    movedCardId: movedCard.cardId
  };
}

/**
 * 変更案の適用（計画を確定して整合性を同期）
 * @param {Object} params
 * @param {Object} params.currentTrip 現在の旅程データ（最新の編集内容を含む）
 * @param {Object} params.currentPlanning 現在の企画・候補データ
 * @param {Object} params.planResult 適用する計画案（updatedTripまたはupdatedCardsを含む）
 * @param {Object} [params.expectedBaseTrip] 計画作成時のベース旅程データ（競合検出用）
 * @param {string} [params.dayKey] 対象日（planResultがupdatedCardsを返す場合に使用）
 */
export function applyDayPlan({ currentTrip, currentPlanning, planResult, expectedBaseTrip, dayKey }) {
  if (!currentTrip || !planResult) {
    return { error: '適用対象の旅程または計画案がありません。', trip: currentTrip, planning: currentPlanning };
  }

  // エラー付き変更案の適用を拒否
  if (planResult.errors && planResult.errors.length > 0) {
    return { error: `エラーのある変更案は適用できません: ${planResult.errors.join(' ')}`, trip: currentTrip, planning: currentPlanning };
  }

  // 旅行IDの一致確認
  if (expectedBaseTrip && expectedBaseTrip.tripId && expectedBaseTrip.tripId !== currentTrip.tripId) {
    return { error: '別の旅行に対する変更案のため適用できません。', trip: currentTrip, planning: currentPlanning };
  }

  const newTrip = clone(currentTrip);
  newTrip.days ||= {};
  const affectedDaysSet = new Set();
  const updatedDaysMap = {};

  if (planResult.fromDayKey && planResult.toDayKey && planResult.updatedTrip?.days) {
    affectedDaysSet.add(planResult.fromDayKey);
    affectedDaysSet.add(planResult.toDayKey);
    updatedDaysMap[planResult.fromDayKey] = planResult.updatedTrip.days[planResult.fromDayKey];
    updatedDaysMap[planResult.toDayKey] = planResult.updatedTrip.days[planResult.toDayKey];
  } else if (planResult.dayKey) {
    const dk = planResult.dayKey;
    affectedDaysSet.add(dk);
    if (planResult.updatedTrip?.days?.[dk]) {
      updatedDaysMap[dk] = planResult.updatedTrip.days[dk];
    } else if (Array.isArray(planResult.updatedCards)) {
      updatedDaysMap[dk] = planResult.updatedCards;
    }
  } else if (dayKey) {
    affectedDaysSet.add(dayKey);
    if (planResult.updatedTrip?.days?.[dayKey]) {
      updatedDaysMap[dayKey] = planResult.updatedTrip.days[dayKey];
    } else if (Array.isArray(planResult.updatedCards)) {
      updatedDaysMap[dayKey] = planResult.updatedCards;
    }
  } else {
    return { error: '変更対象の日が特定できません。', trip: currentTrip, planning: currentPlanning };
  }

  const affectedDays = Array.from(affectedDaysSet);

  // 競合チェック: expectedBaseTripが与えられている場合、対象日の変更前が一致しているか確認
  if (expectedBaseTrip && expectedBaseTrip.days) {
    for (const dk of affectedDays) {
      if (JSON.stringify(currentTrip.days?.[dk] || []) !== JSON.stringify(expectedBaseTrip.days?.[dk] || [])) {
        return {
          error: `変更案作成後に${dk.toUpperCase()}の日程が編集されたため、適用できません。変更案を再度作成してください。`,
          trip: currentTrip,
          planning: currentPlanning
        };
      }
    }
  }

  // 対象日のカード配列のみを安全に反映（旅行タイトルや他日程の最新編集を保持）
  affectedDays.forEach(dk => {
    if (updatedDaysMap[dk]) {
      newTrip.days[dk] = clone(updatedDaysMap[dk]);
    }
  });

  // 取り消し用スナップショットの生成（旅行IDと適用結果も記録）
  const undoSnapshot = {
    tripId: currentTrip.tripId,
    affectedDays,
    previousDays: Object.fromEntries(affectedDays.map(dk => [dk, clone(currentTrip.days?.[dk] || [])])),
    appliedDays: Object.fromEntries(affectedDays.map(dk => [dk, clone(newTrip.days?.[dk] || [])]))
  };

  const newPlanning = reconcileAssignments(newTrip, currentPlanning);
  return { error: '', trip: newTrip, planning: newPlanning, undoSnapshot };
}

/**
 * 適用した日程変更の取り消し（Undo）
 */
export function undoDayPlan({ currentTrip, currentPlanning, undoSnapshot }) {
  if (!currentTrip || !undoSnapshot || !undoSnapshot.previousDays) {
    return { error: '取り消す変更履歴がありません。', trip: currentTrip, planning: currentPlanning };
  }

  // 別旅行の履歴照合
  if (undoSnapshot.tripId && undoSnapshot.tripId !== currentTrip.tripId) {
    return { error: '別旅行の変更履歴のため取り消しできません。', trip: currentTrip, planning: currentPlanning };
  }

  // 適用後の状態照合（Undo対象日がさらに編集されていたら競合エラー）
  if (undoSnapshot.appliedDays) {
    for (const dk of undoSnapshot.affectedDays || []) {
      if (JSON.stringify(currentTrip.days?.[dk] || []) !== JSON.stringify(undoSnapshot.appliedDays[dk])) {
        return {
          error: `適用後に${dk.toUpperCase()}の日程が編集されているため、直前の変更を取り消せません。`,
          trip: currentTrip,
          planning: currentPlanning
        };
      }
    }
  }

  const restoredTrip = clone(currentTrip);
  restoredTrip.days ||= {};
  Object.entries(undoSnapshot.previousDays).forEach(([dk, cards]) => {
    restoredTrip.days[dk] = clone(cards);
  });

  // planningは最新のcurrentPlanning（新メモや新候補）を保持し、割当状態のみ再同期
  const restoredPlanning = reconcileAssignments(restoredTrip, currentPlanning);

  return { error: '', trip: restoredTrip, planning: restoredPlanning };
}
