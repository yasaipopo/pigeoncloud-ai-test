# E2Eテスト自動パイプライン

引数: `$ARGUMENTS`

以下の完全自動パイプラインを実行してください。引数がある場合は挙動を調整します。

---

## 引数の解釈

引数なし（`/e2e`）→ フルパイプライン（後述のStep 1〜8を全て実行）
- `run [spec]` → 指定specのみStep 3〜8
- `fix [spec]` → 指定specをrepair_specsモードで実行（Step 3〜8）
- `todo [spec]` → todoスキップのみ実装（Step 3〜8、repair_specsモード）
- `auto [spec]` → **自動修復ループ**（確認なし・最後まで全自動）→ 後述
- `retry-failed` → **失敗テストだけ再実行してシートをマージ更新**（→ 後述）
- `status` → 実行中エージェントの状況を表示して終了
- `results` → Step 6〜8のみ（集計・通知・Obsidian記録）
- `results --push` → Step 6〜8 + Google Sheets更新

---

## フルパイプライン

### Step 1: 最新コミット確認・テスト追加要否判断

```bash
cd /Users/yasaipopo/PycharmProjects/pigeon-test
git -C src/pigeon_cloud log --oneline -10
```

直近10コミットを確認し、以下を判断：

**新テストが必要なコミット（テスト追加が必要）**:
- `feat:` / `feature:` → 新機能 → 対応するspecにテストケースを追加
- `add:` で新しいページ・フィールド・機能が追加された場合

**テスト修正が必要なコミット（spec修正が必要）**:
- `fix:` / `refactor:` → UIや挙動の変更 → セレクター・期待値の確認・修正
- `chore:` でURL・クラス名が変わった場合

**テスト不要なコミット（スキップ）**:
- `docs:` / `style:` / `test:` → E2Eテスト変更不要

**判断方法**:
```bash
git -C src/pigeon_cloud diff HEAD~5..HEAD --name-only
```
変更ファイルから影響を受けるspecを特定:
- `Application/Class/Workflow*.php` → workflow.spec.js
- `html_angular4/src/app/notification/` → notifications.spec.js
- など

### Step 2: spec追加・修正（必要な場合のみ）

テスト追加が必要と判断した場合：
1. 対応するシナリオYAML（`scenarios/`）を確認
2. 新機能のシナリオがなければ新規YAML作成
3. spec.jsに`test()`を追加（`test.skip(true, 'todo')`は使わない、必ず実装する）

spec修正が必要と判断した場合：
1. 影響を受けるspecファイルを特定して修正

### Step 3: サブエージェント並列起動

**Dockerは使わない。Agent toolでサブエージェントを直接ホストで並列起動する。**

以下の5グループを並列起動（引数でspec指定がある場合はそのspecのみ1台）:

```
agent-A (AGENT_NUM=30): layout-ui, system-settings, table-definition, reports, records
agent-B (AGENT_NUM=31): notifications, users-permissions, auth
agent-C (AGENT_NUM=32): workflow, uncategorized         ← 247件（分割済み）
agent-C2(AGENT_NUM=34): uncategorized-2                ← 167件（追加実装中）
agent-C3(AGENT_NUM=35): uncategorized-3                ← 166件（追加実装後）
agent-D (AGENT_NUM=33): chart-calendar, fields, filters, comments-logs, csv-export, public-form
```

**uncategorizedは3ファイルに分割済み**: uncategorized.spec.js / uncategorized-2.spec.js / uncategorized-3.spec.js
aggregate は各ファイルを別specとして認識して自動マージする。

**起動方法**: 1つのメッセージで4つのAgent tool callを並列送信する（`run_in_background: true`）。

各サブエージェントへのプロンプトテンプレート:
```
以下のコマンドをそのまま実行してください。
作業ディレクトリは `/Users/yasaipopo/PycharmProjects/pigeon-test` です。

cd /Users/yasaipopo/PycharmProjects/pigeon-test
mkdir -p reports/agent-{AGENT_NUM}
# .envを読み込む（AGENT_NUMは上書きして正しい番号を設定）
set -a; source .env; set +a
export AGENT_NUM={AGENT_NUM}
npx playwright test {SPEC_FILES} \
  2>&1 | tee reports/agent-{AGENT_NUM}/repair_run.log
echo "exit:${PIPESTATUS[0]}" > reports/agent-{AGENT_NUM}/done

完了したら passed/failed/skipped の件数を報告してください。
```

**注意**: `--reporter=json` はコマンドラインに追加しないこと。config で設定済みの
JSON reporter（`reports/agent-N/playwright-results.json`）が上書きされる。

SPEC_FILESは `tests/workflow.spec.js tests/uncategorized.spec.js` のように展開する。

