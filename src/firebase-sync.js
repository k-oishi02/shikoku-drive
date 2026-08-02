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
    getDocs,
    onSnapshot,
    serverTimestamp,
    setDoc,
    updateDoc,
    writeBatch,
    initializeFirestore,
    getFirestore,
    persistentLocalCache,
    persistentMultipleTabManager
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';

const firebaseConfig = {
    apiKey: 'AIzaSyCOh5MtRbplm-46FETshOQAGHqyQ4fD4tA',
    authDomain: 'shikoku-drive.firebaseapp.com',
    projectId: 'shikoku-drive',
    storageBucket: 'shikoku-drive.firebasestorage.app',
    messagingSenderId: '100077385758',
    appId: '1:100077385758:web:dd63588317da1edc9b560f',
    measurementId: 'G-VV9YHYW85C'
};

let EXPENSE_KEY = 'shikoku-drive-expenses-v1';
const pendingActions = [];
let syncContext = null;
let inviteUrl = '';
let unsubscribeRoom = null;
let unsubscribeExpenses = null;
let unsubscribeParticipants = null;
let participantHeartbeat = null;
let syncRunId = 0;
const PARTICIPANT_ACTIVE_MS = 5 * 60 * 1000;
const TRIP_ACCESS_KEY = 'participant-trip-access-v1';
const ACCESS_ID_PATTERN = /^[A-Z2-9]{12}$/;

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
    const url = new URL(window.location.href);
    let roomId = url.searchParams.get('ledger');
    let invite = url.searchParams.get('invite');
    const validLedger = value => /^[A-Za-z0-9_-]{43}$/.test(String(value || ''));
    const validInvite = value => /^[A-Za-z0-9_-]{43}$/.test(String(value || '')) || ACCESS_ID_PATTERN.test(String(value || ''));
    if (!validLedger(roomId) || !validInvite(invite)) {
        const stored = storedAccessForTrip(tripId);
        roomId = stored?.ledger || '';
        invite = stored?.invite || '';
    }
    const roomCode = document.getElementById('sync-room-code');
    if (!validLedger(roomId) || !validInvite(invite)) {
        inviteUrl = '';
        if (roomCode) roomCode.textContent = 'VIEW ONLY';
        return null;
    }
    inviteUrl = url.toString();
    if (roomCode) roomCode.textContent = `ROOM: ${roomId.slice(-6).toUpperCase()}`;
    return { roomId: `${tripId}_${roomId}`, invite, ledgerToken: roomId };
}

function setSyncUi(mode, title, message) {
    const badge = document.getElementById('sync-badge');
    const titleEl = document.getElementById('sync-title');
    const status = document.getElementById('sync-status');
    const actions = document.getElementById('share-room-actions');
    const note = document.getElementById('sync-note');
    const members = document.getElementById('hero-participants');
    const expenseSubmit = document.querySelector('#expense-form .expense-submit');
    const expenseSyncNote = document.getElementById('expense-sync-note');
    if (badge) {
        badge.classList.toggle('live', mode === 'live');
        badge.classList.toggle('error', mode === 'error');
        badge.classList.toggle('local', mode === 'local');
        badge.textContent = mode === 'live' ? 'LIVE SYNC' : mode === 'error' ? 'ACTION NEEDED' : mode === 'local' ? 'VIEW ONLY' : 'CONNECTING';
    }
    if (titleEl) titleEl.textContent = title;
    if (status) status.textContent = message;
    if (actions) actions.hidden = true;
    if (note) note.hidden = mode !== 'live';
    if (members && mode !== 'live') {
        members.textContent = mode === 'error'
            ? 'MEMBERS: 同期なし'
            : mode === 'local'
                ? 'MEMBERS: この端末のみ'
                : 'MEMBERS: 接続中…';
    }
    if (expenseSubmit) {
        expenseSubmit.textContent = mode === 'live'
            ? 'ADD & SHARE'
            : mode === 'connecting'
                ? 'SAVE & SYNC SOON'
                : 'SAVE OFFLINE';
        expenseSubmit.dataset.syncMode = mode;
    }
    if (expenseSyncNote) {
        expenseSyncNote.textContent = mode === 'live'
            ? 'ADD & SHAREで、同じ配布先の参加者全員と管理者へリアルタイム共有します。'
            : mode === 'local'
                ? 'この端末だけに保存されます。共有するには、しおり棚のADDから配布IDを登録してください。'
                : mode === 'error'
                    ? '通信を回復すると自動同期します。現在の入力はこの端末に保存されます。'
                    : '接続確認中です。入力は端末へ保存し、接続後に自動共有します。';
    }
}

