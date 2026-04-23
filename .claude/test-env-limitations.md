# テスト不可一覧（環境・設定・プロダクト未実装による制約）

**このファイルの目的**: E2E テストで「環境的・技術的に検証できない」ケースを**忘れずに追跡**する。

**原則**:
- スキップは **例外**、最小限に留める
- スキップする度にこのファイルに記載する（隠蔽禁止）
- 「解消条件」を必ず書く（いつ復活できるか）
- 定期的に見直して、解消できたものはテスト化する

**スキップ許容基準（満たさない場合はスキップ禁止、必ず実装する）**:
1. ✅ プロダクトに**機能自体が実装されていない**（コード・DBカラム・UI のいずれも存在しない）
2. ✅ **インフラ・外部システム依存**で E2E では再現不可（DNS偽装、別ドメイン経由等）
3. ✅ **破壊的操作**で staging 環境を壊すリスクが高い（本番DB影響、他テスト阻害）

**スキップ禁止パターン（絶対にやらない）**:
- ❌ 「UI セレクタが見つからない」→ MCP Playwright で調査して修正する
- ❌ 「機能はあるがテストが難しい」→ 工夫して実装する
- ❌ 「assertion が通らない」→ プロダクトバグの可能性を調査する
- ❌ 「時間がない」→ ケースを絞って最低限実装する

---

## 🔴 現在スキップ中のケース一覧

### spec: users-permissions / IP制限

#### R-143 / up-ip-110: SEC_DOMAIN バイパスの検証

- **スキップ理由**: `SEC_DOMAIN`（セキュアドメイン経由のバイパス）を E2E で検証するには、
  CloudFront 経路を変更して別ホスト名経由でアクセスする必要があり、Playwright では不可能
- **プロダクト側実装**: `Application/Entity/Admin/Admin.php:435` に実装あり（gemcli A 確認済み）
- **スキップ基準該当**: インフラ依存（基準 2）
- **解消条件**:
  - (a) pigeon_cloud に debug API を追加して `SEC_DOMAIN` フラグを擬似的に有効化できるようにする
  - (b) 同一ドメイン上で `X-Forwarded-Host` ヘッダー経由で検証する仕組みを導入する
- **関連要件**: R-143 (例外設定)
- **記載日**: 2026-04-19
- **見直し予定**: pigeon_cloud に debug API 追加された時点

#### R-139 / up-ip-044 (B002 再現): staging では原理的に再現不可

- **スキップ理由**: B002 バグ（`NetCommon::isPrivateIp()` の `FILTER_FLAG_NO_PRIV_RANGE`）はプライベートIP (10/8, 172.16/12, 192.168/16) 経由のアクセスでのみ発動する。
  staging の接続元IP は AWS NAT Gateway の **public IP** (`54.64.86.208`) になるため、B002 の発動条件を満たさない。
- **プロダクト側実装**: `Application/Class/NetCommon.php:210` (gemcli A 確認済み)
- **スキップ基準該当**: インフラ依存（基準 2）
- **解消条件**:
  - (a) プライベートIP 経由でアクセス可能な別テスト環境構築
  - (b) プロダクト側に `X-Debug-Client-Ip` 等のヘッダーで接続元IPを偽装できる debug フラグ追加
  - (c) `NetCommon::getIp()` の単体テスト（PHPUnit）でカバー
- **代替実装**: up-ip-044 は「現在IP (public IP) を /32 許可してログイン成功」の正常系に変更 → R-139 の別面をカバー
- **関連要件**: R-139 (IPアドレス制限) + B002 バグトラッキング
- **別途チケット化**: 要（テスト手法の改善）
- **記載日**: 2026-04-19
- **見直し予定**: プライベートIP 環境構築または debug フラグ追加後

#### R-109 / R-115: SAML IdP 実ログイン

