import { initializeApp, getApp, getApps } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCOh5MtRbplm-46FETshOQAGHqyQ4fD4tA',
  authDomain: 'shikoku-drive.firebaseapp.com',
  projectId: 'shikoku-drive',
  storageBucket: 'shikoku-drive.firebasestorage.app',
  messagingSenderId: '100077385758',
  appId: '1:100077385758:web:dd63588317da1edc9b560f',
  measurementId: 'G-VV9YHYW85C'
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

const state = {
  currentUser: null,
  trips: new Map(),
  publishedIds: new Set(),
  activeTrip: null,
  activeDayKey: '',
  distributions: [],
  participantUnsubscribers: new Map(),
  distributionsUnsubscribe: null,
  toastTimer: null
};

const $ = id => document.getElementById(id);
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

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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
    return snapshot.exists() && snapshot.data()?.active === true;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function enterAdmin(user) {
  state.currentUser = user;
  $('admin-account').textContent = user.email || user.displayName || user.uid;
  $('admin-auth').hidden = true;
  $('admin-app').hidden = false;
  await loadDashboard();
}

function stopLiveListeners() {
  state.distributionsUnsubscribe?.();
  state.distributionsUnsubscribe = null;
  state.participantUnsubscribers.forEach(unsubscribe => unsubscribe());
  state.participantUnsubscribers.clear();
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
    if (!(await verifyAdministrator(user))) {
      setAuthScreen({
        message: `${user.email || 'このアカウント'} は、まだ管理者として登録されていません。`,
        user,
        canSignIn: true,
        accessDenied: true
      });
      return;
    }
    await enterAdmin(user);
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
  const trip = deepClone(raw || {});
  trip.tripId = text(trip.tripId || fallbackId).trim();
  trip.title = text(trip.title || 'TRAVEL GUIDE');
  trip.subtitle = text(trip.subtitle);
  trip.catchphrase = text(trip.catchphrase);
  trip.startDate = text(trip.startDate);
  trip.endDate = text(trip.endDate);
  trip.days = trip.days && typeof trip.days === 'object' && !Array.isArray(trip.days) ? trip.days : { day1: [] };
  trip.dayLabels = trip.dayLabels && typeof trip.dayLabels === 'object' ? trip.dayLabels : {};
  Object.keys(trip.days).forEach(key => {
    if (!Array.isArray(trip.days[key])) trip.days[key] = [];
    if (!trip.dayLabels[key]) trip.dayLabels[key] = key.toUpperCase();
  });
  return trip;
}

