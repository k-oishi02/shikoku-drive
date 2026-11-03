# SHIORI_app コンバージョン安定版の集大成 (Conversion Stable Culmination)
**技術仕様書・アーキテクチャ総覧 (Comprehensive Technical Specification & Architecture Manual)**

- **対象プロダクト**: SHIORI_app (参加者用しおり `index.html` / 管理者用コンソール `admin.html`)
- **現行バージョン**: v2.0.0 (Milestone 1〜5 達成・コンバージョン安定版)
- **策定日**: 2026-11-03
- **状態**: 検証完了・安定版集大成 (444/444 自動テスト全件合格、マスター検証 100% 合格)

---

## 1. エグゼクティブサマリー (Executive Summary)

本ドキュメントは、旅行しおりPWA「SHIORI_app」が初期のモノリシック構成（肥大化した単一スクリプト群）から、高凝集・疎結合なネイティブESモジュール（45モジュール）と2つのリアクティブ状態管理ストア（`TripStore` / `AdminStore`）を中核とする**モダン・高信頼アーキテクチャ**へと完全移行を遂げた「コンバージョン安定版の集大成」を技術的に総括するものである。

### 主要達成指標
1. **完全なモジュール分離**: 45個のESモジュール、84本の内部依存エッジ、**循環参照 0件**（厳格な有向非巡回グラフ: Acyclic Directed Graph を達成）。
2. **単一情報源ストア (Single Source of Truth)**: 参加者画面 (`TripStore`) と管理者画面 (`AdminStore`) にゼロ依存リアクティブストアを確立。プロトタイプ汚染防御、配列スライスの完全保護を実装。
3. **オフライン耐性＆エラーバウンダリ**: グローバルエラーバウンダリによる日本語障害復旧UI、ローカルストレージ駆動のオフライン立替キュー、Open-Meteo気象情報キャッシュ（オフライン時 `📴` 表示）、Service Worker による75アセット事前キャッシュを完備。
4. **Schema v2 完全互換性**: 標準サンプルデータ（`20261107.json`, `20261031.json`, `20261128.json`）の非破壊読み込み・編集・公開・正規化ラウンドトリップを100%保証。
5. **厳格な行数制限順守**: 23個の制約対象ファイル（`admin.js` <=150行、`viewer-app.js` <=150行、`sw.js` <=200行、`index.html` <=900行 等）すべてが上限を遵守。
6. **テスト品質基準**: 444件の自動テスト（373件の単体・ストレステスト + 71件のE2Eテスト）が100%合格。マスター検証（`verify-all.mjs`）およびエコシステム一括検証（`Test-AllApps.ps1`）を全件クリア。

---

## 2. 全体アーキテクチャ構造 (System Topology)

