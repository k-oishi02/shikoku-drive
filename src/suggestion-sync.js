import {
  validateSuggestionInput,
  validateSuggestionCommentInput,
  validateSuggestionLikeAction,
  cleanSuggestion,
  cleanSuggestionComment
} from './suggestion-validation.js';

export function createSuggestionSyncService(dependencies = {}) {
  const {
    db,
    collection,
    doc,
    query,
    where,
    orderBy,
    limit,
    startAfter,
    documentId,
    FieldPath,
    deleteField,
    getDocs,
    onSnapshot,
    getDoc,
    setDoc,
    updateDoc,
    deleteDoc,
    runTransaction,
    serverTimestamp
  } = dependencies;

let currentContext = null;
  let currentGeneration = 0;
  let connectionState = 'stopped';
  const subscriptions = new Map();
  const reactionQueues = new Map();

  function setState(state) {
    connectionState = state;
    dependencies.onState?.({ state, generation: currentGeneration });
  }
  function isContextActive(context) {
    return !!currentContext && !!context && ['tripId', 'roomId', 'authUid', 'generation'].every(k => context[k] === currentContext[k]) &&
      context.generation === currentGeneration && (!dependencies.getAuthUid || dependencies.getAuthUid() === context.authUid);
  }
  function assertContext(context) {
    if (!isContextActive(context)) { const error = new Error('セッションが無効です。'); error.code = 'stale-session'; throw error; }
  }
  function clearViews() {
    for (const item of subscriptions.values()) {
      try { item.onUpdate?.([], { cursor: null, hasMore: false }); } catch {}
    }
  }
  function stopSubscription(key) {
    const item = subscriptions.get(key);
    if (!item) return;
    subscriptions.delete(key); // invalidates late callbacks BEFORE stopping the SDK
    try { item.onUpdate?.([], { cursor: null, hasMore: false }); } catch {}
    try { item.unsub?.(); } catch {}
  }
  function stopAllSubscriptions() {
    for (const key of [...subscriptions.keys()]) stopSubscription(key);
  }
  function destroy() {
    currentGeneration++;
    currentContext = null;
    stopAllSubscriptions();
    reactionQueues.clear();
    setState('stopped');
  }
  function setContext(context) {
    destroy();
    if (!context?.tripId || !context?.roomId || !context?.authUid) return null;
    currentContext = Object.freeze({ tripId: context.tripId, roomId: context.roomId, authUid: context.authUid, generation: currentGeneration });
    setState('connecting');
    return { ...currentContext };
  }
  function getCurrentContext() { return currentContext ? { ...currentContext } : null; }
  function handleError(context, error, subscriptionError = false) {
    if (!isContextActive(context)) return;
    if (/permission-denied|unauthenticated/.test(String(error?.code))) {
      destroy();
      setState('revoked');
    } else if (subscriptionError || /unavailable|deadline-exceeded|network-request-failed/.test(String(error?.code))) {
      clearViews();
      setState('offline');
    }
  }

  async function guardedTransaction(context, callback) {
    assertContext(context);
    try {
      const result = await runTransaction(db, async tx => {
        assertContext(context);
        const guarded = {
          get: async ref => { assertContext(context); const snap = await tx.get(ref); assertContext(context); return snap; },
          set: (...args) => { assertContext(context); return tx.set(...args); },
          update: (...args) => { assertContext(context); return tx.update(...args); },
          delete: (...args) => { assertContext(context); return tx.delete(...args); }
        };
        const value = await callback(guarded);
        assertContext(context);
        return value;
      });
      // A commit can finish after the editor/room changed; never deliver its old data.
      assertContext(context);
      return result;
    } catch (error) { handleError(context, error); throw error; }
  }

  function makeQuery(context, suggestionId, pageSize, cursor = null, newestFirst = false) {
    assertContext(context);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('取得件数は1〜100件で指定してください。');
    if (typeof documentId !== 'function' || typeof startAfter !== 'function') throw new Error('ページング用SDKが注入されていません。');
    const direction = suggestionId && !newestFirst ? 'asc' : 'desc';
    const path = ['rooms', context.roomId, 'suggestions'];
    if (suggestionId) path.push(suggestionId, 'comments');
    const constraints = [orderBy('createdAt', direction), orderBy(documentId(), direction)];
    if (cursor) {
      if (!isContextActive(cursor) || Boolean(cursor.newestFirst) !== newestFirst || cursor.suggestionId !== (suggestionId || null) ||
          typeof cursor.createdAt !== 'string' || !cursor.id || cursor.id.includes('/')) throw new Error('続き取得の位置が別の相談セッションです。');
      constraints.push(startAfter(cursor.createdAt, cursor.id));
    }
    return query(collection(db, ...path), ...constraints, limit(pageSize));
  }
  function pageResult(context, suggestionId, snapshot, pageSize, newestFirst = false) {
    const docs = snapshot.docs || (() => { const result = []; snapshot.forEach(d => result.push(d)); return result; })();
    const items = docs.map(d => ({ ...d.data(), id: d.id }));
    const last = items.at(-1);
    return {
      items,
      count: items.length,
      cursor: last ? Object.freeze({ ...context, newestFirst, suggestionId: suggestionId || null, createdAt: last.createdAt, id: last.id }) : null,
      hasMore: items.length === pageSize
    };
  }
  function startSubscription(context, suggestionId, onUpdate, onError, options) {
    const key = suggestionId ? 'comments:' + suggestionId : 'suggestions';
    try {
      const pageSize = options.limitCount || 100;
      const q = makeQuery(context, suggestionId, pageSize, null, options.newestFirst === true);
      stopSubscription(key);
      const item = { onUpdate, unsub: null };
      subscriptions.set(key, item);
      const active = () => isContextActive(context) && subscriptions.get(key) === item;
      item.unsub = onSnapshot(q, { includeMetadataChanges: true }, snapshot => {
        if (!active()) return;
        if (snapshot.metadata?.fromCache) { clearViews(); setState('offline'); return; }
        const page = pageResult(context, suggestionId, snapshot, pageSize, options.newestFirst === true);
        setState('live');
        onUpdate?.(page.items, { cursor: page.cursor, hasMore: page.hasMore });
      }, error => {
        if (!active()) return;
        handleError(context, error, true);
        onError?.(error);
      });
      // Support synchronous SDK adapters too.
      if (!active()) item.unsub?.();
      return () => { if (subscriptions.get(key) === item) stopSubscription(key); };
    } catch (error) { onError?.(error); return () => {}; }
  }
  function startSuggestionsSubscription(context, onUpdate, onError, options = {}) {
    return startSubscription(context, null, onUpdate, onError, options);
  }
  function startCommentsSubscription(context, suggestionId, onUpdate, onError, options = {}) {
    if (!suggestionId || suggestionId.includes('/')) { onError?.(new Error('提案IDが無効です。')); return () => {}; }
    return startSubscription(context, suggestionId, onUpdate, onError, options);
  }
  function stopSuggestionsSubscription() { stopSubscription('suggestions'); }
  function stopCommentsSubscription(suggestionId) { stopSubscription('comments:' + suggestionId); }

  async function fetchPage(context, suggestionId, options = {}) {
    const { pageSize = 50, cursor = null } = options;
    if (options.startAfterCreatedAt !== undefined) throw new Error('時刻だけのカーソルは使用できません。cursorを渡してください。');
    const q = makeQuery(context, suggestionId, pageSize, cursor, options.newestFirst === true);
    if (typeof getDocs !== 'function') throw new Error('getDocs が注入されていません。');
    try {
      const snap = await getDocs(q);
      assertContext(context);
      if (snap.metadata?.fromCache) { const error = new Error('サーバーで確認できません。接続後に再試行してください。'); error.code = 'unavailable'; throw error; }
      return pageResult(context, suggestionId, snap, pageSize, options.newestFirst === true);
    } catch (error) { handleError(context, error); throw error; }
  }
  async function fetchMoreSuggestions(context, options = {}) { return fetchPage(context, null, options); }
  async function fetchMoreComments(context, suggestionId, options = {}) {
    if (!suggestionId || suggestionId.includes('/')) throw new Error('提案IDが無効です。');
    return fetchPage(context, suggestionId, options);
  }

  async function createSuggestion(context, rawInput) {
    if (!isContextActive(context)) {
      throw new Error('セッションが無効です。');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('runTransaction が注入されていません。');
    }

    const inputWithAuth = {
      ...rawInput,
      creatorUid: context.authUid,
      status: 'open'
    };

    const errors = validateSuggestionInput(inputWithAuth);
    if (errors.length > 0) {
      throw new Error(errors.join(', '));
    }

    const cleaned = cleanSuggestion(inputWithAuth);
    const sugRef = doc(db, 'rooms', context.roomId, 'suggestions', cleaned.id);

    return await guardedTransaction(context, async (tx) => {
      const existing = await tx.get(sugRef);
      if (existing.exists && existing.exists()) {
        const data = existing.data();
        if (data.creatorUid !== context.authUid) {
          throw new Error('提案IDが衝突しました。もう一度お試しください。');
        }
        return { id: existing.id, ...data };
      }
      tx.set(sugRef, cleaned);
      return cleaned;
    });
  }

  async function updateSuggestionContent(context, suggestionId, updates) {
    if (!isContextActive(context)) {
      throw new Error('セッションが無効です。');
    }
    if (!suggestionId || typeof suggestionId !== 'string') {
      throw new Error('提案IDが無効です。');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('runTransaction が注入されていません。');
    }

    const sugRef = doc(db, 'rooms', context.roomId, 'suggestions', suggestionId);
    const nowIso = new Date().toISOString();

    return await guardedTransaction(context, async (tx) => {
      const snap = await tx.get(sugRef);
      if (!snap.exists || !snap.exists()) {
        throw new Error('提案が見つかりません。');
      }
      const current = snap.data();
      if (current.creatorUid !== context.authUid) {
        throw new Error('他人の提案は編集できません。');
      }
      if (current.status !== 'open') {
        throw new Error('オープン中の提案のみ編集できます。');
      }

      const candidateForValidation = {
        ...current,
        ...updates,
        creatorUid: context.authUid,
        status: current.status
      };
      const errors = validateSuggestionInput(candidateForValidation);
      if (errors.length > 0) {
        throw new Error(errors.join(', '));
      }

      const allowedUpdates = { updatedAt: nowIso };
      if (updates.title !== undefined) allowedUpdates.title = String(updates.title).trim();
      if (updates.mapQuery !== undefined) allowedUpdates.mapQuery = String(updates.mapQuery).trim();
      if (updates.mapUrl !== undefined) allowedUpdates.mapUrl = String(updates.mapUrl).trim();
      if (updates.comment !== undefined) allowedUpdates.comment = String(updates.comment).trim();

      tx.update(sugRef, allowedUpdates);
      return { ...current, ...allowedUpdates };
    });
  }

  async function withdrawSuggestion(context, suggestionId) {
    if (!isContextActive(context)) {
      throw new Error('セッションが無効です。');
    }
    if (!suggestionId || typeof suggestionId !== 'string') {
      throw new Error('提案IDが無効です。');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('runTransaction が注入されていません。');
    }

    const sugRef = doc(db, 'rooms', context.roomId, 'suggestions', suggestionId);
    const nowIso = new Date().toISOString();

    return await guardedTransaction(context, async (tx) => {
      const snap = await tx.get(sugRef);
      if (!snap.exists || !snap.exists()) {
        throw new Error('提案が見つかりません。');
      }
      const current = snap.data();
      if (current.creatorUid !== context.authUid) {
        throw new Error('他人の提案は取下げできません。');
      }
      if (current.status === 'withdrawn') {
        return { id: snap.id, ...current };
      }
      tx.update(sugRef, {
        status: 'withdrawn',
        updatedAt: nowIso
      });
      return { id: snap.id, ...current, status: 'withdrawn', updatedAt: nowIso };
    });
  }

  async function setSuggestionReaction(context, suggestionId, actionInput) {
    if (!isContextActive(context)) {
      throw new Error('セッションが無効です。');
    }
    if (!suggestionId || typeof suggestionId !== 'string') {
      throw new Error('提案IDが無効です。');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('runTransaction が注入されていません。');
    }

    const actionWithUid = {
      ...actionInput,
      uid: context.authUid
    };

    const errors = validateSuggestionLikeAction(actionWithUid);
    if (errors.length > 0) {
      throw new Error(errors.join(', '));
    }

    const { desired, name } = actionInput;
    const uid = context.authUid;
    const sugRef = doc(db, 'rooms', context.roomId, 'suggestions', suggestionId);

    const prevPromise = reactionQueues.get(suggestionId) || Promise.resolve();
    const currentPromise = prevPromise.then(async () => {
      assertContext(context);

      const nowIso = new Date().toISOString();

    return await guardedTransaction(context, async (tx) => {
        const snap = await tx.get(sugRef);
        if (!snap.exists || !snap.exists()) {
          throw new Error('提案が見つかりません。');
        }
        const current = snap.data();
        const currentLikes = current.likes && typeof current.likes === 'object' ? { ...current.likes } : {};
        const isLiked = Object.hasOwn(currentLikes, uid);

        if (desired) {
          if (current.status === 'withdrawn') {
            throw new Error('取下げ済みの提案には「行きたい」を追加できません。');
          }
          if (isLiked) {
            return { id: snap.id, ...current };
          }
          currentLikes[uid] = {
            name: String(name || '参加者').trim().slice(0, 40),
            at: nowIso
          };
        } else {
          if (!isLiked) {
            return { id: snap.id, ...current };
          }
          delete currentLikes[uid];
        }

        if (typeof FieldPath !== 'function' || typeof deleteField !== 'function') throw new Error('リアクション用SDKが注入されていません。');
        tx.update(sugRef, new FieldPath('likes', uid), desired ? currentLikes[uid] : deleteField(), 'updatedAt', nowIso);
        return { id: snap.id, ...current, likes: currentLikes, updatedAt: nowIso };
      });
    });

    reactionQueues.set(suggestionId, currentPromise.catch(() => {}));
    return currentPromise;
  }

  async function createSuggestionComment(context, suggestionId, rawInput) {
    if (!isContextActive(context)) {
      throw new Error('セッションが無効です。');
    }
    if (!suggestionId || typeof suggestionId !== 'string') {
      throw new Error('提案IDが無効です。');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('runTransaction が注入されていません。');
    }

    const inputWithAuth = {
      ...rawInput,
      suggestionId,
      creatorUid: context.authUid
    };

    const errors = validateSuggestionCommentInput(inputWithAuth);
    if (errors.length > 0) {
      throw new Error(errors.join(', '));
    }

    const cleaned = cleanSuggestionComment(inputWithAuth);
    const sugRef = doc(db, 'rooms', context.roomId, 'suggestions', suggestionId);
    const comRef = doc(db, 'rooms', context.roomId, 'suggestions', suggestionId, 'comments', cleaned.id);

    return await guardedTransaction(context, async (tx) => {
      const sugSnap = await tx.get(sugRef);
      if (!sugSnap.exists || !sugSnap.exists()) {
        throw new Error('親の提案が見つかりません。');
      }
      const sugData = sugSnap.data();
      if (sugData.status === 'withdrawn') {
        throw new Error('取下げ済みの提案にはコメントできません。');
      }

      const comSnap = await tx.get(comRef);
      if (comSnap.exists && comSnap.exists()) {
        const data = comSnap.data();
        if (data.creatorUid !== context.authUid) {
          throw new Error('コメントIDが衝突しました。もう一度お試しください。');
        }
        return { id: comSnap.id, ...data };
      }

      tx.set(comRef, cleaned);
      return cleaned;
    });
  }

  async function deleteSuggestionComment(context, suggestionId, commentId) {
    if (!isContextActive(context)) {
      throw new Error('セッションが無効です。');
    }
    if (!suggestionId || !commentId) {
      throw new Error('IDが無効です。');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('runTransaction が注入されていません。');
    }

    const comRef = doc(db, 'rooms', context.roomId, 'suggestions', suggestionId, 'comments', commentId);

    return await guardedTransaction(context, async (tx) => {
      const comSnap = await tx.get(comRef);
      if (!comSnap.exists || !comSnap.exists()) {
        return;
      }
      const comData = comSnap.data();
      if (comData.creatorUid !== context.authUid) {
        throw new Error('他人のコメントは削除できません。');
      }
      tx.delete(comRef);
    });
  }



  return {
    setContext,
    getCurrentContext,
    getState: () => connectionState,
    startSuggestionsSubscription,
    stopSuggestionsSubscription,
    startCommentsSubscription,
    stopCommentsSubscription,
    fetchMoreSuggestions,
    fetchMoreComments,
    createSuggestion,
    updateSuggestionContent,
    withdrawSuggestion,
    setSuggestionReaction,
    createSuggestionComment,
    deleteSuggestionComment,
    destroy
  };
}
