#!/bin/bash
# Staging フルラン（逐次実行）
# 使い方: bash run_all_specs.sh
set -e
cd "$(dirname "$0")"

RESULTS=""
PASS_TOTAL=0
FAIL_TOTAL=0
SKIP_TOTAL=0

run_spec() {
  local env_file="$1"
  local agent_num="$2"
  local specs="${@:3}"

  export $(cat "$env_file" | xargs)
  export AGENT_NUM=$agent_num

  echo ""
  echo "=============================="
  echo "AGENT=$agent_num: $specs"
  echo "=============================="

  # --reporter=list を使わない（playwright.config.js の list+json レポーターをそのまま使う）
  result=$(npx playwright test $specs 2>&1 || true)
  echo "$result"

  passed=$(echo "$result" | grep -Eo '[0-9]+ passed' | awk '{print $1}' | tail -1 || echo 0)
  failed=$(echo "$result" | grep -Eo '[0-9]+ failed' | awk '{print $1}' | tail -1 || echo 0)
  skipped=$(echo "$result" | grep -Eo '[0-9]+ skipped' | awk '{print $1}' | tail -1 || echo 0)
  notrun=$(echo "$result" | grep -Eo '[0-9]+ did not run' | awk '{print $1}' | tail -1 || echo 0)

  passed=${passed:-0}
  failed=${failed:-0}
  skipped=${skipped:-0}
  notrun=${notrun:-0}

  PASS_TOTAL=$((PASS_TOTAL + passed))
  FAIL_TOTAL=$((FAIL_TOTAL + failed))
  SKIP_TOTAL=$((SKIP_TOTAL + skipped + notrun))

  echo ">> AGENT=$agent_num: passed=$passed failed=$failed skipped=$skipped notrun=$notrun"
  RESULTS="${RESULTS}\nAGENT=${agent_num} specs=${specs}: passed=${passed} failed=${failed} skip/notrun=$((skipped + notrun))"
}

# 小さいもの
run_spec .test_env_runtime.staging.1   1  tests/auth.spec.js tests/comments-logs.spec.js tests/public-form.spec.js tests/filters.spec.js
run_spec .test_env_runtime.staging.84  84 tests/records.spec.js tests/reports.spec.js
run_spec .test_env_runtime.staging.83  83 tests/layout-ui.spec.js tests/csv-export.spec.js
run_spec .test_env_runtime.staging.82  82 tests/system-settings.spec.js
# 中くらい
run_spec .test_env_runtime.staging.80  80 tests/workflow.spec.js
run_spec .test_env_runtime.staging.81  81 tests/chart-calendar.spec.js
run_spec .test_env_runtime.staging.85  85 tests/chart-calendar-2.spec.js
run_spec .test_env_runtime.staging.71  71 tests/notifications.spec.js
run_spec .test_env_runtime.staging.92  92 tests/notifications-2.spec.js
run_spec .test_env_runtime.staging.72  72 tests/users-permissions.spec.js
# 大きいもの
run_spec .test_env_runtime.staging.70  70 tests/table-definition.spec.js
run_spec .test_env_runtime.staging.62  62 tests/uncategorized-2.spec.js
run_spec .test_env_runtime.staging.63  63 tests/uncategorized-3.spec.js
run_spec .test_env_runtime.staging.60  60 tests/fields.spec.js
run_spec .test_env_runtime.staging.90  90 tests/fields-2.spec.js
run_spec .test_env_runtime.staging.91  91 tests/fields-3.spec.js
run_spec .test_env_runtime.staging.61  61 tests/uncategorized.spec.js

echo ""
echo "============================================"
echo "FINAL SUMMARY [staging]"
echo "============================================"
echo -e "$RESULTS"
echo ""
echo "TOTAL: passed=$PASS_TOTAL failed=$FAIL_TOTAL skip/notrun=$SKIP_TOTAL"

# Mac通知
osascript -e "display notification \"Stagingテスト完了！ passed=$PASS_TOTAL failed=$FAIL_TOTAL\" with title \"【PigeonCloud】Claude Code\" sound name \"Pop\""

# Pushover通知
curl -s \
  --form-string "token=a1zjgbgm73r95onh5bt92g8zndz8o7" \
  --form-string "user=uu4cfne1wswo9agskr83jwguo8t5n9" \
  --form-string "title=【PigeonCloud】Stagingテスト完了" \
  --form-string "message=passed=$PASS_TOTAL failed=$FAIL_TOTAL skip/notrun=$SKIP_TOTAL" \
  https://api.pushover.net/1/messages.json > /dev/null
