# 現在のタスク: leader-main

## 目標: テストパス率100%に近づける

## 状態: 次の会話で継続

### TEST_NUMBER=56 結果
- **121 pass / 92 fail (56%)**
- DB同期済み（stagingResult反映済み）
- シート: https://dezmzppc07xat.cloudfront.net/sheet.html

### 完了済み
- ✅ 全28 spec.jsのtest.step化（abd02ef）
- ✅ 全2,133ケースのdetailed_flow追加（089ca0d）
- ✅ pipeline_init チェック状態保持修正
- ✅ login関数storageState対応（a1601fe）
- ✅ タイムアウト300秒延長（166b6ff）
- ✅ reports.spec.js 全PASS化 1→5 PASS（f323d3b）
- ✅ DB同期・stagingResult更新（aa8546b）

### 進行中（Sonnetエージェント5並列）
| エージェント | 対象 | fail数 | 状態 |
|---|---|---|---|
| fix-csv | csv-export | 16 fail | 🔄 |
| fix-users | users-permissions | 14 fail | 🔄 |
| fix-filters-layout | filters + layout-ui | 9 fail | 🔄 |
| fix-workflow-records | workflow + records | 10 fail | 🔄 |
| fix-fields-notif | fields,2,3 + notifications | 8 fail | 🔄 |

→ **エージェント完了後、チェック→コミットが必要**

### 未着手のfail spec
- payment (4 fail) — Stripe環境依存
- fields-4 (2 fail) — セレクター問題（265-1 必須トグル）
- fields-5 (5 fail) — beforeAll + セレクター
- chart-calendar (2 fail)
- chart-calendar-2 (skip)
- system-settings (1 fail) — SS03タイムアウト
- table-definition (4 fail) — ARC-01
- uncategorized (2 fail)
- uncategorized-2 (2 fail)
- uncategorized-3 (5 fail)

### 次の会話でやること
1. Sonnetエージェント5つの結果をチェック（git statusで変更を確認）
2. テスト実行して確認（1バッチ順次）
3. PASS→コミット、FAIL→追加修正
4. 残りのfail specを修正
5. 全spec再テスト → DB同期（TEST_NUMBER=57）

### テスト環境情報
- URL: https://t17748687898741.pigeon-demo.com
- ID: admin / PW: 31pd0OYKfPNt
- ALLテストテーブルID: 22
- storageState: .auth-state.1.json
- .test_env_runtime.1 に環境変数

### コミット履歴
| hash | 内容 |
|---|---|
| abd02ef | 全28 spec.js test.step化 |
| 089ca0d | 全2,133ケースdetailed_flow追加 |
| a1601fe | login関数storageState対応 |
| 166b6ff | タイムアウト300秒延長 |
| f1a4951 | SS03タイムアウト600秒延長 |
| aa8546b | bulk-update stagingResult追加 |
| f323d3b | reports.spec.js 全PASS化 |
