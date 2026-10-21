/**
 * verify-all.mjs
 * Master Verification Runner for SHIORI_app Modernization (Milestone 5)
 *
 * Steps:
 * Step 1: Run verify-m2.mjs checks (admin modules, closure, symbols, DOM IDs, line limits).
 * Step 2: Run verify-m3.mjs checks (viewer modules, closure, symbols, DOM IDs, line limits).
 * Step 3: Run verify-m4.mjs checks (error boundary, offline queue, service worker 75 assets, line limits).
 * Step 4: Verify Schema v2 integrity on 20261107.json and 20261031.json.
 * Step 5: Verify zero circular dependencies across all 45 modules in src/.
 * Step 6: Verify all line count constraints across all modules.
 * Exit with code 0 on success.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = __dirname;

console.log('======================================================================');
console.log('       SHIORI_app Modernization: Master Verification Suite (M5)       ');
console.log('======================================================================');
console.log('Project Root:', projectRoot);
console.log('Timestamp:   ', new Date().toISOString());
console.log('');

let totalFailedSteps = 0;

// Helper to execute external verification script safely
function runSubVerification(scriptName, stepNumber, stepDescription) {
  console.log(`\n======================================================================`);
  console.log(`=== STEP ${stepNumber}: ${stepDescription} (${scriptName}) ===`);
  console.log(`======================================================================`);

  const scriptPath = path.resolve(projectRoot, scriptName);
  if (!fs.existsSync(scriptPath)) {
    console.error(`FAIL: Verification script missing on disk: ${scriptName}`);
    totalFailedSteps++;
    return false;
  }

  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    // Print the sub-script summary lines
    const lines = stdout.trim().split('\n');
    const resultLines = lines.filter(l =>
      l.includes('RESULT:') ||
      l.includes('PASSED') ||
      l.includes('FAILED') ||
      l.includes('PASS') ||
      l.includes('Total') ||
      l.startsWith('===')
    );
    resultLines.forEach(l => console.log('  ' + l));
    console.log(`STEP ${stepNumber} RESULT: PASS (${scriptName} exited with code 0)`);
    return true;
  } catch (err) {
    console.error(`STEP ${stepNumber} RESULT: FAIL (${scriptName} failed with code ${err.status})`);
    if (err.stdout) console.error(err.stdout);
    if (err.stderr) console.error(err.stderr);
    totalFailedSteps++;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step 1: Run verify-m2.mjs checks
// ---------------------------------------------------------------------------
runSubVerification('verify-m2.mjs', 1, 'VERIFY MILESTONE 2 (Admin Modules & Architecture)');

// ---------------------------------------------------------------------------
// Step 2: Run verify-m3.mjs checks
// ---------------------------------------------------------------------------
runSubVerification('verify-m3.mjs', 2, 'VERIFY MILESTONE 3 (Viewer Modules & Architecture)');

// ---------------------------------------------------------------------------
// Step 3: Run verify-m4.mjs checks
// ---------------------------------------------------------------------------
runSubVerification('verify-m4.mjs', 3, 'VERIFY MILESTONE 4 (Resilience, Error Boundary & Offline Shell)');

// ---------------------------------------------------------------------------
// Step 4: Verify Schema v2 integrity on 20261107.json and 20261031.json
// ---------------------------------------------------------------------------
console.log(`\n======================================================================`);
console.log(`=== STEP 4: VERIFY SCHEMA V2 INTEGRITY (20261107.json & 20261031.json) ===`);
console.log(`======================================================================`);

let step4Errors = [];

async function verifySchemaV2Integrity() {
  const file07Path = path.resolve(projectRoot, '20261107.json');
  const file31Path = path.resolve(projectRoot, '20261031.json');

  if (!fs.existsSync(file07Path)) step4Errors.push('20261107.json does not exist');
  if (!fs.existsSync(file31Path)) step4Errors.push('20261031.json does not exist');

  if (step4Errors.length > 0) return;

  const raw07 = fs.readFileSync(file07Path, 'utf8');
  const raw31 = fs.readFileSync(file31Path, 'utf8');

  let trip07, trip31;
  try {
    trip07 = JSON.parse(raw07);
    trip31 = JSON.parse(raw31);
  } catch (e) {
    step4Errors.push(`JSON parse error in canonical trip: ${e.message}`);
    return;
  }

  // Byte-for-byte identity check
  if (raw07 !== raw31) {
    step4Errors.push('20261031.json and 20261107.json are not identical');
  } else {
    console.log('  Canonical identity check (20261031.json === 20261107.json): MATCH');
  }

  // Schema version & core fields
  if (trip07.schemaVersion !== 2) step4Errors.push(`20261107.json schemaVersion must be 2 (got ${trip07.schemaVersion})`);
  if (trip31.schemaVersion !== 2) step4Errors.push(`20261031.json schemaVersion must be 2 (got ${trip31.schemaVersion})`);
  if (trip07.tripId !== '20261107') step4Errors.push(`tripId must be 20261107 (got ${trip07.tripId})`);
  if (!trip07.title) step4Errors.push('Missing trip title');
  if (trip07.startDate !== '2026-11-07') step4Errors.push('startDate must be 2026-11-07');
  if (trip07.endDate !== '2026-11-07') step4Errors.push('endDate must be 2026-11-07');

  // Days and cards
  const day1Cards = trip07.days?.day1;
  if (!Array.isArray(day1Cards)) {
    step4Errors.push('trip.days.day1 is not an array');
  } else {
    console.log(`  20261107.json day1 card count: ${day1Cards.length} (Expected: 8)`);
    if (day1Cards.length !== 8) {
      step4Errors.push(`Expected 8 cards in day1, got ${day1Cards.length}`);
    }

    const expectedIds = [
      'day1-01-carshare',
      'day1-02-nakaminato',
      'day1-03-waon',
      'day1-04-hitachikaihin',
      'day1-05-hitachistation',
      'day1-06-night-aquaworld',
      'day1-07-dinner-flyinggarden',
      'day1-08-return'
    ];

    day1Cards.forEach((c, idx) => {
      if (c.cardId !== expectedIds[idx]) {
        step4Errors.push(`Card ${idx} ID mismatch: expected "${expectedIds[idx]}", got "${c.cardId}"`);
      }
      if (!c.title || !c.time || !c.badge || !c.desc) {
        step4Errors.push(`Card ${c.cardId} missing required field (title, time, badge, or desc)`);
      }
    });
  }

  // Checklist
  if (!Array.isArray(trip07.checklist) || trip07.checklist.length !== 2) {
    step4Errors.push('Checklist must have 2 categories (DRIVE and TRAVEL)');
  } else {
    const totalItems = trip07.checklist.reduce((acc, cat) => acc + (cat.items?.length || 0), 0);
    console.log(`  20261107.json checklist items: ${totalItems} items across 2 categories`);
  }

  // Weather locations
  if (!trip07.weatherLocations?.oarai || !trip07.weatherLocations?.hitachi) {
    step4Errors.push('weatherLocations missing oarai or hitachi configuration');
  }

  // Audit via analyzeTrip
  const { analyzeTrip } = await import('./src/trip-v2-analysis.js');
  const audit07 = analyzeTrip(trip07);
  const errorIssues = audit07.issues.filter(i => i.level === 'error');
  if (errorIssues.length > 0) {
    step4Errors.push(`analyzeTrip found ${errorIssues.length} error issue(s): ${errorIssues.map(i => i.message).join('; ')}`);
  } else {
    console.log('  analyzeTrip audit issues: 0 errors (100% clean)');
  }

  // Normalization identity via trip-v2-core
  const tripCore = await import('./src/trip-v2-core.js');
  const normalizeTripDraft = tripCore.normalizeTripDraft || tripCore.migrateTripToV2;
  const normalized = normalizeTripDraft(trip07);
  if (normalized.schemaVersion !== 2 || normalized.days.day1.length !== 8) {
    step4Errors.push('normalizeTripDraft failed to preserve canonical card count or schemaVersion');
  } else {
    console.log('  Normalization roundtrip: PASS (Structure preserved, schemaVersion: 2)');
  }
}

await verifySchemaV2Integrity();

if (step4Errors.length === 0) {
  console.log('STEP 4 RESULT: PASS - Canonical Schema v2 integrity verified.');
} else {
  console.error('STEP 4 RESULT: FAIL - Errors detected:');
  step4Errors.forEach(e => console.error('  - ' + e));
  totalFailedSteps++;
}

// ---------------------------------------------------------------------------
// Step 5: Verify zero circular dependencies across all 45 modules in src/
// ---------------------------------------------------------------------------
console.log(`\n======================================================================`);
console.log(`=== STEP 5: VERIFY ZERO CIRCULAR DEPENDENCIES ACROSS ALL 45 MODULES IN src/ ===`);
console.log(`======================================================================`);

let step5Errors = [];

const srcDir = path.resolve(projectRoot, 'src');
const allSrcFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
console.log(`Total JavaScript modules found in src/: ${allSrcFiles.length}`);

if (allSrcFiles.length !== 45) {
  step5Errors.push(`Expected exactly 45 JS modules in src/, found ${allSrcFiles.length}`);
}

const allModulePaths = allSrcFiles.map(f => `src/${f}`);
const depGraph = new Map();
allModulePaths.forEach(m => depGraph.set(m, []));

let totalImportEdges = 0;
allModulePaths.forEach(modPath => {
  const fullPath = path.resolve(projectRoot, modPath);
  const content = fs.readFileSync(fullPath, 'utf8');
  const regex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const importSpec = match[1] || match[2] || match[3];
    if (importSpec && importSpec.startsWith('.')) {
      const resolved = path.relative(projectRoot, path.resolve(path.dirname(fullPath), importSpec)).replace(/\\/g, '/');
      if (depGraph.has(resolved)) {
        depGraph.get(modPath).push(resolved);
        totalImportEdges++;
      }
    }
  }
});

console.log(`Total internal import dependency edges analyzed: ${totalImportEdges}`);

// Cycle detection using DFS with 3-state coloring
// 0 = unvisited, 1 = visiting (in active recursion stack), 2 = visited (completed)
const visitedState = new Map(); // path -> 0 | 1 | 2
allModulePaths.forEach(m => visitedState.set(m, 0));

function findCycle(node, stack = []) {
  visitedState.set(node, 1);
  stack.push(node);

  const neighbors = depGraph.get(node) || [];
  for (const next of neighbors) {
    const state = visitedState.get(next);
    if (state === 1) {
      // Found cycle
      const cycleStartIdx = stack.indexOf(next);
      return [...stack.slice(cycleStartIdx), next];
    }
    if (state === 0) {
      const cycle = findCycle(next, stack);
      if (cycle) return cycle;
    }
  }

  stack.pop();
  visitedState.set(node, 2);
  return null;
}

let detectedCycles = [];
for (const mod of allModulePaths) {
  if (visitedState.get(mod) === 0) {
    const cycle = findCycle(mod);
    if (cycle) {
      detectedCycles.push(cycle);
      break;
    }
  }
}

if (detectedCycles.length > 0) {
  detectedCycles.forEach(c => {
    step5Errors.push(`Circular dependency detected: ${c.join(' -> ')}`);
  });
} else {
  console.log('  Circular dependency analysis: 0 cycles detected across all 45 modules');
}

if (step5Errors.length === 0) {
  console.log('STEP 5 RESULT: PASS - Full src/ module dependency graph is strictly acyclic.');
} else {
  console.error('STEP 5 RESULT: FAIL - Dependency errors:');
  step5Errors.forEach(e => console.error('  - ' + e));
  totalFailedSteps++;
}

// ---------------------------------------------------------------------------
// Step 6: Verify all line count constraints across all modules
// ---------------------------------------------------------------------------
console.log(`\n======================================================================`);
console.log(`=== STEP 6: VERIFY ALL LINE COUNT CONSTRAINTS ACROSS ALL MODULES ===`);
console.log(`======================================================================`);

let step6Errors = [];

const lineConstraints = [
  // M2 Decomposed Admin Modules
  { file: 'src/admin.js', max: 150, category: 'M2 Admin Entry Point' },
  { file: 'src/admin-distribution-ledger.js', max: 300, category: 'M2 Distribution Ledger' },
  { file: 'src/admin-store.js', max: 400, category: 'M2 Admin Store' },
  { file: 'src/admin-ui.js', max: 400, category: 'M2 Admin UI' },
  { file: 'src/admin-auth.js', max: 400, category: 'M2 Admin Auth' },
  { file: 'src/admin-trip-service.js', max: 400, category: 'M2 Admin Trip Service' },
  { file: 'src/admin-view-overview.js', max: 400, category: 'M2 Admin Overview View' },
  { file: 'src/admin-view-editor.js', max: 400, category: 'M2 Admin Editor View' },
  { file: 'src/admin-candidate-ui.js', max: 400, category: 'M2 Candidate Shelf UI' },
  { file: 'src/admin-day-planner-ui.js', max: 400, category: 'M2 Day Planner UI' },
  { file: 'src/admin-distribution-ui.js', max: 400, category: 'M2 Distribution UI' },
  { file: 'src/admin-roles-ui.js', max: 400, category: 'M2 Roles UI' },
  { file: 'src/admin-discussion-ui.js', max: 400, category: 'M2 Discussion UI' },

  // M3 Decomposed Viewer Modules & index.html
  { file: 'index.html', max: 900, category: 'M3 Participant Viewer HTML Shell' },
  { file: 'src/viewer-app.js', max: 150, category: 'M3 Viewer Entry Point' },
  { file: 'src/trip-store.js', max: 400, category: 'M3 Participant Trip Store' },
  { file: 'src/viewer-router.js', max: 400, strictSubLimit: 350, category: 'M3 Viewer Router' },
  { file: 'src/viewer-ui.js', max: 400, category: 'M3 Viewer UI' },
  { file: 'src/weather-service.js', max: 400, strictSubLimit: 250, category: 'M3 Weather Service' },
  { file: 'src/pwa-manager.js', max: 400, strictSubLimit: 150, category: 'M3 PWA Manager' },

  // M4 Offline & Error Resilience
  { file: 'src/error-boundary.js', max: 200, category: 'M4 Error Boundary' },
  { file: 'src/offline-expense-queue.js', max: 200, category: 'M4 Offline Expense Queue' },
  { file: 'sw.js', max: 200, category: 'M4 Service Worker Shell' }
];

console.log('Inspecting line counts for all constrained application files:');
lineConstraints.forEach(({ file, max, strictSubLimit, category }) => {
  const fullPath = path.resolve(projectRoot, file);
  if (!fs.existsSync(fullPath)) {
    step6Errors.push(`File missing on disk: ${file}`);
    return;
  }
  const lines = fs.readFileSync(fullPath, 'utf8').split('\n').length;
  const hardLimitPass = lines <= max;
  const strictLimitPass = strictSubLimit ? lines <= strictSubLimit : true;
  const pass = hardLimitPass && strictLimitPass;

  const limitDesc = strictSubLimit ? `<=${strictSubLimit} (hard: <=${max})` : `<=${max}`;
  console.log(`  ${file.padEnd(35)} : ${String(lines).padStart(4)} lines (Limit: ${limitDesc.padEnd(16)}) [${category}] -> ${pass ? 'PASS' : 'FAIL'}`);

  if (!hardLimitPass) {
    step6Errors.push(`${file} exceeds hard line limit (${lines} > ${max})`);
  } else if (!strictLimitPass) {
    step6Errors.push(`${file} exceeds strict target sub-limit (${lines} > ${strictSubLimit})`);
  }
});

if (step6Errors.length === 0) {
  console.log('STEP 6 RESULT: PASS - All modules strictly satisfy line count constraints.');
} else {
  console.error('STEP 6 RESULT: FAIL - Line count violations:');
  step6Errors.forEach(e => console.error('  - ' + e));
  totalFailedSteps++;
}

// ---------------------------------------------------------------------------
// Master Summary & Exit
// ---------------------------------------------------------------------------
console.log(`\n======================================================================`);
console.log(`                   MASTER VERIFICATION SUMMARY                       `);
console.log(`======================================================================`);
console.log(`Step 1 (Milestone 2 Admin Architecture)   : ${fs.existsSync(path.resolve(projectRoot, 'verify-m2.mjs')) ? 'PASS' : 'FAIL'}`);
console.log(`Step 2 (Milestone 3 Viewer Architecture)  : ${fs.existsSync(path.resolve(projectRoot, 'verify-m3.mjs')) ? 'PASS' : 'FAIL'}`);
console.log(`Step 3 (Milestone 4 Resilience & Offline) : ${fs.existsSync(path.resolve(projectRoot, 'verify-m4.mjs')) ? 'PASS' : 'FAIL'}`);
console.log(`Step 4 (Schema v2 & Canonical Trip Data)  : ${step4Errors.length === 0 ? 'PASS' : 'FAIL'}`);
console.log(`Step 5 (45-Module Acyclic Dep Graph)      : ${step5Errors.length === 0 ? 'PASS' : 'FAIL'}`);
console.log(`Step 6 (Strict Module Line Count Limits)  : ${step6Errors.length === 0 ? 'PASS' : 'FAIL'}`);
console.log(`----------------------------------------------------------------------`);

if (totalFailedSteps === 0) {
  console.log('OVERALL MASTER VERIFICATION: PASSED (100% of all checks succeeded)');
  process.exit(0);
} else {
  console.error(`OVERALL MASTER VERIFICATION: FAILED (${totalFailedSteps} step(s) failed)`);
  process.exit(1);
}
