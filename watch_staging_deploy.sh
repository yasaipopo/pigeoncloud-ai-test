#!/bin/bash
# ============================================================
# Stagingデプロイ監視 → 自動テスト開始スクリプト
#
# 使い方:
#   bash watch_staging_deploy.sh          # フォアグラウンド実行
#   bash watch_staging_deploy.sh &        # バックグラウンド実行
#   nohup bash watch_staging_deploy.sh &  # ターミナル終了後も継続
#
# 完了条件:
#   1. pigeoncloud-staging-pipeline の全ステージが Succeeded
#   2. ECS pigeoncloud-staging-v2 のデプロイが安定（running==desired）
# ============================================================

set -e
cd "$(dirname "$0")"

PROFILE="lof"
PIPELINE="pigeoncloud-staging-pipeline"
ECS_CLUSTER="pigeoncloud-staging-cluster-v2"
ECS_SERVICE="pigeoncloud-staging-v2"
POLL_INTERVAL=30  # 秒

LOG_FILE="/tmp/watch_staging_deploy.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "============================================"
echo "Stagingデプロイ監視開始: $(date '+%Y-%m-%d %H:%M:%S')"
echo "Pipeline: $PIPELINE"
echo "ECS: $ECS_CLUSTER / $ECS_SERVICE"
echo "============================================"

# ============================================================
# パイプライン完了チェック関数
# ============================================================
check_pipeline_succeeded() {
    local result
    result=$(aws --profile "$PROFILE" codepipeline get-pipeline-state \
        --name "$PIPELINE" \
        --query 'stageStates[*].latestExecution.status' \
        --output text 2>/dev/null)
    # 全ステージが Succeeded（InProgress / Failed などが含まれていない）
    if echo "$result" | grep -q "InProgress\|Failed\|Abandoned"; then
        return 1  # まだ実行中 or 失敗
    fi
    # None（未実行）だけの場合もまだ
    local succeeded_count
    succeeded_count=$(echo "$result" | tr '\t' '\n' | grep -c "Succeeded" || true)
    if [ "$succeeded_count" -lt 3 ]; then
        return 1
    fi
    return 0
}

# ============================================================
# パイプライン失敗チェック関数
# ============================================================
check_pipeline_failed() {
    local result
    result=$(aws --profile "$PROFILE" codepipeline get-pipeline-state \
        --name "$PIPELINE" \
        --query 'stageStates[*].latestExecution.status' \
        --output text 2>/dev/null)
    if echo "$result" | grep -q "Failed\|Abandoned"; then
        return 0
    fi
    return 1
}

# ============================================================
# ECSデプロイ安定チェック関数
# ============================================================
check_ecs_stable() {
    local deploy_count running desired
    deploy_count=$(aws --profile "$PROFILE" ecs describe-services \
        --cluster "$ECS_CLUSTER" \
        --services "$ECS_SERVICE" \
        --query 'length(services[0].deployments)' \
        --output text 2>/dev/null)
    running=$(aws --profile "$PROFILE" ecs describe-services \
        --cluster "$ECS_CLUSTER" \
        --services "$ECS_SERVICE" \
        --query 'services[0].runningCount' \
        --output text 2>/dev/null)
    desired=$(aws --profile "$PROFILE" ecs describe-services \
        --cluster "$ECS_CLUSTER" \
        --services "$ECS_SERVICE" \
        --query 'services[0].desiredCount' \
        --output text 2>/dev/null)
    echo "  ECS: deployments=$deploy_count running=$running desired=$desired"
    if [ "$deploy_count" -eq 1 ] && [ "$running" -eq "$desired" ] && [ "$running" -gt 0 ]; then
        return 0
    fi
    return 1
}

# ============================================================
# 監視ループ
# ============================================================
PIPELINE_DONE=false
ECS_DONE=false
FAILED=false
MAX_WAIT=60  # 最大30分（60回 × 30秒）
COUNT=0

while [ $COUNT -lt $MAX_WAIT ]; do
    COUNT=$((COUNT + 1))
    echo ""
    echo "[$(date '+%H:%M:%S')] チェック $COUNT/$MAX_WAIT"

    # パイプライン確認
    if [ "$PIPELINE_DONE" = "false" ]; then
        if check_pipeline_failed; then
            echo "  ❌ Pipeline FAILED"
            FAILED=true
            break
        fi
        if check_pipeline_succeeded; then
            echo "  ✅ Pipeline Succeeded"
            PIPELINE_DONE=true
        else
            stages=$(aws --profile "$PROFILE" codepipeline get-pipeline-state \
                --name "$PIPELINE" \
                --query 'stageStates[*].{stage:stageName,status:latestExecution.status}' \
                --output table 2>/dev/null || echo "  (取得失敗)")
            echo "$stages"
        fi
    else
        echo "  ✅ Pipeline Succeeded (確認済み)"
    fi

    # ECS確認（パイプライン完了後のみ）
    if [ "$PIPELINE_DONE" = "true" ] && [ "$ECS_DONE" = "false" ]; then
        if check_ecs_stable; then
            echo "  ✅ ECS Stable"
            ECS_DONE=true
        fi
    fi

    # 両方完了したらテスト開始
    if [ "$PIPELINE_DONE" = "true" ] && [ "$ECS_DONE" = "true" ]; then
        break
    fi

    sleep $POLL_INTERVAL
done

# ============================================================
# 結果処理
# ============================================================
if [ "$FAILED" = "true" ]; then
    echo ""
    echo "============================================"
    echo "❌ デプロイ失敗 — テストを中止します"
    echo "============================================"
    osascript -e 'display notification "Stagingデプロイ失敗！テストを中止しました" with title "【PigeonCloud】Claude Code" sound name "Pop"'
    curl -s \
      --form-string "token=a1zjgbgm73r95onh5bt92g8zndz8o7" \
      --form-string "user=uu4cfne1wswo9agskr83jwguo8t5n9" \
      --form-string "title=【PigeonCloud】Stagingデプロイ失敗" \
      --form-string "message=pigeoncloud-staging-pipeline が失敗しました。テストを中止。" \
      https://api.pushover.net/1/messages.json > /dev/null
    exit 1
fi

if [ "$PIPELINE_DONE" = "false" ] || [ "$ECS_DONE" = "false" ]; then
    echo ""
    echo "============================================"
    echo "⏱ タイムアウト — テストを中止します"
    echo "============================================"
    osascript -e 'display notification "デプロイ監視タイムアウト！手動で確認してください" with title "【PigeonCloud】Claude Code" sound name "Pop"'
    exit 1
fi

echo ""
echo "============================================"
echo "✅ デプロイ完了！Stagingテストを開始します"
echo "開始時刻: $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"

# Mac通知（テスト開始）
osascript -e 'display notification "Stagingデプロイ完了！テストを開始します" with title "【PigeonCloud】Claude Code" sound name "Pop"'

# テスト実行
cd "$(dirname "$0")"
bash run_all_specs.sh
