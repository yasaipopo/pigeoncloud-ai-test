#!/bin/bash
# ============================================================
# Stagingデプロイ監視 → 絞り込みテスト実行
# 対象: ラジオ表示条件修正の影響範囲
#   - fields.spec.js       (260-1 新規 + 223〜231系 表示条件)
#   - table-definition.spec.js (フィールド定義)
#   - records.spec.js      (レコード登録画面での表示条件動作)
# ============================================================

cd "$(dirname "$0")"

PROFILE="lof"
PIPELINE="pigeoncloud-staging-pipeline"
ECS_CLUSTER="pigeoncloud-staging-cluster-v2"
ECS_SERVICE="pigeoncloud-staging-v2"
POLL_INTERVAL=30

LOG_FILE="/tmp/watch_staging_targeted.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "============================================"
echo "Staging監視（絞り込みテスト）: $(date '+%Y-%m-%d %H:%M:%S')"
echo "対象: fields / table-definition / records"
echo "============================================"

check_pipeline_succeeded() {
    local result
    result=$(aws --profile "$PROFILE" codepipeline get-pipeline-state \
        --name "$PIPELINE" \
        --query 'stageStates[*].latestExecution.status' \
        --output text 2>/dev/null)
    if echo "$result" | grep -q "InProgress\|Failed\|Abandoned"; then return 1; fi
    local succeeded_count
    succeeded_count=$(echo "$result" | tr '\t' '\n' | grep -c "Succeeded" || true)
    [ "$succeeded_count" -ge 3 ] && return 0 || return 1
}

check_pipeline_failed() {
    local result
    result=$(aws --profile "$PROFILE" codepipeline get-pipeline-state \
        --name "$PIPELINE" \
        --query 'stageStates[*].latestExecution.status' \
        --output text 2>/dev/null)
    echo "$result" | grep -q "Failed\|Abandoned" && return 0 || return 1
}

check_ecs_stable() {
    local deploy_count running desired
    deploy_count=$(aws --profile "$PROFILE" ecs describe-services \
        --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
        --query 'length(services[0].deployments)' --output text 2>/dev/null)
    running=$(aws --profile "$PROFILE" ecs describe-services \
        --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
        --query 'services[0].runningCount' --output text 2>/dev/null)
    desired=$(aws --profile "$PROFILE" ecs describe-services \
        --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
        --query 'services[0].desiredCount' --output text 2>/dev/null)
    echo "  ECS: deployments=$deploy_count running=$running desired=$desired"
    [ "$deploy_count" -eq 1 ] && [ "$running" -eq "$desired" ] && [ "$running" -gt 0 ] && return 0 || return 1
}

# 監視ループ
PIPELINE_DONE=false
ECS_DONE=false
FAILED=false
MAX_WAIT=60
COUNT=0

# 最新デプロイの開始を検知するため、現在のPipeline実行IDを記録
LAST_PIPELINE_ID=$(aws --profile "$PROFILE" codepipeline get-pipeline-state \
    --name "$PIPELINE" \
    --query 'stageStates[0].latestExecution.pipelineExecutionId' \
    --output text 2>/dev/null || echo "none")
echo "現在のPipeline実行ID: $LAST_PIPELINE_ID"
echo "次のデプロイ完了を待機中..."

while [ $COUNT -lt $MAX_WAIT ]; do
    COUNT=$((COUNT + 1))
    sleep $POLL_INTERVAL

    echo "[$(date '+%H:%M:%S')] チェック $COUNT/$MAX_WAIT"

    # 新しいPipeline実行が始まったか確認
    CURRENT_ID=$(aws --profile "$PROFILE" codepipeline get-pipeline-state \
        --name "$PIPELINE" \
        --query 'stageStates[0].latestExecution.pipelineExecutionId' \
        --output text 2>/dev/null || echo "none")

    if [ "$CURRENT_ID" = "$LAST_PIPELINE_ID" ] && [ "$PIPELINE_DONE" = "false" ]; then
        echo "  Pipeline: 同じ実行ID（新デプロイ未開始）"
        continue
    fi

    # パイプライン確認
    if [ "$PIPELINE_DONE" = "false" ]; then
        if check_pipeline_failed; then
            echo "  ❌ Pipeline FAILED"; FAILED=true; break
        fi
        if check_pipeline_succeeded; then
            echo "  ✅ Pipeline Succeeded"; PIPELINE_DONE=true
        else
            aws --profile "$PROFILE" codepipeline get-pipeline-state \
                --name "$PIPELINE" \
                --query 'stageStates[*].{stage:stageName,status:latestExecution.status}' \
                --output table 2>/dev/null || true
        fi
    else
        echo "  ✅ Pipeline Succeeded (確認済み)"
    fi

    # ECS確認
    if [ "$PIPELINE_DONE" = "true" ] && [ "$ECS_DONE" = "false" ]; then
        if check_ecs_stable; then
            echo "  ✅ ECS Stable"; ECS_DONE=true
        fi
    fi

    [ "$PIPELINE_DONE" = "true" ] && [ "$ECS_DONE" = "true" ] && break
