# Angular ng-select コンポーネント操作の知見

PigeonCloud は Angular4 SPA + `@ng-select/ng-select` コンポーネントを多用している。
ところが多くの spec で `select` 標準要素と `ng-select` を混同・回避し、`count() > 0 ? click : skip` のような偽装パターンが常態化していた。
このファイルは **ng-select の正しい操作パターン** と関連知見を集約する。

## ヘルパー (tests/helpers/ng-select.js)

すべての ng-select 操作はヘルパー経由で行う。直接 click/locator しない。

```js
const { selectNgSelectOption, ngSelectByLabel, expectNgSelectValue, openNgSelect, getNgSelectValue } = require('./helpers/ng-select');
```

### 主要 API

| 関数 | 用途 |
|---|---|
| `openNgSelect(ngSelect, opts)` | dropdown を開く (`.ng-select-container` or `.ng-arrow-wrapper` クリック) |
| `selectNgSelectOption(page, ngSelect, optionText, opts)` | 選択肢を選ぶ。完全一致 string or 正規表現対応 |
| `ngSelectByLabel(page, labelText)` | `<label>テーブル</label>` 等のラベル近傍の ng-select を取得 |
| `expectNgSelectValue(ngSelect, expected)` | `.ng-value-label` の選択値を expect |
| `getNgSelectValue(ngSelect)` | 現在選択値を文字列で取得 (未選択は null) |

### オプション
- `timeout`: デフォルト 10000ms
- `searchable`: true で検索ボックス入力 (絞り込み)
- `partial`: true で部分一致 (filter hasText)

## ng-select の典型 DOM 構造

```html
<ng-select [items]="..." [(ngModel)]="...">
  <div class="ng-select-container">
    <div class="ng-value-container">
      <div class="ng-value">  <!-- 選択値 -->
        <span class="ng-value-label">選択値テキスト</span>
      </div>
      <div class="ng-input">
        <input type="text">  <!-- 検索可能ng-select はここに入力 -->
      </div>
    </div>
    <span class="ng-arrow-wrapper">
      <span class="ng-arrow"></span>
    </span>
  </div>
  <!-- dropdown は body 直下に portal される (ng-dropdown-panel) -->
</ng-select>
```

dropdown panel:
```html
<div class="ng-dropdown-panel">
  <div class="ng-dropdown-panel-items">
    <div class="ng-option">選択肢A</div>
    <div class="ng-option">選択肢B</div>
  </div>
</div>
```

## 重要な実装ノウハウ

### 1. dropdown panel は body 直下 portal
ng-select 本体内の `.ng-option` ではマッチしない。**`page.locator('.ng-option')` (page 全体) を使う**こと。

### 2. dropdown を開くクリック対象
- `.ng-select-container` または `.ng-arrow-wrapper` をクリック
- ng-select 全体クリックでも開くが、`.ng-input` 内の input にフォーカスが当たり開かないことがある

### 3. label と ng-select の紐付け
PigeonCloud のフォームは `<div class="form-group">` 内に `<label>` + `<ng-select>` が配置される構造が多い。
**xpath で同じ form-group 内の組を取得**:

