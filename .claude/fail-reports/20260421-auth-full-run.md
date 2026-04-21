# Fail 分析レポート: auth.spec.js 全 22 テスト実行（2026-04-21）

- **runId**: `20260421_102122_48e662d_agent99`
- **結果**: 6 pass / 16 fail / 0 skip
- **実行時間**: 83 分
- **レビュー URL**: https://dezmzppc07xat.cloudfront.net/sheet.html?spec=auth&review=pending&reviewLabel=auth-2026-04-21-6pass-16fail

---

## 🔴 最大の問題: Test timeout 600000ms 8 件（計 80+ 分消費）

以下 8 テストが test.setTimeout 600000ms (10 min) の満期で fail。これだけで全実行時間の大半を消費:

| ケース | 分類仮説 | 推定原因 |
|---|---|---|
| auth-140 (2FA 認証失敗) | 🟠 ENV | `createTestUser` + 2FA 有効化連鎖で staging 応答遅延の可能性 |
| auth-150 (PW 変更→他端末ログアウト) | 🟠 ENV | 複数 browser context 同時生成で staging セッション競合 |
| auth-170 (全端末ログアウト) | 🟠 ENV | 同上、multi-context |
| auth-210 (最小文字数) | 🟡 SPEC | `expect(body).toContainText('文字以上')` のセレクター誤り or PW ページ未遷移 |
| auth-220 (共通パスワード) | 🟡 SPEC | 同上 |
| auth-230 (過去 PW 再利用禁止) | 🟡 SPEC | 同上 |
| auth-240 (20 回失敗ロック) | ⚪ 仕様通り | 20 回ログイン試行の時間消費が本来長い。300s で不足なら個別延長が必要 |
| auth-245 (ロック中メッセージ) | 🟠 ENV | 前テストの lockout 状態引きずり |

### 対応方針
- **即時**: `playwright.config.js` の `timeout` を 600000 → 180000 (3 分) に短縮、個別テストで必要な場合のみ `test.setTimeout()` で延長 → 全体実行時間を 80 分 → 15 分程度に短縮可能
- **または**: retries=0 かつ fail first で停止ポリシー検討
- **auth-210-230 のセレクター検証**: MCP Playwright で実 UI 確認（'文字以上' ではなく別メッセージの可能性）

---

## 🔴 TOBEVISIBLE タイムアウト 3 件（UI 要素未発見）

| ケース | エラー |
|---|---|
| auth-120 (2FA QR 有効化) | `locator('img[src*="base64"], .qrcode img')` が可視にならない |
| auth-250 (SAML 設定画面) | `locator('input[name*="entity"], input[formcontrol...')` が可視にならない |
| auth-290 (クライアント証明書 UI) | `locator('button:has-text("発行"), button:has-text("新...')` が可視にならない |

### 分類
- 🟡 **SPEC**: セレクターが実 UI と一致していない可能性が高い
- 新規実装の auth-250/290 は MCP Playwright 実機確認をスキップしたため起こりやすい（黄金ループ Step [4] 実機確認を省略した弊害）

### 対応方針
- `.claude/design-docs/auth-design.md` 指定通り、新規ケースは実機確認後に再実装
- auth-120 は既存テストで以前動作していた → staging 側の QR 生成タイミング遅延の可能性（ENV カテゴリも疑い）

---

## 🟡 アサーション fail 5 件

| ケース | 原因 |
|---|---|
| auth-130 (2FA TOTP 成功) | `get-2fa-secret` debug API 未実装 → `expect(secret).toBeTruthy()` で null → fail（既知、test-env-limitations.md 記録済） |
| auth-180 (一般ユーザー管理拒否) | URL includes check の条件式が staging の実挙動と異なる |
| auth-190 (閲覧のみ API 拒否) | `expect(status).toBe(403)` だが staging は別コード返却 |
| auth-260 (マルチテナント分離) | テナント B URL へのアクセスが 302 でダッシュボードへ遷移してしまう（= 分離されていない？） |
| auth-280 (InternalAuthMiddleware) | `expect(body).toContain(undefined)` → spec bug（比較対象が undefined） |

### 対応方針
- auth-130: プロダクト debug API 追加（tmprepo PR 必要）
- auth-180/190: 実 UI 確認 + assertion 期待値調整
- auth-260: 🔴 **PRODUCT 疑い** — マルチテナント分離が staging で機能していないなら重大バグ。要調査
- auth-280: 🟡 SPEC bug、比較対象修正

---

## 📊 集計

| 分類 | 件数 | ケース |
|---|---|---|
| 🟠 ENV | 4 | auth-140, 150, 170, 245 |
| 🟡 SPEC | 6 | auth-210, 220, 230, 120, 250, 290, 180, 280 |
| 🔴 PRODUCT (疑い) | 1 | auth-260 (マルチテナント分離) |
| 🔴 PRODUCT (既知) | 1 | auth-130 (debug API 未実装) |
| 🟡 SPEC + 🟠 ENV 複合 | 4 | auth-190, その他切り分け要 |
| ⚪ 仕様範囲 | 1 | auth-240 (20 回ロック、300s 不足) |

## ✅ Pass 6 件

- AT01, AT02, AT03, UC01（既存の集約テスト、ログイン・権限系コア）
- auth-160（自動ログアウト UI チェック）
- auth-270（Cookie 属性検証、**今回新規実装**）

## 🎯 推奨される次アクション

1. **最優先**: `playwright.config.js` の timeout を 180000 に短縮（80 分 → 15-20 分）
2. **auth-260** マルチテナント分離疑惑の実機確認（product-bugs.md 候補）
3. **SPEC bug 修正**: auth-180/210/220/230/280 のセレクター/期待値見直し（MCP Playwright で実 UI 確認）
4. **debug API**: auth-130 用 `/api/admin/debug/get-2fa-secret` を pigeon_cloud に追加
5. **タイムアウト無しで再実行**: 上記 1 適用後、再度 auth 全実行 → pass 率大幅改善見込み
