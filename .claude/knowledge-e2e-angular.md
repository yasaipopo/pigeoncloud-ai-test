# E2Eテスト Angular固有の知見

作成: 2026-03-27

---

## 知見1: beforeAll で browser.newPage() を使うと storageState が効かない

### 問題
```javascript
// ❌ 悪いパターン: browser.newPage() は cookies/localStorage が空
test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page);  // ←ログイン必要
});
```

### 原因
- `test({ page })` で渡されるページは `playwright.config.js` の `use.storageState` が適用される
- `browser.newPage()` はその設定が**無視**される → Angular の初期化が失敗しやすい
- storageState には cookies（PHPSESSID, browser_token）と localStorage（admin_table）が必要

### 正しい書き方
```javascript
// ✅ 良いパターン: newContext で storageState を明示的に渡す
test.beforeAll(async ({ browser }) => {
    const fs = require('fs');
    const agentNum = process.env.AGENT_NUM || '1';
    const authStatePath = `.auth-state.${agentNum}.json`;
    const context = await browser.newContext(
        fs.existsSync(authStatePath) ? { storageState: authStatePath } : {}
    );
    const page = await context.newPage();
    // ログイン不要 — storageState で認証済み
    await page.goto(BASE_URL + '/admin/dashboard');
    await waitForAngular(page);
    // ... setup処理 ...
    await context.close();  // page.close() ではなく context.close()
});
```

---

## 知見2: Angular Reactive Forms ([formControl]) に fill() が効かない

### 問題
```javascript
// ❌ 悪いパターン: Angular FormControl には値が入らない
await page.fill('#new_password', 'NewPass9876!');
// → ng-pristine のままで送信時バリデーションエラー
```

### 原因
Angular の `[formControl]` / `[(ngModel)]` はネイティブDOMイベントを監視するが、
Playwright の `fill()` は React/Angular のイベント処理と相性が悪い場合がある。

### 正しい書き方（2通り）

**方法A: Native Input Value Setter（確実）**
```javascript
await page.evaluate((value) => {
    const input = document.querySelector('#name');
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSet.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}, 'テストDB_12345');
```

**方法B: ng.getComponent で直接 setValue（Angular専用）**
```javascript
await page.evaluate(() => {
    const el = document.querySelector('[ng-version]') || document.querySelector('app-root');
    // Angularコンポーネントを探してFormControlに直接setValue
    const comp = ng.getComponent(el);
    if (comp && comp.myForm) {
        comp.myForm.controls['new_password'].setValue('NewPass9876!');
    }
});
```

---

## 知見3: チュートリアルモーダルが初回訪問時に自動表示される

### 問題
新しいテスト環境で `/admin/dashboard` を開くと「テンプレートからインストール」モーダルが表示され、
次の操作（+ ボタンクリック等）が失敗する。

### 原因
PigeonCloud はテナント作成後の初回ダッシュボード訪問でチュートリアルモーダルを表示する。

### 対処
```javascript
// ダッシュボードページでtutorialモーダルが出たら閉じる
const hasTutorial = await page.locator('.modal.show')
    .filter({ hasText: 'テンプレートからインストール' })
    .isVisible({ timeout: 3000 }).catch(() => false);
if (hasTutorial) {
    await page.locator('.modal.show button:has-text("スキップ")').first()
        .click({ force: true }).catch(() => {});
    await waitForAngular(page);
}
```

---

## 知見4: ダッシュボード作成の + ボタンは `.dashboard-tab-add-btn`

### UI情報（2026-03-27確認）
- タブリスト: `[role=tablist]` → 複数ある場合は `.filter({ hasText: 'HOME' })` で絞り込む
- + ボタン: `button.dashboard-tab-add-btn`
- 作成モーダルの入力欄: `input#name`（edit.component.htmlのフォーム）
- 送信ボタン: `button.btn-primary.btn-ladda`（Laddaがinit後は `.ladda-button` も付く）

### 注意
- `input#name` は tutorialModal の中にはない（tutorialModal は `input` を持たない）
- `btn-ladda` はHTMLソースの class、`ladda-button` はLadda JSがinit時に付与するclass
- 両方に対応: `button.btn-primary.ladda-button, button.btn-primary.btn-ladda`

---

## 知見5: /admin/add/dashboards/ は PHP に届かない

### 問題
```javascript
// ❌ fetch で直接API呼び出ししても Angular HTML が返ってくる
const res = await fetch(BASE_URL + '/admin/add/dashboards/', { method: 'POST', ... });
// → Nginx が / → angular_app にルーティングするため
```

### 原因
- Nginx の設定: `/api/` → PHP backend、`/` → Angular SPA
- Angular の API 呼び出しは `http://takasaki-hanahanastreet.com` (別ドメイン) に送信される
  （`environment.prod.ts`: `api_url: 'http://takasaki-hanahanastreet.com'`）
- テスト環境から直接 `/admin/add/xxx` にfetchしても Angular index.html が返る

### 正しいアプローチ
- **UIで操作する**（ボタンクリック → Angularが別ドメインに送信）
- または **`/api/admin/` プレフィックスのAPIを使う**（これはPHPに届く）

---

## 知見6: パスワード変更フロー（295テスト）の条件

### Angular の条件（login-base.component.ts）
```typescript
if ((!_user.password_changed && this.userinfo['ignore_new_pw_input'] == 'false') || ...)
```

パスワード変更フォームが表示される条件:
1. `admin` テーブルの `password_changed = 'false'`（DBはstring）
2. `admin_setting` テーブルの `ignore_new_pw_input = 'false'`

### debug API での設定方法
```javascript
// 1. ignore_new_pw_input を false に
await fetch(BASE_URL + '/api/admin/debug/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ table: 'admin_setting', data: { ignore_new_pw_input: 'false' } }),
    credentials: 'include',
});

// 2. create-user でユーザー作成（レスポンスに id が含まれる）
// レスポンス: {"result":"success","id":4,"success":true,"email":"ishikawa+4@loftal.jp","password":"admin"}
// → create-user は password_changed='true' で作成するため、edit/admin/{id} で変更が必要

// 3. edit/admin/{id} で password_changed='false' に変更
await fetch(BASE_URL + '/api/admin/edit/admin/' + userId, {
    method: 'POST',
    body: JSON.stringify({ id: String(userId), name: email, email, password_changed: 'false', ... }),
    credentials: 'include',
});
```

### ハマりポイント
- `create-user` のレスポンスには `id` フィールドが含まれる → `list/admin` で検索不要
- `edit/admin/{id}` に `type` や `state` を含めると権限エラーになる場合がある → 除外すること
