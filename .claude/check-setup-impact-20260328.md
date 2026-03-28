# setupAllTypeTable global-setup集約 影響チェック結果

**チェック実施日**: 2026-03-28
**チェック対象**: global-setupでテーブル作成を1回に集約した後の各specへの影響

---

## 前提

- Playwright config: `fullyParallel: false`, `workers: 1` → specファイルはアルファベット順に逐次実行
- global-setup で `setupAllTypeTable` が1回実行される
- 各specは `getAllTypeTableId` でID取得のみ（のはず）

### 実行順序（アルファベット順）

```
auth → chart-calendar → chart-calendar-2 → comments-logs → csv-export →
dashboard → fields → fields-2 → fields-3 → fields-4 → fields-5 →
filters → layout-ui → notifications → notifications-2 → payment →
public-form → records → reports → rpa → system-settings →
table-definition → templates → uncategorized → uncategorized-2 → uncategorized-3 →
users-permissions → workflow
```

---

## 1. テーブル削除→再作成が必要な箇所

### 致命的な問題（テスト失敗を引き起こす）

| ファイル | 行 | 内容 | 影響 | 対応方針 |
|---------|-----|------|------|---------|
| **csv-export.spec.js** | 1115-1130 | テスト `クリーンアップ: ALLタイプテーブルを削除` が `debugApiPost(page, '/delete-all-type-tables')` を実行 | **global共有テーブルが消える**。同じファイル内の次のdescribe `JSONエクスポート・インポート`（L1137）の `beforeAll` で `getAllTypeTableId` が `null` を返し `throw new Error` で失敗する。さらに後続の全spec（dashboard以降）も影響。 | **クリーンアップテストを削除**するか、削除対象を特定テーブルIDに限定する（`10-4`のように個別削除API使用） |
| **system-settings.spec.js** | 795-796 | テスト `7-4` が `debugApiPost(page, '/create-all-type-table')` → `debugApiPost(page, '/delete-all-type-tables')` を実行 | **global共有テーブルを含む全テーブルが消える**。`create-all-type-table` で新テーブルを作ってから `delete-all-type-tables` で全削除しているが、このAPIは **全てのALLテストテーブルを削除する**ため、global-setupで作成したテーブルも消える。 | `7-4` の削除を個別テーブルID指定に変更する（`10-4` と同様の方式で、新規作成したテーブルのみ削除） |
| **system-settings.spec.js** | 510 | `afterAll` で `deleteAllTypeTables(page)` を実行 | **global共有テーブルが消える**。afterAll実行後、後続spec（table-definition以降）が全て影響。 | **afterAllのテーブル削除を除去**する。pw_change_interval_daysリセットと利用規約無効化のみ残す |

### 条件付きで発生する問題

| ファイル | 行 | 内容 | 影響 | 対応方針 |
|---------|-----|------|------|---------|
| **chart-calendar.spec.js** | 342-351 | `ensureSummarizeGrant` 関数内で、summarize権限が不足時に `deleteAllTypeTables` → `createAllTypeTable` → `createAllTypeData` を実行 | summarize権限が不足している場合のみ発火。テーブルを削除→再作成するため、**tableIdが変わる**。しかしこのspec内で `getAllTypeTableId` を使って再取得しているため、このspec自体は問題なし。ただし**テーブルIDが変わった場合、他specが古いIDをキャッシュしていると問題**になる可能性あり。 | 現状のままで問題なし（通常はsummarize権限が有効なので発火しない）。ただし発火した場合の安全策として、再作成後にtableIdをグローバルに通知する仕組みがあると望ましい |
| **system-settings.spec.js** | 966-1000 | テスト `9-1` で、テーブルが存在しない場合に `setupAllTypeTable` を呼んで再作成 | `7-4` のdelete後のリカバリ。**既に対応済み**だが、`setupAllTypeTable` を `require` しているため依存関係あり。 | 現状のリカバリで問題なし |

### 定義のみで呼び出されていない（問題なし）

