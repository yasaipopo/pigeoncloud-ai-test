# PigeonCloud テストエージェント 指示書

このDockerコンテナはPigeonCloudのQAテストを自律的に実行するClaudeエージェントです。
以下の指示に従って作業してください。

---

## あなたの役割

### モードA: spec.js生成モード（メイン作業）
1. **`specs/*.yaml`（グループ単位のテストケース一覧）を読む**
2. **Playwrightでブラウザを実際に操作**してテスト対象ページを確認
3. **`tests/*.spec.js` を生成・更新**する（1グループ = 1 spec.jsファイル）
4. **`npx playwright test` で spec.js を実行**して動作確認
5. 失敗したらブラウザで確認・spec.jsを修正する

### モードB: 定期テスト実行モード
1. **Google Sheetsからテストシナリオを取得**してYAMLに変換
2. **`npx playwright test` で全spec.jsを実行**
3. **失敗を調査**して、仕様変更か不具合かを判断
4. **テスト結果をGoogle Sheetsに書き戻す**
5. **Slack通知**する

---

## 環境情報

| 変数 | 内容 |
|---|---|
| `ADMIN_BASE_URL` | 管理用URL（テスト環境作成元）例: https://ai-test.pigeon-demo.com |
| `ADMIN_EMAIL` | 管理用ログインID（admin） |
| `ADMIN_PASSWORD` | 管理用パスワード |
| `TEST_BASE_URL` | テスト実行対象URL（起動時に自動生成・上書きされる） |
| `TEST_EMAIL` | テスト環境ログインID（作成後に設定） |
| `TEST_PASSWORD` | テスト環境パスワード（作成後に自動取得） |
| `AGENT_NUM` | エージェント番号（並列実行時に識別、1/2/3...） |
| `ANTHROPIC_API_KEY` | Claude API キー |
| `SLACK_WEBHOOK_URL` | Slack通知用WebhookURL |
| `SLACK_NOTIFY_USER_ID` | 通知先SlackユーザーID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google認証ファイルパス（/app/secrets/service_account.json） |
| `SPREADSHEET_ID` | テストシート ID（1h_gwuCGUAdj5fKPRZu438TKFkFkYUNUKz2K_vtEFlmI） |
| `PIGEON_SOURCE_PATH` | ソースコードパス（/app/src/pigeon_cloud） |

---

## テスト環境の自動作成

各エージェントは起動時に **自分専用のテスト環境を作成**してからテストを行う。

### 作成ページ
```
https://ai-test.pigeon-demo.com/admin/internal/create-client
```

### ドメイン命名規則
```
tmp-testai-{YmdHis}-{AGENT_NUM}
例: tmp-testai-20260309120000-1
```

### 作成手順（Playwrightで自動実行）
1. `ADMIN_BASE_URL` でログイン（ADMIN_EMAIL / ADMIN_PASSWORD）
2. `/admin/internal/create-client` にアクセス
3. クライアントドメイン欄に `tmp-testai-{YmdHis}-{AGENT_NUM}` を入力
4. ログインID欄に `admin` を入力
5. 「作成完了」ボタンをクリック
6. 表示された URL と PASSWORD を取得
7. `TEST_BASE_URL` と `TEST_PASSWORD` を環境変数として設定してテスト実行

### 作成後のテスト環境
- URL: `https://tmp-testai-{YmdHis}-{AGENT_NUM}.pigeon-demo.com`
- ID: `admin`
- PASSWORD: 自動生成（作成完了画面から取得）

### 注意
- テスト完了後に環境を削除する必要はない（使い捨て）
- 環境作成に失敗したら Slack通知して終了する

---

## ディレクトリ構成

```
/app/
├── CLAUDE.md                  ← この指示書
├── run_agent.sh               ← エントリーポイント（通常はこれが自動実行）
├── agent_instructions.md      ← 調査時の補足指示
├── runner/
│   ├── test_runner.py         ← YAMLを読んでPlaywrightテスト実行
│   ├── sheets_sync.py         ← Google Sheets同期
│   └── reporter.py            ← Slack通知
├── scenarios/                 ← YAMLシナリオ（Sheetsから生成・gitignore）
├── reports/                   ← テスト結果・スクリーンショット（gitignore）
├── secrets/
│   └── service_account.json  ← Google認証（gitignore）
└── src/
    └── pigeon_cloud/          ← PigeonCloudソースコード（gitignore・read-only）
```

---

## Google Sheets構成

