import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch, query, orderBy, limit, startAfter, documentId, FieldPath, deleteField, getDocsFromServer
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import {
  analyzeTrip,
  cleanCandidate,
  cleanPlanning,
  formatMinute,
  migrateTripToV2,
  parseTimeRange,
  stripPlanningForPublication,
  validateTripDraft
} from './trip-v2-index.js';
import { validatePlacement } from './admin-placement.js';
import { createSuggestionSyncService } from './suggestion-sync.js';
import { createDiscussionPanel } from './discussion-ui.js';
import { reconcileAssignments, inspectAssignment, unassignCandidate } from './admin-candidate-state.js';
import { createEditorSession, draftVersion } from './admin-save-state.js';
import {
  commitTripRecord,
  cleanupRoomSuggestionsAndComments,
  adoptSuggestionTransaction,
  unadoptSuggestionTransaction,
  changeSuggestionStatusTransaction
} from './admin-trip-store.js';
import { buildTripExport, buildAdminBackup, parseTripImport } from './admin-transfer.js';
import { resolveMapFields, validateMapFields, mapHref, mapSearchQuery, mapRouteHref } from './map-links.js';
import { validateCandidateInput, validateTripInput, validateStoredDraftSize } from './draft-validation.js';
import { decodeDraftRecord } from './admin-draft-record.js';
import { planCardReorder, planCardMoveDay, planCascadeTimeAdjustment, compareScheduleChanges, applyDayPlan, undoDayPlan } from './admin-day-planner.js';


const firebaseConfig = {
  apiKey: 'AIzaSyCOh5MtRbplm-46FETshOQAGHqyQ4fD4tA',
  authDomain: 'shikoku-drive.firebaseapp.com',
  projectId: 'shikoku-drive',
  storageBucket: 'shikoku-drive.firebasestorage.app',
  messagingSenderId: '100077385758',
  appId: '1:100077385758:web:dd63588317da1edc9b560f',
  measurementId: 'G-VV9YHYW85C'
};

const ADMIN_APP_NAME = 'shiori-admin';
const app = getApps().find(existingApp => existingApp.name === ADMIN_APP_NAME)
  || initializeApp(firebaseConfig, ADMIN_APP_NAME);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

const state = {
  currentView: 'overview',
  tripWriteBusy: false,
  dirtyDialogs: new Set(),
  editorInputRevision: 0,
  currentUser: null,
  currentRole: 'editor',
  adminProfiles: [],
  trips: new Map(),
  publishedIds: new Set(),
  publishedTrips: new Map(),
  activeTrip: null,
  activePlanning: null,
  activeDayKey: '',
  candidateFilterStatus: 'all',
  candidateFilterCategory: 'all',
  activeCandidateForAdopt: null,
  distributions: [],
  participantUnsubscribers: new Map(),
  roomUnsubscribers: new Map(),
  expenseUnsubscribers: new Map(),
  distributionsUnsubscribe: null,
  toastTimer: null
};


const $ = id => document.getElementById(id);
const editorSession = createEditorSession();
const deepClone = value => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

function text(value) {
  return value == null ? '' : String(value);
}

function showToast(message, error = false) {
  const toast = $('admin-toast');
  window.clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('visible');
  state.toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3600);
}

function setBusy(button, busy, label = '') {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label || '処理中…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
  }
}

async function copyText(value, successMessage = 'コピーしました') {
  try {
    await navigator.clipboard.writeText(value);
    showToast(successMessage);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    showToast(successMessage);
  }
}

function formatTimestamp(value) {
  const date = value?.toDate?.() || (value ? new Date(value) : null);
  if (!date || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function formatYen(value) {
  const amount = Number(value);
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency', currency: 'JPY', maximumFractionDigits: 0
  }).format(Number.isFinite(amount) ? amount : 0);
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const ACCESS_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomAccessId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(byte => ACCESS_ID_ALPHABET[byte % ACCESS_ID_ALPHABET.length]).join('');
}

function formatAccessId(value) {
  const normalized = text(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.match(/.{1,4}/g)?.join('-') || '—';
}

async function sha256(value) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function setAuthScreen({ message, canSignIn = false, user = null, accessDenied = false }) {
  $('auth-state').textContent = message;
  $('admin-sign-in').hidden = !canSignIn;
  $('admin-access-help').hidden = !accessDenied;
  $('admin-uid').textContent = user?.uid || '—';
  $('admin-auth').hidden = false;
  $('admin-app').hidden = true;
}

async function verifyAdministrator(user) {
  let timeoutId;
  try {
    const snapshot = await Promise.race([
      getDoc(doc(db, 'admins', user.uid)),
      new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error('Admin verification timed out')), 10000);
      })
    ]);
    if (!snapshot.exists() || snapshot.data()?.active !== true) return null;
    const data = snapshot.data();
    return { ...data, role: data.role === 'editor' ? 'editor' : 'owner' };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function enterAdmin(user, profile) {
  state.currentUser = user;
  state.currentRole = profile?.role === 'editor' ? 'editor' : 'owner';
  $('admin-account').textContent = `${state.currentRole === 'owner' ? 'OWNER' : 'EDITOR'} · ${user.email || user.displayName || user.uid}`;
  $('roles-nav').hidden = state.currentRole !== 'owner';
  $('admin-auth').hidden = true;
  $('admin-app').hidden = false;
  await loadDashboard();
}

function stopLiveListeners() {
  stopAdminDiscussion();
  state.distributionsUnsubscribe?.();
  state.distributionsUnsubscribe = null;
  state.participantUnsubscribers.forEach(unsubscribe => unsubscribe());
  state.participantUnsubscribers.clear();
  state.roomUnsubscribers.forEach(unsubscribe => unsubscribe());
  state.roomUnsubscribers.clear();
  state.expenseUnsubscribers.forEach(unsubscribe => unsubscribe());
  state.expenseUnsubscribers.clear();
}

async function handleAuthState(user) {
  if (!user) {
    stopLiveListeners();
    state.currentUser = null;
    setAuthScreen({ message: 'Googleアカウントで管理者認証してください。', canSignIn: true });
    return;
  }
  setAuthScreen({ message: '管理者権限を確認しています…' });
  try {
    const profile = await verifyAdministrator(user);
    if (!profile) {
      setAuthScreen({
        message: `${user.email || 'このアカウント'} は、まだ管理者として登録されていません。`,
        user,
        canSignIn: true,
        accessDenied: true
      });
      return;
    }
    await enterAdmin(user, profile);
  } catch (error) {
    console.error(error);
    setAuthScreen({
      message: 'Firestoreの管理者確認に失敗しました。ルールの公開と admins ドキュメントを確認してください。',
      user,
      canSignIn: true,
      accessDenied: true
    });
  }
}

function normalizeTrip(raw, fallbackId = '') {
  return migrateTripToV2(raw, fallbackId);
}

function blankPlanning() {
  return cleanPlanning({
    schemaVersion: 3,
    candidates: [],
    notes: ''
  });
}

async function loadCloudTrips() {
  const [drafts, published] = await Promise.all([
    getDocs(collection(db, 'adminTrips')),
    getDocs(collection(db, 'publishedTrips'))
  ]);
  state.publishedIds = new Set(published.docs.filter(item => item.data().published === true).map(item => item.id));
  published.forEach(item => {
    const data = item.data();
    try {
      const trip = normalizeTrip(JSON.parse(data.payloadJson), item.id);
      state.publishedTrips.set(item.id, deepClone(trip));
      state.trips.set(item.id, { trip, planning: blankPlanning(), source: 'published', updatedAt: data.publishedAt || null });
    } catch (error) {
      console.warn(`Invalid publishedTrips/${item.id}`, error);
    }
  });
  drafts.forEach(item => {
    const data = item.data();
    try {
      const { trip, planning } = decodeDraftRecord(data, item.id);
      state.trips.set(item.id, { trip, planning, source: 'cloud', version: draftVersion(data), updatedAt: data.updatedAt || null });
    } catch (error) {
      const trip = state.trips.get(item.id)?.trip || normalizeTrip({ tripId: item.id, title: data.title || item.id });
      state.trips.set(item.id, { trip, planning: null, source: 'cloud-error', version: draftVersion(data), loadError: error.message, rawDraft: { tripId: item.id, payloadJson: data.payloadJson, ...(data.planningJson !== undefined ? { planningJson: data.planningJson } : {}) } });
      console.warn(`Invalid adminTrips/${item.id}`, error);
    }
  });
}

async function loadDashboard() {
  stopLiveListeners();
  state.trips.clear();
  state.publishedTrips.clear();
  try {
    await loadCloudTrips();
    renderTripLibrary();
    populateTripSelects();
    startDistributionListener();
  } catch (error) {
    console.error(error);
    showToast(`管理データを読み込めませんでした: ${error.message}`, true);
  }
}

function makeElement(tag, className = '', content = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== '') element.textContent = content;
  return element;
}

function renderTripLibrary() {
  const list = $('admin-trip-list');
  list.replaceChildren();
  const entries = [...state.trips.entries()].sort((a, b) => text(a[1].trip.startDate).localeCompare(text(b[1].trip.startDate)));
  $('metric-trips').textContent = String(entries.length);
  $('metric-published').textContent = String(state.publishedIds.size);
  $('overview-updated').textContent = `更新 ${new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`;
  if (!entries.length) {
    list.append(makeElement('div', 'empty-state', '旅行がまだありません。「新しい旅行」から作成できます。'));
    return;
  }
  entries.forEach(([tripId, record]) => {
    const trip = record.trip;
    const candidateCount = record.planning?.candidates?.length || 0;
    const card = makeElement('article', 'trip-card');
    const header = makeElement('div', 'distribution-head');
    header.append(makeElement('span', `pill ${state.publishedIds.has(tripId) ? '' : 'draft'}`, state.publishedIds.has(tripId) ? '公開中' : '下書き'));
    header.append(makeElement('span', 'muted small', tripId));
    const title = makeElement('h3', '', trip.title || tripId);
    const description = makeElement('p', '', trip.catchphrase || trip.subtitle || '説明は未設定です');
    const meta = makeElement('div', 'trip-meta');
    meta.append(makeElement('span', '', `${trip.startDate || '未定'} → ${trip.endDate || '未定'}`));
    meta.append(makeElement('span', '', `${Object.keys(trip.days).length} DAYS`));
    if (candidateCount > 0) {
      meta.append(makeElement('span', '', `候補 ${candidateCount}件`));
    }
    const actions = makeElement('div', 'trip-actions');
    const edit = makeElement('button', 'compact', '編集');
    edit.type = 'button';
    edit.addEventListener('click', () => openTripEditor(tripId));
    const distribute = makeElement('button', 'compact ghost', '配布');
    distribute.type = 'button';
    distribute.addEventListener('click', () => openDistribution(tripId));
    const duplicate = makeElement('button', 'compact ghost', '複製');
    duplicate.type = 'button';
    duplicate.addEventListener('click', () => duplicateTrip(tripId));
    const archive = makeElement('button', 'compact ghost', trip.archived ? '戻す' : '保管');
    archive.type = 'button';
    archive.addEventListener('click', () => toggleTripArchive(tripId));
    card.classList.toggle('archived', trip.archived === true);
    actions.append(edit, distribute, duplicate, archive);
    if (record.loadError) {
      edit.disabled = true;
      duplicate.disabled = true;
      archive.disabled = true;
      card.append(makeElement('p', 'field-help', `下書きの読込を停止しました。元データを保管し、JSONを修正して読み込んでください。公開済み内容は変更していません。\n${record.loadError}`));
      const recover = makeElement('button', 'compact ghost', '元データを保管');
      recover.type = 'button';
      recover.addEventListener('click', () => downloadDraftRecovery(tripId));
      actions.append(recover);
    }
    card.append(header, title, description, meta, actions);
    list.append(card);
  });
}

function syncEditorInputs() {
  if (!state.activeTrip) return;
  readTripBasics();
  readTripPlanning();
  readDaySettings();
}

function hasUnsavedChanges() {
  if (!state.activeTrip) return false;
  syncEditorInputs();
  return state.dirtyDialogs.size > 0 || editorSession.isDirty(state.activeTrip, state.activePlanning);
}

function updateSaveStatus() {
  const status = $('editor-save-status');
  if (status) status.textContent = state.tripWriteBusy ? '保存中…' : hasUnsavedChanges() ? '未保存の変更があります' : '下書きに変更はありません';
  $('save-draft').disabled = state.tripWriteBusy;
  $('publish-trip').disabled = state.tripWriteBusy;
  $('reload-draft').disabled = state.tripWriteBusy;
}

function confirmEditorLeave() {
  if (state.tripWriteBusy || editorSession.saving) {
    showToast('保存が終わるまでお待ちください。', true);
    return false;
  }
  return !hasUnsavedChanges() || window.confirm('未保存の変更があります。保存せずに進みますか？');
}

function startEditorSession(saved = true, version = null) {
  state.dirtyDialogs.clear();
  editorSession.open({ trip: state.activeTrip, planning: state.activePlanning, version, saved });
  updateSaveStatus();
}

function handleEditorInput(event) {
  if (!state.activeTrip) return;
  const dialog = event.target.closest?.('#card-dialog, #candidate-dialog, #candidate-adopt-dialog');
  if (dialog) state.dirtyDialogs.add(dialog.id);
  if (dialog || event.target.closest?.('#view-editor')) {
    state.editorInputRevision += 1;
    updateSaveStatus();
  }
}

function closeEditingDialog(id) {
  if (state.dirtyDialogs.has(id) && !window.confirm('この画面の未反映の入力を破棄しますか？')) return;
  $(id).close();
}

function handleEditorUnload(event) {
  if (state.tripWriteBusy || hasUnsavedChanges()) {
    event.preventDefault();
    event.returnValue = '';
  }
}

function showView(viewName) {
  if (state.currentView === 'editor' && viewName !== 'editor' && !confirmEditorLeave()) return false;
  state.currentView = viewName;
  refreshAdminDiscussionRooms();
  document.querySelectorAll('[data-view]').forEach(section => {
    const active = section.dataset.view === viewName;
    section.hidden = !active;
  });
  document.querySelectorAll('[data-admin-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.adminView === viewName);
  });
}

function blankTrip() {
  return normalizeTrip({
    tripId: '',
    title: '旅行しおり',
    subtitle: '',
    catchphrase: '',
    startDate: '',
    endDate: '',
    dayLabels: { day1: 'DAY 1' },
    days: { day1: [] },
    weatherLocations: {},
    checklist: []
  });
}

function openTripEditor(tripId = '') {
  if (state.trips.get(tripId)?.loadError) return showToast('下書きに読込エラーがあります。元データを保管して修復してください。', true);
  if (!confirmEditorLeave()) return;
  state.lastDayPlanUndo = null;
  if ($('undo-day-plan')) $('undo-day-plan').hidden = true;
  state.activeTrip = tripId && state.trips.has(tripId)
    ? deepClone(state.trips.get(tripId).trip)
    : blankTrip();
  state.activePlanning = tripId && state.trips.has(tripId) && state.trips.get(tripId).planning
    ? deepClone(state.trips.get(tripId).planning)
    : blankPlanning();
  state.activeDayKey = Object.keys(state.activeTrip.days)[0] || 'day1';
  renderEditor();
  showView('editor');
  startEditorSession(Boolean(tripId), state.trips.get(tripId)?.version ?? null);
}

function readTripBasics() {
  if (!state.activeTrip) return;
  state.activeTrip.tripId = $('trip-id').value.trim();
  state.activeTrip.title = $('trip-title').value.trim();
  state.activeTrip.subtitle = $('trip-subtitle').value.trim();
  state.activeTrip.catchphrase = $('trip-catchphrase').value.trim();
  state.activeTrip.startDate = $('trip-start-date').value;
  state.activeTrip.endDate = $('trip-end-date').value;
  state.activeTrip.archived = $('trip-archived').checked;
  state.activeTrip.theme = {
    mode: $('trip-theme-mode').value,
    accent: $('trip-theme-accent').value
  };
  state.activeTrip.features = {
    nowMode: $('feature-now').checked,
    expenses: $('feature-expenses').checked,
    notifications: $('feature-notifications').checked
  };
  if (state.activeDayKey) state.activeTrip.dayLabels[state.activeDayKey] = $('editor-day-label').value.trim();
}

