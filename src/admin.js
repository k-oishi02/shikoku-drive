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
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  runTransaction,
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

const ADMIN_APP_NAME = 'shiori-admin';
const app = getApps().find(existingApp => existingApp.name === ADMIN_APP_NAME)
  || initializeApp(firebaseConfig, ADMIN_APP_NAME);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

const state = {
  currentUser: null,
  trips: new Map(),
  publishedIds: new Set(),
  publishedTrips: new Map(),
  activeTrip: null,
  activeDayKey: '',
  distributions: [],
  participantUnsubscribers: new Map(),
  expenseUnsubscribers: new Map(),
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
      state.trips.set(item.id, { trip, source: 'published', updatedAt: data.publishedAt || null });
    } catch (error) {
      console.warn(`Invalid publishedTrips/${item.id}`, error);
    }
  });
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

function remapFerryLegs(dayKey, mapper) {
  const legs = state.activeTrip?.ferryLegs?.[dayKey];
  if (!Array.isArray(legs)) return;
  state.activeTrip.ferryLegs[dayKey] = legs.map(leg => {
    if (!leg || !Number.isInteger(leg.from) || !Number.isInteger(leg.to)) return null;
    const from = mapper(leg.from);
    const to = mapper(leg.to);
    return Number.isInteger(from) && Number.isInteger(to) ? { ...leg, from, to } : null;
  }).filter(Boolean);
}

function deleteCard() {
  const index = Number($('card-index').value);
  if (index < 0) return;
  if (!window.confirm('このカードを削除しますか？')) return;
  state.activeTrip.days[state.activeDayKey].splice(index, 1);
  remapFerryLegs(state.activeDayKey, value => value === index ? null : (value > index ? value - 1 : value));
  $('card-dialog').close();
  renderEditorCards();
}

