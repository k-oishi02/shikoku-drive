/**
 * Admin Distribution Ledger Module
 *
 * Provides shared distribution ledger UI rendering, individual expense deletion,
 * batched document deletion, and ledger clearance.
 */
import {
  collection, doc, getDocs, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import {
  makeElement, showToast, setBusy, formatTimestamp, formatYen, text
} from './admin-ui.js';

/**
 * Deletes Firestore documents in chunks of 400 to respect batch limit.
 * @param {object|Array} dbOrDocs Firestore database instance or documents array.
 * @param {Array} [maybeDocs] Documents array when db is provided as first argument.
 */
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

/**
 * Deletes a single expense from a distribution's shared ledger.
 * Supports (db, distribution, expense, button) or (distribution, expense, button).
 */
export async function deleteDistributionExpense(dbOrDist, distOrExpense, expenseOrBtn, maybeBtn) {
  let db, distribution, expense, button;
  if (maybeBtn !== undefined) {
    db = dbOrDist;
    distribution = distOrExpense;
    expense = expenseOrBtn;
    button = maybeBtn;
  } else {
    distribution = dbOrDist;
    expense = distOrExpense;
    button = expenseOrBtn;
    db = distribution?.db;
  }
  const label = expense?.note || expense?.category || 'この支出';
  if (!window.confirm(`「${label}」${formatYen(expense?.amount)} を共有台帳から削除しますか？`)) return;
  setBusy(button, true, '削除中…');
  try {
    const roomId = distribution.roomId || distribution.id;
    const expenseRef = doc(db, 'rooms', roomId, 'expenses', expense.id);
    const batch = writeBatch(db);
    batch.delete(expenseRef);
    await batch.commit();
    showToast('共有支出を削除しました。');
  } catch (error) {
    console.error(error);
    showToast(`共有支出を削除できません: ${error.message}`, true);
    setBusy(button, false);
  }
}

/**
 * Clears all expenses from a distribution's shared ledger.
 * Supports (db, distribution, button) or (distribution, button).
 */
export async function clearDistributionLedger(dbOrDist, distOrBtn, maybeBtn) {
  let db, distribution, button;
  if (maybeBtn !== undefined) {
    db = dbOrDist;
    distribution = distOrBtn;
    button = maybeBtn;
  } else {
    distribution = dbOrDist;
    button = distOrBtn;
    db = distribution?.db;
  }
  if (distribution.status === 'active') {
    return showToast('全削除の前に配布を停止してください。停止中は参加者の新規追加を防げます。', true);
  }
  const roomId = distribution.roomId || distribution.id;
  const expensesRef = collection(db, 'rooms', roomId, 'expenses');
  try {
    let snapshot = await getDocs(expensesRef);
    if (!snapshot.size) return showToast('共有台帳はすでに空です。');
    if (!window.confirm(`共有支出 ${snapshot.size}件をすべて削除しますか？元に戻せません。`) || window.prompt('確認のため「全削除」と入力してください。') !== '全削除') return;
    setBusy(button, true, '全削除中…');
    for (let pass = 0; pass < 5 && snapshot.size; pass += 1) {
      await deleteDocumentsInChunks(db, snapshot.docs);
      snapshot = await getDocs(expensesRef);
    }
    if (snapshot.size) throw new Error('削除中に台帳が更新されました。配布停止を確認して再実行してください。');
    showToast('共有台帳を全削除しました。');
  } catch (error) {
    console.error(error);
    showToast(`共有台帳を全削除できません: ${error.message}`, true);
    setBusy(button, false);
  }
}

/**
 * Renders the interactive distribution ledger component.
 * @param {object} dbOrDist Firestore database instance or distribution record.
 * @param {object} [maybeDist] Distribution record when db is passed as first argument.
 * @returns {HTMLElement} Details element representing the ledger.
 */
export function renderDistributionLedger(dbOrDist, maybeDist) {
  const db = maybeDist ? dbOrDist : (dbOrDist?.db || null);
  const distribution = maybeDist || dbOrDist;
  const expenses = Array.isArray(distribution.expenses) ? distribution.expenses : [];
  const total = expenses.reduce((sum, expense) => sum + Math.max(0, Number(expense.amount) || 0), 0);
  const panel = makeElement('details', 'admin-ledger');
  const summary = makeElement('summary');
  const summaryText = makeElement('span');
  summaryText.append(makeElement('strong', '', '共有台帳'), makeElement('small', '', `${expenses.length}件`));
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
    const splitLabel = Array.isArray(expense.participantIds) && expense.participantIds.length ? `${expense.participantIds.length}人で分担` : '';
    copy.append(makeElement('small', '', [expense.category || 'その他', `${participantNames.get(expense.payer) || '参加者'}が支払い`, splitLabel, formatTimestamp(expense.createdAt)].filter(Boolean).join(' · ')));
    const amount = makeElement('strong', 'admin-ledger-amount', formatYen(expense.amount));
    const remove = makeElement('button', 'compact danger admin-ledger-delete', '削除');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteDistributionExpense(db, distribution, expense, remove));
    const controls = makeElement('div', 'admin-ledger-controls');
    controls.append(amount, remove);
    row.append(copy, controls);
    list.append(row);
  });
  panel.append(list);
  const actions = makeElement('div', 'admin-ledger-actions');
  const clear = makeElement('button', 'compact danger', '台帳を全削除');
  clear.type = 'button';
  clear.addEventListener('click', () => clearDistributionLedger(db, distribution, clear));
  actions.append(clear);
  panel.append(actions);
  return panel;
}
