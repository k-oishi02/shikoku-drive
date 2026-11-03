# SHIORI (SHIORI_app) — PWA トラベルガイド アプリケーション

旅行の計画策定（管理者向けコンソール）・旅行当日のリアルタイム利用（参加者向けしおり）・旅行後の振り返り（RECAP）を一元管理する、高信頼・オフライン対応のモダンPWAアプリケーションです。

---

## 1. 概要と特徴

- **参加者向けしおり (`index.html`)**:
  スマートフォンでの利用に最適化したPWA画面。日程タブ切り替え、スワイプ操作、リアルタイム進行管理（NOWモード）、Open-Meteo気象情報表示（オフライン時バッジ `📴` 表示）、外部交通・予約アプリアクティベーション（トヨタレンタカー、じゃらん、HELLO CYCLING、ANA、PayPay、ウェザーニュース等）、割り勘立替費用の記録・二分探索清算を提供。
- **管理者向けコンソール (`admin.html`)**:
  直感的な日本語4ステップナビゲーション（① 旅行一覧、② しおり編集・公開、③ メンバーへ共有、④ 管理者設定）。プログレッシブ情報開示アコーディオン、候補スポット棚（Candidate Shelf）、`timeLocked` 保護・24:00深夜跨ぎ防止付き自動カスケード時間調整エンジン（Day Planner）、既知メンバー端末への直接プッシュ共有、立替精算台帳を装備。
- **モダンアーキテクチャ**:
  従来のモノリシックな巨大スクリプトを完全撤廃し、45個のネイティブESモジュールへ分割。単一の情報源となるリアクティブストア（`TripStore` および `AdminStore`）、DOM非依存の純粋計算ドメインコア、グローバルエラーバウンダリ、オフライン立替キュー、Service Worker（75アセットキャッシュ）による高い堅牢性を実現。

---

## 2. 共通運用インターフェース規格 (MASA準拠)

本アプリは `C:\My app\AGENTS.md` に規定された共通運用インターフェース規格（MASA: My app Standard Architecture）に完全準拠しています。

### ポート仕様
- **ポート番号**: `4173`（固定・予約専有）
  - 正本: `app-port.json`
  - 共通台帳: `C:\My app\localhost-ports.json`
- **ヘルスチェックURL**: `http://localhost:4173/api/health`
  - 応答例: `{"app": "SHIORI", "status": "ok", "port": 4173, "version": "2.0.0"}`

### 起動と停止操作

#### A. エクスプローラー / デスクトップからの操作（推奨）
- **起動**: `アプリ起動.cmd` をダブルクリック
- **停止**: `アプリ終了.cmd` をダブルクリック

#### B. PowerShell からの操作
- **バックグラウンド起動**:
  ```powershell
  cd 'C:\My app\SHIORI_app'
  .\StartApp.ps1
  ```
  ※ ブラウザを自動起動したくない場合は `-NoBrowser`、コンソール出力を抑制したい場合は `-Silent` を付与できます。

- **安全なシャットダウン**:
  ```powershell
  cd 'C:\My app\SHIORI_app'
  .\StopApp.ps1
  ```
  ※ プロセスIDファイル（`.shiori-server.pid`）およびポート記録ファイル（`.shiori-server.port`）を安全に検知・解放します。

---

## 3. アプリケーション画面と利用フロー

| 画面 | ファイル | 主な役割・機能 |
|---|---|---|
| **参加者用しおり** | `index.html` | 旅程タイムライン閲覧、スワイプ移動、持ち物リスト、天候情報、割り勘費用登録、NOWモード進行記録 |
| **管理者用コンソール** | `admin.html` | 旅行一覧管理、しおり基本情報・カード編集、候補スポット管理、カスケード日程編成、共有ルーム発行・管理 |
| **旅行の振り返り** | `recap.html` | タイムライン振り返り、訪問スポット履歴、旅行感想・総評の閲覧（静的RECAP） |

---

## 4. アーキテクチャ設計

```
+---------------------------------------------------------------------------------------------+
|                                    SHIORI_app Architecture                                  |
+---------------------------------------------------------------------------------------------+
|                                                                                             |
|  [Admin Track: admin.html]                            [Participant Track: index.html]       |
|            |                                                         |                      |
|            v                                                         v                      |
|    src/admin.js (entry point <150 L)                         src/viewer-app.js (<150 L)     |
|            |                                                         |                      |
|            v                                                         v                      |
|    src/admin-store.js (Reactive Store)                       src/trip-store.js (Store)      |
|    ├── admin-view-overview.js                                ├── viewer-router.js           |
|    ├── admin-view-editor.js                                  ├── viewer-ui.js               |
|    ├── admin-candidate-ui.js                                 ├── weather-service.js         |
|    ├── admin-day-planner-ui.js                               ├── pwa-manager.js             |
|    ├── admin-distribution-ui.js                              ├── participant-v2.js          |
|    ├── admin-roles-ui.js                                     └── error-boundary.js          |
|    └── admin-discussion-ui.js                                                               |
|            |                                                         |                      |
|            +----------------------------+----------------------------+                      |
|                                         |                                                   |
|                                         v                                                   |
|                         [Pure Domain & Calculation Core]                                    |
|          ├── src/trip-v2-core.js (parsing, normalization, schema migration)                  |
|          ├── src/trip-v2-analysis.js (auditing, phase calculation, settlementTransfers)      |
|          ├── src/draft-validation.js (schema validation, 900KB size limit guard)            |
|          ├── src/admin-day-planner.js (cascade adjustments, reorder, undo snapshots)         |
|          ├── src/admin-placement.js (collision & travel buffer rules)                        |
|          ├── src/itinerary-calc.js (timeline derivation, live delay, card links)             |
|          └── src/map-links.js (maps query & navigation URL builder)                         |
|                                         |                                                   |
|                                         v                                                   |
|                         [Automated Test Suites (444 Tests)]                                 |
|          ├── tests/*.test.js (373 Unit & Adversarial Stress Tests)                          |
|          ├── tests/e2e/*.test.js (71 End-to-End Tiers 1-4 Tests)                            |
|          └── verify-all.mjs (Milestone Master Verification Suite)                            |
+---------------------------------------------------------------------------------------------+
```

