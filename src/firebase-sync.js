import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
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

function ensureRoomParameters(tripId) {
    const url = new URL(window.location.href);
    let roomId = url.searchParams.get('ledger');
    let invite = url.searchParams.get('invite');
    if (!roomId || !invite) {
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
    return { roomId: `${tripId}_${roomId}`, invite };
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
        id: String(expense.id || ''),
        amount: Math.max(0, Math.round(Number(expense.amount) || 0)),
        payer: expense.payer === 'kotaro' ? 'kotaro' : 'aoi',
        category: String(expense.category || 'その他').slice(0, 20),
        note: String(expense.note || '').slice(0, 40),
        comment: String(expense.comment || '').slice(0, 80),
        createdAt: String(expense.createdAt || new Date().toISOString())
    };
}

function emitRemoteExpenses(expenses) {
    window.dispatchEvent(new CustomEvent('shikoku-expenses-remote', { detail: expenses }));
}

async function persistAction(action) {
    if (!syncContext) {
        pendingActions.push(action);
        return;
    }

    const { expensesCollection, db } = syncContext;
    if (action.type === 'upsert' && action.expense) {
        const expense = cleanExpense(action.expense);
        await setDoc(doc(expensesCollection, expense.id), expense);
    } else if (action.type === 'remove' && action.id) {
        await deleteDoc(doc(expensesCollection, String(action.id)));
    } else if (action.type === 'clear') {
        const snapshot = await getDocs(expensesCollection);
        const batch = writeBatch(db);
        snapshot.forEach(item => batch.delete(item.ref));
        await batch.commit();
    }
}

async function flushPendingActions() {
    while (pendingActions.length) {
        const action = pendingActions.shift();
        await persistAction(action);
    }
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
        window.prompt('このリンクを蒼さんへ送ってください', inviteUrl);
    }
};

window.addEventListener('shikoku-expense-action', event => {
    persistAction(event.detail).catch(() => {
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
    EXPENSE_KEY = `expenses-${tripId}-v1`;
    try {
        const { roomId, invite } = ensureRoomParameters(tripId);
        const app = initializeApp(firebaseConfig);
        const auth = getAuth(app);
        const db = initializeFirestore(app, {
            localCache: persistentLocalCache({
                tabManager: persistentMultipleTabManager()
            })
        });
        await signInAnonymously(auth);
        const uid = auth.currentUser?.uid;
        if (!uid) throw new Error('Anonymous authentication failed');

        const { roomRef, role, created } = await createOrJoinRoom(db, uid, roomId, invite);
        const expensesCollection = collection(roomRef, 'expenses');
        syncContext = { db, roomRef, expensesCollection, uid };

        if (created) {
            const cached = readCachedExpenses();
            await Promise.all(cached.map(expense => {
                const clean = cleanExpense(expense);
                return setDoc(doc(expensesCollection, clean.id), clean);
            }));
        }

        onSnapshot(roomRef, snapshot => {
            const members = snapshot.data()?.members || {};
            const count = Object.keys(members).length;
            const roleLabel = role === 'owner' ? '作成者' : '参加者';
            setSyncUi('live', `${roleLabel}として接続済み`, `${count}/2台が接続済み。追加・削除は自動同期されます。`);
        }, () => {
            setSyncUi('error', '共有ルームを確認できません', 'Firestoreのセキュリティルールを確認してください。');
        });

        onSnapshot(expensesCollection, snapshot => {
            const expenses = snapshot.docs
                .map(item => cleanExpense({ id: item.id, ...item.data() }))
                .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
            emitRemoteExpenses(expenses);
        }, () => {
            setSyncUi('error', '台帳を同期できません', 'Firestoreのセキュリティルールを確認してください。');
        });

        setShareEnabled(true);
        await flushPendingActions();
    } catch (error) {
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
