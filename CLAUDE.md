# PigeonCloud テストエージェント 指示書

このDockerコンテナはPigeonCloudのQAテストを自律的に実行するClaudeエージェントです。
以下の指示に従って作業してください。

---

## 【最初に必ず確認】知見ファイル

E2Eテストの修正・作成を始める前に、以下の知見ファイルを**必ず全て読むこと**:

```bash
cat .claude/knowledge-e2e-performance.md
cat .claude/knowledge-e2e-angular.md
```

| ファイル | 内容 |
|---|---|
| `.claude/knowledge-e2e-performance.md` | waitForTimeout, auto-waiting, 高速化施策 |
| `.claude/knowledge-e2e-angular.md` | beforeAll/storageState, Reactive Forms, ダッシュボードUI, パスワード変更フロー等 |

調査で新しい知見が得られたら、作業終了前に必ず該当ファイルに追記すること。

## 【パイプラインフロー】

```
① テスト内容チェック (/check-yaml): yaml品質・網羅性（pigeon repo + Playwright MCP参照）
  → ② テスト修正くん (/spec-create): yaml通りにspec.js実装・修正
    → ③ チェックくん (/check-run): Playwright実行 + 問題あれば差し戻し
```

**前工程変更 → 後工程全リセット:**
- yaml変更 → ②③ リセット
- spec.js変更 → ③ リセット

**管理DB**: チェックDB（DynamoDB + API）— **唯一の正（SSoT）**。DB未構築時は `.claude/pipeline-status.md` をフォールバック。
**詳細**: `.claude/e2e-pipeline-sheet.md`

| エージェント | スキル | 役割 |
|---|---|---|
| テスト内容チェック | `/check-yaml` | yaml品質・網羅性チェック（pigeon repo + Playwright MCP参照） |
| テスト修正くん | `/spec-create` | yaml通りにspec.jsを実装・修正（MCP Playwright必須） |
| チェックくん | `/check-run` | Playwright実行 + failed振り分け + 差し戻し（環境依存の遅さは切り分け） |
| 不具合調査くん | — | 障害・PRからyaml追加→DB更新→知見md |
| 詳細調査くん | — | インフラ根本原因調査（CloudWatch/ECS/RDS） |

---

## 【URLベースのテストケース】

yaml の description がURL（pigeon-cloud.com/pigeon-demo.com）のみのケースは**そのままPASSにしない**。
URLは不具合修正依頼や機能追加依頼のページ。raw_query.js で依頼内容を取得してテストフローに書き直す。

```bash
# 例: https://loftal.pigeon-cloud.com/admin/dataset__90/view/583
node /Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/manage/raw_query.js \
  popo "SELECT * FROM dataset__90 WHERE id = 583" --env=prod
```

詳細は `.claude/knowledge-e2e-angular.md` の「URLベースのテストケースの扱い」参照。

---

## 【絶対守るルール】テスト設計

1. **ALLテストテーブルは global-setup で1回だけ作成**。各specは `getAllTypeTableId` でID取得のみ。`setupAllTypeTable` は各specから呼ばない。
2. **テスト途中で `deleteAllTypeTables` を呼ばない**（他specが同じテーブルを使う）。テーブル削除テストは専用の一時テーブルで。
3. **`browser.newPage()` 禁止** → `createAuthContext(browser)` を使う（storageState必須）。
4. **MCP Playwright (`mcp__playwright__*`) で実UI確認してからコードを書く**。
5. **テスト間のデータ状態に依存しない**。各テストが必要なデータは自身のsetupで作成。
6. **Laddaボタン**: `setInputFiles` 後に `dispatchEvent(new Event('change'))` を手動発火。
7. **CSVアップロードは非同期**。結果は `/admin/csv` 履歴ページで確認。

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
| `ADMIN_BASE_URL` | 管理用URL（テスト環境作成元）staging: https://ai-test.pigeon-demo.com / 本番: https://ai-test.pigeon-cloud.com |
| `ADMIN_EMAIL` | 管理用ログインID（admin） |
| `ADMIN_PASSWORD` | 管理用パスワード |
| `ENV_TYPE` | テスト環境種別: `staging`（デフォルト）/ `production` — Sheetsの結果書き込み先タブを切り替える |
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

