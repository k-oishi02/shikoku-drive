/**
 * src/offline-expense-queue.js
 * Offline Expense Queue & Reconnection Synchronization Module (Feature F16)
 */

export const OFFLINE_QUEUE_KEY = 'shiori_offline_expenses_queue_v1';
let memoryQueue = null;

function getStorage() {
  if (typeof localStorage !== 'undefined') return localStorage;
  if (!memoryQueue) memoryQueue = new Map();
  return {
    getItem: k => memoryQueue.get(k) ?? null, setItem: (k, v) => memoryQueue.set(k, String(v)),
    removeItem: k => memoryQueue.delete(k), clear: () => memoryQueue.clear()
  };
}

export function readRawQueue() {
  let storageItems = [], memItems = [];
  try {
    const raw = getStorage().getItem(OFFLINE_QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) storageItems = parsed.filter(item => item && typeof item === 'object');
  } catch { storageItems = []; }
  if (memoryQueue) {
    try {
      const rawMem = memoryQueue.get(OFFLINE_QUEUE_KEY);
      const parsedMem = rawMem ? JSON.parse(rawMem) : [];
      if (Array.isArray(parsedMem)) memItems = parsedMem.filter(item => item && typeof item === 'object');
    } catch { memItems = []; }
  }
  if (!memItems.length) return storageItems;
  if (!storageItems.length) return memItems;
  const map = new Map();
  storageItems.forEach(item => { const k = item.id || item.queueId; if (k) map.set(k, item); });
  memItems.forEach(item => { const k = item.id || item.queueId; if (k) map.set(k, item); });
  return [...map.values()];
}

export function writeRawQueue(queue) {
  const safe = Array.isArray(queue) ? queue.filter(item => item && typeof item === 'object') : [];
  const serialized = JSON.stringify(safe);
  if (!memoryQueue) memoryQueue = new Map();
  memoryQueue.set(OFFLINE_QUEUE_KEY, serialized);
  try {
    getStorage().setItem(OFFLINE_QUEUE_KEY, serialized);
  } catch { /* Quota exceeded: data retained in memoryQueue */ }
  return true;
}

export function getOfflineExpensesQueue(tripId) {
  const all = readRawQueue();
  return tripId ? all.filter(item => !item.tripId || item.tripId === tripId) : all;
}

export function getPendingExpenses(tripId) {
  return getOfflineExpensesQueue(tripId).filter(item => item.syncStatus === 'pending' || item.synced === false);
}

export function isExpensePendingSync(expenseId, tripId) {
  if (!expenseId) return false;
  return getPendingExpenses(tripId).some(item => item.id === expenseId || item.queueId === expenseId);
}

export function getPendingQueueCount(tripId) { return getPendingExpenses(tripId).length; }

export function enqueueOfflineExpense(expense) {
  const queue = readRawQueue();
  const now = new Date().toISOString();
  const queueId = expense.queueId || `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const id = expense.id || `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const existingIdx = queue.findIndex(item => item.id === id || item.queueId === queueId);

  const record = {
    queueId, id,
    tripId: String(expense.tripId || ''),
    ledgerToken: String(expense.ledgerToken || ''),
    amount: Number.isFinite(Number(expense?.amount)) ? Math.max(0, Math.round(Number(expense.amount))) : 0,
    payer: String(expense.payer || ''),
    category: String(expense.category || 'その他'),
    note: String(expense.note || '').trim().slice(0, 120),
    createdAt: expense.createdAt || now,
    creatorUid: String(expense.creatorUid || ''),
    splitMode: expense.splitMode === 'selected' ? 'selected' : 'equal',
    participantIds: Array.isArray(expense.participantIds) ? expense.participantIds : [],
    syncStatus: 'pending',
    synced: false,
    queuedAt: expense.queuedAt || now,
    syncedAt: null,
    retryCount: Number(expense.retryCount || 0),
    lastError: null
  };

  if (existingIdx >= 0) queue[existingIdx] = { ...queue[existingIdx], ...record };
  else queue.push(record);

  writeRawQueue(queue);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('shiori-offline-queue-changed', {
      detail: { action: 'enqueue', item: record, pendingCount: getPendingQueueCount(expense.tripId) }
    }));
  }
  return record;
}

