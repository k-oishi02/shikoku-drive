/**
 * Admin Distribution Ledger & Direct Member Share Components
 */
import { collection, doc, getDocs, writeBatch } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { makeElement, showToast, setBusy, formatTimestamp, formatYen, formatAccessId, text } from './admin-ui.js';

export async function deleteDocumentsInChunks(dbOrDocs, maybeDocs) {
  const db = maybeDocs ? dbOrDocs : undefined;
  const documents = maybeDocs || dbOrDocs;
  if (!Array.isArray(documents) || !documents.length) return;
  const firestoreDb = db || documents[0]?.ref?.firestore;
  for (let offset = 0; offset < documents.length; offset += 400) {
    const batch = writeBatch(firestoreDb);
    documents.slice(offset, offset + 400).forEach(item => batch.delete(item.ref));
    await batch.commit();
  }
}

export async function deleteDistributionExpense(dbOrDist, distOrExpense, expenseOrBtn, maybeBtn) {
  const db = maybeBtn !== undefined ? dbOrDist : dbOrDist?.db;
  const distribution = maybeBtn !== undefined ? distOrExpense : dbOrDist;
  const expense = maybeBtn !== undefined ? expenseOrBtn : distOrExpense;
  const button = maybeBtn !== undefined ? maybeBtn : expenseOrBtn;
  const label = expense?.note || expense?.category || 'この支出';
  if (!window.confirm(`「${label}」${formatYen(expense?.amount)} を共有台帳から削除しますか？`)) return;
  setBusy(button, true, '削除中…');
  try {
    const roomId = distribution.roomId || distribution.id;
    const batch = writeBatch(db);
    batch.delete(doc(db, 'rooms', roomId, 'expenses', expense.id));
    await batch.commit();
    showToast('共有支出を削除しました。');
  } catch (error) {
    console.error(error);
    showToast(`共有支出を削除できません: ${error.message}`, true);
    setBusy(button, false);
  }
}

export async function clearDistributionLedger(dbOrDist, distOrBtn, maybeBtn) {
  const db = maybeBtn !== undefined ? dbOrDist : dbOrDist?.db;
  const distribution = maybeBtn !== undefined ? distOrBtn : dbOrDist;
  const button = maybeBtn !== undefined ? maybeBtn : distOrBtn;
  if (distribution.status === 'active') return showToast('全削除の前に共有を一時停止してください。', true);
  const expensesRef = collection(db, 'rooms', distribution.roomId || distribution.id, 'expenses');
  try {
    let snapshot = await getDocs(expensesRef);
    if (!snapshot.size) return showToast('共有台帳はすでに空です。');
    if (!window.confirm(`共有支出 ${snapshot.size}件をすべて削除しますか？元に戻せません。`) || window.prompt('確認のため「全削除」と入力してください。') !== '全削除') return;
    setBusy(button, true, '全削除中…');
    for (let pass = 0; pass < 5 && snapshot.size; pass += 1) {
      await deleteDocumentsInChunks(db, snapshot.docs);
      snapshot = await getDocs(expensesRef);
    }
    if (snapshot.size) throw new Error('削除中に台帳が更新されました。停止状態を確認して再実行してください。');
    showToast('共有台帳を全削除しました。');
  } catch (error) {
    console.error(error);
    showToast(`共有台帳を全削除できません: ${error.message}`, true);
    setBusy(button, false);
  }
}

