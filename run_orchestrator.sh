#!/bin/bash
# ============================================================
# PigeonCloud E2Eテスト オーケストレーター起動スクリプト
# Docker内でClaude Codeを親として起動し、sub-agentで並列実行
# ============================================================

set -e

MAX_WORKERS=${MAX_WORKERS:-5}
MAX_ROUNDS=${MAX_ROUNDS:-8}

echo "============================================"
echo " PigeonCloud E2E Orchestrator (Claude Code)"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo " MAX_WORKERS: ${MAX_WORKERS} / MAX_ROUNDS: ${MAX_ROUNDS}"
echo "============================================"

# git safe.directory
git config --global --add safe.directory /app/src/pigeon_cloud 2>/dev/null || true

# Playwrightブラウザ確認
echo ">> Playwrightブラウザ確認..."
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx playwright install chromium 2>/dev/null || true

# プロンプト生成（環境変数を展開）
PROMPT_FILE="/tmp/orchestrator_prompt_$$.txt"
python3 -c "
import os, re, sys
tmpl = open('/app/orchestrator_prompt.txt').read()
result = re.sub(r'\\\$([A-Z_][A-Z0-9_]*)', lambda m: os.environ.get(m.group(1), m.group(0)), tmpl)
sys.stdout.write(result)
" > "${PROMPT_FILE}"

echo ">> Claude Code Orchestrator 起動..."
# stdinを閉じてTTY待ち受けによるハングを防止
claude --dangerously-skip-permissions -p "$(cat "${PROMPT_FILE}")" < /dev/null

rm -f "${PROMPT_FILE}"
echo "============================================"
echo " Orchestrator 終了: $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"
