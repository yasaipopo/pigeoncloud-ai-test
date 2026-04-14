# テスト内容チェックagent — yaml品質・網羅性チェック

引数: `$ARGUMENTS`

**テスト内容チェックagent**は `specs/*.yaml` のテスト内容が正しいか、PigeonCloudの全機能を網羅しているかをチェックするエージェントです。

---

## 役割

1. **yaml内容の正確性チェック**: description/expected が PigeonCloud の実際の機能と一致しているか
2. **網羅性チェック**: 全機能がテストケースとしてカバーされているか、漏れがないか
3. **適当なテストの検出**: 曖昧な description、検証不十分な expected がないか

---

## チェック手順

### Step 1: PigeonCloudのソースから機能一覧を把握

```bash
# Angularのルート定義（ページ一覧）
grep -rn "path:" /Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/html_angular4/src/app/app-routing.module.ts
grep -rn "path:" /Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/html_angular4/src/app/admin/admin-routing.module.ts

# PHPのルート定義（API一覧）
grep -rn "->get\|->post\|->put\|->delete" /Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/routes/admin/admin.php | head -50

# 主要コンポーネント
ls /Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/html_angular4/src/app/admin/
```

### Step 2: 各yamlファイルをチェック

各 `specs/*.yaml` について:

1. **case_no** が一意か
2. **description** が具体的か（「〜を確認する」だけでは不十分、操作手順が明確か）
3. **expected** が検証可能か（「正常に表示されること」は曖昧、具体的な確認項目があるか）
4. PigeonCloudソースの実装と一致しているか

### Step 3: 機能網羅チェック

PigeonCloudの主要機能ごとにテストケースがあるか確認:

| 機能カテゴリ | 確認対象 |
|---|---|
| 認証 | ログイン、ログアウト、パスワード変更、2FA、SAML |
| テーブル管理 | 作成、編集、削除、アーカイブ、フィールド追加/編集/削除 |
| レコード操作 | 追加、編集、削除、一括編集、インポート、エクスポート |
| ワークフロー | 申請、承認、否認、取り下げ、再申請 |
| 通知 | メール通知、Webhook、Slack、リマインダ |
| 権限 | ユーザー管理、グループ権限、IP制限 |
| UI | ダッシュボード、チャート、カレンダー、レイアウト |
| 帳票 | Excel出力、PDF出力 |
| CSV | アップロード、ダウンロード、JSONエクスポート |
| コネクト(RPA) | フロー作成、実行、ログ |
| 設定 | システム設定、SMTP、利用規約 |
| 公開フォーム | 設定、URL生成 |

### Step 4: 結果をシートに記録

チェック結果を `.claude/yaml-check-sheet.md` に記録:

```markdown
| spec | case_no | yaml内容OK | 問題点・備考 |
|------|---------|-----------|------------|
| auth | 1-1 | ✅ | |
| auth | 1-2 | ✅ | |
| auth | 295 | ⚠️ | expected がpassword変更後の確認手順不足 |
```

**OKの基準**:
- description が具体的な操作手順を含む
- expected が検証可能な結果を含む
- PigeonCloudの実装と一致している

**NGの場合**:
- 問題点を備考に記載
- yaml修正案を提示

---

## 引数

- 引数なし → 全yamlファイルをチェック
- `[spec名]` → そのyamlのみチェック

---

## 注意

- yamlを修正した場合、**後工程（spec実装確認、怒りくんレビュー、チェックくん実行確認）は全てリセット**される
- yaml修正後は必ずシートの該当行の後工程を空欄に戻すこと