done

# 失敗・タイムアウト処理
if [ "$FAILED" = "true" ]; then
    echo "❌ デプロイ失敗"; exit 1
fi
if [ "$PIPELINE_DONE" = "false" ] || [ "$ECS_DONE" = "false" ]; then
    echo "⏱ タイムアウト"; exit 1
fi

echo ""
echo "============================================"
echo "✅ デプロイ完了！絞り込みテストを開始します"
echo "開始: $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"
osascript -e 'display notification "Stagingデプロイ完了！絞り込みテストを開始します" with title "【PigeonCloud】Claude Code" sound name "Pop"'

# ALLテストテーブルを削除（関係する環境のみ）
echo "ALLテストテーブルを削除中..."
node -e "
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const envFiles = [
    '.test_env_runtime.60',  // fields
    '.test_env_runtime.70',  // table-definition
    '.test_env_runtime.84',  // records
].map(f => path.join('$(pwd)', f));
(async () => {
    for (const envFile of envFiles) {
        if (!fs.existsSync(envFile)) { console.log(envFile + ': ファイルなし'); continue; }
        const env = {};
        fs.readFileSync(envFile, 'utf8').trim().split('\n').forEach(l => { const [k,v] = l.split('='); env[k]=v; });
        const br = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        try {
            const page = await br.newPage();
            await page.goto(env.TEST_BASE_URL + '/admin/login');
            await page.fill('#id', env.TEST_EMAIL);
            await page.fill('#password', env.TEST_PASSWORD);
            await page.click('button[type=submit].btn-primary');
            await page.waitForSelector('.navbar', { timeout: 20000 }).catch(() => {});
            const r = await page.evaluate(async (base) => {
                const res = await fetch(base + '/api/admin/debug/delete-all-type-tables', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({}), credentials: 'include'
                });
                return res.status;
            }, env.TEST_BASE_URL);
            console.log(path.basename(envFile) + ': DELETE ' + r);
        } catch(e) { console.log(path.basename(envFile) + ': エラー ' + e.message); }
        finally { await br.close(); }
    }
})();
" 2>&1

echo ""
echo "--- テスト開始 ---"

run_spec() {
    local env_file="$1"
    local agent_num="$2"
    local specs="${@:3}"
    export $(cat "$env_file" | xargs)
    export AGENT_NUM=$agent_num
    echo ""; echo "AGENT=$agent_num: $specs"
    result=$(npx playwright test $specs 2>&1 || true)
    echo "$result"
    passed=$(echo "$result" | grep -Eo '[0-9]+ passed' | awk '{print $1}' | tail -1 || echo 0)
    failed=$(echo "$result" | grep -Eo '[0-9]+ failed' | awk '{print $1}' | tail -1 || echo 0)
    echo ">> AGENT=$agent_num: passed=$passed failed=$failed"
    PASS_TOTAL=$((PASS_TOTAL + ${passed:-0}))
    FAIL_TOTAL=$((FAIL_TOTAL + ${failed:-0}))
}

PASS_TOTAL=0
FAIL_TOTAL=0

run_spec .test_env_runtime.84  84 tests/records.spec.js
run_spec .test_env_runtime.70  70 tests/table-definition.spec.js
run_spec .test_env_runtime.60  60 tests/fields.spec.js

echo ""
echo "============================================"
echo "FINAL SUMMARY [Staging 絞り込みテスト]"
echo "TOTAL: passed=$PASS_TOTAL failed=$FAIL_TOTAL"
echo "============================================"

osascript -e "display notification \"絞り込みテスト完了！ passed=$PASS_TOTAL failed=$FAIL_TOTAL\" with title \"【PigeonCloud】Claude Code\" sound name \"Pop\""
curl -s \
  --form-string "token=a1zjgbgm73r95onh5bt92g8zndz8o7" \
  --form-string "user=uu4cfne1wswo9agskr83jwguo8t5n9" \
  --form-string "title=【PigeonCloud】Staging絞り込みテスト完了" \
  --form-string "message=passed=$PASS_TOTAL failed=$FAIL_TOTAL" \
  https://api.pushover.net/1/messages.json > /dev/null
