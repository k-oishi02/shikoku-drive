function canonicalStringify(val, isPlanningRoot = false) {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(item => canonicalStringify(item)).join(',') + ']';
  }
  const keys = Object.keys(val).sort();
  const pairs = [];
  for (const k of keys) {
    if (isPlanningRoot && k === 'lastSavedAt') continue;
    pairs.push(JSON.stringify(k) + ':' + canonicalStringify(val[k]));
  }
  return '{' + pairs.join(',') + '}';
}

function computeFingerprint(trip, planning) {
  return canonicalStringify(trip) + '|' + canonicalStringify(planning, true);
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return obj;
}

export function draftVersion(data) {
  if (!data || typeof data !== 'object') return null;
  return JSON.stringify([
    data.revision ?? '',
    data.payloadJson ?? '',
    data.planningJson ?? '',
    data.title ?? '',
    data.status ?? ''
  ]);
}

export function assertDraftVersion(actualData, expectedVersion) {
  const actual = draftVersion(actualData);
  if (actual !== expectedVersion) {
    const err = new Error('他の端末で変更されています。入力内容を退避し、最新の下書きを読み直してください。');
    err.code = 'draft-conflict';
    throw err;
  }
}

export function createEditorSession() {
  let currentGeneration = 0;
  let baselineFingerprint = null;
  let baselineTripId = null;
  let currentVersion = null;
  let isSavedState = true;
  let isOpen = false;
  let pendingTicket = null;

  return {
    open({ trip, planning, version = null, saved = true, tripId = null } = {}) {
      currentGeneration += 1;
      isOpen = true;
      isSavedState = Boolean(saved);
      baselineTripId = tripId ?? trip?.tripId ?? trip?.id ?? null;
      baselineFingerprint = computeFingerprint(trip, planning);
      currentVersion = version;
    },

    getVersion() {
      return currentVersion;
    },

    getTripId() {
      return baselineTripId;
    },

    isOpenSession() {
      return isOpen;
    },

    updateSavedBaseline({ trip, planning, newVersion, tripId = null } = {}) {
      if (!isOpen) {
        const err = new Error('エディタセッションが開かれていません。');
        err.code = 'session-not-open';
        throw err;
      }
      if (pendingTicket !== null) {
        const err = new Error('保存処理が既に実行中です。');
        err.code = 'save-busy';
        throw err;
      }
      baselineTripId = tripId ?? trip?.tripId ?? trip?.id ?? baselineTripId;
      baselineFingerprint = computeFingerprint(trip, planning);
      currentVersion = newVersion;
      isSavedState = true;
    },

    isDirty(trip, planning) {
      if (!isOpen) return false;
      if (!isSavedState) return true;
      return computeFingerprint(trip, planning) !== baselineFingerprint;
    },

    beginSave(trip, planning, options = {}) {
      if (pendingTicket !== null) {
        const err = new Error('保存処理が既に実行中です。');
        err.code = 'save-busy';
        throw err;
      }
      if (!isOpen) {
        const err = new Error('エディタセッションが開かれていません。');
        err.code = 'session-not-open';
        throw err;
      }
      const currentTripId = options.tripId ?? trip?.tripId ?? trip?.id ?? baselineTripId;
      const expectedVersion = (currentTripId !== baselineTripId) ? null : currentVersion;
      const fingerprint = computeFingerprint(trip, planning);

      const ticket = deepFreeze({
        generation: currentGeneration,
        trip: structuredClone(trip),
        planning: structuredClone(planning),
        expectedVersion,
        tripId: currentTripId,
        fingerprint
      });
      pendingTicket = ticket;
      return ticket;
    },

    finishSave(ticket, newVersion) {
      if (!ticket || ticket !== pendingTicket) return;
      pendingTicket = null;
      if (ticket.generation !== currentGeneration) return;
      baselineFingerprint = ticket.fingerprint;
      currentVersion = newVersion;
      baselineTripId = ticket.tripId;
      isSavedState = true;
    },

    finishExternalSave(ticket, { trip, planning, newVersion }, currentTrip, currentPlanning, inputsUnchanged = true) {
      if (!ticket || ticket !== pendingTicket) return { applied: false, sessionSwitched: true };
      pendingTicket = null;
      if (ticket.generation !== currentGeneration || ticket.tripId !== baselineTripId) {
        return { applied: false, sessionSwitched: true };
      }
      if (!inputsUnchanged || computeFingerprint(currentTrip, currentPlanning) !== ticket.fingerprint) {
        // The server committed, but local edits must retain their OLD version so a
        // later save cannot erase the server's candidate or another admin's work.
        return { applied: false, localEditsPreserved: true };
      }
      if (!trip || trip.tripId !== ticket.tripId || !planning) throw new Error('採用結果の旅行データが不正です。');
      baselineFingerprint = computeFingerprint(trip, planning);
      currentVersion = newVersion;
      isSavedState = true;
      return { applied: true };
    },

    failSave(ticket) {
      if (ticket && ticket === pendingTicket) {
        pendingTicket = null;
      }
    },

    get saving() {
      return pendingTicket !== null;
    },

    get generation() {
      return currentGeneration;
    }
  };
}
