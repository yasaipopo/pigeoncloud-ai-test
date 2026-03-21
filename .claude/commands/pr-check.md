# PR Validation Check

引数: PRの番号またはURL

pigeon_cloud リポジトリのPRを高速バリデーションします。

---

## 目的

stagingマージ前に以下を素早くチェックして問題を事前検出する（所要時間: ~1分）。

| チェック | 内容 | 検出例 |
|---------|------|-------|
| PHP構文チェック | `php -l` で全変更PHPファイルを検査 | `} else { ... } else if` 構文エラー（PR #2746の問題） |
| 変更ファイル報告 | TypeScript/HTMLの変更を一覧表示 | Angular コンポーネント変更の確認漏れ防止 |

---

## 実行手順

### Step 1: PR番号を解析

引数からPR番号を特定する。URLでも番号でもOK。

### Step 2: PR情報と変更ファイルを取得

```bash
cd /Users/yasaipopo/PycharmProjects/pigeon-test

# PR情報
gh pr view <PR番号> --repo Loftal/pigeon_cloud \
    --json number,title,headRefName,baseRefName,author,url

# 変更ファイル一覧
gh pr diff <PR番号> --repo Loftal/pigeon_cloud --name-only
```

### Step 3: PRブランチをフェッチ

```bash
cd src/pigeon_cloud

# 現在のブランチを記録
ORIGINAL=$(git branch --show-current)

# PRブランチを一時ブランチとしてフェッチ
git fetch origin pull/<PR番号>/head:pr-check-<PR番号> --quiet
git checkout pr-check-<PR番号> --quiet
```

### Step 4: PHP構文チェック

変更されたPHPファイル全件に `php -l` を実行:

```bash
# 変更ファイルの中からPHPファイルを抽出してチェック
for file in <PHPファイル一覧>; do
    php -l "src/pigeon_cloud/$file"
done
```

結果:
- ✅ `No syntax errors detected` → OK
- ❌ `Parse error:` / `Fatal error:` → エラー詳細を報告

### Step 5: TypeScript変更ファイルを報告

TypeScript / HTML ファイルの変更を一覧表示する。
（本格的なAngularビルドは重いので、一覧のみ報告して手動確認を促す）

### Step 6: ブランチ復元

```bash
cd src/pigeon_cloud
git checkout <ORIGINAL>
git branch -D pr-check-<PR番号>
```

### Step 7: 結果をSlackで通知

石川（`<@U869KKT8C>`）に結果を通知:

**OKの場合**:
```
【PigeonCloud PR #N】✅ PHP構文チェック OK

PR: <URL|タイトル>
ブランチ: feature/xxx → staging
作成者: xxx

✅ PHP構文チェック: N件全て通過
📝 TypeScript変更: N件（手動確認推奨）
```

**エラーの場合**:
```
【PigeonCloud PR #N】❌ PHP構文エラー検出

PR: <URL|タイトル>
ブランチ: feature/xxx → staging
作成者: xxx

❌ PHP構文エラー N件:
• Application/Class/Record.php: Parse error on line 358
```

---

## スクリプト実行（ショートカット）

上記手順を全て自動実行するスクリプトが用意されています:

```bash
cd /Users/yasaipopo/PycharmProjects/pigeon-test
./runner/pr_check.sh <PR番号またはURL>
```

---

## 注意事項

- PHPUnitテスト実行は**含まない**（DBが必要なため）
- TypeScriptコンパイルは**含まない**（Angular build が重いため）
- PHP構文エラーのみで**既知のほとんどのデプロイ事故を防止できる**
- 対象リポジトリ: `Loftal/pigeon_cloud`（`src/pigeon_cloud/` にローカルクローン済み）
