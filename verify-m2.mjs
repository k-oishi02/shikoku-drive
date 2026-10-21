import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
console.log('Project root:', projectRoot);

// 1. Inspect all 12 modules for valid native ES Module imports
const modules = [
  'src/admin-store.js',
  'src/admin-ui.js',
  'src/admin-auth.js',
  'src/admin-trip-service.js',
  'src/admin-view-overview.js',
  'src/admin-view-editor.js',
  'src/admin-candidate-ui.js',
  'src/admin-day-planner-ui.js',
  'src/admin-distribution-ui.js',
  'src/admin-distribution-ledger.js',
  'src/admin-roles-ui.js',
  'src/admin-discussion-ui.js',
  'src/admin.js'
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
    // Only check actual import or require statements!
    const importBuiltinRegex = new RegExp(`(?:import\\s+(?:[\\w*\\s{},]*\\s+from\\s+)?|require\\s*\\(\\s*)['\"](?:node:)?${builtin}['\"]`);
    const match = content.match(importBuiltinRegex);
    if (match) {
      importErrors.push(`[${modPath}] Unsafe Node.js builtin import found for browser module: "${builtin}" (match: ${match[0]})`);
    }
  });
});

console.log(`Total static/dynamic imports checked: ${totalImportsChecked}`);
if (importErrors.length === 0) {
  console.log('STEP 1 RESULT: PASS - All relative imports end in .js and target existing files.');
} else {
  console.error('STEP 1 RESULT: FAIL - Import errors found:');
  importErrors.forEach(err => console.error('  - ' + err));
}

