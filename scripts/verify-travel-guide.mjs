import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const passes = [];

function pass(message) { passes.push(message); }
function fail(message) { failures.push(message); }
function assert(condition, message) {
    if (condition) pass(message);
    else fail(message);
}
function read(relativePath) {
    const absolutePath = path.join(root, relativePath);
    try {
        return fs.readFileSync(absolutePath, 'utf8');
    } catch (error) {
        fail(`${relativePath} を読み込めません: ${error.message}`);
        return '';
    }
}
function assertHttpUrl(value, label) {
    try {
        const url = new URL(String(value));
        assert(url.protocol === 'http:' || url.protocol === 'https:', `${label}: HTTPS/HTTPリンク`);
    } catch {
        fail(`${label}: URLが不正 (${String(value)})`);
    }
}

let data;
try {
    data = JSON.parse(read('data/shikoku2026.json').replace(/^\uFEFF/, ''));
    pass('JSON構文');
} catch (error) {
    fail(`JSON構文: ${error.message}`);
    data = null;
}

if (data) {
    assert(data.tripId === 'shikoku2026', '旅程ID');
    assert(/^\d{4}-\d{2}-\d{2}$/.test(data.startDate), '開始日形式');
    assert(/^\d{4}-\d{2}-\d{2}$/.test(data.endDate), '終了日形式');
    assert(data.startDate <= data.endDate, '開始日 <= 終了日');
    assert(data.days && typeof data.days === 'object', '日別データ');

    const ids = new Set();
    const imagePaths = new Set();
    let cardCount = 0;
    for (const [dayKey, cards] of Object.entries(data.days || {})) {
        assert(Array.isArray(cards) && cards.length > 0, `${dayKey}: カード配列`);
        for (const [index, card] of (cards || []).entries()) {
            cardCount += 1;
            const label = `${dayKey}[${index}] ${card.title || '(無題)'}`;
            assert(typeof card.time === 'string' && card.time.trim(), `${label}: 時刻`);
            assert(typeof card.title === 'string' && card.title.trim(), `${label}: タイトル`);
            assert(typeof card.badge === 'string' && card.badge.trim(), `${label}: バッジ`);
            assert(typeof card.desc === 'string' && card.desc.trim(), `${label}: 説明`);
            if (card.id) {
                assert(!ids.has(card.id), `${label}: ID重複なし (${card.id})`);
                ids.add(card.id);
            }
            if (card.image) {
                const imagePath = path.join(root, 'images', card.image);
                assert(fs.existsSync(imagePath), `${label}: 画像存在 (${card.image})`);
                imagePaths.add(card.image);
            }
            for (const field of ['official', 'tabelog', 'jalan']) {
                if (card[field]) assertHttpUrl(card[field], `${label}.${field}`);
            }
            for (const field of ['apple', 'google']) {
                if (card.wallet?.[field]) assertHttpUrl(card.wallet[field], `${label}.wallet.${field}`);
            }
            for (const [linkIndex, link] of (Array.isArray(card.links) ? card.links : []).entries()) {
                assert(typeof link.label === 'string' && link.label.trim(), `${label}.links[${linkIndex}]: ラベル`);
                if (link.url) assertHttpUrl(link.url, `${label}.links[${linkIndex}]`);
                else fail(`${label}.links[${linkIndex}]: URLがありません`);
            }
            const hasCoordinates = Number.isFinite(Number(card.lat)) && Number.isFinite(Number(card.lon));
            const showsMap = card.map !== false && hasCoordinates;
            if (showsMap && card.title.includes('→')) {
                assert(typeof card.mapQuery === 'string' && card.mapQuery.trim(), `${label}: 移動カードのMAP先を明示`);
            }
            if (card.tabelog) {
                assert(['GOURMET', 'DINNER'].includes(card.badge), `${label}: 食べログは食事カードのみ`);
            }
            if (card.jalan) {
                assert(card.badge === 'HOTEL' || /ホテル/.test(card.title), `${label}: JALANはホテルカードのみ`);
            }
            if (card.wallet) {
                assert(card.badge === 'FLIGHT', `${label}: Walletは航空カードのみ`);
            }
            if (card.badge === 'FOOD LIST') {
                assert(card.map === false, `${label}: 一覧カードに無関係なMAPを出さない`);
            }
        }
    }
    assert(cardCount >= 30, `カード総数 (${cardCount})`);
    for (const requiredId of [
        'day1-hotel-card',
        'pokemon-center-card',
        'father-beach-card',
        'matsuyama-drive-card',
        'towel-museum-card',
        'day3-lunch-card'
    ]) {
        assert(ids.has(requiredId), `重要カード ${requiredId}`);
    }
    const longda = (data.days.day2 || []).find(card => /長田 in 香の香/.test(card.title));
    assert(longda && longda.image !== 'chichibugahama.png', '長田 in 香の香に父母ヶ浜画像を流用しない');
}

