/**
 * SHIORI Admin Console: Master Entry Point
 * Bootstraps Firebase, reactive AdminStore, editor session, and coordinates view controllers.
 */

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { $, showToast } from './admin-ui.js';
import { initErrorBoundary, reportAppError } from './error-boundary.js';
import { createAdminStore } from './admin-store.js';
import { createEditorSession } from './admin-save-state.js';
import { initAdminAuth, handleAuthState } from './admin-auth.js';
import {
  loadCloudTrips, persistTrip, reloadActiveDraft, downloadDraftRecovery,
  downloadActiveTrip, importTripFile, duplicateTrip, toggleTripArchive
} from './admin-trip-service.js';
import { renderTripLibrary, initOverviewView } from './admin-view-overview.js';
import {
  initEditorView, renderEditor, renderDaySelect, renderEditorCards,
  readTripBasics, readDaySettings, openTripEditor, syncEditorInputs,
  hasUnsavedChanges, updateSaveStatus, confirmEditorLeave, startEditorSession,
  handleEditorInput, closeEditingDialog, handleEditorUnload,
  renderTripAudit, renderPlanningCockpit
} from './admin-view-editor.js';
import { initCandidateShelf, renderCandidateList } from './admin-candidate-ui.js';
import { initDayPlannerUI, previewCardReorder, openMoveDayDialog, openCascadeAdjustDialog } from './admin-day-planner-ui.js';
import { initDistributionView, populateTripSelects, startDistributionListener, renderDistributions, openDistribution } from './admin-distribution-ui.js';
import { initRolesView, loadAdminRoles } from './admin-roles-ui.js';
import { initAdminDiscussion, stopAdminDiscussion, refreshAdminDiscussionRooms } from './admin-discussion-ui.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCOh5MtRbplm-46FETshOQAGHqyQ4fD4tA',
  authDomain: 'shikoku-drive.firebaseapp.com',
  projectId: 'shikoku-drive',
  storageBucket: 'shikoku-drive.firebasestorage.app',
  messagingSenderId: '100077385758',
  appId: '1:100077385758:web:dd63588317da1edc9b560f',
  measurementId: 'G-VV9YHYW85C'
};

const app = getApps().find(a => a.name === 'shiori-admin') || initializeApp(firebaseConfig, 'shiori-admin');
const auth = getAuth(app), db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export const adminStore = createAdminStore();
export const editorSession = createEditorSession();

export function stopLiveListeners(store = adminStore) {
  stopAdminDiscussion();
  const s = store.getState();
  s.distributionsUnsubscribe?.(); s.distributionsUnsubscribe = null;
  [s.participantUnsubscribers, s.roomUnsubscribers, s.expenseUnsubscribers].forEach(m => { m.forEach(u => u()); m.clear(); });
}

export function showView(viewName) {
  if (adminStore.getState().currentView === 'editor' && viewName !== 'editor' && !confirmEditorLeave(adminStore, editorSession)) return false;
  adminStore.setState({ currentView: viewName });
  refreshAdminDiscussionRooms();
  document.querySelectorAll('[data-view]').forEach(s => { s.hidden = s.dataset.view !== viewName; });
  document.querySelectorAll('[data-admin-view]').forEach(b => b.classList.toggle('active', b.dataset.adminView === viewName));
  if (viewName === 'overview') callbacks.renderTripLibrary();
  if (viewName === 'distribution') populateTripSelects(adminStore);
  if (viewName === 'roles') loadAdminRoles(db, adminStore);
  return true;
}

export async function loadDashboard() {
  stopLiveListeners(adminStore);
  adminStore.getState().trips.clear(); adminStore.getState().publishedTrips.clear();
  try {
    await loadCloudTrips(db, adminStore);
    callbacks.renderTripLibrary();
    populateTripSelects(adminStore);
    startDistributionListener(db, adminStore, callbacks);
  } catch (err) { console.error(err); reportAppError(err, { action: 'loadDashboard' }); showToast(`管理データを読み込めませんでした: ${err.message}`, true); }
}