export function renderDistributionLedger(dbOrDist, maybeDist) {
  const db = maybeDist ? dbOrDist : (dbOrDist?.db || null);
  const distribution = maybeDist || dbOrDist;
  const expenses = Array.isArray(distribution.expenses) ? distribution.expenses : [];
  const total = expenses.reduce((sum, expense) => sum + Math.max(0, Number(expense.amount) || 0), 0);
  const panel = makeElement('details', 'admin-ledger');
  const summary = makeElement('summary');
  const summaryText = makeElement('span');
  summaryText.append(makeElement('strong', '', '💴 みんなの割り勘・共有台帳'), makeElement('small', '', `${expenses.length}件`));
  summary.append(summaryText, makeElement('strong', 'admin-ledger-total', formatYen(total)));
  panel.append(summary);
  if (!distribution.expensesReady) { panel.append(makeElement('p', 'admin-ledger-empty', '台帳を読み込んでいます…')); return panel; }
  if (distribution.expensesError) { panel.append(makeElement('p', 'admin-ledger-error', distribution.expensesError)); return panel; }
  if (!expenses.length) { panel.append(makeElement('p', 'admin-ledger-empty', 'まだ共有支出はありません。')); return panel; }

  const participantNames = new Map((distribution.participants || []).map(person => [person.uid, person.nickname || '名前未設定']));
  const list = makeElement('div', 'admin-ledger-list');
  expenses.forEach(expense => {
    const row = makeElement('article', 'admin-ledger-row');
    const copy = makeElement('div');
    const displayNote = [expense.note, expense.comment].map(v => text(v).trim()).filter(Boolean).join(' — ') || expense.category || '支出';
    const splitLabel = Array.isArray(expense.participantIds) && expense.participantIds.length ? `${expense.participantIds.length}人で分担` : '';
    copy.append(makeElement('strong', '', displayNote), makeElement('small', '', [expense.category || 'その他', `${participantNames.get(expense.payer) || '参加者'}が支払い`, splitLabel, formatTimestamp(expense.createdAt)].filter(Boolean).join(' · ')));
    const remove = makeElement('button', 'button compact danger admin-ledger-delete', '削除');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteDistributionExpense(db, distribution, expense, remove));
    const controls = makeElement('div', 'admin-ledger-controls');
    controls.append(makeElement('strong', 'admin-ledger-amount', formatYen(expense.amount)), remove);
    row.append(copy, controls);
    list.append(row);
  });
  const actions = makeElement('div', 'admin-ledger-actions');
  const clear = makeElement('button', 'button compact danger', '台帳を全削除');
  clear.type = 'button';
  clear.addEventListener('click', () => clearDistributionLedger(db, distribution, clear));
  actions.append(clear);
  panel.append(list, actions);
  return panel;
}

function buildMemberChip(member, checked, onToggle) {
  const chip = makeElement('label', `known-member-chip${checked ? ' is-selected' : ''}`);
  const input = document.createElement('input');
  input.type = 'checkbox'; input.checked = checked;
  input.addEventListener('change', () => onToggle(member.uid, input.checked));
  const copy = makeElement('span', 'known-member-copy');
  copy.append(makeElement('strong', '', member.nickname), makeElement('small', '', `…${member.uid.slice(-6)}${member.lastLabel ? ' · ' + member.lastLabel : ''}`));
  chip.append(input, copy);
  return chip;
}

export function renderKnownMemberPicker({ container, knownMembers, selectedUids, onChange }) {
  if (!container) return;
  container.replaceChildren();
  if (!Array.isArray(knownMembers) || !knownMembers.length) { container.hidden = true; return; }
  container.hidden = false;
  const head = makeElement('div', 'known-members-head');
  const titleWrap = makeElement('div', 'known-members-title');
  titleWrap.append(makeElement('strong', '', '✨ 過去の参加メンバーへ同時に自動共有'), makeElement('small', '', 'チェックして作成すると、相手は12桁入力不要でSHIORIを開くだけで自動追加されます'));
  const quick = makeElement('div', 'known-members-quick');
  const selRecent = makeElement('button', 'button compact ghost', '前回のメンバーを選択');
  selRecent.type = 'button';
  selRecent.addEventListener('click', () => {
    selectedUids.clear();
    const recents = knownMembers.filter(m => m.isRecent);
    (recents.length ? recents : knownMembers).forEach(m => selectedUids.add(m.uid));
    onChange();
  });
  const clearBtn = makeElement('button', 'button compact ghost', '選択解除');
  clearBtn.type = 'button';
  clearBtn.addEventListener('click', () => { selectedUids.clear(); onChange(); });
  quick.append(selRecent, clearBtn);
  head.append(titleWrap, quick);
  const grid = makeElement('div', 'known-members-grid');
  knownMembers.forEach(m => grid.append(buildMemberChip(m, selectedUids.has(m.uid), (uid, on) => { if (on) selectedUids.add(uid); else selectedUids.delete(uid); onChange(); })));
  container.append(head, grid);
}

export function renderCardDirectShareBox({ distribution, knownMembers, memberSet, selectedUids, onChange, onPush }) {
  if (distribution.status !== 'active' || !distribution.accessId) return null;
  const candidates = (Array.isArray(knownMembers) ? knownMembers : []).filter(m => !memberSet.has(m.uid));
  if (!candidates.length) return null;
  const box = makeElement('div', 'direct-share-box');
  const head = makeElement('div', 'known-members-head');
  const titleWrap = makeElement('div', 'known-members-title');
  titleWrap.append(makeElement('strong', '', '✨ 既知メンバーへ直接共有（12桁コード不要）'), makeElement('small', '', 'チェックして押すだけで相手の「しおり棚」へ自動追加されます'));
  const selAll = makeElement('button', 'button compact ghost', '全員選択');
  selAll.type = 'button';
  selAll.addEventListener('click', () => { candidates.forEach(m => selectedUids.add(m.uid)); onChange(); });
  head.append(titleWrap, selAll);
  const grid = makeElement('div', 'known-members-grid');
  let activeSelected = 0;
  candidates.forEach(m => {
    const isChecked = selectedUids.has(m.uid);
    if (isChecked) activeSelected += 1;
    grid.append(buildMemberChip(m, isChecked, (uid, on) => { if (on) selectedUids.add(uid); else selectedUids.delete(uid); onChange(); }));
  });
  const actions = makeElement('div', 'direct-share-actions');
  const pushBtn = makeElement('button', 'button compact primary', activeSelected ? `選択した${activeSelected}名へ直接共有する` : 'メンバーを選んで直接共有');
  pushBtn.type = 'button'; pushBtn.disabled = activeSelected === 0;
  pushBtn.addEventListener('click', () => onPush(pushBtn, candidates.filter(m => selectedUids.has(m.uid))));
  actions.append(pushBtn);
  box.append(head, grid, actions);
  return box;
}