### 環境別の接続情報

| 環境 | ADMIN_BASE_URL | ADMIN_EMAIL | ADMIN_PASSWORD | ENV_TYPE |
|---|---|---|---|---|
| **Staging** | `https://ai-test.pigeon-demo.com` | `admin` | （環境変数参照） | `staging` |
| **本番** | `https://ai-test.pigeon-cloud.com` | `admin` | `BBjqqjSMxT4K` | `production` |

### テスト環境ドメイン命名規則（共通）
- Staging: `tmp-testai-{YmdHis}-{AGENT_NUM}.pigeon-demo.com`
- 本番: `tmp-testai-{YmdHis}-{AGENT_NUM}.pigeon-cloud.com`
  → `ADMIN_BASE_URL` からベースドメインを自動抽出（`global-setup.js` が動的に生成）

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

## テスト用外部リソース

### Webhookテストサーバー
- **受信URL**: `http://test.yaspp.net/pigeon/webhook.php?key={KEY}`
- **確認URL**: `http://test.yaspp.net/pigeon/display.php?key={KEY}`
- **リセット**: `http://test.yaspp.net/pigeon/webhook.php?key={KEY}&reset`
- ヘルパー: `tests/helpers/webhook-checker.js` に `webhookUrl(key)`, `waitForWebhook(key)`, `resetWebhook(key)` が実装済み
- 使い方: テストごとに一意なkeyを使う（例: `'105-01'`, `'105-02'`）

### テスト用ファイル（`/app/test_files/`）
| ファイル | 用途 |
|---------|------|
| `ok.png`, `donmai.png`, `oshii.png`, `gomen.png`, `renshu.png` | 画像アップロードテスト |
| `cs.pdf`, `general_affairs.pdf`, `hr.pdf`, `sales.pdf` | PDF・帳票テスト |
| `稼働_2M.csv`, `稼働_10M.csv` | CSVアップロードテスト |
| `請求書_+関連ユーザー.xlsx` | Excel帳票テスト |

ファイルアップロード: `await page.setInputFiles('input[type=file]', '/app/test_files/ok.png')`

### SMTPメール設定
beforeAllで `setupSmtp(page)` を呼ぶと自動設定される（notifications.spec.jsに実装済み）
- ホスト: `SMTP_HOST` (env) / デフォルト: `www3569.sakura.ne.jp`
- ポート: `SMTP_PORT` (env) / デフォルト: `587`
- ユーザー: `SMTP_USER` (env) / 同 `IMAP_USER`

### IMAPメール受信確認
- ヘルパー: `tests/helpers/mail-checker.js` に `waitForEmail()`, `deleteTestEmails()` が実装済み
- 受信アドレス: `IMAP_USER` (env) = `test@loftal.sakura.ne.jp`
- `IMAP_USER`/`IMAP_PASS` が設定されていれば自動でメール受信確認が有効になる

---

## spec.js 生成の作業手順

### Step 1: specs/XXXXX.yaml を読む
```bash
cat specs/auth.yaml
```
`cases` の各テストケースを把握する（case_no, description, expected）

### Step 2: ブラウザで実際に操作して確認
Playwrightを使って実際にページを開き、セレクターやURLを確認する：

> **⚠️ generate_specsモードではスクリーンショットを保存しない**
> ディスク容量節約のため、`page.screenshot()` は呼ばない。
> セレクター確認は `page.query_selector_all()` や `page.inner_html()` で行う。

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
    # スクリーンショットは撮らない。DOMを直接確認する。
    # 例: print(page.inner_html("body"))
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
# REPORTS_DIR環境変数で自分のディレクトリが設定されている
cat ${REPORTS_DIR}/results.json
```

失敗した各テストについて `errors` と `screenshot` を確認する。

### Step 2: スクリーンショットを見る

`${REPORTS_DIR}/screenshots/` をVisionで確認し、画面の状態を把握する。

### Step 3: Playwrightで実際に操作して確認

> **テスト失敗調査時はスクリーンショットOK**（run_testsモードのみ）

```python
from playwright.sync_api import sync_playwright
import os

