import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  initErrorBoundary,
  reportAppError,
  createErrorReport,
  escapeHtml,
  getLastError,
  getErrorHistory,
  clearErrorState,
  resetBoundaryForTesting,
  renderErrorUI,
  hideErrorUI
} from '../src/error-boundary.js';

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
  isNetworkOffline,
  drainOfflineExpenseQueue
} from '../src/offline-expense-queue.js';

describe('Milestone 4 Adversarial Stress & Vulnerability Challenge Suite', () => {

  // =========================================================================
  // SECTION 1: Error Boundary Adversarial Stress Tests
  // =========================================================================
  describe('1. Error Boundary (src/error-boundary.js) Stress & Edge Cases', () => {
    beforeEach(() => {
      resetBoundaryForTesting();
    });

    afterEach(() => {
      resetBoundaryForTesting();
    });

    it('1.1 Burst Stress: handles 600 rapid sequential errors without memory leak or crash, caps errorLog at 50', () => {
      const startTime = Date.now();
      for (let i = 1; i <= 600; i++) {
        reportAppError(new Error(`Burst error #${i}`), { index: i, burst: true });
      }
      const elapsed = Date.now() - startTime;

      // Log must be capped at 50 (ring buffer behavior)
      const history = getErrorHistory();
      assert.equal(history.length, 50, 'errorLog must be capped at exactly 50 entries');

      // Last error must be the 600th
      const last = getLastError();
      assert.ok(last !== null);
      assert.equal(last.technicalDetails, 'Burst error #600');
      assert.equal(last.context.index, 600);

      // Oldest entry in history must be error #551
      assert.equal(history[0].technicalDetails, 'Burst error #551');
      assert.equal(history[49].technicalDetails, 'Burst error #600');

      // Performance check: 600 reports in headless Node should execute within 1000ms
      assert.ok(elapsed < 1000, `600 reports took ${elapsed}ms, should be under 1000ms`);
    });

    it('1.2 Concurrent Burst: handles 500 concurrent asynchronous errors via Promise.all', async () => {
      const tasks = Array.from({ length: 500 }, (_, i) => {
        return Promise.resolve().then(() => {
          reportAppError(new Error(`Async burst #${i}`), { asyncIndex: i });
        });
      });

      await Promise.all(tasks);
      const history = getErrorHistory();
      assert.equal(history.length, 50);
      assert.ok(getLastError() !== null);
    });

    it('1.3 Malformed Payloads: handles primitives, null, undefined, numbers, BigInt, Symbols', () => {
      // null error
      const rNull = reportAppError(null);
      assert.equal(rNull.technicalDetails, '不明なエラー');

      // undefined error
      const rUndef = reportAppError(undefined);
      assert.equal(rUndef.technicalDetails, '不明なエラー');

      // number
      const rNum = reportAppError(500);
      assert.equal(rNum.technicalDetails, '500');

      // boolean false
      const rFalse = reportAppError(false);
      assert.equal(rFalse.technicalDetails, '不明なエラー');

      // boolean true
      const rTrue = reportAppError(true);
      assert.equal(rTrue.technicalDetails, 'true');

      // Symbol
      const sym = Symbol('CRASH_CODE');
      const rSym = reportAppError(sym);
      assert.equal(rSym.technicalDetails, 'Symbol(CRASH_CODE)');

      // BigInt
      const rBig = reportAppError(9007199254740991n);
      assert.equal(rBig.technicalDetails, '9007199254740991');

      // Non-object context
      const rContextPrimitive = reportAppError('Simple error', 'not-an-object');
      assert.deepEqual(rContextPrimitive.context, {});

      const rContextNull = reportAppError('Simple error', null);
      assert.deepEqual(rContextNull.context, {});
    });

    it('1.4 Circular Structure Defense in Error and Context (Headless Mode)', () => {
      // Error with circular property
      const circError = new Error('Circular error test');
      circError.self = circError;

      assert.doesNotThrow(() => {
        const rep = reportAppError(circError);
        assert.equal(rep.technicalDetails, 'Circular error test');
      });

      // Context with circular reference in Headless environment (where document is undefined)
      const circContext = { name: 'circular-test' };
      circContext.ref = circContext;

      assert.doesNotThrow(() => {
        const rep = reportAppError('Error with circ context', circContext);
        assert.equal(rep.technicalDetails, 'Error with circ context');
        assert.equal(rep.context.name, 'circular-test');
      });
    });

    it('1.5 Circular context & BigInt in DOM mode: safely renders without throwing', () => {
      const originalDoc = global.document;
      const originalWin = global.window;

      const containerEl = {
        id: 'error-boundary-root',
        hidden: true,
        innerHTML: '',
        querySelector: () => null
      };

      global.document = {
        getElementById: (id) => (id === 'error-boundary-root' ? containerEl : null),
        createElement: (tag) => ({ tagName: tag.toUpperCase(), appendChild: () => {}, id: '', textContent: '' }),
        head: { appendChild: () => {} },
        body: { appendChild: () => {} }
      };
      global.window = { location: { reload: () => {} } };

      try {
        // Safe context renders cleanly
        reportAppError('Safe error', { user: 'tester', route: '/home' });
        assert.equal(containerEl.hidden, false);

        // Circular context: safely handled without throwing
        const circContext = { component: 'MapView' };
        circContext.parent = circContext;

        assert.doesNotThrow(() => {
          renderErrorUI({
            status: 'error',
            displayMessage: 'エラー',
            technicalDetails: 'Circ Test',
            context: circContext
          });
        });
        assert.ok(containerEl.innerHTML.includes('[シリアライズ不可]'));

        // BigInt in context: safely handled without throwing
        const bigIntContext = { timestamp: 1729382400000n };
        assert.doesNotThrow(() => {
          renderErrorUI({
            status: 'error',
            displayMessage: 'エラー',
            technicalDetails: 'BigInt Test',
            context: bigIntContext
          });
        });
        assert.ok(containerEl.innerHTML.includes('[シリアライズ不可]'));
      } finally {
        global.document = originalDoc;
        global.window = originalWin;
      }
    });

    it('1.6 Null-prototype object defense: createErrorReport handles Object.create(null) safely', () => {
      const nullProtoObj = Object.create(null);
      nullProtoObj.code = 'CRITICAL';

      assert.doesNotThrow(() => {
        const report = createErrorReport(nullProtoObj);
        assert.equal(report.status, 'error');
        assert.equal(report.technicalDetails, '不明なエラー');
      });
    });

    it('1.7 XSS Payload Escaping: verifies all injection vectors in message, stack, and context are escaped', () => {
      const originalDoc = global.document;
      const originalWin = global.window;

      const containerEl = {
        id: 'error-boundary-root',
        hidden: true,
        innerHTML: '',
        querySelector: () => null
      };

      global.document = {
        getElementById: (id) => (id === 'error-boundary-root' ? containerEl : null),
        createElement: (tag) => ({ tagName: tag.toUpperCase(), appendChild: () => {}, id: '', textContent: '' }),
        head: { appendChild: () => {} },
        body: { appendChild: () => {} }
      };
      global.window = { location: { reload: () => {} } };

      try {
        const xssError = new Error('<script>alert("XSS_MSG")</script>');
        xssError.stack = 'Error at <img src=x onerror=alert(1)>:10:20\n    at eval (<iframe src=x>)';

        reportAppError(xssError, {
          payload: '<svg onload="alert(1)">',
          attrBreakout: '" onmouseover="alert(2)'
        });

        const html = containerEl.innerHTML;
        // Verify NO unescaped HTML tags can execute in the DOM
        assert.ok(!html.includes('<script>'), 'Must not contain raw <script>');
        assert.ok(!html.includes('<img src='), 'Must not contain raw <img');
        assert.ok(!html.includes('<iframe'), 'Must not contain raw <iframe');
        assert.ok(!html.includes('<svg onload='), 'Must not contain raw <svg onload=');

        // Verify entities escaped
        assert.ok(html.includes('&lt;script&gt;alert(&quot;XSS_MSG&quot;)&lt;/script&gt;'));
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.ok(html.includes('&lt;iframe src=x&gt;'));
        assert.ok(html.includes('&lt;svg onload='));
      } finally {
        global.document = originalDoc;
        global.window = originalWin;
      }
    });

    it('1.8 Headless Node.js Safety: operations without window or document', () => {
      assert.equal(typeof document, 'undefined');
      assert.equal(typeof window, 'undefined');

      assert.doesNotThrow(() => initErrorBoundary());
      assert.doesNotThrow(() => hideErrorUI());
      assert.doesNotThrow(() => renderErrorUI(createErrorReport('Headless test')));
      assert.doesNotThrow(() => clearErrorState());

      const rep = reportAppError('Headless execution test');
      assert.equal(rep.status, 'error');
      assert.equal(rep.technicalDetails, 'Headless execution test');
      assert.equal(getLastError(), rep);
    });
  });

  // =========================================================================
  // SECTION 2: Offline Expense Queue Adversarial Stress Tests
  // =========================================================================
  describe('2. Offline Expense Queue (src/offline-expense-queue.js) Stress & Edge Cases', () => {
    beforeEach(() => {
      clearAllQueuedExpenses();
    });

    it('2.1 Corrupted JSON in localStorage: string corruptions handled safely', () => {
      const corruptions = [
        '{ malformed json [',
        'undefined',
        'null',
        '42',
        '"just a string"',
        '{"id": "not an array"}',
        '   \n\t   ',
        '{"__proto__": {"polluted": true}}'
      ];

      for (const badData of corruptions) {
        writeRawQueue(badData);
        let queue;
        assert.doesNotThrow(() => {
          queue = readRawQueue();
        }, `readRawQueue threw on input: ${badData}`);
        assert.ok(Array.isArray(queue), `Must return Array on: ${badData}`);
      }
    });

    it('2.2 Corrupted raw queue elements: null and primitives are filtered and do not crash queue functions', () => {
      // If storage holds an array containing null or primitive values alongside valid items
      writeRawQueue([null, 123, 'corrupted-entry', { id: 'valid-1', tripId: 'shikoku-2026', syncStatus: 'pending', amount: 500 }]);

      // getOfflineExpensesQueue safely filters and does not crash
      assert.doesNotThrow(() => {
        const queue = getOfflineExpensesQueue('shikoku-2026');
        assert.equal(queue.length, 1);
        assert.equal(queue[0].id, 'valid-1');
      });

      // getPendingExpenses safely filters and does not crash
      assert.doesNotThrow(() => {
        const pending = getPendingExpenses();
        assert.equal(pending.length, 1);
        assert.equal(pending[0].id, 'valid-1');
      });

      // enqueueOfflineExpense safely succeeds and does not crash
      assert.doesNotThrow(() => {
        const enqueued = enqueueOfflineExpense({ amount: 1000, tripId: 'shikoku-2026' });
        assert.ok(enqueued);
      });
      assert.equal(getPendingExpenses('shikoku-2026').length, 2);
    });

    it('2.3 writeRawQueue safety on non-array inputs', () => {
      assert.equal(writeRawQueue(null), true);
      assert.deepEqual(readRawQueue(), []);

      assert.equal(writeRawQueue(undefined), true);
      assert.deepEqual(readRawQueue(), []);

      assert.equal(writeRawQueue('not an array'), true);
      assert.deepEqual(readRawQueue(), []);

      assert.equal(writeRawQueue({ not: 'array' }), true);
      assert.deepEqual(readRawQueue(), []);
    });

    it('2.4 Mutex Lock Test: parallel drainOfflineExpenseQueue calls guard against concurrent drains', async () => {
      enqueueOfflineExpense({ id: 'drain-mutex-1', amount: 1000, tripId: 'trip-mutex' });
      enqueueOfflineExpense({ id: 'drain-mutex-2', amount: 2000, tripId: 'trip-mutex' });

      let syncCallCount = 0;
      const syncHandler = async (item) => {
        syncCallCount++;
        // Artificial async delay to simulate network latency
        await new Promise(r => setTimeout(r, 40));
        return true;
      };

      // Launch 5 parallel drain calls concurrently
      const [res1, res2, res3, res4, res5] = await Promise.all([
        drainOfflineExpenseQueue({ tripId: 'trip-mutex', syncHandler }),
        drainOfflineExpenseQueue({ tripId: 'trip-mutex', syncHandler }),
        drainOfflineExpenseQueue({ tripId: 'trip-mutex', syncHandler }),
        drainOfflineExpenseQueue({ tripId: 'trip-mutex', syncHandler }),
        drainOfflineExpenseQueue({ tripId: 'trip-mutex', syncHandler })
      ]);

      // Exactly ONE caller should execute; the remaining 4 must be skipped via mutex
      const completedDrains = [res1, res2, res3, res4, res5].filter(r => !r.skipped);
      const skippedDrains = [res1, res2, res3, res4, res5].filter(r => r.skipped === true);

      assert.equal(completedDrains.length, 1, 'Exactly one drain call should execute');
      assert.equal(skippedDrains.length, 4, 'Remaining 4 parallel calls must be skipped by mutex');
      assert.equal(completedDrains[0].syncedCount, 2);
      assert.equal(syncCallCount, 2, 'SyncHandler must be called exactly once per item');

      // Verify mutex lock was cleanly released in finally block
      const subsequentResult = await drainOfflineExpenseQueue({ tripId: 'trip-mutex', syncHandler: async () => true });
      assert.equal(subsequentResult.skipped, undefined, 'Subsequent drain should run cleanly without being locked');
    });

    it('2.5 Mutex Lock Release on Uncaught Exception in drain loop', async () => {
      enqueueOfflineExpense({ id: 'drain-crash-1', amount: 1500, tripId: 'trip-crash' });

      // Simulate a syncHandler that throws synchronously or asynchronously
      await drainOfflineExpenseQueue({
        tripId: 'trip-crash',
        syncHandler: () => {
          throw new Error('Fatal socket abort');
        }
      });

      // Confirm item is marked failed
      const pending = getPendingExpenses('trip-crash');
      assert.equal(pending[0].syncStatus, 'failed');

      // Crucial: isSyncDraining must be false so subsequent calls can execute
      const nextRes = await drainOfflineExpenseQueue({
        tripId: 'trip-crash',
        syncHandler: async () => true
      });
      assert.equal(nextRes.skipped, undefined, 'Mutex must be released even after error');
      assert.equal(nextRes.syncedCount, 1);
    });

    it('2.6 Deduplication: enqueuing duplicate expense ID updates record in-place (upsert)', () => {
      const item1 = enqueueOfflineExpense({
        id: 'exp-dup-1',
        tripId: 'trip-dup',
        amount: 3000,
        payer: 'Alice',
        note: 'Initial lunch'
      });

      assert.equal(getPendingQueueCount('trip-dup'), 1);
      assert.equal(item1.amount, 3000);

      // Enqueue identical ID with updated amount and note
      const item2 = enqueueOfflineExpense({
        id: 'exp-dup-1',
        tripId: 'trip-dup',
        amount: 3500,
        payer: 'Alice',
        note: 'Updated lunch with coffee'
      });

      assert.equal(getPendingQueueCount('trip-dup'), 1, 'Queue count must remain 1');
      assert.equal(item2.amount, 3500);
      assert.equal(item2.note, 'Updated lunch with coffee');

      const all = getOfflineExpensesQueue('trip-dup');
      assert.equal(all.length, 1);
      assert.equal(all[0].amount, 3500);
      assert.equal(all[0].note, 'Updated lunch with coffee');
    });

    it('2.7 Deduplication by queueId: updates record in-place when queueId matches', () => {
      const qId = 'offline-custom-token-999';
      enqueueOfflineExpense({
        queueId: qId,
        id: 'exp-first-id',
        amount: 500,
        note: 'v1'
      });

      assert.equal(readRawQueue().length, 1);

      enqueueOfflineExpense({
        queueId: qId,
        id: 'exp-second-id',
        amount: 800,
        note: 'v2'
      });

      const queue = readRawQueue();
      assert.equal(queue.length, 1);
      assert.equal(queue[0].amount, 800);
      assert.equal(queue[0].note, 'v2');
    });

    it('2.8 Deduplication in mergeWithOfflineQueue: remote items take precedence over pending local items', () => {
      enqueueOfflineExpense({
        id: 'exp-shared-1',
        tripId: 'trip-merge',
        amount: 1000,
        createdAt: '2026-10-20T10:00:00Z'
      });

      const remoteItems = [
        {
          id: 'exp-shared-1',
          tripId: 'trip-merge',
          amount: 1000,
          createdAt: '2026-10-20T10:00:00Z',
          synced: true
        },
        {
          id: 'exp-remote-2',
          tripId: 'trip-merge',
          amount: 4000,
          createdAt: '2026-10-20T11:00:00Z'
        }
      ];

      const merged = mergeWithOfflineQueue(remoteItems, 'trip-merge');
      assert.equal(merged.length, 2, 'Must not duplicate exp-shared-1');

      const shared = merged.find(i => i.id === 'exp-shared-1');
      assert.ok(shared);
      assert.equal(shared.syncStatus, 'synced');
      assert.equal(shared.pendingSync, false);
    });

    it('2.9 Extreme & Negative Amounts: negative amounts clamp to 0, non-integers round to integer yen', () => {
      // Negative amount
      const rNeg = enqueueOfflineExpense({ amount: -5000 });
      assert.equal(rNeg.amount, 0, 'Negative amount must be clamped to 0');

      // Negative string
      const rNegStr = enqueueOfflineExpense({ amount: '-1200' });
      assert.equal(rNegStr.amount, 0, 'Negative string amount must clamp to 0');

      // Float rounding (FinTech 1-yen integer invariant)
      const rFloatUp = enqueueOfflineExpense({ amount: 1500.65 });
      assert.equal(rFloatUp.amount, 1501, '1500.65 must round to 1501');

      const rFloatDown = enqueueOfflineExpense({ amount: 1500.49 });
      assert.equal(rFloatDown.amount, 1500, '1500.49 must round to 1500');

      // NaN and non-numeric
      const rNaN = enqueueOfflineExpense({ amount: 'invalid-number' });
      assert.equal(rNaN.amount, 0, 'NaN string must default to 0');

      const rNull = enqueueOfflineExpense({ amount: null });
      assert.equal(rNull.amount, 0, 'null must default to 0');

      const rUndef = enqueueOfflineExpense({ amount: undefined });
      assert.equal(rUndef.amount, 0, 'undefined must default to 0');
    });

    it('2.10 Non-finite amount guard: Infinity or -Infinity amounts default to 0 and serialize safely', () => {
      const rInf = enqueueOfflineExpense({ amount: Infinity });
      assert.equal(rInf.amount, 0);

      const rNegInf = enqueueOfflineExpense({ amount: -Infinity });
      assert.equal(rNegInf.amount, 0);

      // Upon JSON storage round-trip:
      const rawQueue = readRawQueue();
      const savedItem = rawQueue.find(i => i.id === rInf.id);
      assert.equal(savedItem.amount, 0, 'Amount must remain 0 and never serialize to null');
    });

    it('2.11 Note Truncation: truncates notes exceeding 120 characters and trims whitespace', () => {
      const longNote = 'A'.repeat(300);
      const rLong = enqueueOfflineExpense({ note: longNote });
      assert.equal(rLong.note.length, 120, 'Note must be truncated to exactly 120 characters');
      assert.equal(rLong.note, 'A'.repeat(120));

      const whitespaceNote = '    \n  温泉入湯税とタオル代   \t  ';
      const rTrimmed = enqueueOfflineExpense({ note: whitespaceNote });
      assert.equal(rTrimmed.note, '温泉入湯税とタオル代');

      const nullNote = enqueueOfflineExpense({ note: null });
      assert.equal(nullNote.note, '');
    });

    it('2.12 Storage Quota Exhaustion fallback: retains offline records in-memory when setItem throws', () => {
      const originalStorage = global.localStorage;
      let storageMap = {};

      global.localStorage = {
        getItem: (k) => storageMap[k] || null,
        setItem: () => {
          const err = new Error('The quota has been exceeded.');
          err.name = 'QuotaExceededError';
          throw err;
        },
        removeItem: (k) => delete storageMap[k],
        clear: () => { storageMap = {}; }
      };

      try {
        const item = enqueueOfflineExpense({ amount: 1500, note: 'quota-loss-test' });
        assert.ok(item !== null);

        // Queue must retain the item in memory fallback
        const retrieved = readRawQueue();
        assert.equal(retrieved.length, 1);
        assert.equal(retrieved[0].note, 'quota-loss-test');
        assert.equal(retrieved[0].amount, 1500);
      } finally {
        global.localStorage = originalStorage;
      }
    });
  });
});
