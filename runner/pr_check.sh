#!/usr/bin/env bash
# PR Validation Check - テストマージ方式
# 使い方: ./runner/pr_check.sh <PR番号またはURL>
# 例: ./runner/pr_check.sh 2746
#     ./runner/pr_check.sh https://github.com/Loftal/pigeon_cloud/pull/2746
#
# チェック内容:
#   1. PRブランチをベースブランチにテストマージ
#   2. PHP構文チェック (php -l) - 変更されたPHPファイル全件
#   3. TypeScript変更ファイルの報告
#   4. 結果をSlack通知

set -euo pipefail

PIGEON_PATH="$(cd "$(dirname "$0")/.." && pwd)/src/pigeon_cloud"
SLACK_WEBHOOK="SLACK_WEBHOOK_PLACEHOLDER"
SLACK_USER="U869KKT8C"

# ---------------------- 引数パース ----------------------
PR_ARG="${1:-}"
if [[ -z "$PR_ARG" ]]; then
    echo "使い方: $0 <PR番号またはURL>"
    echo "例: $0 2746"
    exit 1
fi

# URLからPR番号を抽出
PR_NUM=$(echo "$PR_ARG" | grep -oE '[0-9]+$' | head -1)
if [[ -z "$PR_NUM" ]]; then
    echo "❌ PR番号を解析できませんでした: $PR_ARG"
    exit 1
fi

echo "========================================"
echo "🔍 PR #$PR_NUM の検証チェック開始（テストマージ方式）"
echo "========================================"

# ---------------------- PR情報取得 ----------------------
echo ""
echo "📋 PR情報を取得中..."
PR_INFO=$(gh pr view "$PR_NUM" \
    --repo Loftal/pigeon_cloud \
    --json number,title,headRefName,baseRefName,author,url \
    2>/dev/null) || {
    echo "❌ PR情報の取得に失敗しました（gh CLIのログインを確認してください）"
    exit 1
}

PR_TITLE=$(echo "$PR_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['title'])")
PR_BRANCH=$(echo "$PR_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['headRefName'])")
PR_BASE=$(echo "$PR_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['baseRefName'])")
PR_AUTHOR=$(echo "$PR_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['author']['login'])")
PR_URL=$(echo "$PR_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['url'])")

echo "  タイトル: $PR_TITLE"
echo "  ブランチ: $PR_BRANCH → $PR_BASE"
echo "  作成者: $PR_AUTHOR"
echo "  URL: $PR_URL"

# ---------------------- 変更ファイル取得 ----------------------
echo ""
echo "📁 変更ファイルを取得中..."
CHANGED_FILES=$(gh pr diff "$PR_NUM" \
    --repo Loftal/pigeon_cloud \
    --name-only 2>/dev/null) || {
    echo "❌ 変更ファイルの取得に失敗しました"
    exit 1
}

PHP_FILES=$(echo "$CHANGED_FILES" | grep '\.php$' || true)
TS_FILES=$(echo "$CHANGED_FILES" | grep '\.ts$' || true)
HTML_FILES=$(echo "$CHANGED_FILES" | grep '\.html$' || true)
ALL_COUNT=$(echo "$CHANGED_FILES" | grep -c '.' || true)
PHP_COUNT=$(echo "$PHP_FILES" | grep -c '.' 2>/dev/null || echo 0)
TS_COUNT=$(echo "$TS_FILES" | grep -c '.' 2>/dev/null || echo 0)
HTML_COUNT=$(echo "$HTML_FILES" | grep -c '.' 2>/dev/null || echo 0)

echo "  総変更ファイル数: $ALL_COUNT"
echo "  PHP: ${PHP_COUNT}件"
echo "  TypeScript: ${TS_COUNT}件"
echo "  HTML: ${HTML_COUNT}件"

# ---------------------- ブランチ取得・テストマージ ----------------------
echo ""
echo "⬇️  ブランチをフェッチ中..."

ORIGINAL_BRANCH=$(cd "$PIGEON_PATH" && git branch --show-current 2>/dev/null || echo "staging")
TIMESTAMP=$(date +%s)
TEMP_BASE_BRANCH="pr-check-base-${PR_NUM}-${TIMESTAMP}"
PR_FETCH_BRANCH="pr-check-pr-${PR_NUM}-${TIMESTAMP}"