reports_dir = os.environ.get("REPORTS_DIR", "reports/agent-1")
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    page = browser.new_page()
    page.set_viewport_size({"width": 1280, "height": 800})
    page.goto(os.environ["TEST_BASE_URL"] + "/admin/login")
    # ...調査したい操作...
    # 失敗調査時のみスクリーンショット保存（1テストケース1枚まで）
    page.screenshot(path=f"{reports_dir}/investigation.png", full_page=True)
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

## テスト品質チェック（必須・厳格に実施）

### 「テストOK」の定義

テストが **passed** であっても、以下のチェックリストを全て満たさない限り **本当のOKではない**。
spec.jsを生成・修正した際、またはテスト結果をシートに書き込む前に、必ず各テストを以下の観点で評価すること。

### テスト品質チェックリスト

各テストケースについて、以下を全てクリアしているか確認する：

| # | チェック項目 | NGの例 |
|---|------------|--------|
| 1 | **タイトルとテスト内容が合致している（十分である）** | タイトルが「フィルタ適用中にのみ一括編集がかかること」なのに、`.navbar` が表示されているだけを確認している |
| 2 | **テスト内容が正しく最後まで完遂している** | 途中で `return` / `console.log('...スキップ')` して実質何もテストしていない |
| 3 | **スキップされていない** | `test.skip(...)` / 早期 `return` / graceful skip で終わっている |

### NGパターン（絶対に許可しない）

```javascript
// ❌ NG: UIが見つからないと言ってreturnするだけ — 何もテストしていない
if (!filterBtnVisible) {
    console.log('フィルタUIが見つからないためスキップ');
    await expect(page.locator('.navbar')).toBeVisible();
    return;  // ← passed になるが何も確認していない
}

// ❌ NG: test.skip で逃げる
test.skip(true, 'todo');

// ❌ NG: タイトルと無関係なアサーション
// タイトル: 「フィルタ適用中にのみ一括編集がかかること」
await expect(page.locator('.navbar')).toBeVisible();  // ← navbarの表示はタイトルと無関係
```

### OKパターン（こうすること）

```javascript
// ✅ OK: タイトルに書いてある動作を実際に操作・確認している
// タイトル: 「フィルタ適用中にのみ一括編集がかかること」
// → フィルタを掛ける → 一括編集を実行 → フィルタ対象のレコードのみ変更されたことを確認

// ✅ OK: UIが存在しない場合は「機能未実装」として記録し、テスト削除または実装待ち
// → UIが存在しないなら test を削除するか、機能実装後に対応

// ✅ OK: フォールバックより具体的な確認
const filterUI = page.locator('.filter-btn');
if (await filterUI.count() === 0) {
    throw new Error('フィルタUIが存在しない — テスト環境か実装を確認してください');
}
```

### シートへの書き込みルール（品質情報を追加）

テスト結果をGoogle Sheetsに書き込む際、単純な `OK/NG` に加えて **品質判定** も記録する：

- `OK` → チェックリスト3項目を全てクリアしている場合のみ
- `OK*` （アスタリスク付き）→ passed だがチェック項目に疑義がある場合（内容が薄い等）
- `NG` → failed / 実質スキップ / タイトルと内容が不一致

**具体的には**: `e2e_report_sheet.py` でシートに書き込む際、「テスト品質」列（または備考）に以下を追記：
- `✓ 完全実装` → 3項目クリア
- `⚠ 内容不十分` → passed だがタイトルと内容が乖離
- `⚠ スキップ` → 早期returnや test.skip

### spec.js生成・修正時のセルフレビュー手順

spec.jsを書いた後、**コミット前に必ず以下を自分でレビューする**：

1. 各 `test('...', ...)` のタイトルを読む
2. テスト本体のコードを読む
3. 「このコードはタイトルに書いてあることを本当に確認しているか？」を自問する
4. `return` で途中終了していないか確認する
5. `test.skip` がないか確認する

もし疑問があれば、**MCP Playwrightでブラウザを実際に操作して確認**し、正しく実装してからコミットすること。

