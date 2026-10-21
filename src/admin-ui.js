/**
 * Admin UI Primitives & Formatting Helpers
 */

export const $ = id => document.getElementById(id);

export const deepClone = value => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

export function text(value) {
  return value == null ? '' : String(value);
}

let toastTimer = null;

export function showToast(message, error = false) {
  const toast = $('admin-toast');
  if (!toast) return;
  if (typeof window !== 'undefined') {
    window.clearTimeout(toastTimer);
  }
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('visible');
  if (typeof window !== 'undefined') {
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3600);
  }
}

export function setBusy(button, busy, label = '') {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label || '処理中…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
  }
}

export async function copyText(value, successMessage = 'コピーしました') {
  try {
    await navigator.clipboard.writeText(value);
    showToast(successMessage);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    showToast(successMessage);
  }
}

export function formatTimestamp(value) {
  const date = value?.toDate?.() || (value ? new Date(value) : null);
  if (!date || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

export function formatYen(value) {
  const amount = Number(value);
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency', currency: 'JPY', maximumFractionDigits: 0
  }).format(Number.isFinite(amount) ? amount : 0);
}

export function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export const ACCESS_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomAccessId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(byte => ACCESS_ID_ALPHABET[byte % ACCESS_ID_ALPHABET.length]).join('');
}

export function formatAccessId(value) {
  const normalized = text(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.match(/.{1,4}/g)?.join('-') || '—';
}

export async function sha256(value) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function makeElement(tag, className = '', content = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== '') element.textContent = content;
  return element;
}
