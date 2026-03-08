#!/bin/bash
# ============================================================
# PigeonCloud テストエージェント エントリーポイント
# Claudeを起動して、あとはClaude + Playwright MCPに全部任せる
# ============================================================

set -e

# git safe.directory（ボリュームマウント対応）
git config --global --add safe.directory /app/src/pigeon_cloud 2>/dev/null || true
export GIT_SSH_COMMAND="ssh -i /home/agent/.ssh/deploy_key -o StrictHostKeyChecking=no -o IdentitiesOnly=yes"

MODE=${MODE:-run_tests}
AGENT_NUM=${AGENT_NUM:-1}
TARGET_SPEC=${TARGET_SPEC:-}
TOTAL_AGENTS=${TOTAL_AGENTS:-1}

# テスト環境ドメイン（Claudeが作成する）
DATETIME=$(date '+%Y%m%d%H%M%S')
MY_DOMAIN="tmp-testai-${DATETIME}-${AGENT_NUM}"
MY_URL="https://${MY_DOMAIN}.pigeon-demo.com"

# エージェントごとのレポートディレクトリ
AGENT_REPORT_DIR="/app/reports/agent-${AGENT_NUM}"
mkdir -p "${AGENT_REPORT_DIR}/screenshots"
mkdir -p /app/reports
export REPORTS_DIR="${AGENT_REPORT_DIR}"

echo "============================================"
echo " PigeonCloud テストエージェント起動"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo " モード: ${MODE} / エージェント番号: ${AGENT_NUM}"
echo " テスト環境（作成予定）: ${MY_URL}"
echo "============================================"

# PigeonCloudソースを最新化
if [ -d "/app/src/pigeon_cloud/.git" ]; then
    echo ">> PigeonCloudソースを最新化..."
    cd /app/src/pigeon_cloud
    git pull --quiet 2>/dev/null || true
    echo "   最新コミット: $(git log -1 --format='%h %s')"
    cd /app
fi

# ============================================================
# Claude に全部任せる（Playwright MCPでブラウザ操作）
# ============================================================

claude --dangerously-skip-permissions "
あなたはPigeonCloudのQAエージェント（Agent ${AGENT_NUM}）です。
CLAUDE.mdの指示に従って作業してください。

## 実行環境
- モード: ${MODE}
- 対象スペック: ${TARGET_SPEC:-（全スペック）}
- レポートディレクトリ: ${AGENT_REPORT_DIR}
- 総エージェント数: ${TOTAL_AGENTS}

## ステップ1: テスト環境を作成（Playwright MCPを使う）

Playwright MCPブラウザで以下を実行してテスト専用環境を作成してください：

1. https://ai-test.pigeon-demo.com/admin/login にアクセス
2. ID: admin / パスワード: ${TEST_PASSWORD} でログイン
3. https://ai-test.pigeon-demo.com/admin/internal/create-client にアクセス
4. ドメイン欄に「${MY_DOMAIN}」を入力
5. ログインID欄に「admin」を入力
6. 作成ボタンをクリック
7. 完了後に表示されたパスワードを確認する

作成したテスト環境：
- URL: ${MY_URL}
- ログインID: admin
- パスワード: （上記で確認した値）

テスト環境URLを ${AGENT_REPORT_DIR}/test_env.txt に保存してください。
作成失敗したら Slack通知して終了してください。

## ステップ2: モードに応じて作業

### MODE=generate_specs の場合
specs/${TARGET_SPEC}.yaml を読んで、Playwright MCPでブラウザを操作しながら
tests/${TARGET_SPEC}.spec.js を生成してください。
CLAUDE.mdの「spec.js 生成の作業手順」に従ってください。

### MODE=run_tests の場合

#### Phase 1（Agent1のみ）: Google Sheetsからシナリオ同期
\`\`\`bash
python runner/sheets_sync.py --pull
touch /app/reports/sheets_sync_done
\`\`\`
Agent1以外は /app/reports/sheets_sync_done が出来るまで待機してください（最大3分）。

#### Phase 2: テスト実行
\`\`\`bash
npx playwright test ${TARGET_SPEC:+tests/${TARGET_SPEC}.spec.js} --reporter=list,json
\`\`\`
結果を ${AGENT_REPORT_DIR}/results.json に変換して保存してください。

#### Phase 3: 失敗調査
失敗があればPlaywright MCPで実際にブラウザを操作して原因を調査してください。
- セレクター変更・URL変更 → tests/*.spec.js を修正
- 不具合 → ${AGENT_REPORT_DIR}/claude_report.md にまとめてSlack通知

#### Phase 4（Agent1のみ・全員完了後）
${TOTAL_AGENTS}台すべての ${AGENT_REPORT_DIR}/done ファイルが揃ったら：
\`\`\`bash
python runner/sheets_sync.py --push
REPORTS_DIR=/app/reports python runner/consolidate_reports.py
\`\`\`

## 完了時
${AGENT_REPORT_DIR}/done ファイルを作成してSlack通知してください。
"
