#!/bin/bash
# ============================================================
# PigeonCloud テストエージェント エントリーポイント
#
# MODE=generate_specs  → spec.jsを生成・更新（Claude が作業）
# MODE=run_tests       → spec.jsを実行してSheetsに結果書き戻し（デフォルト）
#
# 並列実行時: AGENT_NUM=1,2,3... を指定
# 各エージェントが自分専用のテスト環境を作成してテストする
# ============================================================

set -e

export GIT_SSH_COMMAND="ssh -i /home/agent/.ssh/deploy_key -o StrictHostKeyChecking=no -o IdentitiesOnly=yes"

MODE=${MODE:-run_tests}
AGENT_NUM=${AGENT_NUM:-1}
TARGET_SPEC=${TARGET_SPEC:-}

# 自分専用の環境名（ドメイン）
DATETIME=$(date '+%Y%m%d%H%M%S')
MY_DOMAIN="tmp-testai-${DATETIME}-${AGENT_NUM}"
MY_URL="https://${MY_DOMAIN}.pigeon-demo.com"

# エージェントごとのレポートディレクトリ
AGENT_REPORT_DIR="/app/reports/agent-${AGENT_NUM}"
mkdir -p "${AGENT_REPORT_DIR}/screenshots"

# 共有ディレクトリ（同期フラグなど）
mkdir -p /app/reports

# このエージェントの結果パスを環境変数で上書き
export REPORTS_DIR="${AGENT_REPORT_DIR}"

echo "============================================"
echo " PigeonCloud テストエージェント起動"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo " モード: ${MODE} / エージェント番号: ${AGENT_NUM}"
echo " テスト環境: ${MY_URL}"
echo "============================================"

# PigeonCloudソースを最新化
if [ -d "/app/src/pigeon_cloud/.git" ]; then
    echo ">> PigeonCloudソースを最新化..."
    cd /app/src/pigeon_cloud
    git pull --quiet
    echo "   最新コミット: $(git log -1 --format='%h %s')"
    cd /app
fi

# ============================================================
# Step 0: テスト専用環境を自動作成
# ============================================================
echo ""
echo ">> テスト環境作成: ${MY_DOMAIN}"

TEST_PASSWORD=$(python3 - <<PYEOF
from playwright.sync_api import sync_playwright
import os, sys

admin_url = os.environ.get("ADMIN_BASE_URL", "https://ai-test.pigeon-demo.com")
admin_email = os.environ.get("ADMIN_EMAIL", os.environ.get("TEST_EMAIL", "admin"))
admin_password = os.environ.get("ADMIN_PASSWORD", os.environ.get("TEST_PASSWORD", ""))
domain = "${MY_DOMAIN}"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    page = browser.new_page()
    page.set_viewport_size({"width": 1280, "height": 800})

    try:
        # ログイン
        page.goto(admin_url + "/admin/login", wait_until="networkidle")
        page.fill("#id", admin_email)
        page.fill("#password", admin_password)
        page.click("button[type=submit].btn-primary")
        page.wait_for_selector(".navbar", timeout=15000)

        # 環境作成ページ
        page.goto(admin_url + "/admin/internal/create-client", wait_until="networkidle")

        # ドメイン入力（既存の値をクリアして入力）
        domain_input = page.locator("input").first
        domain_input.fill(domain)

        # ログインID = admin
        login_inputs = page.locator("input")
        for i in range(login_inputs.count()):
            val = login_inputs.nth(i).input_value()
            if val == "" or val == "admin":
                login_inputs.nth(i).fill("admin")
                break

        # 作成ボタンをクリック
        page.click("button:has-text('作成')")
        page.wait_for_timeout(3000)

        # パスワードを取得（作成完了後に表示される）
        content = page.content()
        import re
        m = re.search(r'PASSWORD[:\s]+([A-Za-z0-9]{8,})', content)
        if m:
            print(m.group(1))
        else:
            # ページ全体からパスワードらしい文字列を探す
            m2 = re.search(r'(?:password|pw|pass)[^A-Za-z0-9]*([A-Za-z0-9]{8,16})', content, re.IGNORECASE)
            if m2:
                print(m2.group(1))
            else:
                print("ERROR: パスワード取得失敗", file=sys.stderr)
                sys.exit(1)

    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        browser.close()
PYEOF
)

