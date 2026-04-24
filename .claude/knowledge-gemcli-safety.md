# 🚨 Gemini CLI 委託時の安全ルール（絶対遵守）

**このファイルは gemcli に渡す全プロンプトの冒頭に必ず要約して含めること。**

---

## 🔴 絶対禁止事項

### 1. 他人のファイルへの書き込み・削除禁止

- **`git checkout` / `git restore` / `git reset` コマンドは絶対に実行しない**
- 委託タスクの「編集対象ファイル」リストに**明記されていないファイルは一切触らない**
- 「一貫性のために周辺ファイルも直そう」という判断は**絶対に NG**
- スコープ外ファイルに改善の余地を見つけても、**報告のみ行い実行しない**

### 2. git 操作の全面禁止（明示許可なし時）

- `git checkout HEAD -- <file>` は**絶対禁止**（revert 扱いで data loss につながる）
- `git stash` / `git stash pop` も委託プロンプトで明示許可がない限り禁止
- `git add` / `git commit` は Claude (メインエージェント) 側の仕事、gemcli はやらない
- `git rm` / `rm <file>` で既存ファイルを削除しない

### 3. 「好意的な改善」禁止

- 「ついでに type を揃える」「ついでに重複コードを除去」などは**依頼されない限り禁止**
- コードスタイル違反を見つけても、委託タスクのスコープ外なら**触らない**

---

## 🟢 gemcli への委託プロンプト必須テンプレート

以下テンプレートを**必ず委託プロンプト冒頭に含める**:

```markdown
❗❗ 最重要制約（絶対遵守）:
- 編集対象は下記 "編集対象ファイル" リストのみ。それ以外のファイルは絶対に変更・削除・revert しない
- `git checkout` / `git restore` / `git reset` / `git stash` は絶対に実行しない（要求あれば作業停止と報告）
- スコープ外ファイルを改善したい誘惑に駆られても我慢する。気になる点は報告だけする
- 不明点があれば推測せず「判断できません」と報告
- `git add` / `git commit` は禁止（Claude 側でやる）

編集対象ファイル:
- tests/xxx.spec.js (行番号 L100-200 付近の特定テスト)
- specs/xxx.yaml (特定 case_no のみ)
...
```

---

## 🟠 Claude 側の運用ルール

### 委託後の検証手順（必須）

1. **委託完了後すぐに `git status --short` で変更ファイル一覧を確認**
2. **編集対象リストに無いファイルが modified / deleted になっていたら即座に止める**
3. スコープ外変更があれば `git diff <file>` で内容確認、必要なら `git checkout <file>` で revert（Claude の手で）
4. ⚠️ gemcli に「修正してくれた」と信じず、diff は必ず自分で確認する

### 並行実行時の注意

- 複数 gemcli を並行実行する場合、**各 agent の編集対象ファイルが重ならない**こと
- 同じディレクトリ配下の複数ファイルを別 agent に委託すると、誤って「周辺ファイルも対応しなきゃ」と判断する可能性
- 並列実行前に各 agent の役割をクリアに分離

### gemcli の典型的失敗パターン

| パターン | 事例 | 防止策 |
|---|---|---|
| **スコープ外 revert** | Claude が加えた変更を「scope 外だから戻す」と誤判断して `git checkout HEAD --` で消去 | git 操作全面禁止、スコープ外は報告のみと明記 |
| **勝手な整形** | 他の spec.js の timeout も「最適化」と称して書き換え | 「他のファイルは見るだけ、触らない」と明記 |
| **依存追加時の連鎖** | `npm install` で package.json 更新 → 他の依存もアップデート | package.json 編集は Claude 側で行う or 具体的に `install --save-dev X@Y` のみ指示 |

---

## 📚 過去のインシデント記録

### 2026-04-21: timeout 最適化 agent が 14 ファイル revert

**経緯**:
- Claude が spec #2/#3/#4 実装を gemcli に並列委託 → 成功
- その後 playwright.config.js の timeout 最適化を別 gemcli に委託
- timeout agent が `git checkout HEAD --` で「スコープ外の変更」と判断した 14 ファイルを revert
- 結果: spec #2/#3/#4 の実装コード + 関連変更（yaml/script/lambda/package.json/CLAUDE.md 等）が全消失

**影響**: 数時間分の作業が消失。JSONL ログから復旧可能だったが手動作業発生

**学び**:
- gemcli に「このファイルしか触らない」とだけ書いても、「他は revert してよい」と解釈される余地があった
- 明示的に「git checkout 禁止」「revert 禁止」と書くべきだった
- **このルールファイルを毎回 gemcli に渡す運用に変更**

---

## 🔗 関連ファイル

- `CLAUDE.md` — 「gemcli と Claude の役割分担」セクション
- `~/.claude/CLAUDE.md` — グローバル「Gemini CLI 使い方」セクション