function moveCard(direction) {
  const index = Number($('card-index').value);
  const cards = state.activeTrip.days[state.activeDayKey];
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= cards.length) return;
  [cards[index], cards[destination]] = [cards[destination], cards[index]];
  remapFerryLegs(state.activeDayKey, value => value === index ? destination : (value === destination ? index : value));
  $('card-dialog').close();
  renderEditorCards();
  openCardDialog(destination);
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
    const parts = match.slice(1).map(Number);
    if (parts[0] > 23 || parts[1] > 59 || parts[2] > 23 || parts[3] > 59) return null;
    return { start: parts[0] * 60 + parts[1], end: parts[2] * 60 + parts[3] };
  };
  if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(trip.tripId)) errors.push('しおりIDは英小文字・数字・_・- の3〜40文字にしてください。');
  if (!trip.title) errors.push('タイトルを入力してください。');
  if (!validDate(trip.startDate)) errors.push('開始日を正しい日付で入力してください。');
  if (!validDate(trip.endDate)) errors.push('終了日を正しい日付で入力してください。');
  if (trip.startDate && trip.endDate && trip.startDate > trip.endDate) errors.push('終了日は開始日以降にしてください。');
  const dayKeys = Object.keys(trip.days || {});
  if (!dayKeys.length) errors.push('日程を1日以上作成してください。');
  const cardIds = new Set();
  const validUrl = value => {
    if (!value) return true;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && Boolean(parsed.hostname);
    } catch (error) {
      return false;
    }
  };
  dayKeys.forEach(dayKey => {
    if (!/^day[1-9]\d*$/.test(dayKey)) errors.push(`${dayKey}: 日キーはday1、day2の形式にしてください。`);
    const cards = trip.days[dayKey];
    let previousEnd = -1;
    if (!Array.isArray(cards)) {
      errors.push(`${dayKey}: カード一覧が不正です。`);
      return;
    }
    cards.forEach((card, index) => {
      const label = `${dayKey.toUpperCase()} カード${index + 1}`;
      if (card.id) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(text(card.id))) errors.push(`${label}: カードIDは英数字・_・-の80文字以内にしてください。`);
        else if (cardIds.has(card.id)) errors.push(`${label}: カードID ${card.id} が重複しています。`);
        else cardIds.add(card.id);
      }
      if (!card.title) errors.push(`${label}: タイトルがありません。`);
      if (text(card.title).length > 120) errors.push(`${label}: タイトルは120文字以内にしてください。`);
      if (!card.badge) errors.push(`${label}: バッジがありません。`);
      if (!card.desc) errors.push(`${label}: 説明がありません。`);
      if (text(card.desc).length > 2000) errors.push(`${label}: 説明は2000文字以内にしてください。`);
      if (card.time === 'OPTIONAL') {
        // Optional cards do not reserve a fixed slot.
      } else {
        const minutes = scheduledMinutes(card.time);
        if (!minutes || minutes.end <= minutes.start) {
          errors.push(`${label}: 時刻は「09:00 - 10:00」形式で、終了を開始より後にしてください。`);
        } else {
          if (minutes.start < previousEnd) errors.push(`${label}: 前の確定予定と時刻が重複しています。`);
          previousEnd = Math.max(previousEnd, minutes.end);
        }
      }
      ['official', 'tabelog', 'jalan'].forEach(key => {
        if (!validUrl(card[key])) errors.push(`${label}: ${key} は https URLにしてください。`);
      });
      for (const [linkIndex, link] of (Array.isArray(card.links) ? card.links : []).entries()) {
        if (!text(link?.label).trim()) errors.push(`${label}: 追加リンク${linkIndex + 1}の名前がありません。`);
        if (!validUrl(link?.url)) errors.push(`${label}: 追加リンク${linkIndex + 1}は https URLにしてください。`);
      }
      for (const [walletKind, walletUrl] of Object.entries(card.wallet || {})) {
        if (!validUrl(walletUrl)) errors.push(`${label}: wallet.${walletKind} は https URLにしてください。`);
      }
      if (card.lat != null && (!Number.isFinite(Number(card.lat)) || Number(card.lat) < -90 || Number(card.lat) > 90)) errors.push(`${label}: 緯度は-90〜90にしてください。`);
      if (card.lon != null && (!Number.isFinite(Number(card.lon)) || Number(card.lon) < -180 || Number(card.lon) > 180)) errors.push(`${label}: 経度は-180〜180にしてください。`);
      if (card.image && !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif|svg)$/i.test(text(card.image))) errors.push(`${label}: 画像はimagesフォルダ内の安全なファイル名にしてください。`);
    });
    const ferryLegs = trip.ferryLegs?.[dayKey] || [];
    if (!Array.isArray(ferryLegs)) {
      errors.push(`${dayKey}: フェリー区間が配列ではありません。`);
    } else {
      const confirmed = cards.map((card, index) => ({ card, index }))
        .filter(({ card }) => card.time !== 'OPTIONAL' && card.map !== false && Number.isFinite(Number(card.lat)) && Number.isFinite(Number(card.lon)))
        .map(({ index }) => index);
      ferryLegs.forEach((leg, legIndex) => {
        const label = `${dayKey.toUpperCase()} フェリー区間${legIndex + 1}`;
        if (!leg || !Number.isInteger(leg.from) || !Number.isInteger(leg.to)) {
          errors.push(`${label}: from/toは整数にしてください。`);
          return;
        }
        if (leg.from < 0 || leg.to < 0 || leg.from >= cards.length || leg.to >= cards.length) {
          errors.push(`${label}: 参照先カードが範囲外です。`);
          return;
        }
        if (leg.to !== leg.from + 1 || confirmed.indexOf(leg.to) !== confirmed.indexOf(leg.from) + 1) {
          errors.push(`${label}: 隣接する確定ルートカードを指定してください。`);
        }
      });
    }
  });
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
      const distributionSnapshot = await getDocs(collection(db, 'adminDistributions'));
      const activeDistributions = distributionSnapshot.docs
        .map(item => ({ id: item.id, ...item.data() }))
        .filter(distribution => distribution.tripId === tripId && distribution.status === 'active' && distribution.grantId);
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
      activeDistributions.slice(0, 450).forEach(distribution => batch.set(doc(db, 'accessGrants', distribution.grantId), {
        title: state.activeTrip.title,
        payloadJson,
        updatedAt: serverTimestamp()
      }, { merge: true }));
      await batch.commit();
      for (let offset = 450; offset < activeDistributions.length; offset += 450) {
        const grantBatch = writeBatch(db);
        activeDistributions.slice(offset, offset + 450).forEach(distribution => grantBatch.set(doc(db, 'accessGrants', distribution.grantId), {
          title: state.activeTrip.title,
          payloadJson,
          updatedAt: serverTimestamp()
        }, { merge: true }));
        await grantBatch.commit();
      }
      state.publishedIds.add(tripId);
      state.publishedTrips.set(tripId, deepClone(state.activeTrip));
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
    const previousParticipants = new Map(state.distributions.map(item => [item.id, item.participants || []]));
    const previousExpenses = new Map(state.distributions.map(item => [item.id, item.expenses || []]));
    const previousExpenseState = new Map(state.distributions.map(item => [item.id, {
      ready: item.expensesReady === true,
      error: item.expensesError || ''
    }]));
    state.distributions = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data(),
      participants: previousParticipants.get(item.id) || [],
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

