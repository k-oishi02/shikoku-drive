import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminStore, createInitialAdminState } from '../src/admin-store.js';

describe('Milestone 2 Re-Gating Adversarial Challenge Suite', () => {

  // =========================================================================
  // Vector 1: Prototype Pollution via setSlice and setState
  // =========================================================================
  describe('Vector 1: Prototype Pollution Attacks', () => {

    it('setSlice("__proto__", ...) does not pollute Object.prototype nor corrupt state prototype', () => {
      const store = createAdminStore();
      const evilPayload = {
        pollutedAdmin: true,
        superUser: true,
        pwned: 'yes'
      };

      store.setSlice('__proto__', evilPayload);

      // 1. Check global Object.prototype
      assert.equal(({}).pollutedAdmin, undefined, 'Object.prototype.pollutedAdmin must be undefined');
      assert.equal(({}).superUser, undefined, 'Object.prototype.superUser must be undefined');
      assert.equal(({}).pwned, undefined, 'Object.prototype.pwned must be undefined');

      // 2. Check newly instantiated object
      const freshObj = new Object();
      assert.equal(freshObj.pollutedAdmin, undefined, 'fresh object must not inherit pollutedAdmin');

      // 3. Check store state instance
      const state = store.getState();
      assert.equal(Object.getPrototypeOf(state), Object.prototype, 'state prototype must strictly be Object.prototype');
      assert.equal(state.pollutedAdmin, undefined, 'state root must not have pollutedAdmin');
      assert.equal(state.superUser, undefined, 'state root must not have superUser');
      assert.equal(state.pwned, undefined, 'state root must not have pwned');

      // 4. Verify state methods still function
      assert.equal(typeof state.hasOwnProperty, 'function');
      assert.equal(state.hasOwnProperty('slices'), true);
    });

    it('setSlice("constructor", ...) does not alter Object.prototype.constructor or pollute state', () => {
      const store = createAdminStore();
      const evilConstructor = {
        prototype: {
          pollutedMethod: () => 'evil'
        }
      };

      store.setSlice('constructor', evilConstructor);

      // Verify Object constructor integrity
      assert.equal(Object.prototype.constructor, Object, 'Object.prototype.constructor must remain native Object');
      assert.equal(({}).pollutedMethod, undefined, 'Object.prototype must not inherit pollutedMethod');

      const state = store.getState();
      assert.equal(state.constructor, Object, 'state.constructor must resolve to Object');
      assert.equal(typeof state.constructor, 'function');
      assert.equal(state.pollutedMethod, undefined);
    });

    it('nested prototype pollution payloads via JSON.parse cannot escape store isolation', () => {
      const store = createAdminStore();
      const evilJsonPayload = JSON.parse('{"__proto__":{"isAdmin":true,"role":"superadmin"}}');

      // Challenge via setState
      store.setState(evilJsonPayload);
      assert.equal(({}).isAdmin, undefined, 'Object.prototype.isAdmin must remain undefined');
      assert.equal(({}).role, undefined, 'Object.prototype.role must remain undefined');

      // Challenge via setSlice
      store.setSlice('security', evilJsonPayload);
      assert.equal(({}).isAdmin, undefined, 'Object.prototype must not be polluted via setSlice');
      assert.equal(store.getState().isAdmin, undefined, 'state root must not acquire isAdmin via prototype');
    });

  });

  // =========================================================================
  // Vector 2: Method Clobbering Attacks
  // =========================================================================
  describe('Vector 2: Object Method Clobbering Attacks', () => {

    it('setSlice with "toString" does not clobber state.toString', () => {
      const store = createAdminStore();
      assert.equal(typeof store.getState().toString, 'function');

      // Attack: overwrite toString with an object slice
      store.setSlice('toString', { clobbered: true, value: 'attack' });

      const state = store.getState();
      assert.equal(typeof state.toString, 'function', 'state.toString must remain a callable function');
      assert.doesNotThrow(() => {
        const repr = state.toString();
        assert.equal(repr, '[object Object]', 'state.toString() must return standard Object representation');
      });

      // Slice itself is accessible in slices container without breaking state root
      const slice = store.getSlice('toString');
      assert.deepEqual(slice, { clobbered: true, value: 'attack' });
    });

    it('setSlice with "valueOf" does not clobber state.valueOf', () => {
      const store = createAdminStore();
      assert.equal(typeof store.getState().valueOf, 'function');

      store.setSlice('valueOf', { clobbered: true });

      const state = store.getState();
      assert.equal(typeof state.valueOf, 'function', 'state.valueOf must remain a callable function');
      assert.doesNotThrow(() => {
        const val = state.valueOf();
        assert.equal(typeof val, 'object', 'state.valueOf() must return state object');
      });
      assert.deepEqual(store.getSlice('valueOf'), { clobbered: true });
    });

    it('setSlice with all common Object.prototype methods preserves callable methods on state', () => {
      const store = createAdminStore();
      const protoMethods = [
        'hasOwnProperty',
        'isPrototypeOf',
        'propertyIsEnumerable',
        'toLocaleString'
      ];

      for (const method of protoMethods) {
        assert.equal(typeof store.getState()[method], 'function', `Initial ${method} must be function`);
        store.setSlice(method, { fakeMethod: method });

        const state = store.getState();
        assert.equal(typeof state[method], 'function', `state.${method} must remain a function after setSlice`);
        assert.deepEqual(store.getSlice(method), { fakeMethod: method });
      }

      // Test that state.hasOwnProperty still executes correctly
      assert.equal(store.getState().hasOwnProperty('currentView'), true);
      assert.equal(store.getState().hasOwnProperty('nonExistentKey123'), false);
    });

  });

  // =========================================================================
  // Vector 3: Array Slice Handling & Preservation
  // =========================================================================
  describe('Vector 3: Array Slice Handling & Preservation', () => {

    it('store.setSlice("tags", ["a", "b"]) retains Array.isArray() === true and array prototype methods', () => {
      const store = createAdminStore();
      const initialTags = ['alpha', 'beta'];

      // Set array slice
      store.setSlice('tags', initialTags);

      const retrievedSlice = store.getSlice('tags');
      const stateSlice = store.getState().slices.tags;

      // 1. Array.isArray assertions
      assert.equal(Array.isArray(retrievedSlice), true, 'store.getSlice("tags") must be an Array');
      assert.equal(Array.isArray(stateSlice), true, 'store.getState().slices.tags must be an Array');
      assert.equal(retrievedSlice.length, 2);
      assert.equal(retrievedSlice[0], 'alpha');
      assert.equal(retrievedSlice[1], 'beta');

      // 2. Array prototype methods: push, pop, shift, unshift
      const copyForPush = [...retrievedSlice];
      copyForPush.push('gamma');
      assert.equal(copyForPush.length, 3);
      assert.equal(copyForPush[2], 'gamma');

      // 3. Functional array methods: map, filter, reduce, slice, includes, indexOf
      assert.deepEqual(retrievedSlice.map(x => x.toUpperCase()), ['ALPHA', 'BETA']);
      assert.deepEqual(retrievedSlice.filter(x => x.startsWith('a')), ['alpha']);
      assert.equal(retrievedSlice.reduce((acc, x) => acc + ',' + x, ''), ',alpha,beta');
      assert.deepEqual(retrievedSlice.slice(1), ['beta']);
      assert.equal(retrievedSlice.includes('beta'), true);
      assert.equal(retrievedSlice.includes('delta'), false);
      assert.equal(retrievedSlice.indexOf('alpha'), 0);
      assert.equal(retrievedSlice.indexOf('delta'), -1);

      // Verify no plain-object spread pollution (e.g. key '0' as enumerable own prop on a plain object)
      assert.equal(Object.prototype.toString.call(retrievedSlice), '[object Array]');
    });

    it('consecutive setSlice operations on array slices preserve Array type', () => {
      const store = createAdminStore();

      // Step 1: Initial array
      store.setSlice('categories', ['gourmet', 'sightseeing']);
      assert.ok(Array.isArray(store.getSlice('categories')));

      // Step 2: Overwrite with new array
      store.setSlice('categories', ['hotel', 'transport']);
      const s2 = store.getSlice('categories');
      assert.ok(Array.isArray(s2));
      assert.deepEqual(s2, ['hotel', 'transport']);

      // Step 3: Functional updater appending to array
      store.setSlice('categories', prev => [...prev, 'other']);
      const s3 = store.getSlice('categories');
      assert.ok(Array.isArray(s3));
      assert.deepEqual(s3, ['hotel', 'transport', 'other']);

      // Step 4: Empty array
      store.setSlice('categories', []);
      const s4 = store.getSlice('categories');
      assert.ok(Array.isArray(s4));
      assert.equal(s4.length, 0);
    });

    it('top-level array slices (e.g. distributions) synchronize both root and slice as Arrays', () => {
      const store = createAdminStore();
      const distPayload = [
        { id: 'dist-101', name: 'Tokyo Trip Distribution', members: ['u1', 'u2'] },
        { id: 'dist-102', name: 'Kyoto Trip Distribution', members: ['u3'] }
      ];

      store.setSlice('distributions', distPayload);

      const rootDist = store.getState().distributions;
      const sliceDist = store.getSlice('distributions');

      assert.ok(Array.isArray(rootDist), 'Root state.distributions must be an Array');
      assert.ok(Array.isArray(sliceDist), 'store.getSlice("distributions") must be an Array');
      assert.equal(rootDist.length, 2);
      assert.equal(sliceDist.length, 2);
      assert.equal(rootDist[0].id, 'dist-101');
      assert.equal(sliceDist[1].id, 'dist-102');
    });

  });

  // =========================================================================
  // Vector 4: Non-Object and Array setState Protection
  // =========================================================================
  describe('Vector 4: Root setState Non-Object & Array Protection', () => {

    it('store.setState(["a", "b"]) does not spread numeric keys onto state root', () => {
      const store = createAdminStore();
      const stateBefore = { ...store.getState() };
      let notifications = 0;
      store.subscribe(() => { notifications++; });

      // Adversarial attack: pass an array to setState
      store.setState(['a', 'b', 'c']);

      const stateAfter = store.getState();

      // 1. Verify numeric keys are NOT added to state root
      assert.equal(stateAfter['0'], undefined, 'Numeric index 0 must not exist on state');
      assert.equal(stateAfter['1'], undefined, 'Numeric index 1 must not exist on state');
      assert.equal(stateAfter['2'], undefined, 'Numeric index 2 must not exist on state');
      assert.equal(stateAfter.length, undefined, 'Array length property must not exist on state');

      // 2. Verify state root properties are unmodified
      assert.equal(stateAfter.currentView, stateBefore.currentView);
      assert.equal(stateAfter.tripWriteBusy, stateBefore.tripWriteBusy);
      assert.equal(stateAfter.editorInputRevision, stateBefore.editorInputRevision);

      // 3. Verify subscribers were not notified for invalid patch
      assert.equal(notifications, 0, 'No notification should fire when array passed to setState');
    });

    it('store.setState rejects primitive, nullish, and array updaters cleanly', () => {
      const store = createAdminStore({ baselineKey: 'safe' });
      let notif = 0;
      store.subscribe(() => { notif++; });

      const invalidPatches = [
        ['arr1', 'arr2'],
        null,
        undefined,
        42,
        0,
        -100,
        3.14159,
        NaN,
        Infinity,
        -Infinity,
        'malicious string patch',
        '',
        true,
        false,
        Symbol('patchToken'),
        () => ['functional', 'array', 'updater'],
        () => null,
        () => undefined,
        () => 999
      ];

      for (const patch of invalidPatches) {
        assert.doesNotThrow(() => {
          store.setState(patch);
        });
        assert.equal(store.getState()['0'], undefined);
        assert.equal(store.getState().baselineKey, 'safe');
      }

      assert.equal(notif, 0, 'Subscribers must not be notified for any invalid patch');
    });

    it('empirically documents TypedArray behavior: ArrayBuffer.isView is not guarded by Array.isArray', () => {
      const store = createAdminStore();
      // In ECMAScript, Array.isArray(new Int32Array(...)) === false.
      // Therefore, passing a TypedArray passes (!Array.isArray) guard and spreads indexed elements.
      assert.equal(Array.isArray(new Int32Array([10, 20])), false);
      store.setState(new Int32Array([10, 20]));
      // Documents exact empirical behavior:
      assert.equal(store.getState()['0'], 10);
      assert.equal(store.getState()['1'], 20);
    });

  });

  // =========================================================================
  // Vector 5: High-Throughput Concurrency & Stress Harness
  // =========================================================================
  describe('Vector 5: High-Throughput Concurrency & Stress Harness', () => {

    it('1,000+ rapid mutations across slices maintain strict data integrity', () => {
      const store = createAdminStore();
      const slices = ['overview', 'editor', 'candidateShelf', 'dayPlanner', 'distribution', 'roles', 'discussion'];
      const totalMutations = 2100; // 300 per slice

      const start = performance.now();
      for (let i = 0; i < totalMutations; i++) {
        const sliceName = slices[i % slices.length];
        store.setSlice(sliceName, prev => ({
          ...prev,
          mutationIndex: i,
          lastUpdated: 1000000 + i
        }));
      }
      const duration = performance.now() - start;

      // Assert each slice has its expected state
      for (let sIdx = 0; sIdx < slices.length; sIdx++) {
        const sliceName = slices[sIdx];
        const slice = store.getSlice(sliceName);
        assert.ok(slice != null, `Slice ${sliceName} must exist`);
        assert.ok(typeof slice.mutationIndex === 'number');
        assert.ok(typeof slice.lastUpdated === 'number');
        // The last mutation index for slice sIdx should be:
        // totalMutations - slices.length + sIdx (when totalMutations is multiple of slices.length)
        const expectedIndex = totalMutations - slices.length + sIdx;
        assert.equal(slice.mutationIndex, expectedIndex, `Slice ${sliceName} mutation index mismatch`);
      }

      assert.ok(duration < 500, `2,100 slice mutations took ${duration.toFixed(2)}ms, expected < 500ms`);
    });

    it('rapid subscription add/remove cycles during heavy mutation churn without leaks or errors', () => {
      const store = createAdminStore({ counter: 0 });
      let totalSubscriberCalls = 0;

      const t0 = performance.now();

      // Concurrently add listeners, perform updates, remove listeners
      for (let i = 0; i < 1000; i++) {
        // Subscribe a temporary listener
        const unsub = store.subscribe((s) => {
          totalSubscriberCalls += s.counter;
        });

        // Trigger mutation
        store.setState(s => ({ counter: s.counter + 1 }));

        // Unsubscribe immediately
        unsub();

        // Trigger another mutation that should NOT be received by unsubscribed listener
        store.setState(s => ({ counter: s.counter + 1 }));
      }

      const duration = performance.now() - t0;

      assert.equal(store.getState().counter, 2000, 'Total counter should reach 2,000');
      // Each subscriber was active for exactly 1 odd update: 1, 3, 5, ..., 1999
      // Sum of odd numbers 1 to 2n-1 = n^2. Here n = 1000, so sum = 1,000,000
      assert.equal(totalSubscriberCalls, 1000000, 'Total subscriber calls must match theoretical sum');
      assert.ok(duration < 400, `1,000 add/mutate/remove cycles took ${duration.toFixed(2)}ms, expected < 400ms`);

      // Post-stress: verify store has zero lingering subscribers
      let lingeringCalls = 0;
      store.subscribe(() => { lingeringCalls++; });
      store.setState({ counter: 9999 });
      assert.equal(lingeringCalls, 1, 'Only newly added subscriber should fire');
    });

    it('handles 1,000 asynchronous concurrent mutations with Promise.all and microtask interleaving', async () => {
      const store = createAdminStore({ count: 0, ops: [] });

      const asyncOps = Array.from({ length: 1000 }, (_, idx) => async () => {
        if (idx % 3 === 0) {
          await new Promise(resolve => queueMicrotask(resolve));
        } else if (idx % 3 === 1) {
          await Promise.resolve();
        }
        store.setState(prev => ({
          count: prev.count + 1
        }));
      });

      const t0 = performance.now();
      await Promise.all(asyncOps.map(fn => fn()));
      const duration = performance.now() - t0;

      assert.equal(store.getState().count, 1000, 'All 1,000 concurrent async mutations must complete');
      assert.ok(duration < 250, `1,000 async updates took ${duration.toFixed(2)}ms, expected < 250ms`);
    });

  });

  // =========================================================================
  // Vector 6: Boundary Inputs and Fallback Semantics
  // =========================================================================
  describe('Vector 6: Boundary Inputs and Fallback Semantics', () => {

    it('getSlice with unknown, empty, or non-existent slice returns undefined gracefully', () => {
      const store = createAdminStore();

      assert.equal(store.getSlice('completelyNonExistentSlice'), undefined);
      assert.equal(store.getSlice(''), undefined);
      assert.equal(store.getSlice('__non_existent__'), undefined);
    });

    it('setSlice creates new slice dynamically if not pre-defined', () => {
      const store = createAdminStore();

      store.setSlice('dynamicNewSlice', { key: 'value1' });
      assert.deepEqual(store.getSlice('dynamicNewSlice'), { key: 'value1' });

      // Functional updater on newly created slice
      store.setSlice('dynamicNewSlice', prev => ({ ...prev, key2: 'value2' }));
      assert.deepEqual(store.getSlice('dynamicNewSlice'), { key: 'value1', key2: 'value2' });
    });

    it('getState returns shallow state object without mutating previous snapshot references', () => {
      const store = createAdminStore({ counter: 1 });
      const snap1 = store.getState();

      store.setState({ counter: 2 });
      const snap2 = store.getState();

      assert.notEqual(snap1, snap2, 'getState references must differ across state mutations');
      assert.equal(snap1.counter, 1, 'Previous snapshot reference must retain old value');
      assert.equal(snap2.counter, 2, 'New snapshot reference must reflect updated value');
    });

  });

});
