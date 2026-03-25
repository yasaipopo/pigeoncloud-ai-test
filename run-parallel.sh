#!/bin/bash
# =============================================================================
# 並列E2Eテスト実行スクリプト
#
# 使い方:
#   ./run-parallel.sh              # デフォルト4並列
#   WORKERS=6 ./run-parallel.sh    # 6並列
#   WORKERS=1 ./run-parallel.sh    # 直列（デバッグ用）
# =============================================================================

WORKERS=${WORKERS:-4}
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# .envファイルがあれば読み込む
if [ -f ".env" ]; then
  set -a
  source .env
  set +a
fi

echo "======================================================"
echo "  PigeonCloud E2E 並列テスト実行"
echo "  Workers: $WORKERS"
echo "  E2E_API_URL: ${E2E_API_URL:-(未設定)}"
echo "======================================================"

# spec.jsファイル一覧（重いファイルを先頭に）
SPECS=(
  "tests/uncategorized.spec.js"
  "tests/uncategorized-2.spec.js"
  "tests/uncategorized-3.spec.js"
  "tests/table-definition.spec.js"
  "tests/users-permissions.spec.js"
  "tests/workflow.spec.js"
  "tests/fields-3.spec.js"
  "tests/notifications.spec.js"
  "tests/notifications-2.spec.js"
  "tests/fields.spec.js"
  "tests/fields-2.spec.js"
  "tests/fields-4.spec.js"
  "tests/fields-5.spec.js"
  "tests/chart-calendar.spec.js"
  "tests/chart-calendar-2.spec.js"
  "tests/layout-ui.spec.js"
  "tests/system-settings.spec.js"
  "tests/csv-export.spec.js"
  "tests/records.spec.js"
  "tests/auth.spec.js"
  "tests/dashboard.spec.js"
  "tests/filters.spec.js"
  "tests/comments-logs.spec.js"
  "tests/reports.spec.js"
  "tests/public-form.spec.js"
  "tests/templates.spec.js"
  "tests/rpa.spec.js"
  "tests/payment.spec.js"
)

