/**
 * Global Error Boundary & Japanese Recovery Interface (Feature F15)
 * Captures uncaught errors and unhandled promise rejections,
 * displaying a friendly Japanese fallback UI with diagnostic details.
 */

let initialized = false;
const defaultOptions = {
  containerId: 'error-boundary-root',
  fallbackMessage: 'しおりの表示中に予期せぬエラーが発生しました。',
  onRetry: null,
  autoHook: true
};
let currentOptions = { ...defaultOptions };
let lastErrorReport = null;
const errorLog = [];

export function resetBoundaryForTesting() {
  initialized = false;
  currentOptions = { ...defaultOptions };
  lastErrorReport = null;
  errorLog.length = 0;
  hideErrorUI();
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function createErrorReport(error, context = {}) {
  let message;
  try {
    message = error instanceof Error
      ? error.message
      : (typeof error === 'string' ? error : (error ? String(error) : '不明なエラー'));
  } catch {
    message = '不明なエラー';
  }
  const stack = (error instanceof Error && error.stack) ? error.stack : '';
  return {
    status: 'error',
    displayMessage: currentOptions.fallbackMessage || 'しおりの表示中に予期せぬエラーが発生しました。',
    recoveryAction: '再読み込みをお試しください',
    technicalDetails: message,
    stack,
    timestamp: new Date().toISOString(),
    context: context && typeof context === 'object' ? context : {}
  };
}

export function getLastError() { return lastErrorReport; }
export function getErrorHistory() { return [...errorLog]; }
export function clearErrorState() {
  lastErrorReport = null;
  errorLog.length = 0;
  hideErrorUI();
}

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('shiori-error-boundary-style')) return;
  const style = document.createElement('style');
  style.id = 'shiori-error-boundary-style';
  style.textContent = `
.shiori-error-overlay { position: fixed; inset: 0; z-index: 999999; background: rgba(10,15,20,0.88); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 20px; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans JP", sans-serif; }
.shiori-error-card { background: #202725; color: #f1f0eb; border: 1px solid rgba(255,107,122,0.35); border-radius: 16px; padding: 24px; max-width: 480px; width: 100%; box-shadow: 0 20px 50px rgba(0,0,0,0.5); box-sizing: border-box; }
.shiori-error-badge { display: inline-block; font-size: 0.68rem; font-weight: 800; letter-spacing: 0.1em; background: rgba(255,107,122,0.18); color: #ff6b7a; border: 1px solid rgba(255,107,122,0.4); border-radius: 999px; padding: 2px 10px; margin-bottom: 8px; }
.shiori-error-title { margin: 0 0 10px; font-size: 1.25rem; font-weight: 700; color: #ffffff; }
.shiori-error-desc { font-size: 0.92rem; line-height: 1.6; color: #b8bfbb; margin: 0 0 18px; }
.shiori-error-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.shiori-error-btn { cursor: pointer; border: none; border-radius: 8px; padding: 10px 16px; font-size: 0.88rem; font-weight: 600; font-family: inherit; transition: opacity 0.2s; }
.shiori-error-btn:hover { opacity: 0.88; }
.shiori-error-btn-primary { background: #356b68; color: #ffffff; }
.shiori-error-btn-secondary { background: #2f3a36; color: #f1f0eb; border: 1px solid rgba(255,255,255,0.15); }
.shiori-error-btn-ghost { background: transparent; color: #b8bfbb; text-decoration: underline; }
.shiori-error-diagnostics { background: #171c1b; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 8px 12px; font-size: 0.82rem; color: #a1a1a1; }
.shiori-error-summary { cursor: pointer; font-weight: 600; color: #b8bfbb; outline: none; }
.shiori-error-details-body { margin-top: 10px; font-size: 0.78rem; word-break: break-all; }
.shiori-error-stack { background: #0f1312; padding: 10px; border-radius: 6px; overflow-x: auto; color: #e0a39a; font-family: monospace; font-size: 0.74rem; line-height: 1.4; margin-top: 6px; }
`;
  (document.head || document.body)?.appendChild(style);
}

