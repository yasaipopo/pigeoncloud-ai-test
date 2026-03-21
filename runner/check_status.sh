#!/bin/bash
# オーケストレーター状態チェック（stuck判定付き）
# 使い方: bash runner/check_status.sh

CONTAINER="pigeon_test_orchestrator"
STUCK_THRESHOLD=300  # 5分（秒）

# コンテナ確認
STATUS=$(docker ps --filter "name=$CONTAINER" --format "{{.Status}}" 2>/dev/null)
if [ -z "$STATUS" ]; then
    echo "❌ コンテナ停止中"
    exit 1
fi
echo "🐳 コンテナ: $STATUS"

# Claude活動確認（セッションファイルの最新更新時刻）
LATEST_SESSION=$(docker exec "$CONTAINER" find /home/agent/.claude/projects/-app/ -name "*.jsonl" -not -path "*/memory/*" 2>/dev/null | \
    xargs -I{} docker exec "$CONTAINER" stat -c "%Y {}" {} 2>/dev/null | sort -rn | head -1 | awk '{print $2}')

if [ -z "$LATEST_SESSION" ]; then
    echo "⚠️  セッションファイル取得失敗"
else
    LAST_TS=$(docker exec "$CONTAINER" stat -c %Y "$LATEST_SESSION" 2>/dev/null)
    LAST_ACTIVITY=$(docker exec "$CONTAINER" stat "$LATEST_SESSION" 2>/dev/null | grep Modify | awk '{print $2, $3}')
    NOW_TS=$(docker exec "$CONTAINER" date +%s 2>/dev/null)
    ELAPSED=$(( NOW_TS - LAST_TS ))
    ELAPSED_MIN=$(( ELAPSED / 60 ))

    if [ "$ELAPSED" -gt "$STUCK_THRESHOLD" ]; then
        echo "🚨 STUCK: 最終活動 ${ELAPSED_MIN}分前 ($LAST_ACTIVITY) → 詰まっている可能性大"
    else
        echo "✅ ACTIVE: 最終活動 ${ELAPSED}秒前 ($LAST_ACTIVITY)"
    fi
fi

# agent進捗サマリー（今ラウンドの基準: doneファイルが存在する最大番号+1 or 最新-20）
LATEST_NUM=$(ls /Users/yasaipopo/PycharmProjects/pigeon-test/reports/ | grep '^agent-' | sed 's/agent-//' | sort -n | tail -1)
ROUND_BASE=$(( LATEST_NUM > 20 ? LATEST_NUM - 20 : 0 ))
# doneファイルが存在する最小番号を今ラウンド基準とする
FIRST_DONE=$(find /Users/yasaipopo/PycharmProjects/pigeon-test/reports/ -name "done" 2>/dev/null | \
    sed 's|.*/agent-||; s|/done||' | sort -n | head -1)
[ -n "$FIRST_DONE" ] && ROUND_BASE=$(( FIRST_DONE > 0 ? FIRST_DONE - 1 : 0 ))

TOTAL=0; DONE_COUNT=0; RUNNING=0
for dir in /Users/yasaipopo/PycharmProjects/pigeon-test/reports/agent-*/; do
    num=$(basename "$dir" | sed 's/agent-//')
    [ "$num" -lt "$ROUND_BASE" ] 2>/dev/null && continue  # 今ラウンド以前はスキップ
    TOTAL=$((TOTAL+1))
    if [ -f "$dir/done" ]; then
        DONE_COUNT=$((DONE_COUNT+1))
    else
        RUNNING=$((RUNNING+1))
        # 最新ファイルの更新時刻
        LATEST=$(ls -t "$dir" 2>/dev/null | head -1)
        echo "  🔄 agent-$num: $LATEST $(ls "$dir" 2>/dev/null | tr '\n' ' ')"
    fi
done
echo ""
echo "📊 今ラウンド: DONE=$DONE_COUNT / RUNNING=$RUNNING / 計=$TOTAL"

# 最新agent番号
LATEST_AGENT=$(ls /Users/yasaipopo/PycharmProjects/pigeon-test/reports/ | grep '^agent-' | sed 's/agent-//' | sort -n | tail -1)
echo "📌 最新agent番号: agent-$LATEST_AGENT"