// Check for circular dependencies among decomposed modules
const depGraph = new Map();
modules.forEach(m => depGraph.set(m, []));
modules.forEach(modPath => {
  const fullPath = path.resolve(projectRoot, modPath);
  const content = fs.readFileSync(fullPath, 'utf8');
  const regex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"])/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const importPath = match[1] || match[2];
    if (importPath.startsWith('.')) {
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
// Compute transitive dependency graph starting from src/admin.js
console.log('\n--- Transitive Dependency Closure from src/admin.js ---');
const visitedMods = new Set();
const modQueue = ['src/admin.js'];
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

console.log(`Total modules in transitive closure from src/admin.js: ${visitedMods.size}`);
console.log('Modules in closure:', [...visitedMods].sort());
if (transitiveErrors.length === 0) {
  console.log('TRANSITIVE CLOSURE RESULT: PASS - All transitive imports are valid .js files and exist on disk.');
} else {
  console.error('TRANSITIVE CLOSURE RESULT: FAIL -', transitiveErrors);
}

// 2. DOM ID coverage check: all 188 element IDs in admin.html
console.log('\n=== STEP 2: VERIFY DOM ID COVERAGE (188 IDs in admin.html) ===');
const adminHtmlPath = path.resolve(projectRoot, 'admin.html');
const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');

// Extract all id="..." attributes in admin.html
const idRegex = /\bid=["']([^"']+)["']/g;
const htmlIds = new Set();
let idMatch;
while ((idMatch = idRegex.exec(adminHtml)) !== null) {
  htmlIds.add(idMatch[1]);
}

console.log(`Unique IDs found in admin.html: ${htmlIds.size}`);

// Read all 12 modules combined
const moduleContents = modules.map(m => {
  const p = path.resolve(projectRoot, m);
  return { path: m, content: fs.readFileSync(p, 'utf8') };
});
const combinedModules = moduleContents.map(m => m.content).join('\n');

const referencedIds = new Set();
const unreferencedIds = [];

htmlIds.forEach(id => {
  // Check if ID appears in any module (as string literal, getElementById, querySelector, etc.)
  // We check for exact token / substring occurrences
  const escapedId = id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const searchRegex = new RegExp(`['"\`#]${escapedId}['"\`]|\b${escapedId}\b`);
  if (searchRegex.test(combinedModules)) {
    referencedIds.add(id);
  } else {
    unreferencedIds.push(id);
  }
});

console.log(`IDs referenced in decomposed modules: ${referencedIds.size}`);
console.log(`IDs unreferenced in decomposed modules: ${unreferencedIds.length}`);
if (unreferencedIds.length > 0) {
  console.log('Unreferenced IDs detail:', unreferencedIds);
}

// Compare with original admin.js in git HEAD
import { execSync } from 'node:child_process';
const origAdmin = execSync('git show HEAD:src/admin.js', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

const origReferencedIds = new Set();
htmlIds.forEach(id => {
  const escapedId = id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const searchRegex = new RegExp(`['"\`#]${escapedId}['"\`]|\b${escapedId}\b`);
  if (searchRegex.test(origAdmin)) {
    origReferencedIds.add(id);
  }
});

console.log(`IDs referenced in original monolithic admin.js: ${origReferencedIds.size}`);
const droppedIds = [];
origReferencedIds.forEach(id => {
  if (!referencedIds.has(id)) {
    droppedIds.push(id);
  }
});

console.log(`Dropped IDs (referenced originally but missing now): ${droppedIds.length}`);
if (droppedIds.length > 0) {
  console.error('DROPPED IDS DETECTED:', droppedIds);
} else {
  console.log('STEP 2 RESULT: PASS - Zero accidental ID drops (100% of originally referenced IDs are preserved).');
}

console.log('Analysis of unreferenced IDs:');
unreferencedIds.forEach(id => {
  const origHadIt = origReferencedIds.has(id);
  const idx = adminHtml.indexOf(`id="${id}"`);
  const snippet = adminHtml.substring(Math.max(0, idx - 40), Math.min(adminHtml.length, idx + 80)).replace(/\n/g, ' ');
  console.log(`  - ID "${id}" (in orig: ${origHadIt}): context snippet -> ...${snippet}...`);
});

// Inverse check: check all getElementById and #id selectors in JS modules to ensure they exist in admin.html
console.log('\n--- Inverse Check: Modules Querying Non-existent IDs ---');
const queriedIds = new Map(); // id -> array of modules
const queryPatterns = [
  /\$\(\s*['"]([a-zA-Z0-9_-]+)['"]\s*\)/g,
  /getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /querySelector(?:All)?\s*\(\s*['"]#([a-zA-Z0-9_-]+)[^'"]*['"]\s*\)/g,
  /\bbyId\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bel\s*\(\s*['"]([^'"]+)['"]\s*\)/g
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

console.log(`Total queried IDs found in JS: ${queriedIds.size}`);
if (missingQueriedIds.length > 0) {
  console.error('CRITICAL: Modules query IDs that do NOT exist in admin.html:', missingQueriedIds);
} else {
  console.log('PASS: All queried IDs in JS modules exist in admin.html (0 phantom element queries).');
}

// 3. Line counts verification across all decomposed files
console.log('\n=== STEP 3: INDEPENDENT LINE COUNTS VERIFICATION ===');
let lineCountViolations = [];
modules.forEach(m => {
  const p = path.resolve(projectRoot, m);
  const lines = fs.readFileSync(p, 'utf8').split('\n').length;
  const isMain = m === 'src/admin.js';
  const isLedger = m === 'src/admin-distribution-ledger.js';
  const limit = isMain ? 150 : isLedger ? 300 : 400;
  const pass = lines <= limit;
  console.log(`  ${m}: ${lines} lines (Limit: <= ${limit}) -> ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) {
    lineCountViolations.push(`${m} exceeds line limit (${lines} > ${limit})`);
  }
});

if (lineCountViolations.length === 0) {
  console.log('STEP 3 RESULT: PASS - All modules satisfy line count constraints.');
} else {
  console.error('STEP 3 RESULT: FAIL - Line count violations:');
  lineCountViolations.forEach(v => console.error('  - ' + v));
}

// 4. Critical symbol resolution verification across modules
console.log('\n=== STEP 4: SYMBOL RESOLUTION & IMPORT BINDING VERIFICATION ===');
const criticalSymbols = [
  { file: 'src/admin-view-editor.js', symbol: 'deleteCard', type: 'definition' },
  { file: 'src/admin-distribution-ui.js', symbol: 'renderDistributionLedger', type: 'import' },
  { file: 'src/admin-distribution-ui.js', symbol: 'deleteDocumentsInChunks', type: 'import' },
  { file: 'src/admin-distribution-ledger.js', symbol: 'renderDistributionLedger', type: 'export' },
  { file: 'src/admin-distribution-ledger.js', symbol: 'deleteDistributionExpense', type: 'export' },
  { file: 'src/admin-distribution-ledger.js', symbol: 'deleteDocumentsInChunks', type: 'export' },
  { file: 'src/admin-distribution-ledger.js', symbol: 'clearDistributionLedger', type: 'export' }
];

let symbolErrors = [];
criticalSymbols.forEach(({ file, symbol, type }) => {
  const content = fs.readFileSync(path.resolve(projectRoot, file), 'utf8');
  let valid = false;
  if (type === 'definition') {
    valid = new RegExp(`(?:function\\s+${symbol}\\b|const\\s+${symbol}\\s*=)`).test(content);
  } else if (type === 'import') {
    valid = new RegExp(`import\\s+.*?\\b${symbol}\\b.*?from`).test(content);
  } else if (type === 'export') {
    valid = new RegExp(`export\\s+(?:async\\s+)?function\\s+${symbol}\\b|export\\s*{[^}]*\\b${symbol}\\b[^}]*}`).test(content);
  }
  console.log(`  [${file}] ${symbol} (${type}): ${valid ? 'PASS' : 'FAIL'}`);
  if (!valid) symbolErrors.push(`[${file}] Missing ${type} of "${symbol}"`);
});

// Check that all imported named identifiers across all decomposed modules actually exist in target module exports
console.log('\n--- Checking All Imported Named Identifiers Across Decomposed Modules ---');
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

console.log(`Total named import identifiers checked across ${modules.length} modules: ${totalNamedChecked}`);
if (bindingErrors.length === 0) {
  console.log('PASS: All imported named identifiers exist in the exported symbols of their target modules.');
} else {
  console.error('FAIL: Missing imported symbols detected:');
  bindingErrors.forEach(err => console.error('  - ' + err));
}

const totalStep4Errors = symbolErrors.length + bindingErrors.length;
if (totalStep4Errors === 0) {
  console.log('STEP 4 RESULT: PASS - All critical symbols and named imports are properly resolved.');
} else {
  console.error(`STEP 4 RESULT: FAIL - ${totalStep4Errors} symbol resolution error(s) found.`);
}

// Summary and exit code enforcement
const totalErrors = importErrors.length +
  (hasCycle ? 1 : 0) +
  transitiveErrors.length +
  droppedIds.length +
  missingQueriedIds.length +
  lineCountViolations.length +
  totalStep4Errors;

if (totalErrors > 0) {
  console.error(`\nOVERALL VERIFICATION FAILED: ${totalErrors} issue(s) detected.`);
  process.exit(1);
} else {
  console.log('\nOVERALL VERIFICATION PASSED: All M2 architectural and symbol integrity checks succeeded.');
}

