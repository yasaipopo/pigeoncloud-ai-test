#!/bin/bash
# ============================================================
# PigeonCloud テストエージェント エントリーポイント
#
# MODE=generate_specs  → spec.jsを生成・更新（Claude が作業）
# MODE=run_tests       → spec.jsを実行してSheetsに結果書き戻し（デフォルト）
# ============================================================

set -e

# Deploy Key設定（read-only・push不可）
export GIT_SSH_COMMAND="ssh -i /root/.ssh/deploy_key -o StrictHostKeyChecking=no -o IdentitiesOnly=yes"

MODE=${MODE:-run_tests}
TARGET_SPEC=${TARGET_SPEC:-}  # 特定specだけ実行する場合（例: auth）

echo "============================================"
echo " PigeonCloud テストエージェント起動"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo " モード: ${MODE}"
echo "============================================"

# PigeonCloudソースを最新化（Deploy Keyでpullのみ）
if [ -d "/app/src/pigeon_cloud/.git" ]; then
    echo ">> PigeonCloudソースを最新化..."
    cd /app/src/pigeon_cloud
    git pull --quiet
    echo "   最新コミット: $(git log -1 --format='%h %s')"
    cd /app
fi

# ============================================================
# モードA: spec.js 生成モード
# Claude がブラウザを操作してspec.jsを作成・更新する
# ============================================================
if [ "$MODE" = "generate_specs" ]; then
    echo ""
    echo ">> spec.js 生成モード"

    SPEC_YAML=${TARGET_SPEC:-auth}

    claude --dangerously-skip-permissions "
あなたはPigeonCloudのQAエージェントです。CLAUDE.mdの指示に従って作業してください。

## 今回のタスク: spec.js 生成

対象: specs/${SPEC_YAML}.yaml

手順:
1. specs/${SPEC_YAML}.yaml を読んで、テストケース一覧（cases）を把握する
2. Playwrightでブラウザを実際に操作して対象機能のページを確認する
   - セレクターの確認
   - URLパスの確認
   - UIの状態確認（スクリーンショットも撮る）
3. 確認した内容を元に tests/${SPEC_YAML}.spec.js を生成する
   - 各テストケースを test() として実装
   - ログインはlogin()ヘルパーを使う
   - セレクターは実際に確認したものを使う
4. npx playwright test tests/${SPEC_YAML}.spec.js --reporter=list で動作確認
5. 失敗したケースは再調査して修正する
6. 完了したらSlack通知: SLACK_WEBHOOK_URL に結果を送る

ソースコードは /app/src/pigeon_cloud/ で確認できます（staging最新・read-only）。
テスト環境: ${TEST_BASE_URL}
"
    exit 0
fi

# ============================================================
# モードB: 定期テスト実行モード（デフォルト）
# ============================================================

# Phase 1: Google Sheets → YAMLシナリオ同期
echo ""
echo ">> Phase 1: Google Sheets からシナリオを同期"
python runner/sheets_sync.py --pull

# Phase 2: Playwright spec.js 実行
echo ""
echo ">> Phase 2: Playwright spec.js テスト実行"

if [ -n "$TARGET_SPEC" ]; then
    SPEC_FILES="tests/${TARGET_SPEC}.spec.js"
else
    SPEC_FILES="tests/"
fi

# spec.jsが存在するか確認
SPEC_COUNT=$(find tests/ -name "*.spec.js" 2>/dev/null | wc -l)

if [ "$SPEC_COUNT" -gt "0" ]; then
    npx playwright test $SPEC_FILES --reporter=list,json 2>&1 || true
    # Playwright結果をreports/results.jsonに変換
    python3 -c "
import json, os
from pathlib import Path

pw_path = Path('reports/playwright-results.json')
if pw_path.exists():
    with open(pw_path) as f:
        pw = json.load(f)
    results = []
    for suite in pw.get('suites', []):
        for spec in suite.get('specs', []):
            status = 'passed' if spec.get('ok') else 'failed'
            results.append({
                'scenario': spec.get('title', ''),
                'file': suite.get('file', ''),
                'status': status,
                'errors': [{'type': 'test', 'message': r.get('error', {}).get('message', '')}
                           for r in spec.get('tests', [{}])[0].get('results', [])
                           if r.get('status') == 'failed'],
                'screenshot': None,
            })
    with open('reports/results.json', 'w') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    passed = sum(1 for r in results if r['status'] == 'passed')
    failed = sum(1 for r in results if r['status'] == 'failed')
    print(f'結果: {passed}件成功 / {failed}件失敗')
" 2>/dev/null || true
else
    echo "spec.jsが見つかりません。先にMODE=generate_specs で生成してください。"
fi

# 失敗件数をチェック
FAILED=$(python3 -c "
import json
from pathlib import Path
p = Path('reports/results.json')
if not p.exists():
    print(0)
else:
    with open(p) as f:
        results = json.load(f)
    print(sum(1 for r in results if r['status'] == 'failed'))
" 2>/dev/null || echo "0")

echo ""
echo "失敗件数: $FAILED"

if [ "$FAILED" -gt "0" ]; then
    echo ""
    echo ">> Phase 3: Claude による失敗調査・spec.js修正"

    claude --dangerously-skip-permissions "
あなたはPigeonCloudのQAエージェントです。CLAUDE.mdの指示に従って作業してください。

reports/results.json に失敗したテストが ${FAILED} 件あります。
各失敗を調査して：
- セレクター変更・URL変更・文言変更など仕様変更の場合 → tests/*.spec.js を修正
- 不具合の場合 → reports/claude_report.md にまとめてSlack通知（python runner/reporter.py）

ソースコードは /app/src/pigeon_cloud/ で確認できます（staging最新）。
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