スプレッドシート名: **ピジョンクラウド_テストケース一覧 v2 AI**
URL: https://docs.google.com/spreadsheets/d/1h_gwuCGUAdj5fKPRZu438TKFkFkYUNUKz2K_vtEFlmI

### シートA: (佐藤)テスト区分A_テスト仕様書2
- ヘッダー: **1行目**
- E列: テストケースNo / F列: 機能名 / G列: カテゴリ
- H列: 手順 / I列: 予想結果
- J列以降: チェック結果（右に追加していく）

### シートB: (邊見)テスト区分B_テスト仕様書
- ヘッダー: **4行目**（1〜3行目はタイトル等）
- E列: テストケースNo / F列: 機能名 / G列: カテゴリ
- H列: 手順 / I列: 予想結果
- J列以降: 実施日/結果ペア（右に追加していく）
- 末尾固定列: テスト実施者・備考・再テストフラグ・修正・再テスト完了フラグ

### チェック結果の書き込みルール
- **毎回必ず右端に新しい列として追加**する（既存の結果は絶対に上書きしない）
- シートA: 列ヘッダー = `チェック結果(YYYY/M)`（例: チェック結果(2026/3)）
- シートB: `実施日` + `結果` のペアで追加（テスト実施者列の手前に挿入）
- 結果値: `OK`（テスト通過）/ `NG`（失敗）

---

## ディレクトリ構成（追加分）

```
/app/
├── specs/                     ← グループ単位のテストケース一覧YAML（git管理）
│   ├── auth.yaml              ← 認証テスト（14件）
│   ├── table-definition.yaml  ← テーブル定義（194件）
│   ├── fields.yaml            ← フィールド（365件）
│   ├── records.yaml           ← レコード操作（12件）
│   ├── layout-ui.yaml         ← レイアウト・UI（33件）
│   ├── chart-calendar.yaml    ← チャート・カレンダー（75件）
│   ├── filters.yaml           ← フィルタ（2件）
│   ├── csv-export.yaml        ← CSV・インポート（16件）
│   ├── users-permissions.yaml ← ユーザー・権限（106件）
│   ├── notifications.yaml     ← 通知・メール（99件）
│   ├── workflow.yaml          ← ワークフロー（69件）
│   ├── reports.yaml           ← 帳票（11件）
│   ├── system-settings.yaml   ← システム設定（55件）
│   ├── public-form.yaml       ← 公開フォーム（2件）
│   ├── comments-logs.yaml     ← コメント・ログ（13件）
│   └── uncategorized.yaml     ← 未分類（580件）
├── tests/                     ← Playwright spec.js（Claudeが生成・git管理）
│   ├── auth.spec.js
│   ├── table-definition.spec.js
│   └── ...
└── playwright.config.js       ← Playwright設定
```

---

## spec.js 生成の作業手順

### Step 1: specs/XXXXX.yaml を読む
```bash
cat specs/auth.yaml
```
`cases` の各テストケースを把握する（case_no, description, expected）

### Step 2: ブラウザで実際に操作して確認
Playwrightを使って実際にページを開き、セレクターやURLを確認する：
```python
from playwright.sync_api import sync_playwright
import os

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    page = browser.new_page()
    page.set_viewport_size({"width": 1280, "height": 800})
    # ログイン
    page.goto(os.environ["TEST_BASE_URL"] + "/admin/login")
    page.fill("#id", os.environ["TEST_EMAIL"])
    page.fill("#password", os.environ["TEST_PASSWORD"])
    page.click("button[type=submit].btn-primary")
    page.wait_for_selector(".navbar")
    # 調査したいページへ
    page.goto(os.environ["TEST_BASE_URL"] + "/admin/dashboard")
    page.screenshot(path="reports/investigation.png", full_page=True)
    browser.close()
```

### Step 3: tests/XXXXX.spec.js を生成
確認したセレクターを元に spec.js を書く：
```javascript
// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

async function login(page) {
    await page.goto(BASE_URL + '/admin/login');
    await page.fill('#id', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit].btn-primary');
    await page.waitForSelector('.navbar');
}

test.describe('認証', () => {
    test('1-1: マスターユーザーでログイン・ログアウト', async ({ page }) => {
        await login(page);
        await expect(page).toHaveURL(/\/admin\/dashboard/);
        // ログアウト
        await page.click('...');
        await expect(page).toHaveURL(/\/admin\/login/);
    });
});
```

### Step 4: 実行して確認
```bash
npx playwright test tests/auth.spec.js --reporter=list
```

---

## 実行フロー

### 通常実行（run_agent.sh が自動実行）

