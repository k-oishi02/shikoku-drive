import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const projectRoot = process.cwd();
console.log('Project root:', projectRoot);

// 1. Inspect Milestone 4 modules for valid native ES Module imports
const modules = [
  'src/error-boundary.js',
  'src/offline-expense-queue.js',
  'src/weather-service.js',
  'src/pwa-manager.js',
  'src/viewer-app.js',
  'src/admin.js',
  'src/enhancements.js',
  'src/firebase-sync.js'
];

console.log('=== STEP 1: VERIFY NATIVE ES MODULE IMPORTS ===');
let importErrors = [];
let totalImportsChecked = 0;

modules.forEach(modPath => {
  const fullPath = path.resolve(projectRoot, modPath);
  if (!fs.existsSync(fullPath)) {
    importErrors.push(`Missing file: ${modPath}`);
    return;
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  // Match static import ... from '...', import '...', export ... from '...', import('...')
  const regex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const importPath = match[1] || match[2] || match[3];
    totalImportsChecked++;
    if (importPath.startsWith('.')) {
      if (!importPath.endsWith('.js')) {
        importErrors.push(`[${modPath}] Relative import missing .js extension: "${importPath}"`);
      }
      const targetPath = path.resolve(path.dirname(fullPath), importPath);
      if (!fs.existsSync(targetPath)) {
        importErrors.push(`[${modPath}] Target file does not exist: "${importPath}" (resolved to ${targetPath})`);
      }
    }
  }
});

// Check for non-browser imports (e.g. Node built-ins)
const nodeBuiltins = ['fs', 'path', 'child_process', 'os', 'http', 'https', 'crypto', 'net', 'url', 'buffer', 'stream', 'util', 'events'];
modules.forEach(modPath => {
  const fullPath = path.resolve(projectRoot, modPath);
  const content = fs.readFileSync(fullPath, 'utf8');
  nodeBuiltins.forEach(builtin => {
    const importBuiltinRegex = new RegExp(`(?:import\\s+(?:[\\w*\\s{},]*\\s+from\\s+)?|require\\s*\\(\\s*)['"](?:node:)?${builtin}['"]`);
    const match = content.match(importBuiltinRegex);
    if (match) {
      importErrors.push(`[${modPath}] Unsafe Node.js builtin import found for browser module: "${builtin}" (match: ${match[0]})`);
    }
  });
});

console.log(`Total static/dynamic imports checked in M4 modules: ${totalImportsChecked}`);
if (importErrors.length === 0) {
  console.log('STEP 1 RESULT: PASS - All relative imports end in .js and target existing files.');
} else {
  console.error('STEP 1 RESULT: FAIL - Import errors found:');
  importErrors.forEach(err => console.error('  - ' + err));
}

// 2. Circular dependency check among M4 modules
console.log('\n=== STEP 2: CIRCULAR DEPENDENCY CHECK ===');
const depGraph = new Map();
modules.forEach(m => depGraph.set(m, []));
modules.forEach(modPath => {
  const fullPath = path.resolve(projectRoot, modPath);
  const content = fs.readFileSync(fullPath, 'utf8');
  const regex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"])/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const importPath = match[1] || match[2];
    if (importPath && importPath.startsWith('.')) {
      const resolved = path.relative(projectRoot, path.resolve(path.dirname(fullPath), importPath)).replace(/\\/g, '/');
      if (depGraph.has(resolved)) {
        depGraph.get(modPath).push(resolved);
      }
    }
  }
});

function detectCycle(node, visited = new Set(), recStack = new Set()) {
  visited.add(node);
  recStack.add(node);
  const neighbors = depGraph.get(node) || [];
  for (const neighbor of neighbors) {
    if (!visited.has(neighbor)) {
      const cycle = detectCycle(neighbor, visited, recStack);
      if (cycle) return [node, ...cycle];
    } else if (recStack.has(neighbor)) {
      return [node, neighbor];
    }
  }
  recStack.delete(node);
  return null;
}

let hasCycle = false;
for (const mod of modules) {
  const cycle = detectCycle(mod);
  if (cycle) {
    console.error('CIRCULAR DEPENDENCY DETECTED:', cycle.join(' -> '));
    hasCycle = true;
    break;
  }
}
if (!hasCycle) {
  console.log('CIRCULAR DEPENDENCY CHECK: PASS - Zero dependency cycles among M4 modules.');
}

