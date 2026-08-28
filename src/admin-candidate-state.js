function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  return value;
}

export function reconcileAssignments(trip, planning) {
  if (!planning || typeof planning !== 'object' || !Array.isArray(planning.candidates)) {
    return planning ? structuredClone(planning) : planning;
  }
  const resultPlanning = structuredClone(planning);
  if (!trip?.days || typeof trip.days !== 'object' || Array.isArray(trip.days) || Object.values(trip.days).some(cards => !Array.isArray(cards))) return resultPlanning;
  const days = trip?.days && typeof trip.days === 'object' ? trip.days : {};

  const cardMap = new Map();
  for (const [dayKey, cardList] of Object.entries(days)) {
    if (!Array.isArray(cardList)) continue;
    for (let i = 0; i < cardList.length; i++) {
      const card = cardList[i];
      if (!card || !card.cardId) continue;
      const list = cardMap.get(card.cardId) || [];
      list.push({ dayKey, index: i, card });
      cardMap.set(card.cardId, list);
    }
  }

  const refCountMap = new Map();
  for (const c of resultPlanning.candidates) {
    if (c && c.assignedCardId) {
      refCountMap.set(c.assignedCardId, (refCountMap.get(c.assignedCardId) || 0) + 1);
    }
  }

  for (const c of resultPlanning.candidates) {
    if (!c || typeof c !== 'object') continue;
    if (!c.assignedCardId) continue;

    const cardOccurrences = cardMap.get(c.assignedCardId) || [];
    const refCount = refCountMap.get(c.assignedCardId) || 0;

    if (cardOccurrences.length === 1 && refCount === 1) {
      c.status = 'assigned';
      c.assignedDay = cardOccurrences[0].dayKey;
    } else if (cardOccurrences.length === 0) {
      c.status = 'draft';
      delete c.assignedDay;
      delete c.assignedCardId;
      delete c.placementUndo;
    } else {
      // An ambiguous existing link must not allow another adoption.
      c.status = 'assigned';
    }
  }

  return resultPlanning;
}

export function inspectAssignment(trip, planning, candidateId) {
  if (!candidateId || typeof candidateId !== 'string') {
    return { error: '候補IDが指定されていません。' };
  }
  if (!planning || typeof planning !== 'object' || !Array.isArray(planning.candidates)) {
    return { error: '候補データが不正です。' };
  }
  if (!trip || typeof trip !== 'object' || !trip.days || typeof trip.days !== 'object') {
    return { error: '旅行データが不正です。' };
  }

  const matchingCandidates = planning.candidates.filter(c => c && c.id === candidateId);
  if (matchingCandidates.length === 0) {
    return { error: '指定された候補が見つかりません。' };
  }
  if (matchingCandidates.length > 1) {
    return { error: '候補IDが重複しています。' };
  }

  const candidate = matchingCandidates[0];
  if (!candidate.assignedCardId) {
    return { error: '候補に配置カードIDが設定されていません。' };
  }

  const sameRefCandidates = planning.candidates.filter(c => c && c.assignedCardId === candidate.assignedCardId);
  if (sameRefCandidates.length > 1) {
    return { error: '複数の候補が同一のカードを参照しています。' };
  }

  const matchingCards = [];
  for (const [dayKey, cardList] of Object.entries(trip.days)) {
    if (!Array.isArray(cardList)) continue;
    for (let i = 0; i < cardList.length; i++) {
      const card = cardList[i];
      if (card && card.cardId === candidate.assignedCardId) {
        matchingCards.push({ dayKey, index: i, card });
      }
    }
  }

  if (matchingCards.length === 0) {
    return { error: '配置先のカードが見つかりません。' };
  }
  if (matchingCards.length > 1) {
    return { error: '配置カードIDが重複しています。' };
  }

  const { dayKey, index, card } = matchingCards[0];
  return { error: '', dayKey, index, card, candidate };
}

