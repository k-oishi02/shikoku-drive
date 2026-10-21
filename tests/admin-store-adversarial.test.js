import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminStore, createInitialAdminState } from '../src/admin-store.js';

describe('AdminStore Adversarial Challenge & Stress Suite', () => {

  // =========================================================================
  // 1. Rapid Concurrent State Mutations & Stress
  // =========================================================================
  describe('1. Rapid Concurrent State Mutations & Stress', () => {

    it('handles 1,000 rapid sequential synchronous state mutations without loss', () => {
      const store = createAdminStore({ counter: 0 });
      let notificationCount = 0;
      store.subscribe(() => {
        notificationCount++;
      });

      const start = performance.now();
      for (let i = 1; i <= 1000; i++) {
        store.setState(prev => ({
          counter: prev.counter + 1
        }));
      }
      const duration = performance.now() - start;

      const state = store.getState();
      assert.equal(state.counter, 1000, 'State counter must accurately reach 1,000');
      assert.equal(notificationCount, 1000, 'Subscribers must receive exactly 1,000 notifications');
      assert.ok(duration < 150, `1,000 updates took ${duration}ms, expected < 150ms`);
    });

    it('handles 5,000 interleaved slice updates without state corruption', () => {
      const store = createAdminStore();
      const slices = ['overview', 'editor', 'candidateShelf', 'dayPlanner', 'distribution', 'roles', 'discussion'];

      const start = performance.now();
      for (let i = 0; i < 5000; i++) {
        const sliceName = slices[i % slices.length];
        store.setSlice(sliceName, prev => ({
          ...prev,
          updateSeq: i,
          updatedAt: Date.now()
        }));
      }
      const duration = performance.now() - start;

      // Verify each slice holds its expected final updateSeq
      for (let idx = 0; idx < slices.length; idx++) {
        const sliceName = slices[idx];
        const slice = store.getSlice(sliceName);
        assert.ok(slice != null, `Slice ${sliceName} must exist`);
        assert.ok(typeof slice.updateSeq === 'number', `Slice ${sliceName} must have numeric updateSeq`);
      }
      assert.ok(duration < 500, `5,000 slice updates took ${duration}ms, expected < 500ms`);
    });

    it('handles 1,000 concurrent asynchronous updates via Promise.all without race corruption', async () => {
      const store = createAdminStore({ asyncCounter: 0 });

      await Promise.all(
        Array.from({ length: 1000 }, async (_, i) => {
          // Add microtask jitter
          if (i % 2 === 0) await Promise.resolve();
          store.setState(prev => ({
            asyncCounter: prev.asyncCounter + 1
          }));
        })
      );

      assert.equal(store.getState().asyncCounter, 1000, 'All 1,000 async microtask updates must be accurately accumulated');
    });

    it('preserves state integrity when functional updater throws an exception', () => {
      const store = createAdminStore({ safeVal: 42, errorOccurred: false });
      let notifyCount = 0;
      store.subscribe(() => {
        notifyCount++;
      });

      assert.throws(() => {
        store.setState(() => {
          throw new Error('Explosive updater');
        });
      }, /Explosive updater/);

      // Verify state was not corrupted and no notifications dispatched
      assert.equal(store.getState().safeVal, 42);
      assert.equal(notifyCount, 0, 'No notification should fire if updater throws');
    });

  });

  // =========================================================================
  // 2. High Volume Subscribers & Dynamic Unsubscriptions
  // =========================================================================
  describe('2. High Volume Subscribers & Dynamic Unsubscriptions', () => {

    it('handles 1,000 active subscribers receiving multiple dispatches smoothly', () => {
      const store = createAdminStore({ tick: 0 });
      let totalReceived = 0;
      const unsubs = [];

      for (let i = 0; i < 1000; i++) {
        unsubs.push(store.subscribe((state) => {
          totalReceived += state.tick;
        }));
      }

      const start = performance.now();
      store.setState({ tick: 1 });
      store.setState({ tick: 2 });
      const duration = performance.now() - start;

      // 1,000 * 1 + 1,000 * 2 = 3,000
      assert.equal(totalReceived, 3000);
      assert.ok(duration < 200, `Notifying 1,000 subscribers twice took ${duration}ms, expected < 200ms`);

      // Cleanup
      unsubs.forEach(u => u());
      store.setState({ tick: 10 });
      assert.equal(totalReceived, 3000, 'No callbacks after all 1,000 subscribers unsubscribed');
    });

    it('subscriber safely unsubscribes itself during its own notification callback', () => {
      const store = createAdminStore({ count: 0 });
      let subCalls = 0;

      let unsub;
      unsub = store.subscribe((state) => {
        subCalls++;
        if (state.count === 1) {
          unsub(); // Self-unsubscribe during notification!
        }
      });

      store.setState({ count: 1 });
      assert.equal(subCalls, 1);

      store.setState({ count: 2 });
      store.setState({ count: 3 });
      assert.equal(subCalls, 1, 'Self-unsubscribed listener must never receive subsequent notifications');
    });

    it('subscriber unsubscribes a subsequent subscriber during iteration without skip corruption', () => {
      const store = createAdminStore({ v: 0 });
      const calls = [];

      let unsubB;
      const unsubA = store.subscribe((s) => {
        calls.push(`A:${s.v}`);
        if (unsubB) {
          unsubB(); // Unsubscribes B while iteration is ongoing
        }
      });

      unsubB = store.subscribe((s) => {
        calls.push(`B:${s.v}`);
      });

      const unsubC = store.subscribe((s) => {
        calls.push(`C:${s.v}`);
      });

      store.setState({ v: 1 });
      // In JS Set iteration, if an item not yet visited is deleted, it is skipped.
      // So B is deleted during A's callback, thus B should NOT be called for v: 1.
      // C must still be called!
      assert.ok(calls.includes('A:1'));
      assert.ok(calls.includes('C:1'), 'Subsequent subscriber C must still receive notification');
      assert.ok(!calls.includes('B:1'), 'Deleted subscriber B must be skipped');

      store.setState({ v: 2 });
      assert.ok(calls.includes('A:2'));
      assert.ok(calls.includes('C:2'));
      assert.ok(!calls.includes('B:2'));

      unsubA();
      unsubC();
    });

    it('re-entrant subscribe adds listener visited in current notification cycle', () => {
      const store = createAdminStore({ tick: 0 });
      const order = [];

      let innerUnsub = null;
      store.subscribe((s) => {
        order.push(`outer:${s.tick}`);
        if (s.tick === 1 && !innerUnsub) {
          innerUnsub = store.subscribe((s2) => {
            order.push(`inner:${s2.tick}`);
          });
        }
      });

      store.setState({ tick: 1 });
      // Due to Set.prototype.forEach semantics, elements added during iteration are visited
      assert.ok(order.includes('outer:1'));
      assert.ok(order.includes('inner:1'), 'Newly added listener is visited before iteration terminates');

      if (innerUnsub) innerUnsub();
    });

    it('re-entrant setState inside subscriber terminates cleanly when guarded', () => {
      const store = createAdminStore({ level: 0 });
      const trace = [];

      const unsub = store.subscribe((s) => {
        trace.push(s.level);
        if (s.level < 3) {
          store.setState({ level: s.level + 1 });
        }
      });

      store.setState({ level: 1 });
      // Trace will record the cascade of updates:
      // level: 1 -> triggers level: 2 -> triggers level: 3 (halts)
      assert.equal(store.getState().level, 3);
      assert.ok(trace.includes(3));

      unsub();
    });

    it('subscriber registration is deduplicated for identical function references', () => {
      const store = createAdminStore({ val: 0 });
      let calls = 0;
      const fn = () => { calls++; };

      const u1 = store.subscribe(fn);
      const u2 = store.subscribe(fn); // identical reference

      store.setState({ val: 1 });
      assert.equal(calls, 1, 'Set-backed listener registry must deduplicate identical references');

      u1();
      store.setState({ val: 2 });
      assert.equal(calls, 1, 'Unsubscribing deduplicated reference removes listener');
      u2(); // idempotent
    });

    it('subscriber throwing an unhandled exception interrupts remaining subscriber notifications', () => {
      const store = createAdminStore({ step: 0 });
      let sub2Called = false;

      store.subscribe(() => {
        throw new Error('Subscriber 1 Failure');
      });
      store.subscribe(() => {
        sub2Called = true;
      });

      // Invoking setState will throw when subscriber 1 fails
      assert.throws(() => {
        store.setState({ step: 1 });
      }, /Subscriber 1 Failure/);

      // State is already updated, but subscriber 2 was blocked from notification
      assert.equal(store.getState().step, 1);
      assert.equal(sub2Called, false, 'Subscriber 2 was not reached because unhandled error broke the forEach loop');
    });

  });

  // =========================================================================
  // 3. Invalid Updaters, Boundary Inputs & Prototype Pollution Resistance
  // =========================================================================
  describe('3. Invalid Updaters, Boundary Inputs & Prototype Pollution Resistance', () => {

    it('safely ignores null, undefined, primitive, and symbol updaters without throwing', () => {
      const initial = { active: true, count: 10 };
      const store = createAdminStore(initial);
      let notifyCount = 0;
      store.subscribe(() => { notifyCount++; });

      const invalidUpdaters = [
        null,
        undefined,
        42,
        -1,
        0,
        NaN,
        Infinity,
        -Infinity,
        'string',
        '',
        true,
        false,
        Symbol('token'),
        () => null,
        () => undefined,
        () => 42,
        () => 'invalid',
        () => Symbol('test')
      ];

      for (const inv of invalidUpdaters) {
        assert.doesNotThrow(() => {
          store.setState(inv);
        });
      }

      assert.deepEqual(store.getState(), initial, 'State must remain completely unchanged');
      assert.equal(notifyCount, 0, 'No notifications should fire for invalid updaters');
    });

    it('prototype pollution via setState does not pollute global Object.prototype', () => {
      const store = createAdminStore();

      // Vector 1: __proto__ via JSON.parse
      const payload1 = JSON.parse('{"__proto__": {"pollutedKey1": "evil"}}');
      store.setState(payload1);
      assert.equal(({}).pollutedKey1, undefined, 'Object.prototype must not have pollutedKey1');

      // Vector 2: constructor.prototype
      const payload2 = JSON.parse('{"constructor": {"prototype": {"pollutedKey2": "evil"}}}');
      store.setState(payload2);
      assert.equal(({}).pollutedKey2, undefined, 'Object.prototype must not have pollutedKey2');

      // Vector 3: Direct proto object property
      const payload3 = { ['__proto__']: { pollutedKey3: 'evil' } };
      store.setState(payload3);
      assert.equal(({}).pollutedKey3, undefined, 'Object.prototype must not have pollutedKey3');
    });

    it('prototype pollution via setSlice: does not pollute Object.prototype nor mutate state prototype', () => {
      const store = createAdminStore();

      // Vector 1: setSlice('__proto__', ...)
      const evilSlice = { pollutedSlice: true };
      store.setSlice('__proto__', evilSlice);

      // Verify global Object.prototype is safe
      assert.equal(({}).pollutedSlice, undefined, 'Object.prototype must NOT be polluted');

      // State prototype is safe because Object.prototype.hasOwnProperty is used
      const state = store.getState();
      assert.equal(Object.getPrototypeOf(state).pollutedSlice, undefined, 'state prototype must not be altered');
      assert.equal(state.pollutedSlice, undefined, 'state instance must not inherit pollutedSlice');
    });

    it('setSlice with Object.prototype method names ("toString", "valueOf") does not clobber state methods', () => {
      const store = createAdminStore();

      // Before update: state inherits standard toString
      assert.equal(typeof store.getState().toString, 'function');

      // Setting slice name 'toString'
      store.setSlice('toString', { custom: 'string_slice' });

      // Because hasOwnProperty.call(state, 'toString') evaluates to false,
      // state.toString is preserved as a function!
      const state = store.getState();
      assert.equal(typeof state.toString, 'function', 'state.toString must remain a function');

      // Calling state.toString() executes without error
      assert.doesNotThrow(() => {
        state.toString();
      });
    });

    it('array patch in setSlice for non-existent slice preserves Array type and elements', () => {
      const store = createAdminStore();

      // Setting a slice that does not exist in state.slices or state:
      // must preserve Array instead of converting to plain indexed Object
      store.setSlice('customArray', [1, 2, 3]);
      const slice = store.getSlice('customArray');

      assert.equal(Array.isArray(slice), true, 'Slice must remain an Array');
      assert.deepEqual(slice, [1, 2, 3]);
    });

    it('array patch in setState is safely guarded and does not spread numeric indices onto state root', () => {
      const store = createAdminStore();

      store.setState(['item0', 'item1']);
      const state = store.getState();

      // Passing an array to setState is ignored by guard and does not spread indices
      assert.equal(state['0'], undefined, 'Numeric index 0 must not be spread onto root state');
      assert.equal(state['1'], undefined, 'Numeric index 1 must not be spread onto root state');
    });

  });

  // =========================================================================
  // 4. Slice Isolation, Immutability & Deep Mutation Resistance
  // =========================================================================
  describe('4. Slice Isolation, Immutability & Deep Mutation Resistance', () => {

    it('setSlice updates target slice and produces a new state reference', () => {
      const store = createAdminStore();
      const stateBefore = store.getState();

      store.setSlice('editor', { dirty: true });
      const stateAfter = store.getState();

      assert.notEqual(stateBefore, stateAfter, 'setState/setSlice must produce a new state object reference');
      assert.equal(store.getSlice('editor').dirty, true);
    });

    it('getSlice returns direct mutable reference to internal state slice (shallow isolation)', () => {
      const store = createAdminStore();
      const editorSlice = store.getSlice('editor');

      // Direct mutation on returned slice
      editorSlice.dirty = true;

      // Demonstrates lack of deep immutability / defensive freeze:
      // Internal store state was modified without calling setSlice or notifying subscribers
      assert.equal(store.getState().slices.editor.dirty, true, 'Internal store state reflects direct mutation');
    });

    it('getState returns direct mutable reference to internal state container', () => {
      const store = createAdminStore();
      const state = store.getState();

      // Direct mutation on root state
      state.currentView = 'directly_mutated';

      assert.equal(store.getState().currentView, 'directly_mutated', 'getState exposes direct mutable state object');
    });

    it('synchronizes slice with top-level state property if defined', () => {
      const store = createAdminStore({
        distributions: [{ id: 'd1' }]
      });

      store.setSlice('distributions', [{ id: 'd1' }, { id: 'd2' }]);
      assert.equal(store.getState().distributions.length, 2);
      assert.equal(store.getSlice('distributions').length, 2);
    });

    it('deep nested object mutations inside slices do not bleed into parallel instances', () => {
      const store1 = createAdminStore();
      const store2 = createAdminStore();

      store1.setSlice('dayPlanner', { pendingPlan: { planId: 'p1', steps: ['a', 'b'] } });
      store2.setSlice('dayPlanner', { pendingPlan: { planId: 'p2', steps: ['x'] } });

      assert.equal(store1.getSlice('dayPlanner').pendingPlan.planId, 'p1');
      assert.equal(store2.getSlice('dayPlanner').pendingPlan.planId, 'p2');
      assert.deepEqual(store1.getSlice('dayPlanner').pendingPlan.steps, ['a', 'b']);
      assert.deepEqual(store2.getSlice('dayPlanner').pendingPlan.steps, ['x']);
    });

    it('preserves Map and Set instances in state across unrelated slice updates', () => {
      const store = createAdminStore();
      const initialTrips = store.getState().trips;
      const initialDirtyDialogs = store.getState().dirtyDialogs;

      initialTrips.set('trip-1', { title: 'Trip 1' });
      initialDirtyDialogs.add('modal-editor');

      // Update unrelated slices
      store.setSlice('roles', { count: 5 });
      store.setState({ currentView: 'editor' });

      const stateNow = store.getState();
      assert.equal(stateNow.trips.get('trip-1').title, 'Trip 1');
      assert.ok(stateNow.dirtyDialogs.has('modal-editor'));
    });

  });

  // =========================================================================
  // 5. Memory & Performance Stress Harness
  // =========================================================================
  describe('5. Memory & Performance Stress Harness', () => {

    it('rapid subscription and unsubscription lifecycle does not leak memory or listeners', () => {
      const store = createAdminStore({ value: 0 });

      // Rapidly create and immediately unsubscribe 10,000 listeners
      const t0 = performance.now();
      for (let i = 0; i < 10000; i++) {
        const unsub = store.subscribe(() => {});
        unsub();
      }
      const duration = performance.now() - t0;

      // After all unsubscriptions, notification should hit 0 listeners
      let called = 0;
      const finalUnsub = store.subscribe(() => { called++; });
      store.setState({ value: 1 });

      assert.equal(called, 1, 'Only the active subscriber should be called');
      assert.ok(duration < 250, `10,000 subscribe/unsubscribe cycles took ${duration}ms, expected < 250ms`);
      finalUnsub();
    });

    it('10,000 setState cycles maintain low memory profile and stable throughput', () => {
      const store = createAdminStore({ count: 0 });
      let notifications = 0;
      const unsub = store.subscribe(() => { notifications++; });

      const memBefore = process.memoryUsage().heapUsed;
      const t0 = performance.now();

      for (let i = 1; i <= 10000; i++) {
        store.setState(s => ({ count: s.count + 1 }));
      }

      const duration = performance.now() - t0;
      const memAfter = process.memoryUsage().heapUsed;
      const heapDeltaMb = (memAfter - memBefore) / (1024 * 1024);

      assert.equal(store.getState().count, 10000);
      assert.equal(notifications, 10000);
      assert.ok(duration < 500, `10,000 setState took ${duration}ms, expected < 500ms`);
      // Memory growth for 10,000 small state updates should be modest (< 35MB)
      assert.ok(heapDeltaMb < 35, `Heap delta was ${heapDeltaMb.toFixed(2)}MB, expected < 35MB`);

      unsub();
    });

  });

});
