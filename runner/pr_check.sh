#!/usr/bin/env bash
# PR Validation Check - テストマージ方式
# 使い方: ./runner/pr_check.sh <PR番号またはURL>
# 例: ./runner/pr_check.sh 2746
#
# チェック内容:
#   1. PRブランチをベースブランチにテストマージ → コンフリクトはNG
#   2. PHP構文チェック (php -l) - 変更されたPHPファイル全件 → エラーはNG
#   3. TypeScript変更ファイルの報告
#   4. 結果をSlack通知（NGの場合はPR作成者にも通知）

set -euo pipefail

PIGEON_PATH="$(cd "$(dirname "$0")/.." && pwd)/src/pigeon_cloud"
SLACK_WEBHOOK="${SLACK_WEBHOOK_URL}"
REVIEWER_SLACK_ID="U869KKT8C"  # 石川

# GitHub username → Slack ID マッピング
# 未登録の場合は GitHub username をそのまま表示（Slack メンションなし）
get_slack_id() {
    local github_user="$1"
    case "$github_user" in
        hninoo|HninOo|hninoowaiucsy)   echo "U06LCA60N6R" ;;  # HninOo (loftal)
        zayyamin)                        echo "U02GAPZ8S84" ;;  # Zay Yar Min (partner)
        channlynn|ChannLynn)             echo "U87ARCUDD" ;;    # ChannLynn
        iikubo)                          echo "U869RDG2G" ;;    # 飯窪
        takayanagi|takayama)             echo "U86BJT16G" ;;    # 高山
        *)                               echo "" ;;  # 未登録
    esac
}

# ---------------------- 引数パース ----------------------
PR_ARG="${1:-}"
if [[ -z "$PR_ARG" ]]; then
    echo "使い方: $0 <PR番号またはURL>"
    echo "例: $0 2746"
    exit 1
fi

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

AUTHOR_SLACK_ID=$(get_slack_id "$PR_AUTHOR")

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

# ---------------------- ブランチ取得 ----------------------
echo ""
echo "⬇️  ブランチをフェッチ中..."

ORIGINAL_BRANCH=$(cd "$PIGEON_PATH" && git branch --show-current 2>/dev/null || echo "staging")
TIMESTAMP=$(date +%s)
TEMP_BASE_BRANCH="pr-check-base-${PR_NUM}-${TIMESTAMP}"
PR_FETCH_BRANCH="pr-check-pr-${PR_NUM}-${TIMESTAMP}"

(cd "$PIGEON_PATH" && git fetch origin "${PR_BASE}:${TEMP_BASE_BRANCH}" --quiet 2>/dev/null) || {
    (cd "$PIGEON_PATH" && git fetch origin "${PR_BASE}" --quiet 2>/dev/null || true)
    (cd "$PIGEON_PATH" && git checkout -b "${TEMP_BASE_BRANCH}" "origin/${PR_BASE}" --quiet 2>/dev/null) || {
        (cd "$PIGEON_PATH" && git checkout -b "${TEMP_BASE_BRANCH}" "${PR_BASE}" --quiet 2>/dev/null)
    }
}

(cd "$PIGEON_PATH" && \
    git fetch origin "pull/${PR_NUM}/head:${PR_FETCH_BRANCH}" --quiet 2>/dev/null) || {
    echo "❌ PRブランチのフェッチに失敗しました"
    (cd "$PIGEON_PATH" && git branch -D "${TEMP_BASE_BRANCH}" --quiet 2>/dev/null || true)
    exit 1
}

echo "  ✅ フェッチ完了"

# クリーンアップ
cleanup() {
    (cd "$PIGEON_PATH" && \
        git merge --abort 2>/dev/null || true && \
        git checkout "${ORIGINAL_BRANCH}" --quiet 2>/dev/null || true && \
        git branch -D "${TEMP_BASE_BRANCH}" --quiet 2>/dev/null || true && \
        git branch -D "${PR_FETCH_BRANCH}" --quiet 2>/dev/null || true)
}
trap cleanup EXIT

# ---------------------- テストマージ ----------------------
echo ""
echo "🔀 テストマージを実行中（${PR_BASE} ← ${PR_BRANCH}）..."
cd "$PIGEON_PATH"
git checkout "${TEMP_BASE_BRANCH}" --quiet

MERGE_SUCCESS=true
CONFLICT_FILES=""
git merge "${PR_FETCH_BRANCH}" --no-edit --quiet 2>/dev/null || {
    MERGE_SUCCESS=false
    CONFLICT_FILES=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
    echo "  ❌ コンフリクト発生"
    echo ""
    echo "  コンフリクトファイル:"
    echo "$CONFLICT_FILES" | while IFS= read -r f; do echo "    ❌ $f"; done
    git merge --abort 2>/dev/null || true
}

if [[ "$MERGE_SUCCESS" == "true" ]]; then
    echo "  ✅ テストマージ成功"
fi

cd - > /dev/null

