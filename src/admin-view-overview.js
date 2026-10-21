/**
 * Admin Overview View Controller (View 01: OVERVIEW)
 *
 * Renders trip library cards, publish status badges, metadata, and metric counters.
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
  const entries = [...state.trips.entries()].sort((a, b) => text(a[1].trip?.startDate).localeCompare(text(b[1].trip?.startDate)));

  if ($('metric-trips')) $('metric-trips').textContent = String(entries.length);
  if ($('metric-published')) $('metric-published').textContent = String(state.publishedIds.size);
  if ($('overview-updated')) {
    $('overview-updated').textContent = `更新 ${new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`;
  }

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
    meta.append(makeElement('span', '', `${Object.keys(trip.days || {}).length} DAYS`));
    if (candidateCount > 0) {
      meta.append(makeElement('span', '', `候補 ${candidateCount}件`));
    }
    const actions = makeElement('div', 'trip-actions');
    const edit = makeElement('button', 'compact', 'EDIT');
    edit.type = 'button';
    edit.addEventListener('click', () => onOpenEditor(tripId));

    const distribute = makeElement('button', 'compact ghost', 'DISTRIBUTE');
    distribute.type = 'button';
    distribute.addEventListener('click', () => onOpenDistribution(tripId));

    const duplicate = makeElement('button', 'compact ghost', 'DUPLICATE');
    duplicate.type = 'button';
    duplicate.addEventListener('click', () => duplicateTrip(tripId));

    const archive = makeElement('button', 'compact ghost', trip.archived ? 'RESTORE' : 'ARCHIVE');
    archive.type = 'button';
    archive.addEventListener('click', () => toggleTripArchive(tripId));

    card.classList.toggle('archived', trip.archived === true);
    actions.append(edit, distribute, duplicate, archive);

    if (record.loadError) {
      edit.disabled = true;
      duplicate.disabled = true;
      archive.disabled = true;
      card.append(makeElement('p', 'field-help', `下書きの読込を停止しました。元データを保管し、JSONを修正して読み込んでください。公開済み内容は変更していません。\n${record.loadError}`));
      const recover = makeElement('button', 'compact ghost', 'KEEP SOURCE');
      recover.type = 'button';
      recover.addEventListener('click', () => downloadDraftRecovery(tripId));
      actions.append(recover);
    }

    card.append(header, title, description, meta, actions);
    list.append(card);
  });
}

export function initOverviewView({
  store,
  onNewTrip,
  onOpenEditor,
  onOpenDistribution,
  duplicateTrip,
  toggleTripArchive,
  downloadDraftRecovery
}) {
  if ($('overview-new-trip')) {
    $('overview-new-trip').addEventListener('click', () => onNewTrip());
  }
}
