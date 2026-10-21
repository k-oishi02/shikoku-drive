import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFLINE_QUEUE_KEY,
  readRawQueue,
  writeRawQueue,
  getOfflineExpensesQueue,
  getPendingExpenses,
  isExpensePendingSync,
  getPendingQueueCount,
  enqueueOfflineExpense,
  updateQueuedExpenseStatus,
  clearSyncedExpenses,
  clearAllQueuedExpenses,
  mergeWithOfflineQueue,
  drainOfflineExpenseQueue,
  isNetworkOffline
} from '../src/offline-expense-queue.js';

describe('Offline Expense Queue Suite (Feature F16)', () => {
  beforeEach(() => {
    clearAllQueuedExpenses();
  });

  describe('Queue Lifecycle & Schema', () => {
    it('enqueues a new offline expense with valid schema and pending status', () => {
      const expense = {
        amount: 2500,
        payer: 'user-alice',
        category: '食事',
        note: 'さぬきうどん昼食',
        tripId: 'shikoku-2026',
        ledgerToken: 'tok-1234567890123456789012345678901234567890123'
      };

      const record = enqueueOfflineExpense(expense);
      assert.ok(record.queueId.startsWith('offline-'));
      assert.ok(record.id.startsWith('exp-'));
      assert.equal(record.amount, 2500);
      assert.equal(record.payer, 'user-alice');
      assert.equal(record.category, '食事');
      assert.equal(record.note, 'さぬきうどん昼食');
      assert.equal(record.tripId, 'shikoku-2026');
      assert.equal(record.syncStatus, 'pending');
      assert.equal(record.synced, false);
      assert.equal(record.syncedAt, null);
      assert.equal(record.retryCount, 0);

      assert.equal(getPendingQueueCount('shikoku-2026'), 1);
      assert.equal(isExpensePendingSync(record.id, 'shikoku-2026'), true);
    });

    it('updates queued expense status through syncing, synced, and failed', () => {
      const record = enqueueOfflineExpense({
        id: 'exp-test-status',
        amount: 1000,
        tripId: 'trip-1'
      });

      updateQueuedExpenseStatus('exp-test-status', 'syncing');
      let pending = getPendingExpenses('trip-1');
      assert.equal(pending[0].syncStatus, 'syncing');

      updateQueuedExpenseStatus('exp-test-status', 'failed', { error: '503 Service Unavailable' });
      pending = getPendingExpenses('trip-1');
      assert.equal(pending[0].syncStatus, 'failed');
      assert.equal(pending[0].retryCount, 1);
      assert.equal(pending[0].lastError, '503 Service Unavailable');

      const syncedTime = new Date().toISOString();
      updateQueuedExpenseStatus('exp-test-status', 'synced', { syncedAt: syncedTime });
      assert.equal(getPendingExpenses('trip-1').length, 0);

      const raw = getOfflineExpensesQueue('trip-1');
      assert.equal(raw[0].syncStatus, 'synced');
      assert.equal(raw[0].synced, true);
      assert.equal(raw[0].syncedAt, syncedTime);
    });

    it('clearSyncedExpenses only removes synced items, leaving pending untouched', () => {
      enqueueOfflineExpense({ id: 'item-1', tripId: 'trip-1', amount: 500 });
      enqueueOfflineExpense({ id: 'item-2', tripId: 'trip-1', amount: 800 });

      updateQueuedExpenseStatus('item-1', 'synced');
      assert.equal(getOfflineExpensesQueue('trip-1').length, 2);

      const removed = clearSyncedExpenses('trip-1');
      assert.equal(removed, 1);

      const remaining = getOfflineExpensesQueue('trip-1');
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].id, 'item-2');
      assert.equal(remaining[0].syncStatus, 'pending');
    });
  });

  describe('Multi-Trip Isolation & Idempotency', () => {
    it('isolates queues cleanly between different tripIds', () => {
      enqueueOfflineExpense({ id: 'shikoku-1', tripId: 'shikoku-2026', amount: 1200 });
      enqueueOfflineExpense({ id: 'hokkaido-1', tripId: 'hokkaido-2026', amount: 3400 });

      assert.equal(getPendingQueueCount('shikoku-2026'), 1);
      assert.equal(getPendingQueueCount('hokkaido-2026'), 1);
      assert.equal(getPendingQueueCount(), 2);

      assert.equal(isExpensePendingSync('shikoku-1', 'shikoku-2026'), true);
      assert.equal(isExpensePendingSync('shikoku-1', 'hokkaido-2026'), false);
    });

    it('enqueuing identical ID updates record in-place without duplicating', () => {
      enqueueOfflineExpense({ id: 'unique-item', amount: 1000, note: 'Initial' });
      assert.equal(getPendingQueueCount(), 1);

      enqueueOfflineExpense({ id: 'unique-item', amount: 1500, note: 'Updated' });
      assert.equal(getPendingQueueCount(), 1);

      const raw = readRawQueue();
      assert.equal(raw.length, 1);
      assert.equal(raw[0].amount, 1500);
      assert.equal(raw[0].note, 'Updated');
    });

    it('mergeWithOfflineQueue merges remote and pending local items without duplicates', () => {
      enqueueOfflineExpense({ id: 'pending-1', amount: 2000, createdAt: '2026-11-07T12:00:00Z', tripId: 'trip-a' });

      const remote = [
        { id: 'remote-1', amount: 1000, createdAt: '2026-11-07T10:00:00Z', tripId: 'trip-a' },
        { id: 'pending-1', amount: 2000, createdAt: '2026-11-07T12:00:00Z', tripId: 'trip-a' }
      ];

      const merged = mergeWithOfflineQueue(remote, 'trip-a');
      assert.equal(merged.length, 2);
      const pendingItem = merged.find(i => i.id === 'pending-1');
      assert.ok(pendingItem);
      assert.equal(pendingItem.pendingSync, false); // remote copy overrides
    });
  });

  describe('drainOfflineExpenseQueue & Drainage Lifecycle', () => {
    it('successfully drains pending items sequentially and marks synced', async () => {
      enqueueOfflineExpense({ id: 'drain-1', amount: 1000, tripId: 'trip-drain' });
      enqueueOfflineExpense({ id: 'drain-2', amount: 2000, tripId: 'trip-drain' });

      const syncedItems = [];
      const result = await drainOfflineExpenseQueue({
        tripId: 'trip-drain',
        syncHandler: async (item) => {
          syncedItems.push(item.id);
          return true;
        }
      });

      assert.equal(result.total, 2);
      assert.equal(result.syncedCount, 2);
      assert.equal(result.failedCount, 0);
      assert.deepEqual(syncedItems, ['drain-1', 'drain-2']);
      assert.equal(getPendingQueueCount('trip-drain'), 0);
    });

    it('handles syncHandler errors by updating retryCount and keeping items pending', async () => {
      enqueueOfflineExpense({ id: 'fail-1', amount: 500, tripId: 'trip-fail' });

      const result = await drainOfflineExpenseQueue({
        tripId: 'trip-fail',
        syncHandler: async () => {
          throw new Error('Connection refused');
        }
      });

      assert.equal(result.total, 1);
      assert.equal(result.syncedCount, 0);
      assert.equal(result.failedCount, 1);

      const pending = getPendingExpenses('trip-fail');
      assert.equal(pending.length, 1);
      assert.equal(pending[0].syncStatus, 'failed');
      assert.equal(pending[0].retryCount, 1);
      assert.equal(pending[0].lastError, 'Connection refused');
    });

    it('requires syncHandler function argument', async () => {
      await assert.rejects(async () => {
        await drainOfflineExpenseQueue({ tripId: 'trip-1' });
      }, TypeError);
    });

    it('skips drain if network is offline', async () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
      Object.defineProperty(globalThis.navigator, 'onLine', {
        value: false,
        configurable: true,
        writable: true
      });

      try {
        enqueueOfflineExpense({ id: 'offline-item', amount: 500 });
        const result = await drainOfflineExpenseQueue({
          tripId: '',
          syncHandler: async () => true
        });
        assert.equal(result.offline, true);
        assert.equal(result.syncedCount, 0);
      } finally {
        if (origDescriptor) {
          Object.defineProperty(globalThis.navigator, 'onLine', origDescriptor);
        } else {
          delete globalThis.navigator.onLine;
        }
      }
    });
  });

  describe('Storage Resilience', () => {
    it('readRawQueue handles corrupted JSON safely returning empty array', () => {
      writeRawQueue('not a valid json string');
      assert.deepEqual(readRawQueue(), []);
    });
  });
});