- **スキップ理由**: SAML IdP (Google Workspace / Microsoft 365 等) との連携ログインは、外部 IdP 側の設定・DNS 伝播・実テナント契約が必要。staging のブラウザで実走検証は不可。
- **プロダクト側実装**: `Application/Controllers/SamlLoginController.php` (OneLogin php-saml 使用)
- **スキップ基準該当**: インフラ/外部システム依存（基準 2）
- **代替実装**: SAML 設定画面 (/admin/sso-settings) の UI 確認 + 不正設定値のエラー検証で間接的にカバー
- **解消条件**:
  - (a) 専用のモック IdP エンドポイント構築
  - (b) 手動テストで定期検証
- **関連要件**: R-109, R-115, R-122 (SAML エラー)
- **記載日**: 2026-04-19
- **見直し予定**: モック IdP 構築 or 定期手動テスト導入後

#### R-119: SSO リダイレクト実走

- **スキップ理由**: SSO リダイレクト先での実認証完了は外部 IdP 応答に依存。
- **プロダクト側実装**: `Application/Controllers/SamlLoginController.php` (/saml/sso)
- **スキップ基準該当**: 外部システム依存（基準 2）
- **代替実装**: /saml/sso へのリダイレクトが発生することまでは確認可能
- **解消条件**: SAML と同様
- **関連要件**: R-119
- **記載日**: 2026-04-19

#### R-117: クライアント証明書 実ログイン

- **スキップ理由**: Playwright 標準のブラウザコンテキストにクライアント証明書をインポートする仕組みが限定的。ALB mTLS 終端経由の `X-Amzn-Mtls-Clientcert` ヘッダーの手動挿入も E2E では困難。
- **プロダクト側実装**: `Application/Service/CertificateService.php` (ALB mTLS 検証)
- **スキップ基準該当**: ブラウザ/インフラ依存（基準 2）
- **代替実装**: 証明書発行 UI (/admin/setting/client-cert) 表示 + 証明書なしでアクセス時の拒否確認までは可能
- **解消条件**:
  - (a) Playwright でクライアント証明書インポート方法確立
  - (b) プロダクト側に debug API で証明書バイパスフラグ追加
- **関連要件**: R-117
- **記載日**: 2026-04-19

#### R-146 / up-ip-140: IPv6 バリデーション (要仕様確認)

- **スキップ理由**: 実機検証で IPv6 (`2001:db8::1`) を入力しても `.alert-danger` が出ない。
  プロダクトの正規表現 `/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/` は IPv4 のみだが、
  フロント側でも何のエラー表示もない。サイレント無視か、フィールドが何も保存されないか未確定。
- **プロダクト側実装**: `Application/Class/IpChecker.php:10`
- **スキップ基準該当**: 🟡 保留（仕様確認中、完全にスキップではなく挙動再定義）
- **解消条件**: 以下どちらかを実施後にテスト実装
  - (a) ユーザー or 開発チームに IPv6 仕様を確認（対応予定か否か）
  - (b) 現状の「サイレント無視」を正として、そのエラー表示がないことをテストで許容
- **関連要件**: R-146 (IP検証エラー)
- **記載日**: 2026-04-19
- **見直し予定**: 仕様確認後

#### R-144 / up-ip-120: 「一時的な許可」機能

- **スキップ理由**: プロダクトに実装なし
  - `admin_allow_ips_multi` テーブルに `expires_at` カラムなし（gemcli A 確認済み）
  - UI なし、バックエンドロジックなし
  - `docs/security/ip_restriction.md` には記載があるが実装されていない
- **スキップ基準該当**: プロダクト未実装（基準 1）
- **解消条件**: pigeon_cloud に機能追加（DB カラム追加、UI、バックエンド全て）
- **関連要件**: R-144 (一時的な許可)
- **別途チケット化**: 要（機能追加リクエスト）
- **記載日**: 2026-04-19
- **見直し予定**: 機能追加 PR がマージされた時点

---

## 📋 テンプレート（新規追加時の記入例）