| ファイル | 行 | 内容 | 状態 |
|---------|-----|------|------|
| comments-logs.spec.js | 107-169 | `setupTestTable` 関数（内部で `delete-all-type-tables` + `create-all-type-table`） | **未使用**。関数定義のみ。実際のbeforeAllはL408で `getAllTypeTableId` を使用 |
| comments-logs.spec.js | 174-180 | `teardownTestTable` 関数（内部で `delete-all-type-tables`） | **未使用**。関数定義のみ |
| system-settings.spec.js | 42-65 | `createTableWithRetry` 関数（内部で `delete-all-type-tables` + `create-all-type-table`） | **未使用**。関数定義のみ |
| chart-calendar-2.spec.js | 183-200 | `deleteAllTypeTables` 関数 | **未使用**。関数定義のみ |
| fields-2.spec.js | 157-165 | `deleteAllTypeTables` 関数 | **未使用**。関数定義のみ |
| fields-3.spec.js | 158-166 | `deleteAllTypeTables` 関数 | **未使用**。関数定義のみ |

---

## 2. データ状態の前提が崩れる箇所

### beforeAllでデータ投入している箇所（レコード蓄積の問題）

| ファイル | テスト/箇所 | 投入内容 | 問題 | 対応方針 |
|---------|------------|---------|------|---------|
| chart-calendar.spec.js | beforeAll (L392) | `createAllTypeData(page, 10)` | 10件投入。ただし `createAllTypeData` は既存データ数 >= count ならスキップするため、他specが先に多めに投入していればスキップされる。**データ件数は増加方向にのみ変化**。 | 問題低。チャートテストは件数の正確な一致を求めていない |
| chart-calendar-2.spec.js | beforeAll (L306) | `createAllTypeData(page, 10)` | 同上 | 問題低 |
| records.spec.js | beforeAll (L148) | `createAllTypeData(page, 5, 'fixed')` | 5件固定パターンで投入。他specがデータを追加/削除していると件数が異なる。 | **レコード操作テストでは正確な件数に依存するケースがある**。beforeEachでデータリセットする仕組みが必要 |
| records.spec.js | 別のdescribe beforeAll (L827) | `createAllTypeData(page, 10, 'fixed')` | 同上 | 同上 |
| notifications.spec.js | 各テスト内 (L348等) | `debugApiPost(page, '/create-all-type-data', { count: 1-3 })` | テスト内でデータ追加。蓄積する。 | 通知テストはデータの存在のみ確認するため問題低 |
| comments-logs.spec.js | beforeAll (L417) | `createAllTypeData(page, 3)` | 3件投入。コメントテストはレコードが存在すればOK。 | 問題低 |

### 件数に厳密な前提を持つテスト

| ファイル | テスト | 前提 | 問題 | 対応方針 |
|---------|--------|------|------|---------|
| csv-export.spec.js | 各CSVテスト | beforeAllで5件投入後にCSVダウンロード | CSV行数を5+1(ヘッダー)で検証していなければ問題なし。CSVの内容チェックはヘッダーの存在確認が主 | 問題低（要確認） |

---

## 3. beforeAll内の`createAllTypeTable`（自己修復パターン）

以下のspecはbeforeAllで独自の`createAllTypeTable`を呼んでおり、テーブルが存在しない場合は自動で再作成する。**global-setupのテーブルが前のspecに削除されても自己修復する**。

| ファイル | beforeAll行 | 自己修復方式 | 問題 |
|---------|------------|-------------|------|
| chart-calendar.spec.js | L386 | `createAllTypeTable` → 既存チェック + 無ければ作成 | OK。ただし`ensureSummarizeGrant`で条件付き削除あり |
| chart-calendar-2.spec.js | L301 | `createAllTypeTable` → 既存チェック + 無ければ作成 | OK |
| fields.spec.js | L279 | `createAllTypeTable` → 既存チェック + 無ければ作成 | OK |
| fields-2.spec.js | L264 | `createAllTypeTable` → 既存チェック + 無ければ作成 | OK |
| fields-3.spec.js | L265 | `createAllTypeTable` → 既存チェック + 無ければ作成 | OK |
| fields-4.spec.js | L265 | `createAllTypeTable` → 既存チェック + 無ければ作成 | OK |

### getAllTypeTableIdのみ（自己修復なし）

