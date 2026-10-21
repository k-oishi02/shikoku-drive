import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTripStore, createInitialTripState } from '../src/trip-store.js';

describe('TripStore Adversarial Challenge & Stress Suite', () => {

  // =========================================================================
  // 1. Prototype Pollution Attempts & Defense
  // =========================================================================
  describe('1. Prototype Pollution Attempts & Defense', () => {

    it('rejects setSlice("__proto__", ...) without mutating Object.prototype or state prototype', () => {
      const store = createTripStore();
      const initialProto = Object.getPrototypeOf(store.getState());

      const res = store.setSlice('__proto__', { polluted: 'evil_proto' });
      assert.equal(res, undefined, 'setSlice("__proto__") must return undefined');

      // Verify global Object prototype is not polluted
      const cleanObj = {};
      assert.equal(cleanObj.polluted, undefined, 'Object.prototype must not be polluted');
      assert.equal(Object.prototype.polluted, undefined, 'Object.prototype.polluted must be undefined');

      // Verify internal state prototype is untouched
      assert.equal(Object.getPrototypeOf(store.getState()), initialProto, 'State prototype must remain unchanged');
      assert.equal(store.getState().polluted, undefined, 'State must not have polluted property');
    });

    it('rejects setSlice("constructor", ...) without clobbering Object.prototype.constructor', () => {
      const store = createTripStore();
      const res = store.setSlice('constructor', { polluted: 'evil_constructor' });
      assert.equal(res, undefined, 'setSlice("constructor") must return undefined');

      const cleanObj = {};
      assert.equal(cleanObj.constructor, Object, 'cleanObj.constructor must remain Object');
      assert.equal(store.getState().constructor, Object, 'store.getState().constructor must remain Object');
    });

    it('rejects setSlice("prototype", ...) without side effects', () => {
      const store = createTripStore();
      const res = store.setSlice('prototype', { polluted: 'evil_prototype' });
      assert.equal(res, undefined, 'setSlice("prototype") must return undefined');
      assert.equal(store.getState().prototype, undefined);
    });

    it('returns undefined for getSlice with prototype pollution keys', () => {
      const store = createTripStore();
      assert.equal(store.getSlice('__proto__'), undefined);
      assert.equal(store.getSlice('constructor'), undefined);
      assert.equal(store.getSlice('prototype'), undefined);
    });

    it('strips __proto__, constructor, and prototype from setState payloads', () => {
      const store = createTripStore();
      let notified = 0;
      store.subscribe(() => { notified++; });

      const maliciousPayload = JSON.parse('{"__proto__": {"hacked": true}, "constructor": {"hacked": true}, "prototype": {"hacked": true}, "weather": {"valid": true}}');
      store.setState(maliciousPayload);

      assert.equal(notified, 1, 'Valid keys in patch must still trigger subscriber');
      assert.equal({}.hacked, undefined, 'Global prototype must not be polluted');
      assert.equal(Object.prototype.hacked, undefined);
      assert.equal(store.getState().hacked, undefined);
      assert.equal(store.getState().weather.valid, true, 'Legitimate properties must be applied');
    });

    it('safely handles deeply nested objects with prototype pollution keys in slice updaters', () => {
      const store = createTripStore();
      const nestedPayload = JSON.parse('{"tokyo": {"temp": "18C", "__proto__": {"deepPolluted": true}}}');

      store.setSlice('weather', nestedPayload);
      assert.equal({}.deepPolluted, undefined, 'Global Object must not receive deepPolluted');
      assert.equal(store.getSlice('weather').tokyo.temp, '18C');
    });
  });

  // =========================================================================
  // 2. Method Clobbering Resistance via setSlice & getSlice
  // =========================================================================
  describe('2. Method Clobbering Resistance via setSlice & getSlice', () => {

    it('setSlice("toString", ...) does not clobber state.toString method', () => {
      const store = createTripStore();
      const beforeState = store.getState();
      assert.equal(typeof beforeState.toString, 'function');
      assert.equal(beforeState.toString(), '[object Object]');

      const res = store.setSlice('toString', { customFormat: 'custom-val' });
      assert.deepEqual(res, { customFormat: 'custom-val' });

      const afterState = store.getState();
      // Crucial assertion: state.toString must remain the standard function
      assert.equal(typeof afterState.toString, 'function', 'state.toString must remain a callable function');
      assert.equal(afterState.toString(), '[object Object]', 'state.toString() must execute without throwing');

      // The slice itself is accessible through getSlice
      assert.deepEqual(store.getSlice('toString'), { customFormat: 'custom-val' });
    });

    it('setSlice("valueOf", ...) does not clobber state.valueOf method', () => {
      const store = createTripStore();
      const beforeState = store.getState();
      assert.equal(typeof beforeState.valueOf, 'function');
      assert.equal(beforeState.valueOf(), beforeState);

      const res = store.setSlice('valueOf', { num: 42 });
      assert.deepEqual(res, { num: 42 });

      const afterState = store.getState();
      assert.equal(typeof afterState.valueOf, 'function', 'state.valueOf must remain a callable function');
      assert.equal(afterState.valueOf(), afterState, 'state.valueOf() must execute without throwing');
      assert.deepEqual(store.getSlice('valueOf'), { num: 42 });
    });

    it('getSlice returns undefined for unpopulated Object.prototype methods', () => {
      const store = createTripStore();
      assert.equal(store.getSlice('toString'), undefined, 'getSlice("toString") must not return Object.prototype.toString');
      assert.equal(store.getSlice('valueOf'), undefined, 'getSlice("valueOf") must not return Object.prototype.valueOf');
      assert.equal(store.getSlice('hasOwnProperty'), undefined, 'getSlice("hasOwnProperty") must return undefined');
      assert.equal(store.getSlice('isPrototypeOf'), undefined, 'getSlice("isPrototypeOf") must return undefined');
      assert.equal(store.getSlice('propertyIsEnumerable'), undefined, 'getSlice("propertyIsEnumerable") must return undefined');
    });
  });

  // =========================================================================
  // 3. Array Slice Handling & Prototype Method Preservation
  // =========================================================================
  describe('3. Array Slice Handling & Prototype Method Preservation', () => {

    it('store.setSlice("portalTrips", [...]) retains Array.isArray() === true and array prototype methods', () => {
      const store = createTripStore();

      const trips = ['trip-1', 'trip-2'];
      const returnedSlice = store.setSlice('portalTrips', trips);

      // Verify return value
      assert.equal(Array.isArray(returnedSlice), true, 'Returned slice must be true Array');
      assert.equal(returnedSlice.length, 2);

      // Verify getSlice
      const retrievedSlice = store.getSlice('portalTrips');
      assert.equal(Array.isArray(retrievedSlice), true, 'getSlice("portalTrips") must be true Array');
      assert.equal(retrievedSlice.length, 2);
      assert.equal(retrievedSlice[0], 'trip-1');
      assert.equal(retrievedSlice[1], 'trip-2');

      // Verify getState().portalTrips
      const stateTrips = store.getState().portalTrips;
      assert.equal(Array.isArray(stateTrips), true, 'store.getState().portalTrips must be true Array');
      assert.equal(stateTrips.length, 2);

      // Verify array prototype methods work seamlessly
      assert.equal(typeof retrievedSlice.push, 'function');
      assert.equal(typeof retrievedSlice.map, 'function');
      assert.equal(typeof retrievedSlice.filter, 'function');
      assert.equal(typeof retrievedSlice.reduce, 'function');
      assert.equal(typeof retrievedSlice.slice, 'function');
      assert.equal(typeof retrievedSlice.some, 'function');
      assert.equal(typeof retrievedSlice.every, 'function');
      assert.equal(typeof retrievedSlice.includes, 'function');
      assert.equal(typeof retrievedSlice.join, 'function');

      // Test execution of array prototype methods
      const mapped = retrievedSlice.map(t => t.toUpperCase());
      assert.deepEqual(mapped, ['TRIP-1', 'TRIP-2']);

      const filtered = retrievedSlice.filter(t => t.endsWith('2'));
      assert.deepEqual(filtered, ['trip-2']);

      const joined = retrievedSlice.join(', ');
      assert.equal(joined, 'trip-1, trip-2');

      retrievedSlice.push('trip-3');
      assert.equal(retrievedSlice.length, 3);
    });

    it('preserves array prototype on dynamic non-default slices', () => {
      const store = createTripStore();
      const customArray = [{ id: 'badge-1' }, { id: 'badge-2' }];

      const res = store.setSlice('customBadges', customArray);
      assert.equal(Array.isArray(res), true);

      const retrieved = store.getSlice('customBadges');
      assert.equal(Array.isArray(retrieved), true);
      assert.equal(retrieved.length, 2);
      assert.equal(retrieved.map(b => b.id).join('-'), 'badge-1-badge-2');
    });

    it('functional updater returning array preserves Array instance', () => {
      const store = createTripStore();
      store.setSlice('checklist', ['チケット購入']);

      store.setSlice('checklist', (prev) => [...prev, 'パッキング', 'モバイルバッテリー']);

      const checklist = store.getSlice('checklist');
      assert.equal(Array.isArray(checklist), true);
      assert.equal(checklist.length, 3);
      assert.deepEqual(checklist, ['チケット購入', 'パッキング', 'モバイルバッテリー']);
    });

    it('store.setState({ portalTrips: [...] }) preserves Array in state root and slices', () => {
      const store = createTripStore();
      store.setState({ portalTrips: ['trip-alpha', 'trip-beta'] });

      assert.equal(Array.isArray(store.getState().portalTrips), true);
      assert.equal(Array.isArray(store.getSlice('portalTrips')), true);
      assert.deepEqual(store.getSlice('portalTrips'), ['trip-alpha', 'trip-beta']);
    });
  });

  // =========================================================================
  // 4. store.setState(['a', 'b']) Guard & Malformed State Payloads
  // =========================================================================
  describe('4. store.setState(["a", "b"]) Guard & Malformed State Payloads', () => {

    it('does not spread numeric keys onto state root when passed an Array', () => {
      const store = createTripStore();
      const beforeState = store.getState();
      let notifyCount = 0;
      store.subscribe(() => { notifyCount++; });

      store.setState(['a', 'b']);

      assert.equal(notifyCount, 0, 'Array patch must be rejected without notifying subscribers');

      const afterState = store.getState();
      assert.equal(afterState[0], undefined, 'Numeric index 0 must not exist on state');
      assert.equal(afterState['0'], undefined, 'Key "0" must not exist on state');
      assert.equal(afterState[1], undefined, 'Numeric index 1 must not exist on state');
      assert.equal(afterState['1'], undefined, 'Key "1" must not exist on state');
      assert.equal('0' in afterState, false, '"0" in state must be false');
      assert.equal('1' in afterState, false, '"1" in state must be false');

      assert.deepEqual(afterState, beforeState, 'State must remain completely unchanged');
    });

    it('functional updater returning an Array is rejected without spreading numeric keys', () => {
      const store = createTripStore();
      let notifyCount = 0;
      store.subscribe(() => { notifyCount++; });

      store.setState(() => ['alpha', 'beta', 'gamma']);

      assert.equal(notifyCount, 0);
      assert.equal(store.getState()[0], undefined);
      assert.equal('0' in store.getState(), false);
    });

    it('safely rejects primitives, null, undefined, and symbols without throwing or mutating', () => {
      const store = createTripStore();
      const beforeState = store.getState();
      let notifyCount = 0;
      store.subscribe(() => { notifyCount++; });

      const invalidPatches = [
        null,
        undefined,
        12345,
        -99.9,
        NaN,
        Infinity,
        'string-payload',
        true,
        false,
        Symbol('adversarial-symbol'),
        () => null,
        () => undefined,
        () => 'invalid-from-fn',
        () => 999
      ];

      for (const patch of invalidPatches) {
        store.setState(patch);
      }

      assert.equal(notifyCount, 0, 'Invalid patches must not notify subscribers');
      assert.deepEqual(store.getState(), beforeState, 'State must remain identical');
    });
  });

  // =========================================================================
  // 5. High-Throughput Concurrency & Stress Harness
  // =========================================================================
  describe('5. High-Throughput Concurrency & Stress Harness', () => {

    it('handles 1,500 rapid sequential mutations across multiple slices with high throughput', () => {
      const store = createTripStore();
      let notifyCount = 0;
      store.subscribe(() => { notifyCount++; });

      const slices = ['weather', 'checklist', 'expenses', 'portalTrips', 'syncState'];

      const start = performance.now();
      for (let i = 0; i < 1500; i++) {
        const slice = slices[i % slices.length];
        if (slice === 'portalTrips' || slice === 'checklist') {
          store.setSlice(slice, [`item-${i}`]);
        } else if (slice === 'expenses') {
          store.setSlice(slice, [{ id: `exp-${i}`, amount: i * 10 }]);
        } else if (slice === 'syncState') {
          store.setSlice(slice, { mode: 'syncing', seq: i });
        } else {
          store.setSlice(slice, { [`loc-${i % 10}`]: { temp: `${20 + (i % 5)}C` } });
        }
      }
      const duration = performance.now() - start;

      assert.equal(notifyCount, 1500, 'Subscribers must receive exactly 1,500 notifications');
      assert.ok(duration < 350, `1,500 updates completed in ${duration}ms, expected < 350ms`);

      // Verify final slice values
      const portalTrips = store.getSlice('portalTrips');
      assert.equal(Array.isArray(portalTrips), true);
      assert.equal(portalTrips[0], 'item-1498');

      const syncState = store.getSlice('syncState');
      assert.equal(syncState.seq, 1499);
    });

    it('handles 1,000 asynchronous concurrent mutations via Promise.all without state corruption', async () => {
      const store = createTripStore({ counter: 0 });
      let notifyCount = 0;
      store.subscribe(() => { notifyCount++; });

      const tasks = Array.from({ length: 1000 }, (_, i) => {
        return new Promise(resolve => {
          // Stagger slightly with microtask and setImmediate simulation
          queueMicrotask(() => {
            store.setState(prev => ({ counter: (prev.counter || 0) + 1 }));
            store.setSlice('portalTrips', prev => [...(Array.isArray(prev) ? prev : []), `async-trip-${i}`]);
            resolve(i);
          });
        });
      });

      const start = performance.now();
      await Promise.all(tasks);
      const duration = performance.now() - start;

      assert.ok(duration < 500, `1,000 async updates took ${duration}ms, expected < 500ms`);
      assert.equal(store.getState().counter, 1000, 'Counter must reach exactly 1,000');
      const portalTrips = store.getSlice('portalTrips');
      assert.equal(Array.isArray(portalTrips), true);
      assert.equal(portalTrips.length, 1000, 'portalTrips must accumulate 1,000 items');
    });

    it('handles heavy subscriber churn: 1,000 subscribers with rapid add/remove cycles', () => {
      const store = createTripStore();
      const unsubs = [];
      let totalCalls = 0;

      // Add 1,000 subscribers
      for (let i = 0; i < 1000; i++) {
        const unsub = store.subscribe(() => {
          totalCalls++;
        });
        unsubs.push(unsub);
      }

      // First dispatch: all 1,000 called
      store.setSlice('syncState', { status: 'wave1' });
      assert.equal(totalCalls, 1000);

      // Unsubscribe odd numbered subscribers
      for (let i = 1; i < 1000; i += 2) {
        unsubs[i]();
      }

      // Second dispatch: remaining 500 called
      store.setSlice('syncState', { status: 'wave2' });
      assert.equal(totalCalls, 1500);

      // Unsubscribe remaining even numbered subscribers
      for (let i = 0; i < 1000; i += 2) {
        unsubs[i]();
      }

      // Third dispatch: 0 called
      store.setSlice('syncState', { status: 'wave3' });
      assert.equal(totalCalls, 1500, 'No more notifications should occur after total unsubscription');
    });

    it('supports subscriber self-unsubscribing inside its own callback cleanly', () => {
      const store = createTripStore();
      let callCount = 0;

      let unsub;
      unsub = store.subscribe(() => {
        callCount++;
        unsub(); // Self-unsubscribe on first notification
      });

      store.setSlice('syncState', { count: 1 });
      store.setSlice('syncState', { count: 2 });
      store.setSlice('syncState', { count: 3 });

      assert.equal(callCount, 1, 'Self-unsubscribing listener must only be called once');
    });

    it('supports subscriber unsubscribing a subsequent listener during notification iteration', () => {
      const store = createTripStore();
      let listener1Calls = 0;
      let listener2Calls = 0;

      let unsub2;
      store.subscribe(() => {
        listener1Calls++;
        if (unsub2) {
          unsub2(); // Cancel listener 2 before its turn
        }
      });

      unsub2 = store.subscribe(() => {
        listener2Calls++;
      });

      store.setSlice('syncState', { tick: 1 });

      assert.equal(listener1Calls, 1);
      // In JS Set iteration, if a member is deleted before it is visited, it is not visited
      assert.equal(listener2Calls, 0, 'Listener 2 should have been cancelled before iteration');
    });
  });

  // =========================================================================
  // 6. Boundary Inputs, Non-String Slices & Error Resilience
  // =========================================================================
  describe('6. Boundary Inputs, Non-String Slices & Error Resilience', () => {

    it('safely handles non-string slice names in getSlice and setSlice', () => {
      const store = createTripStore();

      const invalidNames = [
        null,
        undefined,
        123,
        0,
        -1,
        true,
        false,
        {},
        [],
        Symbol('sliceName')
      ];

      for (const name of invalidNames) {
        assert.equal(store.getSlice(name), undefined, `getSlice(${String(name)}) must return undefined`);
        assert.equal(store.setSlice(name, 'test-val'), undefined, `setSlice(${String(name)}) must return undefined`);
      }
    });

    it('throws TypeError when subscribe is called with non-function arguments', () => {
      const store = createTripStore();
      const invalidListeners = [null, undefined, 123, 'not a fn', {}, []];

      for (const arg of invalidListeners) {
        assert.throws(() => {
          store.subscribe(arg);
        }, TypeError, 'subscribe with non-function must throw TypeError');
      }
    });

    it('preserves state integrity when setState updater function throws an exception', () => {
      const store = createTripStore({ activeTrip: { tripId: 'trip-secure' } });
      const beforeState = store.getState();

      assert.throws(() => {
        store.setState(() => {
          throw new Error('Updater exploded');
        });
      }, /Updater exploded/);

      assert.deepEqual(store.getState(), beforeState, 'State must remain intact after updater throw');
    });

    it('preserves state integrity when setSlice updater function throws an exception', () => {
      const store = createTripStore();
      store.setSlice('weather', { oarai: { temp: '20C' } });
      const beforeWeather = store.getSlice('weather');

      assert.throws(() => {
        store.setSlice('weather', () => {
          throw new Error('Slice updater exploded');
        });
      }, /Slice updater exploded/);

      assert.deepEqual(store.getSlice('weather'), beforeWeather, 'Slice must remain intact after throw');
    });

    it('handles primitive values in setSlice cleanly', () => {
      const store = createTripStore();

      assert.equal(store.setSlice('primitiveStr', 'hello'), 'hello');
      assert.equal(store.getSlice('primitiveStr'), 'hello');

      assert.equal(store.setSlice('primitiveNum', 42), 42);
      assert.equal(store.getSlice('primitiveNum'), 42);

      assert.equal(store.setSlice('primitiveBool', false), false);
      assert.equal(store.getSlice('primitiveBool'), false);

      assert.equal(store.setSlice('primitiveNull', null), null);
      assert.equal(store.getSlice('primitiveNull'), null);
    });

    it('custom initialState without slices container automatically initializes default slices', () => {
      const customInitial = {
        activeTrip: { tripId: 'init-trip', title: 'Custom Init' },
        portalTrips: ['init-portal']
      };

      const store = createTripStore(customInitial);
      assert.ok(store.getState().slices, 'slices container must be initialized');
      assert.deepEqual(store.getSlice('portalTrips'), ['init-portal']);
      assert.equal(store.getSlice('activeTrip').tripId, 'init-trip');
    });

    it('window bridge handles malformed trip members without crashing', () => {
      const originalWindow = globalThis.window;
      globalThis.window = {};

      try {
        const store = createTripStore();

        // Malformed members (string instead of array)
        store.setState({
          activeTrip: { tripId: 'bad-members', members: 'not-an-array' }
        });
        assert.deepEqual(globalThis.window.currentTripMembers, [], 'Malformed members must fallback to empty array');

        // Missing subtitle and title
        store.setState({
          activeTrip: { tripId: 'no-title' }
        });
        assert.equal(globalThis.window.currentTripTitle, '旅行', 'Missing title must fallback to default string');
      } finally {
        if (originalWindow !== undefined) {
          globalThis.window = originalWindow;
        } else {
          delete globalThis.window;
        }
      }
    });
  });
});