# リモートのベースブランチを最新化
(cd "$PIGEON_PATH" && git fetch origin "${PR_BASE}:${TEMP_BASE_BRANCH}" --quiet 2>/dev/null) || {
    # fallback: ローカルのstagingから作成
    (cd "$PIGEON_PATH" && git fetch origin "${PR_BASE}" --quiet 2>/dev/null || true)
    (cd "$PIGEON_PATH" && git checkout -b "${TEMP_BASE_BRANCH}" "origin/${PR_BASE}" --quiet 2>/dev/null) || {
        (cd "$PIGEON_PATH" && git checkout -b "${TEMP_BASE_BRANCH}" "${PR_BASE}" --quiet 2>/dev/null)
    }
}

# PRブランチをフェッチ
(cd "$PIGEON_PATH" && \
    git fetch origin "pull/${PR_NUM}/head:${PR_FETCH_BRANCH}" --quiet 2>/dev/null) || {
    echo "❌ PRブランチのフェッチに失敗しました"
    (cd "$PIGEON_PATH" && git branch -D "${TEMP_BASE_BRANCH}" --quiet 2>/dev/null || true)
    exit 1
}

echo "  ✅ フェッチ完了"

# クリーンアップ関数
cleanup() {
    (cd "$PIGEON_PATH" && \
        git merge --abort 2>/dev/null || true && \
        git checkout "${ORIGINAL_BRANCH}" --quiet 2>/dev/null || true && \
        git branch -D "${TEMP_BASE_BRANCH}" --quiet 2>/dev/null || true && \
        git branch -D "${PR_FETCH_BRANCH}" --quiet 2>/dev/null || true)
}
trap cleanup EXIT

# テストマージを実行
echo ""
echo "🔀 テストマージを実行中..."
cd "$PIGEON_PATH"
git checkout "${TEMP_BASE_BRANCH}" --quiet

MERGE_SUCCESS=true
git merge "${PR_FETCH_BRANCH}" --no-edit --quiet 2>/dev/null || {
    MERGE_SUCCESS=false
    echo "  ⚠️  マージコンフリクト発生"
    CONFLICT_FILES=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
    echo ""
    echo "  コンフリクトファイル:"
    echo "$CONFLICT_FILES" | while IFS= read -r f; do echo "    ⚠️  $f"; done
    git merge --abort 2>/dev/null || true
    echo ""
    echo "  ⚠️  コンフリクトのため、PRブランチ単体でPHP構文チェックを実行します"
    git checkout "${PR_FETCH_BRANCH}" --quiet
}

if [[ "$MERGE_SUCCESS" == "true" ]]; then
    echo "  ✅ テストマージ成功（ベース: ${PR_BASE}）"
fi

cd - > /dev/null

# ---------------------- PHP構文チェック ----------------------
echo ""
echo "🔬 PHP構文チェック (php -l) 実行中..."

PHP_PASS=0
PHP_FAIL=0
PHP_ERRORS=()

if [[ -n "$PHP_FILES" ]] && [[ "$PHP_COUNT" -gt 0 ]]; then
    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        full_path="$PIGEON_PATH/$file"
        if [[ -f "$full_path" ]]; then
            result=$(php -l "$full_path" 2>&1)
            if echo "$result" | grep -q "No syntax errors"; then
                echo "  ✅ $file"
                PHP_PASS=$((PHP_PASS + 1))
            else
                echo "  ❌ $file"
                echo "     $(echo "$result" | grep -E 'Parse error|Fatal error' | head -1)"
                PHP_FAIL=$((PHP_FAIL + 1))
                PHP_ERRORS+=("$file: $(echo "$result" | grep -E 'Parse error|Fatal error' | head -1)")
            fi
        else
            echo "  ⚠️  $file (ファイルなし - 削除済み？)"
        fi
    done <<< "$PHP_FILES"
else
    echo "  PHPファイルの変更なし"
fi

# ---------------------- TypeScript変更ファイル報告 ----------------------
echo ""
echo "📝 TypeScript/HTML変更ファイル（手動確認推奨）:"

if [[ -n "$TS_FILES" ]] && [[ "$TS_COUNT" -gt 0 ]]; then
    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        echo "  📄 $file"
    done <<< "$TS_FILES"
else
    echo "  TypeScriptファイルの変更なし"
fi

if [[ -n "$HTML_FILES" ]] && [[ "$HTML_COUNT" -gt 0 ]]; then
    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        echo "  🖥️  $file"
    done <<< "$HTML_FILES"
