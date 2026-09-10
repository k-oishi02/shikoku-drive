# SHIORI

旅行の計画・当日利用・振り返りをまとめるWebアプリです。

## ローカル起動

PowerShellで次を実行します。

```powershell
cd 'C:\My app\SHIORI_app'
.\start-local.ps1
```

起動先は `http://localhost:4173` です。ポート番号は `app-port.json` が正本で、共通台帳の `C:\My app\localhost-ports.json` にも登録しています。

## 役割別の画面

- `index.html`: 参加者用しおり
- `admin.html`: 管理者用編集画面
- `recap.html`: 旅行の振り返り

本番公開先は https://k-oishi02.github.io/shikoku-drive/ です。
