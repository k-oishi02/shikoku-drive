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

function randomToken(byteLength = 32) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

function getOrCreateDeviceId() {
    let id = localStorage.getItem('device_id');
    if (!id) {
        id = 'dev_' + randomToken(16);
        localStorage.setItem('device_id', id);
    }
    return id;
}

function ensureRoomParameters(tripId) {
    const url = new URL(window.location.href);
    let roomId = url.searchParams.get('ledger');
    let invite = url.searchParams.get('invite');
    const validToken = value => /^[A-Za-z0-9_-]{43}$/.test(String(value || ''));
    if (!validToken(roomId) || !validToken(invite)) {
        roomId = randomToken();
        invite = randomToken();
        url.searchParams.set('ledger', roomId);
        url.searchParams.set('invite', invite);
        url.searchParams.delete('v');
        history.replaceState(null, '', url);
    }
    inviteUrl = url.toString();
    const roomCode = document.getElementById('sync-room-code');
    if (roomCode) roomCode.textContent = `ROOM: ${roomId.slice(-6).toUpperCase()}`;
    return { roomId: `${tripId}_${roomId}`, invite, ledgerToken: roomId };
}

function setSyncUi(mode, title, message) {
    const badge = document.getElementById('sync-badge');
    const titleEl = document.getElementById('sync-title');
    const status = document.getElementById('sync-status');
    if (badge) {
        badge.classList.toggle('live', mode === 'live');
        badge.classList.toggle('error', mode === 'error');
        badge.textContent = mode === 'live' ? 'LIVE SYNC' : mode === 'error' ? 'ACTION NEEDED' : 'CONNECTING';
    }
    if (titleEl) titleEl.textContent = title;
    if (status) status.textContent = message;
}