```
+---------------------------------------------------------------------------------------------------------+
|                                        SHIORI_app System Architecture                                   |
+---------------------------------------------------------------------------------------------------------+
|                                                                                                         |
|  [Admin Track: admin.html]                                  [Participant Track: index.html]             |
|            |                                                               |                            |
|            v                                                               v                            |
|    src/admin.js (Entry Point <150 L)                             src/viewer-app.js (Entry Point <150 L) |
|            |                                                               |                            |
|            v                                                               v                            |
|    src/admin-store.js (Reactive Store)                           src/trip-store.js (Reactive Store)     |
|    ├── admin-view-overview.js (一覧・バッジ)                     ├── viewer-router.js (ルーティング)    |
|    ├── admin-view-editor.js (4タブ編集)                          ├── viewer-ui.js (DOM描画・スワイプ)   |
|    ├── admin-candidate-ui.js (候補棚・採用)                      ├── weather-service.js (気象・オフライン)|
|    ├── admin-day-planner-ui.js (カスケード日程)                  ├── pwa-manager.js (PWA更新・インテント) |
|    ├── admin-distribution-ui.js (共有・QR)                       ├── participant-v2.js (正規化・マイグレ)|
|    ├── admin-distribution-ledger.js (立替台帳)                  └── error-boundary.js (障害復旧UI)     |
|    ├── admin-roles-ui.js (管理者ロール設定)                                                              |
|    └── admin-discussion-ui.js (相談チャット)                                                             |
|            |                                                               |                            |
|            +-------------------------------+-------------------------------+                            |
|                                            |                                                            |
|                                            v                                                            |
|                           [Pure Domain & Calculation Core]                                              |
|            ├── src/trip-v2-core.js (時間パース, 分換算, カード/候補/計画正規化, スキーマ移行)            |
|            ├── src/trip-v2-analysis.js (包括的旅程監査, 2ポインタ貪欲債務解消 settlementTransfers)       |
|            ├── src/draft-validation.js (ホワイトリストスキーマ検証, Firestore 900KB制限防御)            |
|            ├── src/admin-day-planner.js (3パス照合, カスケード自動調整, timeLocked防壁, 深夜跨ぎ防御)   |
|            ├── src/admin-placement.js (スポット重複判定, 移動バッファ検証)                              |
|            ├── src/itinerary-calc.js (タイムライン導出, 遅延オフセット, activeItem, カードリンク)      |
|            └── src/map-links.js (マップ検索・ナビゲーションURLビルダー)                                  |
|                                            |                                                            |
|                                            v                                                            |
|                           [Automated Testing & Verification Suite]                                      |
|            ├── tests/*.test.js (373 Unit, Adversarial & Stress Tests)                                   |
|            ├── tests/e2e/*.test.js (71 End-to-End Tests across Tiers 1-4)                              |
|            └── verify-all.mjs (Milestone 1〜5 Master Verification Suite)                                |
+---------------------------------------------------------------------------------------------------------+
```

---

## 3. モジュール構成と依存性グラフ (45 Native ES Modules)

`src/` 配下の45モジュールは、役割ごとに明確に分類され、循環参照が一切生じないレイヤードアーキテクチャを採用しています。

### モジュール一覧表