function setShareEnabled(enabled, label = '招待リンクをコピー') {
    const button = document.getElementById('share-link-button');
    if (!button) return;
    button.disabled = !enabled;
    button.textContent = label;
}

function renderLiveSyncState() {
    if (!syncContext?.roomReady || !syncContext?.participantsReady) return;
    const count = Number(syncContext.memberCount || 0);
    const capacity = Math.max(count, Number(syncContext.capacity || 2));
    const roleLabel = syncContext.role === 'owner' ? '作成者' : '参加者';
    setSyncUi('live', `${roleLabel}として接続済み`, `${count}/${capacity}名が登録済み。追加・削除は自動同期されます。`);
    const roomFull = count >= capacity;
    setShareEnabled(false, roomFull ? `${capacity}名登録済み` : '管理者の登録リンクを使用');
    const note = document.getElementById('sync-note');
    if (note) {
        note.textContent = roomFull
            ? `定員${capacity}名の同期が有効です。入力内容は全員へ自動反映されます。`
            : `あと${capacity - count}名登録できます。管理者の登録リンク、または同じ配布IDを使用してください。`;
    }
}

function setIdentityControlLocked(locked) {
    const deviceOwner = document.getElementById('device-owner');
    if (!deviceOwner) return;
    deviceOwner.disabled = locked;
    deviceOwner.title = locked ? '招待ルームの参加順から自動設定されています' : '';
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
    return {
        id: String(expense.id || '').slice(0, 120),
        amount: Math.max(0, Math.round(Number(expense.amount) || 0)),
        payer: String(expense.payer || '').slice(0, 128),
        category: String(expense.category || 'その他').slice(0, 20),
        note: String(expense.note || '').slice(0, 40),
        comment: String(expense.comment || '').slice(0, 80),
        createdAt: String(expense.createdAt || new Date().toISOString()).slice(0, 40)
    };
}

function expenseForCurrentRoom(expense) {
    const cleaned = cleanExpense(expense);
    const memberIds = Array.isArray(syncContext?.memberIds) ? syncContext.memberIds : [];
    if (memberIds.includes(cleaned.payer)) return cleaned;
    const visibleOrder = (Array.isArray(window.currentTripMembers) ? window.currentTripMembers : [])
        .map(member => String(member?.id || ''))
        .filter(id => memberIds.includes(id));
    if (cleaned.payer === 'aoi') cleaned.payer = visibleOrder[0] || syncContext?.uid || '';
    else if (cleaned.payer === 'kotaro') cleaned.payer = visibleOrder[1] || visibleOrder[0] || syncContext?.uid || '';
    else cleaned.payer = syncContext?.uid || visibleOrder[0] || '';
    return cleaned;
}

