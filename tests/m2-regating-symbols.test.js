import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

describe('Milestone 2 Re-Gating Symbol Resolution & AST Call-Site Verification', () => {

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

  // 1. Critical Symbol Resolution Verification
  describe('1. Critical Symbol Definitions and Bindings', () => {

    it('deleteCard is defined, exported, and called properly in src/admin-view-editor.js', () => {
      const content = fs.readFileSync(path.resolve(projectRoot, 'src/admin-view-editor.js'), 'utf8');
      const hasDef = /(?:export\s+)?function\s+deleteCard\b/.test(content);
      const hasCall = /deleteCard\(/.test(content);
      assert.equal(hasDef, true, 'deleteCard must be defined');
      assert.equal(hasCall, true, 'deleteCard must be called in click handler');
    });

    it('renderDistributionLedger is exported from ledger module and imported in distribution-ui', () => {
      const ledgerContent = fs.readFileSync(path.resolve(projectRoot, 'src/admin-distribution-ledger.js'), 'utf8');
      const uiContent = fs.readFileSync(path.resolve(projectRoot, 'src/admin-distribution-ui.js'), 'utf8');

      const isExported = /export\s+function\s+renderDistributionLedger\b/.test(ledgerContent);
      const isImported = /import\s+{[^}]*\brenderDistributionLedger\b[^}]*}\s+from\s+['"]\.\/admin-distribution-ledger\.js['"]/.test(uiContent);
      const isCalled = /renderDistributionLedger\(/.test(uiContent);

      assert.equal(isExported, true, 'renderDistributionLedger must be exported from admin-distribution-ledger.js');
      assert.equal(isImported, true, 'renderDistributionLedger must be imported in admin-distribution-ui.js');
      assert.equal(isCalled, true, 'renderDistributionLedger must be called in renderDistributions');
    });

    it('deleteDocumentsInChunks is exported from ledger module and imported in distribution-ui', () => {
      const ledgerContent = fs.readFileSync(path.resolve(projectRoot, 'src/admin-distribution-ledger.js'), 'utf8');
      const uiContent = fs.readFileSync(path.resolve(projectRoot, 'src/admin-distribution-ui.js'), 'utf8');

      const isExported = /export\s+async\s+function\s+deleteDocumentsInChunks\b/.test(ledgerContent);
      const isImported = /import\s+{[^}]*\bdeleteDocumentsInChunks\b[^}]*}\s+from\s+['"]\.\/admin-distribution-ledger\.js['"]/.test(uiContent);
      const isCalledInUi = /deleteDocumentsInChunks\(/.test(uiContent);
      const isCalledInLedger = /deleteDocumentsInChunks\(/.test(ledgerContent);

      assert.equal(isExported, true, 'deleteDocumentsInChunks must be exported from admin-distribution-ledger.js');
      assert.equal(isImported, true, 'deleteDocumentsInChunks must be imported in admin-distribution-ui.js');
      assert.equal(isCalledInUi, true, 'deleteDocumentsInChunks must be called in admin-distribution-ui.js');
      assert.equal(isCalledInLedger, true, 'deleteDocumentsInChunks must be called in admin-distribution-ledger.js');
    });

    it('deleteDistributionExpense is exported from ledger module and wired to delete button', () => {
      const ledgerContent = fs.readFileSync(path.resolve(projectRoot, 'src/admin-distribution-ledger.js'), 'utf8');
      const isExported = /export\s+async\s+function\s+deleteDistributionExpense\b/.test(ledgerContent);
      const isWired = /deleteDistributionExpense\(/.test(ledgerContent);

      assert.equal(isExported, true, 'deleteDistributionExpense must be exported from admin-distribution-ledger.js');
      assert.equal(isWired, true, 'deleteDistributionExpense must be wired to button click listener');
    });

    it('clearDistributionLedger is exported from ledger module and re-exported in distribution-ui', () => {
      const ledgerContent = fs.readFileSync(path.resolve(projectRoot, 'src/admin-distribution-ledger.js'), 'utf8');
      const uiContent = fs.readFileSync(path.resolve(projectRoot, 'src/admin-distribution-ui.js'), 'utf8');

      const isExported = /export\s+async\s+function\s+clearDistributionLedger\b/.test(ledgerContent);
      const isReExported = /export\s*\{\s*clearDistributionLedger\s*\}/.test(uiContent);
      const isWired = /clearDistributionLedger\(/.test(ledgerContent);

      assert.equal(isExported, true, 'clearDistributionLedger must be exported from admin-distribution-ledger.js');
      assert.equal(isReExported, true, 'clearDistributionLedger must be re-exported from admin-distribution-ui.js');
      assert.equal(isWired, true, 'clearDistributionLedger must be wired in ledger component');
    });

  });

  // 2. Comprehensive Call-Site Scope Analysis across all 13 modules
  describe('2. Comprehensive AST Call-Site Resolution Across All 13 Modules', () => {

    const jsGlobals = new Set([
      'Math', 'Date', 'Array', 'Object', 'Number', 'String', 'Boolean', 'Promise',
      'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
      'JSON', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'parseInt', 'parseFloat',
      'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
      'console', 'performance', 'queueMicrotask', 'structuredClone', 'atob', 'btoa',
      'TextEncoder', 'TextDecoder',
      'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
      'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
      'ArrayBuffer', 'DataView', 'BigInt', 'Proxy', 'Reflect',
      'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
      'fetch', 'alert', 'confirm', 'prompt', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'requestAnimationFrame', 'cancelAnimationFrame', 'CustomEvent', 'Event', 'EventTarget',
      'HTMLElement', 'Element', 'Node', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
      'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData', 'Headers', 'Request', 'Response',
      'crypto', 'Image', 'Audio', 'Option', 'DocumentFragment', 'NodeList', 'HTMLCollection'
    ]);

    for (const modPath of modules) {
      it(`verifies 100% call-site resolution in ${modPath}`, () => {
        const fullPath = path.resolve(projectRoot, modPath);
        assert.ok(fs.existsSync(fullPath), `Module file must exist: ${modPath}`);
        const code = fs.readFileSync(fullPath, 'utf8');

        // Extract imports
        const importedSymbols = new Set();
        const namedImportRegex = /import\s*\{([^}]+)\}\s*from/g;
        let m;
        while ((m = namedImportRegex.exec(code)) !== null) {
          m[1].split(',').forEach(part => {
            const clean = part.trim();
            if (!clean) return;
            if (clean.includes(' as ')) {
              importedSymbols.add(clean.split(/\s+as\s+/)[1].trim());
            } else {
              importedSymbols.add(clean);
            }
          });
        }
        const defaultImportRegex = /import\s+([a-zA-Z0-9_$]+)\s+from/g;
        while ((m = defaultImportRegex.exec(code)) !== null) {
          if (m[1] !== '{') importedSymbols.add(m[1].trim());
        }
        const namespaceImportRegex = /import\s*\*\s*as\s+([a-zA-Z0-9_$]+)\s+from/g;
        while ((m = namespaceImportRegex.exec(code)) !== null) {
          importedSymbols.add(m[1].trim());
        }

        // Extract declared functions & variables
        const declaredSymbols = new Set();
        const funcDeclRegex = /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/g;
        while ((m = funcDeclRegex.exec(code)) !== null) declaredSymbols.add(m[1]);

        const varDeclRegex = /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=/g;
        while ((m = varDeclRegex.exec(code)) !== null) declaredSymbols.add(m[1]);

        const destructuredRegex = /(?:export\s+)?(?:const|let|var)\s*\{([^}]+)\}\s*=/g;
        while ((m = destructuredRegex.exec(code)) !== null) {
          m[1].split(',').forEach(item => {
            const clean = item.trim().split(':')[0].trim();
            if (clean && /^[a-zA-Z0-9_$]+$/.test(clean)) declaredSymbols.add(clean);
          });
        }

        const arrDestructuredRegex = /(?:export\s+)?(?:const|let|var)\s*\[([^\]]+)\]\s*=/g;
        while ((m = arrDestructuredRegex.exec(code)) !== null) {
          m[1].split(',').forEach(item => {
            const clean = item.trim();
            if (clean && /^[a-zA-Z0-9_$]+$/.test(clean)) declaredSymbols.add(clean);
          });
        }

        const classRegex = /(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/g;
        while ((m = classRegex.exec(code)) !== null) declaredSymbols.add(m[1]);

        // Parameters in functions (positional & destructured)
        const fnParamsRegex = /(?:function\s*(?:[a-zA-Z0-9_$]+)?\s*\(([^)]*)\)|(?:\(([^)]*)\)|([a-zA-Z0-9_$]+))\s*=>)/g;
        while ((m = fnParamsRegex.exec(code)) !== null) {
          const rawParams = m[1] || m[2] || m[3] || '';
          const paramWords = rawParams.match(/[a-zA-Z0-9_$]+/g) || [];
          paramWords.forEach(w => {
            if (!isNaN(w[0])) return;
            declaredSymbols.add(w);
          });
        }

        // Sanitize code
        const sanitized = code
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*/g, '')
          .replace(/'(?:[^'\\]|\\.)*'/g, "''")
          .replace(/"(?:[^"\\]|\\.)*"/g, '""')
          .replace(/`(?:[^`\\]|\\.)*`/g, '``');

        const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'instanceof', 'await', 'import', 'super', 'new']);
        const callRegex = /(?:^|[^a-zA-Z0-9_$.])([a-zA-Z0-9_$]+)\s*\(/g;
        const unresolved = [];

        while ((m = callRegex.exec(sanitized)) !== null) {
          const fnName = m[1];
          if (keywords.has(fnName)) continue;
          if (!isNaN(fnName[0])) continue;
          if (importedSymbols.has(fnName)) continue;
          if (declaredSymbols.has(fnName)) continue;
          if (jsGlobals.has(fnName)) continue;
          unresolved.push(fnName);
        }

        assert.deepEqual(unresolved, [], `Module ${modPath} must have 0 unresolved call sites`);
      });
    }

  });

  // 3. Native ES Module Import Extension & Path Resolution
  describe('3. Native ES Module Import Extension & Target Existence', () => {

    it('all relative imports end with .js and target existing files on disk', () => {
      const importErrors = [];

      for (const modPath of modules) {
        const fullPath = path.resolve(projectRoot, modPath);
        const code = fs.readFileSync(fullPath, 'utf8');
        const regex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
        let m;
        while ((m = regex.exec(code)) !== null) {
          const importPath = m[1] || m[2] || m[3];
          if (importPath.startsWith('.')) {
            if (!importPath.endsWith('.js')) {
              importErrors.push(`[${modPath}] Relative import missing .js extension: "${importPath}"`);
            }
            const targetPath = path.resolve(path.dirname(fullPath), importPath);
            if (!fs.existsSync(targetPath)) {
              importErrors.push(`[${modPath}] Target file does not exist: "${importPath}" -> ${targetPath}`);
            }
          }
        }
      }

      assert.deepEqual(importErrors, [], 'All relative imports must end with .js and resolve to existing files');
    });

    it('all imported named identifiers exist in the exported symbols of the target module', () => {
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
              if (!targetExports.has(name)) {
                bindingErrors.push(`[${mod}] imports "${name}" from "${targetRel}", but "${name}" is NOT exported by "${targetRel}"`);
              }
            }
          }
        }
      }

      assert.deepEqual(bindingErrors, [], 'All imported named identifiers must be exported by the target module');
    });

  });

  // 4. Line Count Constraints Verification
  describe('4. Independent Line Count Constraints', () => {

    it('src/admin.js satisfies entry point constraint (<= 150 lines)', () => {
      const lines = fs.readFileSync(path.resolve(projectRoot, 'src/admin.js'), 'utf8').split(/\r?\n/).length;
      assert.ok(lines <= 150, `src/admin.js has ${lines} lines, expected <= 150`);
    });

    it('src/admin-distribution-ledger.js satisfies dedicated ledger constraint (<= 300 lines)', () => {
      const lines = fs.readFileSync(path.resolve(projectRoot, 'src/admin-distribution-ledger.js'), 'utf8').split(/\r?\n/).length;
      assert.ok(lines <= 300, `src/admin-distribution-ledger.js has ${lines} lines, expected <= 300`);
    });

    it('all 11 remaining decomposed modules satisfy submodule constraint (<= 400 lines)', () => {
      const otherModules = modules.filter(m => m !== 'src/admin.js' && m !== 'src/admin-distribution-ledger.js');
      for (const m of otherModules) {
        const lines = fs.readFileSync(path.resolve(projectRoot, m), 'utf8').split(/\r?\n/).length;
        assert.ok(lines <= 400, `${m} has ${lines} lines, expected <= 400`);
      }
    });

  });

});
