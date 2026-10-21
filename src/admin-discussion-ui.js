/**
 * Admin Discussion Bridge & Suggestion Adoption UI Controller
 *
 * Connects the discussion room panel with administrative controls and
 * executes atomic Firestore transactions for suggestion adoption and status changes.
 */

import {
  doc, collection, query, orderBy, limit, startAfter, documentId,
  FieldPath, deleteField, runTransaction, getDocsFromServer, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { $, showToast } from './admin-ui.js';
import { createDiscussionPanel } from './discussion-ui.js';
import { createSuggestionSyncService } from './suggestion-sync.js';
import {
  adoptSuggestionTransaction,
  unadoptSuggestionTransaction,
  changeSuggestionStatusTransaction
} from './admin-trip-store.js';

let contextDb = null;
let contextAuth = null;
let contextStore = null;
let contextSession = null;
let contextCallbacks = {};

let adminDiscussionPanel = null;
let adminDiscussionService = null;
let adminDiscussionRoomStop = null;
let adminDiscussionBinding = '';

export function stopAdminDiscussion(message = '') {
  adminDiscussionBinding = '';
  adminDiscussionRoomStop?.();
  adminDiscussionRoomStop = null;
  adminDiscussionPanel?.disconnect(message);
  adminDiscussionService?.destroy();
  adminDiscussionService = null;
}

export function connectAdminDiscussion() {
  if (!contextStore || !contextDb || !contextAuth) return;
  const select = $('admin-discussion-room');
  if (!select) return;
  const roomId = select.value;
  const state = contextStore.getState();
  const distribution = state.distributions.find(
    d => (d.roomId || d.id) === roomId && d.tripId === state.activeTrip?.tripId && d.status === 'active'
  );

  if (!distribution || !state.currentUser || state.currentView !== 'editor') {
    stopAdminDiscussion();
    return;
  }

  const key = JSON.stringify([state.currentUser.uid, distribution.tripId, roomId]);
  if (key === adminDiscussionBinding) {
    adminDiscussionPanel?.refresh();
    return;
  }

  stopAdminDiscussion();
  adminDiscussionBinding = key;
  adminDiscussionService = createSuggestionSyncService({
    db: contextDb, doc, collection, query, orderBy, limit, startAfter, documentId, FieldPath, deleteField, runTransaction,
    getDocs: getDocsFromServer, onSnapshot, getAuthUid: () => contextAuth.currentUser?.uid,
    onState: ({ state: connection }) => {
      if (adminDiscussionBinding === key) adminDiscussionPanel?.onConnection(connection);
    }
  });

  const ctx = adminDiscussionService.setContext({
    tripId: distribution.tripId,
    roomId,
    authUid: state.currentUser.uid
  });
  adminDiscussionPanel.connect({ service: adminDiscussionService, context: ctx });
  adminDiscussionPanel.setVisible(true);

  const failed = message => {
    if (adminDiscussionBinding !== key) return;
    adminDiscussionPanel.disconnect(message);
    adminDiscussionService?.destroy();
  };

  adminDiscussionRoomStop = onSnapshot(doc(contextDb, 'rooms', roomId), { includeMetadataChanges: true }, snapshot => {
    if (adminDiscussionBinding !== key) return;
    if (snapshot.metadata.fromCache) return;
    const room = snapshot.data();
    if (!snapshot.exists() || room.status !== 'active' || room.tripId !== distribution.tripId) {
      failed('この配布先の相談は停止されています。');
    }
  }, () => failed('配布先の確認に失敗しました。権限または通信状態を確認してください。'));
}

export function refreshAdminDiscussionRooms() {
  const select = $('admin-discussion-room');
  if (!select || !contextStore) return;
  const state = contextStore.getState();

  if (!adminDiscussionPanel) {
    adminDiscussionPanel = createDiscussionPanel($('admin-discussion'), {
      role: 'admin',
      getName: () => state.currentUser?.displayName || '管理者',
      getCandidate: (suggestionId, roomId) => state.activePlanning?.candidates?.find(
        c => c.sourceSuggestion?.roomId === roomId && c.sourceSuggestion?.suggestionId === suggestionId
      ),
      onAdminAction: (action, args) => {
        if (action === 'adopt') return executeAdminAdoptSuggestion(args);
        if (action === 'unadopt') return executeAdminUnadoptSuggestion(args);
        return executeAdminChangeSuggestionStatus(args);
      },
      onReconnect: () => {
        stopAdminDiscussion();
        connectAdminDiscussion();
      }
    });
  }

  const previous = select.value;
  const available = state.distributions.filter(d => d.tripId === state.activeTrip?.tripId && d.status === 'active');
  select.replaceChildren();

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = available.length ? '配布先を選択' : 'この旅行の有効な配布先はありません';
  select.append(empty);

  for (const distribution of available) {
    const option = document.createElement('option');
    option.value = distribution.roomId || distribution.id;
    option.textContent = distribution.label || '名称未設定の配布先';
    select.append(option);
  }

  select.value = available.some(d => (d.roomId || d.id) === previous)
    ? previous
    : available.length === 1 ? (available[0].roomId || available[0].id) : '';

  if (state.currentView === 'editor') connectAdminDiscussion();
  else stopAdminDiscussion();
}

export async function executeAdminSuggestionChange(mode, { roomId, suggestionId, candidateId }) {
  if (!contextStore || !contextSession || !contextDb) return { ok: false, error: 'Context not initialized' };
  const state = contextStore.getState();
  let ticket = null;
  try {
    if (state.tripWriteBusy || contextSession.saving) throw new Error('保存処理が実行中です。');
    if (!state.currentUser || !contextSession.isOpenSession() || !state.activeTrip?.tripId) throw new Error('旅行が開かれていません。');
    if (contextCallbacks.hasUnsavedChanges && contextCallbacks.hasUnsavedChanges()) {
      throw new Error('未保存の変更があります。先に下書き保存してください。');
    }

    const tripId = state.activeTrip.tripId;
    let expectedCandidate;
    if (mode === 'unadopt') {
      expectedCandidate = state.activePlanning?.candidates.find(c => c.id === candidateId);
      if (!expectedCandidate) throw new Error('候補が見つかりません。');
      expectedCandidate = structuredClone(expectedCandidate);
      if (!window.confirm(`「${expectedCandidate.title}」を候補棚から削除し、採用を取り消しますか？候補のメモも削除されます。`)) {
        return { ok: false, cancelled: true };
      }
    }

    const inputRevision = state.editorInputRevision;
    const uid = state.currentUser.uid;
    ticket = contextSession.beginSave(state.activeTrip, state.activePlanning, { tripId });
    contextStore.setState({ tripWriteBusy: true });
    if (contextCallbacks.updateSaveStatus) contextCallbacks.updateSaveStatus();

    const operation = mode === 'adopt' ? adoptSuggestionTransaction : unadoptSuggestionTransaction;
    const result = await operation({
      db: contextDb, doc, runTransaction, adminTripRef: doc(contextDb, 'adminTrips', tripId),
      expectedVersion: ticket.expectedVersion, roomId,
      roomRef: doc(contextDb, 'rooms', roomId),
      suggestionRef: doc(contextDb, 'rooms', roomId, 'suggestions', suggestionId),
      candidateId, confirmed: mode === 'unadopt', expectedCandidate
    });

    if (contextStore.getState().currentUser?.uid !== uid) {
      contextSession.failSave(ticket);
      return { ok: true, sessionSwitched: true };
    }

    state.trips.set(tripId, {
      trip: result.trip,
      planning: result.planning,
      version: result.newVersion,
      source: 'cloud',
      updatedAt: new Date()
    });

    const sameSession = contextSession.generation === ticket.generation && contextStore.getState().activeTrip?.tripId === tripId;
    if (sameSession && contextCallbacks.syncEditorInputs) contextCallbacks.syncEditorInputs();

    const completion = contextSession.finishExternalSave(
      ticket, result, contextStore.getState().activeTrip, contextStore.getState().activePlanning,
      sameSession && inputRevision === contextStore.getState().editorInputRevision && contextStore.getState().dirtyDialogs.size === 0
    );

    if (completion.applied) {
      contextStore.setState({
        activeTrip: structuredClone(result.trip),
        activePlanning: structuredClone(result.planning)
      });
      if (contextCallbacks.renderEditor) contextCallbacks.renderEditor();
      showToast(mode === 'adopt' ? '候補棚に採用しました。旅程はまだ公開されません。' : '採用を取り消しました。');
    } else if (completion.localEditsPreserved) {
      showToast('サーバーの処理は完了しました。処理中の入力は保持しています。入力をバックアップしてから下書きを再読込してください。', true);
    }
    return { ok: true, result, ...completion };
  } catch (error) {
    if (ticket) contextSession.failSave(ticket);
    showToast(error.message, true);
    return { ok: false, error: error.message };
  } finally {
    if (ticket) {
      contextStore.setState({ tripWriteBusy: false });
      if (contextCallbacks.updateSaveStatus) contextCallbacks.updateSaveStatus();
    }
  }
}

export async function executeAdminAdoptSuggestion(args) {
  return executeAdminSuggestionChange('adopt', args);
}

export async function executeAdminUnadoptSuggestion(args) {
  return executeAdminSuggestionChange('unadopt', args);
}

export async function executeAdminChangeSuggestionStatus({ roomId, suggestionId, nextStatus }) {
  if (!contextStore || !contextSession || !contextDb) return { ok: false, error: 'Context not initialized' };
  const state = contextStore.getState();
  if (state.tripWriteBusy || contextSession.saving || !state.currentUser || !state.activeTrip?.tripId) {
    return { ok: false, error: '旅行を開き、処理の完了を待ってください。' };
  }
  const generation = contextSession.generation;
  try {
    contextStore.setState({ tripWriteBusy: true });
    const result = await changeSuggestionStatusTransaction({
      db: contextDb, doc, runTransaction, tripId: state.activeTrip.tripId, roomId,
      suggestionRef: doc(contextDb, 'rooms', roomId, 'suggestions', suggestionId),
      roomRef: doc(contextDb, 'rooms', roomId), nextStatus
    });
    if (generation !== contextSession.generation) return { ok: true, sessionSwitched: true };
    showToast(nextStatus === 'declined' ? '提案を見送りにしました。' : '提案を検討中に戻しました。');
    return { ok: true, result };
  } catch (error) {
    showToast(error.message, true);
    return { ok: false, error: error.message };
  } finally {
    contextStore.setState({ tripWriteBusy: false });
    if (contextCallbacks.updateSaveStatus) contextCallbacks.updateSaveStatus();
  }
}

export function initAdminDiscussion({ db, auth, store, session, callbacks = {} }) {
  contextDb = db;
  contextAuth = auth;
  contextStore = store;
  contextSession = session;
  contextCallbacks = callbacks;

  const roomSelect = $('admin-discussion-room');
  if (roomSelect) {
    roomSelect.addEventListener('change', connectAdminDiscussion);
  }

  window._executeAdminAdoptSuggestion = executeAdminAdoptSuggestion;
  window._executeAdminUnadoptSuggestion = executeAdminUnadoptSuggestion;
  window._executeAdminChangeSuggestionStatus = executeAdminChangeSuggestionStatus;
}
