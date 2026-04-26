# Setting カラム × E2E カバー マトリクス (生成日: 2026-04-26、更新: 2026-04-26)

## サマリー

- setting カラム数: 50 (うち debug-tools 編集可能: 33)
- admin_setting カラム数: 約40 (うち debug-tools 編集可能: 29)
- E2E カバー済み (1件以上のヒット): **44 カラム** (前回 30 → +14)
- ギャップ (E2E 抜け): **18 カラム** (前回 32 → -14)

## 進捗 (2026-04-26 PR1〜PR2 で改善)

| PR | 対象 | 件数 |
|---|---|---|
| #23 | UP-B003: allow_ip_addresses (全体IP+個別IP+複合) | 6 テスト |
| #24 | SS-B001/B002: is_maintenance / enable_api / allow_only_secure_access | 3 件 (5 テスト) |
| #26 | SS-B003: contract_type / enable_filesearch / use_analytics_ai / enable_rpa / action_limit_*2 / scrollable / use_comma / not_close_toastr_auto / lock_timeout_min / ignore_csv_noexist_header | 11 件 (11 テスト) |
| **合計** | | **20 件 / 22 テスト追加** |

## setting テーブル

| # | カラム名 | 型 | 編集 API | 読み出し場所 (enforcement / behavior 変化) | E2E カバー (spec.js) | ギャップ判定 |
|---|---|---|---|---|---|---|
| 1 | allow_ip_addresses | string | debug/settings | public/api/index.php:443 (IP制限チェック) | UP-B003 (users-permissions.spec.js) | ✅ カバー済み |
| 2 | allow_only_secure_access | bool | debug/settings | routes/login/admin/login.php:112 (クライアント証明書強制) | SS-B002 sec-010 (CRUD only, mTLS staging 不可) | ✅ カバー済み (CRUD) |
| 3 | enable_api | bool | debug/settings | routes/public/api.php:346 (APIアクセス制限) | SS-B001 api-010/020/030 | ✅ カバー済み (enforcement) |
| 4 | is_maintenance | bool | debug/settings | routes/public/api.php:338 (メンテナンス遮断) | SS-B001 maint-010 | ✅ カバー済み (enforcement) |
| 5 | contract_type | string | debug/settings | Setting.php (契約種別判定) | SS-B003 ct-010 | ✅ カバー済み (CRUD) |
| 6 | max_user | int | debug/settings | Setting.php (ユーザー数上限) | master-settings.spec.js:12 | ✅ カバー済み |
| 7 | max_table_num | int | debug/settings | Setting.php (テーブル数上限) | table-definition.spec.js:6 | ✅ カバー済み |
| 8 | enable_filesearch | bool | debug/settings | VectorIndexService.php:174 (AIファイル検索) | SS-B003 fs-010 | ✅ カバー済み (CRUD) |
| 9 | enable_rpa | bool | debug/settings | Setting.php (Connect機能) | SS-B003 rpa-010 | ✅ カバー済み (CRUD) |
| 10 | use_analytics_ai | bool | debug/settings | Setting.php (AI分析機能) | SS-B003 aa-010 | ✅ カバー済み (CRUD) |
| 11 | use_login_id | bool | debug/settings | Setting.php (ログインID使用) | (なし) | 🟡 ギャップ (中) |
| 12 | workflow_status_edit_by_csv | bool | debug/settings | Setting.php (CSVワークフロー編集) | workflow.spec.js:1 | ✅ カバー済み |
| 13 | action_limit_per_min | int | debug/settings | Setting.php (APIレート制限) | SS-B003 rl-010 | ✅ カバー済み (CRUD) |
| 13b | action_limit_per_15min | int | debug/settings | Setting.php (APIレート制限15分) | SS-B003 rl-020 | ✅ カバー済み (CRUD) |
| 14 | mail_option | bool | debug/settings | Setting.php (メール配信) | mail-delivery.spec.js:2 | ✅ カバー済み |
| 15 | step_mail_option | bool | debug/settings | Setting.php (ステップメール) | mail-delivery.spec.js:2 | ✅ カバー済み |
| 16 | max_upload_mb | int | debug/settings | Setting.php (アップロード制限) | (なし) | 🟡 ギャップ (中) |
| 17 | title | string | debug/settings | Setting.php (テナント名) | dashboard.spec.js 他多数 | ✅ カバー済み |
| 18 | max_client_secure_user_num | int | debug/settings | Setting.php (証明書ユーザー数上限) | user-security.spec.js:5 | ✅ カバー済み |

