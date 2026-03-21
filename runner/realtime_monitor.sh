#!/bin/bash
# リアルタイム完了監視スクリプト
# 完了したagentを検知してSheets・Obsidianに反映する

PROCESSED_FILE="/tmp/pigeon_processed_agents.txt"
OBSIDIAN_PATH="/Users/yasaipopo/Dropbox/notes/iCloud/pigeoncloud/E2Eテスト/現状ステータス.md"
touch "$PROCESSED_FILE"

echo "[$(date '+%H:%M:%S')] 監視開始"

# 完了agentを検索
for done_file in reports/agent-*/done; do
    [ -f "$done_file" ] || continue
    agent_dir=$(dirname "$done_file")
    agent_num=$(basename "$agent_dir" | sed 's/agent-//')

    # 処理済みチェック
    grep -q "^$agent_num$" "$PROCESSED_FILE" 2>/dev/null && continue

    # 新規完了を検知
    echo "[$(date '+%H:%M:%S')] ✅ agent-$agent_num 完了を検知"
    echo "$agent_num" >> "$PROCESSED_FILE"

    # repair_reportがあれば内容確認
    if [ -f "$agent_dir/repair_report.md" ]; then
        echo "--- repair_report (agent-$agent_num) ---"
        head -20 "$agent_dir/repair_report.md"
    fi
done

# skip数・実装数を集計
STATS=$(python3 -c "
import re
from pathlib import Path
tests_dir = Path('tests')
skip = sum(len(re.findall(r'test\.skip', f.read_text())) for f in tests_dir.glob('*.spec.js'))
total = sum(len(re.findall(r'\btest\s*\(', f.read_text())) for f in tests_dir.glob('*.spec.js'))
done = total - skip
pct = round(done/total*100, 1) if total else 0
print(f'total={total} skip={skip} done={done} pct={pct}')
")
echo "[$(date '+%H:%M:%S')] 現在の集計: $STATS"

# 完了agent数
DONE_COUNT=$(cat "$PROCESSED_FILE" 2>/dev/null | wc -l | tr -d ' ')
echo "[$(date '+%H:%M:%S')] 累計完了agent数: $DONE_COUNT"
