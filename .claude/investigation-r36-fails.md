# R36 Fail調査レポート (2026-03-29)

## サマリ

| Agent | passed | failed | skipped | flaky | 合計 |
|-------|--------|--------|---------|-------|------|
| agent-30 | 104 | 166 | 74 | 4 | 348 |
| agent-31 | 489 | 235 | 77 | 1 | 802 |
| agent-32 | 213 | 48 | 43 | 0 | 304 |
| **合計** | **806** | **449** | **194** | **5** | **1454** |

> ユーザー報告の「88件fail」は repair_run.log のサマリ値（11+76+1）。
> playwright-results.json ベースでは449件（retryを含む個別テスト単位）。

---

## エラーパターン分類（449件）

### パターン1: navbar not visible（ログイン/セッション失敗） — 96件
- **原因**: `login()` 後に `.navbar` が表示されない。storageStateの期限切れ、またはテスト環境のセッション上限到達
- **影響**: agent-30（reports, layout-ui, records等）、agent-31（uncategorized系多数）
- **対処**: storageStateの再生成ロジック確認。login()にリトライを追加検討

### パターン2: データ件数不足 — 88件
- **原因**: `toBeGreaterThan(0)` 等のアサーションで、beforeAllで作成されたはずのデータが参照できない
- **影響**: agent-30（table-definition, records）、agent-31（uncategorized系）
- **根本原因**: beforeAllのcascade failure → データ未作成 → 後続テスト全滅
- **対処**: beforeAllのエラーハンドリング強化。データ作成失敗時のリトライ

### パターン3: browser closed — 79件
- **原因**: `Target page, context or browser has been closed`。長時間テストでブラウザプロセスが切断
- **影響**: agent-30（table-definition）、agent-31（uncategorized系）
- **根本原因**: テスト実行時間が長すぎてChromiumプロセスがOOM or タイムアウトでkill
- **対処**: テストの分割、メモリリーク対策

### パターン4: beforeAll cascade — 74件
- **原因**: `"beforeAll" hook timeout exceeded` → 同一describe内の全テストがskip扱い
- **影響**: agent-30（dashboard, records一括系）、agent-31（notifications, users-permissions）
- **主要箇所**:
  - `dashboard.spec.js` beforeAll: 300秒タイムアウト超過 → DB-01含む5件cascade
  - `records.spec.js` 一括テスト群: beforeAllでテーブル作成失敗 → 4件cascade
  - `workflow.spec.js` 21-1: beforeAllでテーブル名input待ちタイムアウト → 75件cascade skip
- **対処**: beforeAllタイムアウト延長、エラー時の詳細ログ出力

### パターン5: その他 element not visible — 23件
- **原因**: 期待するUI要素が存在しない（セレクタ変更、機能未実装など）
- **影響**: csv-export（JSON系）、layout-ui（メニュータブ）
- **対処**: セレクタの更新が必要。MCP Playwrightで実UIを確認して修正

### パターン6: locator timeout — 19件
- **原因**: 特定要素の待機が10-15秒でタイムアウト
- **影響**: table-definition（ダブルクリック系、設定ボタン）、records
- **対処**: タイムアウト延長 or waitForSelector追加

### パターン7: timeout (テスト全体) — 11件
- **原因**: テスト全体の180秒タイムアウト超過
- **影響**: auth（パスワード変更）、csv-export、notifications（ステップメール）
- **対処**: テストの簡素化 or タイムアウト延長

### パターン8: データ行なし (mat-row) — 8件
- **原因**: テーブルにレコードが0件。beforeAllでデータ投入失敗
- **影響**: records.spec.js（チェックボックス系、LOCK系）
- **対処**: パターン4と同根。beforeAllのデータ作成を確実にする

### パターン9: ページ遷移失敗 (title=PigeonCloud) — 6件
- **原因**: `toHaveTitle(/ダッシュボード/)` で title が "PigeonCloud" のまま。AngularのSPA遷移未完了
- **影響**: layout-ui.spec.js
- **対処**: `waitForAngular()` の追加、または `waitForURL` との併用

### パターン10: API error (create-user) — 5件
- **原因**: デバッグAPI `create-user` が `"error"` を返す。ユーザー上限到達
- **影響**: layout-ui.spec.js（ユーザータイプ「ユーザー」テスト群）
- **対処**: beforeAllでユーザー上限解除APIを先に呼ぶ、または既存ユーザーを再利用

### パターン11: null値 (要素取得失敗) — 4件
- **原因**: `expect(received).not.toBeNull()` — レコード編集ページで要素がnull
- **影響**: records.spec.js SAVE系
- **対処**: テーブルにレコードがないことが原因（パターン4の連鎖）

### パターン12: Failed to fetch (API) — 3件
- **原因**: `page.evaluate` 内の `fetch()` が失敗。ネットワークエラーまたはCORS
- **影響**: csv-export（JSON-01, 337）、chart-calendar-2（16-1）
- **対処**: テスト環境のネットワーク安定性確認