---

## テスト修正フロー — テスト作成君（必須・永続ルール）

**E2Eテストが失敗した場合、以下のフローを必ず実行すること。このルールは永続的に適用される。**

### フロー概要

```
失敗テスト発見
  ↓
① 原因分類（specバグ / プロダクトバグ / 環境依存）
  ↓
[specバグの場合]              [プロダクトバグの場合]
  ↓                             ↓
② ソースコード確認              `.claude/product-bugs.md` に記録
  ↓                             （テストコードは絶対に修正しない）
③ MCP Playwrightで実UIを確認
  ↓
④ spec.jsを修正・実装
  ↓
⑤ `npx playwright test` で自動実行・Pass確認
  ↓
⑥ 怒りくん（/check-specs）にレビュー依頼
  ↓
[怒りくん ✅ OK]              [怒りくん ❌ NG]
  ↓                             ↓
⑦ git commit                  ③に戻って再修正
```

### テスト作成君の実行コマンド

```bash
# 特定のspecの特定ケースを修正
/spec-create [spec名] [case_no]

# 特定のspecの全失敗を修正
/spec-create [spec名]

# 全失敗を修正（フルパイプライン）
/spec-create
```

### 絶対ルール

1. **MCP Playwright (`mcp__playwright__*`) を使って実際のUIを確認してからコードを書く**
2. **`npx playwright test` で実行確認してからコミットする**
3. **怒りくんのレビューを通過してからコミットする**
4. **プロダクトバグはテストコードで隠蔽しない**（スキップ・緩いアサーションへの変更も禁止）
5. **スクリーンショットも怒りくんが確認する**（テスト完了後）

### プロダクトバグの記録（`.claude/product-bugs.md`）

```markdown
## {spec名}/{case_no}: {テスト名}

- **発見日**: YYYY-MM-DD
- **症状**: {何が起きているか}
- **期待値**: {タイトルに書いてある期待動作}
- **実際**: {実際に起きていること}
- **判定**: プロダクトバグ
- **対応**: 開発チームに報告待ち
```

---

## 重要な注意事項

- **`_sheet_row` と `_sheet_gid` は変更禁止**（Sheetsへの書き戻しに使用）
- **Sheetsへの結果書き込みは必ず右端の新しい列に追加**（既存列は上書きしない）
- **ソースコード（/app/src/pigeon_cloud/）は読み取り専用**（変更禁止）
- **テスト対象はai-test.pigeon-demo.comのテスト専用テナントのみ**
- git操作はpullのみ可能（pushは権限なし）
- `reports/` への書き込みは自由（スクリーンショット、レポート等）
- `scenarios/` への書き込みは自由（シナリオの追加・更新）

---

## 並列エージェント実行時の注意

各エージェントは **自分専用のレポートディレクトリ** `${REPORTS_DIR}` を使う（`/app/reports/agent-{N}/`）。

### ファイル出力先

| ファイル | パス |
|---|---|
| テスト結果 | `${REPORTS_DIR}/results.json` |
| Playwright生JSON | `${REPORTS_DIR}/playwright-results.json` |
| Claudeレポート | `${REPORTS_DIR}/claude_report.md` |
| スクリーンショット | `${REPORTS_DIR}/screenshots/` |
| テスト環境URL | `${REPORTS_DIR}/test_env.txt` |
| 完了フラグ | `${REPORTS_DIR}/done` |

### 不具合報告
不具合は必ず `${REPORTS_DIR}/claude_report.md` に書く。`reports/claude_report.md` ではなく。

```bash
# 自分のレポートディレクトリを確認
echo $REPORTS_DIR
# → /app/reports/agent-1

# 不具合レポートの書き先
${REPORTS_DIR}/claude_report.md
```

### 並列実行起動コマンド（ホスト側）

```bash
# 3エージェント並列・各グループを分担
TOTAL_AGENTS=3 TARGET_SPEC=auth TARGET_SPEC_2=fields TARGET_SPEC_3=records \
  docker-compose --profile parallel up

# 単体実行（Agent1のみ・デフォルト）
docker-compose up agent-1
```
