# Agent-30 DB-01 0ms即fail 調査結果

## 結論
**beforeAllの `throw new Error()` がcascade failの根本原因**

## 詳細

### 発生箇所
`tests/dashboard.spec.js` 行93-94:
```javascript
_tableId = await getAllTypeTableId(page);
if (!_tableId) throw new Error('ALLテストテーブルが見つかりません（global-setupで作成されているはずです）');
```

### メカニズム
1. beforeAllで `getAllTypeTableId()` がnullを返す（セッション切れ、ネットワークタイムアウト等）
2. `throw new Error()` でbeforeAll全体が失敗
3. Playwrightの仕様により、describe内の全テスト（DB-01〜DB-06）が0ms failまたはskipになる
4. DB-01は最初のテストなのでfail扱い、DB-02〜DB-06はskip扱い

### なぜ問題か
- DB-01（ダッシュボード画面表示確認）は `_tableId` を一切使わない
- DB-02（タブ作成）も `_tableId` を使わない
- DB-06（HOMEタブ確認）も `_tableId` を使わない
- これらは独立して成功すべきテスト

### 修正内容
beforeAll全体をtry-catchで包み、失敗時はログ出力のみ。`_tableId`と`_createdDashboardName`をnullに設定して個別テストに判断を委ねる。

### 修正ファイル
- `tests/dashboard.spec.js`

### 確認方法
```bash
npx playwright test tests/dashboard.spec.js --reporter=list
```