# ---------------------- PHP構文チェック ----------------------
# コンフリクトがある場合もPRブランチ単体でチェックは実行する（情報提供のため）
if [[ "$MERGE_SUCCESS" == "false" ]]; then
    cd "$PIGEON_PATH"
    git checkout "${PR_FETCH_BRANCH}" --quiet
    cd - > /dev/null
fi

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
    echo "  変更なし"
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

# 判定: コンフリクトもPHP構文エラーもどちらもNG
OVERALL_NG=false
[[ "$MERGE_SUCCESS" == "false" ]] && OVERALL_NG=true
[[ $PHP_FAIL -gt 0 ]] && OVERALL_NG=true

if [[ "$MERGE_SUCCESS" == "false" ]]; then
    echo "❌ テストマージ: コンフリクトあり → 修正が必要"
    CONFLICT_LIST=""
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        CONFLICT_LIST="${CONFLICT_LIST}• ${f}\\n"
    done <<< "$CONFLICT_FILES"
else
    echo "✅ テストマージ: 成功"
fi

if [[ $PHP_FAIL -gt 0 ]]; then
    echo "❌ PHP構文チェック: ${PHP_PASS}件通過 / ${PHP_FAIL}件エラー"
    for err in "${PHP_ERRORS[@]}"; do
        echo "   • $err"
    done
else
    echo "✅ PHP構文チェック: ${PHP_PASS}件通過"
fi

echo ""
echo "PR #$PR_NUM: $PR_TITLE"
echo "URL: $PR_URL"

# ---------------------- Slack通知 ----------------------
echo ""
echo "📣 Slack通知送信中..."

# 作成者メンション文字列
if [[ -n "$AUTHOR_SLACK_ID" ]]; then
    AUTHOR_MENTION="<@${AUTHOR_SLACK_ID}>"
else
    AUTHOR_MENTION="@${PR_AUTHOR}（GitHub）"
fi

if [[ "$OVERALL_NG" == "true" ]]; then
    # NG: 作成者 + レビュアーに通知
    NG_DETAILS=""

    if [[ "$MERGE_SUCCESS" == "false" ]]; then
        NG_DETAILS="${NG_DETAILS}❌ *コンフリクトあり* → ${PR_BRANCH} を ${PR_BASE} の最新に rebase して解消してください\\n"
        if [[ -n "$CONFLICT_LIST" ]]; then
            NG_DETAILS="${NG_DETAILS}コンフリクトファイル:\\n${CONFLICT_LIST}"
        fi
    fi

    if [[ $PHP_FAIL -gt 0 ]]; then
        NG_DETAILS="${NG_DETAILS}❌ *PHP構文エラー ${PHP_FAIL}件* → マージ前に修正してください\\n"
        for err in "${PHP_ERRORS[@]}"; do
            NG_DETAILS="${NG_DETAILS}• ${err}\\n"
        done
    fi

    SLACK_MSG="${AUTHOR_MENTION} <@${REVIEWER_SLACK_ID}> 【PigeonCloud PR #${PR_NUM}】❌ 検証NG\\n\\n*PR*: <${PR_URL}|PR #${PR_NUM}>\\n*タイトル*: ${PR_TITLE}\\n*ブランチ*: ${PR_BRANCH} → ${PR_BASE}\\n\\n${NG_DETAILS}\\n修正後に再チェックします。"

    osascript -e "display notification \"PR #${PR_NUM}: 検証NG（コンフリクト/構文エラー）\" with title \"【PigeonCloud】PR Check ❌\" sound name \"Pop\"" 2>/dev/null || true
else
    # OK: レビュアーのみに通知
    SLACK_MSG="<@${REVIEWER_SLACK_ID}> 【PigeonCloud PR #${PR_NUM}】✅ 検証OK\\n\\n*PR*: <${PR_URL}|PR #${PR_NUM}>\\n*タイトル*: ${PR_TITLE}\\n*ブランチ*: ${PR_BRANCH} → ${PR_BASE}\\n*作成者*: ${PR_AUTHOR}\\n\\n✅ テストマージ: 成功\\n✅ PHP構文チェック: ${PHP_PASS}件全て通過\\n📝 TypeScript/HTML変更: ${TS_COUNT}/${HTML_COUNT}件（要目視確認）"

    osascript -e "display notification \"PR #${PR_NUM}: 検証OK\" with title \"【PigeonCloud】PR Check ✅\" sound name \"Pop\"" 2>/dev/null || true
fi

curl -s -X POST -H 'Content-type: application/json' \
    --data "{\"text\": \"${SLACK_MSG}\"}" \
    "$SLACK_WEBHOOK" > /dev/null
echo "  ✅ 通知送信完了"

# ---------------------- 終了コード ----------------------
echo ""
if [[ "$OVERALL_NG" == "true" ]]; then
    echo "❌ 検証失敗: マージ前に問題を修正してください"
    exit 1
else
    echo "✅ 検証完了: 問題なし"
    exit 0
fi
