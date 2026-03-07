#!/bin/bash
# ============================================================
# 初回セットアップスクリプト
# PigeonCloudのソースコードをcloneして最新を取得
# Deploy Key（read-only）を使用 → push不可
# ============================================================

set -e

REPO="git@github.com:Loftal/pigeon_cloud.git"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)/src/pigeon_cloud"
DEPLOY_KEY="$HOME/.ssh/pigeon_test_deploy_key"

# Deploy Key経由でSSH接続するgitコマンドのラッパー
export GIT_SSH_COMMAND="ssh -i ${DEPLOY_KEY} -o StrictHostKeyChecking=no -o IdentitiesOnly=yes"

echo "=== PigeonCloud ソースコードの準備 ==="
echo "使用するDeploy Key: ${DEPLOY_KEY}"

if [ ! -f "$DEPLOY_KEY" ]; then
    echo "エラー: Deploy Keyが見つかりません: ${DEPLOY_KEY}"
    echo "以下を実行してください:"
    echo "  ssh-keygen -t ed25519 -C 'pigeon-test-agent' -f ~/.ssh/pigeon_test_deploy_key -N ''"
    echo "  生成された公開鍵をGitHubのDeploy Keysに登録（read-only）"
    exit 1
fi

if [ -d "$SRC_DIR/.git" ]; then
    echo "既存のリポジトリを更新中..."
    cd "$SRC_DIR"
    git fetch origin
    git checkout staging 2>/dev/null || git checkout main 2>/dev/null || git checkout master
    git pull
    echo "最新に更新しました（ブランチ: $(git branch --show-current)）"
else
    echo "リポジトリをclone中: $REPO"
    mkdir -p "$(dirname "$SRC_DIR")"
    git clone "$REPO" "$SRC_DIR"
    cd "$SRC_DIR"
    git checkout staging 2>/dev/null || echo "stagingブランチなし、デフォルトブランチを使用"
    echo "cloneが完了しました（ブランチ: $(git branch --show-current)）"
fi

echo ""
echo "=== .env ファイルの確認 ==="
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo ".env が存在しません。.env.example をコピーして設定してください:"
    echo "  cp .env.example .env"
    echo "  vi .env"
    exit 1
fi

echo ""
echo "=== セットアップ完了 ==="
echo "実行するには: docker-compose up --build"