function activeParticipantEntries(snapshot) {
    const cutoff = Date.now() - PARTICIPANT_ACTIVE_MS;
    return snapshot.docs
        .map(item => {
            const data = item.data();
            const activeAt = data?.lastActive?.toMillis?.() || 0;
            const nickname = String(data?.nickname || '').trim().slice(0, 40);
            return nickname && activeAt >= cutoff ? { uid: item.id, nickname, activeAt } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.activeAt - a.activeAt);
}

function activeParticipantNames(snapshot) {
    return [...new Set(activeParticipantEntries(snapshot).map(item => item.nickname))];
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
    window.dispatchEvent(new CustomEvent('shikoku-expenses-remote', { detail: expenses }));
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

    const { expensesCollection, db } = syncContext;
    if (action.type === 'upsert' && action.expense && !syncContext.participantsReady) {
        if (queueWhenUnavailable) pendingActions.push({ ...action, tripId: actionTripId, ledgerToken: actionLedgerToken });
        return false;
    }
    if (action.type === 'upsert' && action.expense) {
        const expense = expenseForCurrentRoom(action.expense);
        if (!validExpenseForSync(expense)) return true;
        await setDoc(doc(expensesCollection, expense.id), expense);
    } else if (action.type === 'remove' && action.id && !String(action.id).includes('/')) {
        await deleteDoc(doc(expensesCollection, String(action.id)));
    } else if (action.type === 'clear') {
        const snapshot = await getDocs(expensesCollection);
        const batch = writeBatch(db);
        snapshot.forEach(item => batch.delete(item.ref));
        await batch.commit();
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
window.copyLedgerInviteLink = async function () {
    const button = document.getElementById('share-link-button');
    try {
        await navigator.clipboard.writeText(inviteUrl);
        if (button) button.textContent = 'コピーしました！';
        window.setTimeout(() => {
            if (button) button.textContent = '招待リンクをコピー';
        }, 1800);
    } catch (error) {
        window.prompt('このリンクを同行者へ送ってください', inviteUrl);
    }
};

window.addEventListener('shikoku-expense-action', event => {
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
    persistAction(action).then(shared => {
        const note = document.getElementById('expense-sync-note');
        if (!note) return;
        if (shared) {
            note.textContent = action.type === 'remove'
                ? '共有台帳から削除しました。参加者全員と管理者へ反映されます。'
                : '共有しました。参加者全員と管理者の台帳へ反映されます。';
        } else if (/^[A-Za-z0-9_-]{43}$/.test(ledgerToken)) {
            note.textContent = '端末に保存しました。接続が完了すると参加者全員と管理者へ自動共有します。';
        } else {
            note.textContent = 'この端末だけに保存しました。共有するには、しおり棚のADDから配布IDを登録してください。';
        }
    }).catch(() => {
        setSyncUi('error', '同期に失敗しました', '通信状態を確認してください。入力内容はこの端末に残っています。');
    });
});

async function createOrJoinRoom(db, uid, roomId, invite) {
    const roomRef = doc(db, 'rooms', roomId);
    const inviteHash = await sha256(invite);
    try {
        const currentRoom = await getDoc(roomRef);
        if (currentRoom.exists()) {
            const members = currentRoom.data().members || {};
            if (members[uid]) return { roomRef, role: 'member' };
        }
    } catch (readError) {
        // Non-members cannot read a room before proving the invite token.
    }
    await updateDoc(roomRef, {
        [`members.${uid}`]: true,
        joined: true,
        joinProof: inviteHash,
        updatedAt: serverTimestamp()
    });
    return { roomRef, role: 'member' };
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
    const accessId = normalizeAccessId(access?.invite);
    const legacyInvite = /^[A-Za-z0-9_-]{43}$/.test(String(access?.invite || ''));
    if (!ACCESS_ID_PATTERN.test(accessId) && !legacyInvite) throw accessError('access/invalid', 'Invalid saved access');
    if (legacyInvite) throw accessError('access/revoked', 'Legacy invite must be replaced with a distribution ID');
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
    setShareEnabled(false);
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
        const { roomId, invite, ledgerToken } = roomParameters;
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

        const { roomRef, role } = await createOrJoinRoom(db, uid, roomId, invite);
        if (currentRunId !== syncRunId) return;
        const expensesCollection = collection(roomRef, 'expenses');
        syncContext = {
            db,
            roomRef,
            expensesCollection,
            uid,
            tripId,
            ledgerToken,
            role,
            roomReady: false,
            participantsReady: false,
            memberCount: 0,
            capacity: 2,
            deviceOwnerInitialized: false,
            memberIds: []
        };

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

        // Listen to participant updates for header display and PayPay select options
        unsubscribeParticipants = onSnapshot(collection(roomRef, 'participants'), (snapshot) => {
            if (currentRunId !== syncRunId || !syncContext) return;
            const allParticipants = snapshot.docs
                .map(item => {
                    const data = item.data();
                    return {
                        uid: item.id,
                        nickname: String(data?.nickname || '名無し').trim().slice(0, 40) || '名無し',
                        activeAt: data?.lastActive?.toMillis?.() || 0,
                        joinedAt: data?.joinedAt?.toMillis?.() || Number.MAX_SAFE_INTEGER
                    };
                })
                .sort((a, b) => a.joinedAt - b.joinedAt || a.uid.localeCompare(b.uid));
            const cutoff = Date.now() - PARTICIPANT_ACTIVE_MS;
            const names = [...new Set(allParticipants
                .filter(item => item.activeAt >= cutoff)
                .map(item => item.nickname))];
            const optionData = allParticipants.map(item => ({ id: item.uid, name: item.nickname }));
            syncContext.memberIds = optionData.map(member => member.id);
            window.memberNames = Object.fromEntries(optionData.map(member => [member.id, member.name]));
            window.currentTripMembers = optionData;

            const pElem = document.getElementById('hero-participants');
            const displayNames = names.length > 0 ? names : [nickname];
            if (pElem) pElem.textContent = `MEMBERS: ${displayNames.join(', ')}`;
            const participantsWereReady = syncContext.participantsReady;
            syncContext.participantsReady = true;
            renderLiveSyncState();
            if (!participantsWereReady) {
                flushPendingActions(syncContext.tripId, syncContext.ledgerToken).catch(() => {
                    setSyncUi('error', '台帳の送信に失敗しました', '通信状態を確認してください。入力内容はこの端末に残っています。');
                });
            }

            const deviceOwner = document.getElementById('device-owner');
            const expensePayer = document.getElementById('expense-payer');
            if (deviceOwner && expensePayer) {
                const savedOwner = deviceOwner.value;
                const savedPayer = expensePayer.value;
                const deviceOwnerId = uid;
                deviceOwner.replaceChildren(...optionData.map(member => new Option(member.name, member.id)));
                expensePayer.replaceChildren(...optionData.map(member => new Option(member.name, member.id)));
                if (!syncContext.deviceOwnerInitialized) {
                    deviceOwner.value = deviceOwnerId;
                    expensePayer.value = deviceOwnerId;
                    localStorage.setItem('shikoku-drive-device-owner-v1', JSON.stringify(deviceOwnerId));
                    syncContext.deviceOwnerInitialized = true;
                } else {
                    const optionIds = new Set(optionData.map(member => member.id));
                    deviceOwner.value = optionIds.has(savedOwner) ? savedOwner : deviceOwnerId;
                    expensePayer.value = optionIds.has(savedPayer) ? savedPayer : deviceOwner.value;
                }
            }

            if (window.recalculateExpenses) window.recalculateExpenses();
        }, (error) => {
            if (currentRunId !== syncRunId || !syncContext) return;
            console.error('Participant sync failed', error);
            setSyncUi('error', '参加者情報を同期できません', '管理者へ連絡し、Firestoreルールと招待リンクを確認してください。');
            setShareEnabled(false);
        });


        const cached = readCachedExpenses()
            .map(cleanExpense)
            .filter(validExpenseForSync);
        await Promise.all(cached.map(expense => persistAction({
            type: 'upsert',
            expense,
            tripId,
            ledgerToken
        })));
        if (currentRunId !== syncRunId) return;

        unsubscribeRoom = onSnapshot(roomRef, snapshot => {
            if (currentRunId !== syncRunId || !syncContext) return;
            const roomData = snapshot.data() || {};
            const members = roomData.members || {};
            syncContext.memberCount = Object.keys(members).length;
            syncContext.capacity = Number.isInteger(Number(roomData.capacity)) ? Number(roomData.capacity) : 2;
            syncContext.roomReady = true;
            renderLiveSyncState();
        }, () => {
            setSyncUi('error', '招待ルームが停止されました', '管理者から新しい招待リンクを受け取ってください。');
        });

        unsubscribeExpenses = onSnapshot(expensesCollection, snapshot => {
            if (currentRunId !== syncRunId) return;
            const expenses = snapshot.docs
                .map(item => cleanExpense({ id: item.id, ...item.data() }))
                .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
            emitRemoteExpenses(expenses);
        }, () => {
            setSyncUi('error', '台帳を同期できません', '通信状態、または招待リンクの有効期限を確認してください。端末内の入力は残っています。');
        });

        if (currentRunId !== syncRunId) return;
        setShareEnabled(true);
        await flushPendingActions(tripId, ledgerToken);
    } catch (error) {
        if (currentRunId !== syncRunId) return;
        const code = String(error?.code || '');
        if (code.includes('auth/operation-not-allowed')) {
            setSyncUi('error', '共有機能を利用できません', '管理者へ連絡してください。端末内では引き続き記録できます。');
        } else if (code.includes('permission-denied') || code.includes('not-found')) {
            setSyncUi('error', '配布IDが無効です', '配布が停止された可能性があります。管理者から新しい配布IDを受け取ってください。');
        } else {
            setSyncUi('error', '共有同期を開始できません', '通信状態を確認してください。端末内の入力は残っています。');
        }
        setIdentityControlLocked(false);
        setShareEnabled(false);
    }
}

export function stopSyncEngine() {
    syncRunId += 1;
    syncContext = null;
    inviteUrl = '';
    pendingActions.splice(0, pendingActions.length);
    setShareEnabled(false);
    if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
    if (unsubscribeExpenses) { unsubscribeExpenses(); unsubscribeExpenses = null; }
    if (unsubscribeParticipants) { unsubscribeParticipants(); unsubscribeParticipants = null; }
    if (participantHeartbeat) { window.clearInterval(participantHeartbeat); participantHeartbeat = null; }
}

export async function getDbInstance() {
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
