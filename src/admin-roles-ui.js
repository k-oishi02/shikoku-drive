/**
 * Admin Roles View Controller (View 04: ADMINS)
 *
 * Manages administrator whitelist (owners vs. editors), role modifications, and deactivations.
 */

import { collection, doc, getDocs, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { $, makeElement, showToast } from './admin-ui.js';

export async function loadAdminRoles(db, store) {
  if (store.getState().currentRole !== 'owner') return;
  const list = $('roles-list');
  if (list) list.textContent = '管理者を読み込んでいます…';
  try {
    const snapshot = await getDocs(collection(db, 'admins'));
    const adminProfiles = snapshot.docs.map(item => ({ uid: item.id, ...item.data() }));
    store.setState({ adminProfiles });
    renderAdminRoles(db, store);
  } catch (error) {
    if (list) list.textContent = `管理者を読み込めません: ${error.message}`;
  }
}

export function renderAdminRoles(db, store) {
  const list = $('roles-list');
  if (!list) return;
  list.replaceChildren();
  const state = store.getState();
  const profiles = state.adminProfiles || [];
  if ($('roles-count')) $('roles-count').textContent = `${profiles.length}名`;

  [...profiles].sort((a, b) => String(a.name || a.email || a.uid).localeCompare(String(b.name || b.email || b.uid), 'ja')).forEach(profile => {
    const row = makeElement('article', 'distribution-card');
    const head = makeElement('div', 'distribution-head');
    head.append(makeElement('span', 'pill', profile.role === 'editor' ? '編集者' : 'オーナー'));
    head.append(makeElement('span', 'muted small', profile.active === false ? '停止中' : '有効'));
    row.append(head, makeElement('h3', '', profile.name || profile.email || '管理者'));
    row.append(makeElement('p', 'muted small', profile.uid));

    const actions = makeElement('div', 'trip-actions');
    const edit = makeElement('button', 'compact ghost', 'EDIT');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      $('role-uid').value = profile.uid;
      $('role-name').value = profile.name || '';
      $('role-type').value = profile.role === 'editor' ? 'editor' : 'owner';
      $('role-uid').focus();
    });
    actions.append(edit);

    if (profile.uid !== state.currentUser?.uid) {
      const deactivate = makeElement('button', 'compact danger', profile.active === false ? '再開' : '停止');
      deactivate.type = 'button';
      deactivate.addEventListener('click', () => toggleAdminProfile(db, store, profile));
      actions.append(deactivate);
    }

    row.append(actions);
    list.append(row);
  });
}

export async function saveAdminRole(db, store) {
  if (store.getState().currentRole !== 'owner') return;
  const uid = $('role-uid').value.trim();
  const name = $('role-name').value.trim();
  const role = $('role-type').value === 'owner' ? 'owner' : 'editor';
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(uid)) return showToast('Firebase UIDを正しく入力してください。', true);
  try {
    await setDoc(doc(db, 'admins', uid), {
      active: true, role, name, updatedAt: serverTimestamp(), updatedBy: store.getState().currentUser.uid
    }, { merge: true });
    $('role-uid').value = '';
    $('role-name').value = '';
    $('role-type').value = 'editor';
    showToast('管理者の役割を保存しました。');
    await loadAdminRoles(db, store);
  } catch (error) {
    showToast(`管理者を保存できません: ${error.message}`, true);
  }
}

export async function toggleAdminProfile(db, store, profile) {
  if (store.getState().currentRole !== 'owner' || profile.uid === store.getState().currentUser?.uid) return;
  const active = profile.active === false;
  if (!active && !window.confirm('この管理者を停止しますか？')) return;
  try {
    await setDoc(doc(db, 'admins', profile.uid), {
      active, updatedAt: serverTimestamp(), updatedBy: store.getState().currentUser.uid
    }, { merge: true });
    await loadAdminRoles(db, store);
  } catch (error) {
    showToast(`管理者を変更できません: ${error.message}`, true);
  }
}

export function initRolesView({ db, store }) {
  if ($('save-role')) $('save-role').addEventListener('click', () => saveAdminRole(db, store));
}
