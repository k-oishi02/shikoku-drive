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
import { analyzeTrip, migrateTripToV2 } from './trip-v2-index.js';

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
  currentRole: 'editor',
  adminProfiles: [],
  trips: new Map(),
  publishedIds: new Set(),
  publishedTrips: new Map(),
  activeTrip: null,
  activeDayKey: '',
  distributions: [],
  participantUnsubscribers: new Map(),
  roomUnsubscribers: new Map(),
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
    const duplicate = makeElement('button', 'compact ghost', '複製');
    duplicate.type = 'button';
    duplicate.addEventListener('click', () => duplicateTrip(tripId));
    const archive = makeElement('button', 'compact ghost', trip.archived ? '戻す' : '保管');
    archive.type = 'button';
    archive.addEventListener('click', () => toggleTripArchive(tripId));
    card.classList.toggle('archived', trip.archived === true);
    actions.append(edit, distribute, duplicate, archive);
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
  state.activeTrip.archived = $('trip-archived').checked;
  state.activeTrip.theme = {
    mode: $('trip-theme-mode').value,
    accent: $('trip-theme-accent').value,
    coverImage: $('trip-cover-image').value.trim()
  };
  state.activeTrip.features = {
    nowMode: $('feature-now').checked,
    offline: $('feature-offline').checked,
    expenses: $('feature-expenses').checked,
    notifications: $('feature-notifications').checked
  };
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
  $('trip-archived').checked = trip.archived === true;
  $('trip-theme-mode').value = trip.theme?.mode || 'auto';
  $('trip-theme-accent').value = trip.theme?.accent || '#f4d35e';
  $('trip-cover-image').value = trip.theme?.coverImage || '';
  $('feature-now').checked = trip.features?.nowMode !== false;
  $('feature-offline').checked = trip.features?.offline !== false;
  $('feature-expenses').checked = trip.features?.expenses !== false;
  $('feature-notifications').checked = trip.features?.notifications === true;
  renderDaySelect();
  renderEditorCards();
  hideEditorErrors();
  renderTripAudit();
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
      const [moved] = cards.splice(from, 1);
      cards.splice(index, 0, moved);
      renderEditorCards();
    });
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

function cardFieldMap() {
  return {
    time: $('card-time').value.trim(),
    badge: $('card-badge').value.trim(),
    title: $('card-title').value.trim(),
    desc: $('card-desc').value.trim(),
    mapQuery: $('card-map-query').value.trim(),
    official: $('card-official').value.trim(),
    officialLabel: $('card-official-label').value.trim(),
    tabelog: $('card-tabelog').value.trim(),
    jalan: $('card-jalan').value.trim(),
    image: $('card-image').value.trim(),
    links: parseCardLinks($('card-links').value),
    expenseShortcut: $('card-expense').checked,
    travelMinutesFromPrevious: Number($('card-travel-minutes').value) || 0,
    notifyBeforeMinutes: $('card-notify').value.split(',').map(value => Number(value.trim())).filter(Number.isFinite),
    constraints: {
      opensAt: $('card-opens-at').value,
      closesAt: $('card-closes-at').value,
      reservationAt: $('card-reservation-at').value,
      lastEntryAt: $('card-last-entry-at').value,
      departureBy: $('card-departure-by').value,
      arrivalBufferMinutes: Number($('card-arrival-buffer').value) || 0
    },
    reservation: {
      number: $('card-reservation-number').value.trim(),
      name: $('card-reservation-name').value.trim(),
      phone: $('card-reservation-phone').value.trim(),
      deadline: $('card-reservation-deadline').value.trim(),
      url: $('card-reservation-url').value.trim(),
      note: $('card-reservation-note').value.trim(),
      qrImage: $('card-reservation-qr').value.trim()
    }
  };
}