| ファイル | beforeAll行 | テーブル不在時の動作 | 問題 |
|---------|------------|-------------------|------|
| comments-logs.spec.js | L413 | `throw new Error` | **csv-exportのクリーンアップ後に実行されると失敗** |
| csv-export.spec.js (JSONセクション) | L1149 | `throw new Error` | **同ファイルのクリーンアップテスト後に失敗** |
| dashboard.spec.js | L93 | `getAllTypeTableId` | 要確認（csv-export後に実行される） |
| fields-5.spec.js | L133 | `getAllTypeTableId` | fields-4が自己修復するため、テーブルは存在するはず |
| filters.spec.js | L148 | `getAllTypeTableId` + フォールバック作成(L317) | **フォールバックあり**。テーブルがない場合は自前で作成 |
| layout-ui.spec.js | L517 | `getAllTypeTableId` | 要確認 |
| notifications.spec.js | L196 | `getAllTypeTableId` | 要確認 |
| notifications-2.spec.js | L201 | `getAllTypeTableId` | 要確認 |
| public-form.spec.js | L168 | `getAllTypeTableId` | 要確認 |
| records.spec.js | L146 | `getAllTypeTableId` | 要確認 |
| reports.spec.js | L157 | `getAllTypeTableId` | 要確認 |
| rpa.spec.js | L104 | `getAllTypeTableId` | 要確認 |
| system-settings.spec.js | L450 | `getAllTypeTableId` + `throw new Error` | **system-settingsはcsv-exportの後なので、テーブルが消えている可能性あり** |
| table-definition.spec.js | L161 | `getAllTypeTableId` | **system-settingsのafterAll後に実行されると失敗** |
| uncategorized*.spec.js | 各テスト内 | `getAllTypeTableId` | **system-settingsのafterAll後に実行されると失敗** |
| users-permissions.spec.js | L1200 | `getAllTypeTableId` | 同上 |

---

## 4. 修正不要（問題なし）

| ファイル | 理由 |
|---------|------|
| auth.spec.js | ALLテストテーブルを使用していない |
| payment.spec.js | ALLテストテーブルを使用していない |
| templates.spec.js | ALLテストテーブルを使用していない |
| workflow.spec.js | ALLテストテーブルを使用していない |
| fields.spec.js | 自己修復パターン（createAllTypeTable in beforeAll） |
| fields-2.spec.js | 自己修復パターン + deleteは定義のみ未使用 |
| fields-3.spec.js | 自己修復パターン + deleteは定義のみ未使用 |
| fields-4.spec.js | 自己修復パターン |
| chart-calendar-2.spec.js | 自己修復パターン + deleteは定義のみ未使用 |

---

## 5. 修正が必要な箇所まとめ（優先度順）

### P0: 致命的（即座にテスト失敗を引き起こす）

| # | ファイル | 行 | 問題 | 修正方針 |
|---|---------|-----|------|---------|
| 1 | **csv-export.spec.js** | 1115-1130 | クリーンアップテストが `delete-all-type-tables` で全テーブル削除 → 同ファイルのJSONセクション + 後続全specが失敗 | クリーンアップテストを削除するか、`/api/admin/delete/dataset` + 特定ID指定に変更 |
| 2 | **system-settings.spec.js** | 510 | afterAllで `deleteAllTypeTables` → 後続spec（table-definition以降全て）が失敗 | afterAllからテーブル削除を除去 |
| 3 | **system-settings.spec.js** | 795-796 | テスト `7-4` が `delete-all-type-tables` で全テーブル削除 | `7-4` の削除を個別テーブルID指定に変更（`10-4`方式） |

### P1: 要注意（条件次第で発生）

| # | ファイル | 行 | 問題 | 修正方針 |
|---|---------|-----|------|---------|
| 4 | **chart-calendar.spec.js** | 342-351 | `ensureSummarizeGrant` でsummarize権限不足時にdelete→recreate | 通常は発火しないが、tableIdが変わるリスクあり。監視のみでOK |
| 5 | **system-settings.spec.js** | 966-1000 | `9-1` の `setupAllTypeTable` リカバリ | `7-4` を修正すれば不要になるが、安全装置として残してもよい |

### P2: デッドコード（影響なし・クリーンアップ推奨）

| # | ファイル | 行 | 内容 |
|---|---------|-----|------|
| 6 | comments-logs.spec.js | 107-180 | `setupTestTable` + `teardownTestTable` が未使用 |
| 7 | system-settings.spec.js | 42-65 | `createTableWithRetry` が未使用 |

---

## 6. 推奨する修正順序

1. **csv-export.spec.js**: クリーンアップテスト（L1115-1130）を削除または個別ID削除に変更
2. **system-settings.spec.js**: afterAll（L510）から `deleteAllTypeTables` を除去
3. **system-settings.spec.js**: テスト `7-4`（L795-796）を `10-4` と同様の個別テーブル作成→個別テーブル削除方式に変更
4. デッドコード削除（comments-logs, system-settings の未使用関数）