// 3. Symbol Resolution & Export Verification
console.log('\n=== STEP 3: SYMBOL RESOLUTION & EXPORT VERIFICATION ===');
const criticalSymbols = [
  // Error Boundary (F15)
  { file: 'src/error-boundary.js', symbol: 'initErrorBoundary', type: 'export' },
  { file: 'src/error-boundary.js', symbol: 'reportAppError', type: 'export' },
  { file: 'src/error-boundary.js', symbol: 'createErrorReport', type: 'export' },
  { file: 'src/error-boundary.js', symbol: 'escapeHtml', type: 'export' },
  { file: 'src/error-boundary.js', symbol: 'getLastError', type: 'export' },
  { file: 'src/error-boundary.js', symbol: 'getErrorHistory', type: 'export' },
  { file: 'src/error-boundary.js', symbol: 'clearErrorState', type: 'export' },
  { file: 'src/error-boundary.js', symbol: 'resetBoundaryForTesting', type: 'export' },
  // Offline Expense Queue (F16)
  { file: 'src/offline-expense-queue.js', symbol: 'OFFLINE_QUEUE_KEY', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'readRawQueue', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'writeRawQueue', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'getOfflineExpensesQueue', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'getPendingExpenses', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'isExpensePendingSync', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'getPendingQueueCount', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'enqueueOfflineExpense', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'updateQueuedExpenseStatus', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'clearSyncedExpenses', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'clearAllQueuedExpenses', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'mergeWithOfflineQueue', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'isNetworkOffline', type: 'export' },
  { file: 'src/offline-expense-queue.js', symbol: 'drainOfflineExpenseQueue', type: 'export' },
  // Weather Service Cache & API (F17)
  { file: 'src/weather-service.js', symbol: 'WEATHER_CACHE_KEY_PREFIX', type: 'export' },
  { file: 'src/weather-service.js', symbol: 'readLocalWeatherCache', type: 'export' },
  { file: 'src/weather-service.js', symbol: 'writeLocalWeatherCache', type: 'export' },
  { file: 'src/weather-service.js', symbol: 'loadWeatherCache', type: 'export' },
  { file: 'src/weather-service.js', symbol: 'saveWeatherCache', type: 'export' },
  { file: 'src/weather-service.js', symbol: 'initWeatherService', type: 'export' },
  { file: 'src/weather-service.js', symbol: 'refreshWeather', type: 'export' },
  { file: 'src/weather-service.js', symbol: 'resetWeather', type: 'export' },
  { file: 'src/weather-service.js', symbol: 'updateWeather', type: 'export' },
  // PWA Manager (F16)
  { file: 'src/pwa-manager.js', symbol: 'initPwaUpdateManager', type: 'export' },
  { file: 'src/pwa-manager.js', symbol: 'triggerPwaUpdate', type: 'export' },
  { file: 'src/pwa-manager.js', symbol: 'openAppWithFallback', type: 'export' }
];

