#!/bin/bash
# ============================================================
# PigeonCloud テストエージェント エントリーポイント
# 1. Playwrightテスト実行
# 2. 失敗があればClaudeが調査・判断・対応
# ============================================================

set -e

echo "============================================"
echo " PigeonCloud テストエージェント起動"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"

# ソースコードの最新化（gitignore対象ディレクトリ）
if [ -d "/app/src/pigeon_cloud/.git" ]; then
    echo ">> PigeonCloudソースを最新化..."
    cd /app/src/pigeon_cloud
    git pull --quiet
    cd /app
fi

# Phase 1: Playwrightテスト実行
echo ""
echo ">> Phase 1: Playwrightテスト実行"
python runner/test_runner.py

# 失敗件数をチェック
FAILED=$(python3 -c "
import json
with open('reports/results.json') as f:
    results = json.load(f)
print(sum(1 for r in results if r['status'] == 'failed'))
" 2>/dev/null || echo "0")

echo ""
echo "失敗件数: $FAILED"

if [ "$FAILED" -gt "0" ]; then
    echo ""
    echo ">> Phase 2: Claude による失敗調査"

    # Claudeに調査を依頼
    claude --dangerously-skip-permissions "
あなたはPigeonCloudのQAエージェントです。
agent_instructions.md の指示に従って作業してください。

reports/results.json に失敗したテストが ${FAILED} 件あります。
各失敗を調査して、仕様変更かどうかを判断し、
- 仕様変更なら scenarios/ のYAMLを更新
- 不具合なら reports/claude_report.md にまとめてSlack通知（python runner/reporter.py）
してください。
"
else
    echo ""
    echo ">> 全テスト通過。Slack通知..."
    python runner/reporter.py
fi

echo ""
echo "============================================"
echo " 完了: $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"
