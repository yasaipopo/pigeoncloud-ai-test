# PigeonCloud URL パス規約 — SPA fallback vs PHP API

## 原則

| パス接頭辞 | 処理 | レスポンス |
|---|---|---|
| `/admin/*` | Angular SPA fallback (nginx/CloudFront が index.html を返す) | HTML 200 |
| `/api/admin/*` | PHP バックエンド (Slim 4 router) | JSON |
| `/api/*` | PHP バックエンド（非 admin） | JSON |

## テストで気をつけること

- API レスポンスを検証する際は **必ず `/api/admin/*` を叩く**
- `/admin/debug/status` は HTML を返すため、API 検証には使えない（SPA fallback）
- 正しい: `GET /api/admin/debug/status` → JSON
- 誤り: `GET /admin/debug/status` → HTML (SPA shell)

## notifications.spec.js の既存コード (line 1245)

```js
const status = await page.request.get(BASE_URL + '/admin/debug/status').then(r => r.json()).catch(() => null);
```

これは `catch(() => null)` で HTML レスポンスを握り潰している。正しくは `/api/admin/debug/status` に変更すべきだが、本テストはフォールバック経路で別 API を叩く実装のため致命的ではない。

## auth-260 での実例 (2026-04-23)

PR #3132/#3135/#3136 でマルチテナント session 分離を実装後、E2E auth-260 が fail し続けていた。
原因は SPA fallback の性質上、`/admin/dashboard` にアクセスすると常に HTML 200 が返り、ブラウザ URL も変わらないため、URL ベースの検証が意味を成さなかったこと。

修正後は `/api/admin/debug/status` に tampered cookie を送り、バックエンドから 401 (tenant mismatch) or 400 (login_error) が返ることで分離を検証している。