function participantInviteUrl(accessId) {
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
    showToast('定員は1〜50名の整数で入力してください。', true);
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
      inviteHash: grantId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: state.currentUser.uid
    });
    batch.set(doc(db, 'adminDistributions', roomId), {
      roomId,
      tripId,
      label,
      ledgerToken,
      inviteToken: accessId,
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
          note: text(data.note),
          comment: text(data.comment),
          createdAt: text(data.createdAt)
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
    copy.append(makeElement('strong', '', expense.note || expense.category || '支出'));
    copy.append(makeElement('small', '', [expense.category || 'その他', (participantNames.get(expense.payer) || '参加者') + 'が支払い', formatTimestamp(expense.createdAt)].join(' · ')));
    if (expense.comment) copy.append(makeElement('small', 'admin-ledger-comment', expense.comment));
    row.append(copy, makeElement('strong', 'admin-ledger-amount', formatYen(expense.amount)));
    list.append(row);
  });
  panel.append(list);
  return panel;
}

function renderDistributions() {
  const list = $('distribution-list');
  list.replaceChildren();
  const activeCount = state.distributions.filter(item => item.status === 'active').length;
  $('metric-invites').textContent = String(activeCount);
  $('distribution-count').textContent = `${state.distributions.length}件`;
  if (!state.distributions.length) {
    list.append(makeElement('div', 'empty-state', '配布先はまだありません。旅行を選び、配布IDを発行してください。'));
    return;
  }
  const activeIds = new Set(state.distributions.map(item => item.id));
  [...state.participantUnsubscribers.entries()].forEach(([id, unsubscribe]) => {
    if (!activeIds.has(id)) {
      unsubscribe();
      state.participantUnsubscribers.delete(id);
    }
  });
  [...state.expenseUnsubscribers.entries()].forEach(([id, unsubscribe]) => {
    if (!activeIds.has(id)) {
      unsubscribe();
      state.expenseUnsubscribers.delete(id);
    }
  });
  state.distributions.forEach(distribution => {
    subscribeDistributionParticipants(distribution);
    subscribeDistributionExpenses(distribution);
    const card = makeElement('article', 'distribution-card');
    const head = makeElement('div', 'distribution-head');
    const left = makeElement('div');
    left.append(makeElement('span', `pill ${distribution.status === 'active' ? '' : 'draft'}`, distribution.status === 'active' ? '有効' : '停止'));
    left.append(makeElement('h3', '', distribution.label || '名称未設定'));
    left.append(makeElement('span', 'muted small', `${distribution.tripId} · ${formatTimestamp(distribution.createdAt)}`));
    const participantCount = distribution.participants?.length || 0;
    const capacity = Number.isInteger(Number(distribution.capacity)) ? Number(distribution.capacity) : 2;
    head.append(left, makeElement('strong', '', `${participantCount}/${capacity}名`));
    const accessId = distribution.accessId ? formatAccessId(distribution.accessId) : '旧方式：新しい配布IDを発行してください';
    const invite = makeElement('code', 'invite-url', accessId);
    const participants = makeElement('div', 'participant-list');
    if (participantCount) {
      distribution.participants.forEach(person => participants.append(makeElement('span', 'participant', person.nickname || '名前未設定')));
    } else {
      participants.append(makeElement('span', 'muted small', 'まだ参加者はいません'));
    }
    const capacityControl = makeElement('div', 'capacity-control');
    const capacityLabel = makeElement('label', '', '定員');
    const capacityInput = document.createElement('input');
    capacityInput.type = 'number';
    capacityInput.min = String(Math.max(1, participantCount));
    capacityInput.max = '50';
    capacityInput.step = '1';
    capacityInput.value = String(capacity);
    const updateCapacity = makeElement('button', 'compact ghost', '定員を変更');
    updateCapacity.type = 'button';
    updateCapacity.addEventListener('click', () => updateDistributionCapacity(distribution, Number(capacityInput.value), updateCapacity));
    capacityLabel.append(capacityInput);
    capacityControl.append(capacityLabel, updateCapacity);

    const actions = makeElement('div', 'trip-actions');
    const copyLink = makeElement('button', 'compact primary', '登録リンクをコピー');
    copyLink.type = 'button';
    copyLink.disabled = distribution.status !== 'active' || !distribution.accessId;
    copyLink.addEventListener('click', () => copyText(participantInviteUrl(distribution.accessId), '自動登録リンクをコピーしました。'));
    const copy = makeElement('button', 'compact ghost', '配布IDをコピー');
    copy.type = 'button';
    copy.disabled = distribution.status !== 'active' || !distribution.accessId;
    copy.addEventListener('click', () => copyText(formatAccessId(distribution.accessId), '配布IDをコピーしました。'));
    const copyApp = makeElement('button', 'compact ghost', '空のアプリURLをコピー');
    copyApp.type = 'button';
    copyApp.addEventListener('click', () => copyText(participantAppUrl(), '空の参加者アプリURLをコピーしました。'));
    const toggle = makeElement('button', `compact ${distribution.status === 'active' ? 'danger' : ''}`, distribution.status === 'active' ? '配布を停止' : '再開');
    toggle.type = 'button';
    toggle.addEventListener('click', () => toggleDistribution(distribution));
    actions.append(copyLink, copy, copyApp, toggle);
    const ledger = renderDistributionLedger(distribution);
    card.append(head, invite, participants, ledger, capacityControl, actions);
    list.append(card);
  });
}

