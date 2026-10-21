/**
 * AdminStore: Reactive State Container for SHIORI Admin Console
 *
 * Implements a zero-dependency pub/sub state container with slice isolation,
 * immutable updates, and subscriber notifications.
 */

export function createInitialAdminState() {
  return {
    currentView: 'overview',
    tripWriteBusy: false,
    dirtyDialogs: new Set(),
    editorInputRevision: 0,
    currentUser: null,
    currentRole: 'editor',
    adminProfiles: [],
    trips: new Map(),
    publishedIds: new Set(),
    publishedTrips: new Map(),
    activeTrip: null,
    activePlanning: null,
    activeDayKey: '',
    candidateFilterStatus: 'all',
    candidateFilterCategory: 'all',
    activeCandidateForAdopt: null,
    activePendingPlan: null,
    lastDayPlanUndo: null,
    distributions: [],
    participantUnsubscribers: new Map(),
    roomUnsubscribers: new Map(),
    expenseUnsubscribers: new Map(),
    distributionsUnsubscribe: null,
    toastTimer: null,
    // Discrete state slices for view controllers
    slices: {
      overview: { lastUpdated: null, metricCount: 0 },
      editor: { dirty: false, activeDayKey: '' },
      candidateShelf: { filterStatus: 'all', filterCategory: 'all' },
      dayPlanner: { lastUndo: null, pendingPlan: null },
      distribution: { activeCount: 0 },
      roles: { count: 0 },
      discussion: { activeRoomId: '' }
    }
  };
}

/**
 * Creates an AdminStore instance.
 * @param {object} [initialState] Optional initial state override.
 * @returns {object} AdminStore instance with getState, setState, subscribe, getSlice, setSlice.
 */
export function createAdminStore(initialState = createInitialAdminState()) {
  let state = { ...initialState };
  const listeners = new Set();

  return {
    /**
     * Returns the current state snapshot.
     */
    getState: () => state,

    /**
     * Updates state and notifies subscribers.
     * @param {object|Function} updater Partial state object or function (prevState) => partialState.
     */
    setState: (updater) => {
      const patch = typeof updater === 'function' ? updater(state) : updater;
      if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
        state = { ...state, ...patch };
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
     * Retrieves a named state slice.
     * @param {string} sliceName Name of the slice.
     */
    getSlice: (sliceName) => {
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
     * @param {string} sliceName Name of the slice.
     * @param {object|Function} updater Partial slice object or updater function.
     */
    setSlice: (sliceName, updater) => {
      const currentSlice = (state.slices && Object.prototype.hasOwnProperty.call(state.slices, sliceName))
        ? state.slices[sliceName]
        : (Object.prototype.hasOwnProperty.call(state, sliceName) ? state[sliceName] : undefined);
      const patch = typeof updater === 'function' ? updater(currentSlice) : updater;
      const newSlice = (typeof currentSlice === 'object' && currentSlice !== null && !Array.isArray(currentSlice)
        && typeof patch === 'object' && patch !== null && !Array.isArray(patch))
        ? { ...currentSlice, ...patch }
        : patch;
      const newSlices = { ...(state.slices || {}), [sliceName]: newSlice };
      state = { ...state, slices: newSlices };
      // Also update top-level property if it exists
      if (Object.prototype.hasOwnProperty.call(state, sliceName)) {
        state[sliceName] = newSlice;
      }
      listeners.forEach(fn => fn(state));
      return newSlice;
    }
  };
}