const callbacks = {
  showView,
  confirmEditorLeave: () => confirmEditorLeave(adminStore, editorSession),
  hasUnsavedChanges: () => hasUnsavedChanges(adminStore, editorSession),
  syncEditorInputs: () => syncEditorInputs(adminStore),
  updateSaveStatus: () => updateSaveStatus(adminStore, editorSession),
  renderEditor: () => renderEditor(adminStore, editorSession, callbacks),
  renderEditorCards: () => renderEditorCards(adminStore, callbacks),
  renderDaySelect: () => renderDaySelect(adminStore),
  renderCandidateList: () => renderCandidateList(adminStore, callbacks),
  renderTripLibrary: () => renderTripLibrary({
    store: adminStore,
    onOpenEditor: id => openTripEditor(adminStore, editorSession, callbacks, id),
    onOpenDistribution: id => openDistribution(adminStore, id, showView),
    duplicateTrip: id => duplicateTrip({ store: adminStore, tripId: id, confirmEditorLeave: callbacks.confirmEditorLeave, renderEditor: callbacks.renderEditor, showView, startEditorSession: (s, v) => startEditorSession(adminStore, editorSession, s, v) }),
    toggleTripArchive: id => toggleTripArchive({ db, store: adminStore, session: editorSession, tripId: id, hasUnsavedChanges: callbacks.hasUnsavedChanges, updateSaveStatus: callbacks.updateSaveStatus, renderEditor: callbacks.renderEditor, startEditorSession: (s, v) => startEditorSession(adminStore, editorSession, s, v), renderTripLibrary: () => callbacks.renderTripLibrary() }),
    downloadDraftRecovery: id => downloadDraftRecovery(adminStore, id)
  }),
  renderTripAudit: () => renderTripAudit(adminStore),
  refreshAdminDiscussionRooms: () => refreshAdminDiscussionRooms(),
  previewCardReorder: (from, to, opt) => previewCardReorder(adminStore, from, to, opt),
  openMoveDayDialog: idx => openMoveDayDialog(adminStore, idx),
  openCascadeAdjustDialog: idx => openCascadeAdjustDialog(adminStore, idx),
  readDaySettings: () => readDaySettings(adminStore),
  readTripBasics: () => readTripBasics(adminStore)
};

function bindGlobalEvents() {
  initErrorBoundary({ containerId: 'admin-error-boundary', fallbackMessage: '管理者コンソールの実行中に予期せぬエラーが発生しました。' });
  initAdminAuth({ auth, db, store: adminStore, googleProvider, onEnter: loadDashboard, stopLiveListeners: () => stopLiveListeners(adminStore), confirmLeave: callbacks.confirmEditorLeave });
  initOverviewView({ store: adminStore, onNewTrip: () => openTripEditor(adminStore, editorSession, callbacks, ''), onOpenEditor: id => openTripEditor(adminStore, editorSession, callbacks, id), onOpenDistribution: id => openDistribution(adminStore, id, showView), duplicateTrip: callbacks.duplicateTrip, toggleTripArchive: callbacks.toggleTripArchive, downloadDraftRecovery: id => downloadDraftRecovery(adminStore, id) });
  initEditorView({ store: adminStore, session: editorSession, db, callbacks });
  initCandidateShelf({ store: adminStore, callbacks, closeEditingDialog: id => closeEditingDialog(adminStore, id) });
  initDayPlannerUI({ store: adminStore, callbacks });
  initDistributionView({ db, store: adminStore });
  initRolesView({ db, store: adminStore });
  initAdminDiscussion({ db, auth, store: adminStore, session: editorSession, callbacks });

  document.querySelectorAll('[data-admin-view]').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.adminView)));
  $('save-draft')?.addEventListener('click', () => persistTrip({ db, store: adminStore, session: editorSession, publish: false, ...callbacks }));
  $('publish-trip')?.addEventListener('click', () => persistTrip({ db, store: adminStore, session: editorSession, publish: true, ...callbacks }));
  $('reload-draft')?.addEventListener('click', () => reloadActiveDraft({ db, store: adminStore, session: editorSession, ...callbacks }));
  $('download-trip')?.addEventListener('click', () => downloadActiveTrip({ store: adminStore, adminBackup: false, syncEditorInputs: callbacks.syncEditorInputs }));
  $('download-admin-backup')?.addEventListener('click', () => downloadActiveTrip({ store: adminStore, adminBackup: true, syncEditorInputs: callbacks.syncEditorInputs }));
  $('import-trip-file')?.addEventListener('change', e => importTripFile({ file: e.target.files?.[0], store: adminStore, session: editorSession, ...callbacks }));

  document.addEventListener('input', e => handleEditorInput(adminStore, editorSession, e));
  document.addEventListener('change', e => handleEditorInput(adminStore, editorSession, e));
  document.addEventListener('click', e => {
    if (e.target.closest?.('#view-editor, #card-dialog, #candidate-dialog, #candidate-adopt-dialog, #move-day-dialog, #cascade-adjust-dialog, #planner-compare-dialog')) {
      queueMicrotask(callbacks.updateSaveStatus);
    }
  });

  ['card-dialog', 'candidate-dialog', 'candidate-adopt-dialog', 'move-day-dialog', 'cascade-adjust-dialog', 'planner-compare-dialog'].forEach(id => {
    $(id)?.addEventListener('cancel', e => { if (adminStore.getState().dirtyDialogs.has(id) && !window.confirm('未反映の入力を破棄しますか？')) e.preventDefault(); });
    $(id)?.addEventListener('close', () => { adminStore.getState().dirtyDialogs.delete(id); callbacks.updateSaveStatus(); });
  });

  window.addEventListener('beforeunload', e => handleEditorUnload(adminStore, editorSession, e));
  window.addEventListener('pagehide', () => stopLiveListeners(adminStore));
  onAuthStateChanged(auth, user => handleAuthState({ user, db, store: adminStore, onEnter: loadDashboard, stopLiveListeners: () => stopLiveListeners(adminStore) }));
}

bindGlobalEvents();
