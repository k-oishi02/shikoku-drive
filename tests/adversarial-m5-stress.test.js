/**
 * tests/adversarial-m5-stress.test.js
 * Milestone 5 Phase 2: Adversarial Coverage Hardening
 *
 * White-box stress testing of:
 * 1. offline-expense-queue.js:
 *    - Concurrency stress: 10 parallel drainOfflineExpenseQueue executions with intermittent network restoration.
 *    - Storage corruption fuzzing: randomly corrupted bytes in shiori_offline_expenses_queue_v1, quota exceeded errors during drain, memory queue overflow.
 * 2. error-boundary.js:
 *    - Error cascade: rapid burst of 1,000 unhandled errors containing DOM event targets and circular references.
 * 3. Canonical Schema v2 Fuzzing:
 *    - Malformed schema variations: trips without days, trips with missing IDs, negative amounts in expenses, trips with 10,000-char notes.
 *    - Compatibility verification with 20261107.json and 20261031.json.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  migrateTripToV2,
  cleanCard,
  cleanCandidate,
  cleanPlanning,
  stripPlanningForPublication,
  validateTripDraft,
  parseTimeRange,
  formatMinute
} from '../src/trip-v2-core.js';

import {
  validateTripInput,
  validateCandidateInput,
  validatePlanningInput,
  validateStoredDraftSize
} from '../src/draft-validation.js';

import {
  analyzeTrip,
  settlementTransfers,
  getTripNowState
} from '../src/trip-v2-analysis.js';

import { buildTimeline } from '../src/itinerary-calc.js';
import { createTripStore } from '../src/trip-store.js';
import { createAdminStore } from '../src/admin-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// =============================================================================
// SUITE 1: Concurrency Stress on drainOfflineExpenseQueue with Intermittent Network
// =============================================================================
describe('Suite 1: Concurrency Stress on drainOfflineExpenseQueue (10 Parallel Calls + Intermittent Network)', () => {
  let originalOnLine;

  beforeEach(() => {
    clearAllQueuedExpenses();
    originalOnLine = globalThis.navigator?.onLine;
    if (typeof globalThis.navigator === 'object' && globalThis.navigator !== null) {
      Object.defineProperty(globalThis.navigator, 'onLine', {
        value: true,
        configurable: true,
        writable: true
      });
    }
  });

  afterEach(() => {
    clearAllQueuedExpenses();
    if (typeof globalThis.navigator === 'object' && globalThis.navigator !== null) {
      Object.defineProperty(globalThis.navigator, 'onLine', {
        value: originalOnLine,
        configurable: true,
        writable: true
      });
    }
  });

  it('1.1 Concurrency Stress: 10 parallel drain calls execute cleanly with mutual exclusion lock', async () => {
    const tripId = 'trip-parallel-10';
    for (let i = 1; i <= 20; i++) {
      enqueueOfflineExpense({
        id: `exp-p10-${i}`,
        tripId,
        amount: i * 100,
        payer: 'Alice',
        note: `Expense item ${i}`
      });
    }
    assert.equal(getPendingQueueCount(tripId), 20);

    const processedOrder = [];
    const syncHandler = async (item) => {
      processedOrder.push(item.id);
      await new Promise(r => setTimeout(r, 10));
      return true;
    };

    // Execute 10 concurrent drain calls simultaneously
    const results = await Promise.all([
      drainOfflineExpenseQueue({ tripId, syncHandler }),
      drainOfflineExpenseQueue({ tripId, syncHandler }),
      drainOfflineExpenseQueue({ tripId, syncHandler }),
      drainOfflineExpenseQueue({ tripId, syncHandler }),
      drainOfflineExpenseQueue({ tripId, syncHandler }),
      drainOfflineExpenseQueue({ tripId, syncHandler }),
      drainOfflineExpenseQueue({ tripId, syncHandler }),
      drainOfflineExpenseQueue({ tripId, syncHandler }),
      drainOfflineExpenseQueue({ tripId, syncHandler }),
      drainOfflineExpenseQueue({ tripId, syncHandler })
    ]);

    // Exactly 1 worker should have processed the queue; 9 should be skipped by the mutex
    const active = results.filter(r => !r.skipped);
    const skipped = results.filter(r => r.skipped === true);

    assert.equal(active.length, 1, 'Only 1 worker must acquire the drain mutex');
    assert.equal(skipped.length, 9, 'Exactly 9 parallel calls must be skipped by mutex');
    assert.equal(active[0].syncedCount, 20);
    assert.equal(active[0].failedCount, 0);

    // SyncHandler must be called exactly 20 times (0 duplicate syncs)
    assert.equal(processedOrder.length, 20);
    assert.equal(new Set(processedOrder).size, 20, 'All processed item IDs must be unique');

    // Queue should be completely cleared
    assert.equal(getPendingQueueCount(tripId), 0);
  });

  it('1.2 Intermittent Network Restoration: drops network mid-drain, then restores and drains rest with 10 parallel calls', async () => {
    const tripId = 'trip-intermittent';
    const totalItems = 30;
    for (let i = 1; i <= totalItems; i++) {
      enqueueOfflineExpense({
        id: `exp-inter-${i}`,
        tripId,
        amount: 250,
        payer: 'Bob',
        note: `Item ${i}`
      });
    }
    assert.equal(getPendingQueueCount(tripId), totalItems);

    const syncedInWave1 = [];
    const syncedInWave2 = [];

    // Wave 1: Network goes offline after 10 items
    const wave1Handler = async (item) => {
      syncedInWave1.push(item.id);
      await new Promise(r => setTimeout(r, 10));
      if (syncedInWave1.length === 10) {
        // Disconnect network mid-drain
        Object.defineProperty(globalThis.navigator, 'onLine', {
          value: false,
          configurable: true,
          writable: true
        });
      }
      return true;
    };

    // Launch 10 parallel calls during Wave 1
    const wave1Results = await Promise.all(
      Array.from({ length: 10 }, () =>
        drainOfflineExpenseQueue({ tripId, syncHandler: wave1Handler })
      )
    );

    const wave1Active = wave1Results.find(r => !r.skipped);
    assert.ok(wave1Active, 'Wave 1 must have an active runner');
    assert.equal(wave1Active.syncedCount, 10, 'Wave 1 must sync exactly 10 items before network drop');

    // Items 11..30 should still be pending or ready for retry
    const remainingPending = getPendingExpenses(tripId);
    assert.equal(remainingPending.length, 20, 'Exactly 20 items must remain pending after mid-drain disconnection');

    // Now restore network connection!
    Object.defineProperty(globalThis.navigator, 'onLine', {
      value: true,
      configurable: true,
      writable: true
    });
    assert.equal(isNetworkOffline(), false);

    // Wave 2: Drain the remaining 20 items with 10 parallel calls
    const wave2Handler = async (item) => {
      syncedInWave2.push(item.id);
      await new Promise(r => setTimeout(r, 5));
      return true;
    };

    const wave2Results = await Promise.all(
      Array.from({ length: 10 }, () =>
        drainOfflineExpenseQueue({ tripId, syncHandler: wave2Handler })
      )
    );

    const wave2Active = wave2Results.find(r => !r.skipped);
    assert.ok(wave2Active, 'Wave 2 must have an active runner');
    assert.equal(wave2Active.syncedCount, 20, 'Wave 2 must sync remaining 20 items');

    // Total unique items synced across both waves must be exactly 30
    const allSynced = [...syncedInWave1, ...syncedInWave2];
    assert.equal(allSynced.length, totalItems);
    assert.equal(new Set(allSynced).size, totalItems, 'Every single item must be synced with zero duplicates');

    // Queue must now be 100% empty
    assert.equal(getPendingQueueCount(tripId), 0);
  });
});

// =============================================================================
// SUITE 2: Storage Corruption Fuzzing & Memory Fallback Stress
// =============================================================================
describe('Suite 2: Storage Corruption Fuzzing & Memory Fallback Stress', () => {
  beforeEach(() => {
    clearAllQueuedExpenses();
  });

  afterEach(() => {
    clearAllQueuedExpenses();
    delete globalThis.localStorage;
  });

  it('2.1 Random byte corruption in shiori_offline_expenses_queue_v1 does not crash queue reader', () => {
    const corruptedPayloads = [
      '{"unterminated_json": [1, 2, 3',
      '\x00\x01\x02\x03\xff\xfe\xaa\xbb',
      'null',
      '42',
      'true',
      '"a raw string without array"',
      '   \r\n\t  ',
      '[{"id": "valid-1"}, null, 999, "string-elem", false, undefined, {}]',
      '{"__proto__": {"polluted": true}}',
      JSON.stringify(Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? null : { id: `item-${i}`, tripId: 'fuzz' })))
    ];

    for (const badPayload of corruptedPayloads) {
      globalThis.localStorage = {
        getItem: () => badPayload,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {}
      };

      assert.doesNotThrow(() => {
        const queue = readRawQueue();
        assert.ok(Array.isArray(queue));
      }, `readRawQueue must not throw on payload: ${badPayload.slice(0, 30)}`);

      assert.doesNotThrow(() => {
        const pending = getPendingExpenses();
        assert.ok(Array.isArray(pending));
      });

      assert.doesNotThrow(() => {
        const count = getPendingQueueCount();
        assert.ok(typeof count === 'number');
      });
    }
  });

  it('2.2 Quota Exceeded error during drainOfflineExpenseQueue maintains in-memory integrity', async () => {
    let mockStorageMap = {};
    let setItemCallCount = 0;

    globalThis.localStorage = {
      getItem: (k) => mockStorageMap[k] ?? null,
      setItem: (k, v) => {
        setItemCallCount++;
        // Simulate localStorage full quota exception
        const err = new Error('The quota has been exceeded.');
        err.name = 'QuotaExceededError';
        err.code = 22;
        throw err;
      },
      removeItem: (k) => delete mockStorageMap[k],
      clear: () => { mockStorageMap = {}; }
    };

    const tripId = 'trip-quota-drain';
    for (let i = 1; i <= 15; i++) {
      enqueueOfflineExpense({
        id: `exp-quota-${i}`,
        tripId,
        amount: 800,
        payer: 'Carol',
        note: `Quota item ${i}`
      });
    }

    assert.equal(getPendingQueueCount(tripId), 15);

    const syncedItems = [];
    const drainResult = await drainOfflineExpenseQueue({
      tripId,
      syncHandler: async (item) => {
        syncedItems.push(item.id);
        return true;
      }
    });

    assert.equal(drainResult.syncedCount, 15);
    assert.equal(drainResult.failedCount, 0);
    assert.equal(syncedItems.length, 15);
    assert.ok(setItemCallCount > 0, 'Quota errors were encountered and absorbed safely');

    // Confirm that cleared items are properly reflected in memoryQueue
    assert.equal(getPendingQueueCount(tripId), 0);
  });

  it('2.3 Memory queue high throughput: 250 enqueued items drain cleanly without corruption', async () => {
    const tripId = 'trip-bulk-stress';
    const totalCount = 250;

    for (let i = 1; i <= totalCount; i++) {
      enqueueOfflineExpense({
        id: `exp-bulk-${i}`,
        tripId,
        amount: 100 + (i % 50),
        payer: i % 2 === 0 ? 'Alice' : 'Bob',
        note: `Bulk item ${i}`
      });
    }

    assert.equal(getPendingQueueCount(tripId), totalCount);

    let drainCount = 0;
    const result = await drainOfflineExpenseQueue({
      tripId,
      syncHandler: async () => {
        drainCount++;
        return true;
      }
    });

    assert.equal(result.syncedCount, totalCount);
    assert.equal(result.failedCount, 0);
    assert.equal(drainCount, totalCount);
    assert.equal(getPendingQueueCount(tripId), 0);
  });
});

// =============================================================================
// SUITE 3: Error Cascade & Burst Stress on src/error-boundary.js
// =============================================================================
describe('Suite 3: Error Cascade & Burst Stress on error-boundary.js (1,000 Rapid Errors with DOM & Cycles)', () => {
  beforeEach(() => {
    resetBoundaryForTesting();
  });

  afterEach(() => {
    resetBoundaryForTesting();
    delete globalThis.document;
    delete globalThis.window;
  });

  it('3.1 Burst of 1,000 unhandled errors containing DOM event targets & circular references (Headless)', () => {
    const originalConsoleError = console.error;
    let consoleCalls = 0;
    console.error = () => { consoleCalls++; };

    try {
      // Circular error object
      const circularError = new Error('Severe cascading system fault');
      circularError.self = circularError;
      circularError.subCycle = { root: circularError };

      // Circular DOM Event simulation
      const fakeDomNode = {
        nodeType: 1,
        tagName: 'DIV',
        id: 'view-root',
        ownerDocument: null
      };
      fakeDomNode.ownerDocument = { body: fakeDomNode }; // cycle

      const fakeEvent = {
        type: 'click',
        target: fakeDomNode,
        currentTarget: fakeDomNode
      };

      const startTime = Date.now();
      for (let i = 1; i <= 1000; i++) {
        reportAppError(circularError, {
          iteration: i,
          domEvent: fakeEvent,
          circularRef: circularError
        });
      }
      const elapsed = Date.now() - startTime;

      // History must be strictly capped at 50 entries
      const history = getErrorHistory();
      assert.equal(history.length, 50, 'errorLog must be capped at 50 entries (ring-buffer invariant)');

      const last = getLastError();
      assert.ok(last !== null);
      assert.equal(last.technicalDetails, 'Severe cascading system fault');
      assert.equal(last.context.iteration, 1000);

      // Verify FIFO ordering: oldest retained must be iteration 951, newest 1000
      assert.equal(history[0].context.iteration, 951);
      assert.equal(history[49].context.iteration, 1000);

      assert.ok(elapsed < 2000, `1,000 reports took ${elapsed}ms, should be under 2,000ms`);
      assert.equal(consoleCalls, 1000);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('3.2 Error Boundary UI Rendering: circular context safely converted to [シリアライズ不可] in DOM mode', () => {
    const originalConsoleError = console.error;
    console.error = () => {};

    const container = {
      id: 'error-boundary-root',
      hidden: true,
      innerHTML: '',
      querySelector: () => ({ addEventListener: () => {} })
    };

    globalThis.document = {
      getElementById: (id) => (id === 'error-boundary-root' ? container : null),
      createElement: () => ({ id: '', textContent: '', appendChild: () => {}, querySelector: () => null }),
      head: { appendChild: () => {} },
      body: { appendChild: () => {} }
    };
    globalThis.window = { location: { reload: () => {} } };

    try {
      const circularContext = { screen: 'ExpenseModal' };
      circularContext.nested = circularContext;

      assert.doesNotThrow(() => {
        reportAppError(new Error('UI Cascade Error'), circularContext);
      });

      assert.equal(container.hidden, false);
      assert.ok(container.innerHTML.includes('[シリアライズ不可]'), 'Must render fallback message for circular context');
      assert.ok(container.innerHTML.includes('UI Cascade Error'));
    } finally {
      console.error = originalConsoleError;
    }
  });
});

// =============================================================================
// SUITE 4: Canonical Schema v2 Fuzzing & Malformed Schema Variations
// =============================================================================
describe('Suite 4: Canonical Schema v2 Fuzzing & Malformed Variations', () => {
  it('4.1 Trips without days: handles missing, null, empty, or non-object days gracefully', () => {
    const malformedVariations = [
      { tripId: 'trip-no-days-1', title: 'No Days 1' }, // days undefined
      { tripId: 'trip-no-days-2', title: 'No Days 2', days: null },
      { tripId: 'trip-no-days-3', title: 'No Days 3', days: {} },
      { tripId: 'trip-no-days-4', title: 'No Days 4', days: 'invalid-string' },
      { tripId: 'trip-no-days-5', title: 'No Days 5', days: [] }
    ];

    for (const raw of malformedVariations) {
      const migrated = migrateTripToV2(raw, raw.tripId);
      assert.ok(migrated.days && typeof migrated.days === 'object');
      assert.ok(Array.isArray(migrated.days.day1), 'Must guarantee day1 array exists as fallback');
      assert.equal(migrated.schemaVersion, 2);

      // analyzeTrip must not crash on trips without days
      assert.doesNotThrow(() => {
        const audit = analyzeTrip(raw);
        assert.ok(Array.isArray(audit.issues));
      });
    }

    // validateTripInput detects non-object days
    const validationErrors = validateTripInput({ tripId: 'trip-bad-days', title: 'Bad', days: 'not-an-obj' });
    assert.ok(validationErrors.some(e => e.includes('days')));
  });

  it('4.2 Trips with missing or invalid IDs: properly flagged by validators and normalized with fallbackId', () => {
    const invalidIdTrips = [
      { title: 'Missing ID' },
      { tripId: '', title: 'Empty ID' },
      { tripId: 'ab', title: 'Too short (<3 chars)' },
      { tripId: 'a'.repeat(45), title: 'Too long (>40 chars)' },
      { tripId: 'INVALID_UPPERCASE', title: 'Uppercase' },
      { tripId: 'invalid spaces', title: 'Has spaces' },
      { tripId: 12345, title: 'Numeric ID' }
    ];

    for (const raw of invalidIdTrips) {
      // 1. validateTripInput strictly flags all missing or non-conforming tripIds
      const errors = validateTripInput(raw);
      assert.ok(errors.length > 0, `Expected validation errors for: ${JSON.stringify(raw.tripId)}`);
      assert.ok(errors.some(e => e.includes('tripId')));

      // 2. Character format violations (uppercase, spaces, too short) are flagged by analyzeTrip
      if (['ab', 'INVALID_UPPERCASE', 'invalid spaces'].includes(raw.tripId)) {
        const audit = analyzeTrip(raw);
        assert.ok(audit.issues.some(i => i.level === 'error' && (i.code === 'trip-id' || i.path === 'tripId')));
      }

      // 3. migrateTripToV2 supplies fallbackId when tripId is missing or falsy
      if (!raw.tripId) {
        const fallback = migrateTripToV2(raw, 'safe-fallback-id');
        assert.equal(fallback.tripId, 'safe-fallback-id');
      }
    }
  });

  it('4.3 Negative amounts in expenses: normalized to 0 in queue and settlementTransfers', () => {
    const members = [
      { id: 'user-alice', name: 'Alice' },
      { id: 'user-bob', name: 'Bob' }
    ];

    const expensesWithNegative = [
      { id: 'exp-neg-1', amount: -5000, payer: 'user-alice' },
      { id: 'exp-neg-2', amount: -1, payer: 'user-bob' },
      { id: 'exp-zero', amount: 0, payer: 'user-alice' }
    ];

    // settlementTransfers must ignore negative and zero amounts
    const transfers = settlementTransfers(members, expensesWithNegative);
    assert.equal(transfers.length, 0, 'Negative amounts must result in 0 transfers');

    // enqueueOfflineExpense clamps negative amount to 0
    const queuedNeg = enqueueOfflineExpense({ amount: -9999, payer: 'user-alice' });
    assert.equal(queuedNeg.amount, 0);

    const queuedNegStr = enqueueOfflineExpense({ amount: '-3400', payer: 'user-alice' });
    assert.equal(queuedNegStr.amount, 0);
  });

  it('4.4 Trips with 10,000-char notes: correctly truncated or rejected across domain boundaries', () => {
    const huge10k = 'A'.repeat(10000);

    // 1. Day note in trip
    const tripWithHugeNote = {
      tripId: 'trip-huge-notes',
      title: 'Huge Note Trip',
      daySettings: {
        day1: {
          note: huge10k
        }
      }
    };

    const migrated = migrateTripToV2(tripWithHugeNote);
    assert.ok(migrated.daySettings.day1.note.length <= 160, 'Day note must be truncated to <= 160 chars');

    const tripInputErrors = validateTripInput(tripWithHugeNote);
    assert.ok(tripInputErrors.some(e => e.includes('160文字以内')));

    // 2. Candidate notes (max 2000 chars)
    const candWithHugeNote = {
      title: 'Huge Candidate',
      notes: huge10k
    };
    const cleanedCand = cleanCandidate(candWithHugeNote);
    assert.ok(cleanedCand.notes.length <= 2000, 'Candidate notes must be truncated to <= 2000 chars');

    const candErrors = validateCandidateInput(candWithHugeNote);
    assert.ok(candErrors.some(e => e.includes('2000文字以内')));

    // 3. Planning notes (max 5000 chars)
    const planningWithHugeNote = {
      notes: huge10k
    };
    const cleanedPlan = cleanPlanning(planningWithHugeNote);
    assert.ok(cleanedPlan.notes.length <= 5000, 'Planning notes must be truncated to <= 5000 chars');

    const planErrors = validatePlanningInput(planningWithHugeNote);
    assert.ok(planErrors.some(e => e.includes('5000文字以内')));
  });

  it('4.5 Real trip compatibility verification: loads 20261107.json & 20261031.json with zero regressions', () => {
    const p07 = path.resolve(projectRoot, '20261107.json');
    const p31 = path.resolve(projectRoot, '20261031.json');

    const raw07Str = fs.readFileSync(p07, 'utf8');
    const raw31Str = fs.readFileSync(p31, 'utf8');

    assert.equal(raw07Str, raw31Str, '20261031.json and 20261107.json must be byte-for-byte identical');

    const trip07 = JSON.parse(raw07Str);
    assert.equal(trip07.schemaVersion, 2);
    assert.equal(trip07.tripId, '20261107');
    assert.equal(trip07.days.day1.length, 8);

    // Audit verification: 0 error-level issues
    const audit = analyzeTrip(trip07);
    const errors = audit.issues.filter(i => i.level === 'error');
    assert.equal(errors.length, 0, 'Canonical trip must have 0 audit errors');

    // Timeline verification: 0 schedule conflicts
    const { timeline, conflicts } = buildTimeline(trip07, { offsetMinutes: 0 }, 'day1');
    assert.equal(timeline.length, 8);
    assert.equal(conflicts.length, 0);

    // Store mounting verification
    const tripStore = createTripStore({ activeTrip: trip07 });
    assert.equal(tripStore.getSlice('activeTrip').tripId, '20261107');
    assert.equal(tripStore.getSlice('activeTrip').days.day1.length, 8);

    const adminStore = createAdminStore({ trip: trip07 });
    assert.equal(adminStore.getSlice('trip').tripId, '20261107');
  });
});
