import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
console.log('Project root:', projectRoot);

// 1. Inspect Milestone 3 modules for valid native ES Module imports
const modules = [
  'src/trip-store.js',
  'src/viewer-router.js',
  'src/viewer-ui.js',
  'src/weather-service.js',
  'src/pwa-manager.js',
  'src/viewer-app.js'
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

console.log(`Total static/dynamic imports checked in M3 modules: ${totalImportsChecked}`);
if (importErrors.length === 0) {
  console.log('STEP 1 RESULT: PASS - All relative imports end in .js and target existing files.');
} else {
  console.error('STEP 1 RESULT: FAIL - Import errors found:');
  importErrors.forEach(err => console.error('  - ' + err));
}

// Check for circular dependencies among M3 modules
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
  console.log('CIRCULAR DEPENDENCY CHECK: PASS - Zero dependency cycles among M3 modules.');
}

// Compute transitive dependency graph starting from src/viewer-app.js
console.log('\n=== STEP 2: TRANSITIVE DEPENDENCY CLOSURE FROM src/viewer-app.js ===');
const visitedMods = new Set();
const modQueue = ['src/viewer-app.js'];
let transitiveErrors = [];

while (modQueue.length > 0) {
  const current = modQueue.shift();
  if (visitedMods.has(current)) continue;
  visitedMods.add(current);

  const fullCurrent = path.resolve(projectRoot, current);
  if (!fs.existsSync(fullCurrent)) {
    transitiveErrors.push(`Missing dependency: ${current}`);
    continue;
  }
  const content = fs.readFileSync(fullCurrent, 'utf8');
  const regex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    const imp = m[1] || m[2] || m[3];
    if (imp.startsWith('.')) {
      if (!imp.endsWith('.js')) {
        transitiveErrors.push(`[${current}] Relative import missing .js: ${imp}`);
      }
      const target = path.relative(projectRoot, path.resolve(path.dirname(fullCurrent), imp)).replace(/\\/g, '/');
      if (!fs.existsSync(path.resolve(projectRoot, target))) {
        transitiveErrors.push(`[${current}] Target does not exist on disk: ${imp} -> ${target}`);
      } else {
        if (!visitedMods.has(target)) {
          modQueue.push(target);
        }
      }
    }
  }
}

console.log(`Total modules in transitive closure from src/viewer-app.js: ${visitedMods.size}`);
console.log('Modules in closure:', [...visitedMods].sort());
if (transitiveErrors.length === 0) {
  console.log('TRANSITIVE CLOSURE RESULT: PASS - All transitive imports are valid .js files and exist on disk.');
} else {
  console.error('TRANSITIVE CLOSURE RESULT: FAIL -', transitiveErrors);
}