### Step 4: 完了待機

サブエージェントは `run_in_background: true` で起動しているため、完了時に自動通知が来る。
全エージェントの完了通知が揃うまで待機する。

途中経過の確認:
```bash
ls reports/agent-{30..33}/done 2>/dev/null
tail -5 reports/agent-30/run.log
```

### Step 5: 動画の整理

各エージェントの最終実行ディレクトリから：
- **passed/failedの動画のみ**収集（skippedは不要）
- Google Drive `1lBuy_g3Jv6m4txbT-SsYkKqdeB59HA59` にアップロード
- フォルダ構造: `E2Eテスト/{実行日}/{spec名}/{テストID}.webm`

```python
# Google Drive アップロード
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google.oauth2.service_account import Credentials

creds = Credentials.from_service_account_file('secrets/service_account.json',
    scopes=['https://www.googleapis.com/auth/drive'])
service = build('drive', 'v3', credentials=creds)
DRIVE_FOLDER_ID = '1lBuy_g3Jv6m4txbT-SsYkKqdeB59HA59'
```

ただし動画が多すぎる場合（50件超）は failed のみアップロード。

### Step 6: 結果集計 + Google Sheetsレポート作成

```bash
cd /Users/yasaipopo/PycharmProjects/pigeon-test
python3 runner/aggregate_playwright_results.py
```

集計結果: `reports/results.json`

**Google Sheets への結果書き込み（必須）**:
```bash
python3 runner/e2e_report_sheet.py --push-run
```

これにより自動的に:
1. **「テスト結果」タブ（1つのみ）**に「N回目」列を追加して全spec・全ケースの結果（passed/failed/skipped）を色付きで記録
   - 列構成: A=spec, B=case_no, C=feature, D=description, E=expected, F+=実行回ごとの結果
   - uncategorized-2/3 の結果は uncategorized として正規化してマージ
2. **「N回目テストレポート」タブ**を新規作成し、以下を記載:
   - 実行日時・合計/成功/失敗/スキップ件数
   - spec別結果一覧（判定・色付き）
   - 失敗テスト一覧（シートリンク付き）
   - **分析・総括**（失敗パターン自動分析・推奨アクション）

**シートを作り直す場合**:
```bash
python3 runner/e2e_report_sheet.py --rebuild
```
テスト結果タブを削除・再作成し、1回目として書き直す。

シート: https://docs.google.com/spreadsheets/d/1bdM8712izGrI9E9m4x2SkSyG6mBCK-apoxVI1xwG93E

**動画アップロード（オプション・失敗動画が多い場合）**:
```bash
python3 runner/e2e_report_sheet.py --upload-videos --date $(date +%Y-%m-%d)
```

### Step 7: Slack通知（サマリー）

以下の形式で石川（`<@U869KKT8C>`）に通知:

```
<@U869KKT8C> 【PigeonCloud E2E】自動テスト完了

📊 結果サマリー
✅ passed: XXX件
❌ failed: N件
⏭ skipped: XXX件（環境依存・todo）

❌ 失敗テスト:
• notifications/6-1: メッセージ...
• workflow/106-02: メッセージ...

⚠️ 新規スキップ（前回比）:
• なし / または件名

🔗 Google Sheets: https://docs.google.com/spreadsheets/d/1h_gwuCGUAdj5fKPRZu438TKFkFkYUNUKz2K_vtEFlmI

🎬 エラー動画: https://drive.google.com/drive/folders/1lBuy_g3Jv6m4txbT-SsYkKqdeB59HA59

📅 実行日時: YYYY-MM-DD HH:MM JST
🌿 コミット: {最新コミットハッシュ} {メッセージ}
```

Slack Webhook:
```bash
curl -s -X POST -H 'Content-type: application/json' \
  --data "{\"text\": \"...\"}" \
  ${SLACK_WEBHOOK_URL}
```

Mac通知も送る:
```bash
osascript -e 'display notification "E2Eテスト完了: passed=XXX failed=N" with title "【PigeonCloud】Claude Code" sound name "Pop"'
```

### Step 8: Obsidian記録（必須）

実行結果の詳細をObsidianに記録する。ファイルパス:
```
/Users/yasaipopo/Dropbox/notes/iCloud/pigeoncloud/E2Eテスト実行結果/{YYYY-MM-DD}_{HHmm}.md
```