```bash
# 1. PigeonCloudソースを最新化（read-only pull）
# 2. Google Sheets → YAMLシナリオ同期
python runner/sheets_sync.py --pull

# 3. Playwrightテスト実行
python runner/test_runner.py
# → reports/results.json に結果が保存される

# 4. 失敗があればClaudeが調査（後述）

# 5. テスト結果をSheetsに書き戻し（右端に新列追加）
python runner/sheets_sync.py --push

# 6. Slack通知
python runner/reporter.py
```

### 手動でコマンドを実行する場合

```bash
# シート構成確認
python runner/sheets_sync.py --inspect

# Sheetsからシナリオ取得
python runner/sheets_sync.py --pull

# テスト実行
python runner/test_runner.py

# 結果をSheetsに書き戻し
python runner/sheets_sync.py --push

# ClaudeがYAMLを追加・更新した場合、Sheetsにも反映
python runner/sheets_sync.py --push-scenarios

# Slack通知
python runner/reporter.py
```

---

## テスト失敗時の調査手順

### Step 1: 結果確認

```bash
cat reports/results.json
```

失敗した各テストについて `errors` と `screenshot` を確認する。

### Step 2: スクリーンショットを見る

`reports/screenshot_*.png` をVisionで確認し、画面の状態を把握する。

### Step 3: Playwrightで実際に操作して確認

```python
from playwright.sync_api import sync_playwright
import os

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    page = browser.new_page()
    page.set_viewport_size({"width": 1280, "height": 800})
    page.goto(os.environ["TEST_BASE_URL"] + "/admin/login")
    # ...調査したい操作...
    page.screenshot(path="reports/investigation.png", full_page=True)
    browser.close()
```

### Step 4: ソースコードで仕様確認

`/app/src/pigeon_cloud/` にステージングと同じブランチのソースコードがある。
Angularのテンプレート: `html_angular4/src/app/`
PHPバックエンド: `Application/`

不具合か仕様変更かを確認する際にソースコードを参照する。

---

## 判断基準

### 仕様変更（YAMLを更新）

以下の場合は仕様変更と判断し、該当の `scenarios/*.yaml` を修正する：

- HTMLのselectorが変わった（id/class名の変更）
- URLのパスが変わった
- テキスト・ボタンの文言が変わった
- UIレイアウトが変わったが機能は正常
- 手順の順序が変わった

対応:
1. `scenarios/*.yaml` の steps/assertions を修正
2. `python runner/sheets_sync.py --push-scenarios` でSheetsにも反映

### 不具合（Slack通知）

以下の場合は不具合と判断し、Slack通知する：

- 500エラー・エラーページが表示されている
- ログインできない
- データが保存・取得できない
- レイアウトが大きく崩れている
- 本来表示されるべき要素が消えている
- 日本語文字化け
- 機能自体が動作しない

対応:
1. `reports/claude_report.md` に詳細を記録
2. `python runner/reporter.py` でSlack通知

---

## YAMLシナリオの形式

```yaml
name: シナリオ名
sheet: A          # A or B
case_no: "1-1"    # テストケースNo
feature: ログイン  # 機能名
category: '-'     # カテゴリ
description: |    # 手順（Sheetsから取得）
  ユーザータイプが「マスター」のユーザーでログイン
expected: |       # 予想結果
  エラーなくログインが完了すること
_sheet_row: 2     # Sheets上の行番号（書き戻し用・変更禁止）
_sheet_gid: 46306531  # シートGID（変更禁止）
steps:
  - action: navigate
    value: /admin/login
  - action: fill
    selector: "#id"
    value: "{{ TEST_EMAIL }}"
  - action: fill
    selector: "#password"
    value: "{{ TEST_PASSWORD }}"
  - action: click
    selector: "button[type=submit].btn-primary"
  - action: wait_for
    selector: ".navbar"
assertions:
  - type: url_contains
    value: /admin/dashboard
  - type: element_visible
    selector: "nav"
screenshot: true
```

### 利用可能なaction

| action | 説明 | 必須パラメータ |
|---|---|---|
| `navigate` | URLに遷移 | `value`: パス or URL |
| `fill` | テキスト入力 | `selector`, `value` |
| `click` | クリック | `selector` |
| `wait_for` | 要素が現れるまで待機 | `selector` |
| `wait` | 秒数待機 | `value`: 秒数 |
| `select` | ドロップダウン選択 | `selector`, `value` |
| `comment` | コメント（スキップ） | `value` |

`{{ TEST_EMAIL }}`, `{{ TEST_PASSWORD }}` は環境変数に自動展開される。