// 3. Symbol Resolution & Import Binding Verification
console.log('\n=== STEP 3: SYMBOL RESOLUTION & IMPORT BINDING VERIFICATION ===');
const criticalSymbols = [
  { file: 'src/trip-store.js', symbol: 'createTripStore', type: 'export' },
  { file: 'src/trip-store.js', symbol: 'createInitialTripState', type: 'export' },
  { file: 'src/viewer-router.js', symbol: 'initAppRouter', type: 'export' },
  { file: 'src/viewer-router.js', symbol: 'storedTripAccess', type: 'export' },
  { file: 'src/viewer-router.js', symbol: 'fetchTripConfig', type: 'export' },
  { file: 'src/viewer-router.js', symbol: 'handleTripLoadFailure', type: 'export' },
  { file: 'src/viewer-router.js', symbol: 'pauseTripRuntime', type: 'export' },
  { file: 'src/viewer-router.js', symbol: 'setRouterCallbacks', type: 'export' },
  { file: 'src/viewer-ui.js', symbol: 'buildShioriUI', type: 'export' },
  { file: 'src/viewer-ui.js', symbol: 'setupDaySwipe', type: 'export' },
  { file: 'src/viewer-ui.js', symbol: 'resetDaySwipe', type: 'export' },
  { file: 'src/viewer-ui.js', symbol: 'switchTab', type: 'export' },
  { file: 'src/viewer-ui.js', symbol: 'escapeHtml', type: 'export' },
  { file: 'src/weather-service.js', symbol: 'initWeatherService', type: 'export' },
  { file: 'src/weather-service.js', symbol: 'refreshWeather', type: 'export' },
  { file: 'src/weather-service.js', symbol: 'resetWeather', type: 'export' },
  { file: 'src/weather-service.js', symbol: 'updateWeather', type: 'export' },
  { file: 'src/pwa-manager.js', symbol: 'initPwaUpdateManager', type: 'export' },
  { file: 'src/pwa-manager.js', symbol: 'triggerPwaUpdate', type: 'export' },
  { file: 'src/pwa-manager.js', symbol: 'openAppWithFallback', type: 'export' },
  { file: 'src/viewer-app.js', symbol: 'tripStore', type: 'export' },
  { file: 'src/viewer-app.js', symbol: 'loadShioriData', type: 'export' },
  { file: 'src/viewer-app.js', symbol: 'initViewerApp', type: 'export' }
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

console.log(`Total named import identifiers checked across ${modules.length} M3 modules: ${totalNamedChecked}`);
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

// 4. DOM ID coverage check in index.html
console.log('\n=== STEP 4: VERIFY DOM ID COVERAGE IN index.html ===');
const indexHtmlPath = path.resolve(projectRoot, 'index.html');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

const idRegex = /\bid=["']([^"']+)["']/g;
const htmlIds = new Set();
let idMatch;
while ((idMatch = idRegex.exec(indexHtml)) !== null) {
  htmlIds.add(idMatch[1]);
}
console.log(`Unique IDs found in index.html: ${htmlIds.size}`);

// Inverse check: check all getElementById and #id selectors in M3 modules to ensure they exist in index.html
const queriedIds = new Map();
const queryPatterns = [
  /getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /querySelector(?:All)?\s*\(\s*['"]#([a-zA-Z0-9_-]+)[^'"]*['"]\s*\)/g
];

modules.forEach(modPath => {
  const fullPath = path.resolve(projectRoot, modPath);
  const content = fs.readFileSync(fullPath, 'utf8');
  queryPatterns.forEach(pat => {
    let m;
    while ((m = pat.exec(content)) !== null) {
      const qId = m[1];
      if (!queriedIds.has(qId)) queriedIds.set(qId, []);
      queriedIds.get(qId).push(modPath);
    }
  });
});

const missingQueriedIds = [];
for (const [qId, mods] of queriedIds.entries()) {
  if (!htmlIds.has(qId)) {
    missingQueriedIds.push({ id: qId, callers: mods });
  }
}

console.log(`Total queried static DOM IDs in M3 JS modules: ${queriedIds.size}`);
if (missingQueriedIds.length > 0) {
  console.error('CRITICAL: Modules query IDs that do NOT exist in index.html:', missingQueriedIds);
} else {
  console.log('PASS: All queried IDs in JS modules exist in index.html (0 phantom element queries).');
}

// Check coverage of core interactive element IDs
const coreViewerIds = [
  'welcome-overlay', 'welcome-nickname', 'portal-overlay', 'portal-cards',
  'portal-tab-upcoming', 'portal-tab-past', 'btn-show-add-trip', 'add-trip-container',
  'new-trip-id', 'add-trip-error', 'shiori-content', 'hero-title', 'hero-catchphrase',
  'hero-date', 'weather-nav-container', 'weather-summary', 'w-temp', 'w-range', 'w-pop',
  'w-sunset', 'w-cond', 'w-icon', 'w-updated', 'w-app-link', 'w-location', 'nav-bar',
  'day-panels-container', 'tab-checklist', 'checklist-grid-container', 'tab-expenses',
  'tab-talk', 'tab-recap', 'recap-preview', 'device-owner', 'expense-payer', 'update-prompt'
];

let missingCoreIds = [];
coreViewerIds.forEach(id => {
  if (!htmlIds.has(id)) {
    missingCoreIds.push(id);
  }
});
if (missingCoreIds.length === 0) {
  console.log(`PASS: All ${coreViewerIds.length} core viewer UI IDs are present in index.html.`);
} else {
  console.error('FAIL: Missing core viewer UI IDs in index.html:', missingCoreIds);
}

// 5. Independent Line Counts Verification
console.log('\n=== STEP 5: INDEPENDENT LINE COUNTS VERIFICATION ===');
let lineCountViolations = [];

const fileLimits = [
  { file: 'index.html', limit: 900 },
  { file: 'src/viewer-app.js', limit: 150 },
  { file: 'src/trip-store.js', limit: 400 },
  { file: 'src/viewer-router.js', limit: 400, targetSubLimit: 350 },
  { file: 'src/viewer-ui.js', limit: 400 },
  { file: 'src/weather-service.js', limit: 400, targetSubLimit: 250 },
  { file: 'src/pwa-manager.js', limit: 400, targetSubLimit: 150 }
];

fileLimits.forEach(({ file, limit, targetSubLimit }) => {
  const p = path.resolve(projectRoot, file);
  const lines = fs.readFileSync(p, 'utf8').split('\n').length;
  const pass = lines <= limit;
  const subLimitNote = targetSubLimit ? ` (Target: < ${targetSubLimit})` : '';
  console.log(`  ${file}: ${lines} lines (Limit: <= ${limit}${subLimitNote}) -> ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) {
    lineCountViolations.push(`${file} exceeds line limit (${lines} > ${limit})`);
  }
  if (targetSubLimit && lines >= targetSubLimit) {
    lineCountViolations.push(`${file} exceeds strict target sub-limit (${lines} >= ${targetSubLimit})`);
  }
});

if (lineCountViolations.length === 0) {
  console.log('STEP 5 RESULT: PASS - All files satisfy strict line count constraints.');
} else {
  console.error('STEP 5 RESULT: FAIL - Line count violations:');
  lineCountViolations.forEach(v => console.error('  - ' + v));
}

// Final summary and process exit code
const totalErrors = importErrors.length +
  (hasCycle ? 1 : 0) +
  transitiveErrors.length +
  totalStep3Errors +
  missingQueriedIds.length +
  missingCoreIds.length +
  lineCountViolations.length;

if (totalErrors > 0) {
  console.error(`\nOVERALL VERIFICATION FAILED: ${totalErrors} issue(s) detected.`);
  process.exit(1);
} else {
  console.log('\nOVERALL VERIFICATION PASSED: All M3 architectural, closure, and symbol integrity checks succeeded.');
}
