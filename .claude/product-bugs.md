# プロダクトバグ・環境問題 記録

E2Eテスト実行中に発見されたプロダクトバグおよび環境問題。
テストコードは修正せず、ここに記録する。

---

## 環境問題（再実行で解消見込み）

### fields-2, fields-4: beforeAll タイムアウト (2026-03-27)

- **症状**: `beforeAll` hook timeout of 480000ms exceeded（agent-33実行時）
- **影響**: fields-2 全82件スキップ、fields-4 全10件スキップ
- **原因**: 並列実行時の環境負荷でALLテストテーブル作成API（create-all-type-table）が300秒以上かかった
- **判定**: 環境タイムアウト（並列実行の競合）
- **対応**: 再実行で解消見込み。必要であれば該当specを単独実行する

### auth, dashboard, users-permissions: ログインページ#idタイムアウト (2026-03-27)

- **症状**: `waitForSelector('#id')` Timeout 30000ms/60000ms exceeded（agent-31/35実行時）
- **影響**: auth 4件失敗、dashboard 2件失敗、users-permissions 6件失敗
- **原因**: agent-31/35の実行時にテスト環境のログインページが応答遅延
- **判定**: 環境タイムアウト（ネットワーク/サーバー一時的問題）— リーダー確認済み
- **対応**: 再実行で解消見込み

### users-permissions/155-1: data-ng-ready タイムアウト (2026-03-27)

- **症状**: `waitForSelector('body[data-ng-ready="true"]')` Timeout 15000ms
- **原因**: 同上（Angular描画がサーバー応答遅延で完了しなかった）
- **判定**: 環境タイムアウト
- **対応**: 再実行で解消見込み

### reports/205: テスト環境で帳票機能が無効 (2026-03-27)

- **症状**: テスト環境(tmptestai-xxx.pigeon-demo.com)で帳票ボタンが表示されない
- **原因**: `is_ledger_active` はdataset（テーブルメニュー設定）のフラグで、テスト環境作成時に無効のまま。debug/settingsのsetting/admin_settingテーブルには`is_ledger_active`カラムが存在しないためskipされる
- **影響**: reports/205, 206, 207 等の帳票テストが帳票ボタン不在で失敗
- **判定**: 環境セットアップの不足（debug APIの制約）
- **対応案**:
  1. `create-all-type-table` API で `is_ledger_active=true` を設定する
  2. debug APIに dataset テーブルのメニュー設定更新機能を追加

### chart-calendar/114-01〜04: カレンダービュー設定がdebug APIで直接更新できない (2026-03-27)

- **症状**: ensureCalendarViewでテーブル設定ページからカレンダー表示を有効化しようとするが、テーブル設定フォームの「セレクト_必須」フィールドのバリデーションエラーにより保存できない
- **原因**: テーブル設定ページ（`/admin/dataset/edit/{id}`）のフォームにはフィールドデータの必須バリデーションが含まれており、ALLテストテーブルの「セレクト_必須」フィールドに選択肢がないためvalidateが失敗する。debug APIにdataset直接更新機能がない
- **影響**: カレンダーテスト（114-01〜04）がbeforeAllで失敗
- **判定**: 環境セットアップの不足（debug APIの制約）
- **対応案**:
  1. `create-all-type-table` API にカレンダー設定（`is_calendar_view_enabled=true`, `calendar_view_datetime`）を含める
  2. debug APIに `/admin/debug/update-dataset` エンドポイントを追加し、dataset テーブルを直接更新可能にする
  3. ALLテストテーブル作成時に「セレクト_必須」フィールドのデフォルト選択肢を設定する

---

## Specバグ（修正済み）

### waitForAngular スコープ外定義バグ (2026-03-27) — 修正済み

- **症状**: `ReferenceError: waitForAngular is not defined`
- **影響**: layout-ui(40件), reports(22件), table-definition(238件), csv-export(10件), notifications, notifications-2, system-settings
- **原因**: `createLoginContext`, `setupSmtp`, テストブロック内に `waitForAngular` が誤って埋め込まれていた
- **修正**: commit b52ca0d — 全specのトップレベルに移動
- **修正後**: 再実行でこれらのエラーは解消される見込み

---

## Specバグ候補（修正推奨）

### auth/212-4: 全端末ログアウト — モーダル検出タイミング問題 (2026-03-27)

