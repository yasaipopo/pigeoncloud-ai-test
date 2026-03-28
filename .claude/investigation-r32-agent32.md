# R32 Agent-32 失敗調査レポート

調査日: 2026-03-29
ログファイル: `reports/agent-32/repair_run.log`

---

## サマリー

| 項目 | 値 |
|------|-----|
| 総テスト数 | 390 |
| 失敗数（retry除く） | 62テスト（retry含め118行） |
| スキップ数 | 76以上（cascade skip含む） |
| パス数 | 26（ログで確認できた分） |
| ログ状態 | **途中切断**（サマリー行なし — 実行が中断された可能性あり） |

---

## 失敗内訳（specファイル別）

| spec ファイル | 失敗数(retry含む) | パターン | 重症度 |
|---|---|---|---|
| `chart-calendar.spec.js` | 73 | 個別テスト失敗 + cascade skip | **高** |
| `uncategorized-3.spec.js` | 36 | 全テスト42秒タイムアウト | **高** |
| `fields-3.spec.js` | 7 | 個別テスト失敗(4秒) | 中 |
| `chart-calendar-2.spec.js` | 2 | beforeAll失敗→cascade | 中 |

---

## 原因分析

### 1. chart-calendar.spec.js（73件）— 最大の失敗源

**3つの異なる失敗パターンが混在:**

#### パターンA: カレンダーdescribeのbeforeAll失敗（cascade skip）
- **テスト**: 114-01等（0ms失敗）
- **原因**: `ensureCalendarView(page)`がbeforeAllで失敗 → describe内の全テストがskip
- **行**: L871のbeforeAll → `ensureCalendarView`が何かの理由で例外
- **影響**: カレンダー系テスト全滅

#### パターンB: 集計・チャートテストの個別失敗（3-9秒）
- **テスト**: 65-1, 85-2, 87-1, 105-01, 105-02, 110-01, 119-01, 120-03〜06, 260, 261等
- **原因**: チャート/集計UI操作でセレクタが見つからない、またはUI構造変更
  - `.dropdown-item:has-text("チャート")` が見つからない
  - `a:has-text("絞り込み")` / `button:has-text("表示")` のセレクタ不一致
  - `waitForAngular(body[data-ng-ready="true"])` がタイムアウト（このカスタム属性はAngularが出力しない可能性）
- **影響**: 集計・チャート系の大部分

#### パターンC: 詳細権限設定テスト（136/137/139/140/141系）
- **テスト**: 136-01〜04, 137-01〜04, 139-01〜04, 140-01〜04, 141-01
- **原因**: 権限設定UIのセレクタ不一致
- **影響**: 権限系テスト全滅

### 2. uncategorized-3.spec.js（36件）— タイムアウト

**全テストが42秒前後で失敗。**

- **原因の流れ**:
  1. `beforeEach` で `ensureLoggedIn(page)` → 約5-7秒
  2. テスト内で `checkPage(page, '/admin/dataset__${tableId}')` を呼ぶ
  3. `checkPage`内で `page.waitForSelector('table', { timeout: 35000 })` → 35秒待機
  4. テーブルが表示されないまま35秒経過
  5. `beforeEach`(5秒) + `checkPage`内待機(35秒) + assertion ≈ 42秒 → `test.setTimeout(60000)` に引っかかる前に内部のassertionで失敗

- **根本原因**: **テスト環境のテーブル一覧ページでAngularアプリが`<table>`要素を描画していない**
  - ALLテストテーブルにレコードがあるはずだが、ページが正しくロードされていない
  - テスト環境のレスポンスが遅い、またはbeforeAllの`createAllTypeData(page, 3)`が失敗している可能性
  - `beforeAll`で`.catch(() => {})` でエラーを握りつぶしている（L228）のが問題

### 3. fields-3.spec.js（7件）— waitForAngular失敗

- **テスト**: 113-19〜113-22（レイアウト2-4列系）
- **原因**: `waitForAngular(page)` = `page.waitForSelector('body[data-ng-ready="true"]', { timeout: 15000 })`
  - この`data-ng-ready="true"`はAngularアプリが設定するカスタム属性だが、設定されないケースがある
  - 113-19〜22はテーブル一覧に `page.goto` → `waitForAngular` → `page.innerText('body')` のシンプルなフロー
  - `waitForAngular`が15秒以内にtimeoutして例外→テスト失敗（約4秒はlogin+goto+少しの待機）

### 4. chart-calendar-2.spec.js（2件）— beforeAll失敗cascade

- **テスト**: 16-1（0ms）→ describe内全テストがskip
- **原因**: ファイルレベルbeforeAll（L298）で`createAllTypeTable`が失敗
  - `createAllTypeTable`が`result !== 'success'`を返した
  - テスト環境でALLテストテーブルの作成/取得に失敗
  - global-setupで作成済みだが、別specのbeforeAllで`createAllTypeTable`を再呼び出しして競合した可能性

---

## 修正提案

### 優先度高: uncategorized-3.spec.js

**beforeAllの`createAllTypeData`エラー握りつぶしを修正:**

```javascript
// 修正前（L228）
await createAllTypeData(page, 3).catch(() => {});

// 修正後
const dataResult = await createAllTypeData(page, 3).catch(e => {
    console.error('[beforeAll] createAllTypeData失敗:', e.message);
    return null;
});
if (!dataResult) {
    console.warn('[beforeAll] データ作成に失敗しましたが続行します');
}
```

**checkPage内の`table`待機タイムアウトを短縮し、エラーメッセージを改善:**

```javascript
// 修正前（L200）: 35秒待機
const tableFound = await page.waitForSelector('table', { timeout: 35000 })...

// 修正後: 20秒に短縮（60秒timeoutの中で余裕を持たせる）
const tableFound = await page.waitForSelector('table', { timeout: 20000 })...
```

### 優先度高: fields-3.spec.js

**`waitForAngular`の堅牢化:**

```javascript
// 修正前
async function waitForAngular(page, timeout = 15000) {
    await page.waitForSelector('body[data-ng-ready="true"]', { timeout });
}

// 修正後: フォールバック付き
async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        // data-ng-readyが設定されないケース: loadイベント + 短い待機で代替
        await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
    }
}
```

### 優先度中: chart-calendar.spec.js / chart-calendar-2.spec.js

- `ensureCalendarView`の実装を調査し、失敗原因を特定する必要がある
- 集計/チャートUIのセレクタを実UIで再確認する必要がある（MCP Playwright推奨）
- 権限設定テスト（136-141系）のセレクタも実UIで再確認

---

## ログの異常

repair_run.logはサマリー行（`X passed, Y failed`）がなく途中で切断されている。
最後の行は fields-3.spec.js の 113-22 テスト。実行が中断された可能性あり。
390テスト中、ログに記録されたのは約240テスト分。

---

## 次のアクション

1. [ ] uncategorized-3: `checkPage`の`table`待機を20秒に短縮
2. [ ] uncategorized-3: `createAllTypeData`のエラー握りつぶし解消
3. [ ] fields-3: `waitForAngular`にフォールバック追加
4. [ ] chart-calendar: `ensureCalendarView`の失敗原因調査（MCP Playwright）
5. [ ] chart-calendar: 集計/チャートUIセレクタの実UI確認
6. [ ] chart-calendar-2: beforeAllのcreateAllTypeTable失敗原因調査
7. [ ] ログ切断の原因調査（メモリ/タイムアウト/プロセスkill）
