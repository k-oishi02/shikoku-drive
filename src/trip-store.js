/**
 * TripStore: Reactive State Container for SHIORI Participant Viewer
 *
 * Implements a single-source-of-truth pub/sub state container with slice isolation,
 * array preservation, prototype pollution defense, and a backward-compatibility
 * window bridge for non-modular companion scripts.
 */

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function syncToWindow(state) {
  if (typeof window === 'undefined') return;
  const trip = state.activeTrip;
  const access = state.currentAccess;

  window.currentTripId = (trip && trip.tripId) ? trip.tripId : (access && access.tripId) ? access.tripId : '';
  window.currentTripLedgerToken = (access && (access.ledgerToken || access.ledger))
    ? (access.ledgerToken || access.ledger)
    : (trip && trip.ledgerToken ? trip.ledgerToken : '');
  window.currentTripData = trip || null;
  window.currentTripTitle = trip ? (trip.subtitle || trip.title || '旅行') : '';
  window.currentTripDate = (trip && trip.startDate) ? trip.startDate : '';
  window.currentTripEndDate = (trip && trip.endDate) ? trip.endDate : '';
  window.currentTripMembers = (trip && Array.isArray(trip.members)) ? trip.members : [];
}

export function createInitialTripState() {
  return {
    activeTrip: null,
    currentAccess: null,
    syncState: { mode: 'idle', status: 'ready' },
    weather: {},
    checklist: [],
    expenses: [],
    portalTrips: [],
    slices: {
      activeTrip: null,
      currentAccess: null,
      syncState: { mode: 'idle', status: 'ready' },
      weather: {},
      checklist: [],
      expenses: [],
      portalTrips: []
    }
  };
}

/**
 * Creates a reactive TripStore instance.
 * @param {object} [initialState] Optional initial state override.
 * @returns {object} TripStore instance with getState, setState, subscribe, getSlice, setSlice.
 */
export function createTripStore(initialState = createInitialTripState()) {
  let state = { ...initialState };
  if (!state.slices || typeof state.slices !== 'object' || Array.isArray(state.slices)) {
    state.slices = {};
  }
  const defaultSlices = ['activeTrip', 'currentAccess', 'syncState', 'weather', 'checklist', 'expenses', 'portalTrips'];
  for (const key of defaultSlices) {
    if (!Object.prototype.hasOwnProperty.call(state.slices, key) && Object.prototype.hasOwnProperty.call(state, key)) {
      state.slices[key] = state[key];
    }
  }

  const listeners = new Set();
  syncToWindow(state);

  return {
    /**
     * Returns the current state snapshot.
     */
    getState: () => state,

    /**
     * Merges a partial state object and notifies subscribers.
     * Guards against array patches, nullish, primitives, and prototype pollution keys.
     * @param {object|Function} updater Partial state object or function (prevState) => partialState.
     */
    setState: (updater) => {
      const patch = typeof updater === 'function' ? updater(state) : updater;
      if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
        const cleanPatch = {};
        for (const key of Object.keys(patch)) {
          if (BLOCKED_KEYS.has(key)) continue;
          cleanPatch[key] = patch[key];
        }
        state = { ...state, ...cleanPatch };
        if (state.slices && typeof state.slices === 'object') {
          const updatedSlices = { ...state.slices };
          for (const key of Object.keys(cleanPatch)) {
            if (Object.prototype.hasOwnProperty.call(updatedSlices, key)) {
              updatedSlices[key] = cleanPatch[key];
            }
          }
          state.slices = updatedSlices;
        }
        syncToWindow(state);
        listeners.forEach(fn => fn(state));
      }
    },

    /**
     * Subscribes a listener function to state changes.
     * @param {Function} listener Callback invoked with new state on changes.
     * @returns {Function} Unsubscribe function.
     */
    subscribe: (listener) => {
      if (typeof listener !== 'function') {
        throw new TypeError('Subscriber listener must be a function');
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Retrieves a named state slice with prototype pollution protection.
     * @param {string} sliceName Name of the slice.
     */
    getSlice: (sliceName) => {
      if (typeof sliceName !== 'string' || BLOCKED_KEYS.has(sliceName)) {
        return undefined;
      }
      if (state.slices && Object.prototype.hasOwnProperty.call(state.slices, sliceName)) {
        return state.slices[sliceName];
      }
      if (Object.prototype.hasOwnProperty.call(state, sliceName)) {
        return state[sliceName];
      }
      return undefined;
    },

    /**
     * Updates a named state slice and notifies subscribers.
     * Preserves Array instances as Arrays, avoiding accidental object spread.
     * @param {string} sliceName Name of the slice.
     * @param {object|Array|Function} updater Partial slice object, array, or updater function.
     */
    setSlice: (sliceName, updater) => {
      if (typeof sliceName !== 'string' || BLOCKED_KEYS.has(sliceName)) {
        return undefined;
      }
      const currentSlice = (state.slices && Object.prototype.hasOwnProperty.call(state.slices, sliceName))
        ? state.slices[sliceName]
        : (Object.prototype.hasOwnProperty.call(state, sliceName) ? state[sliceName] : undefined);

      const patch = typeof updater === 'function' ? updater(currentSlice) : updater;

      let newSlice;
      if (Array.isArray(patch)) {
        newSlice = patch;
      } else if (
        typeof currentSlice === 'object' && currentSlice !== null && !Array.isArray(currentSlice) &&
        typeof patch === 'object' && patch !== null && !Array.isArray(patch)
      ) {
        newSlice = { ...currentSlice, ...patch };
      } else {
        newSlice = patch;
      }

      const newSlices = { ...(state.slices || {}), [sliceName]: newSlice };
      state = { ...state, slices: newSlices };
      if (Object.prototype.hasOwnProperty.call(state, sliceName) || defaultSlices.includes(sliceName)) {
        state[sliceName] = newSlice;
      }

      syncToWindow(state);
      listeners.forEach(fn => fn(state));
      return newSlice;
    }
  };
}
