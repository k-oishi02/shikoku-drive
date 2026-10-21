import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTripStore, createInitialTripState } from '../src/trip-store.js';

describe('TripStore Unit Test Suite', () => {
  it('creates initial state with required default slices', () => {
    const store = createTripStore();
    const state = store.getState();

    assert.ok(state, 'Store should return state snapshot');
    assert.equal(state.activeTrip, null);
    assert.equal(state.currentAccess, null);
    assert.deepEqual(state.syncState, { mode: 'idle', status: 'ready' });
    assert.deepEqual(state.weather, {});
    assert.deepEqual(state.checklist, []);
    assert.deepEqual(state.expenses, []);
    assert.deepEqual(state.portalTrips, []);

    // Slices container
    assert.ok(state.slices, 'State slices container should exist');
    assert.equal(store.getSlice('activeTrip'), null);
    assert.deepEqual(store.getSlice('checklist'), []);
    assert.deepEqual(store.getSlice('expenses'), []);
  });

  it('notifies subscribers on setState mutations', () => {
    const store = createTripStore();
    let notificationCount = 0;
    let lastReceivedState = null;

    const unsubscribe = store.subscribe((newState) => {
      notificationCount++;
      lastReceivedState = newState;
    });

    store.setState({ syncState: { mode: 'live', status: 'connected' } });

    assert.equal(notificationCount, 1);
    assert.equal(lastReceivedState.syncState.mode, 'live');
    assert.equal(store.getState().syncState.status, 'connected');

    unsubscribe();
    store.setState({ syncState: { mode: 'offline', status: 'cached' } });

    // Count should remain 1 after unsubscription
    assert.equal(notificationCount, 1);
    assert.equal(store.getState().syncState.mode, 'offline');
  });

  it('notifies subscribers and isolates slices on setSlice mutations', () => {
    const store = createTripStore();
    let notificationCount = 0;

    store.subscribe(() => {
      notificationCount++;
    });

    // Object slice update with functional updater
    store.setSlice('weather', (prev) => ({ ...prev, oarai: { temp: '22°C', cond: '晴れ' } }));
    assert.equal(notificationCount, 1);
    assert.deepEqual(store.getSlice('weather'), { oarai: { temp: '22°C', cond: '晴れ' } });

    // Merges partial object without wiping existing fields
    store.setSlice('weather', { mito: { temp: '20°C', cond: '曇り' } });
    assert.equal(notificationCount, 2);
    const weather = store.getSlice('weather');
    assert.ok(weather.oarai, 'Existing oarai weather should be preserved');
    assert.ok(weather.mito, 'New mito weather should be added');
    assert.equal(weather.oarai.temp, '22°C');
    assert.equal(weather.mito.temp, '20°C');
  });

  it('preserves Array slices as true Arrays without spreading into plain objects', () => {
    const store = createTripStore();

    const expensesList = [
      { id: 'exp-1', amount: 3500, title: '海鮮丼' },
      { id: 'exp-2', amount: 1200, title: '高速料金' }
    ];

    const result = store.setSlice('expenses', expensesList);

    assert.ok(Array.isArray(result), 'Returned slice must be an Array');
    assert.equal(result.length, 2);

    const retrievedExpenses = store.getSlice('expenses');
    assert.ok(Array.isArray(retrievedExpenses), 'getSlice must return a real Array');
    assert.equal(retrievedExpenses.length, 2);
    assert.equal(typeof retrievedExpenses.map, 'function', 'Must support Array prototype methods');
    assert.equal(typeof retrievedExpenses.filter, 'function');
    assert.equal(retrievedExpenses[0].title, '海鮮丼');

    // Functional array updater
    store.setSlice('expenses', (prev) => [...prev, { id: 'exp-3', amount: 800, title: '梅ソーダ' }]);
    const updatedExpenses = store.getSlice('expenses');
    assert.ok(Array.isArray(updatedExpenses));
    assert.equal(updatedExpenses.length, 3);
    assert.equal(updatedExpenses[2].title, '梅ソーダ');

    // Checklist array slice
    store.setSlice('checklist', ['ETCカード', '運転免許証']);
    const checklist = store.getSlice('checklist');
    assert.ok(Array.isArray(checklist));
    assert.equal(checklist.length, 2);
    assert.equal(checklist.includes('ETCカード'), true);
  });

  it('guards against prototype pollution and method clobbering', () => {
    const store = createTripStore();

    // Direct attacks via getSlice
    assert.equal(store.getSlice('__proto__'), undefined);
    assert.equal(store.getSlice('constructor'), undefined);
    assert.equal(store.getSlice('prototype'), undefined);
    assert.equal(store.getSlice('toString'), undefined);
    assert.equal(store.getSlice('valueOf'), undefined);

    // Pollution attacks via setSlice
    assert.equal(store.setSlice('__proto__', { admin: true }), undefined);
    assert.equal(store.setSlice('constructor', { admin: true }), undefined);
    assert.equal(store.setSlice('prototype', { admin: true }), undefined);

    // Verify global Object prototype was not polluted
    const cleanObj = {};
    assert.equal(cleanObj.admin, undefined);

    // Pollution attacks via setState
    const maliciousPayload = JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": {"hacked": true}}');
    store.setState(maliciousPayload);

    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  });

  it('rejects array, non-object, primitive, and nullish patches on setState', () => {
    const store = createTripStore();
    const beforeState = store.getState();
    let notifications = 0;
    store.subscribe(() => { notifications++; });

    // Array patch
    store.setState(['corrupted', 'data']);
    assert.equal(notifications, 0, 'Array patch must be rejected without notification');
    assert.equal(store.getState()[0], undefined);

    // Primitive and nullish patches
    store.setState('invalid string');
    store.setState(12345);
    store.setState(null);
    store.setState(undefined);
    store.setState(true);

    assert.equal(notifications, 0, 'Invalid patches must not trigger subscribers');
    assert.deepEqual(store.getState(), beforeState);
  });

  it('synchronizes backward-compatibility properties to window object', () => {
    // Provide mock window on globalThis
    const originalWindow = globalThis.window;
    globalThis.window = {};

    try {
      const store = createTripStore();

      // Initially empty window state
      assert.equal(globalThis.window.currentTripId, '');
      assert.equal(globalThis.window.currentTripData, null);
      assert.equal(globalThis.window.currentTripTitle, '');
      assert.deepEqual(globalThis.window.currentTripMembers, []);

      // Set activeTrip and currentAccess
      const sampleTrip = {
        tripId: '20261107',
        title: '茨城海岸ドライブ 2026秋',
        subtitle: '海の幸・梅ソーダ・コキア・海カフェ',
        startDate: '2026-11-07',
        endDate: '2026-11-07',
        ledgerToken: 'AbCdEf1234567890_-AbCdEf1234567890_-AbCdEf1',
        members: [{ id: 'm1', name: '木村蒼' }, { id: 'm2', name: '佐藤優' }]
      };

      store.setState({
        activeTrip: sampleTrip,
        currentAccess: { tripId: '20261107', ledger: sampleTrip.ledgerToken }
      });

      // Assert window bridge properties match
      assert.equal(globalThis.window.currentTripId, '20261107');
      assert.equal(globalThis.window.currentTripLedgerToken, 'AbCdEf1234567890_-AbCdEf1234567890_-AbCdEf1');
      assert.equal(globalThis.window.currentTripData, sampleTrip);
      assert.equal(globalThis.window.currentTripTitle, '海の幸・梅ソーダ・コキア・海カフェ');
      assert.equal(globalThis.window.currentTripDate, '2026-11-07');
      assert.equal(globalThis.window.currentTripEndDate, '2026-11-07');
      assert.equal(globalThis.window.currentTripMembers.length, 2);
      assert.equal(globalThis.window.currentTripMembers[0].name, '木村蒼');

      // Clear trip on pause
      store.setState({ activeTrip: null, currentAccess: null });
      assert.equal(globalThis.window.currentTripId, '');
      assert.equal(globalThis.window.currentTripLedgerToken, '');
      assert.equal(globalThis.window.currentTripData, null);
      assert.deepEqual(globalThis.window.currentTripMembers, []);
    } finally {
      if (originalWindow !== undefined) {
        globalThis.window = originalWindow;
      } else {
        delete globalThis.window;
      }
    }
  });
});
