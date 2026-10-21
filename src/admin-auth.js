/**
 * Admin Authentication & Administrator Verification
 */

import { signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { $, setBusy, showToast, copyText } from './admin-ui.js';

export function setAuthScreen({ message, canSignIn = false, user = null, accessDenied = false }) {
  $('auth-state').textContent = message;
  $('admin-sign-in').hidden = !canSignIn;
  $('admin-access-help').hidden = !accessDenied;
  $('admin-uid').textContent = user?.uid || '—';
  $('admin-auth').hidden = false;
  $('admin-app').hidden = true;
}

export async function verifyAdministrator(db, user) {
  let timeoutId;
  try {
    const snapshot = await Promise.race([
      getDoc(doc(db, 'admins', user.uid)),
      new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error('Admin verification timed out')), 10000);
      })
    ]);
    if (!snapshot.exists() || snapshot.data()?.active !== true) return null;
    const data = snapshot.data();
    return { ...data, role: data.role === 'editor' ? 'editor' : 'owner' };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

export async function enterAdmin({ user, profile, store, onEnter }) {
  const currentRole = profile?.role === 'editor' ? 'editor' : 'owner';
  store.setState({
    currentUser: user,
    currentRole
  });
  $('admin-account').textContent = `${currentRole === 'owner' ? 'OWNER' : 'EDITOR'} · ${user.email || user.displayName || user.uid}`;
  $('roles-nav').hidden = currentRole !== 'owner';
  $('admin-auth').hidden = true;
  $('admin-app').hidden = false;
  if (typeof onEnter === 'function') {
    await onEnter();
  }
}

export async function handleAuthState({ user, db, store, onEnter, stopLiveListeners }) {
  if (!user) {
    if (typeof stopLiveListeners === 'function') stopLiveListeners();
    store.setState({ currentUser: null });
    setAuthScreen({ message: 'Googleアカウントで管理者認証してください。', canSignIn: true });
    return;
  }
  setAuthScreen({ message: '管理者権限を確認しています…' });
  try {
    const profile = await verifyAdministrator(db, user);
    if (!profile) {
      setAuthScreen({
        message: `${user.email || 'このアカウント'} は、まだ管理者として登録されていません。`,
        user,
        canSignIn: true,
        accessDenied: true
      });
      return;
    }
    await enterAdmin({ user, profile, store, onEnter });
  } catch (error) {
    console.error(error);
    setAuthScreen({
      message: 'Firestoreの管理者確認に失敗しました。ルールの公開と admins ドキュメントを確認してください。',
      user,
      canSignIn: true,
      accessDenied: true
    });
  }
}

export async function signInAdmin(auth, googleProvider) {
  setBusy($('admin-sign-in'), true, 'ログイン中…');
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    if (error.code !== 'auth/popup-closed-by-user') {
      showToast(`ログインできません: ${error.message}`, true);
    }
  } finally {
    setBusy($('admin-sign-in'), false);
  }
}

export function signOutAdmin(auth, confirmLeave) {
  if (typeof confirmLeave === 'function' && !confirmLeave()) return;
  signOut(auth);
}

export function initAdminAuth({ auth, db, store, googleProvider, onEnter, stopLiveListeners, confirmLeave }) {
  $('admin-sign-in').addEventListener('click', () => signInAdmin(auth, googleProvider));
  $('admin-sign-out').addEventListener('click', () => signOutAdmin(auth, confirmLeave));
  $('copy-admin-uid').addEventListener('click', () => copyText($('admin-uid').textContent, 'UIDをコピーしました。'));
}
