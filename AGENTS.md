# プロジェクト共通ルール (AGENTS.md) - SHIORI_app

この規約は `C:\My app\SHIORI_app` 以下のすべての作業へ常時適用する。

## 1. 文字コード・ファイル形式規約

- `.html`, `.js`, `.mjs`, `.css`, `.json`, `.md`, `.webmanifest`: **UTF-8（BOMなし）**
- `.ps1`: **UTF-8 with BOM**（PowerShell 5.1/7の日本語文字化け防止のため厳守）
- `.cmd`, `.bat`: **Shift_JIS（CP932）**
- 改行コード: `CRLF`（Windows環境標準）

## 2. アーキテクチャとモジュール行数制約（厳格）

- **モジュール方式**: ネイティブ ES Modules (`import`/`export`)。
- **相対パス拡張子**: 相対 import は必ず `.js` 拡張子を付与すること（例: `import { x } from './module.js';`）。
- **循環依存の禁止**: `src/` 配下のすべてのモジュール依存グラフは非循環（DAG）でなければならない。
- **厳格な行数制約**:
  - `src/admin.js` (管理者エントリ): **<= 150行**
  - `src/viewer-app.js` (閲覧者エントリ): **<= 150行**
  - `src/pwa-manager.js`: **<= 150行**
  - `src/admin-distribution-ledger.js`: **<= 300行**
  - 各種機能モジュール (`src/admin-*.js`, `src/viewer-*.js` 等): **<= 400行**
  - `sw.js` (Service Worker): **<= 200行**
  - `src/error-boundary.js`: **<= 200行**
  - `src/offline-expense-queue.js`: **<= 200行**

## 3. 運用・ライフサイクル仕様

- **正本ポート**: `app-port.json` で定義されたポート `4173`。
- **起動**: `StartApp.ps1`（`-NoBrowser`, `-Silent` 対応）または `アプリ起動.cmd`。
  - バックグラウンドで `serve.py` が稼働し、`GET /api/health` を応答する。
- **停止**: `StopApp.ps1`（`-Silent` 対応）または `アプリ終了.cmd`。
- **インスタンス追跡**: `.shiori-server.pid`, `.shiori-server.port`。

## 4. 必須検証テストスイート

コード変更を行った際は、以下の検証を必ず全件実行して合格を確認すること：

```powershell
.\run-tests.ps1
node verify-all.mjs
```

1. **`run-tests.ps1`**:
   - `tests/day-planner.test.js`, `tests/draft-validation.test.js`, `tests/itinerary-calc.test.js`, `tests/settlement.test.js`, `tests/trip-core.test.js` などのユニットテスト（100+ tests）。
2. **`verify-all.mjs`**:
   - M2 (管理者モジュール・行数・シンボル整合性)
   - M3 (閲覧者モジュール・ルーティング・循環依存なし)
   - M4 (オフラインキュー・Service Worker・Error Boundary)
   - Schema v2 整合性 (`20261107.json`, `20261031.json`)
   - 45モジュール完全非循環検証
   - 全ファイル行数制約検証

## 5. 壊してはいけない不変の前提

- GitHub Pages (`https://k-oishi02.github.io/shikoku-drive/`) での静的配信互換性
- `recaps/*.json` の `shiori-recap-v1` スキーマ（LifeMoney Hub との連携データ）
- `admin.html` および `index.html` の DOM ID 互換性
- Firebase Firestore との同期契約
- オフライン動作（PWA / Service Worker / IndexedDB キュー）