export function updateQueuedExpenseStatus(idOrQueueId, status, meta = {}) {
  const queue = readRawQueue();
  const target = queue.find(item => item.id === idOrQueueId || item.queueId === idOrQueueId);
  if (!target) return false;

  target.syncStatus = status;
  if (status === 'synced') { target.synced = true; target.syncedAt = meta.syncedAt || new Date().toISOString(); }
  if (meta.error) { target.lastError = String(meta.error); target.retryCount = (target.retryCount || 0) + 1; }
  writeRawQueue(queue);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('shiori-offline-queue-changed', {
      detail: { action: 'status', item: target, status }
    }));
  }
  return true;
}

export function clearSyncedExpenses(tripId) {
  const queue = readRawQueue();
  const kept = queue.filter(item => {
    if (tripId && item.tripId && item.tripId !== tripId) return true;
    return item.syncStatus !== 'synced' && item.synced !== true;
  });
  const removedCount = queue.length - kept.length;
  if (removedCount > 0) writeRawQueue(kept);
  return removedCount;
}

export function clearAllQueuedExpenses(tripId) {
  if (!tripId) { writeRawQueue([]); if (memoryQueue) memoryQueue.delete(OFFLINE_QUEUE_KEY); return; }
  const queue = readRawQueue();
  writeRawQueue(queue.filter(item => item.tripId && item.tripId !== tripId));
}

export function mergeWithOfflineQueue(remoteExpenses = [], tripId) {
  const pending = getPendingExpenses(tripId);
  const remoteMap = new Map();
  (Array.isArray(remoteExpenses) ? remoteExpenses : []).forEach(item => {
    if (item?.id) remoteMap.set(item.id, { ...item, syncStatus: 'synced', pendingSync: false });
  });
  const merged = [...remoteMap.values()];
  pending.forEach(item => {
    if (!remoteMap.has(item.id)) merged.push({ ...item, syncStatus: 'pending', pendingSync: true });
  });
  return merged.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export function isNetworkOffline() { return typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' && !navigator.onLine; }

let isSyncDraining = false;

export async function drainOfflineExpenseQueue({ tripId, syncHandler, onProgress, onError } = {}) {
  if (isSyncDraining) return { total: 0, syncedCount: 0, failedCount: 0, skipped: true };
  if (isNetworkOffline()) return { total: 0, syncedCount: 0, failedCount: 0, offline: true };
  if (typeof syncHandler !== 'function') throw new TypeError('syncHandler function required');

  isSyncDraining = true;
  let syncedCount = 0, failedCount = 0;

  try {
    const pending = getPendingExpenses(tripId);
    const total = pending.length;
    if (total === 0) return { total: 0, syncedCount: 0, failedCount: 0 };

    for (const item of pending) {
      if (isNetworkOffline()) break;
      try {
        updateQueuedExpenseStatus(item.id, 'syncing');
        const ok = await syncHandler(item);
        if (ok) {
          updateQueuedExpenseStatus(item.id, 'synced', { syncedAt: new Date().toISOString() });
          syncedCount++;
          if (onProgress) onProgress({ total, synced: syncedCount, remaining: total - syncedCount - failedCount, currentItem: item });
        } else {
          updateQueuedExpenseStatus(item.id, 'failed', { error: 'Sync unsuccessful' });
          failedCount++;
          if (onError) onError(item, new Error('Sync unsuccessful'));
        }
      } catch (err) {
        updateQueuedExpenseStatus(item.id, 'failed', { error: err.message });
        failedCount++;
        if (onError) onError(item, err);
      }
    }
    clearSyncedExpenses(tripId);
    return { total, syncedCount, failedCount };
  } finally {
    isSyncDraining = false;
  }
}