- **症状**: ログアウト後にログインページへリダイレクトされなかった（ダッシュボードに残留）
- **MCP Playwright 実機確認**: `contract_type=login_num` で `#logout` クリック → 「※全端末がログアウトされます。よろしいですか？」モーダルが **正常に表示** → 「はい」クリック → `/admin/login` へ**正常リダイレクト**
- **根本原因（Specバグ）**: テストコードの `hasAllDeviceLogout = modalText.includes('全端末')` で `modalText` を取得するタイミングが早い場合（`waitForAngular` 後でもモーダル表示前）に `false` になり `else` ブランチに落ちる。`else` ブランチでは `waitForURL` 10秒待機するが、モーダルが閉じられていないためリダイレクトが起きず失敗する。
- **判定**: Specバグ（タイミング問題）
- **対応**: `#logout` クリック後にモーダル表示を `waitForSelector('.modal.show')` で待ってから `innerText` を取得するよう修正

### auth/295: パスワード変更 — Angular フォームバインディング問題 (2026-03-27)

- **症状**: ユーザー管理ページにテストユーザーが表示されない（ユーザーが 4件のみ）
- **MCP Playwright 実機確認**: `/admin/admin/edit/new` フォームで `page.fill()` でパスワードと確認パスワードに同じ値を入力しても「確認パスワードが一致しませんでした」エラーが発生 → 登録ボタン押下でユーザー作成失敗
- **根本原因（Specバグ）**: Angular の `ngModel` バインディングが `fill()` の DOM 直接書き込みで変更検知されない。`page.fill()` → `dispatchEvent('input')` のトリガーが必要。テストコードは `page.fill('#id', EMAIL)` でパスワードを入れているが Angular の確認パスワード一致バリデーションが false のまま残る。
- **判定**: Specバグ（Angular バインディング対応不足）
- **対応**: パスワードフィールドへの入力後に `page.dispatchEvent` で `input` イベントをトリガーするか、`page.type()` を使用する。または `debug/create-user` API 経由（`password_changed` フラグ問題あり）

### users-permissions/60-3: sharedUserId が null (2026-03-27)

- **症状**: `expect(sharedUserId, 'ユーザーIDが取得できること').toBeTruthy()` が null で失敗
- **根本原因（Specバグ）**: 「アクセス許可IP設定」describe の `beforeAll` でユーザー作成に失敗した場合、`sharedUserId` が null のまま個別テストが実行される。フォールバックなし。
- **判定**: Specバグ（beforeAll 失敗時の guard 不足）
- **対応**: `beforeAll` 失敗時に `test.skip()` を呼ぶか、個別テスト冒頭で `if (!sharedUserId) { test.skip() }` を追加

### users-permissions/61-4: ishikawa+99 ユーザー不在 (2026-03-27)

- **症状**: `expect(found, 'テストユーザー(ishikawa+99)がユーザー一覧に存在すること').toBeTruthy()` が undefined
- **根本原因（Specバグ）**: `testUserId` が null の場合に API でユーザー一覧を検索するが `ishikawa+99` が前のテストで削除されていた（またはそもそも作成されていない）
- **判定**: Specバグ（テストユーザーのライフサイクル管理不足）
- **対応**: beforeAll でユーザー作成を確実化するか、見つからない場合は `test.skip()` へフォールバック

---

## プロダクトバグ候補（調査中）

### workflow/21-1: ワークフロー設定が保存されないこと (2026-03-27) — 環境問題として解決

- **症状**: `toBeTruthy() received: false` — ワークフロー有効チェックで false
- **期待値**: ワークフロー承認者はデータ編集可能設定が保存されること
- **実際**: beforeAll タイムアウト → 全62件スキップ
- **判定**: **環境問題・製品バグではない**
- **根本原因**: fix-workflow エージェント（aa2160eeaf73e4740）が確認:
  - 第2回テスト環境 `tmptestai2026032701205932.pigeon-demo.com` が削除済み
  - アクセスすると `ai-test.pigeon-demo.com` にリダイレクト
  - `ai-test.pigeon-demo.com` 上で `/admin/dataset/edit/new` が既存テーブル(2815)にリダイレクト
  - これで `createWorkflowTestTable` がタイムアウト
- **MCP Playwright 実機確認**: `dataset-workflow-options` の `label.switch` クリックで `checked: true` に正常遷移 → UI・機能は正常動作
- **対応**: 有効なテスト環境で再実行すれば解消見込み

### templates/TMPL-01〜12: テンプレートモーダルが開かない (2026-03-27)

