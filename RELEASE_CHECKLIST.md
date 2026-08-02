# 公開チェックリスト

## コード

- [x] 参加者アプリ・管理者アプリの構文検査
- [x] カード、ボタン、リンク、予定制約の回帰検査
- [x] 同期失敗時のMEMBERS表示
- [x] LIVE時だけROOM・招待操作を表示
- [x] PWAキャッシュ更新
- [ ] 実機2台で最終確認

## Firebase Console

- [x] Authenticationで「匿名」を有効化
- [x] Authenticationで「Google」を有効化
- [x] Authorized domainsへ `k-oishi02.github.io` を追加
- [x] Googleログイン後のUIDで `admins/{uid}` を作成
- [x] `src/firestore.rules` と同じルールを公開
- [x] 管理者画面から旅程を公開
- [ ] 管理者画面から新しい配布先・招待リンクを作成
- [ ] 旧招待リンクを停止

## GitHub Pages

- [ ] ローカル最新版を公開リポジトリへ反映
- [ ] Pagesの公開元が `main` のルートになっていることを確認
- [ ] 公開後にPWA更新を適用

## 2台テスト

- [ ] 2台とも新しい招待リンクで開く
- [ ] MEMBERSに両者の名前が出る
- [ ] `LIVE SYNC` と `2/2台` が出る
- [ ] 支出の追加・削除・コメントが相互反映される
- [ ] オフライン後の再接続で同期が復帰する
- [ ] 配布停止後、新規端末から参加できない
