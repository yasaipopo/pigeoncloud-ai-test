# E2E 差分監視・自動テスト

PigeonCloudのソースコードの変更を監視し、変更があれば自動でE2Eテストを実行します。

## 動作

1. `src/pigeon_cloud` の最新コミットを確認
2. 前回実行時のコミットハッシュ（`reports/.last_tested_commit`）と比較
3. 差分がある場合のみ `/e2e` フルパイプラインを実行
4. 差分がなければ「変更なし」と通知して終了

## 実行

```bash
LAST=$(cat reports/.last_tested_commit 2>/dev/null || echo "")
CURRENT=$(git -C src/pigeon_cloud rev-parse HEAD)

if [ "$LAST" = "$CURRENT" ]; then
  echo "変更なし（$CURRENT）- テストスキップ"
  exit 0
fi

echo "新コミット検出: $CURRENT（前回: $LAST）"
# → /e2e フルパイプラインを実行
# → 完了後に reports/.last_tested_commit を更新
echo "$CURRENT" > reports/.last_tested_commit
```

引数 `$ARGUMENTS` で `--force` が指定された場合は差分チェックをスキップして強制実行。
