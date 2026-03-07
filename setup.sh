#!/bin/bash
# ============================================================
# 初回セットアップスクリプト
# PigeonCloudのソースコードをcloneして最新を取得
# ============================================================

set -e

REPO="git@github.com:Loftal/pigeon_cloud.git"
SRC_DIR="$(dirname "$0")/src/pigeon_cloud"

echo "=== PigeonCloud ソースコードの準備 ==="

if [ -d "$SRC_DIR/.git" ]; then
    echo "既存のリポジトリを更新中..."
    cd "$SRC_DIR"
    git fetch origin
    git checkout staging 2>/dev/null || git checkout main 2>/dev/null || git checkout master
    git pull
    echo "最新に更新しました"
else
    echo "リポジトリをclone中: $REPO"
    mkdir -p "$(dirname "$SRC_DIR")"
    git clone "$REPO" "$SRC_DIR"
    cd "$SRC_DIR"
    # stagingブランチがあれば切り替え
    git checkout staging 2>/dev/null || echo "stagingブランチなし、デフォルトブランチを使用"
    echo "cloneが完了しました"
fi

echo ""
echo "=== .env ファイルの確認 ==="
if [ ! -f "$(dirname "$0")/.env" ]; then
    echo ".env が存在しません。.env.example をコピーして設定してください:"
    echo "  cp .env.example .env"
    echo "  vi .env"
    exit 1
fi

echo ""
echo "=== セットアップ完了 ==="
echo "実行するには: docker-compose up --build"
