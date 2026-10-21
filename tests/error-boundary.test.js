import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initErrorBoundary,
  reportAppError,
  createErrorReport,
  escapeHtml,
  getLastError,
  getErrorHistory,
  clearErrorState,
  resetBoundaryForTesting
} from '../src/error-boundary.js';

describe('Error Boundary Suite (Feature F15)', () => {
  beforeEach(() => {
    resetBoundaryForTesting();
  });

  afterEach(() => {
    resetBoundaryForTesting();
  });

  describe('escapeHtml utility', () => {
    it('escapes dangerous HTML characters', () => {
      const input = '<script>alert("XSS" & \'test\')</script>';
      const escaped = escapeHtml(input);
      assert.equal(escaped, '&lt;script&gt;alert(&quot;XSS&quot; &amp; &#39;test&#39;)&lt;/script&gt;');
    });

    it('handles null and undefined gracefully', () => {
      assert.equal(escapeHtml(null), '');
      assert.equal(escapeHtml(undefined), '');
      assert.equal(escapeHtml(123), '123');
    });
  });

  describe('createErrorReport schema conformance', () => {
    it('matches Tier 1 and F15 contract payload structure', () => {
      const err = new Error('Test failure');
      const context = { route: 'expenses', tripId: 'shikoku-2026' };
      const report = createErrorReport(err, context);

      assert.equal(report.status, 'error');
      assert.ok(report.displayMessage.includes('エラーが発生しました'));
      assert.equal(report.recoveryAction, '再読み込みをお試しください');
      assert.equal(report.technicalDetails, 'Test failure');
      assert.ok(typeof report.timestamp === 'string');
      assert.ok(!Number.isNaN(Date.parse(report.timestamp)));
      assert.deepEqual(report.context, context);
      assert.ok(typeof report.stack === 'string');
    });

    it('handles non-Error objects and strings as error', () => {
      const reportString = createErrorReport('Network request timed out');
      assert.equal(reportString.technicalDetails, 'Network request timed out');

      const reportNull = createErrorReport(null);
      assert.equal(reportNull.technicalDetails, '不明なエラー');
    });
  });

  describe('Headless Node.js safety', () => {
    it('reportAppError executes without DOM and returns structured report', () => {
      const report = reportAppError(new Error('Headless test'), { env: 'node' });
      assert.equal(report.status, 'error');
      assert.equal(report.technicalDetails, 'Headless test');
      assert.equal(getLastError(), report);
      assert.equal(getErrorHistory().length, 1);
    });

    it('initErrorBoundary runs safely in Node.js without window or document', () => {
      assert.doesNotThrow(() => {
        initErrorBoundary({ containerId: 'test-root' });
      });
    });

    it('clearErrorState resets error history and last error', () => {
      reportAppError(new Error('Sample'));
      assert.ok(getLastError() !== null);
      assert.equal(getErrorHistory().length, 1);

      clearErrorState();
      assert.equal(getLastError(), null);
      assert.equal(getErrorHistory().length, 0);
    });
  });

  describe('Mock DOM & Global Event Handlers', () => {
    let mockWindow;
    let mockDocument;
    let originalWindow;
    let originalDocument;

    beforeEach(() => {
      originalWindow = global.window;
      originalDocument = global.document;

      const listeners = {};
      mockWindow = {
        onerror: null,
        addEventListener: (event, handler) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(handler);
        },
        dispatchEvent: (event) => {
          (listeners[event.type] || []).forEach(fn => fn(event));
        },
        location: {
          reload: () => { mockWindow._reloaded = true; }
        },
        _listeners: listeners,
        _reloaded: false
      };

      const mockButtons = new Map();
      const getOrCreateBtn = (sel) => {
        if (!mockButtons.has(sel)) {
          mockButtons.set(sel, {
            clickHandlers: [],
            addEventListener: (ev, h) => { if (ev === 'click') getOrCreateBtn(sel).clickHandlers.push(h); },
            click: () => getOrCreateBtn(sel).clickHandlers.forEach(h => h())
          });
        }
        return mockButtons.get(sel);
      };

      const containerEl = {
        id: 'test-error-boundary',
        hidden: true,
        innerHTML: '',
        querySelector: (sel) => {
          if (sel.includes('retry') || sel.includes('reload') || sel.includes('close')) return getOrCreateBtn(sel);
          return null;
        }
      };

      mockDocument = {
        getElementById: (id) => (id === 'test-error-boundary' ? containerEl : null),
        createElement: (tag) => ({
          tagName: tag.toUpperCase(),
          id: '',
          textContent: '',
          hidden: true,
          appendChild: () => {}
        }),
        head: { appendChild: () => {} },
        body: { appendChild: () => {} },
        _container: containerEl
      };

      global.window = mockWindow;
      global.document = mockDocument;
    });

    afterEach(() => {
      global.window = originalWindow;
      global.document = originalDocument;
    });

    it('attaches window.onerror and unhandledrejection handlers on init', () => {
      let retried = false;
      initErrorBoundary({
        containerId: 'test-error-boundary',
        onRetry: () => { retried = true; }
      });

      assert.equal(typeof mockWindow.onerror, 'function');
      assert.ok(mockWindow._listeners['unhandledrejection']?.length > 0);

      // Trigger window.onerror
      mockWindow.onerror('Script syntax error', 'viewer.js', 42, 10, new Error('Script syntax error'));
      assert.equal(mockDocument._container.hidden, false);
      assert.ok(mockDocument._container.innerHTML.includes('エラーが発生しました'));
      assert.ok(mockDocument._container.innerHTML.includes('Script syntax error'));

      // Test retry action
      const retryBtn = mockDocument._container.querySelector('[data-action="retry"]');
      assert.ok(retryBtn);
      retryBtn.click();
      assert.equal(retried, true);
      assert.equal(mockDocument._container.hidden, true);
    });

    it('captures unhandledrejection event properly', () => {
      initErrorBoundary({ containerId: 'test-error-boundary' });
      const rejHandler = mockWindow._listeners['unhandledrejection']?.[0];
      assert.ok(typeof rejHandler === 'function');

      rejHandler({ reason: new Error('Promise rejected network error') });
      const last = getLastError();
      assert.ok(last);
      assert.equal(last.technicalDetails, 'Promise rejected network error');
      assert.equal(last.context.hook, 'unhandledrejection');
      assert.equal(mockDocument._container.hidden, false);
    });
  });
});
