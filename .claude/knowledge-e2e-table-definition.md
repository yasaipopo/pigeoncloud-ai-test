# E2E table-definition テスト知見

## テーブル名マッピング（古い→正）

| 機能 | 誤 | 正 |
|---|---|---|
| 組織 | `/admin/organization` | **`/admin/division`** |
| メールテンプレート | `mail_template` | `mail_templates` |
| 配信リスト | `distribution_list` | `mail_delivery_list` |
| メール配信 | `mail_magazine` | `mail_reserve` |

出典: `Application/Class/CloudMenu.php` の各メニュー定義。

---

## `/admin/dataset__{tableId}/add` 直接 goto の既知問題

**問題**: `/admin/dataset__N/add` に直接 goto すると白画面（`.navbar` も表示されない）になることがある。

**対処**: 一覧画面（`/admin/dataset__N`）に遷移 → `+` ボタン（`button:visible:has(.fa-plus)`）をクリック。

**helper 実装例** (`tests/table-definition.spec.js` に追加済み):

```js
async function gotoRecordAdd(page, tableId) {
    await page.goto(BASE_URL + '/admin/dataset__' + tableId, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await waitForAngular(page);
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
    const addBtn = page.locator('button:visible:has(.fa-plus)').first();
    if (await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await addBtn.click();
        await waitForAngular(page);
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
    }
}
```

---

## ALLテストテーブルのフィールド構造

### 自動採番フィールド

ALLテストテーブルには以下の2つの自動採番関連フィールドがある:

1. **ラベル完全一致「自動採番」** — 実際の `auto-id` フィールド（カウンターリセット対象）
2. **「自動採番_数値ソート」** — 数値ソート用の補助フィールド（リセット不可）

**正しい特定方法**: `.pc-field-block` から `hasNotText: /自動採番_/` でフィルタしてから `hasText: '自動採番'`。

```js
const autoIdBlock = page.locator('.pc-field-block').filter({
    hasNotText: /自動採番_/,
}).filter({ hasText: '自動採番' }).first();
const autoIdGear = autoIdBlock.locator('.fa-gear, .fa-cog').first();
await autoIdGear.click();
```

### カウンターリセットボタン

自動採番フィールドの歯車アイコンをクリック → フィールド設定モーダル → `button:has-text("カウンターをリセット")` が表示される。

---

## /admin/dataset/edit/{tableId} のタブ構造

**重要**: タブは `[role=tab]` 要素ではなく、通常の要素（`div`, `li`, `a` 等）として実装されている。

### サイドバータブ一覧（8項目、左側縦並び）

- 基本設定
- メニュー
- 一覧画面
- 詳細・編集画面
- CSV
- ワークフロー
- 地図設定
- その他

### タブクリック方法

```js
// ❌ 動かない
await page.locator('[role=tab]:has-text("一覧画面")').click();

// ✅ 動く
await page.locator('text=一覧画面').first().click();
```

---

## 更新日時/作成日時/作成者の表示設定の場所

**タブ**: 「一覧画面」タブ内
**コンポーネント**: `dataset-list-options.component.html`

検証パターン:

```js
// 「一覧画面」タブをクリック
await page.locator('text=一覧画面').first().click();
await page.waitForTimeout(2500);
await waitForAngular(page);

// ラベル or option value で存在確認
const bodyText = await page.innerText('body');
const bodyHtml = await page.content();
const hasDateOptions = bodyText.includes('更新日時') || bodyText.includes('作成日時') || bodyText.includes('作成者')
    || bodyHtml.includes('value="updated"') || bodyHtml.includes('value="created"') || bodyHtml.includes('value="admin_id"');
expect(hasDateOptions).toBeTruthy();
```

---

## 複製ボタンの場所

### レコード編集画面（child-forms）

`/admin/dataset__{tableId}/edit/new` 内で子テーブル機能を使うと、各子レコード行に `button.duplicate-button`（テキスト「複製」）が表示される。

### テーブル権限設定（forms-field）

`/admin/dataset/edit/{tableId}` の権限設定タブ内に `duplicateTableGrant(i)` の 複製 ボタン（`fa fa-copy`）がある。これはテーブル権限行の複製。

### テーブル定義 edit ページ本体には 複製 ボタン無し

`/admin/dataset/edit/{tableId}` の基本設定タブ・フィールド一覧には「項目の複製」ボタンは**直接は存在しない**。

---

## モーダル内 hidden confirm ボタンの罠

**現象**: `button.btn-danger` の first() は hidden な `#confirm-submit-btn`（モーダル内の確認ボタン）にマッチしてクリックタイムアウト。

**対処**: `:visible` pseudo-selector + 確認テキスト除外。

```js
const deleteBtns = page.locator('button.btn-danger:visible, button:visible:has(.fa-trash)').filter({
    hasNotText: /確認|はい/,
});
```

---

## テナントオプションと fail の相関

テスト環境で特定機能を使うには対応する option を有効化する必要がある:

| 機能 | 必要 option |
|---|---|
| ステップメール設定 | `step_mail_option: 'true'`, `mail_option: 'true'` |
| メール配信全般 | `mail_option: 'true'` |

詳細は `.claude/knowledge-e2e-notifications.md` 参照。

---

## チェックリスト違反に注意

本セッションで修正した table-definition の多くの fail は、以下のパターンに由来する:

1. **count() > 0 → click() の防御的コード** — hidden要素にマッチするとリトライループでタイムアウト
2. **first() の hidden マッチ** — strict mode ではないが初ヒットが非表示の場合、click/fill が止まる
3. **古いテーブル名**（organization, mail_template 等）
4. **`/add` 直接 goto** — listing → + ボタン経由が必須
5. **未定義変数参照**（`backToFieldsBtn` 等の残骸）