export function renderCardInviteAndAdvanced({ dist, isActive, isDeleting, capacity, memberCount, onCopyLink, onCopyId, onCopyAppUrl, onUpdateCap, onToggle, onDelete }) {
  const mkBtn = (cls, txt, fn, dis) => { const b = makeElement('button', `button ${cls}`, txt); b.type = 'button'; b.disabled = Boolean(dis); b.addEventListener('click', fn); return b; };
  const inviteBox = makeElement('div', 'invite-share-box');
  inviteBox.append(makeElement('strong', 'invite-share-title', '🔗 初参加の人を招待する場合（リンクを送るだけ）'));
  const inviteRow = makeElement('div', 'invite-share-row');
  inviteRow.append(
    mkBtn('compact primary', '🔗 LINE・招待リンクをコピー', onCopyLink, !isActive || !dist.accessId),
    mkBtn('compact ghost', '🔑 12桁コードをコピー', onCopyId, !isActive || !dist.accessId),
    makeElement('code', 'distribution-id', dist.accessId ? `コード: ${formatAccessId(dist.accessId)}` : 'コードなし（再作成してください）')
  );
  inviteBox.append(inviteRow);
  const adv = makeElement('details', 'dist-advanced');
  adv.append(makeElement('summary', '', '⚙️ 端末上限の変更・一時停止・削除などの詳細設定'));
  const advBody = makeElement('div', 'dist-advanced-body');
  const capCtrl = makeElement('div', 'capacity-control');
  const capLabel = makeElement('label', '', '端末上限（台）');
  const capInput = document.createElement('input');
  capInput.type = 'number'; capInput.min = String(Math.max(1, memberCount)); capInput.max = '50'; capInput.step = '1'; capInput.value = String(capacity); capInput.disabled = isDeleting;
  const updCap = mkBtn('compact', '上限を変更', () => onUpdateCap(Number(capInput.value), updCap), isDeleting);
  capLabel.append(capInput); capCtrl.append(capLabel, updCap);
  const advActions = makeElement('div', 'trip-actions');
  advActions.append(mkBtn('compact ghost', '空のアプリURLをコピー', onCopyAppUrl, false), mkBtn(`compact ${isActive ? 'danger' : ''}`, isActive ? '⏸ 共有を一時停止' : '▶ 共有を再開', onToggle, isDeleting));
  if (!isActive) advActions.append(mkBtn('compact danger', isDeleting ? '削除を再試行' : '🗑 完全削除', () => onDelete(advActions.lastChild), false));
  advBody.append(capCtrl, advActions, makeElement('p', 'participant-merge-note', '※ 同じ表示名の端末は同一人物として割り勘集計されます。'));
  adv.append(advBody);
  return { inviteBox, adv };
}

export function renderParticipantDeviceList({ listedIds, partByUid, sharedMap, memberSet, onRemove }) {
  const wrap = makeElement('div', 'participant-list participant-device-list');
  if (!listedIds.length) { wrap.append(makeElement('span', 'muted small', 'まだ参加している端末はありません')); return wrap; }
  listedIds.forEach(uid => {
    const p = partByUid.get(uid);
    const sharedNick = text(sharedMap[uid]?.nickname).trim();
    const item = makeElement('span', 'participant participant-device');
    const copy = makeElement('span', 'participant-device-copy');
    const tail = p?.joinedAt ? ' · 参加済 ' + formatTimestamp(p.joinedAt) : (sharedNick ? ' · 直接共有済（未起動）' : '');
    copy.append(makeElement('strong', '', p?.nickname || sharedNick || '名称未設定の端末'), makeElement('small', '', `端末 …${uid.slice(-6)}${tail}${memberSet.has(uid) ? '' : ' · 枠外'}`));
    const remBtn = makeElement('button', 'button compact danger', '解除');
    remBtn.type = 'button'; remBtn.addEventListener('click', () => onRemove(uid, remBtn));
    item.append(copy, remBtn); wrap.append(item);
  });
  return wrap;
}