## admin_setting テーブル

| # | カラム名 | 型 | 編集 API | 読み出し場所 (enforcement / behavior 変化) | E2E カバー (spec.js) | ギャップ判定 |
|---|---|---|---|---|---|---|
| 1 | setTwoFactor | bool | debug/settings | LoginController.php:219 (2FA) | auth.spec.js, system-settings.spec.js | ✅ カバー済み |
| 2 | setTermsAndConditions | bool | debug/settings | admin.php:1233 (規約同意) | system-settings.spec.js:15 | ✅ カバー済み |
| 3 | use_smtp | bool | debug/settings | EmailSmtp.php (SMTP配信) | mail-delivery.spec.js, notifications.spec.js | ✅ カバー済み |
| 4 | google_saml_enabled | bool | debug/settings | SsoSettingController.php (SSO) | auth.spec.js, debug-settings.js | ✅ カバー済み |
| 5 | azure_saml_enabled | bool | debug/settings | SsoSettingController.php (SSO) | auth.spec.js | ✅ カバー済み |
| 6 | prevent_password_reuse | bool | debug/settings | LoginController.php:308 (PW使いまわし) | user-security.spec.js:7 | ✅ カバー済み |
| 7 | pw_change_interval_days | int | debug/settings | (PW変更間隔) | user-security.spec.js:7 | ✅ カバー済み |
| 8 | ignore_new_pw_input | bool | debug/settings | (PW入力スキップ) | user-security.spec.js:9 | ✅ カバー済み |
| 9 | lock_timeout_min | int | debug/settings | (レコードロック) | SS-B003 lk-010 | ✅ カバー済み (CRUD) |
| 10 | scrollable | bool | debug/settings | (UI: テーブルスクロール) | SS-B003 ui-010 | ✅ カバー済み (CRUD) |
| 11 | use_comma | bool | debug/settings | Form.php:236 (三桁区切り) | SS-B003 ui-020 | ✅ カバー済み (CRUD) |
| 12 | not_close_toastr_auto | bool | debug/settings | (UI: Toastr自動閉じ) | SS-B003 ui-030 | ✅ カバー済み (CRUD) |
| 13 | ignore_csv_noexist_header | bool | debug/settings | CsvHandleAction.php:1223 | SS-B003 csv-010 | ✅ カバー済み (CRUD) |

## ギャップ一覧 (E2E 抜け = 要対応)

🔴 高優先度 (本番で動作変化が大きい / セキュリティ影響):
- **is_maintenance**: メンテナンスモードを有効にした際、全アクセスが503で遮断されることの検証が抜けている。
- **enable_api**: APIオプションを無効にした際、`/api/*` へのアクセスが拒否されることの検証が抜けている。
- **allow_only_secure_access**: クライアント証明書のないアクセスを拒否する設定だが、E2Eでの検証が皆無。

🟡 中優先度 (動作変化があるが影響限定):
- **contract_type**: `user_num` と `login_num` でAI使用回数制限などのロジックが変わるが、E2Eでの切り替えテストがない。
- **enable_filesearch / use_analytics_ai / enable_rpa**: 各種高機能オプションの有効/無効によるUI・機能の出し分けが検証されていない。
- **action_limit_per_min / action_limit_per_15min**: APIのレート制限が意図通り動作するかのテストが不十分。
- **scrollable / use_comma / not_close_toastr_auto**: UIに関する挙動設定がE2Eで担保されていない。

🟢 低優先度 (テスト不要 or 既に PHPUnit でカバー):
- **license_id**: 内部的なID保持のみのため。
- **add_size**: ストレージ容量制限はファイルアップロード時のバリデーション等で PHPUnit でのカバーが望ましい。

## 生成方法 (再現可能性)

実行コマンド: `rg -w "<column_name>" /Users/yasaipopo/PycharmProjects/pigeon-test/tests/ --type js`
ベース commit: (不明)
