const PUBLIC_RECAPS = Object.freeze([
  Object.freeze({
    id: 'shikoku-2026',
    title: '香川・愛媛 2泊3日',
    subtitle: '旅の記録 · RECAP',
    startDate: '2026-08-30',
    endDate: '2026-09-01',
    href: './recap.html?id=shikoku-2026',
    dataUrl: './recaps/shikoku-2026.json'
  })
]);

export function listPublicRecaps() {
  return PUBLIC_RECAPS.map(item => ({ ...item }));
}

export function findRecapForTrip(trip) {
  return PUBLIC_RECAPS.find(item => item.startDate === trip?.startDate && item.endDate === trip?.endDate) || null;
}

function registryEntry(id) {
  return PUBLIC_RECAPS.find(item => item.id === id) || null;
}

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.dataset.tripTheme = mode;
  else delete root.dataset.tripTheme;
  const dark = mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#171c1b' : '#356b68');
}

function updateThemeLabel(mode) {
  const button = document.getElementById('recap-theme');
  if (button) button.textContent = mode === 'auto' ? 'AUTO' : mode.toUpperCase();
}

function cycleTheme() {
  const current = localStorage.getItem('shiori-recap-theme') || 'auto';
  const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
  localStorage.setItem('shiori-recap-theme', next);
  applyTheme(next);
  updateThemeLabel(next);
}

function formatDate(dateText) {
  const date = new Date(`${dateText}T12:00:00+09:00`);
  return new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Tokyo' }).format(date);
}

function appendText(parent, tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  parent.append(node);
  return node;
}

function validRecap(data, expectedId) {
  if (!data || data.schema !== 'shiori-recap-v1' || data.id !== expectedId || data.visibility !== 'public') return false;
  if (!Array.isArray(data.days) || data.days.length < 1 || data.days.length > 31) return false;
  return data.days.every(day => Array.isArray(day.events) && day.events.length <= 100);
}

function renderHighlights(data) {
  const list = document.getElementById('recap-highlights');
  list.replaceChildren();
  (data.highlights || []).forEach((highlight, index) => {
    const item = document.createElement('li');
    appendText(item, 'span', 'recap-highlight-number', String(index + 1).padStart(2, '0'));
    appendText(item, 'span', '', String(highlight));
    list.append(item);
  });
}

function renderDay(day, index) {
  const section = document.createElement('section');
  section.className = 'recap-day';
  section.id = `day-${index + 1}`;
  const head = document.createElement('header');
  head.className = 'recap-day-head';
  appendText(head, 'span', 'recap-day-number', `DAY ${String(index + 1).padStart(2, '0')}`);
  const heading = appendText(head, 'h2', '', day.label || `旅の${index + 1}日目`);
  heading.id = `day-title-${index + 1}`;
  appendText(head, 'p', '', formatDate(day.date));
  section.setAttribute('aria-labelledby', heading.id);
  section.append(head);

  const timeline = document.createElement('ol');
  timeline.className = 'recap-timeline';
  day.events.forEach(event => {
    const item = document.createElement('li');
    appendText(item, 'time', 'recap-event-time', String(event.time || ''));
    const copy = document.createElement('div');
    appendText(copy, 'h3', '', String(event.title || ''));
    appendText(copy, 'p', '', String(event.detail || ''));
    item.append(copy);
    timeline.append(item);
  });
  section.append(timeline);

  if (Array.isArray(day.changedPlans) && day.changedPlans.length) {
    const changed = document.createElement('aside');
    changed.className = 'recap-changed';
    appendText(changed, 'span', 'recap-changed-label', 'CHANGED PLAN');
    const list = document.createElement('ul');
    day.changedPlans.forEach(value => appendText(list, 'li', '', String(value)));
    changed.append(list);
    section.append(changed);
  }
  return section;
}

function renderRecap(data) {
  document.title = `${data.title} RECAP | SHIORI`;
  document.getElementById('recap-loading').hidden = true;
  document.getElementById('recap-main').hidden = false;
  document.getElementById('recap-title').textContent = data.title;
  document.getElementById('recap-subtitle').textContent = data.subtitle || '旅の記録';
  document.getElementById('recap-summary').textContent = data.summary || '';
  document.getElementById('recap-date').textContent = `${data.startDate.replaceAll('-', '.')} — ${data.endDate.replaceAll('-', '.')}`;
  const eventCount = data.days.reduce((total, day) => total + day.events.length, 0);
  const changedCount = data.days.reduce((total, day) => total + (day.changedPlans?.length || 0), 0);
  document.getElementById('recap-days').textContent = String(data.days.length);
  document.getElementById('recap-events').textContent = String(eventCount);
  document.getElementById('recap-changes').textContent = String(changedCount);
  document.getElementById('recap-source-note').textContent = data.sourceNote || '';
  renderHighlights(data);

  const nav = document.getElementById('recap-nav');
  const chapters = document.getElementById('recap-chapters');
  nav.replaceChildren();
  chapters.replaceChildren();
  data.days.forEach((day, index) => {
    const link = document.createElement('a');
    link.href = `#day-${index + 1}`;
    link.textContent = `DAY ${index + 1}`;
    link.setAttribute('aria-label', `${index + 1}日目 ${day.label}`);
    nav.append(link);
    chapters.append(renderDay(day, index));
  });
}

function showError(message) {
  const loading = document.getElementById('recap-loading');
  loading.textContent = message;
  loading.dataset.state = 'error';
}

async function shareRecap() {
  const shareData = { title: document.title, text: 'SHIORIで旅のRECAPを見る', url: location.href };
  if (navigator.share) return navigator.share(shareData).catch(() => {});
  await navigator.clipboard?.writeText(location.href);
  const button = document.getElementById('recap-share');
  if (button) {
    button.textContent = 'COPIED';
    setTimeout(() => { button.textContent = 'SHARE'; }, 1600);
  }
}

async function initRecapPage() {
  window.shioriPublicRecaps = listPublicRecaps();
  window.shioriFindRecapForTrip = findRecapForTrip;
  const root = document.getElementById('recap-app');
  if (!root) return;
  const theme = localStorage.getItem('shiori-recap-theme') || 'auto';
  applyTheme(theme);
  updateThemeLabel(theme);
  document.getElementById('recap-theme')?.addEventListener('click', cycleTheme);
  document.getElementById('recap-print')?.addEventListener('click', () => window.print());
  document.getElementById('recap-share')?.addEventListener('click', shareRecap);
  const id = new URLSearchParams(location.search).get('id') || PUBLIC_RECAPS[0].id;
  const entry = registryEntry(id);
  if (!entry) return showError('指定されたRECAPは公開されていません。');
  try {
    const response = await fetch(entry.dataUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!validRecap(data, entry.id)) throw new Error('invalid recap');
    renderRecap(data);
  } catch (error) {
    console.error('Failed to load recap:', error);
    showError('RECAPを読み込めませんでした。通信状態を確認して再度お試しください。');
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

window.shioriPublicRecaps = listPublicRecaps();
window.shioriFindRecapForTrip = findRecapForTrip;
initRecapPage();
