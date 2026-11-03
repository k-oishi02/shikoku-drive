/**
 * Admin Overview View Controller (View 01: 旅行一覧)
 *
 * Renders trip library cards, publish & share status badges, Japanese metadata, and quick actions.
 */

import { $, makeElement, text } from './admin-ui.js';

export function renderTripLibrary({
  store,
  onOpenEditor,
  onOpenDistribution,
  duplicateTrip,
  toggleTripArchive,
  downloadDraftRecovery
}) {
  const list = $('admin-trip-list');
  if (!list) return;
  list.replaceChildren();
  const state = store.getState();
  const entries = [...state.trips.entries()].sort((a, b) => text(b[1].trip?.startDate).localeCompare(text(a[1].trip?.startDate)));

  if ($('metric-trips')) $('metric-trips').textContent = String(entries.length);
  if ($('metric-published')) $('metric-published').textContent = String(state.publishedIds.size);
  if ($('overview-updated')) {
    $('overview-updated').textContent = `最終取得 ${new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`;
  }

  if (!entries.length) {
    list.append(makeElement('div', 'empty-state', 'しおりがまだありません。右上の「＋ 新しいしおりを作成」または「📂 JSONファイルを読み込む」から始められます。'));
    return;
  }

  const activeDistByTrip = new Map();
  (state.distributions || []).forEach(dist => {
    if (dist.status === 'active' && dist.tripId) {
      activeDistByTrip.set(dist.tripId, (activeDistByTrip.get(dist.tripId) || 0) + 1);
    }
  });

  entries.forEach(([tripId, record]) => {
    const trip = record.trip || {};
    const isPublished = state.publishedIds.has(tripId);
    const activeDists = activeDistByTrip.get(tripId) || 0;
    const dayKeys = Object.keys(trip.days || {});
    const totalSpots = dayKeys.reduce((sum, k) => sum + (Array.isArray(trip.days[k]) ? trip.days[k].length : 0), 0);
    const candidateCount = record.planning?.candidates?.length || 0;

    const card = makeElement('article', 'trip-card');
    card.classList.toggle('archived', trip.archived === true);

    const header = makeElement('div', 'distribution-head');
    const pillGroup = makeElement('div', 'trip-pill-group');
    pillGroup.append(makeElement('span', `pill ${isPublished ? 'status-published' : 'draft'}`, isPublished ? '🟢 公開中' : '🟠 下書き（未公開）'));
    if (activeDists > 0) {
      pillGroup.append(makeElement('span', 'pill status-shared', `📤 共有中 ${activeDists}件`));
    }
    if (trip.archived) {
      pillGroup.append(makeElement('span', 'pill status-archived', '📦 アーカイブ'));
    }
    header.append(pillGroup, makeElement('code', 'trip-id-badge', tripId));

    const title = makeElement('h3', '', trip.title || tripId);
    const description = makeElement('p', '', trip.catchphrase || trip.subtitle || 'サブタイトル・説明は未設定です');

    const meta = makeElement('div', 'trip-meta');
    const dateRange = trip.startDate && trip.endDate
      ? (trip.startDate === trip.endDate ? `📅 ${trip.startDate}（日帰り）` : `📅 ${trip.startDate} 〜 ${trip.endDate}`)
      : `📅 ${trip.startDate || '日程未設定'}`;
    meta.append(makeElement('span', '', dateRange));
    meta.append(makeElement('span', '', `🗓️ ${dayKeys.length}日間・全${totalSpots}予定`));
    if (candidateCount > 0) {
      meta.append(makeElement('span', '', `📍 候補 ${candidateCount}件`));
    }

    const actions = makeElement('div', 'trip-actions');
    const edit = makeElement('button', 'button compact primary', '✏️ 編集・公開');
    edit.type = 'button';
    edit.addEventListener('click', () => onOpenEditor(tripId));

    const distribute = makeElement('button', 'button compact', '📤 メンバーへ共有');
    distribute.type = 'button';
    distribute.addEventListener('click', () => onOpenDistribution(tripId));

    const moreMenu = makeElement('details', 'card-more-menu');
    const moreSummary = makeElement('summary', 'button compact ghost', 'その他 ▾');
    const popover = makeElement('div', 'card-more-popover');

    const duplicate = makeElement('button', 'menu-action-item', '📋 コピーして新規作成');
    duplicate.type = 'button';
    duplicate.addEventListener('click', () => duplicateTrip(tripId));

    const archive = makeElement('button', 'menu-action-item', trip.archived ? '↩ 通常一覧へ戻す' : '📦 思い出へアーカイブ');
    archive.type = 'button';
    archive.addEventListener('click', () => toggleTripArchive(tripId));

    popover.append(duplicate, archive);
    moreMenu.append(moreSummary, popover);
    actions.append(edit, distribute, moreMenu);

    if (record.loadError) {
      edit.disabled = true;
      duplicate.disabled = true;
      archive.disabled = true;
      card.append(makeElement('p', 'field-help', `下書きの読込を停止しました。元データを保管し、JSONを修正して読み込んでください。公開済み内容は変更していません。\n${record.loadError}`));
      const recover = makeElement('button', 'button compact ghost', '元データを保存');
      recover.type = 'button';
      recover.addEventListener('click', () => downloadDraftRecovery(tripId));
      actions.append(recover);
    }

    card.append(header, title, description, meta, actions);
    list.append(card);
  });
}

export function initOverviewView({
  onNewTrip
}) {
  if ($('overview-new-trip')) {
    $('overview-new-trip').addEventListener('click', () => onNewTrip());
  }
}