```markdown
#### R-XXX / テストID: 概要

- **スキップ理由**: (具体的に)
- **プロダクト側実装**: (ある場合はファイルパス + 行番号)
- **スキップ基準該当**: (1=機能未実装 / 2=インフラ依存 / 3=破壊的操作)
- **解消条件**: (どうすればテスト可能になるか)
- **関連要件**: R-XXX (要件名)
- **別途チケット化**: 要 / 不要
- **記載日**: YYYY-MM-DD
- **見直し予定**: (いつ見直すか)
```

---

## 📊 スキップ統計（メトリクス）

- 総要件数 (priority:high): **76 件**
- 現在スキップ中: **6 件** (R-139 B002再現 / R-143 SEC_DOMAIN / R-144 一時許可 / R-109-115 SAML / R-119 SSO / R-117 Cert)
- 保留中 (仕様確認): **1 件** (R-146 IPv6 バリデーション)
- スキップ率: **7.9 %** (保留含め 9.2%)
- **備考**: 外部 IdP / ALB mTLS 依存の 3 件は「UI 確認は実装、実走のみスキップ」で実質カバー率は維持

**目標**: スキップ率を常に **5% 以下**に保つ。それを超えたら見直しを実施する。

---

## 🔄 見直しサイクル

- **毎スプリント開始時** (2週間に1回): スキップ中の項目を見直す
- **解消条件に該当する PR マージ時**: そのタイミングでテスト化する
- **スキップ追加時**: 必ずユーザーに確認を取る（勝手判断禁止）

#### R-161 / pay-130: PayPal 決済
- **スキップ理由**: ユーザー指示「PayPal テスト不要」。
- **代替実装**: PayPal ボタンの DOM 存在確認のみ。

#### R-163: Stripe Webhook (定期課金成功)
- **スキップ理由**: Staging 環境での外部 Webhook 受信設定が必要なため。

#### R-166: 返金処理
- **スキップ理由**: プロダクト未実装。

#### R-170: 解約処理
- **スキップ理由**: UI 未実装、または外部 Stripe ダッシュボード操作が必要なため。

#### R-171 / pay-150: Webhook 失敗通知
- **スキップ理由**: Webhook 失敗状態を意図的に作り出すのが困難なため。

#### us-cert-090: クライアント証明書を用いた外部 API 連携
- **スキップ理由**: 外部 API のサンドボックスおよび mTLS 設定が必要なため。

#### R-104 / auth-130: 2FA TOTP 認証 (debug API 未実装)
- **スキップ理由**: TOTP シークレット取得用 debug API (`/api/admin/debug/get-2fa-secret`) が未実装。現状 fail のまま維持。

#### R-121, R-126 / auth-280: INTERNAL_MANAGE_KEY
- **スキップ理由**: 環境変数 `INTERNAL_MANAGE_KEY` 未設定のため、正常系アクセスは未検証。

#### us-cert-080: 証明書発行上限超過エラーの確認 (2026-04-23 追加)
- **スキップ理由**: 上限超過 (certificates.length >= 3) を検証するには実際に 3 枚の証明書を発行する必要があるが、テスト環境の Lambda (cert generation) が未設定 or 応答が遅く、3 回発行完了後も UI の `.cert-alert-warn` / toastr が確認できない
- **調査経緯**: 2026-04-23 発行ボタン → 名前入力モーダル → 発行クリックを 3 回繰り返した後の 4 回目で上限超過確認を試みたが、bodyText に cert-alert-warn も "1ユーザーにつき最大3つまで" も現れず失敗
- **解消条件**: Lambda cert generation が test 環境で stable に動作 (または mock/stub される) + 発行完了から certificates list reload までの race condition 対策
- **現状**: test は fail のまま維持