function resolveContainer() {
  if (typeof document === 'undefined') return null;
  let container = currentOptions.containerId ? document.getElementById(currentOptions.containerId) : null;
  if (!container && document.body) {
    container = document.createElement('div');
    container.id = currentOptions.containerId || 'error-boundary-root';
    document.body.appendChild(container);
  }
  return container;
}

export function hideErrorUI() {
  if (typeof document === 'undefined') return;
  const container = resolveContainer();
  if (container) {
    container.hidden = true;
    container.innerHTML = '';
  }
}

export function renderErrorUI(report) {
  if (typeof document === 'undefined') return;
  ensureStyles();
  const container = resolveContainer();
  if (!container) return;

  let contextStr = '';
  if (report.context && typeof report.context === 'object' && Object.keys(report.context).length > 0) {
    try {
      contextStr = `<p class="shiori-error-context"><strong>コンテキスト:</strong> ${escapeHtml(JSON.stringify(report.context))}</p>`;
    } catch {
      contextStr = `<p class="shiori-error-context"><strong>コンテキスト:</strong> [シリアライズ不可]</p>`;
    }
  }

  container.hidden = false;
  container.innerHTML = `
<div class="shiori-error-overlay" role="alert" aria-live="assertive">
  <div class="shiori-error-card">
    <div class="shiori-error-header">
      <span class="shiori-error-badge">ERROR</span>
      <h2 class="shiori-error-title">エラーが発生しました</h2>
    </div>
    <p class="shiori-error-desc">${escapeHtml(report.displayMessage)}</p>
    <div class="shiori-error-actions">
      <button type="button" class="shiori-error-btn shiori-error-btn-primary" data-action="reload">再読み込み</button>
      <button type="button" class="shiori-error-btn shiori-error-btn-secondary" data-action="retry">再試行</button>
      <button type="button" class="shiori-error-btn shiori-error-btn-ghost" data-action="close">閉じる</button>
    </div>
    <details class="shiori-error-diagnostics">
      <summary class="shiori-error-summary">詳細情報（技術的なログ）</summary>
      <div class="shiori-error-details-body">
        <p><strong>技術的詳細:</strong> ${escapeHtml(report.technicalDetails)}</p>
        ${contextStr}
        <pre class="shiori-error-stack"><code>${escapeHtml(report.stack || 'スタック情報はありません')}</code></pre>
      </div>
    </details>
  </div>
</div>`;

  container.querySelector('[data-action="reload"]')?.addEventListener('click', () => {
    if (typeof window !== 'undefined' && window.location) window.location.reload();
  });
  container.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
    hideErrorUI();
    if (typeof currentOptions.onRetry === 'function') currentOptions.onRetry();
    else if (typeof window !== 'undefined' && window.location) window.location.reload();
  });
  container.querySelector('[data-action="close"]')?.addEventListener('click', () => {
    hideErrorUI();
  });
}

export function reportAppError(error, context = {}) {
  const report = createErrorReport(error, context);
  lastErrorReport = report;
  errorLog.push(report);
  if (errorLog.length > 50) errorLog.shift();

  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    console.error('[SHIORI ErrorBoundary]', error, context);
  }
  if (typeof document !== 'undefined') {
    renderErrorUI(report);
  }
  return report;
}

export function initErrorBoundary(options = {}) {
  currentOptions = { ...currentOptions, ...options };
  if (initialized || options.autoHook === false) return;
  initialized = true;

  if (typeof window !== 'undefined') {
    const prevOnError = window.onerror;
    window.onerror = function(message, source, lineno, colno, error) {
      reportAppError(error || message, { source, lineno, colno, hook: 'onerror' });
      if (typeof prevOnError === 'function') {
        return prevOnError.apply(this, arguments);
      }
      return false;
    };

    window.addEventListener('unhandledrejection', event => {
      const reason = event ? (event.reason || event) : 'Unhandled rejection';
      reportAppError(reason, { hook: 'unhandledrejection' });
    });
  }
}