### コアコンポーネント
1. **リアクティブストア (`AdminStore` / `TripStore`)**:
   プロトタイプ汚染対策、配列スライスの完全保護、きめ細やかなスライス分離（各7スライス）を備えたゼロ依存のPub/Sub状態管理。
2. **純粋計算ドメインコア**:
   UIやDOMから完全に独立した関数型ロジック。時間計算（`itinerary-calc.js`）、スキーマ検証・Firestore 900KB制限防御（`draft-validation.js`）、2ポインタ貪欲債務解消アルゴリズム（`settlementTransfers`）、`timeLocked` 防御付きカスケード日程編成（`admin-day-planner.js`）。
3. **オフライン耐性＆エラーバウンダリ**:
   - `src/error-boundary.js`: 未補足エラーや非同期拒否を捕捉し、親しみやすい日本語復旧UIを提供。
   - `src/offline-expense-queue.js`: オフライン時に登録された立替費用を安全にローカルキューイングし、再接続時に自動送信。
   - `sw.js`: 75個のアセットをCacheStorageに事前キャッシュし、完全オフライン表示を保証。
4. **Schema v2 互換性**:
   標準サンプルデータ（`20261107.json`, `20261031.json`, `20261128.json`）を非破壊で読み込み・正規化・表示・編集可能。

---

## 5. テスト・検証コマンド

本プロジェクトには、単体テスト、ストレステスト、結合テスト、E2Eシナリオテスト、およびアーキテクチャ静的検証を含む合計444件の自動テストが配備されています。

### npm コマンド一覧
```powershell
# 単体・ストレステスト（373テスト）を実行
npm test

# E2Eテスト（Tiers 1〜4、71テスト）を実行
npm run test:e2e

# 全テストスイート（444テスト一括）を実行
npm run test:all

# アーキテクチャ・モジュール制約検証（verify-all.mjs）を実行
npm run verify
```

### PowerShell ネイティブ実行
```powershell
# 8大重要ビジネスロジックの高速スモークテスト（117テスト、約0.5秒）
powershell -ExecutionPolicy Bypass -File .\run-tests.ps1

# エコシステム全体（TRY_app, lifemoney_hub, SHIORI_app）の一括検証
cd 'C:\My app'
powershell -ExecutionPolicy Bypass -File .\Test-AllApps.ps1
```

---

## 6. プロジェクトファイル構成

```
C:\My app\SHIORI_app\
├── package.json               # ESM定義およびテストスクリプト定義
├── app-port.json              # ポート設定ファイル (4173)
├── StartApp.ps1               # MASA標準 起動スクリプト (UTF-8 with BOM)
├── StopApp.ps1                # MASA標準 停止スクリプト (UTF-8 with BOM)
├── run-tests.ps1              # PowerShell テストランナー (UTF-8 with BOM)
├── アプリ起動.cmd             # Windowsデスクトップ用 起動コマンド (CP932)
├── アプリ終了.cmd             # Windowsデスクトップ用 停止コマンド (CP932)
├── serve.py                   # ヘルスチェック (/api/health) 付きHTTPサーバー
├── index.html                 # 参加者用しおり HTMLシェル (<=900行制約)
├── admin.html                 # 管理者用コンソール HTMLシェル
├── recap.html                 # 振り返り画面
├── sw.js                      # 75アセットオフラインキャッシュ Service Worker
├── verify-all.mjs             # Milestone 5 マスターアーキテクチャ検証
├── 20261107.json              # 標準サンプル旅行データ (茨城秋ドライブ, Schema v2)
├── 20261031.json              # 標準サンプル旅行データ (正規化検証用ツイン)
├── 20261128.json              # 秩父長瀞サンプル旅行データ (Schema v2)
├── src/                       # ネイティブESモジュール群 (45モジュール)
│   ├── admin.js               # 管理者画面エントリポイント (<=150行)
│   ├── viewer-app.js          # 参加者画面エントリポイント (<=150行)
│   ├── admin-store.js         # 管理者リアクティブストア
│   ├── trip-store.js          # 参加者リアクティブストア
│   ├── error-boundary.js      # グローバルエラーバウンダリ (<=200行)
│   ├── offline-expense-queue.js # オフライン立替キュー (<=200行)
│   ├── weather-service.js     # 天候連携・キャッシュ (<=250行)
│   ├── pwa-manager.js         # PWA更新・インテント管理 (<=150行)
│   ├── itinerary-calc.js      # タイムライン・遅延計算
│   ├── trip-v2-core.js        # スキーマ正規化・パース
│   ├── trip-v2-analysis.js    # 旅程監査・立替精算
│   └── draft-validation.js    # 入力検証・900KB制限ガード
├── tests/                     # 自動テストスイート群
│   ├── draft-validation.test.js
│   ├── trip-core.test.js
│   ├── settlement.test.js
│   ├── day-planner.test.js
│   ├── itinerary-calc.test.js
│   ├── error-boundary.test.js
│   ├── sw-manifest.test.js
│   └── e2e/                   # Tiers 1-4 E2Eテスト
└── recaps/                    # 旅行振り返りデータ (LifeMoney Hub 連携読取対象)
```
