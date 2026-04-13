# E2E 通知・メール系テスト知見

## テナントオプション（メール・ステップメール等）の有効化

テナントの設定（`mail_option`, `step_mail_option` 等）はデフォルトで `false`。これらが `true` でないと:
- 左サイドバーのメニューに表示されない
- 直接URL（`/admin/step_mail`, `/admin/mail_templates` 等）にアクセスしても「テーブルが見つかりません」エラーになる

### 有効化API

`POST /api/admin/update-client-setting/{client_name}` をai-test admin側で呼ぶ（テナント側ではない）。部分更新OK。

```js
await adminPage.evaluate(async ({ name, opts }) => {
    const r = await fetch(`/api/admin/update-client-setting/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ setting: opts }),
        credentials: 'include',
    });
    return r.ok ? { ok: true } : { error: true, status: r.status };
}, { name: clientName, opts: { mail_option: 'true', step_mail_option: 'true' } });
```

### createTestEnv での利用

```js
const env = await createTestEnv(browser, {
    withAllTypeTable: true,
    enableOptions: { mail_option: 'true', step_mail_option: 'true' },
});
```

`createTestEnv` 内部で `clientName` を baseUrl のサブドメインから抽出し、`adminContext` を閉じる前に上記APIを叩く。

### 有効化できる設定キー一覧（`Application/Class/Setting.php` L101 参照）

`enable_rpa`, `enable_filesearch`, `tutorial_flag`, `grant_app_key`, `option_log`, `enable_api`, `use_master_login_url`, `display_master_on_dashboard`, `workflow_status_edit_by_csv`, `mail_option`, `step_mail_option`, `use_login_id`, `show_only_directory_on_navmenus`, `use_analytics_ai`, `use_freee`, `use_phase`, `use_master_user_auth`, `use_google_calendar`, `is_maintenance`, `allow_only_secure_access`, `enable_log_archive`

---

## メール系テーブル名（正式名）

過去のテストで古い・誤ったテーブル名が使われていた。現在の正しい名前は以下:

| 機能 | 誤（古い） | 正 |
|---|---|---|
| メールテンプレート | `mail_template` | **`mail_templates`**（複数形） |
| 配信リスト | `distribution_list` | **`mail_delivery_list`** |
| メール配信 | `mail_magazine` | **`mail_reserve`** |
| ステップメール設定 | `step_mail` | `step_mail`（変更なし） |
| ステップメール配信履歴 | — | `send_emails_step_mail` |

URL例: `/admin/mail_templates/edit/new`, `/admin/mail_reserve/edit/new`

出典: `Application/Class/CloudMenu.php` の `$mail_option_menus`, `$step_mail_option_menus` 定義

---

## ステップメール編集ページのセレクター

URL: `/admin/step_mail/edit/new`

| 要素 | セレクター |
|---|---|
| ステップメール名 | `input#name` |
| 送信時刻 | `input#time` — ⚠️ **0〜23の数字のみ**。`'09:00'` は無効（`'9'` にする） |
| 有効トグル | 最初の `input[type=checkbox]` |
| 配信リスト | `ng-select`（`label:has-text("配信リスト")` 近傍） |
| ステップ追加 | **`button.add-btn-step_mail_step`** または `button:has-text("ステップを追加する")` |
| テンプレート使用ラジオ | ステップ追加後に `label:has-text("テンプレート使用")` が表示される |
| 登録 | `button.btn-primary:has-text("登録")` |

### アサーション例

```js
// ステップ追加後、ステップ数を確認
await expect(page.locator('label:has-text("テンプレート使用")')).toHaveCount(N, { timeout: 10000 });
```

---

## メールテンプレート編集ページ

URL: `/admin/mail_templates/edit/new`

| 要素 | セレクター |
|---|---|
| テンプレート名 | `input#name` |
| 件名 | `input#subject` |
| 本文 | **`textarea:visible`** ← first() は hidden要素にマッチすることがある |
| 登録 | `button.btn-primary:has-text("登録")` |

---

## メール配信（mail_reserve）編集ページ

URL: `/admin/mail_reserve/edit/new`

初期表示で **form-group の一部が hidden**（最初の「グループ名」等）なので `.form-group` や `.form-group label` の first() は hidden 要素にマッチしがち。

### 待機セレクター

```js
await page.locator('label:has-text("メールテンプレート")').first().waitFor({ state: 'visible', timeout: 15000 });
```

### ラベル一覧（allInnerTexts で取得可能）

- `グループ名  (任意)`（hidden）
- `メールテンプレート`
- `予約日時`
- `配信リスト`
- `Cc`
- `Bcc`
- `添付ファイル`

### ラベル存在確認パターン

```js
const labels = await page.locator('.form-group label').allInnerTexts();
const hasCc = labels.some(l => l.trim().startsWith('Cc'));
const hasBcc = labels.some(l => l.trim().startsWith('Bcc'));
const hasAttachment = labels.some(l => l.includes('添付ファイル'));
```

---

## アンチパターン再確認

### ❌ `textarea.first()` / `.form-group.first()` を待つ
hidden要素にマッチしてタイムアウト。

### ✅ `:visible` pseudo-selector または具体的な label-based locator
```js
// 悪い
await page.locator('textarea').first().fill(value);
// 良い
await page.locator('textarea:visible').first().fill(value);
```

### ❌ `count() > 0` → `click()` / `fill()` パターン
hidden要素にマッチすると永遠にリトライしてタイムアウト。CLAUDE.md 知見6再確認。

### ✅ `isVisible()` ベースの分岐 or 直接確定セレクター
```js
// 悪い
const btn = page.locator('a:has-text("追加"), .fa-plus').first();
if (await btn.count() > 0) await btn.click();
// 良い
await page.locator('button.add-btn-step_mail_step').click(); // 確定セレクター
// または
if (await locator.isVisible().catch(() => false)) await locator.click();
```

---

## テスト品質に関する反省

既存のnotifications.spec.jsは以下の問題があった:

1. **防御的すぎるコード**: `count() > 0 ? fill : skip` のため、UIが壊れていてもテストが `passed` になってしまう
2. **アサーションが弱い**: `expect(bodyText).not.toContain('Internal Server Error')` と `expect(page.url()).toContain('/admin/')` のみでテストが実質意味なし
3. **セレクター網羅型**: `input[name*="name"], input[placeholder*="名"]` のような複数候補が実UIと噛み合わず全てマッチしない

### 修正方針

- 固定のID/classセレクターで要素を取得する（`input#name`, `button.add-btn-step_mail_step`）
- `inputValue()` で入力値を検証する
- `toHaveCount(N)` で子要素数を検証する
- `allInnerTexts()` + `.some()` でラベル存在検証