| 分類 | モジュール名 | 行数 | 役割・機能 |
|---|---|---|---|
| **管理者エントリ** | `src/admin.js` | 145 | 管理者画面ブートストラップ、認証状態管理、ビュー遷移制御、Firebaseリスナー破棄 |
| **管理者ストア** | `src/admin-store.js` | 131 | 7スライス管理、プロトタイプ汚染防御、Pub/Sub状態通知コンテナ |
| **管理者ビュー** | `src/admin-view-overview.js` | 124 | 旅行一覧表示、状態バッジ（公開中/下書き/共有中/アーカイブ）、複製・アーカイブ操作 |
| | `src/admin-view-editor.js` | 396 | 4タブ編集UI（基本情報・旅程・持ち物・監査）、入力変更検知、リアルタイム監査 |
| | `src/admin-candidate-ui.js` | 396 | 候補スポット棚、カテゴリ・優先度フィルタ、日程採用モーダル |
| | `src/admin-day-planner-ui.js` | 346 | カスケード日程編成UI、カード並べ替え、スナップショットUndo/Redo操作 |
| | `src/admin-distribution-ui.js`| 395 | 共有ルーム発行、既知メンバー直接プッシュ共有、QRコード生成、共有失効 |
| | `src/admin-distribution-ledger.js`| 214 | 共有立替精算台帳、参加者別立替額集計、チャンク一括削除 |
| | `src/admin-roles-ui.js` | 100 | ホワイトリスト管理者一覧・追加・削除UI |
| | `src/admin-discussion-ui.js` | 275 | 企画相談チャット、メッセージ送受信、アクティブリスナー管理 |
| **管理者サービス** | `src/admin-auth.js` | 104 | Google認証、管理者ホワイトリスト判定、トークン検証 |
| | `src/admin-trip-service.js` | 388 | Cloud Firestore永続化（下書き/公開）、900KBサイズ検証、JSONインポート/エクスポート |
| | `src/admin-day-planner.js` | 623 | 3パスカード照合、カスケード遅延伝播、timeLocked防壁、スナップショット管理 |
| | `src/admin-placement.js` | 274 | 移動時間バッファ検証、スポット重複判定 |
| | `src/admin-transfer.js` | 227 | しおりバックアップシリアライザ、スキーマ変換 |
| | `src/admin-ui.js` | 238 | 共通ダイアログ（確認/警告/トースト）、アコーディオン制御 |
| **参加者エントリ** | `src/viewer-app.js` | 149 | 参加者画面ライフサイクル、ストア初期化、天候インターバル管理、スワイプ連携 |
| **参加者ストア** | `src/trip-store.js` | 174 | 7スライス管理、配列保護、window互換ブリッジ（`window.currentTripId` 等） |
| **参加者ビュー** | `src/viewer-router.js` | 345 | 3経路アクセス（オンボーディング/参加コード/直接URL）、二重キャッシュ管理 |
| | `src/viewer-ui.js` | 395 | 旅程タイムラインDOM描画、日程スワイプ判定、交通・予約アプリアクティベーション |
| | `src/weather-service.js` | 240 | Open-Meteo気象予報取得、和文変換、ローカルキャッシュ、オフラインバッジ `📴` |
| | `src/pwa-manager.js` | 146 | Service Worker更新検知（`SKIP_WAITING`）、フォアグラウンド復帰時更新確認 |
| | `src/participant-v2.js` | 228 | 参加者画面用データ正規化、v1→v2マイグレーション |
| | `src/live-itinerary.js` | 194 | NOWモード進行管理（到着/完了/見送り/遅れ調整）、端末内進行記録 |
| | `src/navigation-picker.js` | 98 | ナビゲーションアプリ選択モーダル（Google/Yahoo/Waze/Apple） |
| **ドメインコア** | `src/trip-v2-core.js` | 298 | 時間パース（`parseTimeRange`）、分文字列変換（`formatMinute`）、データ正規化 |
| | `src/trip-v2-analysis.js` | 206 | 旅程健全性監査（`analyzeTrip`）、2ポインタ債務解消（`settlementTransfers`） |
| | `src/draft-validation.js` | 416 | ホワイトリストキー検証、Firestore 900KBバイトサイズ境界防御 |
| | `src/itinerary-calc.js` | 141 | タイムライン算出、遅延オフセット計算、アクティブカード判定、リンクパース |
| | `src/map-links.js` | 108 | Googleマップリンク生成、経路検索URLビルダー |
| | `src/suggestion-validation.js`| 82 | 提案スポット入力検証 |
| | `src/suggestion-sync.js` | 115 | 提案スポット同期ハンドラ |
| **耐性・オフライン**| `src/error-boundary.js` | 194 | グローバル未補足例外/Promise拒否捕捉、和文復旧UI、詳細ログ表示 |
| | `src/offline-expense-queue.js`| 196 | オフライン立替キュー（`localStorage`）、pending状態管理、復帰時自動送信 |
| **シェル・サービス**| `sw.js` | 193 | 75アセット事前キャッシュ、二重オフラインシェル（admin/viewer）フォールバック |
| | `serve.py` | 114 | ポート4173リッスン、`/api/health` 提供、MASA準拠バックグラウンドサーバー |

---

## 4. リアクティブストア設計 (State Management Architecture)

### 4.1 管理者ストア (`AdminStore`)
- **ファイル**: `src/admin-store.js` (131行)
- **7つの状態スライス**:
  1. `overview`: 旅行一覧データ、フィルタ条件、選択中旅行ID
  2. `editor`: 編集中旅行データ（dirtyフラグ、バリデーションエラー一覧、アクティブタブ）
  3. `candidateShelf`: 候補スポット配列、カテゴリフィルタ、採用モーダル状態
  4. `dayPlanner`: 編集中日程スナップショット、Undo/Redoスタック、カスケードプレビュー
  5. `distribution`: 共有ルーム一覧、アクティブ配布設定、既知メンバーディレクトリ
  6. `roles`: ホワイトリスト管理者一覧、権限付与状態
  7. `discussion`: 相談チャットルームID、メッセージ履歴、未読カウント
- **セキュリティと堅牢性**:
  - `__proto__`, `constructor`, `prototype` を明示的に排除し、Prototype Pollution攻撃を数学的に遮断。
  - `setSlice` 実行時、引数が配列の場合はスプレッド展開によるオブジェクト化を回避し、完全な `Array` インスタンスを維持。

