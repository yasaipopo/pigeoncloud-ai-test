# /spec-update — Spec自動更新スキル

PigeonCloud E2Eテスト（tests/*.spec.js）の品質を改善する。
`/check-specs` で検出した偽テスト・スキップ・空テストを、実際に動くテストに書き直す。

## 使い方

```
/spec-update [ファイル名]            # 指定ファイルを更新
/spec-update all                    # 全ファイルを優先度順に更新
/spec-update skip                   # test.skip のみを対象に修正
```

---

## 実行手順

### Step 1: 対象を特定

引数なしor `all` の場合：
1. `tests/*.spec.js` を全スキャン
2. 以下を優先度順に洗い出す:

| 優先度 | 種類 | 検出方法 |
|--------|------|---------|
| 🔴 HIGH | `test.skip(true, ...)` — セットアップ失敗 | "テーブルIDが取得できなかった" "データが存在しない" "ボタンが見つからない" |
| 🔴 HIGH | `test.skip('NNN: ...', async () => { // TODO })` — 空テスト | body が TODO コメントのみ |
| 🟡 MED | FAKEテスト（pageアクセス確認のみ） | `not.toContain('Internal Server Error')` のみ |
| 🟡 MED | テスト名と中身が乖離 | description と実装のミスマッチ |

### Step 2: 修正方針を決定

**パターン別修正方針**:

#### A. `test.skip(true, 'データが存在しないためスキップ')` 系
→ `beforeAll` / `beforeEach` でデータを事前作成するコードを追加する
→ skipを削除して `await expect(rows.count()).toBeGreaterThan(0)` に変更

#### B. `test.skip(true, 'テーブルIDが取得できなかった')` 系
→ `setupAllTypeTable(page)` 呼び出しを確認し、失敗時はエラーをthrowするよう修正
→ skipではなく `expect(tableId).toBeTruthy()` で明示的にfail

#### C. `test.skip('NNN: タイトル', async () => { // TODO })` 系
→ specs/XXXX.yaml の対応する case_no を読み、description/expected を確認
→ Playwrightで実際の操作を実装する
→ 実装不可能な場合（外部サービス、廃止済み）はファイルから**完全に削除**

#### D. FAKEテスト（`not.toContain('Internal Server Error')` のみ）
→ specs/XXXX.yaml の expected を読み、本来の検証を実装する
→ 例：「承認が完了すること」→ 実際に承認ボタンをクリックして状態変化を確認

#### E. 時間依存・外部サービス・廃止済み
→ `test.skip(true, '○○のため自動テスト不可（手動確認が必要）')` はそのまま残す
→ これは「合理的な理由あるskip」なので変更しない

### Step 3: 実装

1. 対象ファイルを読む（全体）
2. 対象の yaml も読む（specs/XXXX.yaml）
3. PigeonCloudソース `/Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/html_angular4/src/app/` でUIセレクターを確認（必要時）
4. `tests/helpers/` の既存ヘルパー関数を確認・活用する
5. spec.js を直接編集（Edit tool）

### Step 4: 確認

修正完了後、以下を確認：
- `test.skip(true, ...)` のセットアップ失敗系が残っていないか
- 空のtodo系テストが残っていないか
- 各テストが少なくとも「入力→保存→確認」または「操作→状態変化確認」を含んでいるか

---

## 重要なルール

- **スキップを削除するだけはNG** → 実装するか完全に削除するかのどちらか
- **セレクターは `page.locator()` で複数候補を試す** → Angular/ngx-bootstrap 対応
- **承認・申請フロー系は `workflow.spec.js` の既存実装を参考にする**
- **既存の helpers/ を活用する** → `table-setup.js`, `debug-settings.js`, `webhook-checker.js`, `mail-checker.js`
- **変更後は git add する** → `git add tests/XXXXX.spec.js`
- **1ファイルごとに進捗をthread MDに記録する**

---

## 現在の対応状況

実行前に `.claude/thread-task-queue-*.md` を確認して、どのファイルが未対応かを把握すること。