TOTAL=${#SPECS[@]}
echo "📋 Total spec files: $TOTAL"
echo ""

# ラウンドロビンでグループ分割（pythonで確実に）
GROUP_RESULT=$(python3 -c "
import sys
specs = $(python3 -c "
s=[
  'tests/uncategorized.spec.js','tests/uncategorized-2.spec.js','tests/uncategorized-3.spec.js',
  'tests/table-definition.spec.js','tests/users-permissions.spec.js','tests/workflow.spec.js',
  'tests/fields-3.spec.js','tests/notifications.spec.js','tests/notifications-2.spec.js',
  'tests/fields.spec.js','tests/fields-2.spec.js','tests/fields-4.spec.js','tests/fields-5.spec.js',
  'tests/chart-calendar.spec.js','tests/chart-calendar-2.spec.js','tests/layout-ui.spec.js',
  'tests/system-settings.spec.js','tests/csv-export.spec.js','tests/records.spec.js',
  'tests/auth.spec.js','tests/dashboard.spec.js','tests/filters.spec.js',
  'tests/comments-logs.spec.js','tests/reports.spec.js','tests/public-form.spec.js',
  'tests/templates.spec.js','tests/rpa.spec.js','tests/payment.spec.js'
]
print(repr(s))
")
workers = $WORKERS
groups = [[] for _ in range(workers)]
for i, s in enumerate(specs):
    groups[i % workers].append(s)
for i, g in enumerate(groups):
    print(f'GROUP_{i+1}=\"' + ' '.join(g) + '\"')
")

# グループを変数に設定
eval "$GROUP_RESULT"

echo "📦 グループ分割:"
for i in $(seq 1 $WORKERS); do
  varname="GROUP_$i"
  specs="${!varname}"
  count=$(echo $specs | wc -w | tr -d ' ')
  echo "  Worker $i ($count files): $specs"
done
echo ""

# ログ・レポートディレクトリ作成
mkdir -p logs
for i in $(seq 1 $WORKERS); do
  mkdir -p "reports/agent-$i/screenshots"
done

# =============================================================================
# 各グループを並列実行
# =============================================================================
PIDS_FILE="/tmp/pigeon-e2e-pids-$$.txt"
> "$PIDS_FILE"
START_TIME=$(date +%s)

for i in $(seq 1 $WORKERS); do
  varname="GROUP_$i"
  specs="${!varname}"

  if [ -z "$specs" ]; then
    echo "⚠️  Worker $i: テストなし（スキップ）"
    continue
  fi

  logfile="logs/worker-${i}-$(date +%Y%m%d_%H%M%S).log"
  echo "🚀 Worker $i 起動中... → $logfile"

  (
    export AGENT_NUM=$i
    export REPORTS_DIR="reports/agent-$i"
    if [ -f ".test_env_runtime.$i" ]; then
      set -a
      source ".test_env_runtime.$i"
      set +a
    fi
    npx playwright test $specs 2>&1
  ) > "$logfile" 2>&1 &

  echo "$! $i" >> "$PIDS_FILE"
  echo "   PID: $!"

  if [ $i -lt $WORKERS ]; then
    sleep 3
  fi
done

echo ""
echo "⏳ 全ワーカーの完了を待機中..."
echo ""

# =============================================================================
# 全プロセス完了待ち
# =============================================================================
FAILED_WORKERS=""
PASSED_WORKERS=""

while IFS=" " read -r pid w; do
  if wait $pid; then
    PASSED_WORKERS="$PASSED_WORKERS $w"
  else
    FAILED_WORKERS="$FAILED_WORKERS $w"
  fi
done < "$PIDS_FILE"
rm -f "$PIDS_FILE"

END_TIME=$(date +%s)
ELAPSED=$(( END_TIME - START_TIME ))
MINS=$((ELAPSED / 60))
SECS=$((ELAPSED % 60))

echo ""
echo "======================================================"
echo "  テスト結果サマリー  (所要時間: ${MINS}分${SECS}秒)"
echo "======================================================"

# 各ワーカーの結果集計
TOTAL_PASSED=0
TOTAL_FAILED=0

for w in $(seq 1 $WORKERS); do
  results_file="reports/agent-$w/playwright-results.json"
  if [ -f "$results_file" ]; then
    result=$(python3 -c "
import json, sys
try:
    d = json.load(open('$results_file'))
    def count_results(suites, status):
        total = 0
        for s in suites:
            for spec in s.get('specs', []):
                for test in spec.get('tests', []):
                    for r in test.get('results', []):
                        if r.get('status') == status:
                            total += 1
            total += count_results(s.get('suites', []), status)
        return total
    p = count_results(d.get('suites', []), 'passed')
    f = count_results(d.get('suites', []), 'failed')
    print(f'{p} {f}')
except:
    print('0 0')
" 2>/dev/null)
    passed=$(echo $result | cut -d' ' -f1)
    failed=$(echo $result | cut -d' ' -f2)
    TOTAL_PASSED=$((TOTAL_PASSED + passed))
    TOTAL_FAILED=$((TOTAL_FAILED + failed))
    icon="✅"
    [ "$w" -gt 0 ] && echo $FAILED_WORKERS | grep -q "$w" && icon="❌"
    echo "  Worker $w: ✅ $passed passed, ❌ $failed failed"
  fi
done

echo ""
echo "  合計: ✅ $TOTAL_PASSED passed, ❌ $TOTAL_FAILED failed"
echo "  所要時間: ${MINS}分${SECS}秒"
echo ""

if [ -z "$FAILED_WORKERS" ]; then
  echo "🎉 全ワーカー正常完了"
  RESULT_MSG="全PASS: ✅${TOTAL_PASSED} passed"
  EXIT_CODE=0
else
  echo "⚠️  失敗ワーカー: $FAILED_WORKERS"
  RESULT_MSG="✅${TOTAL_PASSED} passed, ❌${TOTAL_FAILED} failed"
  EXIT_CODE=1
fi

# Mac通知
osascript -e "display notification \"E2Eテスト完了 (${MINS}分): $RESULT_MSG\" with title \"【PigeonCloud】Claude Code\" sound name \"Pop\"" 2>/dev/null || true

echo ""
echo "📊 E2Eビューアー: https://dezmzppc07xat.cloudfront.net"
echo "======================================================"

exit $EXIT_CODE