async function loadStaticTrips() {
  const registryResponse = await fetch('data/trips.json', { cache: 'no-store' });
  if (!registryResponse.ok) throw new Error(`trips.json: ${registryResponse.status}`);
  const registry = await registryResponse.json();
  await Promise.all(registry.map(async entry => {
    const response = await fetch(entry.config, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${entry.config}: ${response.status}`);
    const trip = normalizeTrip(await response.json(), entry.id);
    state.trips.set(trip.tripId, { trip, source: 'static', updatedAt: null });
  }));
}

async function loadCloudTrips() {
  const [drafts, published] = await Promise.all([
    getDocs(collection(db, 'adminTrips')),
    getDocs(collection(db, 'publishedTrips'))
  ]);
  state.publishedIds = new Set(published.docs.filter(item => item.data().published === true).map(item => item.id));
  drafts.forEach(item => {
    const data = item.data();
    try {
      const trip = normalizeTrip(JSON.parse(data.payloadJson), item.id);
      state.trips.set(item.id, { trip, source: 'cloud', updatedAt: data.updatedAt || null });
    } catch (error) {
      console.warn(`Invalid adminTrips/${item.id}`, error);
    }
  });
}

async function loadDashboard() {
  stopLiveListeners();
  state.trips.clear();
  try {
    await loadStaticTrips();
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
    const card = makeElement('article', 'trip-card');
    const header = makeElement('div', 'distribution-head');
    header.append(makeElement('span', `pill ${state.publishedIds.has(tripId) ? '' : 'draft'}`, state.publishedIds.has(tripId) ? '公開中' : '下書き'));
    header.append(makeElement('span', 'muted small', tripId));
    const title = makeElement('h3', '', trip.title || tripId);
    const description = makeElement('p', '', trip.catchphrase || trip.subtitle || '説明は未設定です');
    const meta = makeElement('div', 'trip-meta');
    meta.append(makeElement('span', '', `${trip.startDate || '未定'} → ${trip.endDate || '未定'}`));
    meta.append(makeElement('span', '', `${Object.keys(trip.days).length} DAYS`));
    const actions = makeElement('div', 'trip-actions');
    const edit = makeElement('button', 'compact', '編集');
    edit.type = 'button';
    edit.addEventListener('click', () => openTripEditor(tripId));
    const distribute = makeElement('button', 'compact ghost', '配布');
    distribute.type = 'button';
    distribute.addEventListener('click', () => openDistribution(tripId));
    actions.append(edit, distribute);
    card.append(header, title, description, meta, actions);
    list.append(card);
  });
}

function showView(viewName) {
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
    title: 'TRAVEL GUIDE',
    subtitle: '',
    catchphrase: '',
    startDate: '',
    endDate: '',
    dayLabels: { day1: 'DAY 1' },
    days: { day1: [] },
    ferryLegs: { day1: [] },
    members: [{ id: 'aoi', name: 'メンバー1' }, { id: 'kotaro', name: 'メンバー2' }],
    weatherLocations: {},
    checklist: []
  });
}

function openTripEditor(tripId = '') {
  state.activeTrip = tripId && state.trips.has(tripId)
    ? deepClone(state.trips.get(tripId).trip)
    : blankTrip();
  state.activeDayKey = Object.keys(state.activeTrip.days)[0] || 'day1';
  renderEditor();
  showView('editor');
}

function readTripBasics() {
  if (!state.activeTrip) return;
  state.activeTrip.tripId = $('trip-id').value.trim();
  state.activeTrip.title = $('trip-title').value.trim();
  state.activeTrip.subtitle = $('trip-subtitle').value.trim();
  state.activeTrip.catchphrase = $('trip-catchphrase').value.trim();
  state.activeTrip.startDate = $('trip-start-date').value;
  state.activeTrip.endDate = $('trip-end-date').value;
  if (state.activeDayKey) state.activeTrip.dayLabels[state.activeDayKey] = $('editor-day-label').value.trim();
}

function renderEditor() {
  const trip = state.activeTrip;
  if (!trip) return;
  $('trip-id').value = trip.tripId;
  $('trip-title').value = trip.title;
  $('trip-subtitle').value = trip.subtitle;
  $('trip-catchphrase').value = trip.catchphrase;
  $('trip-start-date').value = trip.startDate;
  $('trip-end-date').value = trip.endDate;
  renderDaySelect();
  renderEditorCards();
  hideEditorErrors();
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
    row.append(makeElement('div', 'editor-card-time', card.time || '—'));
    const copy = makeElement('div');
    copy.append(makeElement('strong', '', card.title || 'タイトル未設定'));
    copy.append(makeElement('span', '', `${card.badge || 'CARD'}${card.expenseShortcut ? ' · 割り勘' : ''}`));
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
  const numbers = Object.keys(state.activeTrip.days).map(key => Number((key.match(/\d+/) || [0])[0]));
  const next = Math.max(0, ...numbers) + 1;
  const dayKey = `day${next}`;
  state.activeTrip.days[dayKey] = [];
  state.activeTrip.dayLabels[dayKey] = `DAY ${next}`;
  state.activeTrip.ferryLegs ||= {};
  state.activeTrip.ferryLegs[dayKey] ||= [];
  state.activeDayKey = dayKey;
  renderDaySelect();
  renderEditorCards();
}

function cardFieldMap() {
  return {
    time: $('card-time').value.trim(),
    badge: $('card-badge').value.trim(),
    title: $('card-title').value.trim(),
    desc: $('card-desc').value.trim(),
    lat: $('card-lat').value.trim(),
    lon: $('card-lon').value.trim(),
    mapQuery: $('card-map-query').value.trim(),
    official: $('card-official').value.trim(),
    officialLabel: $('card-official-label').value.trim(),
    tabelog: $('card-tabelog').value.trim(),
    jalan: $('card-jalan').value.trim(),
    image: $('card-image').value.trim(),
    map: $('card-map-enabled').checked,
    expenseShortcut: $('card-expense').checked,
    fixed: $('card-fixed').checked,
    rigid: $('card-rigid').checked
  };
}

function cleanCard(card) {
  const cleaned = { ...card };
  ['time', 'badge', 'title', 'desc', 'mapQuery', 'official', 'officialLabel', 'tabelog', 'jalan', 'image'].forEach(key => {
    const value = text(cleaned[key]).trim();
    if (value) cleaned[key] = value;
    else delete cleaned[key];
  });
  ['lat', 'lon'].forEach(key => {
    const value = text(cleaned[key]).trim();
    if (!value) delete cleaned[key];
    else if (Number.isFinite(Number(value))) cleaned[key] = Number(value);
  });
  if (cleaned.map === true) delete cleaned.map;
  if (cleaned.map === false) cleaned.map = false;
  if (!cleaned.expenseShortcut) delete cleaned.expenseShortcut;
  if (!cleaned.fixed) delete cleaned.fixed;
  if (!cleaned.rigid) delete cleaned.rigid;
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
  $('card-lat').value = text(card.lat);
  $('card-lon').value = text(card.lon);
  $('card-map-query').value = text(card.mapQuery);
  $('card-official').value = text(card.official);
  $('card-official-label').value = text(card.officialLabel);
  $('card-tabelog').value = text(card.tabelog);
  $('card-jalan').value = text(card.jalan);
  $('card-image').value = text(card.image);
  $('card-map-enabled').checked = card.map !== false;
  $('card-expense').checked = card.expenseShortcut === true;
  $('card-fixed').checked = card.fixed === true;
  $('card-rigid').checked = card.rigid === true;
  $('delete-card').hidden = index < 0;
  $('move-card-up').hidden = index <= 0;
  $('move-card-down').hidden = index < 0 || index >= cards.length - 1;
  $('card-dialog').showModal();
}

function saveCard(event) {
  event.preventDefault();
  const index = Number($('card-index').value);
  const cards = state.activeTrip.days[state.activeDayKey];
  const base = index >= 0 ? cards[index] : {};
  const next = cleanCard({ ...base, ...cardFieldMap() });
  if (!next.title || !next.desc) {
    showToast('タイトルと説明を入力してください。', true);
    return;
  }
  if (index >= 0) cards[index] = next;
  else cards.push(next);
  $('card-dialog').close();
  renderEditorCards();
}

function deleteCard() {
  const index = Number($('card-index').value);
  if (index < 0) return;
  if (!window.confirm('このカードを削除しますか？')) return;
  state.activeTrip.days[state.activeDayKey].splice(index, 1);
  $('card-dialog').close();
  renderEditorCards();
}

function moveCard(direction) {
  const index = Number($('card-index').value);
  const cards = state.activeTrip.days[state.activeDayKey];
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= cards.length) return;
  [cards[index], cards[destination]] = [cards[destination], cards[index]];
  $('card-dialog').close();
  renderEditorCards();
  openCardDialog(destination);
}

function validateTrip(trip) {
  const errors = [];
  if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(trip.tripId)) errors.push('しおりIDは英小文字・数字・_・- の3〜40文字にしてください。');
  if (!trip.title) errors.push('タイトルを入力してください。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trip.startDate)) errors.push('開始日を入力してください。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trip.endDate)) errors.push('終了日を入力してください。');
  if (trip.startDate && trip.endDate && trip.startDate > trip.endDate) errors.push('終了日は開始日以降にしてください。');
  const dayKeys = Object.keys(trip.days || {});
  if (!dayKeys.length) errors.push('日程を1日以上作成してください。');
  const validUrl = value => !value || /^https:\/\//i.test(value);
  dayKeys.forEach(dayKey => {
    const cards = trip.days[dayKey];
    if (!Array.isArray(cards)) {
      errors.push(`${dayKey}: カード一覧が不正です。`);
      return;
    }
    cards.forEach((card, index) => {
      const label = `${dayKey.toUpperCase()} カード${index + 1}`;
      if (!card.title) errors.push(`${label}: タイトルがありません。`);
      if (!card.desc) errors.push(`${label}: 説明がありません。`);
      ['official', 'tabelog', 'jalan'].forEach(key => {
        if (!validUrl(card[key])) errors.push(`${label}: ${key} は https URLにしてください。`);
      });
      if (card.lat != null && !Number.isFinite(Number(card.lat))) errors.push(`${label}: 緯度が不正です。`);
      if (card.lon != null && !Number.isFinite(Number(card.lon))) errors.push(`${label}: 経度が不正です。`);
    });
  });
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
  readTripBasics();
  const errors = validateTrip(state.activeTrip);
  if (errors.length) {
    showEditorErrors(errors);
    return;
  }
  hideEditorErrors();
  const button = publish ? $('publish-trip') : $('save-draft');
  setBusy(button, true, publish ? '公開中…' : '保存中…');
  const tripId = state.activeTrip.tripId;
  const payloadJson = JSON.stringify(state.activeTrip);
  try {
    if (publish) {
      const batch = writeBatch(db);
      batch.set(doc(db, 'adminTrips', tripId), {
        tripId,
        title: state.activeTrip.title,
        status: 'published',
        payloadJson,
        updatedAt: serverTimestamp(),
        updatedBy: state.currentUser.uid
      }, { merge: true });
      batch.set(doc(db, 'publishedTrips', tripId), {
        tripId,
        title: state.activeTrip.title,
        published: true,
        payloadJson,
        publishedAt: serverTimestamp(),
        updatedBy: state.currentUser.uid
      });
      await batch.commit();
      state.publishedIds.add(tripId);
      showToast('参加者ページへ公開しました。');
    } else {
      await setDoc(doc(db, 'adminTrips', tripId), {
        tripId,
        title: state.activeTrip.title,
        status: state.publishedIds.has(tripId) ? 'published' : 'draft',
        payloadJson,
        updatedAt: serverTimestamp(),
        updatedBy: state.currentUser.uid
      }, { merge: true });
      showToast('下書きを保存しました。参加者ページは変わっていません。');
    }
    state.trips.set(tripId, { trip: deepClone(state.activeTrip), source: 'cloud', updatedAt: new Date() });
    renderTripLibrary();
    populateTripSelects();
  } catch (error) {
    console.error(error);
    showToast(`保存に失敗しました: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

function downloadActiveTrip() {
  if (!state.activeTrip) return;
  readTripBasics();
  const blob = new Blob([`${JSON.stringify(state.activeTrip, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${state.activeTrip.tripId || 'trip'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function importTrip(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    state.activeTrip = normalizeTrip(parsed);
    state.activeDayKey = Object.keys(state.activeTrip.days)[0] || 'day1';
    renderEditor();
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
  showView('distribution');
  if (tripId && state.trips.has(tripId)) $('distribution-trip').value = tripId;
}

function startDistributionListener() {
  state.distributionsUnsubscribe?.();
  state.distributionsUnsubscribe = onSnapshot(collection(db, 'adminDistributions'), snapshot => {
    state.distributions = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderDistributions();
  }, error => {
    console.error(error);
    showToast('配布先一覧を取得できませんでした。', true);
  });
}

function distributionInviteUrl(distribution) {
  const url = new URL('./', window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('trip', distribution.tripId);
  url.searchParams.set('ledger', distribution.ledgerToken);
  url.searchParams.set('invite', distribution.inviteToken);
  return url.toString();
}

async function createDistribution() {
  const tripId = $('distribution-trip').value;
  const label = $('distribution-label').value.trim();
  if (!tripId || !state.trips.has(tripId)) {
    showToast('配布する旅行を選択してください。', true);
    return;
  }
  if (!label) {
    showToast('配布先名を入力してください。', true);
    return;
  }
  const button = $('create-distribution');
  setBusy(button, true, '発行中…');
  const ledgerToken = randomToken();
  const inviteToken = randomToken();
  const roomId = `${tripId}_${ledgerToken}`;
  try {
    const inviteHash = await sha256(inviteToken);
    const batch = writeBatch(db);
    batch.set(doc(db, 'rooms', roomId), {
      schemaVersion: 2,
      tripId,
      label,
      status: 'active',
      capacity: 2,
      members: {},
      inviteHash,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: state.currentUser.uid
    });
    batch.set(doc(db, 'adminDistributions', roomId), {
      roomId,
      tripId,
      label,
      ledgerToken,
      inviteToken,
      status: 'active',
      capacity: 2,
      createdAt: serverTimestamp(),
      createdBy: state.currentUser.uid
    });
    await batch.commit();
    $('distribution-label').value = '';
    showToast('招待リンクを発行しました。');
  } catch (error) {
    console.error(error);
    showToast(`招待リンクを発行できません: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

function subscribeDistributionParticipants(distribution) {
  if (state.participantUnsubscribers.has(distribution.id)) return;
  const ref = collection(db, 'rooms', distribution.roomId || distribution.id, 'participants');
  const unsubscribe = onSnapshot(ref, snapshot => {
    distribution.participants = snapshot.docs.map(item => ({ uid: item.id, ...item.data() }));
    renderDistributions();
  }, error => {
    console.warn(`participants/${distribution.id}`, error);
  });
  state.participantUnsubscribers.set(distribution.id, unsubscribe);
}

function renderDistributions() {
  const list = $('distribution-list');
  list.replaceChildren();
  const activeCount = state.distributions.filter(item => item.status === 'active').length;
  $('metric-invites').textContent = String(activeCount);
  $('distribution-count').textContent = `${state.distributions.length}件`;
  if (!state.distributions.length) {
    list.append(makeElement('div', 'empty-state', '配布先はまだありません。旅行を選び、招待リンクを発行してください。'));
    return;
  }
  const activeIds = new Set(state.distributions.map(item => item.id));
  [...state.participantUnsubscribers.entries()].forEach(([id, unsubscribe]) => {
    if (!activeIds.has(id)) {
      unsubscribe();
      state.participantUnsubscribers.delete(id);
    }
  });
  state.distributions.forEach(distribution => {
    subscribeDistributionParticipants(distribution);
    const card = makeElement('article', 'distribution-card');
    const head = makeElement('div', 'distribution-head');
    const left = makeElement('div');
    left.append(makeElement('span', `pill ${distribution.status === 'active' ? '' : 'draft'}`, distribution.status === 'active' ? '有効' : '停止'));
    left.append(makeElement('h3', '', distribution.label || '名称未設定'));
    left.append(makeElement('span', 'muted small', `${distribution.tripId} · ${formatTimestamp(distribution.createdAt)}`));
    const participantCount = distribution.participants?.length || 0;
    head.append(left, makeElement('strong', '', `${participantCount}/${distribution.capacity || 2}名`));
    const invite = makeElement('code', 'invite-url', distributionInviteUrl(distribution));
    const participants = makeElement('div', 'participant-list');
    if (participantCount) {
      distribution.participants.forEach(person => participants.append(makeElement('span', 'participant', person.nickname || '名前未設定')));
    } else {
      participants.append(makeElement('span', 'muted small', 'まだ参加者はいません'));
    }
    const actions = makeElement('div', 'trip-actions');
    const copy = makeElement('button', 'compact primary', '招待リンクをコピー');
    copy.type = 'button';
    copy.disabled = distribution.status !== 'active';
    copy.addEventListener('click', () => copyText(distributionInviteUrl(distribution), '招待リンクをコピーしました。'));
    const toggle = makeElement('button', `compact ${distribution.status === 'active' ? 'danger' : ''}`, distribution.status === 'active' ? '配布を停止' : '再開');
    toggle.type = 'button';
    toggle.addEventListener('click', () => toggleDistribution(distribution));
    actions.append(copy, toggle);
    card.append(head, invite, participants, actions);
    list.append(card);
  });
}

async function toggleDistribution(distribution) {
  const status = distribution.status === 'active' ? 'revoked' : 'active';
  if (status === 'revoked' && !window.confirm('この招待リンクを停止しますか？参加済みユーザーも同期できなくなります。')) return;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'adminDistributions', distribution.id), { status, updatedAt: serverTimestamp() });
    batch.update(doc(db, 'rooms', distribution.roomId || distribution.id), { status, updatedAt: serverTimestamp() });
    await batch.commit();
    showToast(status === 'active' ? '配布を再開しました。' : '配布を停止しました。');
  } catch (error) {
    console.error(error);
    showToast(`配布状態を変更できません: ${error.message}`, true);
  }
}

function bindEvents() {
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
  $('admin-sign-out').addEventListener('click', () => signOut(auth));
  $('copy-admin-uid').addEventListener('click', () => copyText($('admin-uid').textContent, 'UIDをコピーしました。'));
  document.querySelectorAll('[data-admin-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.adminView)));
  $('overview-new-trip').addEventListener('click', () => openTripEditor());
  $('editor-day-select').addEventListener('change', event => {
    readTripBasics();
    state.activeDayKey = event.target.value;
    $('editor-day-label').value = state.activeTrip.dayLabels[state.activeDayKey] || '';
    renderEditorCards();
  });
  $('editor-day-label').addEventListener('input', event => {
    if (state.activeTrip && state.activeDayKey) state.activeTrip.dayLabels[state.activeDayKey] = event.target.value;
  });
  $('add-day').addEventListener('click', addDay);
  $('add-card').addEventListener('click', () => openCardDialog(-1));
  $('close-card-dialog').addEventListener('click', () => $('card-dialog').close());
  $('card-form').addEventListener('submit', saveCard);
  $('delete-card').addEventListener('click', deleteCard);
  $('move-card-up').addEventListener('click', () => moveCard(-1));
  $('move-card-down').addEventListener('click', () => moveCard(1));
  $('save-draft').addEventListener('click', () => persistTrip(false));
  $('publish-trip').addEventListener('click', () => persistTrip(true));
  $('download-trip').addEventListener('click', downloadActiveTrip);
  $('import-trip-file').addEventListener('change', event => importTrip(event.target.files?.[0]));
  $('create-distribution').addEventListener('click', createDistribution);
  window.addEventListener('beforeunload', stopLiveListeners);
}

bindEvents();
onAuthStateChanged(auth, handleAuthState);