function cleanCard(card) {
  const cleaned = {};
  ['time', 'badge', 'title', 'desc', 'mapQuery', 'official', 'officialLabel', 'tabelog', 'jalan', 'image'].forEach(key => {
    const value = text(card?.[key]).trim();
    if (value) cleaned[key] = value;
  });
  const links = (Array.isArray(card?.links) ? card.links : []).map(link => {
    const label = text(link?.label).trim();
    const url = text(link?.url).trim();
    if (!label && !url) return null;
    return link?.kind === 'route' || label === 'ルート' ? { label, url, kind: 'route' } : { label, url };
  }).filter(Boolean);
  if (links.length) cleaned.links = links;
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
  $('card-official').value = text(card.official);
  $('card-official-label').value = text(card.officialLabel);
  $('card-tabelog').value = text(card.tabelog);
  $('card-jalan').value = text(card.jalan);
  $('card-image').value = text(card.image);
  $('card-links').value = formatCardLinks(card.links);
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
  $('card-reservation-qr').value = card.reservation?.qrImage || '';
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
  readTripBasics();
  let errors;
  let report;
  try {
    report = analyzeTrip(state.activeTrip);
    state.activeTrip = report.trip;
    renderTripAudit(report);
    errors = report.errors.map(item => item.message);
  } catch (error) {
    console.error(error);
    showToast(`公開前の確認に失敗しました: ${error.message}`, true);
    return;
  }
  if (errors.length) {
    showEditorErrors(errors);
    return;
  }
  hideEditorErrors();
  if (publish && report.warnings.length && !window.confirm(`公開を止めるエラーはありません。\nただし警告が${report.warnings.length}件あります。内容を確認済みとして公開しますか？`)) return;
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
      const historyRef = doc(collection(db, 'tripHistories', tripId, 'versions'));
      batch.set(historyRef, {
        tripId,
        title: state.activeTrip.title,
        payloadJson,
        schemaVersion: 2,
        publishedAt: serverTimestamp(),
        publishedBy: state.currentUser.uid
      });
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
      '「' + label + '」を完全削除しますか？\n\n参加者 ' + participantsSnapshot.size + '名、共有支出 ' + expensesSnapshot.size + '件、配布ID・同期ルームを削除します。元に戻せません。'
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
          state.activeTrip = normalizeTrip(JSON.parse(version.payloadJson), state.activeTrip.tripId);
          state.activeDayKey = Object.keys(state.activeTrip.days)[0] || 'day1';
          renderEditor();
          $('history-dialog').close();
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
  const source = state.trips.get(tripId)?.trip;
  if (!source) return;
  const duplicate = migrateTripToV2(source);
  const suffix = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  duplicate.tripId = `${tripId.slice(0, 30)}-${suffix}`.slice(0, 40);
  duplicate.title = `${source.title} コピー`.slice(0, 120);
  duplicate.archived = false;
  state.activeTrip = duplicate;
  state.activeDayKey = Object.keys(duplicate.days)[0] || 'day1';
  renderEditor();
  showView('editor');
  showToast('旅行を複製しました。日付と旅行IDを確認して下書き保存してください。');
}

async function toggleTripArchive(tripId) {
  const record = state.trips.get(tripId);
  if (!record) return;
  const trip = migrateTripToV2(record.trip);
  trip.archived = !trip.archived;
  try {
    await setDoc(doc(db, 'adminTrips', tripId), {
      tripId,
      title: trip.title,
      status: state.publishedIds.has(tripId) ? 'published' : 'draft',
      payloadJson: JSON.stringify(trip),
      updatedAt: serverTimestamp(),
      updatedBy: state.currentUser.uid
    }, { merge: true });
    state.trips.set(tripId, { ...record, trip });
    renderTripLibrary();
    showToast(trip.archived ? '思い出へアーカイブしました。' : '旅行一覧へ戻しました。');
  } catch (error) {
    showToast(`変更できません: ${error.message}`, true);
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
  document.querySelectorAll('[data-admin-view]').forEach(button => button.addEventListener('click', () => { showView(button.dataset.adminView); if (button.dataset.adminView === 'roles') loadAdminRoles(); }));
  $('save-role').addEventListener('click', saveAdminRole);
  $('overview-new-trip').addEventListener('click', () => openTripEditor());
  $('editor-day-select').addEventListener('change', event => {
    readTripBasics();
    state.activeDayKey = event.target.value;
    $('editor-day-label').value = state.activeTrip.dayLabels[state.activeDayKey] || '';
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
  $('close-card-dialog').addEventListener('click', () => $('card-dialog').close());
  $('card-form').addEventListener('submit', saveCard);
  $('delete-card').addEventListener('click', deleteCard);
  $('move-card-up').addEventListener('click', () => moveCard(-1));
  $('move-card-down').addEventListener('click', () => moveCard(1));
  $('save-draft').addEventListener('click', () => persistTrip(false));
  $('publish-trip').addEventListener('click', () => persistTrip(true));
  $('preview-trip').addEventListener('click', showTripPreview);
  $('history-trip').addEventListener('click', showPublishHistory);
  $('close-preview').addEventListener('click', () => $('preview-dialog').close());
  $('close-history').addEventListener('click', () => $('history-dialog').close());
  $('download-trip').addEventListener('click', downloadActiveTrip);
  $('import-trip-file').addEventListener('change', event => importTrip(event.target.files?.[0]));
  $('create-distribution').addEventListener('click', createDistribution);
  window.addEventListener('beforeunload', stopLiveListeners);
}

bindEvents();
onAuthStateChanged(auth, handleAuthState);