let symbolErrors = [];
criticalSymbols.forEach(({ file, symbol, type }) => {
  const content = fs.readFileSync(path.resolve(projectRoot, file), 'utf8');
  let valid = false;
  if (type === 'definition') {
    valid = new RegExp(`(?:function\\s+${symbol}\\b|const\\s+${symbol}\\s*=|let\\s+${symbol}\\s*=)`).test(content);
  } else if (type === 'import') {
    valid = new RegExp(`import\\s+.*?\\b${symbol}\\b.*?from`).test(content);
  } else if (type === 'export') {
    valid = new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${symbol}\\b|export\\s*{[^}]*\\b${symbol}\\b[^}]*}`).test(content);
  }
  console.log(`  [${file}] ${symbol} (${type}): ${valid ? 'PASS' : 'FAIL'}`);
  if (!valid) symbolErrors.push(`[${file}] Missing ${type} of "${symbol}"`);
});

function getExports(filePath, visited = new Set()) {
  const full = path.resolve(projectRoot, filePath);
  if (visited.has(full)) return new Set();
  visited.add(full);
  if (!fs.existsSync(full)) return new Set();
  const code = fs.readFileSync(full, 'utf8');
  const exports = new Set();

  const directRegex = /export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([a-zA-Z0-9_$]+)/g;
  let m;
  while ((m = directRegex.exec(code)) !== null) exports.add(m[1]);

  const listRegex = /export\s*\{([^}]+)\}(?:\s*from\s*['"]([^'"]+)['"])?/g;
  while ((m = listRegex.exec(code)) !== null) {
    const list = m[1];
    const fromPath = m[2];
    if (fromPath) {
      const resolvedFrom = path.relative(projectRoot, path.resolve(path.dirname(full), fromPath)).replace(/\\/g, '/');
      const subExports = getExports(resolvedFrom, visited);
      list.split(',').forEach(item => {
        const clean = item.trim();
        if (!clean) return;
        exports.add(clean.includes(' as ') ? clean.split(/\s+as\s+/)[1].trim() : clean);
      });
    } else {
      list.split(',').forEach(item => {
        const clean = item.trim();
        if (!clean) return;
        exports.add(clean.includes(' as ') ? clean.split(/\s+as\s+/)[1].trim() : clean);
      });
    }
  }

  const allRegex = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = allRegex.exec(code)) !== null) {
    const fromPath = m[1];
    const resolvedFrom = path.relative(projectRoot, path.resolve(path.dirname(full), fromPath)).replace(/\\/g, '/');
    const subExports = getExports(resolvedFrom, visited);
    subExports.forEach(e => exports.add(e));
  }

  return exports;
}

const bindingErrors = [];
let totalNamedChecked = 0;
for (const mod of modules) {
  const full = path.resolve(projectRoot, mod);
  const code = fs.readFileSync(full, 'utf8');
  const importNamedRegex = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = importNamedRegex.exec(code)) !== null) {
    const names = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const spec = m[2];
    if (spec.startsWith('.')) {
      const targetRel = path.relative(projectRoot, path.resolve(path.dirname(full), spec)).replace(/\\/g, '/');
      const targetExports = getExports(targetRel);
      for (const name of names) {
        totalNamedChecked++;
        if (!targetExports.has(name)) {
          bindingErrors.push(`[${mod}] imports "${name}" from "${targetRel}", but "${name}" is NOT exported by "${targetRel}"`);
        }
      }
    }
  }
}

console.log(`Total named import identifiers checked across ${modules.length} M4 modules: ${totalNamedChecked}`);
if (bindingErrors.length === 0) {
  console.log('PASS: All imported named identifiers exist in the exported symbols of their target modules.');
} else {
  console.error('FAIL: Missing imported symbols detected:');
  bindingErrors.forEach(err => console.error('  - ' + err));
}

const totalStep3Errors = symbolErrors.length + bindingErrors.length;
if (totalStep3Errors === 0) {
  console.log('STEP 3 RESULT: PASS - All critical symbols and named imports are properly resolved.');
} else {
  console.error(`STEP 3 RESULT: FAIL - ${totalStep3Errors} symbol resolution error(s) found.`);
}

// 4. Verify DOM Boundary Containers in index.html & admin.html
console.log('\n=== STEP 4: VERIFY ERROR BOUNDARY CONTAINERS ===');
let domErrors = [];
const indexHtml = fs.readFileSync(path.resolve(projectRoot, 'index.html'), 'utf8');
const adminHtml = fs.readFileSync(path.resolve(projectRoot, 'admin.html'), 'utf8');

if (!indexHtml.includes('id="error-boundary-root"')) {
  domErrors.push('index.html is missing #error-boundary-root container');
} else {
  console.log('  index.html #error-boundary-root: FOUND');
}

if (!adminHtml.includes('id="admin-error-boundary"')) {
  domErrors.push('admin.html is missing #admin-error-boundary container');
} else {
  console.log('  admin.html #admin-error-boundary: FOUND');
}

if (domErrors.length === 0) {
  console.log('STEP 4 RESULT: PASS - Both viewer and admin have dedicated error boundary mount points.');
} else {
  console.error('STEP 4 RESULT: FAIL - DOM errors:');
  domErrors.forEach(e => console.error('  - ' + e));
}

// 5. Verify Service Worker Manifest & Offline Strategy
console.log('\n=== STEP 5: VERIFY SERVICE WORKER & APP_SHELL ASSETS ===');
let swErrors = [];
const swPath = path.resolve(projectRoot, 'sw.js');
const swCode = fs.readFileSync(swPath, 'utf8');

// Syntactic validity
try {
  new vm.Script(swCode);
  console.log('  sw.js syntax: VALID');
} catch (e) {
  swErrors.push(`sw.js has syntax error: ${e.message}`);
}

// CACHE_VERSION
const versionMatch = swCode.match(/const\s+CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (!versionMatch || versionMatch[1] !== 'v404') {
  swErrors.push(`sw.js CACHE_VERSION must be 'v404' (got '${versionMatch ? versionMatch[1] : 'null'}')`);
} else {
  console.log('  sw.js CACHE_VERSION: v404');
}

// Admin bypass removal
if (swCode.includes('isAdminAsset')) {
  swErrors.push('sw.js still contains isAdminAsset bypass; admin assets must be cached for offline support');
} else {
  console.log('  sw.js isAdminAsset bypass removed: YES');
}

// Dual navigation fallback
if (!swCode.includes("requestUrl.pathname.endsWith('/admin.html')") || !swCode.includes("caches.match('./admin.html')")) {
  swErrors.push('sw.js missing dedicated admin.html offline navigation fallback');
} else {
  console.log('  sw.js admin offline navigation fallback: PRESENT');
}

// 503 JSON fallback
if (!swCode.includes("requestUrl.pathname.endsWith('.json')") || !swCode.includes('status: 503')) {
  swErrors.push('sw.js missing 503 JSON fallback response');
} else {
  console.log('  sw.js 503 JSON offline fallback: PRESENT');
}

// APP_SHELL assets check
const shellMatch = swCode.match(/const\s+APP_SHELL\s*=\s*\[([\s\S]*?)\];/);
if (!shellMatch) {
  swErrors.push('sw.js missing APP_SHELL declaration');
} else {
  const assets = shellMatch[1]
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith("'") || line.startsWith('"'))
    .map(line => line.replace(/^[',"]+|[',",;]+$/g, ''));

  console.log(`  sw.js APP_SHELL asset count: ${assets.length}`);
  if (assets.length < 70) {
    swErrors.push(`APP_SHELL asset count (${assets.length}) is below requirement (>= 70)`);
  }

  const missingAssets = [];
  assets.forEach(asset => {
    let relPath = asset;
    if (relPath === './' || relPath === '/') relPath = './index.html';
    const diskPath = path.resolve(projectRoot, relPath);
    if (!fs.existsSync(diskPath)) {
      missingAssets.push(asset);
    }
  });

  if (missingAssets.length > 0) {
    swErrors.push(`Assets listed in APP_SHELL missing on disk: ${missingAssets.join(', ')}`);
  } else {
    console.log(`  sw.js APP_SHELL disk existence check: PASS (All ${assets.length} assets exist on disk)`);
  }
}

if (swErrors.length === 0) {
  console.log('STEP 5 RESULT: PASS - Service Worker offline shell fully verified.');
} else {
  console.error('STEP 5 RESULT: FAIL - Service Worker errors:');
  swErrors.forEach(e => console.error('  - ' + e));
}

// 6. Strict Line Counts Verification
console.log('\n=== STEP 6: STRICT LINE COUNT VERIFICATION ===');
let lineCountViolations = [];

const fileLimits = [
  { file: 'src/error-boundary.js', limit: 200, strictSubLimit: 200 },
  { file: 'src/offline-expense-queue.js', limit: 200, strictSubLimit: 200 },
  { file: 'src/weather-service.js', limit: 400, strictSubLimit: 250 },
  { file: 'src/pwa-manager.js', limit: 400, strictSubLimit: 150 },
  { file: 'src/viewer-app.js', limit: 150, strictSubLimit: 150 },
  { file: 'src/admin.js', limit: 150, strictSubLimit: 150 },
  { file: 'sw.js', limit: 200, strictSubLimit: 200 },
  { file: 'index.html', limit: 900, strictSubLimit: 900 }
];

fileLimits.forEach(({ file, limit, strictSubLimit }) => {
  const p = path.resolve(projectRoot, file);
  const lines = fs.readFileSync(p, 'utf8').split('\n').length;
  const pass = lines <= limit && (strictSubLimit ? lines <= strictSubLimit : true);
  console.log(`  ${file}: ${lines} lines (Limit: <= ${strictSubLimit || limit}) -> ${pass ? 'PASS' : 'FAIL'}`);
  if (lines > limit) {
    lineCountViolations.push(`${file} exceeds hard line limit (${lines} > ${limit})`);
  } else if (strictSubLimit && lines > strictSubLimit) {
    lineCountViolations.push(`${file} exceeds strict sub-limit (${lines} > ${strictSubLimit})`);
  }
});

if (lineCountViolations.length === 0) {
  console.log('STEP 6 RESULT: PASS - All files satisfy strict line count constraints.');
} else {
  console.error('STEP 6 RESULT: FAIL - Line count violations:');
  lineCountViolations.forEach(v => console.error('  - ' + v));
}

// Overall summary
const totalErrors = importErrors.length +
  (hasCycle ? 1 : 0) +
  totalStep3Errors +
  domErrors.length +
  swErrors.length +
  lineCountViolations.length;

if (totalErrors > 0) {
  console.error(`\nOVERALL M4 VERIFICATION FAILED: ${totalErrors} issue(s) detected.`);
  process.exit(1);
} else {
  console.log('\nOVERALL M4 VERIFICATION PASSED: All Milestone 4 resilience, error boundary, and offline requirements succeeded.');
}
