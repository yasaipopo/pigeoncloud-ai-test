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
TARGET_IDS=${TARGET_IDS:-}
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

# Playwrightブラウザを確認・更新（npmパッケージのバージョンに合わせる）
# npmでPlaywrightが更新されるとDockerイメージ内のブラウザと不一致になるため毎回確認
echo ">> Playwrightブラウザ確認..."
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx playwright install chromium 2>/dev/null || true

# ============================================================
# Claude に全部任せる（Playwright MCPでブラウザ操作）
# ============================================================

CLAUDE_LOG="${AGENT_REPORT_DIR}/claude.log"
echo "[$(date '+%H:%M:%S')] Claude起動" >> "${CLAUDE_LOG}"

# ハートビート: 30秒ごとにclaudeプロセス状態をログ（フリーズ検知用）
(while true; do
    sleep 30
    CLAUDE_PID=$(pgrep -x claude 2>/dev/null | head -1)
    if [ -n "$CLAUDE_PID" ]; then
        CPU=$(ps -p "$CLAUDE_PID" -o %cpu= 2>/dev/null | tr -d ' ')
        MEM=$(ps -p "$CLAUDE_PID" -o %mem= 2>/dev/null | tr -d ' ')
        echo "[$(date '+%H:%M:%S')] ♥ HEARTBEAT: claude PID=${CLAUDE_PID} CPU=${CPU}% MEM=${MEM}%" >> "${CLAUDE_LOG}"
    else
        echo "[$(date '+%H:%M:%S')] ⚠ HEARTBEAT: claude process NOT FOUND" >> "${CLAUDE_LOG}"
        break
    fi
done) &
HEARTBEAT_PID=$!

# TARGET_SPECをspec.jsファイルリストに事前展開（ネスト引用符回避）
if [ -n "${TARGET_SPEC}" ]; then
    SPEC_FILES=$(echo "${TARGET_SPEC}" | tr ',' ' ' | sed 's|[^ ]*|tests/&.spec.js|g')
else
    SPEC_FILES=""
fi

# プロンプトをtempファイルに生成（Pythonで変数展開）
PROMPT_FILE="/tmp/claude_prompt_${AGENT_NUM}_$$.txt"
python3 -c "
import os, re, sys
tmpl = open('/app/agent_prompt_template.txt').read()
result = re.sub(r'\\\$([A-Z_][A-Z0-9_]*)', lambda m: os.environ.get(m.group(1), m.group(0)), tmpl)
sys.stdout.write(result)
" > "${PROMPT_FILE}"

claude --dangerously-skip-permissions "$(cat "${PROMPT_FILE}")"
rm -f "${PROMPT_FILE}"

# Claude終了後にハートビートも停止
kill $HEARTBEAT_PID 2>/dev/null || true
echo "[$(date '+%H:%M:%S')] 全作業完了" >> "${CLAUDE_LOG}"