#### srh-010〜060: OpenSearch グローバル検索 (2026-04-24 追加)
- **スキップ理由**: Playwright でモーダル (`.global-search-modal.show`) を開く動作が不安定。Playwright native click (force オプション含む)・JS `element.click()`・event dispatch いずれも Angular (click) ハンドラまで安定して到達できない。また、検索結果生成には `this.options` (サイドバーテーブル一覧) のロード完了が必要で、モーダル open 直後の検索はレース条件で 0 件になる
- **プロダクト側実装**: `html_angular4/src/app/layouts/full-layout.component.html:236` + `full-layout.component.ts:98` (handleSearchClick)
- **スキップ基準該当**: インフラ/Angular zone 依存（基準 2）
- **代替実装**: 5 spec 実装済 (tests/global-search.spec.js) 維持、修正待ち
- **解消条件**:
  - (a) `this.options` のロード完了を待つ debug helper 追加
  - (b) モーダル open を API 経由（または URL query）でトリガー可能にするプロダクト変更
  - (c) PHPUnit で OpenSearchService の検索ロジック検証
- **関連要件**: R-281/R-282/R-283/R-284/R-286 (OpenSearch グローバル検索)
- **記載日**: 2026-04-24
- **見直し予定**: プロダクト側 debug helper 追加後

#### exc-050, exc-070: Excel インポート AI 分析ステップ (2026-04-24 追加)
- **スキップ理由**: 「AIで分析する」ボタン押下後の GPT API 応答がタイムアウト（2.5 分超）。LLM の非決定的応答時間 + staging の PigeonAI quota で安定実行できない
- **プロダクト側実装**: `html_angular4/src/app/excel-import/excel-import.component.ts:startAnalysis` → `/api/admin/excel-import-analyze`
- **スキップ基準該当**: 外部 LLM 依存（基準 2）
- **代替実装**: exc-020/exc-030 は pass（ファイル種別バリデーション + アップロード→シート選択遷移）
- **解消条件**:
  - (a) debug API で AI 応答を mock 固定化
  - (b) タイムアウトを 5 分まで延長して flaky 許容
- **関連要件**: R-272/R-274
- **記載日**: 2026-04-24
- **見直し予定**: mock API 追加後

#### ms-030: アカウントロック解除 (20回 fail → account_locked → unlock) (2026-04-24 追加)
- **スキップ理由**: staging 環境 + VPN IP 経由のアクセスでは、`LoginController.php:140-141` の `skip_lock_check = !IS_PRODUCTION && NetCommon::isDebugIp()` 条件により **20 回ログイン失敗してもロック判定が常にスキップされる**。`Record.php:476-491` の `account_locked` 再計算も同条件で skip され、unlock ボタンが表示されない。
- **プロダクト側実装**: `Application/Controllers/LoginController.php:140`, `Application/Class/Record.php:476`
- **スキップ基準該当**: インフラ/IP 依存（基準 2）
- **代替実装**: ms-030 は「非ロック時に unlock ボタンが非表示であること」（UI 条件式の逆検証）のみカバー。実ロック→解除フローは未カバー。
- **解消条件**:
  - (a) 非 VPN IP（例: GitHub Actions Runner IP）からのテスト実行環境構築
  - (b) プロダクト側に debug API で `ignore_login_fail_flg=false` の login_fail ログを強制 INSERT できる機能追加
  - (c) PHPUnit でロック判定ロジックをカバー
- **関連要件**: R-265（アカウントロック解除 UI + API）
- **記載日**: 2026-04-24
- **見直し予定**: 上記いずれかの解消条件充足時

#### us-sso-saml-010: SAML 設定画面の項目確認 (2026-04-23 追加)
- **スキップ理由**: テスト環境で SAML 機能の Feature Flag が有効化されていないため、SAML 設定画面にアクセスしてもメニューに表示されないか、リダイレクトされる。
- **調査経緯**: 2026-04-23 gemcli 独立分析で `html_angular4/src/app/pages/sso-settings/sso-settings.component.html` にセレクター（`識別子`、`応答 URL`、`.fa-copy` 等）は正しく実装されていることを確認。fail は環境側 Feature Flag 未設定が原因
- **解消条件**: テスト環境の `admin_setting` or `cloud_setting` で SAML 機能を有効化する（debug API で切替可能になるまで待ち）
- **担当**: インフラ/プロダクト側の設定変更が必要
