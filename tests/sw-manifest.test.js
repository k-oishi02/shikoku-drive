import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const swPath = path.join(projectRoot, 'sw.js');

describe('Service Worker Manifest & Offline Suite (Feature F16)', () => {
  const swCode = fs.readFileSync(swPath, 'utf8');

  it('sw.js file exists and is syntactically valid', () => {
    assert.ok(swCode.length > 0, 'sw.js should not be empty');
    // Verify JS syntax
    assert.doesNotThrow(() => {
      new vm.Script(swCode);
    }, 'sw.js should be valid JavaScript syntax');
  });

  it('declares CACHE_VERSION v404 and matching CACHE_NAME', () => {
    const versionMatch = swCode.match(/const\s+CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(versionMatch, 'CACHE_VERSION declaration found');
    assert.equal(versionMatch[1], 'v404', 'CACHE_VERSION must be bumped to v404');

    assert.ok(
      swCode.includes('`shiori-pwa-${CACHE_VERSION}`') || swCode.includes("'shiori-pwa-' + CACHE_VERSION"),
      'CACHE_NAME should derive from CACHE_VERSION'
    );
  });

  it('defines comprehensive APP_SHELL array containing 70+ assets', () => {
    // Extract APP_SHELL definition
    const shellMatch = swCode.match(/const\s+APP_SHELL\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(shellMatch, 'APP_SHELL array must be defined');

    // Parse array items
    const rawItems = shellMatch[1]
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith("'") || line.startsWith('"'))
      .map(line => line.replace(/^[',"]+|[',",;]+$/g, ''));

    assert.ok(rawItems.length >= 70, `APP_SHELL should contain at least 70 assets (found ${rawItems.length})`);

    // Verify key M4 assets
    const requiredAssets = [
      './',
      './index.html',
      './admin.html',
      './recap.html',
      './manifest.webmanifest',
      './src/error-boundary.js',
      './src/offline-expense-queue.js',
      './src/weather-service.js',
      './src/pwa-manager.js',
      './src/viewer-app.js',
      './src/admin.js',
      './src/firebase-sync.js',
      './src/enhancements.js'
    ];

    for (const req of requiredAssets) {
      assert.ok(
        rawItems.includes(req),
        `Required asset ${req} must be present in APP_SHELL`
      );
    }

    // Verify every single asset exists on disk
    const missing = [];
    for (const item of rawItems) {
      let relativePath = item;
      if (relativePath === './' || relativePath === '/') {
        relativePath = './index.html';
      }
      const fullPath = path.resolve(projectRoot, relativePath);
      if (!fs.existsSync(fullPath)) {
        missing.push(item);
      }
    }

    assert.deepEqual(missing, [], `All assets in APP_SHELL must exist on disk. Missing: ${missing.join(', ')}`);
  });

  it('eliminates isAdminAsset offline bypass so admin is available offline', () => {
    assert.ok(
      !swCode.includes('isAdminAsset'),
      'sw.js must eliminate isAdminAsset bypass to allow offline admin app shell caching'
    );
  });

  it('implements dual navigation fallback for admin.html and index.html', () => {
    assert.ok(swCode.includes("event.request.mode === 'navigate'"), 'handles navigate mode requests');
    assert.ok(swCode.includes("requestUrl.pathname.endsWith('/admin.html')"), 'checks for admin.html navigate target');
    assert.ok(swCode.includes("caches.match('./admin.html')"), 'provides ./admin.html fallback for admin navigations');
    assert.ok(swCode.includes("caches.match('./index.html')"), 'provides ./index.html fallback for user navigations');
  });

  it('provides structured 503 JSON response for offline .json requests', () => {
    assert.ok(swCode.includes("requestUrl.pathname.endsWith('.json')"), 'checks for .json requests');
    assert.ok(swCode.includes('status: 503'), 'returns 503 status code for offline .json');
    assert.ok(swCode.includes("'Content-Type': 'application/json"), 'sets JSON Content-Type header');
  });

  it('supports skipWaiting message and clean cache activation', () => {
    assert.ok(swCode.includes('SKIP_WAITING') || swCode.includes('skipWaiting'), 'handles skipWaiting message');
    assert.ok(swCode.includes('caches.delete'), 'deletes old cache entries on activate');
    assert.ok(swCode.includes('self.clients.claim()'), 'claims clients on activate');
  });
});