const indexHtml = read('index.html');
assert(indexHtml.includes('function escapeHtml'), '動的HTMLエスケープ関数');
assert(indexHtml.includes('function safeExternalUrl'), '外部リンク許可リスト処理');
assert(indexHtml.includes("const raw = typeof value === 'string' ? value.trim() : '';") && indexHtml.includes("if (!raw) return '';") && indexHtml.includes('new URL(raw, window.location.href)'), 'safeExternalUrlは空値をURL解析前に拒否');
function isRenderableExternalUrl(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return false;
    try {
        const url = new URL(raw, 'https://example.test/');
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}
assert(!isRenderableExternalUrl(undefined) && !isRenderableExternalUrl('') && !isRenderableExternalUrl('   '), 'safeExternalUrl空値拒否');
if (data) {
    const allCards = Object.values(data.days || {}).flat();
    assert(allCards.length === 36, `全36カード (${allCards.length})`);
    const expectedButtonTitles = {
        tabelog: ['1軒目候補：手打十段 うどんバカ一代', 'そうめん作兵衛 (小豆島)', '骨付鳥 一鶴 (いっかく)', '2軒目：山越うどん', '3軒目候補：長田 in 香の香', '五志喜 本店 (19:30予約)'],
        jalan: ['高松国際ホテル', '愛媛県松山市へ移動 ＆ ホテル']
    };
    for (const [field, expectedTitles] of Object.entries(expectedButtonTitles)) {
        const actualTitles = allCards.filter(card => isRenderableExternalUrl(card[field])).map(card => card.title);
        assert(actualTitles.length === expectedTitles.length, `${field}: 実描画対象は期待件数 ${expectedTitles.length}件 (${actualTitles.length})`);
        assert(JSON.stringify(actualTitles) === JSON.stringify(expectedTitles), `${field}: 実描画対象タイトルが完全一致`);
    }
}
assert(indexHtml.includes('Array.isArray(card.links)'), '汎用リンク描画');
assert(indexHtml.includes('officialUrl = safeExternalUrl'), '公式リンク描画');
assert(indexHtml.includes('card.map !== false'), 'カード別MAP表示制御');
assert(indexHtml.includes("card.mapLabel || 'MAP →'"), 'カード別MAPラベル');
assert(indexHtml.includes('encodeURIComponent(String(t.id || \'\'))'), 'ポータルIDエスケープ');
assert(indexHtml.includes('unavailable: true'), '対象日外天気の明示');
assert(indexHtml.includes('daySwipeInitialized'), 'スワイプ重複登録防止');

const enhancements = read('src/enhancements.js');
assert(enhancements.includes('link.textContent.trim()'), 'NOWモードは明示ROUTEを優先');
assert(enhancements.includes("card.dataset.expenseShortcut === 'true'"), '割り勘対象をカード明示方式に限定');
assert(data.days.day1.some(card => card.title.includes('そうめん作兵衛') && card.expenseShortcut === true), '割り勘対象カードの明示');
assert(!data.days.day1.some(card => card.title.includes('うどんバカ一代') && card.expenseShortcut === true), 'Optional食事に割り勘ボタンを付けない');

const firebaseSync = read('src/firebase-sync.js');
assert(firebaseSync.includes('window._initSyncEngine = initSyncEngine'), '同期エンジン公開');
const rules = read('src/firestore.rules');
assert(rules.includes('request.auth != null'), 'Firestore認証必須ルール');

const adminHtml = read('admin.html');
const sw = read('sw.js');
const legacyEnhancements = read('enhancements.js');
const legacyFirebaseSync = read('firebase-sync.js');
const localSources = [['index.html', indexHtml], ['admin.html', adminHtml], ['src/enhancements.js', enhancements], ['src/firebase-sync.js', firebaseSync], ['enhancements.js', legacyEnhancements], ['firebase-sync.js', legacyFirebaseSync]];
const dynamicDataIds = new Set(data ? Object.values(data.days || {}).flat().map(card => card.id).filter(Boolean) : []);
const declaredIds = new Set([...dynamicDataIds, ...[indexHtml, adminHtml].flatMap(html => [...html.matchAll(/\bid=(['"])([^'"\s>]+)\1/gi)].map(match => match[2]))]);
for (const [sourceName, source] of localSources) {
    const literalIds = [...source.matchAll(/getElementById\(\s*(['"])([^'"\\]+)\1\s*\)/g)].map(match => match[2]);
    for (const id of literalIds) assert(declaredIds.has(id), `${sourceName}: getElementById(${id}) の対象IDが存在`);
}
assert(adminHtml.includes('getElementById(`admin-list-${t.id}`)') && adminHtml.includes('getElementById(`admin-count-${t.id}`)'), 'admin.html: 動的参加者IDはテンプレート文字列として参照');
const rawIcons = [...indexHtml.matchAll(/getElementById\('([^']*raw-icon-[^']+)'\)/g)].map(match => match[1]);
assert(rawIcons.length === 8, 'raw icon ID参照は期待する8件');
for (const id of rawIcons) assert(new RegExp(`<img\\b[^>]*\\bid="${id}"[^>]*\\bsrc="data:image/`, 'i').test(indexHtml), `raw icon ${id}: data URI画像が存在`);

assert(adminHtml.includes("import { listenToTripParticipants } from './src/firebase-sync.js';"), 'admin.html: src版Firebase同期モジュールを参照');
assert(adminHtml.includes("fetch('data/trips.json')") && adminHtml.includes('adminUnsubscribes.forEach'), 'admin.html: 旅程一覧と参加者監視解除を実装');
assert(indexHtml.includes('src/enhancements.css') && indexHtml.includes('src/enhancements.js') && indexHtml.includes('src/firebase-sync.js'), 'index.html: src版アセットだけを参照');
const indexAssetRefs = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
for (const legacyAsset of ['enhancements.js', 'firebase-sync.js', 'enhancements.css']) assert(!indexAssetRefs.includes(legacyAsset) && !indexAssetRefs.includes(`./${legacyAsset}`), `index.html: 旧ルート直下 ${legacyAsset} を参照しない`);
assert(indexHtml.includes('function switchTab(panelId, btnEl)'), 'index.html: switchTab実装');
assert(indexHtml.includes("'tab-checklist', 'tab-paypay'") && indexHtml.includes('if (daySwipeInitialized) return;'), 'index.html: スワイプにCHECKLIST/PAYPAYと二重初期化guard');
assert(indexHtml.includes('initPwaUpdateManager()') && indexHtml.includes("waiting.postMessage({ action: 'SKIP_WAITING' })"), 'index.html: PWA更新/SKIP_WAITING');
assert(indexHtml.includes("daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunset'") && indexHtml.includes('apiData.daily.weather_code?.[index] ?? apiData.daily.weathercode?.[index]') && indexHtml.includes("sunset: sunsetValue ? String(sunsetValue).slice(11, 16) : '—'"), 'index.html: weather codeとsunsetを処理');
assert(indexHtml.includes('if (activeWeatherKey === locKey) renderWeather(wData)') && indexHtml.includes('if (activeWeatherKey !== locKey) return;'), 'index.html: 天気レスポンス競合を防止');

assert(enhancements.includes('function expenseStorageKey(tripId, ledgerToken)') && enhancements.includes('expenses-${safeTripId}-${safeLedger}-v2'), 'enhancements.js: ルーム別expense cacheキー');
assert(enhancements.includes("card.dataset.expenseShortcut === 'true'") && enhancements.includes('window.initEnhancements = initEnhancements'), 'enhancements.js: 明示ショートカットと初期化公開');
assert(firebaseSync.includes('const currentRunId = ++syncRunId;') && firebaseSync.includes('currentRunId !== syncRunId'), 'firebase-sync.js: 二重初期化・競合guard');
assert(firebaseSync.includes('EXPENSE_KEY = `expenses-${tripId}-${ledgerToken}-v2`;') && firebaseSync.includes('signInAnonymously(auth)') && firebaseSync.includes('persistentMultipleTabManager'), 'firebase-sync.js: ルーム別cache・匿名認証・複数タブ永続化');
assert(firebaseSync.includes('window._initSyncEngine = initSyncEngine'), 'firebase-sync.js: 同期エンジン公開');

const shellMatch = sw.match(/const APP_SHELL\s*=\s*\[([\s\S]*?)\];/);
if (!shellMatch) fail('sw.js: APP_SHELL配列が見つかりません');
else {
    const shellPaths = [...shellMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
    assert(shellPaths.length > 0, 'sw.js: APP_SHELLが空でない');
    for (const shellPath of shellPaths) assert(fs.existsSync(shellPath === './' ? root : path.resolve(root, shellPath.replace(/^\.\//, ''))), `sw.js: APP_SHELL ${shellPath} が存在`);
}
assert(/const CACHE_NAME = 'shikoku-drive-pwa-v\d+'/.test(sw), 'sw.js: キャッシュ版を明示');
assert(sw.includes("event.data.action === 'SKIP_WAITING'") && sw.includes('if (requestUrl.origin !== self.location.origin) return;'), 'sw.js: 更新メッセージと外部origin除外');
assert(sw.includes('fetch(event.request)') && sw.includes('cache.put(event.request, copy)'), 'sw.js: Web assetはネットワーク優先');
assert(sw.includes("event.request.mode !== 'navigate'") && sw.includes("return caches.match('./index.html');") && !sw.includes("caches.match(event.request) || caches.match('./index.html')"), 'sw.js: indexフォールバックはnavigate限定でPromise真値バグなし');

if (data) {
    const shortcuts = Object.values(data.days || {}).flat().filter(card => card.expenseShortcut === true);
    assert(shortcuts.length === 9, `expenseShortcut期待9件 (${shortcuts.length})`);
    for (const card of shortcuts) assert(card.time !== 'OPTIONAL', `${card.title}: OPTIONALにexpenseShortcutを付与しない`);
    for (const [dayKey, ferryLegs] of Object.entries(data.ferryLegs || {})) {
        const cards = data.days?.[dayKey];
        assert(Array.isArray(cards) && Array.isArray(ferryLegs), `${dayKey}: ferryLegsの対象日・配列`);
        if (!Array.isArray(cards) || !Array.isArray(ferryLegs)) continue;
        const confirmed = cards.map((card, index) => ({ card, index })).filter(({ card }) => card.time !== 'OPTIONAL' && card.map !== false && Number.isFinite(Number(card.lat)) && Number.isFinite(Number(card.lon))).map(({ index }) => index);
        for (const [legIndex, leg] of ferryLegs.entries()) {
            const label = `${dayKey}.ferryLegs[${legIndex}]`;
            assert(leg && Number.isInteger(leg.from) && Number.isInteger(leg.to), `${label}: from/toは整数`);
            if (!leg || !Number.isInteger(leg.from) || !Number.isInteger(leg.to)) continue;
            assert(leg.from >= 0 && leg.to >= 0 && leg.from < cards.length && leg.to < cards.length, `${label}: from/toはカード範囲内`);
            assert(leg.to === leg.from + 1, `${label}: 元カードの隣接stopを結ぶ`);
            assert(confirmed.indexOf(leg.to) === confirmed.indexOf(leg.from) + 1, `${label}: 確定stopの隣接区間を結ぶ`);
        }
    }
}
console.log(`PASS ${passes.length}`);
for (const message of passes) console.log(`[PASS] ${message}`);
if (failures.length) {
    console.error(`FAIL ${failures.length}`);
    for (const message of failures) console.error(`[FAIL] ${message}`);
    process.exitCode = 1;
} else {
    console.log('ALL CHECKS PASSED');
}
