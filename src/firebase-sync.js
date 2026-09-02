
import { initializeApp, getApp, getApps } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
    getAuth,
    signInAnonymously
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
    collection,
    deleteDoc,
    doc,
    getDoc,
    onSnapshot,
    serverTimestamp,
    setDoc,
    updateDoc,
    runTransaction,
    query,
    orderBy,
    limit,
    startAfter,
    documentId,
    FieldPath,
    deleteField,
    getDocsFromServer,
    initializeFirestore,
    getFirestore,
    persistentLocalCache,
    persistentMultipleTabManager
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { createSuggestionSyncService } from './suggestion-sync.js';

const firebaseConfig = {
    apiKey: 'AIzaSyCOh5MtRbplm-46FETshOQAGHqyQ4fD4tA',
    authDomain: 'shikoku-drive.firebaseapp.com',
    projectId: 'shikoku-drive',
    storageBucket: 'shikoku-drive.firebasestorage.app',
    messagingSenderId: '100077385758',
    appId: '1:100077385758:web:dd63588317da1edc9b560f',
    measurementId: 'G-VV9YHYW85C'
};

let EXPENSE_KEY = 'shiori-expenses-local-v2';
const pendingActions = [];
let syncContext = null;
let suggestionSyncService = null;
let unsubscribeRoom = null;
let unsubscribeExpenses = null;
let unsubscribeParticipants = null;
let participantHeartbeat = null;
let syncRunId = 0;
const PARTICIPANT_ACTIVE_MS = 5 * 60 * 1000;
const TRIP_ACCESS_KEY = 'participant-trip-access-v1';
const ACCESS_ID_PATTERN = /^[A-Z2-9]{12}$/;

function publishLedgerAccess(uid = '', live = false, reason = '') {
    const access = { uid: String(uid || ''), isAdmin: false, live: live === true, reason: String(reason || '') };
    window.currentLedgerAccess = access;
    window.dispatchEvent(new CustomEvent('shiori-ledger-access', { detail: access }));
}

publishLedgerAccess();
window.expensePayerAliases = {};