### パターン13: LOGIN_ERROR (storageState) — 3件
- **原因**: `getAllTypeTableId()` で login_error 返却 → tableId が `__LOGIN_ERROR__`
- **影響**: agent-31 uncategorized-2.spec.js
- **対処**: セッション切れ時のstorageState再生成

---

## Skip分析（194件）

### Agent-30: 74件skip
| ファイル | 件数 | 原因 |
|---------|------|------|
| csv-export.spec.js | 39 | beforeAll cascade（55-1のtimeoutで後続全滅） |
| table-definition.spec.js | 23 | `test.skip()` 意図的（手動テスト必要: ロック系、複数ユーザー操作） |
| dashboard.spec.js | 5 | beforeAll cascade（300秒timeout） |
| system-settings.spec.js | 4 | beforeAll cascade |
| layout-ui.spec.js | 2 | beforeAll cascade |
| auth.spec.js | 1 | `test.skip()` 意図的（Google認証） |

### Agent-31: 77件skip
| ファイル | 件数 | 原因 |
|---------|------|------|
| workflow.spec.js | 75 | **beforeAll cascade** — 21-1のbeforeAllでテーブル名input待ちtimeout → 75件全滅 |
| notifications-2.spec.js | 1 | 個別skip |
| notifications.spec.js | 1 | 個別skip |

### Agent-32: 43件skip
| ファイル | 件数 | 原因 |
|---------|------|------|
| chart-calendar-2.spec.js | 35 | **beforeAll cascade** — 16-1のbeforeAllで `Failed to fetch` → 35件全滅 |
| chart-calendar.spec.js | 4 | 個別skip |
| payment.spec.js | 4 | 個別skip |

---

## Agent-32 pass=0 の原因

Agent-32で `pass=0, fail=1, skip=35`（chart-calendar-2.spec.js）となった原因:

1. `chart-calendar-2.spec.js` のファイルレベル `test.beforeAll` で `createAllTypeTable()` → `createAllTypeData()` を実行
2. テスト16-1が最初に実行されるが、`page.evaluate` 内の `fetch()` が `TypeError: Failed to fetch` で失敗
3. 16-1が fail → **残り35件が全て beforeAll cascade skip**
4. agent-32の他のspec（fields系等）は別の問題（LOGIN_ERROR等）で失敗

実質的にはchart-calendar-2.spec.jsの `beforeAll` または最初のテスト内の `fetch` が失敗した時点で全滅する構造。

### fields-5.spec.js: 13件全fail
- `beforeAll` で `getAllTypeTableId()` が `__LOGIN_ERROR__` を返す
- storageStateが無効化（login_max_devices等）
- → `editUrl` が `https://xxx/admin/dataset/edit/__LOGIN_ERROR__` になり全テストfail

### fields-4.spec.js: 6件全fail
- 同様にtableId=null（beforeAllで取得失敗）

### fields-3.spec.js: 16件fail
- 同様にtableId=null → `expect(received).toBeTruthy()` で即fail

### templates.spec.js: 6件fail
- 未調査（別パターンの可能性あり）

---

## 修正可能なもの

### 優先度高（構造的問題 → 大量fail解消）

1. **workflow.spec.js beforeAll** — テーブル名input待ちtimeout（75件のskipを解消）
   - `#table_name` のwaitFor timeout=15秒が短すぎる
   - → タイムアウト延長 + ページ遷移後のwaitForAngular追加

2. **chart-calendar-2.spec.js beforeAll** — fetch失敗でcascade（35件skip解消）
   - `createAllTypeTable()` の中でfetch失敗
   - → エラー時リトライ + storageState再チェック

3. **fields-5.spec.js LOGIN_ERROR** — storageState無効（13件fail解消）
   - `getAllTypeTableId()` がLOGIN_ERRORを返した場合のリカバリなし
   - → LOGIN_ERROR検出時にstorageState再生成してリトライ

4. **csv-export.spec.js beforeAll cascade** — 39件skip
   - 55-1のtimeoutが原因で後続39件skip
   - → beforeAllの分離 or タイムアウト延長

### 優先度中（個別テスト修正）

5. **API error create-user** — 5件
   - ユーザー上限到達 → beforeAllでensureUserLimit()呼び出し

6. **ページ遷移失敗** — 6件
   - waitForAngular()追加

### 優先度低（環境依存）

7. **browser closed** — 79件
   - 長時間実行による環境問題。テスト分割で緩和

8. **navbar not visible** — 96件
   - セッション管理の改善（多くはbeforeAll cascade起因の可能性）

---

## 根本原因のまとめ

| 根本原因 | 影響件数 | 解消方法 |
|---------|---------|---------|
| beforeAll cascade（1つのbeforeAll失敗で数十件巻き添え） | ~150件 | beforeAllの堅牢化（リトライ、タイムアウト延長） |
| storageState無効化（LOGIN_ERROR） | ~20件 | LOGIN_ERROR時のstorageState再生成 |
| 長時間実行によるbrowser crash | ~80件 | テスト分割、メモリ最適化 |
| セレクタ/UI変更 | ~30件 | 個別セレクタ修正 |
| 環境依存（API fetch失敗、ネットワーク） | ~10件 | リトライロジック追加 |