if [ $? -ne 0 ] || [ -z "$TEST_PASSWORD" ] || [[ "$TEST_PASSWORD" == ERROR* ]]; then
    MSG="<@${SLACK_NOTIFY_USER_ID}> 🚨 【PigeonCloud Agent${AGENT_NUM}】テスト環境作成失敗: ${MY_DOMAIN}"
    curl -s -X POST -H 'Content-type: application/json' \
        --data "{\"text\":\"${MSG}\"}" "${SLACK_WEBHOOK_URL}" || true
    echo "テスト環境作成に失敗しました"
    exit 1
fi

# 作成したテスト環境の情報を設定
export TEST_BASE_URL="${MY_URL}"
export TEST_EMAIL="admin"
export TEST_PASSWORD="${TEST_PASSWORD}"

echo "   作成完了: ${MY_URL} / admin / ${TEST_PASSWORD}"

# テスト環境情報をファイルに記録
echo "${MY_URL}" > "${AGENT_REPORT_DIR}/test_env.txt"

# ============================================================
# モードA: spec.js 生成モード
# ============================================================
if [ "$MODE" = "generate_specs" ]; then
    echo ""
    echo ">> spec.js 生成モード"

    SPEC_YAML=${TARGET_SPEC:-auth}

    claude --dangerously-skip-permissions "
あなたはPigeonCloudのQAエージェント（Agent ${AGENT_NUM}）です。CLAUDE.mdの指示に従って作業してください。

## テスト環境（自動作成済み）
- URL: ${TEST_BASE_URL}
- ID: admin
- PASSWORD: ${TEST_PASSWORD}

## 今回のタスク: spec.js 生成

対象: specs/${SPEC_YAML}.yaml

手順:
1. specs/${SPEC_YAML}.yaml を読んで、テストケース一覧（cases）を把握する
2. Playwrightでブラウザを実際に操作して対象機能のページを確認する
   - セレクターの確認
   - URLパスの確認
   - UIの状態確認（スクリーンショットも撮る）
3. 確認した内容を元に tests/${SPEC_YAML}.spec.js を生成する
   - 各テストケースを test() として実装
   - ログインはlogin()ヘルパーを使う
   - セレクターは実際に確認したものを使う
4. npx playwright test tests/${SPEC_YAML}.spec.js --reporter=list で動作確認
5. 失敗したケースは再調査して修正する
6. 完了したらSlack通知

ソースコードは /app/src/pigeon_cloud/ で確認できます（staging最新・read-only）。
"
    exit 0
fi

# ============================================================
# モードB: 定期テスト実行モード
# ============================================================

# Phase 1: Google Sheets → YAMLシナリオ同期（Agent1のみ実行・他は待機）
if [ "$AGENT_NUM" = "1" ]; then
    echo ""
    echo ">> Phase 1: Google Sheets からシナリオを同期"
    python runner/sheets_sync.py --pull
    # 同期完了フラグ
    touch /app/reports/sheets_sync_done
else
    # Agent1の同期完了を最大3分待つ
    echo ""
    echo ">> Agent1のシート同期完了を待機中..."
    WAIT_SEC=0
    while [ "$WAIT_SEC" -lt "180" ]; do
        if [ -f "/app/reports/sheets_sync_done" ]; then
            echo "   シート同期完了を確認"
            break
        fi
        sleep 5
        WAIT_SEC=$((WAIT_SEC + 5))
    done
fi

# Phase 2: spec.js 実行
echo ""
echo ">> Phase 2: Playwright spec.js テスト実行（Agent ${AGENT_NUM}）"

if [ -n "$TARGET_SPEC" ]; then
    SPEC_FILES="tests/${TARGET_SPEC}.spec.js"
else
    SPEC_FILES="tests/"
fi

SPEC_COUNT=$(find tests/ -name "*.spec.js" 2>/dev/null | wc -l)

if [ "$SPEC_COUNT" -gt "0" ]; then
    npx playwright test $SPEC_FILES 2>&1 || true

    python3 -c "
import json, os
from pathlib import Path