- **症状**: `toBeTruthy() received: false` — 全12件
- **期待値**: テンプレート一覧モーダルが表示されること
- **実際**: モーダルが開かない（またはセレクターが合っていない）
- **判定**: 調査中（fix-templates エージェントがMCP Playwrightで確認中）
- **対応**: エージェント報告後に判断

---

---

## チェックくん第2回振り分け (2026-03-27 22:00)

### 環境依存（再実行で解消見込み）

#### dashboard/DB-02: flakyテスト
- **症状**: retry#1でpass
- **判定**: 環境依存（flaky）

#### notifications/54-1: beforeAllタイムアウト（360秒）
- **症状**: setupAllTypeTable のbeforeAllが360秒超過
- **判定**: 環境依存（テスト環境負荷）

#### system-settings/10-1: beforeAllタイムアウト（360秒）
- **症状**: beforeAll hook timeout 360000ms exceeded
- **判定**: 環境依存（テスト環境負荷）

#### users-permissions/ユーザー管理: beforeAllタイムアウト（120秒）
- **症状**: beforeAll で debug/settings API 呼び出しが120秒超過
- **判定**: 環境依存（テスト環境負荷）

#### users-permissions/155-1, 155-2: beforeAllタイムアウト（360秒）
- **症状**: beforeAll hook timeout 360000ms exceeded
- **判定**: 環境依存（テスト環境負荷）

#### users-permissions/60-3: flakyテスト（agent-30）
- **症状**: agent-30ではflaky（retry#1 pass）、agent-31ではsharedUserId=null
- **判定**: 環境依存/Specバグ（beforeAll失敗時のguard不足、既に記録済み）

#### users-permissions/61-3: テストタイムアウト（30秒）
- **症状**: Test timeout of 30000ms exceeded
- **判定**: 環境依存（テストユーザーログインが遅い）

#### fields/101-2, fields/113-04: flakyテスト
- **症状**: retry#1でpass
- **判定**: 環境依存（flaky、一時的なページ描画遅延）

#### uncategorized-2/507, 517, 518, 531, 539: テーブル描画タイムアウト
- **症状**: checkPage内でテーブルのthead th描画が30秒以内に完了せず
- **判定**: 環境依存（テスト環境のALLテストテーブル描画負荷）

### Specバグ（修正が必要）

#### layout-ui/127-01: Ctrl+Spaceテーブル検索
- **症状**: Test timeout of 120000ms exceeded
- **根本原因**: ソースコードにCtrl+Spaceのキーバインドが存在しない（HostListenerは escape/shift/ctrl+shift+l/ctrl+shift+j のみ）。テストケース仕様の前提が誤っている可能性
- **判定**: Specバグ — テスト対象機能が存在しない
- **対応**: 機能の実装有無を確認。未実装ならテストをskipに変更

#### layout-ui/215-1, 215-2: テーブルアイコン画像アップロード/削除
- **症状**: 215-1: `img[src*="icon_image"]` がhidden、215-2: 削除ボタンが見つからない
- **根本原因**: ソースコード（dataset-menu-options.component.html）では `<admin-forms-field field_name="'icon_image_url'">` というAngularコンポーネントを使用。specは `img` タグや通常の削除ボタンを直接探しているが、admin-forms-fieldコンポーネント内のDOM構造に合っていない
- **判定**: Specバグ — セレクターがAngularコンポーネントのDOM構造に非対応
- **対応**: admin-forms-fieldのレンダリング結果のDOM構造をMCP Playwrightで調査し、正しいセレクターに修正

#### reports/205: 帳票Excel出力
- **症状**: 帳票ボタンのドロップダウンが開かない
- **根本原因**: テスト環境に帳票が未登録。帳票登録をsetupで行わずにドロップダウン操作を試みている
- **判定**: Specバグ — テストデータ前提条件不足
- **対応**: beforeAllまたはテスト冒頭で帳票テンプレートを登録してからExcel出力をテスト

#### table-definition/98-1, 98-2: CSVアップロード{NOCHANGE}
- **症状**: `a.dropdown-item:has-text("CSVアップロード")` が見つからない
- **根本原因**: ソースコードでCSVアップロードメニューは `*ngIf="grant.csv_upload"` で権限制御。テスト環境のALLテストテーブルでCSVアップロード権限が付与されていない
- **判定**: Specバグ — テスト環境の権限設定不足
- **対応**: setupでCSVアップロード権限を有効化するか、テーブル設定APIで権限を付与してからテスト