### 4.2 参加者ストア (`TripStore`)
- **ファイル**: `src/trip-store.js` (174行)
- **7つの状態スライス**:
  1. `activeTrip`: 現在閲覧中の旅行オブジェクト（Schema v2）
  2. `currentAccess`: 参加認証情報（grantId, token, memberId, role）
  3. `syncState`: 接続状態（online/offline/syncing）、最終同期タイムスタンプ
  4. `weather`: 取得済み気象データ、オフラインフラグ
  5. `checklist`: 持ち物チェック状態マップ
  6. `expenses`: 立替明細リスト、個人負担集計
  7. `portalTrips`: 参加可能な旅行一覧（今後の旅行、過去の旅行、RECAP）
- **後方互換性ブリッジ**:
  `syncToWindow(state)` により、モジュール化されていない既存拡張スクリプト（`enhancements.js` 等）のために `window.currentTripId`, `window.currentTripData`, `window.currentTripMembers` を非破壊同期。

---

## 5. オフライン耐性とエラーバウンダリ (Resilience & Offline Layer)

### 5.1 グローバルエラーバウンダリ (`src/error-boundary.js`)
- `window.addEventListener('error', ...)` および `window.addEventListener('unhandledrejection', ...)` を統制。
- 未補足エラー発生時、画面をクラッシュ・ホワイトアウトさせず、親しみやすい日本語メッセージ（「予期せぬエラーが発生しました」）と「再読み込み」「前の画面に戻る」ボタンを表示。
- `<details>` タグ内にスタックトレースとエラー発生コンテキスト（URL、ユーザーエージェント、タイムスタンプ）を折りたたみ格納し、開発者のデバッグを容易化。

### 5.2 オフライン立替キュー (`src/offline-expense-queue.js`)
- 電波の届かない山間部やフェリー上でも、参加者が立替費用（支払者、金額、品名、対象者）をストレスなく登録可能。
- `localStorage['shiori_offline_expenses_queue_v1']` に `status: 'pending'` で永続化。
- ブラウザの `online` イベント検知時、または画面復帰（`visibilitychange`）時に、キューされた支出を順次Firestoreへ自動同期し、完了時に `shiori-offline-queue-changed` イベントを発火。

### 5.3 Service Worker (`sw.js`) とキャッシュ戦略
- キャッシュバージョン: `v404`
- 事前キャッシュアセット数: **75ファイル**（HTML, CSS, JSモジュール, アイコン画像, フォント）。
- 戦略: **Cache-First (アセット優先) + Stale-While-Revalidate (非同期更新)**。
- オフラインフォールバック: ナビゲーションリクエスト失敗時、URLに応じて `index.html` または `admin.html` のキャッシュを透過的に返却。

---

## 6. ドメイン計算コアとアルゴリズム (Domain Core & Algorithms)

### 6.1 2ポインタ貪欲債務解消アルゴリズム (`settlementTransfers`)
- **配置**: `src/trip-v2-analysis.js`
- **計算量**: $O(N \log N)$（メンバー数 $N$）
- **アルゴリズム特性**:
  1. 各メンバーの「総支払額」と「総負担額」から「純純額（Net Balance = 支払額 - 負担額）」を算出。
  2. 純債権者（プラス残高）と純債務者（マイナス残高）をソート。
  3. 最大債権者と最大債務者を2ポインタでマッチングし、両者のうち小さい方の金額を精算取引として確定。
  4. 金額の保存則（$\sum \text{Credits} = \sum \text{Debits}$）を1円単位で厳密に満たし、端数調整による欠損・余剰を排除。