記録内容（詳細）:
```markdown
# E2Eテスト実行結果 YYYY-MM-DD HH:MM

## サマリー
- ✅ passed: XXX件
- ❌ failed: N件
- ⏭ skipped: XXX件
- 合計: XXX件

## コミット情報
- ハッシュ: {commitHash}
- メッセージ: {commitMessage}

## specごとの結果
| spec | passed | failed | skipped |
|------|--------|--------|---------|
| workflow | XX | 0 | X |
| uncategorized | XX | 0 | X |
...

## 失敗テスト詳細
（failedがある場合のみ）
### {spec}/{case_no}: {テスト名}
- エラー: {エラーメッセージ}
- 原因: {判断した原因}
- 対応: {spec修正済み / プロダクトバグとして記録 / 再実行待ち}

## スキップ分析
- 外部依存（OAuth/Stripe等）: X件
- SMTP未設定: X件
- 環境制約: X件
- todo実装待ち: X件（← これは0にする目標）

## エージェント実行ログ
- agent-XX: {対象spec} / passed XX / skipped XX
...

## 前回比較
- 前回passed: XXX件 → 今回: XXX件（+X）
- 新規failed: なし / {case_no} {テスト名}
- 解消されたskip: {件数}件

## 備考・気づき
（特記事項があれば）
```

ファイル作成後、Obsidian MCP ツールが利用可能な場合は `mcp__mcp-obsidian__read_notes` で確認。

---

## 判断基準

### failedの扱い
- **スペックバグ**（セレクター変更・タイムアウト等）→ specを修正して再実行
- **プロダクトバグ**（機能が壊れている）→ サマリーに記載して通知
- **環境バグ**（一時的なエラー）→ 再実行して確認

### プロダクトバグ判定時のルール
**テストコードは絶対に修正しない**（skipや緩いアサーションへの変更も禁止）。
Slack通知・Obsidian記録に留める。

### 既知のプロダクトバグ候補（要確認）

| spec | case | 症状 | 調査日 |
|------|------|------|--------|
| system-settings | 58-1 | 利用規約設定ON→OFF後、`.content` が hidden になりページ表示崩れ | 2026-03-20 |
| users-permissions | 2-1, 2-2 | ユーザー追加フォームの保存ボタン（btn-outline-primary）が not visible | 2026-03-20 |
| fields | 121-01 | `/admin/dataset/edit/{id}` のフィールド設定ページが60秒タイムアウト（パフォーマンス問題の可能性） | 2026-03-20 |

### スキップの扱い
- `test.skip(true, 'todo')` → 実装して通す（スキップのまま残さない）
- 外部依存（OAuth・Stripe等）→ スキップのまま許容（サマリーに件数のみ記載）
- 環境制約（ユーザー上限等）→ graceful skipのまま許容

### テスト追加の判断
コミットメッセージだけでなく、変更されたファイルのdiffを見て判断すること。
新しいAngularコンポーネント・PHPコントローラーが追加された場合は対応するテストを追加する。

---

## 失敗テストだけ再実行（`/e2e retry-failed`）

**目的**: 前回のフルテストで失敗したspec だけを再実行して、シートの同じ列にマージ更新する。
全1328件ではなく失敗specだけ（通常300〜500件）実行するため大幅に時間短縮できる。

### 手順

**Step 1: 失敗specを抽出**

```bash
cd /Users/yasaipopo/PycharmProjects/pigeon-test
FAILED_SPECS=$(python3 runner/e2e_report_sheet.py --failed-specs 2>/dev/null)
echo "失敗spec: $FAILED_SPECS"
```

カンマ区切りで出力される（例: `auth,fields,uncategorized,workflow`）

**Step 2: 失敗specをグループ分割して並列サブエージェント起動**

フルパイプラインと同じ4グループで分割し、失敗specが含まれるグループのみ起動する。

```
グループA: layout-ui, system-settings, table-definition, reports, records
グループB: notifications, users-permissions, auth
グループC: workflow, uncategorized
グループD: chart-calendar, fields, filters, comments-logs, csv-export, public-form
```

グループ割り当てを計算してから、該当グループを Agent tool で `run_in_background: true` 並列起動:

```bash
# グループ割り当て計算
python3 - <<'EOF'
import subprocess
failed = set(subprocess.check_output(
    ["python3", "runner/e2e_report_sheet.py", "--failed-specs"],
    stderr=subprocess.DEVNULL).decode().strip().split(","))
groups = {
    "A": (50, "layout-ui,system-settings,table-definition,reports,records"),
    "B": (51, "notifications,users-permissions,auth"),
    "C": (52, "workflow,uncategorized"),
    "C2": (54, "uncategorized-2"),
    "C3": (55, "uncategorized-3"),
    "D": (53, "chart-calendar,fields,filters,comments-logs,csv-export,public-form"),
}
for g, (num, specs) in groups.items():
    overlap = failed & set(specs.split(","))
    if overlap:
        target = ",".join(sorted(overlap))
        spec_files = " ".join(f"tests/{s}.spec.js" for s in sorted(overlap))
        print(f"グループ{g}: AGENT_NUM={num} SPEC_FILES={spec_files}")
    else:
        print(f"グループ{g}: スキップ（失敗なし）")
EOF
```

