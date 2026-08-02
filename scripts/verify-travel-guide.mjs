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
        let previousEndMinute = -1;
        for (const [index, card] of (cards || []).entries()) {
            cardCount += 1;
            const label = `${dayKey}[${index}] ${card.title || '(無題)'}`;
            assert(typeof card.time === 'string' && card.time.trim(), `${label}: 時刻`);
            assert(typeof card.title === 'string' && card.title.trim(), `${label}: タイトル`);
            assert(typeof card.badge === 'string' && card.badge.trim(), `${label}: バッジ`);
            assert(typeof card.desc === 'string' && card.desc.trim(), `${label}: 説明`);
            if (card.time !== 'OPTIONAL') {
                const timeMatch = card.time.match(/^(\d{2}):(\d{2}) - (\d{2}):(\d{2})$/);
                assert(Boolean(timeMatch), `${label}: 確定時刻形式`);
                if (timeMatch) {
                    const startMinute = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
                    const endMinute = Number(timeMatch[3]) * 60 + Number(timeMatch[4]);
                    assert(endMinute > startMinute, `${label}: 終了は開始より後`);
                    assert(startMinute >= previousEndMinute, `${label}: 前予定と重複しない`);
                    previousEndMinute = endMinute;
                }
            }
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
assert(indexHtml.includes('escapeHtml(buildTripHref(t.id))') && indexHtml.includes('new URLSearchParams({ trip: String(tripId || \'\') })'), 'ポータルIDと招待パラメータを安全に構築');
assert(indexHtml.includes('unavailable: true'), '対象日外天気の明示');
assert(indexHtml.includes('daySwipeInitialized'), 'スワイプ重複登録防止');

const enhancements = read('src/enhancements.js');
const enhancementsCss = read('src/enhancements.css');
assert(enhancements.includes('link.textContent.trim()'), 'NOWモードは明示ROUTEを優先');
assert(enhancements.includes("card.dataset.expenseShortcut === 'true'"), '割り勘対象をカード明示方式に限定');
assert(data.days.day1.some(card => card.title.includes('そうめん作兵衛') && card.expenseShortcut === true), '割り勘対象カードの明示');
assert(Object.values(data.days).flat().some(card => card.fixed === true) && Object.values(data.days).flat().some(card => card.rigid === true), '既存旅程: 固定時刻・短縮不可フラグを明示');
assert(!data.days.day1.some(card => card.title.includes('うどんバカ一代') && card.expenseShortcut === true), 'Optional食事に割り勘ボタンを付けない');

const firebaseSync = read('src/firebase-sync.js');
assert(firebaseSync.includes('window._initSyncEngine = initSyncEngine'), '同期エンジン公開');
const rules = read('src/firestore.rules');
assert(rules.includes('request.auth != null'), 'Firestore認証必須ルール');

const adminHtml = read('admin.html');
const adminJs = read('src/admin.js');
const adminCss = read('src/admin.css');
const sw = read('sw.js');
const legacyEnhancements = read('enhancements.js');
const legacyFirebaseSync = read('firebase-sync.js');
const localSources = [['index.html', indexHtml], ['admin.html', adminHtml], ['src/admin.js', adminJs], ['src/enhancements.js', enhancements], ['src/firebase-sync.js', firebaseSync], ['enhancements.js', legacyEnhancements], ['firebase-sync.js', legacyFirebaseSync]];
const dynamicDataIds = new Set(data ? Object.values(data.days || {}).flat().map(card => card.id).filter(Boolean) : []);
const declaredIds = new Set([...dynamicDataIds, ...[indexHtml, adminHtml].flatMap(html => [...html.matchAll(/\bid=(['"])([^'"\s>]+)\1/gi)].map(match => match[2]))]);
for (const [sourceName, source] of localSources) {
    const literalIds = [...source.matchAll(/getElementById\(\s*(['"])([^'"\\]+)\1\s*\)/g)].map(match => match[2]);
    for (const id of literalIds) assert(declaredIds.has(id), `${sourceName}: getElementById(${id}) の対象IDが存在`);
}
assert(adminHtml.includes('src/admin.css') && adminHtml.includes('src/admin.js'), 'admin.html: 管理画面専用アセットを参照');
assert(adminJs.includes('GoogleAuthProvider') && adminJs.includes("doc(db, 'admins', user.uid)"), 'admin.js: Googleログインと管理者権限ゲート');
assert(adminJs.includes("collection(db, 'adminTrips')") && adminJs.includes("doc(db, 'publishedTrips', tripId)"), 'admin.js: 下書きと公開旅程を分離');
assert(adminJs.includes("collection(db, 'adminDistributions')") && adminJs.includes("doc(db, 'rooms', roomId)"), 'admin.js: 配布先と同期ルームを一括作成');
assert(adminJs.includes("collection(db, 'rooms', distribution.roomId || distribution.id, 'participants')"), 'admin.js: 配布ルーム別に参加者を監視');
assert(!adminJs.includes('.innerHTML'), 'admin.js: 管理データはDOM APIで安全に描画');
assert(adminCss.includes('.admin-layout') && adminCss.includes('@media (max-width: 620px)'), 'admin.css: デスクトップ・モバイル管理画面レイアウト');
assert(adminCss.includes('[hidden] { display: none !important; }') && enhancementsCss.includes('[hidden] { display: none !important; }'), 'hidden属性はボタン・flex指定より常に優先');
assert(adminJs.includes('Admin verification timed out') && adminJs.includes('Promise.race(['), 'admin.js: 管理者確認を10秒でエラー表示へ切替');
assert(adminHtml.includes('id="card-fixed"') && adminHtml.includes('id="card-rigid"') && adminJs.includes("fixed: $('card-fixed').checked") && adminJs.includes("rigid: $('card-rigid').checked"), 'admin: 固定時刻・短縮不可をカードへ設定');
const rawIcons = [...indexHtml.matchAll(/getElementById\('([^']*raw-icon-[^']+)'\)/g)].map(match => match[1]);
assert(rawIcons.length === 8, 'raw icon ID参照は期待する8件');
for (const id of rawIcons) assert(new RegExp(`<img\\b[^>]*\\bid="${id}"[^>]*\\bsrc="data:image/`, 'i').test(indexHtml), `raw icon ${id}: data URI画像が存在`);

assert(indexHtml.includes('documents/publishedTrips/${encodeURIComponent(tripId)}') && indexHtml.includes('return staticResponse.json()'), 'index.html: 公開旅程を優先し静的JSONへフォールバック');
assert(indexHtml.includes('PUBLISHED_TRIP_CACHE_PREFIX') && indexHtml.includes('if (cloudUnavailable)') && indexHtml.includes('cachedTrip'), 'index.html: 最後に取得した公開旅程をオフライン利用');
assert(indexHtml.includes('TRIP_ACCESS_KEY') && indexHtml.includes('rememberTripAccessFromUrl(tripIdParam)') && indexHtml.includes('buildTripHref(t.id)'), 'index.html: しおり棚を往復しても招待ルームを保持');
assert(indexHtml.includes("window.addEventListener('popstate', initAppRouter)") && indexHtml.includes('window._stopSyncEngine?.()'), 'index.html: 戻る操作と棚表示で旅行ランタイムを停止');
assert(indexHtml.includes('const currentLoadId = ++tripLoadRunId') && indexHtml.includes('currentLoadId !== tripLoadRunId'), 'index.html: 棚へ戻った後に古い旅程読込が画面を再開しない');
assert(!indexHtml.includes('moveFatherBeachCard()') && !indexHtml.includes('moveDay1HotelCard()') && !indexHtml.includes('moveTowelMuseumBeforeLunch()'), 'index.html: 管理者のカード順を参加者側で上書きしない');
assert(indexHtml.includes('window.currentTripData = data'), 'index.html: 描画済み公開データを拡張機能へ共有');
assert(indexHtml.includes('data-fixed="${card.fixed === true') && indexHtml.includes('data-rigid="${card.rigid === true'), 'index.html: 予定制約を参加者カードへ出力');
assert(firebaseSync.includes("doc(roomRef, 'participants', deviceId)") && firebaseSync.includes("collection(roomRef, 'participants')"), 'firebase-sync.js: 参加者プレゼンスを招待ルーム単位に分離');
assert(firebaseSync.includes("return null;") && firebaseSync.includes("setSyncUi('local', '閲覧モード'") && !firebaseSync.includes('url.searchParams.set(\'ledger\', roomId)'), 'firebase-sync.js: 招待なしではルームを自動生成せず閲覧モード');
assert(firebaseSync.includes('window._stopSyncEngine = stopSyncEngine'), 'firebase-sync.js: 棚へ戻ると同期監視を停止');
assert(firebaseSync.includes('syncContext.ledgerToken === actionLedgerToken') && firebaseSync.includes('action.ledgerToken !== ledgerToken'), 'firebase-sync.js: 保留支出を別の招待ルームへ流さない');
assert(firebaseSync.includes('function setIdentityControlLocked(locked)') && firebaseSync.includes('deviceOwner.disabled = locked') && firebaseSync.includes('setIdentityControlLocked(true)') && firebaseSync.includes('setIdentityControlLocked(false)'), 'firebase-sync.js: 共有ルームの支払者は参加順から自動設定し手動入替を防ぐ');
assert(firebaseSync.includes('招待リンクが無効です') && !firebaseSync.includes('Firestoreルールが未設定です'), 'firebase-sync.js: 参加者向けの招待エラー表示');
+assert(indexHtml.includes('id="share-room-actions"') && indexHtml.includes('id="sync-note"') && indexHtml.includes('aria-live="polite">MEMBERS:'), 'index.html: 同期状態を支援技術へ通知し正常時要素を識別');
+assert(firebaseSync.includes("actions.hidden = mode !== 'live'") && firebaseSync.includes("note.hidden = mode !== 'live'"), 'firebase-sync.js: ROOM・招待ボタン・正常説明はLIVE時だけ表示');
+assert(firebaseSync.includes("'MEMBERS: 同期なし'") && firebaseSync.includes("'MEMBERS: この端末のみ'") && firebaseSync.includes("'MEMBERS: 接続中…'"), 'firebase-sync.js: MEMBERSを接続状態に応じて更新');
+assert(firebaseSync.includes('syncContext.roomReady') && firebaseSync.includes('syncContext.participantsReady') && firebaseSync.includes('renderLiveSyncState()'), 'firebase-sync.js: ルームと参加者一覧の両方が成功してからLIVE表示');
+assert(firebaseSync.includes("console.error('Participant sync failed'") && firebaseSync.includes("'参加者情報を同期できません'"), 'firebase-sync.js: 参加者監視失敗をLoadingのままにしない');
assert(rules.includes('function isAdmin()') && rules.includes('match /admins/{uid}'), 'Firestore: 管理者ドキュメント認可');
assert(rules.includes('.data.active == true') && adminJs.includes("snapshot.data()?.active === true"), '管理者権限はactive: trueのアカウントだけ');
assert(rules.includes('match /adminTrips/{tripId}') && rules.includes('match /publishedTrips/{tripId}'), 'Firestore: 下書きと公開旅程の権限分離');
assert(rules.includes('match /adminDistributions/{distributionId}') && rules.includes('match /participants/{uid}'), 'Firestore: 配布先管理とルーム別参加者');
assert(rules.includes('allow create: if isAdmin();') && !rules.includes('validLegacyRoomCreate'), 'Firestore: 配布ルーム作成は管理者だけ');
assert(indexHtml.includes('src/enhancements.css') && indexHtml.includes('src/enhancements.js') && indexHtml.includes('src/firebase-sync.js'), 'index.html: src版アセットだけを参照');
const indexAssetRefs = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
for (const legacyAsset of ['enhancements.js', 'firebase-sync.js', 'enhancements.css']) assert(!indexAssetRefs.includes(legacyAsset) && !indexAssetRefs.includes(`./${legacyAsset}`), `index.html: 旧ルート直下 ${legacyAsset} を参照しない`);
assert(indexHtml.includes('function switchTab(panelId, btnEl)'), 'index.html: switchTab実装');
assert(indexHtml.includes('leaflet@1.9.4/dist/leaflet.css') && indexHtml.includes('leaflet@1.9.4/dist/leaflet.js') && indexHtml.includes('sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='), 'index.html: Leaflet CSS/JSとSRIを読込');
assert(indexHtml.includes("'tab-checklist', 'tab-paypay'") && indexHtml.includes('if (daySwipeInitialized) return;'), 'index.html: スワイプにCHECKLIST/PAYPAYと二重初期化guard');
assert(indexHtml.includes('initPwaUpdateManager()') && indexHtml.includes("waiting.postMessage({ action: 'SKIP_WAITING' })"), 'index.html: PWA更新/SKIP_WAITING');
assert(indexHtml.includes("daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunset'") && indexHtml.includes('apiData.daily.weather_code?.[index] ?? apiData.daily.weathercode?.[index]') && indexHtml.includes("sunset: sunsetValue ? String(sunsetValue).slice(11, 16) : '—'"), 'index.html: weather codeとsunsetを処理');
assert(indexHtml.includes('if (activeWeatherKey === locKey) renderWeather(wData)') && indexHtml.includes('if (activeWeatherKey !== locKey) return;'), 'index.html: 天気レスポンス競合を防止');

assert(enhancements.includes('function expenseStorageKey(tripId, ledgerToken)') && enhancements.includes('expenses-${safeTripId}-${safeLedger}-v2'), 'enhancements.js: ルーム別expense cacheキー');
assert(enhancements.includes("card.dataset.expenseShortcut === 'true'") && enhancements.includes('window.initEnhancements = initEnhancements'), 'enhancements.js: 明示ショートカットと初期化公開');
assert(enhancements.includes('function escapeMarkup(value)') && enhancements.includes('escapeMarkup(item.title)') && enhancements.includes('escapeMarkup(bestDetour.text)'), 'enhancements.js: アドバイザー文字列をHTMLエスケープ');
assert(enhancements.includes('const tripData = window.currentTripData || {}') && !enhancements.includes('fetch(`data/${window.currentTripId}.json`)'), 'enhancements.js: 公開済み描画データを唯一の情報源にする');
assert(enhancements.includes("badge.textContent = 'DONE'") && enhancements.includes('segmentShift = 0'), 'enhancements.js: 過去予定を変更せず固定予定後に遅延をリセット');
assert(enhancements.includes('referenceMinute <= anchorMinute') && enhancements.includes('renderOptionalAdvice(panelId, activeProgressMinutes, anchorMinute)'), 'enhancements.js: 通過済みOptionalを再提案しない');
assert(enhancements.includes("departureEl.textContent = '次の予定へ出発'") && enhancements.includes('departureTarget'), 'enhancements.js: DEPARTUREは次の予定への出発を記録');
assert(enhancements.includes("card.dataset.fixed === 'true'") && enhancements.includes("card.dataset.rigid === 'true'"), 'enhancements.js: 管理者指定の予定制約を優先');
assert(!enhancements.includes("window.currentTripDate || '2026-08-30'"), 'enhancements.js: 別旅行でも四国日付へ固定しない');
assert(enhancements.includes('共有台帳から削除しますか？'), 'enhancements.js: 支出削除前に確認');
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
assert(sw.includes("const CACHE_NAME = 'shikoku-drive-pwa-v39';"), 'sw.js: 参加者仕様修正版キャッシュv39');
assert(sw.includes("event.data.action === 'SKIP_WAITING'") && sw.includes('if (requestUrl.origin !== self.location.origin) return;'), 'sw.js: 更新メッセージと外部origin除外');
assert(sw.includes('fetch(event.request)') && sw.includes('cache.put(cacheKey, copy)'), 'sw.js: Web assetはネットワーク優先');
assert(sw.includes("event.request.mode !== 'navigate'") && sw.includes("return caches.match('./index.html');") && !sw.includes("caches.match(event.request) || caches.match('./index.html')"), 'sw.js: indexフォールバックはnavigate限定でPromise真値バグなし');
assert(sw.includes("url.search = '';") && sw.includes("url.hash = '';") && sw.includes('const cacheKey = cacheKeyFor(event.request);') && !sw.includes('cache.put(event.request, copy)'), 'sw.js: 招待トークンをキャッシュキーへ保存しない');

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
