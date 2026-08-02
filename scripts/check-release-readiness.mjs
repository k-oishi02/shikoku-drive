import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const publicBase = 'https://k-oishi02.github.io/shikoku-drive';
const requiredDomain = 'k-oishi02.github.io';
let blockers = 0;
let warnings = 0;

function pass(message) {
  console.log(`[PASS] ${message}`);
}

function block(message) {
  blockers += 1;
  console.log(`[BLOCKED] ${message}`);
}

function warn(message) {
  warnings += 1;
  console.log(`[WARN] ${message}`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^\uFEFF/, '');
}

for (const relativePath of [
  'index.html',
  'admin.html',
  'sw.js',
  'manifest.webmanifest',
  'firebase.json',
  '.firebaserc',
  'src/admin.js',
  'src/admin.css',
  'src/firebase-sync.js',
  'src/firestore.rules'
]) {
  if (fs.existsSync(path.join(root, relativePath))) pass(`${relativePath} が存在`);
  else block(`${relativePath} が見つかりません`);
}

try {
  const firebaseJson = JSON.parse(read('firebase.json'));
  if (firebaseJson?.firestore?.rules === 'src/firestore.rules') pass('Firebaseは検証済みFirestoreルールを参照');
  else block('firebase.jsonのFirestoreルール参照先が不正');
} catch (error) {
  block(`firebase.jsonを解析できません: ${error.message}`);
}

try {
  if (read('firestore.rules') === read('src/firestore.rules')) pass('ルート版と配備版のFirestoreルールが一致');
  else block('firestore.rulesとsrc/firestore.rulesが不一致');
} catch (error) {
  block(`Firestoreルールを比較できません: ${error.message}`);
}

const localSw = read('sw.js');
const localVersion = localSw.match(/shikoku-drive-pwa-v(\d+)/)?.[1];
if (localVersion) pass(`ローカルPWAはv${localVersion}`);
else block('ローカルPWAバージョンを取得できません');

try {
  const syncSource = read('src/firebase-sync.js');
  const apiKey = syncSource.match(/apiKey:\s*['"]([^'"]+)['"]/)?.[1];
  if (!apiKey) throw new Error('Firebase API key not found');
  const authConfig = await fetch(`https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(apiKey)}`);
  if (!authConfig.ok) throw new Error(`HTTP ${authConfig.status}`);
  const project = await authConfig.json();
  const domains = Array.isArray(project.authorizedDomains) ? project.authorizedDomains : [];
  if (domains.includes(requiredDomain)) pass(`${requiredDomain} はFirebase許可ドメイン`);
  else block(`${requiredDomain} をFirebase Authenticationの許可ドメインへ追加してください`);
} catch (error) {
  warn(`Firebase公開設定をオンライン確認できません: ${error.message}`);
}

try {
  const publicSwResponse = await fetch(`${publicBase}/sw.js`, { cache: 'no-store' });
  if (!publicSwResponse.ok) throw new Error(`HTTP ${publicSwResponse.status}`);
  const publicSw = await publicSwResponse.text();
  const publicVersion = publicSw.match(/shikoku-drive-pwa-v(\d+)/)?.[1];
  if (publicVersion === localVersion) pass(`公開PWAもv${publicVersion}`);
  else warn(`公開PWAはv${publicVersion || '不明'}、ローカルはv${localVersion || '不明'}です`);
} catch (error) {
  warn(`GitHub PagesのPWAバージョンを確認できません: ${error.message}`);
}

console.log('');
console.log(`SUMMARY: ${blockers} blocker(s), ${warnings} warning(s)`);
console.log('MANUAL: 匿名認証、Google認証、admins/{uid}、Firestoreルール公開、新規招待リンクをFirebase Consoleで確認してください。');
process.exitCode = blockers > 0 ? 1 : 0;