各サブエージェントへのプロンプト（`run_in_background: true` で並列起動）:
```
以下のコマンドをそのまま実行してください。
作業ディレクトリは `/Users/yasaipopo/PycharmProjects/pigeon-test` です。

cd /Users/yasaipopo/PycharmProjects/pigeon-test
mkdir -p reports/agent-{AGENT_NUM}
set -a; source .env; set +a
export AGENT_NUM={AGENT_NUM}
npx playwright test {SPEC_FILES} \
  2>&1 | tee reports/agent-{AGENT_NUM}/repair_run.log
echo "exit:${PIPESTATUS[0]}" > reports/agent-{AGENT_NUM}/done

完了したら passed/failed/skipped の件数を報告してください。
```

**注意**: `--reporter=json` はコマンドラインに追加しないこと。
config で設定済みのJSON reporter（`reports/agent-N/playwright-results.json`）が上書きされる。

**Step 3: 完了後に結果を集計**

```bash
python3 runner/aggregate_playwright_results.py
```

**Step 4: シートの同じ列にマージ（新列は作らない）**

```bash
python3 runner/e2e_report_sheet.py --merge-run
```

これにより:
- 各specタブの「N回目」列を**上書きマージ**（passed→passed、failed→passedに変化したセルだけ更新）
- 「N回目テストレポート」タブを**再生成**（マージ後の全体stats反映）
- 新しい列・タブは作成しない

---

## 自動修復ループ（`/e2e auto [spec]`）

**目的**: 確認なし・最後まで全自動でテストをパスさせる

### ループ手順

```
最大 MAX_ITERATIONS=5 回繰り返す:

1. Docker エージェント起動（repair_specs モード）
2. 完了待機
3. 失敗テストを抽出
4. 各失敗テストについて:
   a. エラーログ・スクリーンショットを確認
   b. 分類（下記）
   c. specバグなら即座に修正
5. 修正があれば次のイテレーションへ
6. 修正なしなら（全て product bug）→ ループ終了
```

### 失敗の分類と対応

| 分類 | 判断基準 | 対応 |
|------|---------|------|
| **specバグ** | セレクター変更・タイムアウト・URLパス変更・表示テキスト変更 | spec.jsを修正して次のイテレーションで再実行 |
| **環境エラー** | ネットワークタイムアウト・ポートエラー・ブラウザクラッシュ | 再実行（修正なし） |
| **プロダクトバグ** | 機能が壊れている（期待値に合わない画面が表示される）| エラーとして記録・スキップ化しない |

### specバグの修正方針

```javascript
// ❌ やってはいけない: とりあえずスキップ化
test.skip(true, 'バグ');

// ✅ やるべき: セレクター・期待値を修正
// 例: テキストが変わった場合
await expect(page.locator('.title')).toContainText('新しいテキスト');

// 例: URLが変わった場合
await page.goto(BASE_URL + '/admin/new-path');

// 例: タイムアウトの場合
await page.waitForSelector('.element', { timeout: 10000 });
```

### 実装コマンド例

```bash
# イテレーション N で実行
AGENT_NUM=$((LAST_AGENT + 1))
mkdir -p reports/agent-$AGENT_NUM

docker run -d \
  --name pigeon_test_agent_$AGENT_NUM \
  --env-file .env \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e AGENT_NUM=$AGENT_NUM \
  -e MODE=repair_specs \
  -e TARGET_SPEC="${TARGET_SPEC}" \
  -v $(pwd)/run_agent.sh:/app/run_agent.sh \
  ... （同じマウント）
  pigeon-test_agent-1

# 失敗抽出スクリプト
grep "✗\|✘" reports/agent-$AGENT_NUM/repair_run.log | \
  sed 's/.*\[chromium\].*//' | sort -u
```

### ループ終了条件

- **全テスト passed** → 完了（Step 6〜8へ）
- **失敗が全て product bug** → Step 6〜8へ（product bugとしてObsidianに記録）
- **MAX_ITERATIONS=5 到達** → 強制終了、現状のまま Step 6〜8へ
- **同じ失敗が2イテレーション連続** → product bug と判定して終了

### 修正の記録

spec修正を行ったら必ずコミットする:
```bash
git add tests/[修正したspec].spec.js
git commit -m "fix(e2e): [spec名] セレクター修正・タイムアウト調整"
```

---

## 作業記録

実行内容を以下に記録:
```
.claude/thread-e2e-pipeline-{YmdHis}.md
```

前回の実行結果との差分（passed増減・failed増減）も記録すること。