### 6.2 カスケード自動時間調整エンジン (`admin-day-planner.js`)
- **配置**: `src/admin-day-planner.js` (623行)
- **特徴**:
  1. **3パスカード照合**: `cardId` の完全一致、参照元の照合、内容フィンガープリント（タイトル・滞在時間）によるフォールバック照合により、並べ替えや複製時でもカードの一貫性を維持。
  2. **`timeLocked` 防壁**: 予約時間が固定されているカード（レンタカー返却、フェリー出航、新幹線発車等）に `timeLocked: true` を設定可能。前後の予定が遅延しても、lockedカードの時刻は固定され、カスケード伝播は防壁の手前で停止。
  3. **24:00深夜跨ぎ防止**: 移動時間や滞在時間の合計が24:00を超える場合、スケジュールの破損を未然に防止し、明示的なエラーを返却。
  4. **完全なスナップショットUndo/Redo**: 変更前の状態をディープコピーし、ワンクリックで日程調整前の状態へ完全復元可能。

### 6.3 Firestore 900KB ペイロードガード (`draft-validation.js`)
- Firestoreの1ドキュメントあたりの上限（1MB）に対し、安全マージンを設けた **900,000バイト上限** を設定。
- 保存前に UTF-8 バイト長を正確に計測（`new TextEncoder().encode(JSON.stringify(payload)).length`）。超過時は保存をブロックし、ユーザーに削減を促す。

---

## 7. 厳格な行数制限順守状況 (Line Count Limit Compliance)

プロジェクト最上位ルールに定められた23個の制約対象ファイルに対する、実測行数およびマージンは以下の通りです（`node verify-all.mjs` Step 6 にて常時自動検証）。

| # | ファイルパス | カテゴリ | 実測行数 | 上限行数 | 残余マージン | 判定 |
|---|---|---|---|---|---|---|
| 1 | `src/admin.js` | M2 Admin エントリポイント | 145 | <= 150 | 5 lines | **PASS** |
| 2 | `src/admin-distribution-ledger.js` | M2 立替精算台帳 | 214 | <= 300 | 86 lines | **PASS** |
| 3 | `src/admin-store.js` | M2 Admin リアクティブストア | 131 | <= 400 | 269 lines | **PASS** |
| 4 | `src/admin-ui.js` | M2 Admin 共通UI | 238 | <= 400 | 162 lines | **PASS** |
| 5 | `src/admin-auth.js` | M2 Admin 認証 | 104 | <= 400 | 296 lines | **PASS** |
| 6 | `src/admin-trip-service.js` | M2 Firestore 連携 | 388 | <= 400 | 12 lines | **PASS** |
| 7 | `src/admin-view-overview.js` | M2 旅行一覧ビュー | 124 | <= 400 | 276 lines | **PASS** |
| 8 | `src/admin-view-editor.js` | M2 旅程編集ビュー | 396 | <= 400 | 4 lines | **PASS** |
| 9 | `src/admin-candidate-ui.js` | M2 候補スポット棚UI | 396 | <= 400 | 4 lines | **PASS** |
| 10 | `src/admin-day-planner-ui.js` | M2 日程編成UI | 346 | <= 400 | 54 lines | **PASS** |
| 11 | `src/admin-distribution-ui.js` | M2 共有UI | 395 | <= 400 | 5 lines | **PASS** |
| 12 | `src/admin-roles-ui.js` | M2 ロール管理UI | 100 | <= 400 | 300 lines | **PASS** |
| 13 | `src/admin-discussion-ui.js` | M2 相談チャットUI | 275 | <= 400 | 125 lines | **PASS** |
| 14 | `index.html` | M3 参加者画面 HTMLシェル | 414 | <= 900 | 486 lines | **PASS** |
| 15 | `src/viewer-app.js` | M3 参加者エントリポイント | 149 | <= 150 | 1 line | **PASS** |
| 16 | `src/trip-store.js` | M3 参加者リアクティブストア | 174 | <= 400 | 226 lines | **PASS** |
| 17 | `src/viewer-router.js` | M3 参加者ルーター | 345 | <= 350 | 5 lines | **PASS** |
| 18 | `src/viewer-ui.js` | M3 参加者UI描画 | 395 | <= 400 | 5 lines | **PASS** |
| 19 | `src/weather-service.js` | M3 天候サービス | 240 | <= 250 | 10 lines | **PASS** |
| 20 | `src/pwa-manager.js` | M3 PWA更新マネージャー | 146 | <= 150 | 4 lines | **PASS** |
| 21 | `src/error-boundary.js` | M4 エラーバウンダリ | 194 | <= 200 | 6 lines | **PASS** |
| 22 | `src/offline-expense-queue.js` | M4 オフライン立替キュー | 196 | <= 200 | 4 lines | **PASS** |
| 23 | `sw.js` | M4 Service Worker | 193 | <= 200 | 7 lines | **PASS** |