#### table-definition/ARC-01: テーブルアーカイブ
- **症状**: `body[data-ng-ready="true"]` のwaitForSelector 15秒タイムアウト
- **根本原因**: waitForAngularが`body[data-ng-ready="true"]`のvisible状態を待機するが、bodyのdata-ng-ready属性がhidden状態で解決しない
- **判定**: Specバグ — waitForAngularのタイムアウト処理が不適切
- **対応**: waitForAngularのフォールバック処理を改善、またはARC-01固有のwait処理を追加

#### table-definition/AUTOID-01, AUTOID-02: 自動採番リセット
- **症状**: 自動採番リセットUIが全タブで見つからない
- **根本原因**: ソースコードでは自動採番リセットボタン（「カウンターをリセット」）はフィールド個別設定画面 `dataset-field-one.component.html` にあり、テーブル設定の「その他」タブではない。specはテーブル設定タブを探しているが、正しくはフィールド一覧から自動採番フィールドの設定画面に遷移する必要がある
- **判定**: Specバグ — テスト対象UIの場所を誤認
- **対応**: テーブル設定ではなく、フィールド設定画面（`/admin/dataset/edit/{tableId}` のフィールドリストから自動採番フィールドの設定ボタンクリック）でリセットUIを確認する

#### users-permissions/61-4: ishikawa+99ユーザー不在
- **症状**: テストユーザーが一覧に存在しない（既に記録済み）
- **判定**: Specバグ — テストユーザーライフサイクル管理不足

#### chart-calendar/105-02: チャートオプション「過去分も全て加算」
- **症状**: 4秒で失敗
- **根本原因**: テスト環境のALLテストテーブルで「チャート」または「集計」ドロップダウンメニューが表示されない。ソースコードでは `*ngIf="grant.summarize"` で制御されており、権限不足でメニュー非表示
- **判定**: Specバグ — テスト環境の権限設定不足
- **対応**: setupでsummarize権限を有効化

#### chart-calendar/114-01: カレンダー週表示
- **症状**: beforeAll(ensureCalendarView)で失敗、0msで即テスト失敗
- **根本原因**: ビュー追加UIで「ビュー」追加ボタンのクリック先が間違っており、既存ビューの設定モーダル（「ビュー×項目並び順行に色を付ける...」）が開いてしまう。カレンダー選択肢がモーダルに存在しない
- **判定**: Specバグ — ビュー追加ボタンのセレクターが不正確
- **対応**: ensureCalendarViewのビュー追加ボタンセレクターをMCP Playwrightで調査し修正

#### chart-calendar/15-1, 15-2, 65-1: 集計系テスト
- **症状**: 4-5秒で失敗
- **根本原因**: chart-calendar/105-02と同じ — ドロップダウンメニューの「集計」が `grant.summarize` 権限不足で非表示
- **判定**: Specバグ — テスト環境の権限設定不足
- **対応**: setupでsummarize権限を有効化

#### csv-export/55-1: ヘッダー行なしCSVアップロード
- **症状**: 3分間タイムアウト
- **根本原因**: CSVアップロード処理がハングしている可能性。または98-1/98-2と同様にCSVアップロードメニューが権限不足で表示されない
- **判定**: Specバグ — CSVアップロードUIへのアクセス失敗
- **対応**: 権限確認と、タイムアウト処理の改善

#### csv-export/JSON-02, JSON-03: JSONエクスポート
- **症状**: `.modal.show` が見つからない（13秒で失敗）
- **根本原因**: ソースコード（admin.component.html）ではJSONエクスポートモーダルは `.custom-modal` クラスで実装されており、Bootstrap標準の `.modal.show` ではない。specは `.modal.show` を探している
- **判定**: Specバグ — セレクターがカスタムモーダルに非対応
- **対応**: `.modal.show` を `.custom-modal.show` に変更

#### fields/220: フィールドテスト
- **症状**: ログに実行記録なし — beforeAllの失敗でスキップされた可能性
- **判定**: 環境依存（beforeAll失敗の連鎖）
- **対応**: 再実行で解消見込み

## 記録更新履歴

- 2026-03-27: 初版作成
- 2026-03-27: workflow/21-1 を「環境問題・製品バグではない」に更新（fix-workflow エージェント確認 + MCP Playwright 実機確認）
- 2026-03-27: auth/212-4（Specバグ・タイミング問題）、auth/295（Specバグ・Angularバインディング）、users-permissions/60-3・61-4（Specバグ）を追記
- 2026-03-27: users-permissions/155-1（環境タイムアウト）を追記
- 2026-03-27: チェックくん第2回振り分け（33件）を追記