function setShareEnabled(enabled) {
    const button = document.getElementById('share-link-button');
    if (button) button.disabled = !enabled;
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
        payer: expense.payer === 'kotaro' ? 'kotaro' : 'aoi',
        category: String(expense.category || 'その他').slice(0, 20),
        note: String(expense.note || '').slice(0, 40),
        comment: String(expense.comment || '').slice(0, 80),
        createdAt: String(expense.createdAt || new Date().toISOString()).slice(0, 40)
    };
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
    if (!syncContext || syncContext.tripId !== actionTripId) {
        if (queueWhenUnavailable && actionTripId === String(window.currentTripId || '')) {
            pendingActions.push({ ...action, tripId: actionTripId });
        }
        return false;
    }

    const { expensesCollection, db } = syncContext;
    if (action.type === 'upsert' && action.expense) {
        const expense = cleanExpense(action.expense);
        if (!validExpenseForSync(expense)) return false;
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

async function flushPendingActions(tripId) {
    const queued = pendingActions.splice(0, pendingActions.length);
    const retry = [];
    for (const action of queued) {
        if (action.tripId !== tripId) {
            retry.push(action);
            continue;
        }
        try {
            await persistAction(action, false);
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
    const action = { ...(event.detail || {}), tripId: String(window.currentTripId || '') };
    persistAction(action).catch(() => {
        setSyncUi('error', '同期に失敗しました', '通信状態を確認してください。入力内容はこの端末に残っています。');
    });
});

async function createOrJoinRoom(db, uid, roomId, invite) {
    const roomRef = doc(db, 'rooms', roomId);
    const inviteHash = await sha256(invite);
    let role = 'member';
    let created = false;

    try {
        await setDoc(roomRef, {
            createdBy: uid,
            members: { [uid]: true },
            inviteHash,
            joined: false,
            createdAt: serverTimestamp()
        });
        created = true;
        role = 'owner';
    } catch (createError) {
        try {
            const currentRoom = await getDoc(roomRef);
            if (!currentRoom.exists()) throw createError;
            role = currentRoom.data().createdBy === uid ? 'owner' : 'member';
        } catch (readError) {
            await updateDoc(roomRef, {
                [`members.${uid}`]: true,
                joined: true,
                joinProof: inviteHash
            });
            role = 'member';
        }
    }

    return { roomRef, role, created };
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
        const { roomId, invite, ledgerToken } = ensureRoomParameters(tripId);
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
        syncContext = { db, roomRef, expensesCollection, uid, tripId, ledgerToken, deviceOwnerInitialized: false };

        // Register participant nickname in Firestore
        const nickname = String(localStorage.getItem('user_nickname') || '名無し').trim().slice(0, 40) || '名無し';
        const deviceId = uid;
        const participantRef = doc(db, 'trips', tripId, 'participants', deviceId);
        await setDoc(participantRef, {
            nickname: nickname,
            lastActive: serverTimestamp()
        }, { merge: true });
        if (currentRunId !== syncRunId) return;
        participantHeartbeat = window.setInterval(() => {
            setDoc(participantRef, {
                nickname,
                lastActive: serverTimestamp()
            }, { merge: true }).catch(() => {});
        }, 60 * 1000);

        // Listen to participant updates for header display and PayPay select options
        unsubscribeParticipants = onSnapshot(collection(db, 'trips', tripId, 'participants'), (snapshot) => {
            if (currentRunId !== syncRunId || !syncContext) return;
            const participants = activeParticipantEntries(snapshot);
            const names = [...new Set(participants.map(item => item.nickname))];

            const otherName = participants.find(item => item.uid !== uid)?.nickname;
            window.memberNames = role === 'owner'
                ? { aoi: nickname, kotaro: otherName || 'メンバー2' }
                : { aoi: otherName || 'メンバー1', kotaro: nickname };

            window.currentTripMembers = [
                { id: 'aoi', name: window.memberNames.aoi },
                { id: 'kotaro', name: window.memberNames.kotaro }
            ];

            // Update UI elements
            const pElem = document.getElementById('hero-participants');
            if (pElem) {
                pElem.textContent = `MEMBERS: ${names.join(', ')}`;
            }

            const deviceOwner = document.getElementById('device-owner');
            const expensePayer = document.getElementById('expense-payer');
            if (deviceOwner && expensePayer) {
                const savedOwner = deviceOwner.value;
                const savedPayer = expensePayer.value;
                const deviceOwnerId = role === 'owner' ? 'aoi' : 'kotaro';

                const optionData = [
                    { id: 'aoi', name: window.memberNames.aoi },
                    { id: 'kotaro', name: window.memberNames.kotaro }
                ];
                deviceOwner.replaceChildren(...optionData.map(member => new Option(member.name, member.id)));
                expensePayer.replaceChildren(...optionData.map(member => new Option(member.name, member.id)));

                if (!syncContext.deviceOwnerInitialized) {
                    deviceOwner.value = deviceOwnerId;
                    expensePayer.value = deviceOwnerId;
                    localStorage.setItem('shikoku-drive-device-owner-v1', JSON.stringify(deviceOwnerId));
                    syncContext.deviceOwnerInitialized = true;
                } else {
                    deviceOwner.value = savedOwner || deviceOwnerId;
                    expensePayer.value = savedPayer || deviceOwner.value;
                }
            }

            if (window.recalculateExpenses) {
                window.recalculateExpenses();
            }
        });


        const cached = readCachedExpenses()
            .map(cleanExpense)
            .filter(validExpenseForSync);
        await Promise.all(cached.map(expense =>
            setDoc(doc(expensesCollection, expense.id), expense)
        ));
        if (currentRunId !== syncRunId) return;

        unsubscribeRoom = onSnapshot(roomRef, snapshot => {
            if (currentRunId !== syncRunId) return;
            const members = snapshot.data()?.members || {};
            const count = Object.keys(members).length;
            const roleLabel = role === 'owner' ? '作成者' : '参加者';
            setSyncUi('live', `${roleLabel}として接続済み`, `${count}/2台が登録済み。追加・削除は自動同期されます。`);
        }, () => {
            setSyncUi('error', '共有ルームを確認できません', 'Firestoreのセキュリティルールを確認してください。');
        });

        unsubscribeExpenses = onSnapshot(expensesCollection, snapshot => {
            if (currentRunId !== syncRunId) return;
            const expenses = snapshot.docs
                .map(item => cleanExpense({ id: item.id, ...item.data() }))
                .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
            emitRemoteExpenses(expenses);
        }, () => {
            setSyncUi('error', '台帳を同期できません', 'Firestoreのセキュリティルールを確認してください。');
        });

        if (currentRunId !== syncRunId) return;
        setShareEnabled(true);
        await flushPendingActions(tripId);
    } catch (error) {
        if (currentRunId !== syncRunId) return;
        const code = String(error?.code || '');
        if (code.includes('auth/operation-not-allowed')) {
            setSyncUi('error', '匿名認証が無効です', 'Firebase Authenticationで「匿名」を有効にしてください。');
        } else if (code.includes('permission-denied')) {
            setSyncUi('error', 'Firestoreルールが未設定です', '指定のセキュリティルールをFirebase Consoleへ貼り付けてください。');
        } else {
            setSyncUi('error', '共有同期を開始できません', 'Firebase設定・Firestore・通信状態を確認してください。');
        }
        setShareEnabled(false);
    }
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

export async function listenToTripParticipants(tripId, callback) {
    const db = await getDbInstance();
    if (!db) {
        callback([]);
        return () => {};
    }
    const q = collection(db, 'trips', tripId, 'participants');
    return onSnapshot(q, (snapshot) => {
        const names = activeParticipantNames(snapshot);
        callback(names);
    }, (error) => {
        console.error("Error monitoring participants for trip:", tripId, error);
        callback([]);
    });
}

window._initSyncEngine = initSyncEngine;
window.listenToTripParticipants = listenToTripParticipants;




