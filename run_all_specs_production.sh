#!/bin/bash
# 本番環境フルラン（逐次実行）
# 使い方: bash run_all_specs_production.sh
set -e
cd "$(dirname "$0")"

export ADMIN_BASE_URL="https://ai-test.pigeon-cloud.com"
export ADMIN_EMAIL="admin"
export ADMIN_PASSWORD="BBjqqjSMxT4K"
export ENV_TYPE="production"

RESULTS=""
PASS_TOTAL=0
FAIL_TOTAL=0
SKIP_TOTAL=0

run_spec() {
  local agent_num="$1"
  local specs="${@:2}"

  export AGENT_NUM=$agent_num

  echo ""
  echo "=============================="
  echo "AGENT=$agent_num [本番]: $specs"
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

  echo ">> AGENT=$agent_num [本番]: passed=$passed failed=$failed skipped=$skipped notrun=$notrun"
  RESULTS="${RESULTS}\nAGENT=${agent_num} specs=${specs}: passed=${passed} failed=${failed} skip/notrun=$((skipped + notrun))"
}

# 小さいもの
run_spec 201  tests/auth.spec.js tests/comments-logs.spec.js tests/public-form.spec.js tests/filters.spec.js
run_spec 284  tests/records.spec.js tests/reports.spec.js
run_spec 283  tests/layout-ui.spec.js tests/csv-export.spec.js
run_spec 282  tests/system-settings.spec.js
# 中くらい
run_spec 280  tests/workflow.spec.js
run_spec 281  tests/chart-calendar.spec.js
run_spec 285  tests/chart-calendar-2.spec.js
run_spec 271  tests/notifications.spec.js
run_spec 292  tests/notifications-2.spec.js
run_spec 272  tests/users-permissions.spec.js
# 大きいもの
run_spec 270  tests/table-definition.spec.js
run_spec 262  tests/uncategorized-2.spec.js
run_spec 263  tests/uncategorized-3.spec.js
run_spec 260  tests/fields.spec.js
run_spec 290  tests/fields-2.spec.js
run_spec 291  tests/fields-3.spec.js
run_spec 261  tests/uncategorized.spec.js

echo ""
echo "============================================"
echo "FINAL SUMMARY [本番環境]"
echo "============================================"
echo -e "$RESULTS"
echo ""
echo "TOTAL: passed=$PASS_TOTAL failed=$FAIL_TOTAL skip/notrun=$SKIP_TOTAL"

# Mac通知
osascript -e "display notification \"本番テスト完了！ passed=$PASS_TOTAL failed=$FAIL_TOTAL\" with title \"【PigeonCloud】Claude Code\" sound name \"Pop\""

# Pushover通知
curl -s \
  --form-string "token=a1zjgbgm73r95onh5bt92g8zndz8o7" \
  --form-string "user=uu4cfne1wswo9agskr83jwguo8t5n9" \
  --form-string "title=【PigeonCloud】本番テスト完了" \
  --form-string "message=passed=$PASS_TOTAL failed=$FAIL_TOTAL skip/notrun=$SKIP_TOTAL" \
  https://api.pushover.net/1/messages.json > /dev/null