async function updateDistributionCapacity(distribution, capacity, button) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) {
    showToast('定員は1〜50名の整数で入力してください。', true);
    return;
  }
  setBusy(button, true, '変更中…');
  try {
    const roomRef = doc(db, 'rooms', distribution.roomId || distribution.id);
    const roomSnapshot = await getDoc(roomRef);
    if (!roomSnapshot.exists()) throw new Error('配布ルームが見つかりません。');
    const memberCount = Object.keys(roomSnapshot.data()?.members || {}).length;
    if (capacity < memberCount) throw new Error(`現在${memberCount}名が登録済みです。定員をそれ未満にはできません。`);
    await runTransaction(db, async transaction => {
      const latestRoom = await transaction.get(roomRef);
      if (!latestRoom.exists()) throw new Error('配布ルームが見つかりません。');
      const latestMemberCount = Object.keys(latestRoom.data()?.members || {}).length;
      if (capacity < latestMemberCount) throw new Error(`現在${latestMemberCount}名が登録済みです。定員をそれ未満にはできません。`);
      transaction.update(roomRef, { capacity, updatedAt: serverTimestamp() });
      transaction.update(doc(db, 'adminDistributions', distribution.id), { capacity, updatedAt: serverTimestamp() });
    });
    showToast(`定員を${capacity}名へ変更しました。`);
  } catch (error) {
    console.error(error);
    showToast(`定員を変更できません: ${error.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

async function toggleDistribution(distribution) {
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