function readTripPlanning() {
  if (!state.activePlanning) state.activePlanning = blankPlanning();
  const notesInput = $('trip-planning-notes');
  if (notesInput) state.activePlanning.notes = notesInput.value.trim();
}

function renderEditor() {
  const trip = state.activeTrip;
  if (!trip) return;
  state.activePlanning = reconcileAssignments(trip, state.activePlanning || blankPlanning());
  state.activeCandidateForAdopt = null;
  $('trip-id').value = trip.tripId;
  $('trip-title').value = trip.title;
  $('trip-subtitle').value = trip.subtitle;
  $('trip-catchphrase').value = trip.catchphrase;
  $('trip-start-date').value = trip.startDate;
  $('trip-end-date').value = trip.endDate;
  $('trip-archived').checked = trip.archived === true;
  $('trip-theme-mode').value = trip.theme?.mode || 'auto';
  $('trip-theme-accent').value = trip.theme?.accent || '#f4d35e';
  $('feature-now').checked = trip.features?.nowMode !== false;
  $('feature-expenses').checked = trip.features?.expenses !== false;
  $('feature-notifications').checked = trip.features?.notifications === true;
  if ($('trip-planning-notes')) {
    $('trip-planning-notes').value = state.activePlanning?.notes || '';
  }
  renderDaySelect();
  renderEditorCards();
  renderCandidateList();
  hideEditorErrors();
  renderTripAudit();
  refreshAdminDiscussionRooms();
}

const CATEGORY_NAMES = {
  gourmet: '食事',
  sightseeing: '観光',
  hotel: '宿泊',
  transport: '交通',
  other: 'その他'
};

const CATEGORY_BADGES = {
  gourmet: 'GOURMET',
  sightseeing: 'SPOT',
  hotel: 'HOTEL',
  transport: 'TRANSPORT',
  other: 'OTHER'
};

const PRIORITY_NAMES = {
  high: '行きたい',
  normal: 'できれば',
  low: '時間があれば'
};

function renderCandidateList() {
  const list = $('editor-candidate-list');
  if (!list) return;
  list.replaceChildren();
  const candidates = state.activePlanning?.candidates || [];
  const filterStatus = state.candidateFilterStatus || 'all';
  const filterCategory = state.candidateFilterCategory || 'all';

  const filtered = candidates.filter(item => {
    if (filterStatus === 'draft' && item.status !== 'draft') return false;
    if (filterStatus === 'assigned' && item.status !== 'assigned') return false;
    if (filterCategory !== 'all' && item.category !== filterCategory) return false;
    return true;
  });

  if (!filtered.length) {
    const emptyMsg = candidates.length === 0
      ? '候補スポットはまだありません。「＋ 候補を追加」から行きたい場所やお店を登録できます。'
      : '条件に一致する候補スポットがありません。';
    list.append(makeElement('div', 'empty-state', emptyMsg));
    return;
  }

  filtered.forEach(candidate => {
    const card = makeElement('article', `candidate-card ${candidate.status === 'assigned' ? 'is-assigned' : ''}`);
    const header = makeElement('div', 'candidate-header');
    const titleWrap = makeElement('div', 'candidate-title-wrap');
    titleWrap.append(makeElement('strong', '', candidate.title));

    const badges = makeElement('div', 'candidate-badges');
    const catBadge = makeElement('span', 'candidate-badge', CATEGORY_NAMES[candidate.category] || candidate.category);
    catBadge.dataset.cat = candidate.category;
    badges.append(catBadge);

    const priBadge = makeElement('span', `candidate-priority-tag priority-${candidate.priority}`, PRIORITY_NAMES[candidate.priority] || candidate.priority);
    badges.append(priBadge);

    if (candidate.durationMinutes) {
      badges.append(makeElement('span', 'candidate-badge', `滞在 ${candidate.durationMinutes}分`));
    }

    const isAssigned = candidate.status === 'assigned';
    const statusTag = makeElement(
      'span',
      `candidate-status-tag ${isAssigned ? 'status-assigned' : 'status-draft'}`,
      isAssigned ? `${(candidate.assignedDay || '').toUpperCase()} に追加済` : '未配置'
    );
    badges.append(statusTag);
    titleWrap.append(badges);
    header.append(titleWrap);
    card.append(header);

    if (candidate.notes) {
      card.append(makeElement('p', 'candidate-notes-preview', candidate.notes));
    }

    const actions = makeElement('div', 'candidate-card-actions');
    const adoptBtn = makeElement('button', 'compact primary', isAssigned ? '日程に追加済み' : '日程に入れる');
    adoptBtn.disabled = isAssigned;
    adoptBtn.type = 'button';
    adoptBtn.addEventListener('click', () => openCandidateAdoptDialog(candidate.id));
    actions.append(adoptBtn);

    const editBtn = makeElement('button', 'compact ghost', '編集');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => openCandidateDialog(candidate.id));
    actions.append(editBtn);

    if (isAssigned) {
      const resetBtn = makeElement('button', 'compact ghost', '日程への追加を取り消す');
      resetBtn.type = 'button';
      resetBtn.addEventListener('click', () => resetCandidateStatus(candidate.id));
      actions.append(resetBtn);
    }

    const mapsUrl = mapHref(candidate);
    if (mapsUrl) {
      const mapsLink = makeElement('a', 'button compact ghost', 'MAP ↗');
      mapsLink.href = mapsUrl;
      mapsLink.target = '_blank';
      mapsLink.rel = 'noopener noreferrer';
      actions.append(mapsLink);
    }

    const deleteBtn = makeElement('button', 'compact danger', '削除');
    deleteBtn.type = 'button';
    deleteBtn.addEventListener('click', () => deleteCandidate(candidate.id));
    actions.append(deleteBtn);

    card.append(actions);
    list.append(card);
  });
}

function openCandidateDialog(candidateId = '') {
  if (!state.activePlanning) state.activePlanning = blankPlanning();
  const candidates = state.activePlanning.candidates;
  const candidate = candidateId ? candidates.find(c => c.id === candidateId) : null;

  $('candidate-id').value = candidate?.id || '';
  $('candidate-dialog-title').textContent = candidate ? '候補を編集' : '候補を追加';
  $('candidate-title').value = text(candidate?.title);
  $('candidate-category').value = candidate?.category || 'sightseeing';
  $('candidate-priority').value = candidate?.priority || 'normal';
  $('candidate-duration').value = String(candidate?.durationMinutes ?? 60);
  const maps = resolveMapFields(candidate);
  $('candidate-map-query').value = maps.mapQuery;
  $('candidate-map-url').value = maps.mapUrl;
  $('candidate-official').value = text(candidate?.official);
  $('candidate-official-label').value = text(candidate?.officialLabel);
  $('candidate-tabelog').value = text(candidate?.tabelog);
  $('candidate-jalan').value = text(candidate?.jalan);
  $('candidate-notes').value = text(candidate?.notes);

  $('delete-candidate').hidden = !candidate;
  $('reset-candidate-status').hidden = !(candidate && candidate.status === 'assigned');

  $('candidate-dialog').showModal();
}

function saveCandidate(event) {
  event.preventDefault();
  if (!state.activePlanning) state.activePlanning = blankPlanning();
  const candidateId = $('candidate-id').value.trim();
  const candidates = state.activePlanning.candidates;
  const existing = candidateId ? candidates.find(c => c.id === candidateId) : null;
  if (candidateId && !existing) return showToast('候補が見つかりません。開き直してください。', true);

  const raw = {
    ...existing,
    id: candidateId || `cand-${crypto.randomUUID()}`,
    title: $('candidate-title').value.trim(),
    category: $('candidate-category').value,
    priority: $('candidate-priority').value,
    durationMinutes: $('candidate-duration').value.trim() === '' ? NaN : Number($('candidate-duration').value),
    mapQuery: $('candidate-map-query').value.trim(),
    mapUrl: $('candidate-map-url').value.trim(),
    official: $('candidate-official').value.trim(),
    officialLabel: $('candidate-official-label').value.trim(),
    tabelog: $('candidate-tabelog').value.trim(),
    jalan: $('candidate-jalan').value.trim(),
    notes: $('candidate-notes').value.trim(),
    status: existing?.status || 'draft',
    assignedDay: existing?.assignedDay,
    assignedCardId: existing?.assignedCardId,
    createdAt: existing?.createdAt,
    updatedAt: new Date().toISOString()
  };

  const mapErrors = [...validateCandidateInput(raw), ...validateMapFields(raw, { allowLegacy: false })];
  if (mapErrors.length) return showToast(mapErrors.join('\n'), true);
  const cleaned = cleanCandidate(raw, candidates.length);
  if (!cleaned || !cleaned.title) {
    showToast('場所名・スポット名を入力してください。', true);
    return;
  }

  if (existing) {
    const index = candidates.findIndex(c => c.id === candidateId);
    if (index >= 0) candidates[index] = cleaned;
  } else {
    candidates.push(cleaned);
  }

  $('candidate-dialog').close();
  renderCandidateList();
  showToast('候補を反映しました。下書き保存でクラウドに保存してください。');
}

function deleteCandidate(candidateId) {
  if (!state.activePlanning) return;
  const candidates = state.activePlanning.candidates;
  const index = candidates.findIndex(c => c.id === candidateId);
  if (index < 0) return;
  const target = candidates[index];
  const msg = target.status === 'assigned'
    ? `「${target.title}」は日程に組み込まれています。候補リストから削除しますか？（日程のカードは残ります）`
    : `「${target.title}」を候補から削除しますか？`;
  if (!window.confirm(msg)) return;
  candidates.splice(index, 1);
  if ($('candidate-dialog').open) $('candidate-dialog').close();
  renderCandidateList();
  showToast('候補スポットを削除しました。');
}

function resetCandidateStatus(candidateId) {
  const assignment = inspectAssignment(state.activeTrip, state.activePlanning, candidateId);
  if (assignment.error) return showToast(`${assignment.error}日程カードを確認してください。`, true);
  if (!window.confirm(`「${assignment.card.title}」のカードを日程から取り除き、候補に戻しますか？`)) return;
  const result = unassignCandidate(state.activeTrip, state.activePlanning, candidateId);
  if (result.error) return showToast(result.error, true);
  state.activeTrip = result.trip;
  state.activePlanning = result.planning;
  if ($('candidate-dialog').open) $('candidate-dialog').close();
  renderEditor();
  showToast(result.warnings.join(' ') || '日程への追加を取り消しました。下書き保存してください。');
}

function calculateNextAvailableTime(dayKey, travelMinutes = 0) {
  const cards = state.activeTrip?.days?.[dayKey] || [];
  if (!cards.length) {
    const dep = state.activeTrip?.daySettings?.[dayKey]?.departureTime;
    return dep || '09:00';
  }
  const lastCard = cards[cards.length - 1];
  const range = parseTimeRange(lastCard.time);
  if (!range) return '09:00';
  const startMinute = range.end + travelMinutes;
  return formatMinute(startMinute);
}

function openCandidateAdoptDialog(candidateId) {
  if (!state.activePlanning) return;
  const candidate = state.activePlanning.candidates.find(c => c.id === candidateId);
  if (!candidate) return;
  if (candidate.status === 'assigned') return showToast('この候補は追加済みです。変更する場合は日程カードを編集してください。', true);
  state.activeCandidateForAdopt = candidate;

  $('adopt-candidate-id').value = candidate.id;
  const summaryBox = $('adopt-candidate-summary');
  summaryBox.replaceChildren();
  summaryBox.append(makeElement('strong', '', `候補: ${candidate.title}`));
  const detailText = `分類: ${CATEGORY_NAMES[candidate.category] || candidate.category} · 想定滞在時間: ${candidate.durationMinutes || 60}分${candidate.priority ? ` · 優先度: ${PRIORITY_NAMES[candidate.priority]}` : ''}`;
  summaryBox.append(makeElement('p', '', detailText));

  const daySelect = $('adopt-day-select');
  daySelect.replaceChildren();
  const dayKeys = Object.keys(state.activeTrip.days);
  dayKeys.forEach((dayKey, index) => {
    const option = document.createElement('option');
    option.value = dayKey;
    option.textContent = `${dayKey.toUpperCase()} · ${state.activeTrip.dayLabels[dayKey] || `DAY ${index + 1}`}`;
    if (dayKey === (candidate.assignedDay || state.activeDayKey || dayKeys[0])) option.selected = true;
    daySelect.append(option);
  });

  updateAdoptPositionOptions();

  const duration = candidate.durationMinutes || 60;
  $('adopt-duration-minutes').value = String(duration);
  $('adopt-travel-minutes').value = '0';
  $('adopt-card-desc').value = '';

  const initialDay = daySelect.value;
  const initialStartTime = calculateNextAvailableTime(initialDay, 0);
  $('adopt-start-time').value = initialStartTime;

  updateAdoptPreview();
  $('candidate-adopt-dialog').showModal();
}

function updateAdoptPositionOptions() {
  const dayKey = $('adopt-day-select').value;
  const posSelect = $('adopt-position-select');
  posSelect.replaceChildren();
  const cards = state.activeTrip?.days?.[dayKey] || [];

  if (!cards.length) {
    const opt = document.createElement('option');
    opt.value = 'end';
    opt.textContent = '先頭に追加（1番目のカード）';
    posSelect.append(opt);
    return;
  }

  const startOpt = document.createElement('option');
  startOpt.value = 'start';
  startOpt.textContent = '先頭に追加';
  posSelect.append(startOpt);

  cards.forEach((card, index) => {
    const opt = document.createElement('option');
    opt.value = String(index + 1);
    opt.textContent = `${index + 1}. 「${card.title || '無題'}」の後に追加`;
    posSelect.append(opt);
  });

  const endOpt = document.createElement('option');
  endOpt.value = 'end';
  endOpt.textContent = `末尾に追加（${cards.length + 1}番目）`;
  endOpt.selected = true;
  posSelect.append(endOpt);
}

function readAdoptPlacement() {
  const dayKey = $('adopt-day-select').value;
  return validatePlacement({
    cards: state.activeTrip?.days?.[dayKey],
    position: $('adopt-position-select').value,
    startTime: $('adopt-start-time').value,
    durationMinutes: $('adopt-duration-minutes').value,
    travelMinutes: $('adopt-travel-minutes').value
  });
}

function updateAdoptPreview() {
  const candidate = state.activeCandidateForAdopt;
  const result = readAdoptPlacement();
  const previewBox = $('adopt-preview');
  previewBox.replaceChildren();
  if (!candidate) result.errors.push('候補を選び直してください。');
  if (candidate?.status === 'assigned') result.errors.push('この候補は日程に追加済みです。');
  $('adopt-end-time').value = result.time ? result.time.slice(-5) : '';
  $('confirm-adopt').disabled = result.errors.length > 0;
  const addRow = (time, title) => {
    const row = makeElement('div', 'adopt-preview-item');
    row.append(makeElement('span', 'adopt-preview-time', time || '未定'));
    row.append(makeElement('span', 'adopt-preview-title', title));
    previewBox.append(row);
  };
  if (result.prevCard) addRow(result.prevCard.time, `前: ${result.prevCard.title}`);
  addRow(result.time, `追加: ${candidate?.title || '未選択'}`);
  if (result.nextCard) addRow(result.nextCard.time, `次: ${result.nextCard.title}`);
  result.errors.forEach(message => previewBox.append(makeElement('div', 'adopt-preview-alert error', message)));
  result.warnings.forEach(message => previewBox.append(makeElement('div', 'adopt-preview-alert warning', message)));
  previewBox.classList.toggle('has-conflict', result.errors.length > 0);
  previewBox.classList.toggle('is-valid', result.errors.length === 0 && result.warnings.length === 0);
  if (!result.errors.length && !result.warnings.length) previewBox.append(makeElement('div', 'adopt-preview-alert is-ok', '前後の予定との重複はありません。'));
  const routeLink = $('adopt-maps-route-link');
  const routeUrl = mapRouteHref(result.prevCard, candidate);
  routeLink.hidden = !routeUrl;
  routeLink.href = routeUrl || '#';
  return result;
}

