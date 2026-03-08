#!/bin/bash
# ============================================================
# PigeonCloud テストエージェント 起動スクリプト
# 実行前にKeychainからClaudeの認証情報を自動更新する
# ============================================================

set -e

echo ">> Claude認証情報をKeychainから更新..."
CRED=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
if [ -z "$CRED" ]; then
    echo "ERROR: Keychainに Claude Code-credentials が見つかりません"
    echo "ホストでClaude Codeにログインしてください: claude"
    exit 1
fi
echo "$CRED" > ~/.claude/.credentials.json
echo "   認証情報を更新しました"

# 引数をdocker-composeに渡す
# 例: ./start.sh run --rm agent-1 claude -p "hello" --dangerously-skip-permissions
#     ./start.sh up agent-1
#     ./start.sh build
docker-compose "$@"