```js
function ngSelectByLabel(page, labelText) {
    return page.locator(
        `xpath=//*[contains(@class,'form-group') or contains(@class,'row') or contains(@class,'col')][.//label[contains(normalize-space(.),"${labelText}")]]//ng-select`
    ).first();
}
```

### 4. 検索可能な ng-select
入力欄に文字を入れると選択肢が絞り込まれる。Pigeon Cloud のテーブル選択や項目選択でよく使われる。
```js
const input = ngSelect.locator('input[type="text"]').first();
await input.fill('ALL');
// debounce 待ち
await page.waitForFunction(...);
```

### 5. 選択肢が動的ロード (API fetch)
通知設定のテーブル選択、フィールド選択など、dropdown 開いたタイミングで API fetch して候補ロードするケースあり。
**`await panel.waitFor({ state: 'visible' })` 後の `.ng-option` count > 0 を確認**してから click。

### 6. 選択後に他フィールドが展開されるケース
通知設定では「テーブル」選択後に「通知先ユーザー」「通知先組織」等の関連フィールドが活性化する。
**選択後に `await waitForAngular(page)` を入れる**のが安全。

## アンチパターン

### ❌ `page.locator('select').first()` だけで選択
ng-select は `<select>` 要素ではない。標準 select と混同しない。
```js
// 悪い
await page.locator('select').first().selectOption(...);  // ng-select には無効
```

### ❌ `count > 0 ? click : skip` の防御コード
要素が見つからない場合に sum 0 で pass する偽装テスト。
```js
// 悪い
const opt = page.locator('.ng-option').first();
if (await opt.count() > 0) await opt.click();
// 良い
const opt = page.locator('.ng-option').filter({ hasText: 'X' }).first();
await opt.waitFor({ state: 'visible', timeout: 10000 });
await opt.click();
```

### ❌ click だけで終わる (待機なし)
dropdown が開く前に `.ng-option` を click してしまうと、まだ要素がない状態で fail。
```js
// 悪い
await ngSelect.click();
await ngSelect.locator('.ng-option').first().click();  // race condition
// 良い
await ngSelect.click();
await page.locator('.ng-dropdown-panel').first().waitFor({ state: 'visible' });
await page.locator('.ng-option').filter({ hasText: 'X' }).first().click();
```

### ❌ optional chain で値検証
```js
// 悪い (常に true)
expect(await ngSelect.textContent() || 'fallback').toContain('X');
// 良い
await expectNgSelectValue(ngSelect, 'X');
```

## サンプル: テーブル選択 → 関連フィールド活性化

```js
// 1. テーブル ng-select を取得
const tableSelect = ngSelectByLabel(page, 'テーブル');

// 2. ALLテストテーブルを選択
await selectNgSelectOption(page, tableSelect, /ALL|dataset/);
await waitForAngular(page);

// 3. 選択値を検証
await expectNgSelectValue(tableSelect, /ALL|dataset/);

// 4. 関連フィールド (通知先組織等) が活性化されるのを確認
const orgSelect = ngSelectByLabel(page, '通知先組織');
expect(await orgSelect.count()).toBeGreaterThan(0);
```

## Playwright Pre-flight check

ng-select を操作する前に、ヘルパーが正しく要素を捕捉できているか確認するための簡易テスト:

```js
test.skip('ng-select pre-flight (DEBUG_NG_SELECT=1 のときのみ)', async ({ page }) => {
    test.skip(!process.env.DEBUG_NG_SELECT, 'DEBUG only');
    await login(page);
    await page.goto(BASE_URL + '/admin/notification/edit/new');
    const tableSelect = ngSelectByLabel(page, 'テーブル');
    expect(await tableSelect.count()).toBe(1);
    console.log('ng-select found:', await tableSelect.innerText());
});
```

## このヘルパーが活きる spec 一覧 (要置換)

| Spec | ng-select 使用箇所 | 既存 | 移行優先度 |
|---|---|---|---|
| notifications.spec.js | テーブル / 通知先ユーザー / 通知先組織 | 簡易検証のみ | 高 |
| filters.spec.js | フィルタ条件項目 | 部分対応 | 中 |
| chart-options.spec.js | 集計対象 / グラフ種別 | 偽装多 | 高 |
| layout-ui.spec.js | レイアウト要素選択 | 部分対応 | 中 |
| dashboard.spec.js | ダッシュボード要素選択 | 不明 | 低 |
| content-dashboard.spec.js | 同上 | 不明 | 低 |
| field-* 各種 | フィールド種別選択 | 部分対応 | 中 |

## 参考リンク
- @ng-select/ng-select 公式: https://ng-select.github.io/ng-select
- Pigeon Cloud 採用バージョン: package.json `@ng-select/ng-select` 確認