function confirmAdoptCandidate(event) {
  event.preventDefault();
  const candidate = state.activeCandidateForAdopt;
  if (!candidate || !state.activePlanning?.candidates.includes(candidate)) return;
  // Revalidate actual current inputs, even when submit bypasses the button.
  const result = updateAdoptPreview();
  if (result.errors.length) return showToast(result.errors[0], true);
  const desc = $('adopt-card-desc').value.trim();
  if (!desc) return showToast('参加者向けの説明文を入力してください。', true);
  if (result.warnings.length && !window.confirm(`${result.warnings.join('\n')}\n内容を確認して追加しますか？`)) return;
  const dayKey = $('adopt-day-select').value;
  const newCard = cleanCard({
    cardId: `card-${crypto.randomUUID()}`,
    time: result.time,
    badge: CATEGORY_BADGES[candidate.category] || 'SPOT',
    title: candidate.title,
    desc,
    mapQuery: mapSearchQuery(candidate),
    mapUrl: resolveMapFields(candidate).mapUrl,
    official: candidate.official,
    officialLabel: candidate.officialLabel,
    tabelog: candidate.tabelog,
    jalan: candidate.jalan,
    travelMinutesFromPrevious: Number($('adopt-travel-minutes').value) || undefined
  });
  // Keep private undo metadata; public cards never include this snapshot.
  if (result.nextCard) {
    const nextBefore = deepClone(result.nextCard);
    delete result.nextCard.travelMinutesFromPrevious;
    candidate.placementUndo = {
      dayKey,
      previousCardId: result.prevCard?.cardId || null,
      nextCardId: result.nextCard.cardId,
      nextBefore,
      nextAfter: deepClone(result.nextCard)
    };
  } else delete candidate.placementUndo;
  state.activeTrip.days[dayKey].splice(result.insertIndex, 0, newCard);
  candidate.status = 'assigned';
  candidate.assignedDay = dayKey;
  candidate.assignedCardId = newCard.cardId;
  if (typeof readDaySettings === 'function') readDaySettings();
  $('candidate-adopt-dialog').close();
  state.activeDayKey = dayKey;
  renderDaySelect();
  renderEditorCards();
  renderCandidateList();
  renderTripAudit();
  showToast(`「${candidate.title}」を日程に追加しました。下書き保存で確定してください。`);
}


function renderDaySelect() {
  const select = $('editor-day-select');
  select.replaceChildren();
  Object.keys(state.activeTrip.days).forEach((dayKey, index) => {
    const option = document.createElement('option');
    option.value = dayKey;
    option.textContent = `${dayKey.toUpperCase()} · ${state.activeTrip.dayLabels[dayKey] || `DAY ${index + 1}`}`;
    option.selected = dayKey === state.activeDayKey;
    select.append(option);
  });
  $('editor-day-label').value = state.activeTrip.dayLabels[state.activeDayKey] || '';
  $('editor-day-departure').value = state.activeTrip.daySettings?.[state.activeDayKey]?.departureTime || '';
  $('editor-day-note').value = state.activeTrip.daySettings?.[state.activeDayKey]?.note || '';
}

function renderEditorCards() {
  const list = $('editor-card-list');
  list.replaceChildren();
  const cards = state.activeTrip?.days?.[state.activeDayKey] || [];
  if (!cards.length) {
    list.append(makeElement('div', 'empty-state', 'この日のカードはまだありません。'));
    return;
  }
  cards.forEach((card, index) => {
    const row = makeElement('article', 'editor-card');
    row.draggable = true;
    row.dataset.cardIndex = String(index);
    row.addEventListener('dragstart', event => { row.classList.add('is-dragging'); event.dataTransfer.setData('text/plain', String(index)); });
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
    row.addEventListener('dragover', event => event.preventDefault());
    row.addEventListener('drop', event => {
      event.preventDefault();
      const from = Number(event.dataTransfer.getData('text/plain'));
      if (!Number.isInteger(from) || from === index) return;
      previewCardReorder(from, index);
    });
    row.append(makeElement('div', 'editor-card-time', card.time || '—'));
    const copy = makeElement('div');
    copy.append(makeElement('strong', '', card.title || 'タイトル未設定'));
    const meta = makeElement('div', 'card-meta-line');
    meta.append(makeElement('span', '', `${card.badge || 'CARD'}${card.expenseShortcut ? ' · 割り勘' : ''}`));
    if (card.timeLocked) meta.append(makeElement('span', 'time-locked-indicator', ' 🔒 固定予定'));
    copy.append(meta);
    const actions = makeElement('div', 'actions');
    const edit = makeElement('button', 'compact', '編集');
    edit.type = 'button';
    edit.addEventListener('click', () => openCardDialog(index));
    actions.append(edit);
    row.append(copy, actions);
    list.append(row);
  });
}

function addDay() {
  readTripBasics();
  if (typeof readDaySettings === 'function') readDaySettings();
  const numbers = Object.keys(state.activeTrip.days).map(key => Number((key.match(/\d+/) || [0])[0]));
  const next = Math.max(0, ...numbers) + 1;
  const dayKey = `day${next}`;
  state.activeTrip.days[dayKey] = [];
  state.activeTrip.dayLabels[dayKey] = `DAY ${next}`;
  state.activeDayKey = dayKey;
  renderDaySelect();
  renderEditorCards();
}

function parseCardLinks(value) {
  return text(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const [label = '', url = '', androidUrl = '', iosUrl = '', icon = ''] = line.split('|').map(part => part.trim());
    const link = { label, url };
    if (label === 'ルート') link.kind = 'route';
    if (androidUrl) link.androidUrl = androidUrl;
    if (iosUrl) link.iosUrl = iosUrl;
    if (icon) link.icon = icon;
    return link;
  });
}

function formatCardLinks(links) {
  return (Array.isArray(links) ? links : []).map(link => [link?.label, link?.url, link?.androidUrl, link?.iosUrl, link?.icon].map(value => text(value).trim()).join(' | ').replace(/(?:\s*\|\s*)+$/, '')).join('\n');
}

const BUTTON_PRESETS = {
  route: 'ルート | https://www.google.com/maps/dir/?api=1',
  ana: 'ANA | https://www.ana.co.jp/ | intent://#Intent;scheme=https;package=jp.co.ana.android.travel;end | anaapp:// | ana',
  toyota: 'TOYOTA | https://rent.toyota.co.jp/cp/18_ser_app01/ | intent://#Intent;scheme=toyotaapp;package=jp.co.toyota.rent.app.android;S.browser_fallback_url=https%3A%2F%2Frent.toyota.co.jp%2Fcp%2F18_ser_app01%2F;end | toyotaapp:// | toyota',
  jalan: 'じゃらん | https://www.jalan.net/ | intent://#Intent;scheme=jalan;package=net.jalan.android;S.browser_fallback_url=https%3A%2F%2Fwww.jalan.net%2F;end | https://www.jalan.net/ | jalan',
  'hello-cycling': '自転車 | https://www.hellocycling.jp/ | intent://main/#Intent;scheme=hellocycling;package=jp.hellocycling.hellocycling;S.browser_fallback_url=https%3A%2F%2Fwww.hellocycling.jp%2F;end | hellocycling://main | helloCycling'
};

function addPresetLink(presetKey) {
  const preset = BUTTON_PRESETS[presetKey];
  if (!preset) return;
  const current = $('card-links').value.trim();
  $('card-links').value = current ? `${current}\n${preset}` : preset;
  $('card-links').dispatchEvent(new Event('input', { bubbles: true }));
}

function cardFieldMap() {
  return {
    time: $('card-time').value.trim(),
    badge: $('card-badge').value.trim(),
    title: $('card-title').value.trim(),
    desc: $('card-desc').value.trim(),
    mapQuery: $('card-map-query').value.trim(),
    mapUrl: $('card-map-url').value.trim(),
    official: $('card-official').value.trim(),
    officialLabel: $('card-official-label').value.trim(),
    tabelog: $('card-tabelog').value.trim(),
    jalan: $('card-jalan').value.trim(),
    image: $('card-image').value.trim(),
    links: parseCardLinks($('card-links').value),
    timeLocked: $('card-time-locked').checked,
    expenseShortcut: $('card-expense').checked,
    travelMinutesFromPrevious: Number($('card-travel-minutes').value),
    notifyBeforeMinutes: $('card-notify').value.split(',').filter(value => value.trim() !== '').map(value => Number(value.trim())),
    constraints: {
      opensAt: $('card-opens-at').value,
      closesAt: $('card-closes-at').value,
      reservationAt: $('card-reservation-at').value,
      lastEntryAt: $('card-last-entry-at').value,
      departureBy: $('card-departure-by').value,
      arrivalBufferMinutes: Number($('card-arrival-buffer').value)
    },
    reservation: {
      number: $('card-reservation-number').value.trim(),
      name: $('card-reservation-name').value.trim(),
      phone: $('card-reservation-phone').value.trim(),
      deadline: $('card-reservation-deadline').value.trim(),
      url: $('card-reservation-url').value.trim(),
      note: $('card-reservation-note').value.trim()
    }
  };
}

function cleanCard(card) {
  const cleaned = {};
  ['time', 'badge', 'title', 'desc', 'mapQuery', 'official', 'officialLabel', 'tabelog', 'jalan', 'image'].forEach(key => {
    const value = text(card?.[key]).trim();
    if (value) cleaned[key] = value;
  });
  delete cleaned.mapQuery;
  const mapFields = resolveMapFields(card);
  if (mapFields.mapQuery) cleaned.mapQuery = mapFields.mapQuery;
  if (mapFields.mapUrl) cleaned.mapUrl = mapFields.mapUrl;
  const links = (Array.isArray(card?.links) ? card.links : []).map(link => {
    const label = text(link?.label).trim();
    const url = text(link?.url).trim();
    if (!label && !url) return null;
    const result = link?.kind === 'route' || label === 'ルート' ? { label, url, kind: 'route' } : { label, url };
    for (const key of ['androidUrl', 'iosUrl', 'icon']) if (link[key]) result[key] = link[key];
    return result;
  }).filter(Boolean);
  if (links.length) cleaned.links = links;
  if (card?.timeLocked === true) cleaned.timeLocked = true;
  if (card?.expenseShortcut === true) cleaned.expenseShortcut = true;
  const travelMinutes = Math.max(0, Math.min(1440, Math.round(Number(card?.travelMinutesFromPrevious) || 0)));
  if (travelMinutes) cleaned.travelMinutesFromPrevious = travelMinutes;
  const notify = Array.from(new Set((Array.isArray(card?.notifyBeforeMinutes) ? card.notifyBeforeMinutes : []).map(Number).filter(value => Number.isFinite(value) && value >= 0 && value <= 10080)));
  if (notify.length) cleaned.notifyBeforeMinutes = notify;
  const constraints = Object.fromEntries(Object.entries(card?.constraints || {}).filter(([, value]) => value !== '' && value != null && value !== 0));
  if (Object.keys(constraints).length) cleaned.constraints = constraints;
  const reservation = Object.fromEntries(Object.entries(card?.reservation || {}).map(([key, value]) => [key, text(value).trim()]).filter(([, value]) => value));
  if (Object.keys(reservation).length) cleaned.reservation = reservation;
  if (card?.cardId) cleaned.cardId = text(card.cardId).trim();
  cleaned.links = links.map((link, index) => {
    const source = card.links[index] || {};
    ['androidUrl', 'iosUrl', 'icon'].forEach(key => { if (source[key]) link[key] = text(source[key]).trim(); });
    return link;
  });
  if (!cleaned.links.length) delete cleaned.links;
  return cleaned;
}

function openCardDialog(index = -1) {
  const cards = state.activeTrip.days[state.activeDayKey];
  const card = index >= 0 ? cards[index] : {};
  $('card-index').value = String(index);
  $('card-dialog-title').textContent = index >= 0 ? 'カードを編集' : 'カードを追加';
  $('card-time').value = text(card.time);
  $('card-badge').value = text(card.badge);
  $('card-title').value = text(card.title);
  $('card-desc').value = text(card.desc);
  $('card-map-query').value = text(card.mapQuery);
  $('card-map-url').value = text(card.mapUrl);
  $('card-official').value = text(card.official);
  $('card-official-label').value = text(card.officialLabel);
  $('card-tabelog').value = text(card.tabelog);
  $('card-jalan').value = text(card.jalan);
  $('card-image').value = text(card.image);
  $('card-links').value = formatCardLinks(card.links);
  $('card-time-locked').checked = card.timeLocked === true;
  $('card-expense').checked = card.expenseShortcut === true;
  $('card-travel-minutes').value = card.travelMinutesFromPrevious || '';
  $('card-notify').value = (card.notifyBeforeMinutes || []).join(', ');
  $('card-opens-at').value = card.constraints?.opensAt || '';
  $('card-closes-at').value = card.constraints?.closesAt || '';
  $('card-reservation-at').value = card.constraints?.reservationAt || '';
  $('card-last-entry-at').value = card.constraints?.lastEntryAt || '';
  $('card-departure-by').value = card.constraints?.departureBy || '';
  $('card-arrival-buffer').value = card.constraints?.arrivalBufferMinutes || '';
  $('card-reservation-number').value = card.reservation?.number || '';
  $('card-reservation-name').value = card.reservation?.name || '';
  $('card-reservation-phone').value = card.reservation?.phone || '';
  $('card-reservation-deadline').value = card.reservation?.deadline || '';
  $('card-reservation-url').value = card.reservation?.url || '';
  $('card-reservation-note').value = card.reservation?.note || '';
  $('delete-card').hidden = index < 0;
  $('move-card-up').hidden = index <= 0;
  $('move-card-down').hidden = index < 0 || index >= cards.length - 1;
  $('open-move-day').hidden = index < 0;
  $('open-cascade-adjust').hidden = index < 0;
  $('card-dialog').showModal();
}

function saveCard(event) {
  event.preventDefault();
  const index = Number($('card-index').value);
  const cards = state.activeTrip.days[state.activeDayKey];
  const base = index >= 0 ? cards[index] : {};
  const raw = { ...base, ...cardFieldMap(), cardId: base.cardId || `card-${crypto.randomUUID()}` };
  const mapErrors = [...validateTripInput({ tripId: state.activeTrip.tripId, title: state.activeTrip.title, days: { day1: [raw] } }), ...validateMapFields(raw, { allowLegacy: false })];
  if (mapErrors.length) return showToast(mapErrors.join('\n'), true);
  const next = cleanCard(raw);
  if (!next.title || !next.desc) {
    showToast('タイトルと説明を入力してください。', true);
    return;
  }
  const beforeTime = base.time || '';
  const afterTime = next.time || '';
  if (index >= 0 && base.timeLocked === true && beforeTime !== afterTime) {
    const msg = afterTime
      ? `「${base.title || 'この予定'}」は固定予定（timeLocked）です。時刻を「${beforeTime || '未定'}」から「${afterTime}」へ変更しますか？`
      : `「${base.title || 'この予定'}」は固定予定（timeLocked）です。設定時刻（${beforeTime}）を削除して未定にしますか？`;
    if (!window.confirm(msg)) {
      return;
    }
  }
  if (index >= 0) cards[index] = next;
  else cards.push(next);
  $('card-dialog').close();
  renderEditorCards();
}


function deleteCard() {
  const index = Number($('card-index').value);
  const cards = state.activeTrip?.days?.[state.activeDayKey];
  if (!Array.isArray(cards) || !Number.isInteger(index) || index < 0 || index >= cards.length) return;
  if (!window.confirm('このカードを削除しますか？')) return;
  const target = cards[index];
  const candidate = target.cardId && state.activePlanning?.candidates.find(item => item.assignedCardId === target.cardId);
  const result = candidate ? unassignCandidate(state.activeTrip, state.activePlanning, candidate.id) : null;
  if (result && !result.error) {
    state.activeTrip = result.trip;
    state.activePlanning = result.planning;
  } else {
    cards.splice(index, 1);
    if (cards[index]) delete cards[index].travelMinutesFromPrevious;
    state.activePlanning = reconcileAssignments(state.activeTrip, state.activePlanning);
  }
  state.activeCandidateForAdopt = null;
  $('card-dialog').close();
  renderCandidateList();
  renderEditorCards();
  renderTripAudit();
  if (result?.warnings.length) showToast(result.warnings.join(' '));
}

function moveCard(direction) {
  const index = Number($('card-index').value);
  const cards = state.activeTrip?.days?.[state.activeDayKey] || [];
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= cards.length) return;
  $('card-dialog').close();
  previewCardReorder(index, destination);
}