# エージェント別ディレクトリに出力
agent_dir = Path(os.environ.get('REPORTS_DIR', 'reports/agent-1'))
pw_path = agent_dir / 'playwright-results.json'
if pw_path.exists():
    with open(pw_path) as f:
        pw = json.load(f)
    results = []
    for suite in pw.get('suites', []):
        for spec in suite.get('specs', []):
            status = 'passed' if spec.get('ok') else 'failed'
            results.append({
                'scenario': spec.get('title', ''),
                'file': suite.get('file', ''),
                'status': status,
                'errors': [{'type': 'test', 'message': r.get('error', {}).get('message', '')}
                           for r in spec.get('tests', [{}])[0].get('results', [])
                           if r.get('status') == 'failed'],
                'screenshot': None,
            })
    out = agent_dir / 'results.json'
    with open(out, 'w') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    passed = sum(1 for r in results if r['status'] == 'passed')
    failed = sum(1 for r in results if r['status'] == 'failed')
    print(f'結果: {passed}件成功 / {failed}件失敗')
" 2>/dev/null || true
else
    echo "spec.jsが見つかりません。MODE=generate_specs で先に生成してください。"
fi

FAILED=$(python3 -c "
import json, os
from pathlib import Path
p = Path(os.environ.get('REPORTS_DIR', 'reports/agent-1')) / 'results.json'
if not p.exists():
    print(0)
else:
    with open(p) as f:
        results = json.load(f)
    print(sum(1 for r in results if r['status'] == 'failed'))
" 2>/dev/null || echo "0")

echo "失敗件数: $FAILED"

if [ "$FAILED" -gt "0" ]; then
    echo ""
    echo ">> Phase 3: Claude による失敗調査・spec.js修正"

    claude --dangerously-skip-permissions "
あなたはPigeonCloudのQAエージェント（Agent ${AGENT_NUM}）です。CLAUDE.mdの指示に従って作業してください。

## テスト環境
- URL: ${TEST_BASE_URL}
- ID: admin / PASSWORD: ${TEST_PASSWORD}

${AGENT_REPORT_DIR}/results.json に失敗したテストが ${FAILED} 件あります。
各失敗を調査して：
- セレクター変更・URL変更・文言変更 → tests/*.spec.js を修正
- 不具合 → ${AGENT_REPORT_DIR}/claude_report.md にまとめてSlack通知

ソースコードは /app/src/pigeon_cloud/ で確認できます（staging最新）。
"
fi

# 完了フラグを書く（他エージェントとの同期用）
touch "${AGENT_REPORT_DIR}/done"
echo ">> Agent ${AGENT_NUM} 完了フラグ書き込み: ${AGENT_REPORT_DIR}/done"

# Phase 4: 結果書き戻し・最終レポート（Agent1のみ・全エージェント完了後）
if [ "$AGENT_NUM" = "1" ]; then
    # 他エージェントの完了を最大10分待つ
    TOTAL_AGENTS=${TOTAL_AGENTS:-1}
    if [ "$TOTAL_AGENTS" -gt "1" ]; then
        echo ""
        echo ">> 他エージェントの完了を待機中（最大10分）..."
        WAIT_SEC=0
        while [ "$WAIT_SEC" -lt "600" ]; do
            ALL_DONE=true
            for i in $(seq 2 $TOTAL_AGENTS); do
                if [ ! -f "/app/reports/agent-${i}/done" ]; then
                    ALL_DONE=false
                    break
                fi
            done
            if [ "$ALL_DONE" = "true" ]; then
                echo "   全エージェント完了確認"
                break
            fi
            sleep 10
            WAIT_SEC=$((WAIT_SEC + 10))
            echo "   待機中... ${WAIT_SEC}秒経過 (Agent1を除く${TOTAL_AGENTS}台のうち未完了あり)"
        done
    fi

    echo ""
    echo ">> Phase 4: テスト結果をGoogle Sheetsに書き戻し"
    python runner/sheets_sync.py --push

    echo ""
    echo ">> 最終レポート生成..."
    REPORTS_DIR="/app/reports" python runner/consolidate_reports.py
    echo "   → reports/final_report.md に出力しました"
fi

echo ""
echo "============================================"
echo " 完了: $(date '+%Y-%m-%d %H:%M:%S') / Agent ${AGENT_NUM}"
echo "============================================"
