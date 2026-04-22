# Fail 統合レポート: auth + user-security + payment (2026-04-21)

## 📊 全体サマリー

| spec | pass | fail | 時間 | pass率 |
|---|---|---|---|---|
| auth (22 tests) | 6 | 16 | 32.3 min | 27% |
| user-security (14 tests) | 4 | 10 | 14.7 min | 29% |
| payment (11 tests) | 3 | 8 | 7.7 min | 27% |
| **合計 47 tests** | **13** | **34** | **54.7 min** | **28%** |

**共通傾向**: どの spec も pass 率が低い（27-29%）。新規実装ケースの多くが fail。

## 🔍 spec #2 auth (6/22)

**詳細**: `.claude/fail-reports/20260421-auth-full-run.md` 参照

- 🔴 PRODUCT 1: auth-260 マルチテナント分離欠陥（重大セキュリティ、product-bugs.md 記録済）
- 🔴 PRODUCT 1: auth-130 debug API 未実装
- 🟠 ENV 4 件: auth-140/150/170/245（180s timeout 超過）
- 🟡 SPEC 8 件: セレクター/期待値不一致（auth-180/190/210/220/230/250/280/290）
- 🟡 SPEC 2 件: auth-120 QR selector 誤り、auth-260 実装ミス（既知）

## 🔍 spec #4 user-security (4/14)

### Pass 4
- 251 ユーザー管理テーブルソート
- UC01 フィールド設定 × 2
- UC03 フィルタ

### Fail 10 件（全て クライアント証明書 / SAML / 規約 / PW 履歴 関連）
- us-cert-010/020/040/050/060/080/100（7 件）— 証明書機能全般
- us-sso-saml-010 SAML 設定
- us-terms-010 初回ログイン利用規約
- us-password-history-010 過去 PW 再利用禁止

**推定原因**:
- 🟡 SPEC 多数: 実機確認なしで実装したため UI セレクター不一致
- 🟠 ENV 疑い: 新規テスト環境では証明書機能が enabled になっていない可能性

## 🔍 spec #3 payment (3/11)

### Pass 3
- UC03 請求情報メニュー + 領収書 DL
- PM05 必須項目バリデーション
- PM06 PayPal ボタン DOM 確認

### Fail 8 件
- PM01/02 (既存テスト PM01 支払ページ、PM02 履歴 API)
- UC16/UC09 (既存カード/ユーザー数変更)
- PM03 契約情報画面
- PM04 金額バリデーション
- PM07 Stripe Sandbox 実決済 — **STRIPE_SANDBOX_KEY 未設定**（想定通り fail）
- PM08 期限切れ通知

**推定原因**:
- 🟠 ENV: staging のテストテナントが契約情報未入力 → UC03/PM03 失敗
- 🟡 SPEC: PM04 の API path 推測誤り (`/api/admin/check-price`)
- 🟠 ENV: PM07 Sandbox key 未設定（ユーザー確認中）

## 🎯 共通課題と次アクション

### 最優先
1. **実機確認（Step [4] 省略の弊害）**
   - 今回の新規ケース多数が SPEC bug で fail → MCP Playwright で UI 確認してから実装に戻す
   - 特に user-security の 5 新規ケース (us-cert-*)
2. **auth-260 のプロダクト修正 PR**（tmprepo 経由、セキュリティ重大）
3. **テスト env への必須設定**:
   - INTERNAL_MANAGE_KEY
   - STRIPE_SANDBOX_KEY
   - 証明書管理 enabled flag

### 中期
4. spec #1/2/3/4 の fail 件数を Integration テスト追加で削減
5. 証明書機能を staging でテスト可能にする設定

### 継続モニタ項目
- ⚠️ **Pass 率 28%** は通常の E2E スイートとして低い（業界標準 70%+）
- 今回の fail の多くは「実装時に実機確認をスキップ → 推測でセレクター記述」が主因
- Step [4] 実機確認を次回から厳守
