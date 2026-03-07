#!/bin/bash
# ============================================================
# PigeonCloud テストエージェント エントリーポイント
# 1. Sheets → YAML同期
# 2. Playwrightテスト実行
# 3. 失敗があればClaudeが調査・判断・対応
# 4. 結果をSheetsに書き戻し
# ============================================================

set -e

# Deploy Key設定（read-only・push不可）
export GIT_SSH_COMMAND="ssh -i /root/.ssh/deploy_key -o StrictHostKeyChecking=no -o IdentitiesOnly=yes"

echo "============================================"
echo " PigeonCloud テストエージェント起動"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"

# PigeonCloudソースを最新化（Deploy Keyでpullのみ）
if [ -d "/app/src/pigeon_cloud/.git" ]; then
    echo ">> PigeonCloudソースを最新化..."
    cd /app/src/pigeon_cloud
    git pull --quiet
    echo "   最新コミット: $(git log -1 --format='%h %s')"
    cd /app
fi

# Phase 1: Google Sheets → YAMLシナリオ同期
echo ""
echo ">> Phase 1: Google Sheets からシナリオを同期"
python runner/sheets_sync.py --pull

# Phase 2: Playwrightテスト実行
echo ""
echo ">> Phase 2: Playwrightテスト実行"
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
    echo ">> Phase 3: Claude による失敗調査"

    claude --dangerously-skip-permissions "
あなたはPigeonCloudのQAエージェントです。
agent_instructions.md の指示に従って作業してください。

reports/results.json に失敗したテストが ${FAILED} 件あります。
各失敗を調査して、仕様変更かどうかを判断し、
- 仕様変更なら scenarios/ のYAMLを更新（その後 python runner/sheets_sync.py --push-scenarios でSheetsにも反映）
- 不具合なら reports/claude_report.md にまとめてSlack通知（python runner/reporter.py）
してください。
"
fi

# Phase 4: 結果をGoogle Sheetsに書き戻し
echo ""
echo ">> Phase 4: テスト結果をGoogle Sheetsに書き戻し"
python runner/sheets_sync.py --push

# Slack通知
echo ""
echo ">> Slack通知..."
python runner/reporter.py

echo ""
echo "============================================"
echo " 完了: $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"