function previewCardReorder(fromIndex, toIndex, options = {}) {
  const dayKey = state.activeDayKey;
  const cards = state.activeTrip?.days?.[dayKey] || [];
  const plan = planCardReorder(cards, fromIndex, toIndex, { ...options, dayKey });

  const updatedTrip = structuredClone(state.activeTrip);
  updatedTrip.days[dayKey] = plan.updatedCards;

  openPlannerCompareDialog({
    title: `並べ替えの確認 (${dayKey.toUpperCase()})`,
    planResult: plan,
    updatedTrip,
    dayKey,
    isReorder: true,
    fromIndex,
    toIndex
  });
}

function autoAdjustAndReplan() {
  if (!state.activePendingPlan?.isReorder) return;
  const { fromIndex, toIndex } = state.activePendingPlan;
  previewCardReorder(fromIndex, toIndex, { autoAdjustCascade: true });
}

function openMoveDayDialog(cardIndex) {
  const cards = state.activeTrip?.days?.[state.activeDayKey] || [];
  const card = cards[cardIndex];
  if (!card) return;

  $('move-day-card-index').value = String(cardIndex);
  $('move-day-card-summary').textContent = `対象: 「${card.title}」 (${card.time || '時刻未定'})${card.timeLocked ? ' 🔒 固定予定' : ''}`;
  $('move-day-allow-locked').checked = false;

  const targetSelect = $('move-day-target-select');
  targetSelect.replaceChildren();
  Object.keys(state.activeTrip.days).forEach((dk, i) => {
    if (dk !== state.activeDayKey) {
      const opt = document.createElement('option');
      opt.value = dk;
      opt.textContent = `${dk.toUpperCase()} · ${state.activeTrip.dayLabels[dk] || `DAY ${i + 1}`}`;
      targetSelect.append(opt);
    }
  });

  if (!targetSelect.options.length) {
    showToast('移動先となる他の日がありません。「+ 日を追加」してください。', true);
    return;
  }

  updateMoveDayPositionOptions();

  const range = parseTimeRange(card.time);
  $('move-day-start-time').value = range ? formatMinute(range.start) : '09:00';
  $('move-day-duration-minutes').value = range ? String(range.end - range.start) : '60';
  $('move-day-travel-minutes').value = card.travelMinutesFromPrevious ? String(card.travelMinutesFromPrevious) : '0';

  $('card-dialog').close();
  $('move-day-dialog').showModal();
}

function updateMoveDayPositionOptions() {
  const toDay = $('move-day-target-select').value;
  const targetCards = state.activeTrip?.days?.[toDay] || [];
  const posSelect = $('move-day-position-select');
  posSelect.replaceChildren();

  const optStart = document.createElement('option');
  optStart.value = 'start';
  optStart.textContent = '日の先頭（1番目）';
  posSelect.append(optStart);

  targetCards.forEach((c, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx + 1);
    opt.textContent = `${idx + 1}. 「${c.title}」の後`;
    posSelect.append(opt);
  });

  const optEnd = document.createElement('option');
  optEnd.value = 'end';
  optEnd.textContent = '日の末尾に追加';
  optEnd.selected = true;
  posSelect.append(optEnd);
}

function previewMoveDay(event) {
  event.preventDefault();
  const fromIndex = Number($('move-day-card-index').value);
  const fromDayKey = state.activeDayKey;
  const toDayKey = $('move-day-target-select').value;
  const toPosition = $('move-day-position-select').value;
  const startTime = $('move-day-start-time').value;
  const durationMinutes = Number($('move-day-duration-minutes').value);
  const travelMinutes = Number($('move-day-travel-minutes').value);
  const allowTimeLockedMove = $('move-day-allow-locked').checked;

  const plan = planCardMoveDay(state.activeTrip, fromDayKey, fromIndex, toDayKey, toPosition, {
    startTime,
    durationMinutes,
    travelMinutes,
    allowTimeLockedMove
  });

  $('move-day-dialog').close();

  openPlannerCompareDialog({
    title: `別日移動の確認 (${fromDayKey.toUpperCase()} → ${toDayKey.toUpperCase()})`,
    planResult: plan,
    updatedTrip: plan.updatedTrip,
    dayKey: toDayKey
  });
}

function openCascadeAdjustDialog(cardIndex) {
  const cards = state.activeTrip?.days?.[state.activeDayKey] || [];
  const card = cards[cardIndex];
  if (!card) return;

  $('cascade-card-index').value = String(cardIndex);
  $('cascade-card-summary').textContent = `起点: 「${card.title}」 (${card.time || '時刻未定'})${card.timeLocked ? ' 🔒 固定予定' : ''}`;

  const range = parseTimeRange(card.time);
  $('cascade-start-time').value = range ? formatMinute(range.start) : '09:00';
  $('cascade-duration-minutes').value = range ? String(range.end - range.start) : '60';

  $('card-dialog').close();
  $('cascade-adjust-dialog').showModal();
}

function previewCascadeAdjust(event) {
  event.preventDefault();
  const cardIndex = Number($('cascade-card-index').value);
  const dayKey = state.activeDayKey;
  const cards = state.activeTrip?.days?.[dayKey] || [];
  const startTime = $('cascade-start-time').value;
  const durationMinutes = Number($('cascade-duration-minutes').value);

  const plan = planCascadeTimeAdjustment(cards, cardIndex, startTime, durationMinutes, { dayKey });

  const updatedTrip = structuredClone(state.activeTrip);
  updatedTrip.days[dayKey] = plan.updatedCards;

  $('cascade-adjust-dialog').close();

  openPlannerCompareDialog({
    title: `後続時刻調整の確認 (${dayKey.toUpperCase()})`,
    planResult: plan,
    updatedTrip,
    dayKey
  });
}

function renderDiffList(diffs = [], container) {
  if (diffs.length === 0) {
    container.append(makeElement('div', 'empty-state', '差分はありません。'));
    return;
  }
  diffs.forEach(item => {
    const row = makeElement('div', `planner-diff-item ${item.type}`);
    const badge = makeElement('span', 'planner-diff-badge',
      item.type === 'added' ? '+ 追加' :
      item.type === 'modified' ? '~ 変更' :
      item.type === 'removed' ? '- 除外' : '= 変更なし'
    );
    const label = makeElement('span', '', item.title);
    const timeInfo = makeElement('small', 'muted',
      item.beforeTime && item.afterTime && item.beforeTime !== item.afterTime
        ? `${item.beforeTime} → ${item.afterTime}`
        : item.afterTime || item.beforeTime || '—'
    );
    row.append(badge, label, timeInfo);
    if (item.timeLocked) row.append(makeElement('span', 'time-locked-indicator', ' 🔒'));
    container.append(row);
  });
}

function openPlannerCompareDialog({ title, planResult, updatedTrip, dayKey, isReorder = false, fromIndex = -1, toIndex = -1 }) {
  state.activePendingPlan = {
    updatedTrip,
    planResult,
    dayKey,
    expectedBaseTrip: structuredClone(state.activeTrip),
    isReorder,
    fromIndex,
    toIndex
  };

  $('planner-compare-title').textContent = title;
  $('planner-compare-summary').textContent = planResult.fromDayKey && planResult.toDayKey
    ? `移動元: ${planResult.fromDayKey.toUpperCase()} ➔ 移動先: ${planResult.toDayKey.toUpperCase()}`
    : `対象日: ${dayKey.toUpperCase()}`;

  const diffContainer = $('planner-compare-diff');
  diffContainer.replaceChildren();

  if (planResult.fromDiff && planResult.toDiff) {
    // 別日移動：移動元と移動先を分けて表示
    const fromHead = makeElement('h4', 'planner-diff-section-head', `【移動元】${planResult.fromDayKey.toUpperCase()}`);
    diffContainer.append(fromHead);
    renderDiffList(planResult.fromDiff.diffs, diffContainer);

    const toHead = makeElement('h4', 'planner-diff-section-head', `【移動先】${planResult.toDayKey.toUpperCase()}`);
    diffContainer.append(toHead);
    renderDiffList(planResult.toDiff.diffs, diffContainer);
  } else {
    const diffs = planResult.diff?.diffs || [];
    renderDiffList(diffs, diffContainer);
  }

  const alertContainer = $('planner-compare-alerts');
  alertContainer.replaceChildren();

  const errors = planResult.errors || [];
  const warnings = planResult.warnings || [];

  if (errors.length > 0) {
    alertContainer.className = 'adopt-preview-box has-conflict';
    errors.forEach(msg => {
      alertContainer.append(makeElement('div', 'adopt-preview-alert error', `⛔ ${msg}`));
    });
  } else if (warnings.length > 0) {
    alertContainer.className = 'adopt-preview-box has-conflict';
    warnings.forEach(msg => {
      alertContainer.append(makeElement('div', 'adopt-preview-alert warning', `⚠️ ${msg}`));
    });
  } else {
    alertContainer.className = 'adopt-preview-box is-valid';
    alertContainer.append(makeElement('div', 'adopt-preview-alert', '✅ 時間重複や制限エラーはありません。'));
  }

  $('planner-compare-auto-adjust').hidden = !(isReorder && planResult.canAutoAdjust);
  $('confirm-planner-compare').disabled = errors.length > 0;
  $('planner-compare-dialog').showModal();
}

function confirmPlannerCompare(event) {
  event.preventDefault();
  if (!state.activePendingPlan?.planResult) return;

  const res = applyDayPlan({
    currentTrip: state.activeTrip,
    currentPlanning: state.activePlanning,
    planResult: state.activePendingPlan.planResult,
    expectedBaseTrip: state.activePendingPlan.expectedBaseTrip,
    dayKey: state.activePendingPlan.dayKey
  });

  if (res.error) {
    showToast(`変更を適用できません: ${res.error}`, true);
    return;
  }

  state.activeTrip = res.trip;
  state.activePlanning = res.planning;
  state.lastDayPlanUndo = res.undoSnapshot;
  state.activePendingPlan = null;

  $('undo-day-plan').hidden = false;
  $('planner-compare-dialog').close();
  renderEditorCards();
  renderCandidateList();
  renderTripAudit();
  showToast('日程の変更案を適用しました。内容を確認して下書き保存してください。');
}

function undoLastDayPlan() {
  if (!state.lastDayPlanUndo) return;
  const res = undoDayPlan({
    currentTrip: state.activeTrip,
    currentPlanning: state.activePlanning,
    undoSnapshot: state.lastDayPlanUndo
  });

  if (res.error) {
    showToast(`取り消しできません: ${res.error}`, true);
    return;
  }

  state.activeTrip = res.trip;
  state.activePlanning = res.planning;
  state.lastDayPlanUndo = null;
  $('undo-day-plan').hidden = true;

  renderEditorCards();
  renderCandidateList();
  renderTripAudit();
  showToast('直前の日程変更を取り消しました。');
}


function validateTrip(trip) {
  const errors = [];
  const validDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text(value))) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  const scheduledMinutes = value => {
    const match = text(value).match(/^(\d{2}):(\d{2}) - (\d{2}):(\d{2})$/);
    if (!match) return null;
    const [startHour, startMinute, endHour, endMinute] = match.slice(1).map(Number);
    if (startHour > 23 || startMinute > 59 || endHour > 23 || endMinute > 59) return null;
    return { start: startHour * 60 + startMinute, end: endHour * 60 + endMinute };
  };
  const validUrl = value => {
    if (!text(value).trim()) return true;
    try {
      const parsed = new URL(text(value).trim());
      return parsed.protocol === 'https:' && Boolean(parsed.hostname);
    } catch (error) {
      return false;
    }
  };
  if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(trip.tripId)) errors.push('旅行IDは英小文字・数字・_・-で3〜40文字にしてください。');
  if (!trip.title || text(trip.title).length > 120) errors.push('旅行タイトルは1〜120文字で入力してください。');
  if (!validDate(trip.startDate)) errors.push('開始日を正しい日付で入力してください。');
  if (!validDate(trip.endDate)) errors.push('終了日を正しい日付で入力してください。');
  if (trip.startDate && trip.endDate && trip.startDate > trip.endDate) errors.push('終了日は開始日以降にしてください。');
  for (const [dayKey, cards] of Object.entries(trip.days || {})) {
    if (!Array.isArray(cards)) {
      errors.push(`${dayKey}: カード配列が不正です。`);
      continue;
    }
    let previousEnd = -1;
    cards.forEach((card, index) => {
      const label = `${dayKey.toUpperCase()} カード${index + 1}`;
      if (!card.title) errors.push(`${label}: タイトルがありません。`);
      if (text(card.title).length > 120) errors.push(`${label}: タイトルは120文字以内にしてください。`);
      if (!card.badge) errors.push(`${label}: バッジがありません。`);
      if (!card.desc) errors.push(`${label}: 説明がありません。`);
      if (text(card.desc).length > 240) errors.push(`${label}: 説明は240文字以内にしてください。`);
      const minutes = scheduledMinutes(card.time);
      if (!minutes || minutes.end <= minutes.start) {
        errors.push(`${label}: 時刻は「09:00 - 10:00」形式で、終了を開始より後にしてください。`);
      } else {
        if (minutes.start < previousEnd) errors.push(`${label}: 前の予定と時刻が重複しています。`);
        previousEnd = Math.max(previousEnd, minutes.end);
      }
      ['official', 'tabelog', 'jalan'].forEach(key => {
        if (!validUrl(card[key])) errors.push(`${label}: ${key} は https URLにしてください。`);
      });
      for (const [linkIndex, link] of (Array.isArray(card.links) ? card.links : []).entries()) {
        if (!text(link?.label).trim()) errors.push(`${label}: 追加リンク${linkIndex + 1}の名前がありません。`);
        if (!text(link?.url).trim() || !validUrl(link?.url)) errors.push(`${label}: 追加リンク${linkIndex + 1}は https URLにしてください。`);
        if (link?.kind != null && link.kind !== 'route') errors.push(`${label}: 追加リンク${linkIndex + 1}のkindはrouteだけ指定できます。`);
      }
      if (card.image && !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif|svg)$/i.test(text(card.image))) errors.push(`${label}: 画像はimagesフォルダ内の安全なファイル名にしてください。`);
    });
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(trip)).length > 900000) errors.push('旅程データが大きすぎます。画像はファイル名で指定し、説明を短くしてください。');
  } catch (error) {
    errors.push('旅程データをJSONへ変換できません。');
  }
  return errors;
}

function hideEditorErrors() {
  $('editor-errors').hidden = true;
  $('editor-errors').textContent = '';
}

