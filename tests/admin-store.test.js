import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminStore, createInitialAdminState } from '../src/admin-store.js';

describe('AdminStore Suite', () => {

  describe('1. Initialization and Default State', () => {
    test('initializes with comprehensive default state when no argument provided', () => {
      const store = createAdminStore();
      const state = store.getState();
      assert.equal(state.currentView, 'overview');
      assert.equal(state.tripWriteBusy, false);
      assert.ok(state.dirtyDialogs instanceof Set);
      assert.equal(state.dirtyDialogs.size, 0);
      assert.ok(state.trips instanceof Map);
      assert.ok(state.publishedIds instanceof Set);
      assert.ok(state.publishedTrips instanceof Map);
      assert.equal(state.activeTrip, null);
      assert.equal(state.activePlanning, null);
      assert.equal(state.activeDayKey, '');
      assert.equal(state.candidateFilterStatus, 'all');
      assert.equal(state.candidateFilterCategory, 'all');
      assert.deepEqual(state.distributions, []);
      assert.ok(state.slices);
    });

    test('accepts custom initial state overrides', () => {
      const customInitial = {
        currentView: 'editor',
        activeTrip: { tripId: 'trip-custom-1', title: 'テスト旅行' },
        counter: 42
      };
      const store = createAdminStore(customInitial);
      assert.equal(store.getState().currentView, 'editor');
      assert.equal(store.getState().activeTrip.tripId, 'trip-custom-1');
      assert.equal(store.getState().counter, 42);
    });

    test('createInitialAdminState returns fresh instances of Maps and Sets', () => {
      const s1 = createInitialAdminState();
      const s2 = createInitialAdminState();
      assert.notEqual(s1.dirtyDialogs, s2.dirtyDialogs);
      assert.notEqual(s1.trips, s2.trips);
      assert.notEqual(s1.publishedIds, s2.publishedIds);
    });
  });

  describe('2. State Updates via setState', () => {
    test('updates state with partial object and preserves untouched keys', () => {
      const store = createAdminStore({
        currentView: 'overview',
        tripWriteBusy: false,
        theme: 'dark'
      });
      store.setState({ currentView: 'editor', tripWriteBusy: true });
      const state = store.getState();
      assert.equal(state.currentView, 'editor');
      assert.equal(state.tripWriteBusy, true);
      assert.equal(state.theme, 'dark', 'Untouched properties must be preserved');
    });

    test('supports functional updaters receiving current state', () => {
      const store = createAdminStore({
        editorInputRevision: 10,
        activeDayKey: 'day1'
      });
      store.setState(prev => ({
        editorInputRevision: prev.editorInputRevision + 1,
        activeDayKey: 'day2'
      }));
      assert.equal(store.getState().editorInputRevision, 11);
      assert.equal(store.getState().activeDayKey, 'day2');
    });

    test('safely ignores null or undefined updaters without throwing', () => {
      const store = createAdminStore({ count: 5 });
      store.setState(null);
      store.setState(undefined);
      assert.equal(store.getState().count, 5);
    });
  });

  describe('3. Reactive Subscriber Notifications & Unsubscribe', () => {
    test('notifies subscribers synchronously upon setState', () => {
      const store = createAdminStore({ count: 0 });
      const history = [];
      store.subscribe(state => {
        history.push(state.count);
      });

      store.setState({ count: 1 });
      store.setState({ count: 2 });
      store.setState(s => ({ count: s.count + 5 }));

      assert.deepEqual(history, [1, 2, 7]);
    });

    test('unsubscribe stops listener notifications', () => {
      const store = createAdminStore({ active: false });
      let callCount = 0;
      const unsubscribe = store.subscribe(() => {
        callCount += 1;
      });

      store.setState({ active: true });
      assert.equal(callCount, 1);

      unsubscribe();

      store.setState({ active: false });
      store.setState({ active: true });
      assert.equal(callCount, 1, 'Unsubscribed listener must never be invoked again');
    });

    test('supports multiple independent subscribers without cross-contamination', () => {
      const store = createAdminStore({ msg: 'hello' });
      const logA = [];
      const logB = [];

      const unsubA = store.subscribe(s => logA.push(s.msg));
      const unsubB = store.subscribe(s => logB.push(s.msg));

      store.setState({ msg: 'world' });
      assert.deepEqual(logA, ['world']);
      assert.deepEqual(logB, ['world']);

      unsubA();
      store.setState({ msg: 'final' });
      assert.deepEqual(logA, ['world'], 'Subscriber A must be stopped');
      assert.deepEqual(logB, ['world', 'final'], 'Subscriber B must continue receiving updates');

      unsubB();
    });

    test('throws TypeError when non-function passed to subscribe', () => {
      const store = createAdminStore();
      assert.throws(() => store.subscribe(null), TypeError);
      assert.throws(() => store.subscribe(123), TypeError);
      assert.throws(() => store.subscribe('notAFunction'), TypeError);
    });
  });

  describe('4. State Slices & Isolation', () => {
    test('provides clean access to all 7 admin state slices', () => {
      const store = createAdminStore();
      const slices = [
        'overview',
        'editor',
        'candidateShelf',
        'dayPlanner',
        'distribution',
        'roles',
        'discussion'
      ];

      slices.forEach(sliceName => {
        const slice = store.getSlice(sliceName);
        assert.ok(slice != null, `Slice "${sliceName}" must exist in store`);
        assert.equal(typeof slice, 'object');
      });
    });

    test('setSlice isolates updates to the targeted slice without affecting others', () => {
      const store = createAdminStore();
      const initialDayPlanner = store.getSlice('dayPlanner');
      const initialOverview = store.getSlice('overview');

      // Update candidateShelf slice
      store.setSlice('candidateShelf', { filterStatus: 'assigned', filterCategory: 'gourmet' });

      // Verify targeted slice updated
      const updatedShelf = store.getSlice('candidateShelf');
      assert.equal(updatedShelf.filterStatus, 'assigned');
      assert.equal(updatedShelf.filterCategory, 'gourmet');

      // Verify other slices untouched
      assert.deepEqual(store.getSlice('dayPlanner'), initialDayPlanner, 'dayPlanner slice must be untouched');
      assert.deepEqual(store.getSlice('overview'), initialOverview, 'overview slice must be untouched');
    });

    test('setSlice supports functional updater and triggers subscriber notification', () => {
      const store = createAdminStore();
      let subscriberSeen = null;
      store.subscribe(state => {
        subscriberSeen = state.slices.distribution;
      });

      store.setSlice('distribution', prev => ({
        ...prev,
        activeCount: 3
      }));

      assert.equal(store.getSlice('distribution').activeCount, 3);
      assert.deepEqual(subscriberSeen, { activeCount: 3 });
    });
  });

  describe('5. Real-World Admin State Flow Scenarios', () => {
    test('manages complete editor lifecycle: open trip -> mark dirty -> save -> clean', () => {
      const store = createAdminStore();
      const trip = {
        tripId: 'shikoku-2026',
        title: '四国一周旅行',
        days: { day1: [] }
      };

      // 1. Open trip
      store.setState({
        currentView: 'editor',
        activeTrip: trip,
        activeDayKey: 'day1'
      });
      assert.equal(store.getState().currentView, 'editor');
      assert.equal(store.getState().activeTrip.tripId, 'shikoku-2026');

      // 2. Mark dialog dirty
      store.getState().dirtyDialogs.add('card-dialog');
      assert.equal(store.getState().dirtyDialogs.has('card-dialog'), true);

      // 3. Increment input revision
      store.setState(s => ({ editorInputRevision: s.editorInputRevision + 1 }));
      assert.equal(store.getState().editorInputRevision, 1);

      // 4. Save completes
      store.getState().dirtyDialogs.clear();
      store.setState({ tripWriteBusy: false });
      assert.equal(store.getState().dirtyDialogs.size, 0);
    });
  });

  describe('6. Hardening: Prototype Pollution Resistance and Array Slice Preservation', () => {
    test('preserves arrays when updating or creating slices in setSlice', () => {
      const store = createAdminStore();

      // Setting a new slice with an array
      const arr1 = ['item1', 'item2', 'item3'];
      store.setSlice('customArray', arr1);
      const retrieved = store.getSlice('customArray');

      assert.ok(Array.isArray(retrieved), 'Slice must be preserved as an Array');
      assert.deepEqual(retrieved, ['item1', 'item2', 'item3']);
      assert.equal(retrieved['0'], 'item1');
      assert.equal(Array.isArray(store.getState().slices.customArray), true);

      // Updating array slice with functional updater
      store.setSlice('customArray', prev => [...prev, 'item4']);
      const updated = store.getSlice('customArray');
      assert.ok(Array.isArray(updated));
      assert.deepEqual(updated, ['item1', 'item2', 'item3', 'item4']);

      // Updating existing top-level array property (e.g. distributions)
      const distList = [{ id: 'dist-1' }, { id: 'dist-2' }];
      store.setSlice('distributions', distList);
      assert.ok(Array.isArray(store.getSlice('distributions')));
      assert.ok(Array.isArray(store.getState().distributions));
      assert.deepEqual(store.getState().distributions, distList);
    });

    test('setState guards against array patches and does not spread indices onto root state', () => {
      const store = createAdminStore();
      const initialState = { ...store.getState() };

      store.setState(['elem1', 'elem2']);
      assert.equal(store.getState()['0'], undefined, 'Numeric index 0 must not be spread onto root state');
      assert.equal(store.getState()['1'], undefined, 'Numeric index 1 must not be spread onto root state');
      assert.deepEqual(store.getState(), initialState, 'State must remain unmodified when array is passed to setState');
    });

    test('resists prototype pollution and method clobbering in setSlice and setState', () => {
      const store = createAdminStore();

      // Vector 1: __proto__ via setSlice
      const evilPayload = { pollutedKey: 'malicious' };
      store.setSlice('__proto__', evilPayload);

      assert.equal(({}).pollutedKey, undefined, 'Object.prototype must not be polluted');
      assert.equal(Object.getPrototypeOf(store.getState()), Object.prototype, 'State prototype must not be altered');
      assert.equal(store.getState().pollutedKey, undefined, 'State instance must not inherit pollutedKey');

      // Vector 2: toString / valueOf / constructor method clobbering
      assert.equal(typeof store.getState().toString, 'function');
      store.setSlice('toString', { custom: 'clobber' });

      // State's toString must remain a function (not clobbered by "in" operator check)
      assert.equal(typeof store.getState().toString, 'function', 'state.toString must remain a function');
      assert.doesNotThrow(() => store.getState().toString(), 'state.toString() must execute without throwing');

      // Vector 3: prototype pollution via setState
      store.setState(JSON.parse('{"__proto__": {"pollutedViaSetState": "bad"}}'));
      assert.equal(({}).pollutedViaSetState, undefined, 'Object.prototype must not be polluted via setState');
    });
  });
});