fi

# ---------------------- 結果サマリー ----------------------
echo ""
echo "========================================"
echo "📊 チェック結果サマリー"
echo "========================================"

RESULT_ICON="✅"
if [[ $PHP_FAIL -gt 0 ]]; then
    RESULT_ICON="❌"
elif [[ "$MERGE_SUCCESS" == "false" ]]; then
    RESULT_ICON="⚠️"
fi

echo "${RESULT_ICON} PHP構文チェック: ${PHP_PASS}件通過 / ${PHP_FAIL}件エラー"
if [[ "$MERGE_SUCCESS" == "false" ]]; then
    echo "⚠️  マージコンフリクト: 手動解消が必要"
fi

if [[ ${#PHP_ERRORS[@]} -gt 0 ]]; then
    echo ""
    echo "❌ PHP構文エラー詳細:"
    for err in "${PHP_ERRORS[@]}"; do
        echo "   • $err"
    done
fi

echo ""
echo "PR #$PR_NUM: $PR_TITLE"
echo "URL: $PR_URL"

# ---------------------- Slack通知 ----------------------
echo ""
echo "📣 Slack通知送信中..."

if [[ $PHP_FAIL -gt 0 ]]; then
    ERROR_DETAIL=""
    for err in "${PHP_ERRORS[@]}"; do
        ERROR_DETAIL="${ERROR_DETAIL}• ${err}\\n"
    done
    SLACK_MSG="<@${SLACK_USER}> 【PigeonCloud PR #${PR_NUM}】❌ PHP構文エラー検出\\n\\n*PR*: <${PR_URL}|PR #${PR_NUM}>\\n*タイトル*: ${PR_TITLE}\\n*ブランチ*: ${PR_BRANCH} → ${PR_BASE}\\n*作成者*: ${PR_AUTHOR}\\n\\n❌ *PHP構文エラー ${PHP_FAIL}件:*\\n${ERROR_DETAIL}\\n✅ 通過: ${PHP_PASS}件"
elif [[ "$MERGE_SUCCESS" == "false" ]]; then
    SLACK_MSG="<@${SLACK_USER}> 【PigeonCloud PR #${PR_NUM}】⚠️ マージコンフリクトあり\\n\\n*PR*: <${PR_URL}|PR #${PR_NUM}>\\n*タイトル*: ${PR_TITLE}\\n*ブランチ*: ${PR_BRANCH} → ${PR_BASE}\\n*作成者*: ${PR_AUTHOR}\\n\\n⚠️ マージコンフリクトが発生しています。手動解消が必要です。\\n✅ PHP構文チェック（PRブランチ単体）: ${PHP_PASS}件通過"
else
    SLACK_MSG="<@${SLACK_USER}> 【PigeonCloud PR #${PR_NUM}】✅ 検証OK\\n\\n*PR*: <${PR_URL}|PR #${PR_NUM}>\\n*タイトル*: ${PR_TITLE}\\n*ブランチ*: ${PR_BRANCH} → ${PR_BASE}\\n*作成者*: ${PR_AUTHOR}\\n\\n✅ テストマージ: 成功\\n✅ PHP構文チェック: ${PHP_PASS}件全て通過\\n📝 TypeScript変更: ${TS_COUNT}件（手動確認推奨）"
fi

curl -s -X POST -H 'Content-type: application/json' \
    --data "{\"text\": \"${SLACK_MSG}\"}" \
    "$SLACK_WEBHOOK" > /dev/null

echo "  ✅ 通知送信完了"

# Mac通知
if [[ $PHP_FAIL -gt 0 ]]; then
    osascript -e "display notification \"PR #${PR_NUM}: PHP構文エラー ${PHP_FAIL}件」 with title \"【PigeonCloud】PR Check ❌\" sound name \"Pop\"" 2>/dev/null || true
else
    osascript -e "display notification \"PR #${PR_NUM}: PHP ${PHP_PASS}件OK\" with title \"【PigeonCloud】PR Check ✅\" sound name \"Pop\"" 2>/dev/null || true
fi

# 終了コード
if [[ $PHP_FAIL -gt 0 ]]; then
    echo ""
    echo "❌ 検証失敗: PHP構文エラーがあります。マージ前に修正してください。"
    exit 1
else
    echo ""
    echo "✅ 検証完了: 問題なし"
    exit 0
fi