function showEditorErrors(errors) {
  $('editor-errors').hidden = false;
  $('editor-errors').textContent = `保存前に確認してください\n・${errors.join('\n・')}`;
  $('editor-errors').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function persistTrip(publish = false) {
  if (state.tripWriteBusy || editorSession.saving) return showToast('保存処理が実行中です。', true);
  syncEditorInputs();
  const draftErrors = validateTripDraft(state.activeTrip, state.activePlanning);
  if (draftErrors.length) return showEditorErrors(draftErrors);
  let cleanTrip = stripPlanningForPublication(state.activeTrip);
  if (publish) {
    const report = analyzeTrip(state.activeTrip);
    renderTripAudit(report);
    if (report.errors.length) return showEditorErrors(report.errors.map(item => item.message));
    if (report.warnings.length && !window.confirm('警告が' + report.warnings.length + '件あります。確認済みとして公開しますか？')) return;
    cleanTrip = report.trip;
  }
  const button = publish ? $('publish-trip') : $('save-draft');
  let ticket;
  try {
    ticket = editorSession.beginSave(state.activeTrip, state.activePlanning);
    state.tripWriteBusy = true;
    hideEditorErrors();
    setBusy(button, true, publish ? '公開中…' : '保存中…');
    updateSaveStatus();
    const tripId = ticket.tripId;
    const planning = cleanPlanning(ticket.planning);
    const payloadJson = JSON.stringify(cleanTrip);
    const planningJson = JSON.stringify(planning);
    const sizeErrors = validateStoredDraftSize({ payloadJson, planningJson });
    if (sizeErrors.length) throw new Error(sizeErrors.join('\n'));
    const data = {
      tripId, title: cleanTrip.title,
      status: publish || state.publishedIds.has(tripId) ? 'published' : 'draft',
      payloadJson, planningJson, revision: crypto.randomUUID(),
      updatedAt: serverTimestamp(), updatedBy: state.currentUser.uid
    };
    const writes = [];
    const checks = [];
    if (publish) {
      const snapshot = await getDocs(collection(db, 'adminDistributions'));
      const distributions = snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
        .filter(item => item.tripId === tripId && item.status === 'active' && item.grantId);
      const grants = new Set();
      for (const distribution of distributions) {
        checks.push({ reference: doc(db, 'adminDistributions', distribution.id), fields: {
          tripId, status: 'active', grantId: distribution.grantId
        } });
        if (grants.has(distribution.grantId)) continue;
        grants.add(distribution.grantId);
        writes.push({ reference: doc(db, 'accessGrants', distribution.grantId), merge: true,
          data: { title: cleanTrip.title, payloadJson, publishedRevision: data.revision, updatedAt: serverTimestamp() } });
      }
      writes.push({ reference: doc(collection(db, 'tripHistories', tripId, 'versions')), data: {
        tripId, title: cleanTrip.title, payloadJson, schemaVersion: 2,
        revision: data.revision, publishedAt: serverTimestamp(), publishedBy: data.updatedBy
      } });
      writes.push({ reference: doc(db, 'publishedTrips', tripId), data: {
        tripId, title: cleanTrip.title, published: true, payloadJson,
        revision: data.revision, publishedAt: serverTimestamp(), updatedBy: data.updatedBy
      } });
    }
    const version = await commitTripRecord({ db, runTransaction,
      reference: doc(db, 'adminTrips', tripId), expectedVersion: ticket.expectedVersion,
      data, writes, checks });
    // Post-save records always use the submitted snapshot, never the active editor.
    state.trips.set(tripId, { trip: deepClone(cleanTrip), planning: deepClone(planning), source: 'cloud', version, updatedAt: new Date() });
    if (publish) {
      state.publishedIds.add(tripId);
      state.publishedTrips.set(tripId, deepClone(cleanTrip));
    }
    editorSession.finishSave(ticket, version);
    renderTripLibrary();
    populateTripSelects();
    showToast(publish ? '参加者ページへ公開しました。' : '下書きを保存しました。参加者ページは変わっていません。');
  } catch (error) {
    if (ticket) editorSession.failSave(ticket);
    console.error(error);
    showToast((publish ? '公開' : '保存') + 'できませんでした: ' + error.message, true);
  } finally {
    state.tripWriteBusy = false;
    setBusy(button, false);
    updateSaveStatus();
  }
}

function downloadDraftRecovery(tripId) {
  const raw = state.trips.get(tripId)?.rawDraft;
  if (!raw || !window.confirm('元データには非公開メモが含まれます。共有せず保管し、JSONを修復してから読み込んでください。書き出しますか？')) return;
  const blob = new Blob([JSON.stringify({ format: 'shiori-draft-recovery', version: 1, ...raw }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${tripId.replace(/[^a-zA-Z0-9_-]/g, '_')}.draft-recovery.json`;
    anchor.click();
  } finally { URL.revokeObjectURL(url); }
}

function downloadActiveTrip(adminBackup = false) {
  if (!state.activeTrip) return;
  if (state.dirtyDialogs.size) return showToast('開いている編集画面の入力を反映してから書き出してください。', true);
  if (adminBackup && !window.confirm('管理者専用バックアップには候補・非公開メモが含まれます。参加者などへ共有しないでください。書き出しますか？')) return;
  try {
    syncEditorInputs();
    const exportData = adminBackup ? buildAdminBackup(state.activeTrip, state.activePlanning) : buildTripExport(state.activeTrip);
    const blob = new Blob([`${JSON.stringify(exportData, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      const fileId = state.activeTrip.tripId.replace(/[^a-zA-Z0-9_-]/g, '_');
      anchor.download = `${fileId}${adminBackup ? '.admin-backup' : ''}.json`;
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    showToast(`書き出せません: ${error.message}`, true);
  }
}

async function reloadActiveDraft() {
  if (!state.activeTrip?.tripId || !confirmEditorLeave()) return;
  syncEditorInputs();
  const tripId = state.activeTrip.tripId;
  const generation = editorSession.generation;
  const inputRevision = state.editorInputRevision;
  const before = JSON.stringify({ trip: state.activeTrip, planning: state.activePlanning, dialogs: [...state.dirtyDialogs] });
  state.tripWriteBusy = true;
  updateSaveStatus();
  try {
    const snapshot = await getDoc(doc(db, 'adminTrips', tripId));
    if (!snapshot.exists()) throw new Error('クラウドに下書きがありません。現在の入力は保持しています。');
    const data = snapshot.data();
    const { trip, planning } = decodeDraftRecord(data, tripId);
    syncEditorInputs();
    const now = JSON.stringify({ trip: state.activeTrip, planning: state.activePlanning, dialogs: [...state.dirtyDialogs] });
    if (editorSession.generation !== generation || state.editorInputRevision !== inputRevision || now !== before) throw new Error('読込中に編集されたため中止しました。現在の入力は保持しています。');
    const version = draftVersion(data);
    state.trips.set(tripId, { trip: deepClone(trip), planning: deepClone(planning), version, source: 'cloud', updatedAt: data.updatedAt || null });
    state.activeTrip = trip;
    state.activePlanning = planning;
    state.activeDayKey = Object.keys(trip.days)[0] || 'day1';
    renderEditor();
    startEditorSession(true, version);
    renderTripLibrary();
    showToast('最新の下書きを読み込みました。');
  } catch (error) {
    showToast(`読み込めませんでした: ${error.message}`, true);
  } finally {
    state.tripWriteBusy = false;
    updateSaveStatus();
  }
}

async function importTrip(file) {
  if (!file) return;
  const generation = editorSession.generation;
  try {
    const imported = parseTripImport(JSON.parse(await file.text()));
    const parsed = imported.trip;
    const inputErrors = validateTripDraft(parsed, imported.planning || blankPlanning());
    if (inputErrors.length) throw new Error(inputErrors.join('\n'));
    if (editorSession.generation !== generation) return showToast('編集対象が変わったため、JSON読込を中止しました。', true);
    if (!confirmEditorLeave()) return;
    if (imported.kind !== 'participant' && !window.confirm('管理者用データです。非公開の候補・メモもこの旅行の下書きへ読み込みます。続けますか？')) return;
    if (parsed.tripId !== state.activeTrip?.tripId && state.trips.has(parsed.tripId)
      && !window.confirm('同じIDの旅行が既にあります。その旅行の下書きとして読み込みますか？')) return;
    const trip = normalizeTrip(parsed);
    const planning = imported.planning || blankPlanning();
    state.activeTrip = trip;
    state.activePlanning = planning;
    state.activeDayKey = Object.keys(state.activeTrip.days)[0] || 'day1';
    renderEditor();
    startEditorSession(false, state.trips.get(state.activeTrip.tripId)?.version ?? null);
    showToast('JSONを読み込みました。内容を確認して保存してください。');
  } catch (error) {
    showToast(`JSONを読み込めません: ${error.message}`, true);
  } finally {
    $('import-trip-file').value = '';
  }
}


function populateTripSelects() {
  const options = [...state.trips.entries()].sort((a, b) => text(a[1].trip.startDate).localeCompare(text(b[1].trip.startDate)));
  const select = $('distribution-trip');
  const selected = select.value;
  select.replaceChildren();
  options.forEach(([tripId, record]) => {
    const option = document.createElement('option');
    option.value = tripId;
    option.textContent = `${record.trip.title} (${tripId})`;
    select.append(option);
  });
  if (options.some(([tripId]) => tripId === selected)) select.value = selected;
}

function openDistribution(tripId = '') {
  if (showView('distribution') === false) return;
  if (tripId && state.trips.has(tripId)) $('distribution-trip').value = tripId;
}

function startDistributionListener() {
  state.distributionsUnsubscribe?.();
  state.distributionsUnsubscribe = onSnapshot(collection(db, 'adminDistributions'), snapshot => {
    const previousParticipants = new Map(state.distributions.map(item => [item.id, item.participants || []]));
    const previousRoomMembers = new Map(state.distributions.map(item => [item.id, item.roomMembers || []]));
    const previousRoomReady = new Map(state.distributions.map(item => [item.id, item.roomReady === true]));
    const previousExpenses = new Map(state.distributions.map(item => [item.id, item.expenses || []]));
    const previousExpenseState = new Map(state.distributions.map(item => [item.id, {
      ready: item.expensesReady === true,
      error: item.expensesError || ''
    }]));
    state.distributions = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data(),
      participants: previousParticipants.get(item.id) || [],
      roomMembers: previousRoomMembers.get(item.id) || [],
      roomReady: previousRoomReady.get(item.id) === true,
      expenses: previousExpenses.get(item.id) || [],
      expensesReady: previousExpenseState.get(item.id)?.ready === true,
      expensesError: previousExpenseState.get(item.id)?.error || ''
    })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderDistributions();
  }, error => {
    console.error(error);
    showToast('配布先一覧を取得できませんでした。', true);
  });
}

function participantAppUrl() {
  const url = new URL('./', window.location.href);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function participantRegistrationUrl(accessId) {
  const url = new URL('./', window.location.href);
  url.search = '';
  url.hash = `join=${encodeURIComponent(text(accessId).toUpperCase().replace(/[^A-Z0-9]/g, ''))}`;
  return url.toString();
}

async function createDistribution() {
  const tripId = $('distribution-trip').value;
  const label = $('distribution-label').value.trim();
  const capacity = Number($('distribution-capacity').value);
  if (!tripId || !state.trips.has(tripId)) {
    showToast('配布する旅行を選択してください。', true);
    return;
  }
  if (!label) {
    showToast('配布先名を入力してください。', true);
    return;
  }
  if (label.length > 40) {
    showToast('配布先名は40文字以内にしてください。', true);
    return;
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) {
    showToast('端末枠は1〜50台の整数で入力してください。', true);
    return;
  }
  if (!state.publishedIds.has(tripId)) {
    showToast('配布IDを発行する前に、この旅行を参加者へ公開してください。', true);
    return;
  }
  const button = $('create-distribution');
  setBusy(button, true, '発行中…');
  const ledgerToken = randomToken();
  const roomId = `${tripId}_${ledgerToken}`;
  const trip = state.publishedTrips.get(tripId);
  if (!trip) {
    showToast('公開済みデータを取得できません。旅行をもう一度公開してください。', true);
    setBusy(button, false);
    return;
  }
  const payloadJson = JSON.stringify(trip);
  try {
    let accessId = '';
    let grantId = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      accessId = randomAccessId();
      grantId = await sha256(accessId);
      if (!(await getDoc(doc(db, 'accessGrants', grantId))).exists()) break;
      accessId = '';
    }
    if (!accessId) throw new Error('配布IDを生成できませんでした。もう一度お試しください。');
    const batch = writeBatch(db);
    batch.set(doc(db, 'rooms', roomId), {
      schemaVersion: 2,
      tripId,
      label,
      status: 'active',
      capacity,
      members: {},
      accessIdHash: grantId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: state.currentUser.uid
    });
    batch.set(doc(db, 'adminDistributions', roomId), {
      roomId,
      tripId,
      label,
      ledgerToken,
      accessId,
      grantId,
      status: 'active',
      capacity,
      createdAt: serverTimestamp(),
      createdBy: state.currentUser.uid
    });
    batch.set(doc(db, 'accessGrants', grantId), {
      tripId,
      roomId,
      ledgerToken,
      status: 'active',
      title: trip.title,
      payloadJson,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: state.currentUser.uid
    });
    await batch.commit();
    $('distribution-label').value = '';
    showToast('配布ID ' + formatAccessId(accessId) + ' を発行しました。登録リンクを配布先カードからコピーできます。');
  } catch (error) {
    console.error(error);
    showToast(`配布IDを発行できません: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

function normalizeParticipantName(value) {
  return text(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ja-JP');
}

function subscribeDistributionParticipants(distribution) {
  if (state.participantUnsubscribers.has(distribution.id)) return;
  const ref = collection(db, 'rooms', distribution.roomId || distribution.id, 'participants');
  const unsubscribe = onSnapshot(ref, snapshot => {
    const currentDistribution = state.distributions.find(item => item.id === distribution.id);
    if (currentDistribution) {
      currentDistribution.participants = snapshot.docs.map(item => ({ uid: item.id, ...item.data() }));
    }
    renderDistributions();
  }, error => {
    console.warn(`participants/${distribution.id}`, error);
  });
  state.participantUnsubscribers.set(distribution.id, unsubscribe);
}

function subscribeDistributionRoom(distribution) {
  if (state.roomUnsubscribers.has(distribution.id)) return;
  const ref = doc(db, 'rooms', distribution.roomId || distribution.id);
  const unsubscribe = onSnapshot(ref, snapshot => {
    const currentDistribution = state.distributions.find(item => item.id === distribution.id);
    if (currentDistribution) {
      const roomData = snapshot.data() || {};
      currentDistribution.roomMembers = Object.keys(roomData.members || {});
      currentDistribution.roomReady = true;
      currentDistribution.capacity = Number.isInteger(Number(roomData.capacity)) ? Number(roomData.capacity) : currentDistribution.capacity;
    }
    renderDistributions();
  }, error => {
    console.warn('room/' + distribution.id, error);
  });
  state.roomUnsubscribers.set(distribution.id, unsubscribe);
}

function subscribeDistributionExpenses(distribution) {
  if (state.expenseUnsubscribers.has(distribution.id)) return;
  const ref = collection(db, 'rooms', distribution.roomId || distribution.id, 'expenses');
  const unsubscribe = onSnapshot(ref, snapshot => {
    const currentDistribution = state.distributions.find(item => item.id === distribution.id);
    if (currentDistribution) {
      currentDistribution.expenses = snapshot.docs.map(item => {
        const data = item.data() || {};
        return {
          id: item.id,
          amount: Number(data.amount) || 0,
          payer: text(data.payer),
          category: text(data.category || 'その他'),
          note: [text(data.note), text(data.comment)].map(value => value.trim()).filter(Boolean).join(' — ').slice(0, 120),
          createdAt: text(data.createdAt),
          creatorUid: text(data.creatorUid)
        };
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      currentDistribution.expensesReady = true;
      currentDistribution.expensesError = '';
    }
    renderDistributions();
  }, error => {
    console.warn('expenses/' + distribution.id, error);
    const currentDistribution = state.distributions.find(item => item.id === distribution.id);
    if (currentDistribution) {
      currentDistribution.expensesReady = true;
      currentDistribution.expensesError = '共有台帳を取得できません';
    }
    renderDistributions();
  });
  state.expenseUnsubscribers.set(distribution.id, unsubscribe);
}

async function deleteDistributionExpense(distribution, expense, button) {
  const label = expense.note || expense.category || 'この支出';
  if (!window.confirm('「' + label + '」' + formatYen(expense.amount) + ' を共有台帳から削除しますか？')) return;
  setBusy(button, true, '削除中…');
  try {
    const expenseRef = doc(db, 'rooms', distribution.roomId || distribution.id, 'expenses', expense.id);
    const batch = writeBatch(db);
    batch.delete(expenseRef);
    await batch.commit();
    showToast('共有支出を削除しました。');
  } catch (error) {
    console.error(error);
    showToast('共有支出を削除できません: ' + error.message, true);
    setBusy(button, false);
  }
}

async function clearDistributionLedger(distribution, button) {
  if (distribution.status === 'active') {
    showToast('全削除の前に配布を停止してください。停止中は参加者の新規追加を防げます。', true);
    return;
  }
  const expensesRef = collection(db, 'rooms', distribution.roomId || distribution.id, 'expenses');
  try {
    let snapshot = await getDocs(expensesRef);
    if (!snapshot.size) {
      showToast('共有台帳はすでに空です。');
      return;
    }
    if (!window.confirm('共有支出 ' + snapshot.size + '件をすべて削除しますか？元に戻せません。')) return;
    if (window.prompt('確認のため「全削除」と入力してください。') !== '全削除') return;
    setBusy(button, true, '全削除中…');
    for (let pass = 0; pass < 5 && snapshot.size; pass += 1) {
      await deleteDocumentsInChunks(snapshot.docs);
      snapshot = await getDocs(expensesRef);
    }
    if (snapshot.size) throw new Error('削除中に台帳が更新されました。配布停止を確認して再実行してください。');
    showToast('共有台帳を全削除しました。');
  } catch (error) {
    console.error(error);
    showToast('共有台帳を全削除できません: ' + error.message, true);
    setBusy(button, false);
  }
}

async function migrateParticipantExpenseReferences(expensesRef, uid, replacementUid) {
  const snapshot = await getDocs(expensesRef);
  const migrations = snapshot.docs.filter(item => {
    const data = item.data() || {};
    return data.payer === uid || data.creatorUid === uid;
  });
  if (!replacementUid || !migrations.length) return migrations.length;
  for (let offset = 0; offset < migrations.length; offset += 400) {
    const batch = writeBatch(db);
    migrations.slice(offset, offset + 400).forEach(item => {
      const data = item.data() || {};
      const update = {};
      if (data.payer === uid) update.payer = replacementUid;
      if (data.creatorUid === uid) update.creatorUid = replacementUid;
      batch.update(item.ref, update);
    });
    await batch.commit();
  }
  return migrations.length;
}

async function removeParticipantDevice(distribution, uid, button) {
  const roomId = distribution.roomId || distribution.id;
  const roomRef = doc(db, 'rooms', roomId);
  const participantRef = doc(roomRef, 'participants', uid);
  const participantsRef = collection(roomRef, 'participants');
  const expensesRef = collection(roomRef, 'expenses');
  try {
    const [roomSnapshot, participantSnapshot, participantsSnapshot, expensesSnapshot] = await Promise.all([
      getDoc(roomRef),
      getDoc(participantRef),
      getDocs(participantsRef),
      getDocs(expensesRef)
    ]);
    if (!roomSnapshot.exists()) throw new Error('配布ルームが見つかりません。');
    const roomMembers = roomSnapshot.data()?.members || {};
    if (!roomMembers[uid] && !participantSnapshot.exists()) {
      showToast('この端末はすでに解除されています。');
      return;
    }

    const target = participantSnapshot.data() || {};
    const targetName = text(target.nickname).trim();
    const candidates = participantsSnapshot.docs
      .filter(item => item.id !== uid && roomMembers[item.id])
      .map(item => ({ uid: item.id, ...item.data() }))
      .filter(item => targetName && normalizeParticipantName(item.nickname) === normalizeParticipantName(targetName))
      .sort((a, b) => (a.joinedAt?.seconds || Number.MAX_SAFE_INTEGER) - (b.joinedAt?.seconds || Number.MAX_SAFE_INTEGER)
        || a.uid.localeCompare(b.uid));
    const replacement = candidates[0] || null;
    const referencedExpenses = expensesSnapshot.docs.filter(item => {
      const data = item.data() || {};
      return data.payer === uid || data.creatorUid === uid;
    });
    if (referencedExpenses.length && !replacement) {
      showToast('この端末を参照する支出があります。同じ表示名の新端末を登録してから解除してください。', true);
      return;
    }

    const displayName = targetName || '参加者情報のない端末';
    const migrationNote = replacement ? '\n同じ表示名の端末へ支払者・登録者を移行します。' : '';
    if (!window.confirm('「' + displayName + '」端末 …' + uid.slice(-6) + ' を配布先から解除しますか？' + migrationNote)) return;
    setBusy(button, true, '解除中…');

    if (replacement) {
      await migrateParticipantExpenseReferences(expensesRef, uid, replacement.uid);
    }

    await runTransaction(db, async transaction => {
      const latestRoom = await transaction.get(roomRef);
      if (!latestRoom.exists()) throw new Error('配布ルームが見つかりません。');
      const members = { ...(latestRoom.data()?.members || {}) };
      if (Object.prototype.hasOwnProperty.call(members, uid)) {
        delete members[uid];
        transaction.update(roomRef, { members, updatedAt: serverTimestamp() });
      }
    });

    const remainingReferenceCount = await migrateParticipantExpenseReferences(
      expensesRef,
      uid,
      replacement?.uid || ''
    );
    if (remainingReferenceCount && !replacement) {
      throw new Error('解除中にこの端末の支出が追加されました。参加者情報は残しているため、同名の新端末を登録後に再試行できます。');
    }

    const finalBatch = writeBatch(db);
    finalBatch.delete(participantRef);
    await finalBatch.commit();
    showToast(replacement
      ? '支出の支払者・登録者を同名端末へ移行し、参加端末を解除しました。'
      : '参加端末を解除しました。');
  } catch (error) {
    console.error(error);
    showToast('参加端末を解除できません: ' + error.message, true);
    setBusy(button, false);
  }
}
function renderDistributionLedger(distribution) {
  const expenses = Array.isArray(distribution.expenses) ? distribution.expenses : [];
  const total = expenses.reduce((sum, expense) => sum + Math.max(0, Number(expense.amount) || 0), 0);
  const panel = makeElement('details', 'admin-ledger');
  const summary = makeElement('summary');
  const summaryText = makeElement('span');
  summaryText.append(makeElement('strong', '', '共有台帳'), makeElement('small', '', String(expenses.length) + '件'));
  summary.append(summaryText, makeElement('strong', 'admin-ledger-total', formatYen(total)));
  panel.append(summary);

  if (!distribution.expensesReady) {
    panel.append(makeElement('p', 'admin-ledger-empty', '台帳を読み込んでいます…'));
    return panel;
  }
  if (distribution.expensesError) {
    panel.append(makeElement('p', 'admin-ledger-error', distribution.expensesError));
    return panel;
  }
  if (!expenses.length) {
    panel.append(makeElement('p', 'admin-ledger-empty', 'まだ共有支出はありません。'));
    return panel;
  }

  const participantNames = new Map((distribution.participants || []).map(person => [person.uid, person.nickname || '名前未設定']));
  const list = makeElement('div', 'admin-ledger-list');
  expenses.forEach(expense => {
    const row = makeElement('article', 'admin-ledger-row');
    const copy = makeElement('div');
    const displayNote = [expense.note, expense.comment].map(value => text(value).trim()).filter(Boolean).join(' — ') || expense.category || '支出';
    copy.append(makeElement('strong', '', displayNote));
    const splitLabel = Array.isArray(expense.participantIds) && expense.participantIds.length ? expense.participantIds.length + '人で分担' : '';
    copy.append(makeElement('small', '', [expense.category || 'その他', (participantNames.get(expense.payer) || '参加者') + 'が支払い', splitLabel, formatTimestamp(expense.createdAt)].filter(Boolean).join(' · ')));
    const amount = makeElement('strong', 'admin-ledger-amount', formatYen(expense.amount));
    const remove = makeElement('button', 'compact danger admin-ledger-delete', '削除');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteDistributionExpense(distribution, expense, remove));
    const controls = makeElement('div', 'admin-ledger-controls');
    controls.append(amount, remove);
    row.append(copy, controls);
    list.append(row);
  });
  panel.append(list);
  const actions = makeElement('div', 'admin-ledger-actions');
  const clear = makeElement('button', 'compact danger', '台帳を全削除');
  clear.type = 'button';
  clear.addEventListener('click', () => clearDistributionLedger(distribution, clear));
  actions.append(clear);
  panel.append(actions);
  return panel;
}

async function deleteDocumentsInChunks(documents) {
  for (let offset = 0; offset < documents.length; offset += 400) {
    const batch = writeBatch(db);
    documents.slice(offset, offset + 400).forEach(item => batch.delete(item.ref));
    await batch.commit();
  }
}

async function deleteDistribution(distribution, button) {
  if (state.currentRole !== 'owner') {
    showToast('配布先の完全削除はオーナーだけが実行できます。', true);
    return;
  }
  if (distribution.status === 'active') {
    showToast('先に配布を停止してください。', true);
    return;
  }
  const initialDistributionRef = doc(db, 'adminDistributions', distribution.id);
  try {
    const initialSnapshot = await getDoc(initialDistributionRef);
    if (!initialSnapshot.exists()) {
      showToast('この配布先はすでに削除されています。');
      return;
    }
    const initialData = initialSnapshot.data() || {};
    if (initialData.status === 'active') throw new Error('配布が再開されています。先に停止してください。');
    const roomId = initialData.roomId || distribution.roomId || distribution.id;
    const roomRef = doc(db, 'rooms', roomId);
    const [participantsSnapshot, expensesSnapshot] = await Promise.all([
      getDocs(collection(roomRef, 'participants')),
      getDocs(collection(roomRef, 'expenses'))
    ]);
    const label = initialData.label || distribution.label || '名称未設定';
    const confirmed = window.confirm(
      '「' + label + '」を完全削除しますか？\n\n参加者 ' + participantsSnapshot.size + '名、共有支出 ' + expensesSnapshot.size + '件、提案やコメント、配布ID・同期ルームを削除します。元に戻せません。'
    );
    if (!confirmed) return;
    setBusy(button, true, '削除中…');

    await runTransaction(db, async transaction => {
      const [latestDistribution, latestRoom] = await Promise.all([
        transaction.get(initialDistributionRef),
        transaction.get(roomRef)
      ]);
      if (!latestDistribution.exists()) throw new Error('この配布先はすでに削除されています。');
      if (latestDistribution.data()?.status === 'active' || latestRoom.data()?.status === 'active') {
        throw new Error('配布が再開されたため削除を中止しました。');
      }
      transaction.update(initialDistributionRef, { status: 'deleting', updatedAt: serverTimestamp() });
      if (latestRoom.exists()) transaction.update(roomRef, { status: 'deleting', updatedAt: serverTimestamp() });
    });

    // 提案とコメントを全件削除（コメントを先に全削除してから提案を削除）
    await cleanupRoomSuggestionsAndComments({ db, roomId, getDocs, collection, deleteDoc, writeBatch, query, limit });

    const [participantsToDelete, expensesToDelete] = await Promise.all([
      getDocs(collection(roomRef, 'participants')),
      getDocs(collection(roomRef, 'expenses'))
    ]);
    await deleteDocumentsInChunks([...participantsToDelete.docs, ...expensesToDelete.docs]);
    const latestData = (await getDoc(initialDistributionRef)).data() || initialData;
    const finalBatch = writeBatch(db);
    finalBatch.delete(roomRef);
    finalBatch.delete(initialDistributionRef);
    const grantId = latestData.grantId || distribution.grantId;
    if (grantId) finalBatch.delete(doc(db, 'accessGrants', grantId));
    await finalBatch.commit();
    showToast('「' + label + '」を完全削除しました。');
  } catch (error) {
    console.error(error);
    showToast('配布先を削除できません: ' + error.message, true);
    setBusy(button, false);
  }
}

function renderDistributions() {
  refreshAdminDiscussionRooms();
  const list = $('distribution-list');
  list.replaceChildren();
  const activeCount = state.distributions.filter(item => item.status === 'active').length;
  $('metric-distributions').textContent = String(activeCount);
  $('distribution-count').textContent = String(state.distributions.length) + '件';

  const activeIds = new Set(state.distributions.map(item => item.id));
  [
    state.participantUnsubscribers,
    state.roomUnsubscribers,
    state.expenseUnsubscribers
  ].forEach(unsubscribers => {
    [...unsubscribers.entries()].forEach(([id, unsubscribe]) => {
      if (!activeIds.has(id)) {
        unsubscribe();
        unsubscribers.delete(id);
      }
    });
  });

  if (!state.distributions.length) {
    list.append(makeElement('div', 'empty-state', '配布先はまだありません。旅行を選び、配布IDを発行してください。'));
    return;
  }

  state.distributions.forEach(distribution => {
    subscribeDistributionParticipants(distribution);
    subscribeDistributionRoom(distribution);
    subscribeDistributionExpenses(distribution);
    const card = makeElement('article', 'distribution-card');
    const head = makeElement('div', 'distribution-head');
    const left = makeElement('div');
    const isDeleting = distribution.status === 'deleting';
    const statusLabel = distribution.status === 'active' ? '有効' : isDeleting ? '削除中' : '停止';
    left.append(makeElement('span', 'pill ' + (distribution.status === 'active' ? '' : 'draft'), statusLabel));
    left.append(makeElement('h3', '', distribution.label || '名称未設定'));
    left.append(makeElement('span', 'muted small', distribution.tripId + ' · ' + formatTimestamp(distribution.createdAt)));

    const participantDocs = Array.isArray(distribution.participants) ? distribution.participants : [];
    const participantByUid = new Map(participantDocs.map(person => [person.uid, person]));
    const roomMemberIds = distribution.roomReady
      ? [...new Set(Array.isArray(distribution.roomMembers) ? distribution.roomMembers : [])]
      : [...new Set(participantDocs.map(person => person.uid))];
    const roomMemberSet = new Set(roomMemberIds);
    const listedIds = [...new Set([...roomMemberIds, ...participantDocs.map(person => person.uid)])];
    const uniqueNames = new Set();
    let unnamedMemberCount = 0;
    roomMemberIds.forEach(uid => {
      const nameKey = normalizeParticipantName(participantByUid.get(uid)?.nickname);
      if (nameKey) uniqueNames.add(nameKey);
      else unnamedMemberCount += 1;
    });
    const peopleCount = uniqueNames.size + unnamedMemberCount;
    const deviceCount = roomMemberIds.length;
    const capacity = Number.isInteger(Number(distribution.capacity)) ? Number(distribution.capacity) : 2;
    head.append(left, makeElement('strong', '', peopleCount + '名（' + deviceCount + '/' + capacity + '端末）'));

    const accessId = distribution.accessId ? formatAccessId(distribution.accessId) : '配布IDなし：この配布先を削除し、新しく発行してください';
    const accessIdCode = makeElement('code', 'distribution-id', accessId);
    const participants = makeElement('div', 'participant-list participant-device-list');
    if (listedIds.length) {
      listedIds.forEach(uid => {
        const person = participantByUid.get(uid);
        const label = person?.nickname || '参加者情報のない端末';
        const slotStatus = roomMemberSet.has(uid) ? '' : ' · 配布枠外';
        const joinedAt = person?.joinedAt ? ' · ' + formatTimestamp(person.joinedAt) : '';
        const detail = '…' + uid.slice(-6) + joinedAt + slotStatus;
        const item = makeElement('span', 'participant participant-device');
        const copy = makeElement('span', 'participant-device-copy');
        copy.append(makeElement('strong', '', label), makeElement('small', '', detail));
        const removeDevice = makeElement('button', 'compact danger', '解除');
        removeDevice.type = 'button';
        removeDevice.addEventListener('click', () => removeParticipantDevice(distribution, uid, removeDevice));
        item.append(copy, removeDevice);
        participants.append(item);
      });
    } else {
      participants.append(makeElement('span', 'muted small', 'まだ参加端末はありません'));
    }
    participants.append(makeElement('p', 'participant-merge-note', '同じ表示名は同一人物として割り勘集計します。別人なら表示名を変えてください。'));
    const capacityControl = makeElement('div', 'capacity-control');
    const capacityLabel = makeElement('label', '', '端末枠');
    const capacityInput = document.createElement('input');
    capacityInput.type = 'number';
    capacityInput.min = String(Math.max(1, deviceCount));
    capacityInput.max = '50';
    capacityInput.step = '1';
    capacityInput.value = String(capacity);
    capacityInput.disabled = isDeleting;
    const updateCapacity = makeElement('button', 'compact ghost', '端末枠を変更');
    updateCapacity.type = 'button';
    updateCapacity.disabled = isDeleting;
    updateCapacity.addEventListener('click', () => updateDistributionCapacity(distribution, Number(capacityInput.value), updateCapacity));
    capacityLabel.append(capacityInput);
    capacityControl.append(capacityLabel, updateCapacity);

    const actions = makeElement('div', 'trip-actions');
    const copyLink = makeElement('button', 'compact primary', '登録リンクをコピー');
    copyLink.type = 'button';
    copyLink.disabled = distribution.status !== 'active' || !distribution.accessId;
    copyLink.addEventListener('click', () => copyText(participantRegistrationUrl(distribution.accessId), '自動登録リンクをコピーしました。'));
    const copy = makeElement('button', 'compact ghost', '配布IDをコピー');
    copy.type = 'button';
    copy.disabled = distribution.status !== 'active' || !distribution.accessId;
    copy.addEventListener('click', () => copyText(formatAccessId(distribution.accessId), '配布IDをコピーしました。'));
    const copyApp = makeElement('button', 'compact ghost', '空のアプリURLをコピー');
    copyApp.type = 'button';
    copyApp.addEventListener('click', () => copyText(participantAppUrl(), '空の参加者アプリURLをコピーしました。'));
    const toggle = makeElement('button', `compact ${distribution.status === 'active' ? 'danger' : ''}`, distribution.status === 'active' ? '配布を停止' : '再開');
    toggle.type = 'button';
    toggle.disabled = isDeleting;
    toggle.addEventListener('click', () => toggleDistribution(distribution));
    actions.append(copyLink, copy, copyApp, toggle);
    if (distribution.status !== 'active') {
      const remove = makeElement('button', 'compact danger', isDeleting ? '削除を再試行' : '完全削除');
      remove.type = 'button';
      remove.addEventListener('click', () => deleteDistribution(distribution, remove));
      actions.append(remove);
    }
    const ledger = renderDistributionLedger(distribution);
    card.append(head, accessIdCode, participants, ledger, capacityControl, actions);
    list.append(card);
  });
}

async function updateDistributionCapacity(distribution, capacity, button) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) {
    showToast('端末枠は1〜50台の整数で入力してください。', true);
    return;
  }
  setBusy(button, true, '変更中…');
  try {
    const roomRef = doc(db, 'rooms', distribution.roomId || distribution.id);
    const roomSnapshot = await getDoc(roomRef);
    if (!roomSnapshot.exists()) throw new Error('配布ルームが見つかりません。');
    const memberCount = Object.keys(roomSnapshot.data()?.members || {}).length;
    if (capacity < memberCount) throw new Error(`現在${memberCount}台の端末が登録済みです。端末枠をそれ未満にはできません。`);
    await runTransaction(db, async transaction => {
      const latestRoom = await transaction.get(roomRef);
      if (!latestRoom.exists()) throw new Error('配布ルームが見つかりません。');
      const latestMemberCount = Object.keys(latestRoom.data()?.members || {}).length;
      if (capacity < latestMemberCount) throw new Error(`現在${latestMemberCount}台の端末が登録済みです。端末枠をそれ未満にはできません。`);
      transaction.update(roomRef, { capacity, updatedAt: serverTimestamp() });
      transaction.update(doc(db, 'adminDistributions', distribution.id), { capacity, updatedAt: serverTimestamp() });
    });
    showToast(`端末枠を${capacity}台へ変更しました。`);
  } catch (error) {
    console.error(error);
    showToast(`端末枠を変更できません: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

async function toggleDistribution(distribution) {
  if (distribution.status === 'deleting') {
    showToast('削除処理中の配布先は再開できません。完全削除を再試行してください。', true);
    return;
  }
  const status = distribution.status === 'active' ? 'revoked' : 'active';
  if (status === 'revoked' && !window.confirm('この配布IDを停止しますか？オンライン接続中の参加者は閲覧・同期できなくなります。オフライン保存済みの内容は、次回オンライン確認まで端末に残る場合があります。')) return;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'adminDistributions', distribution.id), { status, updatedAt: serverTimestamp() });
    batch.update(doc(db, 'rooms', distribution.roomId || distribution.id), { status, updatedAt: serverTimestamp() });
    if (distribution.grantId) {
      const trip = state.publishedTrips.get(distribution.tripId);
      const grantUpdate = { status, updatedAt: serverTimestamp() };
      if (status === 'active' && trip) {
        grantUpdate.title = trip.title;
        grantUpdate.payloadJson = JSON.stringify(trip);
      }
      batch.update(doc(db, 'accessGrants', distribution.grantId), grantUpdate);
    }
    await batch.commit();
    showToast(status === 'active' ? '配布を再開しました。' : '配布を停止しました。');
  } catch (error) {
    console.error(error);
    showToast(`配布状態を変更できません: ${error.message}`, true);
  }
}



function applyTripTemplate() {
  if (!state.activeTrip) return;
  if (state.activeTrip.checklist?.length && !window.confirm('現在の持ち物リストをテンプレートで置き換えますか？')) return;
  const templates = {
    domestic: [
      { category: 'DOCUMENTS', items: [{ name: '航空券・予約確認' }, { name: '本人確認書類' }, { name: '保険証・常備薬' }] },
      { category: 'POWER', items: [{ name: 'スマートフォン充電器' }, { name: 'モバイルバッテリー' }] }
    ],
    drive: [
      { category: 'DRIVE', items: [{ name: '運転免許証' }, { name: 'ETCカード' }, { name: '車載充電器・スマホホルダー' }] },
      { category: 'TRAVEL', items: [{ name: '予約確認' }, { name: '保険証・常備薬' }, { name: 'モバイルバッテリー' }] }
    ],
    rail: [
      { category: 'TICKETS', items: [{ name: '乗車券・指定席予約' }, { name: '交通系ICカード' }, { name: '本人確認書類' }] },
      { category: 'TRAVEL', items: [{ name: '時刻表・乗換確認' }, { name: 'モバイルバッテリー' }, { name: '常備薬' }] }
    ]
  };
  const type = $('trip-template').value;
  state.activeTrip.checklist = deepClone(templates[type] || templates.domestic);
  state.activeTrip.theme.accent = type === 'drive' ? '#f4d35e' : type === 'rail' ? '#77b7ff' : '#eab8c9';
  $('trip-theme-accent').value = state.activeTrip.theme.accent;
  showToast('テンプレートを適用しました。既存の日程カードは変更していません。');
}

function readDaySettings() {
  if (!state.activeTrip || !state.activeDayKey) return;
  state.activeTrip.daySettings ||= {};
  const departureTime = $('editor-day-departure').value;
  const note = $('editor-day-note').value.trim();
  if (departureTime || note) state.activeTrip.daySettings[state.activeDayKey] = { departureTime, note };
  else delete state.activeTrip.daySettings[state.activeDayKey];
}

function renderTripAudit(report = analyzeTrip(state.activeTrip || {})) {
  const panel = $('trip-audit');
  if (!panel) return;
  const head = makeElement('div', 'v2-audit-head');
  head.append(makeElement('strong', '', '公開前チェック'));
  const counts = makeElement('div', 'v2-audit-counts');
  counts.append(makeElement('span', report.errors.length ? 'error' : '', `エラー ${report.errors.length}`));
  counts.append(makeElement('span', report.warnings.length ? 'warning' : '', `警告 ${report.warnings.length}`));
  counts.append(makeElement('span', '', `提案 ${report.info.length}`));
  head.append(counts);
  const list = makeElement('ul', 'v2-audit-list');
  report.issues.slice(0, 20).forEach(item => {
    const row = makeElement('li', '', item.message);
    row.dataset.level = item.level;
    list.append(row);
  });
  if (!report.issues.length) list.append(makeElement('li', 'v2-audit-ok', '公開を止める問題はありません。'));
  panel.replaceChildren(head, list);
}

function showTripPreview() {
  readTripBasics();
  readDaySettings();
  const trip = migrateTripToV2(state.activeTrip);
  const phone = makeElement('div', 'v2-phone');
  const header = makeElement('header', 'v2-phone-header');
  header.append(makeElement('small', '', 'TRIP COMPANION'));
  header.append(makeElement('h3', '', trip.title));
  header.append(makeElement('span', 'muted small', `${trip.startDate} — ${trip.endDate}`));
  phone.append(header);
  Object.entries(trip.days).forEach(([dayKey, cards]) => {
    phone.append(makeElement('div', 'v2-preview-day', trip.dayLabels[dayKey] || dayKey.toUpperCase()));
    cards.forEach(card => {
      const item = makeElement('article', 'v2-preview-card');
      item.append(makeElement('time', '', card.time));
      item.append(makeElement('strong', '', `${card.badge} · ${card.title}`));
      item.append(makeElement('p', '', card.desc));
      phone.append(item);
    });
  });
  $('preview-content').replaceChildren(phone);
  $('preview-dialog').showModal();
}

async function showPublishHistory() {
  if (!state.activeTrip?.tripId) return showToast('旅行IDを保存してから履歴を確認してください。', true);
  const generation = editorSession.generation;
  const content = $('history-content');
  content.textContent = '公開履歴を読み込んでいます…';
  $('history-dialog').showModal();
  try {
    const snapshot = await getDocs(collection(db, 'tripHistories', state.activeTrip.tripId, 'versions'));
    const versions = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
      .sort((a, b) => (b.publishedAt?.toMillis?.() || 0) - (a.publishedAt?.toMillis?.() || 0));
    const list = makeElement('div', 'v2-history-list');
    if (!versions.length) list.append(makeElement('div', 'empty-state', 'まだ公開履歴はありません。次回公開から保存されます。'));
    versions.forEach((version, index) => {
      const row = makeElement('article', 'v2-history-item');
      const copy = makeElement('div');
      copy.append(makeElement('strong', '', `公開版 ${versions.length - index}`));
      copy.append(makeElement('small', '', formatTimestamp(version.publishedAt)));
      const restore = makeElement('button', 'button compact', '下書きへ復元');
      restore.type = 'button';
      restore.addEventListener('click', () => {
        try {
          if (editorSession.generation !== generation) return showToast('編集対象が変わっています。履歴を開き直してください。', true);
          if (!confirmEditorLeave()) return;
          state.activeTrip = normalizeTrip(JSON.parse(version.payloadJson), state.activeTrip.tripId);
          state.activeDayKey = Object.keys(state.activeTrip.days)[0] || 'day1';
          renderEditor();
          $('history-dialog').close();
          updateSaveStatus();
          showToast('選択した公開版を下書きへ復元しました。保存するまで参加者ページは変わりません。');
        } catch (error) {
          showToast('履歴を復元できません。', true);
        }
      });
      row.append(copy, restore);
      list.append(row);
    });
    content.replaceChildren(list);
  } catch (error) {
    content.textContent = `履歴を読み込めません: ${error.message}`;
  }
}

function duplicateTrip(tripId) {
  if (state.trips.get(tripId)?.loadError) return showToast('壊れた下書きは複製できません。元データを保管して修復してください。', true);
  if (!confirmEditorLeave()) return;
  const record = state.trips.get(tripId);
  const source = record?.trip;
  if (!source) return;
  const duplicate = migrateTripToV2(source);
  const suffix = crypto.randomUUID().slice(0, 8);
  duplicate.tripId = `${tripId.slice(0, 30)}-${suffix}`.slice(0, 40);
  duplicate.title = `${source.title} コピー`.slice(0, 120);
  duplicate.archived = false;

  let duplicatePlanning = blankPlanning();
  if (record.planning) {
    const cloned = deepClone(record.planning);
    cloned.candidates = (cloned.candidates || []).map((cand, i) => {
      const newCand = cleanCandidate(cand, i);
      newCand.id = `cand-${crypto.randomUUID()}`;
      return newCand;
    });
    duplicatePlanning = reconcileAssignments(duplicate, cleanPlanning(cloned));
  }

  state.activeTrip = duplicate;
  state.activePlanning = duplicatePlanning;
  state.lastDayPlanUndo = null;
  if ($('undo-day-plan')) $('undo-day-plan').hidden = true;
  state.activeDayKey = Object.keys(duplicate.days)[0] || 'day1';
  renderEditor();
  showView('editor');
  startEditorSession(false);
  showToast('旅行を複製しました。日付と旅行IDを確認して下書き保存してください。');
}

async function toggleTripArchive(tripId) {
  if (state.tripWriteBusy || editorSession.saving) return showToast('保存が終わるまでお待ちください。', true);
  const record = state.trips.get(tripId);
  if (!record) return;
  if (record.loadError) return showToast('壊れた下書きは保管状態を変更できません。元データを保管して修復してください。', true);
  const errors = validateTripDraft(record.trip, record.planning || blankPlanning());
  if (errors.length) return showToast(errors.join('\n'), true);
  if (state.activeTrip?.tripId === tripId && hasUnsavedChanges()) return showToast('この旅行の未保存変更を先に保存してください。', true);
  const generation = editorSession.generation;
  const trip = migrateTripToV2(record.trip);
  const planning = cleanPlanning(record.planning || blankPlanning());
  trip.archived = !trip.archived;
  state.tripWriteBusy = true;
  updateSaveStatus();
  try {
    const data = {
      tripId, title: trip.title, status: state.publishedIds.has(tripId) ? 'published' : 'draft',
      payloadJson: JSON.stringify(stripPlanningForPublication(trip)), planningJson: JSON.stringify(planning),
      revision: crypto.randomUUID(), updatedAt: serverTimestamp(), updatedBy: state.currentUser.uid
    };
    const version = await commitTripRecord({ db, runTransaction, reference: doc(db, 'adminTrips', tripId),
      expectedVersion: record.version ?? null, data });
    state.trips.set(tripId, { trip, planning, version, source: 'cloud', updatedAt: new Date() });
    if (state.activeTrip?.tripId === tripId && editorSession.generation === generation && !hasUnsavedChanges()) {
      state.activeTrip = deepClone(trip);
      state.activePlanning = deepClone(planning);
      renderEditor();
      startEditorSession(true, version);
    }
    renderTripLibrary();
    showToast(trip.archived ? '思い出へアーカイブしました。' : '旅行一覧へ戻しました。');
  } catch (error) {
    showToast(`変更できません: ${error.message}`, true);
  } finally {
    state.tripWriteBusy = false;
    updateSaveStatus();
  }
}


async function loadAdminRoles() {
  if (state.currentRole !== 'owner') return;
  const list = $('roles-list');
  list.textContent = '管理者を読み込んでいます…';
  try {
    const snapshot = await getDocs(collection(db, 'admins'));
    state.adminProfiles = snapshot.docs.map(item => ({ uid: item.id, ...item.data() }));
    renderAdminRoles();
  } catch (error) {
    list.textContent = `管理者を読み込めません: ${error.message}`;
  }
}

function renderAdminRoles() {
  const list = $('roles-list');
  list.replaceChildren();
  $('roles-count').textContent = `${state.adminProfiles.length}名`;
  state.adminProfiles.sort((a, b) => String(a.name || a.email || a.uid).localeCompare(String(b.name || b.email || b.uid), 'ja')).forEach(profile => {
    const row = makeElement('article', 'distribution-card');
    const head = makeElement('div', 'distribution-head');
    head.append(makeElement('span', 'pill', profile.role === 'editor' ? '編集者' : 'オーナー'));
    head.append(makeElement('span', 'muted small', profile.active === false ? '停止中' : '有効'));
    row.append(head, makeElement('h3', '', profile.name || profile.email || '管理者'));
    row.append(makeElement('p', 'muted small', profile.uid));
    const actions = makeElement('div', 'trip-actions');
    const edit = makeElement('button', 'compact ghost', '編集');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      $('role-uid').value = profile.uid;
      $('role-name').value = profile.name || '';
      $('role-type').value = profile.role === 'editor' ? 'editor' : 'owner';
      $('role-uid').focus();
    });
    actions.append(edit);
    if (profile.uid !== state.currentUser.uid) {
      const deactivate = makeElement('button', 'compact danger', profile.active === false ? '再開' : '停止');
      deactivate.type = 'button';
      deactivate.addEventListener('click', () => toggleAdminProfile(profile));
      actions.append(deactivate);
    }
    row.append(actions);
    list.append(row);
  });
}

async function saveAdminRole() {
  if (state.currentRole !== 'owner') return;
  const uid = $('role-uid').value.trim();
  const name = $('role-name').value.trim();
  const role = $('role-type').value === 'owner' ? 'owner' : 'editor';
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(uid)) return showToast('Firebase UIDを正しく入力してください。', true);
  try {
    await setDoc(doc(db, 'admins', uid), { active: true, role, name, updatedAt: serverTimestamp(), updatedBy: state.currentUser.uid }, { merge: true });
    $('role-uid').value = '';
    $('role-name').value = '';
    $('role-type').value = 'editor';
    showToast('管理者の役割を保存しました。');
    await loadAdminRoles();
  } catch (error) {
    showToast(`管理者を保存できません: ${error.message}`, true);
  }
}

