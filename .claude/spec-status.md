# Spec ステータス管理

最終更新: 2026-03-11

## ステータス凡例
- ✅ **VERIFIED** - テスト実行済み・全パス（またはskip込みでパス）
- ⚠️ **PARTIAL** - 一部パス・一部失敗あり（要修正）
- 🔧 **GENERATED** - spec生成済みだが未テスト
- 🔄 **IN_PROGRESS** - 現在修正・検証中

---

## spec一覧（現時点の最新状態）

| spec.js | ステータス | テスト結果 | 担当agent | 完了日時 | 備考 |
|---|---|---|---|---|---|
| auth.spec.js | ✅ VERIFIED | 4 passed / 6 skip / 0 fail | agent-1 | 2026-03-09 23:16 | skipは専用環境必要(Google OAuth等) |
| comments-logs.spec.js | ✅ VERIFIED | 8 passed / 0 fail | agent-1 | 2026-03-09 23:16 | 全パス |
| chart-calendar.spec.js | ✅ VERIFIED | 33 passed / 0 fail | agent-2 | 2026-03-10 02:47 | 11箇所セレクター修正済み |
| csv-export.spec.js | ✅ VERIFIED | 16 passed / 0 fail | agent-9 | 2026-03-11 | agent-9が全パス確認。以前の間欠バグは解消 |
| filters.spec.js | ✅ VERIFIED | 1 passed | agent-3 | 2026-03-10 17:28 | 軽量テスト |
| public-form.spec.js | ✅ VERIFIED | 2 passed | agent-3 | 2026-03-10 17:28 | body.toBeVisible修正・URLリダイレクト対応済み |
| workflow.spec.js | ✅ VERIFIED | 4 passed / 2 skip / 0 fail | agent-4 | 2026-03-10 14:00 | 7バグ修正（URL・フィールド名・タイムアウト等） |
| fields.spec.js | ⚠️ PARTIAL | 44/45 passed / 1 fail | agent-6 | 2026-03-11 | 113-04(Yes/No 2-4列レイアウト)のみ失敗。agent-10で124件追加確認済み |
| records.spec.js | ⚠️ PARTIAL | 12 passed / 4 fail / 9 skip | agent-7 | 2026-03-11 | 35-1(参照中テーブル削除エラー)・52-1(関連レコード項目名バリデーション)失敗 |
| reports.spec.js | ⚠️ PARTIAL | 一部 passed / 2 fail / 複数skip | agent-7 | 2026-03-11 | 144-01(関連テーブル追加)・198(帳票設定ページ)失敗。205/206/207はskip |
| layout-ui.spec.js | ⚠️ PARTIAL | 35 passed / 15 skip / 1 fail | agent-11 | 2026-03-11 | 215-3(テーブルアイコン画像未指定でブランク表示)のみ失敗 |
| system-settings.spec.js | 🔧 GENERATED | 未テスト | agent-5 | - | 681行生成済み。agent-5は環境不備で全失敗(2ms=ブラウザ未起動)のため実質未テスト |
| notifications.spec.js | 🔧 GENERATED | 未テスト | - | - | 1016行生成済み。テスト未実行 |
| table-definition.spec.js | 🔧 GENERATED | 未テスト | agent-1(new) | 2026-03-11 | 1109行生成済み。テスト未実行 |
| users-permissions.spec.js | 🔧 GENERATED | 未テスト | - | - | 1229行生成済み。テスト未実行 |
| uncategorized.spec.js | 🔧 GENERATED | 未テスト | agent-8 | - | 1151行生成済み。agent-8はclaude.logなし・結果なしで実質未テスト |

---

## 残作業一覧

### 🔴 要修正（失敗あり）
| spec | 失敗テスト | 内容 |
|---|---|---|
| fields.spec.js | 113-04 | Yes/Noフィールドに2-4列レイアウトを設定できること |
| records.spec.js | 35-1 | 参照中のテーブルを削除しようとするとエラーが表示されること |
| records.spec.js | 52-1 | 関連レコード一覧の項目名未入力でエラーが発生すること |
| reports.spec.js | 144-01 | 帳票設定で関連テーブルの追加ができること |
| reports.spec.js | 198 | 帳票設定ページが表示され、Excel/PDF生成の設定項目があること |
| layout-ui.spec.js | 215-3 | テーブルアイコンタイプ「画像」で画像未指定の場合ブランク表示になること |

### 🔧 未テスト（テスト実行が必要）
| spec | 行数 | 優先度 |
|---|---|---|
| system-settings.spec.js | 681行 | 高（repair_specs実行が必要） |
| notifications.spec.js | 1016行 | 高 |
| table-definition.spec.js | 1109行 | 高 |
| users-permissions.spec.js | 1229行 | 高 |
| uncategorized.spec.js | 1151行 | 中 |

---

## 既知の不具合

| 不具合 | 影響spec | 内容 | 場所 |
|---|---|---|---|
| create-all-type-table 間欠的失敗 | csv-export, chart-calendar | Attempt to assign property "everyone_grant_json" on false | Dataset.php:1190 |
| create-user ユーザー上限 | auth | 有効ユーザー数が上限に達しています（同一環境の再利用時） | - |

---

## playwright.config.js の変更履歴

| 変更 | 内容 | 実施 |
|---|---|---|
| タイムアウト 60s→120s | 重いテスト対応 | agent-3 |
| globalSetup追加 | 新環境自動作成 | 手動追加 |

---

## 進捗サマリー

- ✅ VERIFIED: **7/16** (auth, comments-logs, chart-calendar, csv-export, filters, public-form, workflow)
- ⚠️ PARTIAL: **4/16** (fields, records, reports, layout-ui) ← 修正すればVERIFIEDになれる
- 🔧 GENERATED: **5/16** (system-settings, notifications, table-definition, users-permissions, uncategorized) ← テスト実行が必要
- 🔄 IN_PROGRESS: 0