export function unassignCandidate(trip, planning, candidateId) {
  const inspected = inspectAssignment(trip, planning, candidateId);
  if (inspected.error) {
    return { error: inspected.error, trip, planning, warnings: [] };
  }

  const { dayKey, index, candidate } = inspected;
  const newTrip = structuredClone(trip);
  const newPlanning = structuredClone(planning);
  const warnings = [];

  const dayCards = newTrip.days[dayKey];
  const prevCard = index > 0 ? dayCards[index - 1] : null;
  const nextCard = index + 1 < dayCards.length ? dayCards[index + 1] : null;

  const prevCardId = prevCard ? prevCard.cardId : null;
  const nextCardId = nextCard ? nextCard.cardId : null;

  if (nextCard !== null) {
    const undo = candidate.placementUndo;
    if (undo && typeof undo === 'object') {
      const canRestore =
        undo.nextBefore && typeof undo.nextBefore === 'object' && !Array.isArray(undo.nextBefore) &&
        undo.nextBefore.cardId === nextCardId && typeof nextCardId === 'string' && nextCardId.length > 0 &&
        (!prevCard || (typeof prevCardId === 'string' && prevCardId.length > 0)) &&
        (!Object.hasOwn(undo.nextBefore, 'travelMinutesFromPrevious') || (Number.isInteger(undo.nextBefore.travelMinutesFromPrevious) && undo.nextBefore.travelMinutesFromPrevious >= 0 && undo.nextBefore.travelMinutesFromPrevious <= 1440)) &&
        undo.dayKey === dayKey &&
        undo.previousCardId === prevCardId &&
        undo.nextCardId === nextCardId &&
        JSON.stringify(canonicalJson(nextCard)) === JSON.stringify(canonicalJson(undo.nextAfter));

      if (canRestore) {
        if (Object.hasOwn(undo.nextBefore, 'travelMinutesFromPrevious')) nextCard.travelMinutesFromPrevious = undo.nextBefore.travelMinutesFromPrevious;
        else delete nextCard.travelMinutesFromPrevious;
      } else {
        warnings.push('次の場所への移動時間を再確認してください。');
      }
    } else {
      warnings.push('次の場所への移動時間を再確認してください。');
    }
  }

  dayCards.splice(index, 1);

  const candInNew = newPlanning.candidates.find(c => c && c.id === candidateId);
  if (candInNew) {
    candInNew.status = 'draft';
    delete candInNew.assignedDay;
    delete candInNew.assignedCardId;
    delete candInNew.placementUndo;
  }

  return { error: '', trip: newTrip, planning: newPlanning, warnings };
}

export function convertSuggestionToCandidate({ suggestion, roomId, candidateId, adoptedAt }) {
  if (!suggestion || typeof suggestion !== 'object') return null;
  const sugId = typeof suggestion.id === 'string' ? suggestion.id : '';
  const cid = candidateId || (sugId.startsWith('sug-') ? `cand-${sugId.slice(4)}` : `cand-${sugId}`);
  const nowStr = adoptedAt || new Date().toISOString();

  let memo = '';
  if (suggestion.comment && typeof suggestion.comment === 'string') {
    const author = suggestion.creatorName ? `${suggestion.creatorName}: ` : '';
    memo = `【参加者提案】${author}${suggestion.comment}`.trim();
    if (memo.length > 2000) memo = memo.slice(0, 2000);
  }

  const candidate = {
    id: cid,
    title: typeof suggestion.title === 'string' ? suggestion.title.slice(0, 120) : '',
    status: 'draft',
    sourceSuggestion: {
      roomId: typeof roomId === 'string' ? roomId : '',
      suggestionId: sugId,
      adoptedAt: nowStr
    }
  };

  if (suggestion.mapQuery && typeof suggestion.mapQuery === 'string') {
    candidate.mapQuery = suggestion.mapQuery.slice(0, 300);
  }
  if (suggestion.mapUrl && typeof suggestion.mapUrl === 'string') {
    candidate.mapUrl = suggestion.mapUrl.slice(0, 2048);
  }
  if (memo) {
    candidate.notes = memo;
  }

  return candidate;
}