async function toggleAdminProfile(profile) {
  if (state.currentRole !== 'owner' || profile.uid === state.currentUser.uid) return;
  const active = profile.active === false;
  if (!active && !window.confirm('この管理者を停止しますか？')) return;
  try {
    await setDoc(doc(db, 'admins', profile.uid), { active, updatedAt: serverTimestamp(), updatedBy: state.currentUser.uid }, { merge: true });
    await loadAdminRoles();
  } catch (error) {
    showToast(`管理者を変更できません: ${error.message}`, true);
  }
}

function bindEvents() {
  $('admin-discussion-room').addEventListener('change', connectAdminDiscussion);
  $('admin-sign-in').addEventListener('click', async () => {
    setBusy($('admin-sign-in'), true, 'ログイン中…');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      if (error.code !== 'auth/popup-closed-by-user') showToast(`ログインできません: ${error.message}`, true);
    } finally {
      setBusy($('admin-sign-in'), false);
    }
  });
  $('admin-sign-out').addEventListener('click', () => { if (confirmEditorLeave()) signOut(auth); });
  $('copy-admin-uid').addEventListener('click', () => copyText($('admin-uid').textContent, 'UIDをコピーしました。'));
  document.querySelectorAll('[data-admin-view]').forEach(button => button.addEventListener('click', () => { if (showView(button.dataset.adminView) === false) return; if (button.dataset.adminView === 'roles') loadAdminRoles(); }));
  $('save-role').addEventListener('click', saveAdminRole);
  $('overview-new-trip').addEventListener('click', () => openTripEditor());
  $('editor-day-select').addEventListener('change', event => {
    readTripBasics();
    readDaySettings();
    state.activeDayKey = event.target.value;
    $('editor-day-label').value = state.activeTrip.dayLabels?.[state.activeDayKey] || '';
    $('editor-day-departure').value = state.activeTrip.daySettings?.[state.activeDayKey]?.departureTime || '';
    $('editor-day-note').value = state.activeTrip.daySettings?.[state.activeDayKey]?.note || '';
    renderEditorCards();
  });
  $('editor-day-departure').addEventListener('input', readDaySettings);
  $('editor-day-note').addEventListener('input', readDaySettings);
  $('editor-day-label').addEventListener('input', event => {
    if (state.activeTrip && state.activeDayKey) state.activeTrip.dayLabels[state.activeDayKey] = event.target.value;
  });
  $('add-day').addEventListener('click', addDay);
  $('apply-template').addEventListener('click', applyTripTemplate);
  $('add-card').addEventListener('click', () => openCardDialog(-1));
  $('undo-day-plan').addEventListener('click', undoLastDayPlan);
  $('close-card-dialog').addEventListener('click', () => closeEditingDialog('card-dialog'));
  $('card-form').addEventListener('submit', saveCard);
  $('delete-card').addEventListener('click', deleteCard);
  $('move-card-up').addEventListener('click', () => moveCard(-1));
  $('move-card-down').addEventListener('click', () => moveCard(1));
  $('open-move-day').addEventListener('click', () => openMoveDayDialog(Number($('card-index').value)));
  $('open-cascade-adjust').addEventListener('click', () => openCascadeAdjustDialog(Number($('card-index').value)));
  $('save-draft').addEventListener('click', () => persistTrip(false));
  $('reload-draft').addEventListener('click', reloadActiveDraft);
  $('publish-trip').addEventListener('click', () => persistTrip(true));
  $('preview-trip').addEventListener('click', showTripPreview);
  $('history-trip').addEventListener('click', showPublishHistory);
  $('close-preview').addEventListener('click', () => $('preview-dialog').close());
  $('close-history').addEventListener('click', () => $('history-dialog').close());
  $('download-trip').addEventListener('click', () => downloadActiveTrip(false));
  $('download-admin-backup').addEventListener('click', () => downloadActiveTrip(true));
  $('import-trip-file').addEventListener('change', event => importTrip(event.target.files?.[0]));
  $('create-distribution').addEventListener('click', createDistribution);

  // Button Presets
  document.querySelectorAll('[data-add-preset]').forEach(btn => {
    btn.addEventListener('click', () => addPresetLink(btn.dataset.addPreset));
  });

  // Day Planner Move-Day Dialog events
  $('close-move-day-dialog').addEventListener('click', () => $('move-day-dialog').close());
  $('cancel-move-day').addEventListener('click', () => $('move-day-dialog').close());
  $('move-day-form').addEventListener('submit', previewMoveDay);
  $('move-day-target-select').addEventListener('change', updateMoveDayPositionOptions);

  // Day Planner Cascade Time Adjustment Dialog events
  $('close-cascade-dialog').addEventListener('click', () => $('cascade-adjust-dialog').close());
  $('cancel-cascade').addEventListener('click', () => $('cascade-adjust-dialog').close());
  $('cascade-adjust-form').addEventListener('submit', previewCascadeAdjust);

  // Day Planner Comparison Dialog events
  $('planner-compare-auto-adjust').addEventListener('click', autoAdjustAndReplan);
  $('close-planner-compare').addEventListener('click', () => $('planner-compare-dialog').close());
  $('cancel-planner-compare').addEventListener('click', () => $('planner-compare-dialog').close());
  $('planner-compare-form').addEventListener('submit', confirmPlannerCompare);

  // Candidate Shelf events
  $('add-candidate').addEventListener('click', () => openCandidateDialog(''));
  $('close-candidate-dialog').addEventListener('click', () => closeEditingDialog('candidate-dialog'));
  $('candidate-form').addEventListener('submit', saveCandidate);
  $('delete-candidate').addEventListener('click', () => deleteCandidate($('candidate-id').value));
  $('reset-candidate-status').addEventListener('click', () => resetCandidateStatus($('candidate-id').value));
  $('candidate-filter-status').addEventListener('change', event => {
    state.candidateFilterStatus = event.target.value;
    renderCandidateList();
  });
  $('candidate-filter-category').addEventListener('change', event => {
    state.candidateFilterCategory = event.target.value;
    renderCandidateList();
  });
  $('trip-planning-notes').addEventListener('input', readTripPlanning);
  document.querySelectorAll('[data-set-duration]').forEach(btn => {
    btn.addEventListener('click', () => {
      $('candidate-duration').value = btn.dataset.setDuration;
      $('candidate-duration').dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  // Candidate Adopt Dialog events
  $('close-adopt-dialog').addEventListener('click', () => closeEditingDialog('candidate-adopt-dialog'));
  $('cancel-adopt').addEventListener('click', () => closeEditingDialog('candidate-adopt-dialog'));
  $('candidate-adopt-form').addEventListener('submit', confirmAdoptCandidate);
  $('adopt-day-select').addEventListener('change', () => {
    updateAdoptPositionOptions();
    updateAdoptPreview();
  });
  $('adopt-position-select').addEventListener('change', updateAdoptPreview);
  $('adopt-start-time').addEventListener('input', updateAdoptPreview);
  $('adopt-duration-minutes').addEventListener('input', updateAdoptPreview);
  $('adopt-travel-minutes').addEventListener('input', updateAdoptPreview);

  document.addEventListener('input', handleEditorInput);
  document.addEventListener('change', handleEditorInput);
  document.addEventListener('click', event => {
    if (event.target.closest?.('#view-editor, #card-dialog, #candidate-dialog, #candidate-adopt-dialog, #move-day-dialog, #cascade-adjust-dialog, #planner-compare-dialog')) queueMicrotask(updateSaveStatus);
  });
  for (const id of ['card-dialog', 'candidate-dialog', 'candidate-adopt-dialog', 'move-day-dialog', 'cascade-adjust-dialog', 'planner-compare-dialog']) {
    $(id).addEventListener('cancel', event => {
      if (state.dirtyDialogs.has(id) && !window.confirm('未反映の入力を破棄しますか？')) event.preventDefault();
    });
    $(id).addEventListener('close', () => { state.dirtyDialogs.delete(id); updateSaveStatus(); });
  }
  window.addEventListener('beforeunload', handleEditorUnload);
  window.addEventListener('pagehide', stopLiveListeners);
}

async function executeAdminSuggestionChange(mode, { roomId, suggestionId, candidateId }) {
  let ticket = null;
  try {
    if (state.tripWriteBusy || editorSession.saving) throw new Error('保存処理が実行中です。');
    if (!state.currentUser || !editorSession.isOpenSession() || !state.activeTrip?.tripId) throw new Error('旅行が開かれていません。');
    if (hasUnsavedChanges()) throw new Error('未保存の変更があります。先に下書き保存してください。');
    const tripId = state.activeTrip.tripId;
    let expectedCandidate;
    if (mode === 'unadopt') {
      expectedCandidate = state.activePlanning.candidates.find(c => c.id === candidateId);
      if (!expectedCandidate) throw new Error('候補が見つかりません。');
      expectedCandidate = structuredClone(expectedCandidate);
      if (!window.confirm(`「${expectedCandidate.title}」を候補棚から削除し、採用を取り消しますか？候補のメモも削除されます。`)) return { ok: false, cancelled: true };
    }
    const inputRevision = state.editorInputRevision;
    const uid = state.currentUser.uid;
    ticket = editorSession.beginSave(state.activeTrip, state.activePlanning, { tripId });
    state.tripWriteBusy = true;
    updateSaveStatus();
    const operation = mode === 'adopt' ? adoptSuggestionTransaction : unadoptSuggestionTransaction;
    const result = await operation({
      db, doc, runTransaction, adminTripRef: doc(db, 'adminTrips', tripId),
      expectedVersion: ticket.expectedVersion, roomId,
      roomRef: doc(db, 'rooms', roomId),
      suggestionRef: doc(db, 'rooms', roomId, 'suggestions', suggestionId),
      candidateId, confirmed: mode === 'unadopt', expectedCandidate
    });
    if (state.currentUser?.uid !== uid) {
      editorSession.failSave(ticket);
      return { ok: true, sessionSwitched: true };
    }
    // Keep the cloud cache coherent even when the active editor has changed.
    state.trips.set(tripId, { trip: result.trip, planning: result.planning, version: result.newVersion, source: 'cloud', updatedAt: new Date() });
    const sameSession = editorSession.generation === ticket.generation && state.activeTrip?.tripId === tripId;
    if (sameSession) syncEditorInputs();
    const completion = editorSession.finishExternalSave(ticket, result, state.activeTrip, state.activePlanning,
      sameSession && inputRevision === state.editorInputRevision && state.dirtyDialogs.size === 0);
    if (completion.applied) {
      state.activeTrip = structuredClone(result.trip);
      state.activePlanning = structuredClone(result.planning);
      renderEditor();
      showToast(mode === 'adopt' ? '候補棚に採用しました。旅程はまだ公開されません。' : '採用を取り消しました。');
    } else if (completion.localEditsPreserved) {
      showToast('サーバーの処理は完了しました。処理中の入力は保持しています。入力をバックアップしてから下書きを再読込してください。', true);
    }
    return { ok: true, result, ...completion };
  } catch (error) {
    if (ticket) editorSession.failSave(ticket);
    showToast(error.message, true);
    return { ok: false, error: error.message };
  } finally {
    if (ticket) {
      state.tripWriteBusy = false;
      updateSaveStatus();
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
  if (state.tripWriteBusy || editorSession.saving || !state.currentUser || !state.activeTrip?.tripId) {
    return { ok: false, error: '旅行を開き、処理の完了を待ってください。' };
  }
  const generation = editorSession.generation;
  try {
    state.tripWriteBusy = true;
    const result = await changeSuggestionStatusTransaction({
      db, doc, runTransaction, tripId: state.activeTrip.tripId, roomId,
      suggestionRef: doc(db, 'rooms', roomId, 'suggestions', suggestionId),
      roomRef: doc(db, 'rooms', roomId), nextStatus
    });
    if (generation !== editorSession.generation) return { ok: true, sessionSwitched: true };
    showToast(nextStatus === 'declined' ? '提案を見送りにしました。' : '提案を検討中に戻しました。');
    return { ok: true, result };
  } catch (error) {
    showToast(error.message, true);
    return { ok: false, error: error.message };
  } finally {
    state.tripWriteBusy = false;
    updateSaveStatus();
  }
}


let adminDiscussionPanel = null;
let adminDiscussionService = null;
let adminDiscussionRoomStop = null;
let adminDiscussionBinding = '';

function stopAdminDiscussion(message = '') {
  adminDiscussionBinding = '';
  adminDiscussionRoomStop?.(); adminDiscussionRoomStop = null;
  adminDiscussionPanel?.disconnect(message);
  adminDiscussionService?.destroy(); adminDiscussionService = null;
}
function connectAdminDiscussion() {
  const roomId = $('admin-discussion-room').value;
  const distribution = state.distributions.find(d => (d.roomId || d.id) === roomId && d.tripId === state.activeTrip?.tripId && d.status === 'active');
  if (!distribution || !state.currentUser || state.currentView !== 'editor') { stopAdminDiscussion(); return; }
  const key = JSON.stringify([state.currentUser.uid, distribution.tripId, roomId]);
  if (key === adminDiscussionBinding) { adminDiscussionPanel?.refresh(); return; }
  stopAdminDiscussion();
  adminDiscussionBinding = key;
  adminDiscussionService = createSuggestionSyncService({
    db, doc, collection, query, orderBy, limit, startAfter, documentId, FieldPath, deleteField, runTransaction,
    getDocs: getDocsFromServer, onSnapshot, getAuthUid: () => auth.currentUser?.uid,
    onState: ({ state: connection }) => { if (adminDiscussionBinding === key) adminDiscussionPanel?.onConnection(connection); }
  });
  const context = adminDiscussionService.setContext({ tripId: distribution.tripId, roomId, authUid: state.currentUser.uid });
  adminDiscussionPanel.connect({ service: adminDiscussionService, context });
  adminDiscussionPanel.setVisible(true);
  const failed = message => {
    if (adminDiscussionBinding !== key) return;
    adminDiscussionPanel.disconnect(message);
    adminDiscussionService?.destroy();
    // Keep the refused binding until an explicit retry/selection change.
  };
  adminDiscussionRoomStop = onSnapshot(doc(db, 'rooms', roomId), { includeMetadataChanges: true }, snapshot => {
    if (adminDiscussionBinding !== key) return;
    if (snapshot.metadata.fromCache) return;
    const room = snapshot.data();
    if (!snapshot.exists() || room.status !== 'active' || room.tripId !== distribution.tripId) failed('この配布先の相談は停止されています。');
  }, () => failed('配布先の確認に失敗しました。権限または通信状態を確認してください。'));
}
function refreshAdminDiscussionRooms() {
  const select = $('admin-discussion-room');
  if (!select) return;
  if (!adminDiscussionPanel) adminDiscussionPanel = createDiscussionPanel($('admin-discussion'), {
    role: 'admin',
    getName: () => state.currentUser?.displayName || '管理者',
    getCandidate: (suggestionId, roomId) => state.activePlanning?.candidates?.find(c => c.sourceSuggestion?.roomId === roomId && c.sourceSuggestion?.suggestionId === suggestionId),
    onAdminAction: (action, args) => action === 'adopt' ? executeAdminAdoptSuggestion(args) :
      action === 'unadopt' ? executeAdminUnadoptSuggestion(args) : executeAdminChangeSuggestionStatus(args),
    onReconnect: () => { stopAdminDiscussion(); connectAdminDiscussion(); }
  });
  const previous = select.value;
  const available = state.distributions.filter(d => d.tripId === state.activeTrip?.tripId && d.status === 'active');
  select.replaceChildren();
  const empty = document.createElement('option');
  empty.value = ''; empty.textContent = available.length ? '配布先を選択' : 'この旅行の有効な配布先はありません';
  select.append(empty);
  for (const distribution of available) {
    const option = document.createElement('option');
    option.value = distribution.roomId || distribution.id; option.textContent = distribution.label || '名称未設定の配布先';
    select.append(option);
  }
  select.value = available.some(d => (d.roomId || d.id) === previous) ? previous : available.length === 1 ? available[0].roomId || available[0].id : '';
  if (state.currentView === 'editor') connectAdminDiscussion();
  else stopAdminDiscussion();
}

window._executeAdminAdoptSuggestion = executeAdminAdoptSuggestion;
window._executeAdminUnadoptSuggestion = executeAdminUnadoptSuggestion;
window._executeAdminChangeSuggestionStatus = executeAdminChangeSuggestionStatus;

bindEvents();
onAuthStateChanged(auth, handleAuthState);