function normalizeAccessId(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function storedAccessForTrip(tripId) {
    try {
        const stored = JSON.parse(localStorage.getItem(TRIP_ACCESS_KEY) || '{}')?.[tripId];
        return stored && typeof stored === 'object' ? stored : null;
    } catch (error) {
        return null;
    }
}

function accessError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

function ensureRoomParameters(tripId) {
    const stored = storedAccessForTrip(tripId);
    const ledgerToken = String(stored?.ledger || "");
    const accessId = normalizeAccessId(stored?.accessId);
    const validLedger = /^[A-Za-z0-9_-]{43}$/.test(ledgerToken);
    if (!validLedger || !ACCESS_ID_PATTERN.test(accessId)) return null;
    return { roomId: `${tripId}_${ledgerToken}`, accessId, ledgerToken };
}

function setSyncUi(mode, title, message) {
    const badge = document.getElementById('sync-badge');
    const titleEl = document.getElementById('sync-title');
    const status = document.getElementById('sync-status');
    const note = document.getElementById('sync-note');
    const members = document.getElementById('hero-participants');
    const expenseSubmit = document.querySelector('#expense-form .expense-submit');
    if (badge) {
        badge.classList.toggle('live', mode === 'live');
        badge.classList.toggle('error', mode === 'error');
        badge.classList.toggle('local', mode === 'local');
        badge.textContent = mode === 'live' ? 'LIVE SYNC' : mode === 'error' ? 'ACTION NEEDED' : mode === 'local' ? 'LOCAL ONLY' : 'CONNECTING';
    }
    if (titleEl) titleEl.textContent = title;
    if (status) status.textContent = message;
    if (note) note.hidden = mode !== 'live';
    if (members && mode !== 'live') {
        members.textContent = mode === 'error'
            ? 'MEMBERS: 同期なし'
            : mode === 'local'
                ? 'MEMBERS: この端末のみ'
                : 'MEMBERS: 接続中…';
    }
    if (expenseSubmit) {
        expenseSubmit.textContent = mode === 'live' ? 'ADD & SHARE' : 'LOCKED';
        expenseSubmit.disabled = mode !== 'live';
        expenseSubmit.dataset.syncMode = mode;
    }
}

function renderLiveSyncState() {
    if (!syncContext?.roomReady || !syncContext?.participantsReady
        || !syncContext.roomVerified || !syncContext.participantsVerified
        || !Array.isArray(syncContext.verifiedExpenses) || !navigator.onLine) return;
    publishLedgerAccess(syncContext.uid, true);
    if (Array.isArray(syncContext.verifiedExpenses)) emitRemoteExpenses(syncContext.verifiedExpenses);
    const deviceCount = Number(syncContext.memberCount || 0);
    const peopleCount = Number(syncContext.logicalMemberCount ?? deviceCount);
    const capacity = Math.max(deviceCount, Number(syncContext.capacity || 2));
    setSyncUi('live', '\u53c2\u52a0\u8005\u3068\u3057\u3066\u63a5\u7d9a\u6e08\u307f', `${peopleCount}\u540d\uff08${deviceCount}/${capacity}\u7aef\u672b\uff09\u304c\u767b\u9332\u6e08\u307f\u3002\u8ffd\u52a0\u30fb\u524a\u9664\u306f\u81ea\u52d5\u540c\u671f\u3055\u308c\u307e\u3059\u3002`);
    const roomFull = deviceCount >= capacity;
    const note = document.getElementById('sync-note');
    if (note) {
        note.textContent = roomFull
            ? `端末枠${capacity}台が埋まっています。入力内容は全員へ自動反映されます。`
            : `あと${capacity - deviceCount}台の端末を登録できます。管理者の登録リンク、または同じ配布IDを使用してください。`;
    }
}

function setIdentityControlLocked(locked) {
    const deviceOwner = document.getElementById('device-owner');
    if (!deviceOwner) return;
    deviceOwner.disabled = locked;
    deviceOwner.title = locked ? '配布ルームの参加順から自動設定されています' : '';
}

function readCachedExpenses() {
    try {
        const parsed = JSON.parse(localStorage.getItem(EXPENSE_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function cleanExpense(expense) {
    const note = [expense.note, expense.comment].map(value => String(value || '').trim()).filter(Boolean).join(' — ').slice(0, 120);
    const participantIds = Array.from(new Set((Array.isArray(expense.participantIds) ? expense.participantIds : [])
        .map(value => String(value || '').slice(0, 128)).filter(Boolean))).slice(0, 50);
    const splitMode = expense.splitMode === 'selected' ? 'selected' : 'equal';
    return {
        id: String(expense.id || '').slice(0, 120),
        amount: Math.max(0, Math.round(Number(expense.amount) || 0)),
        payer: String(expense.payer || '').slice(0, 128),
        category: String(expense.category || 'その他').slice(0, 20),
        note,
        createdAt: String(expense.createdAt || new Date().toISOString()).slice(0, 40),
        creatorUid: String(expense.creatorUid || '').slice(0, 128),
        splitMode,
        participantIds: splitMode === 'equal' ? [] : participantIds,
        pendingSync: expense.pendingSync === true
    };
}

function expenseForCurrentRoom(expense) {
    const cleaned = cleanExpense(expense);
    const memberIds = Array.isArray(syncContext?.memberIds) ? syncContext.memberIds : [];
    const payerAlias = window.expensePayerAliases?.[cleaned.payer];
    if (payerAlias) cleaned.payer = payerAlias;
    if (!memberIds.includes(cleaned.payer)) {
        cleaned.payer = window.expensePayerAliases?.[syncContext?.uid]
            || syncContext?.uid
            || memberIds[0]
            || '';
    }
    cleaned.participantIds = cleaned.participantIds
        .map(id => window.expensePayerAliases?.[id] || id)
        .filter((id, index, values) => memberIds.includes(id) && values.indexOf(id) === index);
    if (cleaned.splitMode !== 'equal' && !cleaned.participantIds.length) cleaned.splitMode = 'equal';
    const { pendingSync, ...payload } = cleaned;
    return { ...payload, creatorUid: cleaned.creatorUid || syncContext?.uid || '' };
}

function validExpenseForSync(expense) {
    return Boolean(
        expense &&
        expense.id &&
        !String(expense.id).includes('/') &&
        String(expense.id).length <= 120 &&
        Number.isInteger(expense.amount) &&
        expense.amount > 0 &&
        expense.amount < 10000000
    );
}

function emitRemoteExpenses(expenses) {
    window.dispatchEvent(new CustomEvent('shiori-expenses-remote', { detail: expenses }));
}

async function persistAction(action, queueWhenUnavailable = true) {
    const actionTripId = String(action?.tripId || window.currentTripId || '');
    const actionLedgerToken = String(action?.ledgerToken || '');
    const sameRoom = syncContext
        && syncContext.tripId === actionTripId
        && syncContext.ledgerToken === actionLedgerToken;
    if (!sameRoom) {
        if (queueWhenUnavailable
            && actionTripId === String(window.currentTripId || '')
            && /^[A-Za-z0-9_-]{43}$/.test(actionLedgerToken)) {
            pendingActions.push({ ...action, tripId: actionTripId, ledgerToken: actionLedgerToken });
        }
        return false;
    }

    const { expensesCollection, uid } = syncContext;
    if (action.type === 'upsert' && action.expense && (!syncContext.participantsReady || !syncContext.roomReady)) {
        if (queueWhenUnavailable) pendingActions.push({ ...action, tripId: actionTripId, ledgerToken: actionLedgerToken });
        return false;
    }
    if (action.type === 'upsert' && action.expense) {
        const localExpense = cleanExpense(action.expense);
        if (localExpense.creatorUid && localExpense.creatorUid !== uid) return true;
        const expense = expenseForCurrentRoom(action.expense);
        if (!localExpense.creatorUid && !localExpense.pendingSync && expense.payer !== uid) return true;
        if (!validExpenseForSync(expense)) return true;
        await setDoc(doc(expensesCollection, expense.id), expense);
    } else if (action.type === 'remove' && action.id && !String(action.id).includes('/')) {
        await deleteDoc(doc(expensesCollection, String(action.id)));
    }
    return true;
}

async function flushPendingActions(tripId, ledgerToken) {
    const queued = pendingActions.splice(0, pendingActions.length);
    const retry = [];
    for (const action of queued) {
        if (action.tripId !== tripId || action.ledgerToken !== ledgerToken) {
            retry.push(action);
            continue;
        }
        try {
            const persisted = await persistAction(action, false);
            if (!persisted) retry.push(action);
        } catch (error) {
            retry.push(action);
        }
    }
    pendingActions.push(...retry);
}

window.addEventListener('shiori-expense-action', event => {
    const tripId = String(window.currentTripId || '');
    if (!tripId) return;
    const stored = storedAccessForTrip(tripId);
    const ledgerToken = syncContext?.tripId === tripId
        ? String(syncContext.ledgerToken || '')
        : String(stored?.ledger || '');
    const action = {
        ...(event.detail || {}),
        tripId,
        ledgerToken
    };
    persistAction(action).catch(() => {
        window.expensePayerAliases = {};
        publishLedgerAccess();
        setSyncUi('error', '同期に失敗しました', '通信状態を確認してください。入力内容はこの端末に残っています。');
    });
});

async function createOrJoinRoom(db, uid, roomId, accessId) {
    const roomRef = doc(db, "rooms", roomId);
    const accessIdHash = await sha256(accessId);
    try {
        const currentRoom = await getDoc(roomRef);
        if (currentRoom.exists()) {
            const members = currentRoom.data().members || {};
            if (members[uid]) return { roomRef };
        }
    } catch (readError) {
        // Non-members cannot read a room before proving the distribution ID.
    }
    await updateDoc(roomRef, {
        [`members.${uid}`]: true,
        joined: true,
        joinProof: accessIdHash,
        updatedAt: serverTimestamp()
    });
    return { roomRef };
}

export async function redeemAccessId(value) {
    const accessId = normalizeAccessId(value);
    if (!ACCESS_ID_PATTERN.test(accessId)) throw accessError('access/invalid', 'Invalid access ID');
    const grantId = await sha256(accessId);
    const db = await getDbInstance();
    if (!db) throw accessError('access/unavailable', 'Access service unavailable');
    const auth = getAuth();
    const uid = auth.currentUser?.uid;
    if (!uid) throw accessError('access/unavailable', 'Anonymous authentication failed');
    let grantSnapshot;
    try {
        grantSnapshot = await getDoc(doc(db, 'accessGrants', grantId));
    } catch (error) {
        if (String(error?.code || '').includes('permission-denied')) throw accessError('access/revoked', 'Access ID revoked');
        throw error;
    }
    if (!grantSnapshot.exists()) throw accessError('access/invalid', 'Access ID not found');
    const grant = grantSnapshot.data();
    if (grant.status !== 'active') throw accessError('access/revoked', 'Access ID revoked');
    if (!grant.tripId || !grant.roomId || !grant.ledgerToken || !grant.payloadJson) throw accessError('access/invalid', 'Access grant incomplete');
    let trip;
    try { trip = JSON.parse(grant.payloadJson); } catch (error) { throw accessError('access/invalid', 'Trip payload invalid'); }
    if (trip?.tripId !== grant.tripId || !trip?.days || typeof trip.days !== 'object' || Array.isArray(trip.days)) throw accessError('access/invalid', 'Trip payload mismatch');
    try {
        await createOrJoinRoom(db, uid, grant.roomId, accessId);
    } catch (error) {
        if (String(error?.code || '').includes('permission-denied')) throw accessError('access/full', 'Room is full or inactive');
        throw error;
    }
    return { tripId: grant.tripId, ledgerToken: grant.ledgerToken, grantId, trip };
}

export async function fetchManagedTripConfig(tripId, access) {
    const accessId = normalizeAccessId(access?.accessId);
    if (!ACCESS_ID_PATTERN.test(accessId)) throw accessError("access/invalid", "Invalid saved access");
    const grantId = await sha256(accessId);
    if (access?.grantId && access.grantId !== grantId) throw accessError('access/invalid', 'Access grant mismatch');
    const db = await getDbInstance();
    let grantSnapshot;
    try {
        grantSnapshot = await getDoc(doc(db, 'accessGrants', grantId));
    } catch (error) {
        if (String(error?.code || '').includes('permission-denied')) throw accessError('access/revoked', 'Access ID revoked');
        throw error;
    }
    if (!grantSnapshot.exists()) throw accessError('access/invalid', 'Access ID not found');
    const grant = grantSnapshot.data();
    if (grant.status !== 'active') throw accessError('access/revoked', 'Access ID revoked');
    if (grant.tripId !== tripId || grant.ledgerToken !== access.ledger) throw accessError('access/invalid', 'Access grant does not match trip');
    try {
        const trip = JSON.parse(grant.payloadJson);
        if (trip?.tripId !== tripId || !trip?.days || typeof trip.days !== 'object' || Array.isArray(trip.days)) throw new Error('Trip payload mismatch');
        return trip;
    } catch (error) {
        throw accessError('access/invalid', 'Trip payload invalid');
    }
}

export async function initSyncEngine(tripId) {
    const currentRunId = ++syncRunId;
    syncContext = null;
    if (suggestionSyncService) {
        suggestionSyncService.destroy();
        suggestionSyncService = null;
    }
    window.suggestionSyncService = null;
    window.expensePayerAliases = {};
    publishLedgerAccess();
    if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
    if (unsubscribeExpenses) { unsubscribeExpenses(); unsubscribeExpenses = null; }
    if (unsubscribeParticipants) { unsubscribeParticipants(); unsubscribeParticipants = null; }
    if (participantHeartbeat) { window.clearInterval(participantHeartbeat); participantHeartbeat = null; }
    try {
        const roomParameters = ensureRoomParameters(tripId);
        if (!roomParameters) {
            setIdentityControlLocked(false);
            EXPENSE_KEY = `expenses-${tripId}-local-v2`;
            window.setExpenseStorageScope?.(tripId, null);
            setSyncUi('local', 'しおり未登録', 'しおり棚のADDへ、管理者から届いた配布IDを入力してください。');
            return;
        }
        const { roomId, accessId, ledgerToken } = roomParameters;
        setSyncUi('connecting', '共有ルームへ接続中…', '参加権限とルーム状態を確認しています。');
        setIdentityControlLocked(true);
        EXPENSE_KEY = `expenses-${tripId}-${ledgerToken}-v2`;
        window.setExpenseStorageScope?.(tripId, ledgerToken);
        let app;
        if (getApps().length === 0) {
            app = initializeApp(firebaseConfig);
        } else {
            app = getApp();
        }
        const auth = getAuth(app);

        let db;
        try {
            db = initializeFirestore(app, {
                localCache: persistentLocalCache({
                    tabManager: persistentMultipleTabManager()
                })
            });
        } catch (e) {
            db = getFirestore(app);
        }
        await signInAnonymously(auth);
        if (currentRunId !== syncRunId) return;
        const uid = auth.currentUser?.uid;
        if (!uid) throw new Error('Anonymous authentication failed');

        const { roomRef } = await createOrJoinRoom(db, uid, roomId, accessId);
        if (currentRunId !== syncRunId) return;
        const expensesCollection = collection(roomRef, 'expenses');
        syncContext = {
            db,
            roomRef,
            expensesCollection,
            uid,
            tripId,
            ledgerToken,
            roomReady: false,
            participantsReady: false,
            roomVerified: false,
            participantsVerified: false,
            memberCount: 0,
            logicalMemberCount: null,
            capacity: 2,
            deviceOwnerInitialized: false,
            memberIds: [],
            roomMemberIds: [],
            verifiedExpenses: null
        };
        publishLedgerAccess(uid, false);

        // Register participant nickname in Firestore
        const nickname = String(localStorage.getItem('user_nickname') || '名無し').trim().slice(0, 40) || '名無し';
        const deviceId = uid;
        const participantRef = doc(roomRef, 'participants', deviceId);
        const existingParticipant = await getDoc(participantRef);
        await setDoc(participantRef, {
            nickname: nickname,
            lastActive: serverTimestamp(),
            ...(existingParticipant.exists() ? {} : { joinedAt: serverTimestamp() })
        }, { merge: true });
        if (currentRunId !== syncRunId) return;
        participantHeartbeat = window.setInterval(() => {
            setDoc(participantRef, {
                nickname,
                lastActive: serverTimestamp()
            }, { merge: true }).catch(() => {});
        }, 60 * 1000);

        // Keep participant options derived only from current room members. This also
        // lets room.members changes immediately evict stale participant documents.
        let latestParticipantSnapshot = null;
        const refreshParticipants = () => {
            if (currentRunId !== syncRunId || !syncContext || !latestParticipantSnapshot) return;
            const allowedMemberIds = syncContext.roomReady ? new Set(syncContext.roomMemberIds) : null;
            const allParticipants = latestParticipantSnapshot.docs
                .map(item => {
                    const data = item.data();
                    return {
                        uid: item.id,
                        nickname: String(data?.nickname || '名無し').trim().slice(0, 40) || '名無し',
                        activeAt: data?.lastActive?.toMillis?.() || 0,
                        joinedAt: data?.joinedAt?.toMillis?.() || Number.MAX_SAFE_INTEGER
                    };
                })
                .filter(person => !allowedMemberIds || allowedMemberIds.has(person.uid))
                .sort((a, b) => a.joinedAt - b.joinedAt || a.uid.localeCompare(b.uid));
            const knownParticipantIds = new Set(allParticipants.map(person => person.uid));
            const missingMemberIds = syncContext.roomReady
                ? syncContext.roomMemberIds.filter(memberId => !knownParticipantIds.has(memberId))
                : [];
            const cutoff = Date.now() - PARTICIPANT_ACTIVE_MS;
            const canonicalByName = new Map();
            const payerAliases = {};
            allParticipants.forEach(person => {
                const nameKey = person.nickname.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ja-JP');
                const canonical = canonicalByName.get(nameKey) || person;
                if (!canonicalByName.has(nameKey)) canonicalByName.set(nameKey, canonical);
                payerAliases[person.uid] = canonical.uid;
            });
            missingMemberIds.forEach(memberId => {
                payerAliases[memberId] = memberId;
            });
            const optionData = [
                ...[...canonicalByName.values()].map(person => ({ id: person.uid, name: person.nickname })),
                ...missingMemberIds.map((memberId, index) => ({ id: memberId, name: `参加者 ${index + canonicalByName.size + 1}` }))
            ];
            const activeCanonicalIds = new Set(allParticipants
                .filter(person => person.activeAt >= cutoff)
                .map(person => payerAliases[person.uid]));
            const names = optionData.filter(person => activeCanonicalIds.has(person.id)).map(person => person.name);
            syncContext.memberIds = syncContext.roomReady
                ? [...syncContext.roomMemberIds]
                : allParticipants.map(person => person.uid);
            syncContext.logicalMemberCount = optionData.length;
            window.expensePayerAliases = payerAliases;
            window.memberNames = Object.fromEntries(allParticipants.map(person => [person.uid, person.nickname]));
            window.currentTripMembers = optionData;
            window.dispatchEvent(new CustomEvent('shiori-members-changed', { detail: optionData }));

            const pElem = document.getElementById('hero-participants');
            const displayNames = names.length > 0 ? names : [nickname];
            if (pElem) pElem.textContent = 'MEMBERS: ' + displayNames.join(', ');
            const participantsWereReady = syncContext.participantsReady;
            syncContext.participantsReady = true;
            renderLiveSyncState();
            if (!participantsWereReady && syncContext.roomReady) {
                flushPendingActions(syncContext.tripId, syncContext.ledgerToken).catch(() => {
                    setSyncUi('error', '台帳の送信に失敗しました', '通信状態を確認してください。入力内容はこの端末に残っています。');
                });
            }

            const deviceOwner = document.getElementById('device-owner');
            const expensePayer = document.getElementById('expense-payer');
            if (deviceOwner && expensePayer) {
                const savedOwner = deviceOwner.value;
                const savedPayer = expensePayer.value;
                const deviceOwnerId = payerAliases[uid] || optionData[0]?.id || uid;
                const canonicalSavedOwner = payerAliases[savedOwner] || savedOwner;
                const canonicalSavedPayer = payerAliases[savedPayer] || savedPayer;
                deviceOwner.replaceChildren(...optionData.map(member => new Option(member.name, member.id)));
                expensePayer.replaceChildren(...optionData.map(member => new Option(member.name, member.id)));
                if (!syncContext.deviceOwnerInitialized) {
                    deviceOwner.value = deviceOwnerId;
                    expensePayer.value = deviceOwnerId;
                    window.setLedgerDeviceOwner?.(deviceOwnerId);
                    syncContext.deviceOwnerInitialized = true;
                } else {
                    const optionIds = new Set(optionData.map(member => member.id));
                    deviceOwner.value = optionIds.has(canonicalSavedOwner) ? canonicalSavedOwner : deviceOwnerId;
                    expensePayer.value = optionIds.has(canonicalSavedPayer) ? canonicalSavedPayer : deviceOwner.value;
                }
            }

            if (window.recalculateExpenses) window.recalculateExpenses();
        };

        // Listen to participant updates for header display and PayPay select options.
        unsubscribeParticipants = onSnapshot(collection(roomRef, 'participants'), { includeMetadataChanges: true }, snapshot => {
            syncContext.participantsVerified = snapshot.metadata?.fromCache !== true;
            latestParticipantSnapshot = snapshot;
            refreshParticipants();
        }, error => {
            if (currentRunId !== syncRunId || !syncContext) return;
            console.error('Participant sync failed', error);
            window.expensePayerAliases = {};
            publishLedgerAccess('', false, /permission-denied|unauthenticated/.test(String(error?.code)) ? 'revoked' : 'offline');
            setIdentityControlLocked(false);
            setSyncUi('error', '参加者情報を同期できません', '管理者へ連絡し、Firestoreルールと登録リンクを確認してください。');
        });

        const cached = readCachedExpenses()
            .map(cleanExpense)
            .filter(expense => expense.pendingSync === true)
            .filter(validExpenseForSync);
        await Promise.all(cached.map(expense => persistAction({
            type: 'upsert',
            expense,
            tripId,
            ledgerToken
        })));
        if (currentRunId !== syncRunId) return;

        unsubscribeRoom = onSnapshot(roomRef, { includeMetadataChanges: true }, snapshot => {
            if (currentRunId !== syncRunId || !syncContext) return;
            const roomData = snapshot.data() || {};
            const members = roomData.members || {};
            const roomWasReady = syncContext.roomReady;
            syncContext.roomMemberIds = Object.keys(members);
            syncContext.memberCount = syncContext.roomMemberIds.length;
            syncContext.capacity = Number.isInteger(Number(roomData.capacity)) ? Number(roomData.capacity) : 2;
            syncContext.roomReady = true;
            syncContext.roomVerified = snapshot.metadata?.fromCache !== true;
            refreshParticipants();
            renderLiveSyncState();
            if (!roomWasReady && syncContext.participantsReady) {
                flushPendingActions(syncContext.tripId, syncContext.ledgerToken).catch(() => {
                    setSyncUi('error', '台帳の送信に失敗しました', '通信状態を確認してください。入力内容はこの端末に残っています。');
                });
            }
        }, error => {
            if (currentRunId !== syncRunId) return;
            if (suggestionSyncService) {
                suggestionSyncService.destroy();
                suggestionSyncService = null;
            }
            window.suggestionSyncService = null;
            window.dispatchEvent(new CustomEvent('shiori-suggestions-state', { detail: {
                state: /permission-denied|unauthenticated/.test(String(error?.code)) ? 'revoked' : 'offline'
            } }));
            window.expensePayerAliases = {};
            publishLedgerAccess('', false, /permission-denied|unauthenticated/.test(String(error?.code)) ? 'revoked' : 'offline');
            setIdentityControlLocked(false);
            setSyncUi('error', '配布ルームが停止されました', '管理者から新しい登録リンクを受け取ってください。');
        });

        unsubscribeExpenses = onSnapshot(expensesCollection, { includeMetadataChanges: true }, snapshot => {
            if (currentRunId !== syncRunId) return;
            if (snapshot.metadata?.fromCache === true || !navigator.onLine) return;
            const expenses = snapshot.docs
                .map(item => cleanExpense({ id: item.id, ...item.data() }))
                .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
            syncContext.verifiedExpenses = expenses;
            if (window.currentLedgerAccess?.live === true) emitRemoteExpenses(expenses);
        }, error => {
            if (currentRunId !== syncRunId) return;
            window.expensePayerAliases = {};
            publishLedgerAccess('', false, /permission-denied|unauthenticated/.test(String(error?.code)) ? 'revoked' : 'offline');
            setIdentityControlLocked(false);
            setSyncUi('error', '台帳を同期できません', '通信状態、または登録リンクの有効期限を確認してください。端末内の入力は残っています。');
        });

        if (!suggestionSyncService) {
            suggestionSyncService = createSuggestionSyncService({
                db,
                collection,
                doc,
                query,
                orderBy,
                limit,
                startAfter,
                documentId,
                FieldPath,
                deleteField,
                getDocs: getDocsFromServer,
                getAuthUid: () => auth.currentUser?.uid,
                onState: detail => window.dispatchEvent(new CustomEvent('shiori-suggestions-state', { detail })),
                onSnapshot,
                getDoc,
                setDoc,
                updateDoc,
                deleteDoc,
                runTransaction,
                serverTimestamp
            });
        }
        suggestionSyncService.setContext({
            tripId,
            roomId,
            authUid: uid
        });
        window.suggestionSyncService = suggestionSyncService;
        window.dispatchEvent(new CustomEvent('shiori-suggestions-ready'));

        if (currentRunId !== syncRunId) return;
        await flushPendingActions(tripId, ledgerToken);
    } catch (error) {
        if (currentRunId !== syncRunId) return;
        if (suggestionSyncService) {
            suggestionSyncService.destroy();
            suggestionSyncService = null;
        }
        window.suggestionSyncService = null;
        window.expensePayerAliases = {};
        const code = String(error?.code || '');
        publishLedgerAccess('', false, code.includes('permission-denied') ? 'revoked' : 'offline');
        if (code.includes('auth/operation-not-allowed')) {
            setSyncUi('error', '共有機能を利用できません', '管理者へ連絡してください。端末内では引き続き記録できます。');
        } else if (code.includes('permission-denied')) {
            setIdentityControlLocked(false);
            setSyncUi('error', '配布ルームが停止されました', '管理者から新しい登録リンクを受け取ってください。');
        } else {
            setIdentityControlLocked(false);
            setSyncUi('error', '台帳を同期できません', '通信状態を確認してください。端末内の入力は残っています。');
        }
    }
}

export function stopSyncEngine() {
    syncRunId++;
    syncContext = null;
    pendingActions.splice(0, pendingActions.length);
    if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
    if (unsubscribeExpenses) { unsubscribeExpenses(); unsubscribeExpenses = null; }
    if (unsubscribeParticipants) { unsubscribeParticipants(); unsubscribeParticipants = null; }
    if (participantHeartbeat) { window.clearInterval(participantHeartbeat); participantHeartbeat = null; }
    if (suggestionSyncService) {
        suggestionSyncService.destroy();
        suggestionSyncService = null;
    }
    window.suggestionSyncService = null;
    window.expensePayerAliases = {};
    publishLedgerAccess();
    setIdentityControlLocked(false);
}

async function getDbInstance() {
    try {
        let app;
        if (getApps().length === 0) {
            app = initializeApp(firebaseConfig);
        } else {
            app = getApp();
        }

        let db;
        try {
            db = initializeFirestore(app, {
                localCache: persistentLocalCache({
                    tabManager: persistentMultipleTabManager()
                })
            });
        } catch (e) {
            db = getFirestore(app);
        }

        const auth = getAuth(app);
        if (!auth.currentUser) {
            await signInAnonymously(auth);
        }
        return db;
    } catch (e) {
        console.error("Error initializing general db instance:", e);
        return syncContext?.db;
    }
}

window._redeemAccessId = redeemAccessId;
window._fetchManagedTripConfig = fetchManagedTripConfig;
window._initSyncEngine = initSyncEngine;
window._stopSyncEngine = stopSyncEngine;

window.addEventListener('offline', () => {
    if (window.currentTripId) publishLedgerAccess('', false, 'offline');
});

window.addEventListener('online', () => {
    const tripId = String(window.currentTripId || '');
    if (!tripId) return;
    publishLedgerAccess('', false, 'offline');
    initSyncEngine(tripId).catch(() => {
        publishLedgerAccess('', false, 'offline');
    });
});