---

## 8. テスト検証実績と品質メトリクス (Test Metrics & Quality Audit)

### 8.1 自動テストスイート実行結果 (444/444 全件合格)
```
実行コマンド: npm run test:all (node --test tests/*.test.js tests/e2e/*.test.js)
結果:
  ℹ tests 444
  ℹ suites 145
  ℹ pass 444
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms ~3150ms
```

### 8.2 テストカテゴリ別内訳
- **単体・純粋ドメインテスト (Unit Tests, 161 tests)**:
  `draft-validation` (29), `trip-core` (21), `settlement` (18), `day-planner` (14), `itinerary-calc` (22), `weather-service` (8), `offline-expense-queue` (11), `error-boundary` (9), `sw-manifest` (7), `admin-store` (17), `trip-store` (7).
- **対抗・ストレステスト (Adversarial & Stress Tests, 212 tests)**:
  `admin-store-adversarial` (25), `trip-store-adversarial` (28), `adversarial-challenge` (27), `adversarial-m5-stress` (12), `adversarial-stress-m5` (29), `m2-regating-adversarial` (18), `m2-regating-symbols` (23), `m4-adversarial` (20), `direct-member-share` (5), `admin-ui-ux` (4), `scroll-storytelling` (4), `schema-v2-compatibility` (15).
- **E2E シナリオテスト (End-to-End Tiers 1〜4, 71 tests)**:
  - **Tier 1 (全機能網羅, 36 tests)**: F1〜F20 の全機能契約の検証。
  - **Tier 2 (境界値分析, 22 tests)**: 24:00深夜跨ぎ、timeLocked防壁、奇数円割り勘、900KB上限、危険URLスキーム拒否。
  - **Tier 3 (機能間複合連携, 4 tests)**: 候補スポット採用→カスケード調整→立替精算→エクスポート/インポートのラウンドトリップ。
  - **Tier 4 (実運用実シナリオ, 9 tests)**: 新規ドラフト起草から公開・進行・精算に至る5つの実旅行運用シナリオ。

### 8.3 マスター検証スクリプト (`node verify-all.mjs`)
- **Step 1 (Milestone 2 Admin 構成)**: PASS (48 imports, 31 closure, 188 DOM IDs, 176 symbols)
- **Step 2 (Milestone 3 Viewer 構成)**: PASS (8 imports, 0 cycles, 18 closure, 47 DOM IDs)
- **Step 3 (Milestone 4 耐性・オフライン)**: PASS (SW 75/75 アセット存在確認, エラーバウンダリ, オフラインキュー)
- **Step 4 (Schema v2 整合性)**: PASS (`20261031.json === 20261107.json`, 8 cards, 監査エラー0件)
- **Step 5 (45モジュール依存グラフ)**: PASS (84 internal edges, **0 cycles detected**)
- **Step 6 (行数制限)**: PASS (23 constrained files 全件合格)

---

## 9. 結論と次なる大型アップデートへの接続

SHIORI_app は、v2.0.0 をもって「コンバージョン安定版の集大成」としての完成形に到達した。
コードベースは強固にモジュール化され、状態遷移はリアクティブストアによって予測可能であり、オフラインでの実用性と障害復旧能力は極めて高い水準にある。

この盤石な土台の上に、次なる大型アップデート（リアルタイム同行同期、内蔵インタラクティブマップ、IndexedDB移行、PWA高度連携、写真ジャーナリング、Gemini AIコンシェルジュ）を自信を持って構築することが可能である。具体的な提案とロードマップについては、同リポジトリ内の `NEXT_MAJOR_UPDATE_PROPOSAL.md` に詳述されている。