### 利用可能なassertion type

| type | 説明 | パラメータ |
|---|---|---|
| `url_contains` | URLに文字列が含まれる | `value` |
| `element_visible` | 要素が表示されている | `selector` |
| `element_not_visible` | 要素が非表示 | `selector` |
| `text_contains` | 要素のテキストを確認 | `selector`, `value` |
| `title_contains` | ページタイトルを確認 | `value` |
| `comment` | コメント（スキップ） | `value` |

---

## ログイン情報

- ログインURL: `{TEST_BASE_URL}/admin/login`
- IDフィールド: `#id`
- パスワードフィールド: `#password`
- ログインボタン: `button[type=submit].btn-primary`
- ログイン後リダイレクト: `/admin/dashboard`

---

## Slack通知の送り方

```bash
# reporter.py経由（推奨）
python runner/reporter.py

# 直接curlで緊急通知
curl -s -X POST -H 'Content-type: application/json' \
  --data "{\"text\":\"<@${SLACK_NOTIFY_USER_ID}> 【PigeonCloud】メッセージ\"}" \
  "${SLACK_WEBHOOK_URL}"
```

---

## テスト環境とソースコードについて

- **テスト対象URL**: `https://ai-test.pigeon-demo.com`（テスト専用テナント）
- **ソースコード**: `/app/src/pigeon_cloud/` はstagingブランチの最新コードと同期
  - Angularフロントエンド: `html_angular4/src/app/`
  - PHPバックエンド: `Application/`
- **仕様確認はstagingのソースコードを参照**（テスト環境はstagingと同じコード）
- `pigeon-demo.com` はテスト環境。`pigeon-dev.com` は開発環境

---

## Debug Tools（テストデータ準備に活用）

テスト環境専用のデバッグAPI（`/admin/debug/*`）を積極的に活用すること。

### APIエンドポイント一覧

| エンドポイント | メソッド | 用途 |
|---|---|---|
| `/admin/debug/status` | GET | 環境ステータス確認（テーブル数・テストユーザー数） |
| `/admin/debug/create-all-type-table` | POST | 全フィールドタイプ網羅のテストテーブル作成 |
| `/admin/debug/create-all-type-data` | POST | テストデータ投入（count: 件数, pattern: random/max/min/fixed） |
| `/admin/debug/delete-all-type-tables` | POST | ALLテスト系テーブル全削除 |
| `/admin/debug/create-user` | POST | テストユーザー作成（ishikawa+N@loftal.jp / password: admin） |
| `/admin/debug/reset-all` | POST | 全DB・ユーザーリセット（使用は慎重に） |

### YAMLでのsetup/teardown活用例

```yaml
name: レコード一覧表示テスト
setup:
  - action: api_post
    path: /admin/debug/create-all-type-table
  - action: api_post
    path: /admin/debug/create-all-type-data
    body:
      count: 5
      pattern: fixed
teardown:
  - action: api_post
    path: /admin/debug/delete-all-type-tables
steps:
  - action: login
  - action: navigate
    value: /admin/dataset
  ...
```

### ポイント
- **setup** はテスト前にAPIを叩いてデータ準備（自動でログインしてから実行）
- **teardown** はテスト後のクリーンアップ（失敗しても無視される）
- **ALLテストテーブル** は全フィールドタイプ（テキスト・数値・日付・選択・チェック等）を網羅
- レコード操作・フィールド設定・表示系テストには必ずsetupでテーブル作成してから行う
- テストユーザーが必要な場合は `api_post /admin/debug/create-user` で作成

### 利用可能な追加action

| action | 説明 | パラメータ |
|---|---|---|
| `login` | ログインショートカット | `email`/`password`（省略時は環境変数使用） |
| `api_post` | APIのPOST呼び出し | `path`: APIパス、`body`: リクエストボディ |
| `api_get` | APIのGET呼び出し | `path`: APIパス |

---

## 重要な注意事項

- **`_sheet_row` と `_sheet_gid` は変更禁止**（Sheetsへの書き戻しに使用）
- **Sheetsへの結果書き込みは必ず右端の新しい列に追加**（既存列は上書きしない）
- **ソースコード（/app/src/pigeon_cloud/）は読み取り専用**（変更禁止）
- **テスト対象はai-test.pigeon-demo.comのテスト専用テナントのみ**
- git操作はpullのみ可能（pushは権限なし）
- `reports/` への書き込みは自由（スクリーンショット、レポート等）
- `scenarios/` への書き込みは自由（シナリオの追加・更新）