export function validateAdoptPrerequisites({ planning, suggestion, roomId }) {
  if (!suggestion || typeof suggestion !== 'object' || typeof suggestion.id !== 'string') {
    return { ok: false, error: '提案データが無効です。' };
  }
  if (suggestion.status !== 'open') {
    if (suggestion.status === 'withdrawn') {
      return { ok: false, error: '取下げ済みの提案は採用できません。' };
    }
    if (suggestion.status === 'adopted') {
      return { ok: false, error: '既に採用済みの提案です。' };
    }
    if (suggestion.status === 'declined') {
      return { ok: false, error: '見送り済みの提案です。再検討へ戻してから採用してください。' };
    }
    return { ok: false, error: `ステータスが ${suggestion.status} の提案は採用できません。` };
  }
  if (!roomId || typeof roomId !== 'string') {
    return { ok: false, error: 'ルームIDが指定されていません。' };
  }

  const candidates = Array.isArray(planning?.candidates) ? planning.candidates : [];
  const existing = candidates.find(c =>
    c && c.sourceSuggestion &&
    c.sourceSuggestion.roomId === roomId &&
    c.sourceSuggestion.suggestionId === suggestion.id
  );
  if (existing) {
    return { ok: false, error: 'この提案は既に候補棚に追加されています。' };
  }

  return { ok: true, error: '' };
}

export function applySuggestionAdopt({ planning, suggestion, roomId, candidateId, adoptedAt }) {
  const check = validateAdoptPrerequisites({ planning, suggestion, roomId });
  if (!check.ok) {
    return { ok: false, error: check.error, planning };
  }

  const newPlanning = structuredClone(planning || { candidates: [] });
  if (!Array.isArray(newPlanning.candidates)) {
    newPlanning.candidates = [];
  }

  const candidate = convertSuggestionToCandidate({ suggestion, roomId, candidateId, adoptedAt });
  if (!candidate) {
    return { ok: false, error: '候補の生成に失敗しました。', planning };
  }

  // 重複 candidate ID の防止
  let finalCid = candidate.id;
  let counter = 1;
  while (newPlanning.candidates.some(c => c && c.id === finalCid)) {
    finalCid = `${candidate.id}-${counter++}`;
  }
  candidate.id = finalCid;

  newPlanning.candidates.push(candidate);
  return { ok: true, error: '', planning: newPlanning, candidate };
}

export function validateUnadoptPrerequisites({ trip, planning, candidateId, suggestion, roomId }) {
  if (!candidateId || typeof candidateId !== 'string') {
    return { ok: false, error: '候補IDが指定されていません。' };
  }
  if (!planning || !Array.isArray(planning.candidates)) {
    return { ok: false, error: '候補データが存在しません。' };
  }

  const candidate = planning.candidates.find(c => c && c.id === candidateId);
  if (!candidate) {
    return { ok: false, error: '指定された候補が見つかりません。' };
  }

  // 日程配置済みの場合は採用取消不可（先に日程配置取消が必要）
  if (candidate.status === 'assigned' || candidate.assignedCardId) {
    return { ok: false, error: '日程に配置されている候補は採用取消できません。先に日程からカードを削除してください。' };
  }

  // Only assignedCardId establishes a placement link. Same names (or coincident
  // candidate/card IDs) never justify asking the user to delete an unrelated card.
  if (planning.candidates.filter(c => c?.id === candidateId).length !== 1) {
    return { ok: false, error: '候補IDが重複しています。' };
  }

  // 採用元の照合
  if (!candidate.sourceSuggestion) {
    return { ok: false, error: 'この候補は提案から採用されたものではありません。' };
  }
  if (roomId && candidate.sourceSuggestion.roomId !== roomId) {
    return { ok: false, error: '採用元ルームが一致しません。' };
  }
  if (suggestion && candidate.sourceSuggestion.suggestionId !== suggestion.id) {
    return { ok: false, error: '採用元提案IDが一致しません。' };
  }

  // 提案ステータスの整合性確認（adopted または withdrawn 以外は不整合）
  if (suggestion) {
    if (suggestion.status !== 'adopted' && suggestion.status !== 'withdrawn') {
      return { ok: false, error: `提案ステータスが ${suggestion.status} のため採用取消できません。` };
    }
  }

  return { ok: true, error: '', candidate };
}

export function applySuggestionUnadopt({ trip, planning, candidateId, suggestion, roomId }) {
  const check = validateUnadoptPrerequisites({ trip, planning, candidateId, suggestion, roomId });
  if (!check.ok) {
    return { ok: false, error: check.error, planning };
  }

  const newPlanning = structuredClone(planning);
  const targetIndex = newPlanning.candidates.findIndex(c => c && c.id === candidateId);
  if (targetIndex === -1) {
    return { ok: false, error: '候補が見つかりません。', planning };
  }

  const removed = newPlanning.candidates.splice(targetIndex, 1)[0];
  return { ok: true, error: '', planning: newPlanning, removedCandidate: removed };
}
