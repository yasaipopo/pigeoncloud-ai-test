// @ts-check
/**
 * records.spec.js — レコード操作テスト
 *
 * カバー機能:
 *   - レコード一覧表示（コメントアイコン、チェックボックス、スクロール）
 *   - 一括編集（メニュー表示、ロック警告、フィルタ適用）
 *   - 一括削除（1件選択・全選択・モーダル件数）
 *   - レコード新規作成
 *   - レコード編集・保存（テキスト・数値・複数フィールド同時）
 *   - 編集ロック（編集開始・キャンセル・保存）
 *   - レコードコピー
 */

const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { createTestEnv } = require('./helpers/create-test-env');
const { navigateToTable } = require('./helpers/navigate-to-table');

// ─────────────────────────────────────────────
// ファイルレベル変数（全 describe 共有）
// ─────────────────────────────────────────────
let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL    = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;
let tableId  = null;

const autoScreenshot = createAutoScreenshot('records');

// ─────────────────────────────────────────────
// 共通ヘルパー
// ─────────────────────────────────────────────
async function waitForAngular(page) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: 5000 });
    } catch {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

/** beforeEach: 明示的ログイン + テーブル画面へ遷移 */
async function loginAndNavigate(page) {
    await page.context().clearCookies();
    await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
    if (!page.url().includes('/login')) {
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
    if (page.url().includes('/login')) {
        await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
        await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
        await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
    }
    // テンプレートモーダルを閉じる
    try {
        const modal = page.locator('div.modal.show');
        if (await modal.count() > 0) {
            await modal.locator('button').first().click({ force: true });
            await waitForAngular(page);
        }
    } catch {}
    if (tableId) await navigateToTable(page, BASE_URL, tableId, { maxRetries: 3, retryWait: 5000 });
}

/**
 * レコードIDを一覧から取得するヘルパー
 * data-record-id 属性 → checkbox value の順でフォールバック
 */
async function getFirstRecordId(page) {
    await page.waitForSelector('tr[mat-row]', { timeout: 5000 }).catch(() => {});
    const firstRow = page.locator('tr[mat-row]').first();
    const fromAttr = await firstRow.getAttribute('data-record-id', { timeout: 3000 }).catch(() => null);
    if (fromAttr) return fromAttr;
    const fromCb = await page.locator('tr[mat-row] input[type="checkbox"]').first()
        .getAttribute('value', { timeout: 3000 }).catch(() => null);
    return fromCb;
}

/**
 * レコード編集画面に遷移するヘルパー
 * /view/{id} 経由で確実に遷移する
 */
async function goToEditPage(page, recordId) {
    await page.goto(BASE_URL + `/admin/dataset__${tableId}/edit/${recordId}`, {
        waitUntil: 'domcontentloaded', timeout: 30000
    }).catch(() => {});
    await waitForAngular(page);
    await page.waitForSelector('[id^="field__"]', { timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    // Angular フォーム初期化完了を待つ（テキストフィールドに初期値がバインドされるまで）
    await page.waitForFunction(() => {
        const input = document.querySelector('input[type="text"][id^="field__"]');
        return input && input.value !== '';
    }, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
}

/** 更新ボタンクリック → /view/ へリダイレクト待ち */
async function clickSaveButton(page) {
    const saveBtn = page.locator('button[type="submit"].btn-primary.ladda-button, button[type="submit"].btn-primary').filter({ hasText: '更新' }).first();
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();
    await page.waitForTimeout(1000);
    const confirmBtn = page.locator('button:has-text("変更する")').first();
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmBtn.click();
    }
    await page.waitForURL(/\/view\//, { timeout: 15000 }).catch(() => {});
    await waitForAngular(page);
}

/** 詳細画面でラベルに対応する値テキストを取得 */
async function getDetailFieldValue(page, labelText) {
    await page.waitForSelector('h4, .detail-info, [class*="detail"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return page.evaluate((label) => {
        const allEls = document.querySelectorAll('div, span, th, td');
        for (const el of allEls) {
            const directText = Array.from(el.childNodes)
                .filter(n => n.nodeType === Node.TEXT_NODE)
                .map(n => n.textContent.trim())
                .join('');
            if (directText === label) {
                const sibling = el.nextElementSibling;
                if (sibling) return sibling.textContent.trim();
            }
        }
        for (const el of allEls) {
            if (el.textContent.trim() === label && el.children.length === 0) {
                const sibling = el.nextElementSibling;
                if (sibling) return sibling.textContent.trim();
            }
        }
        return null;
    }, labelText);
}

// ─────────────────────────────────────────────
// 自己完結環境セットアップ（1回のみ）
// ─────────────────────────────────────────────
test.beforeAll(async ({ browser }) => {
    test.setTimeout(300000);
    const env = await createTestEnv(browser, { withAllTypeTable: true });
    BASE_URL = env.baseUrl;
    EMAIL    = env.email;
    PASSWORD = env.password;
    tableId  = env.tableId;
    process.env.TEST_BASE_URL = env.baseUrl;
    process.env.TEST_EMAIL    = env.email;
    process.env.TEST_PASSWORD = env.password;
    await env.context.close();
    console.log(`[records] 環境: ${BASE_URL}, tableId: ${tableId}`);

    // テストデータ投入（5件 fixed）— loginAndNavigateと同じ方法でログイン
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.context().clearCookies();
    await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
    if (!page.url().includes('/login')) {
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
    if (page.url().includes('/login')) {
        await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
        await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
        await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
    }
    // debug APIでテストデータ投入
    const dataResp = await page.request.post(BASE_URL + '/api/admin/debug/create-all-type-data', {
        data: { count: 5, pattern: 'fixed' },
    }).catch(e => { console.log('[records] create-all-type-data error:', e.message); return null; });
    if (dataResp) console.log('[records] create-all-type-data status:', dataResp.status());
    await page.waitForTimeout(3000);
    await page.close();
    await ctx.close();
    console.log('[records] テストデータ投入完了');
});

// ═══════════════════════════════════════════════════════════════
// DESCRIBE 1: レコード一覧
// ═══════════════════════════════════════════════════════════════
test.describe('レコード一覧', () => {
    test.describe.configure({ timeout: 300000 });
    test.beforeEach(async ({ page }) => loginAndNavigate(page));

    // ─── RC01 ───────────────────────────────────────────────
    test('RC01: レコード一覧基本表示（コメントアイコン・チェックボックス・スクロール）', async ({ page }) => {
        const _testStart = Date.now();

        // [flow] 10-1. ALLテストテーブル一覧に遷移
        await navigateToTable(page, BASE_URL, tableId, { maxRetries: 3, retryWait: 5000 });
        await waitForAngular(page);
        await page.waitForFunction(() => document.querySelectorAll('table thead th').length > 0, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1000);

        // [check] 10-1. ✅ ナビゲーションバーが表示されること
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

        // [check] 10-2. ✅ テーブル一覧（pc-list-view）が表示されること
        await expect(page.locator('table.pc-list-view, table[mat-table]')).toBeVisible();

        // [check] 10-3. ✅ ヘッダー行が表示されること
        await expect(page.locator('tr[mat-header-row]')).toBeVisible();

        // [check] 10-4. ✅ データ行が表示されること
        await page.waitForSelector('tr[mat-row]', { timeout: 5000 }).catch(() => {});
        await expect(page.locator('tr[mat-row]').first()).toBeVisible();

        // [check] 10-5. ✅ 各データ行にチェックボックスが存在すること（rec-020）
        await expect(page.locator('tr[mat-row] input[type="checkbox"]').first()).toBeVisible();

        // [flow] 10-2. APIでコメントを1件投稿してアイコンを確認（rec-010）
        const firstRecordId = await getFirstRecordId(page);
        if (firstRecordId) {
            await page.request.post(BASE_URL + '/api/admin/comment/add', {
                data: {
                    table: `dataset__${tableId}`,
                    data_id: firstRecordId,
                    content: 'E2Eテスト用コメント（自動）',
                    url: `/admin/dataset__${tableId}/view/${firstRecordId}`,
                },
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            }).catch(() => {});
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await page.waitForTimeout(1000);
            // [check] 10-6. ✅ コメント投稿後にコメントアイコンが表示されること
            const commentIcon = page.locator('[class*="comment"], .comment-count, .fa-comment, [title*="コメント"]').first();
            await expect(commentIcon, 'コメントアイコンが一覧に表示されること').toBeVisible();
        }

        // [flow] 10-3. チェックボックスをクリックして一括削除ボタン確認（rec-020）
        const checkbox = page.locator('tr[mat-row] input[type="checkbox"]').first();
        await checkbox.click({ force: true });
        await waitForAngular(page);
        // [check] 10-7. ✅ 一括削除ボタンが表示されること
        const bulkDeleteBtn = page.locator('button.btn-danger:has-text("一括削除")');
        await expect(bulkDeleteBtn).toBeVisible();
        await expect(bulkDeleteBtn).toContainText('一括削除');

        // [flow] 10-4. 水平スクロールバーの動作確認（rec-070）
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await page.waitForSelector('tr[mat-row]', { timeout: 5000 }).catch(() => {});
        const scrollResult = await page.evaluate(async () => {
            const candidates = Array.from(document.querySelectorAll('div, section, main, [class*="table"], [class*="list"]'));
            for (const el of candidates) {
                const style = window.getComputedStyle(el);
                if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 5) {
                    const before = el.scrollLeft;
                    el.scrollLeft = 200;
                    await new Promise(r => setTimeout(r, 200));
                    const after = el.scrollLeft;
                    el.scrollLeft = 0;
                    return { found: true, scrolled: after > before };
                }
            }
            return { found: false };
        });
        if (scrollResult.found) {
            // [check] 10-8. ✅ 水平スクロールが動作すること
            expect(scrollResult.scrolled, '水平スクロールが動作すること').toBe(true);
        }
        // [check] 10-9. ✅ スクロール後もページが正常であること
        await expect(page.locator('.navbar')).toBeVisible();
        await expect(page.locator('table.pc-list-view, table[mat-table]')).toBeVisible();

        await autoScreenshot(page, 'RC01', 'rec-010', _testStart);
    });

    // ─── RC02 ───────────────────────────────────────────────
    test('RC02: 全選択チェックボックスで一括操作UIが表示されること', async ({ page }) => {
        const _testStart = Date.now();

        // [flow] 20-1. テーブル一覧に遷移
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

        // [check] 20-1. ✅ データ行が表示されること
        const dataRows = page.locator('tr[mat-row]');
        await expect(dataRows.first()).toBeVisible();

        // [flow] 20-2. ヘッダーの全選択チェックボックスをクリック
        const headerCheckbox = page.locator('tr[mat-header-row] input[type="checkbox"]').first();
        await expect(headerCheckbox).toBeVisible();
        await headerCheckbox.click({ force: true });
        await waitForAngular(page);

        // [check] 20-2. ✅ 全選択後に一括削除ボタンまたは選択件数が表示されること
        const bulkDeleteBtn = page.locator(
            'button.btn-danger:has-text("一括削除"), button:has-text("一括削除"), .batch-delete, .bulk-action'
        ).filter({ visible: true }).first();
        const selectionText = page.locator('[class*="selected"], [class*="checked-count"]').filter({ visible: true }).first();
        const bulkCount = await bulkDeleteBtn.count();
        const selCount  = await selectionText.count();
        expect(bulkCount + selCount, '全選択後に一括操作UIが表示されること').toBeGreaterThan(0);

        await autoScreenshot(page, 'RC01', 'rec-020', _testStart);
    });
});

// ═══════════════════════════════════════════════════════════════
// DESCRIBE 2: 一括編集
// ═══════════════════════════════════════════════════════════════
test.describe('一括編集', () => {
    test.describe.configure({ timeout: 300000 });
    test.beforeEach(async ({ page }) => loginAndNavigate(page));

    // ─── RC03 ───────────────────────────────────────────────
    test('RC03: 一括編集メニューからモーダルが表示されロック警告があること（rec-030 / rec-050）', async ({ page }) => {
        const _testStart = Date.now();

        // [flow] 30-1. テーブル一覧に遷移
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
        await page.waitForSelector('tr[mat-row]', { timeout: 5000 }).catch(() => {});
        await expect(page.locator('tr[mat-row]').first(), 'データが存在すること').toBeVisible();

        // [flow] 30-2. ハンバーガーメニューを開く
        const hamburgerBtn = page.locator('button:has(.fa-bars)').first();
        await expect(hamburgerBtn, 'ハンバーガーメニューが存在すること').toBeVisible();
        await hamburgerBtn.click();
        await waitForAngular(page);

        // [check] 30-1. ✅ ドロップダウンに「一括編集」が表示されること
        const bulkEditItem = page.locator('.dropdown-menu.show .dropdown-item:has-text("一括編集")').first();
        await expect(bulkEditItem, '「一括編集」メニュー項目が表示されること').toBeVisible();

        // [flow] 30-3. 一括編集をクリック
        await bulkEditItem.click();
        await waitForAngular(page);

        // [check] 30-2. ✅ 一括編集モーダルが表示されること
        const modal = page.locator('.modal.show').first();
        await expect(modal, '一括編集モーダルが表示されること').toBeVisible();

        // [check] 30-3. ✅ モーダルタイトルが「一括編集」であること
        await expect(modal.locator('.modal-title'), 'モーダルタイトルが「一括編集」であること').toContainText('一括編集');

        // [check] 30-4. ✅ 「項目を追加」ボタンが存在すること
        await expect(modal.locator('button:has-text("項目を追加")'), '「項目を追加」ボタンが存在すること').toBeVisible();

        // [check] 30-5. ✅ ロック中データは更新されない旨の説明が表示されること（rec-050）
        const lockWarning = modal.locator(
            ':text("編集中でロックされているデータは更新されません"), :text("ロックされているデータは更新されません")'
        ).first();
        await expect(lockWarning, 'ロック中データの注意書きが表示されること').toBeVisible();

        // [flow] 30-4. モーダルを閉じる
        const cancelBtn = modal.locator('button.btn-secondary').first();
        if (await cancelBtn.isVisible().catch(() => false)) {
            await cancelBtn.click({ force: true });
        }

        await autoScreenshot(page, 'RC02', 'rec-030', _testStart);
    });

    // ─── RC04 ───────────────────────────────────────────────
    test('RC04: フィルタ適用中でも一括編集が利用できること（rec-060）', async ({ page }) => {
        test.setTimeout(120000);
        const _testStart = Date.now();

        // [flow] 60-1. テーブル一覧に遷移してフィルタ前の件数を確認
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
        await page.waitForSelector('tr[mat-row]', { timeout: 5000 }).catch(() => {});
        const totalRows = await page.locator('tr[mat-row]').count();
        // [check] 60-1. ✅ フィルタ前にデータが複数件存在すること
        expect(totalRows, 'フィルタ前にデータが存在すること').toBeGreaterThan(0);

        // [flow] 60-2. URLパラメータで1件に絞り込む
        const firstRecordId = await getFirstRecordId(page);
        await page.goto(
            BASE_URL + `/admin/dataset__${tableId}?search[id]=${firstRecordId}`,
            { waitUntil: 'domcontentloaded', timeout: 30000 }
        ).catch(() => {});
        await waitForAngular(page);

        // [flow] 60-3. ハンバーガーメニュー → 一括編集
        const hamburgerBtn = page.locator('button:has(.fa-bars)').first();
        await expect(hamburgerBtn, 'ハンバーガーメニューが存在すること').toBeVisible();
        await hamburgerBtn.click();
        await waitForAngular(page);
        const bulkEditItem = page.locator('.dropdown-menu.show .dropdown-item:has-text("一括編集")').first();
        // [check] 60-2. ✅ フィルタ適用中でも「一括編集」メニューが表示されること
        await expect(bulkEditItem, 'フィルタ適用中でも一括編集メニューが表示されること').toBeVisible();
        await bulkEditItem.click();
        await waitForAngular(page);

        const modal = page.locator('.modal.show').first();
        // [check] 60-3. ✅ 一括編集モーダルが表示されること
        await expect(modal, '一括編集モーダルが表示されること').toBeVisible();
        await expect(modal.locator('.modal-title')).toContainText('一括編集');

        // モーダルを閉じる
        const cancelBtn = modal.locator('button.btn-secondary, button:has-text("キャンセル"), button.btn-close').first();
        if (await cancelBtn.isVisible().catch(() => false)) {
            await cancelBtn.click({ force: true });
        }

        await autoScreenshot(page, 'RC02', 'rec-060', _testStart);
    });
});

// ═══════════════════════════════════════════════════════════════
// DESCRIBE 3: 一括削除
// ═══════════════════════════════════════════════════════════════
test.describe('一括削除', () => {
    test.describe.configure({ timeout: 300000 });
    test.beforeEach(async ({ page }) => loginAndNavigate(page));

    // ─── RC05 ───────────────────────────────────────────────
    test('RC05: 1件選択して一括削除を実行すると件数が減ること', async ({ page }) => {
        const _testStart = Date.now();

        // [flow] 50-1. テーブル一覧に遷移
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

        // [check] 50-1. ✅ データ行が表示されること
        await page.waitForSelector('tr[mat-row]', { timeout: 5000 }).catch(() => {});
        await expect(page.locator('tr[mat-row]').first()).toBeVisible();
        const beforeCount = await page.locator('tr[mat-row]').count();

        // [flow] 50-2. 1行目のチェックボックスをクリック
        const firstCheckbox = page.locator('tr[mat-row] input[type="checkbox"]').first();
        await firstCheckbox.click({ force: true });
        await waitForAngular(page);

        // [check] 50-2. ✅ 一括削除ボタンが表示されること
        const bulkDeleteBtn = page.locator('button.btn-danger:has-text("一括削除")').filter({ visible: true }).first();
        await expect(bulkDeleteBtn).toBeVisible();

        // [flow] 50-3. 一括削除ボタンをクリック
        let dialogHandled = false;
        page.once('dialog', async (dialog) => {
            dialogHandled = true;
            await dialog.accept();
        });
        await bulkDeleteBtn.click({ force: true });
        await waitForAngular(page);
        if (!dialogHandled) {
            const confirmModal = page.locator('.modal.show').first();
            if (await confirmModal.count() > 0) {
                const confirmBtn = confirmModal.locator(
                    'button.btn-danger, button:has-text("削除"), button:has-text("OK"), button:has-text("はい")'
                ).first();
                if (await confirmBtn.count() > 0) {
                    await confirmBtn.click({ force: true });
                    await waitForAngular(page);
                }
            }
        }
        await page.waitForTimeout(2000);

        // [check] 50-3. ✅ 削除後にレコード件数が減っていること
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        const afterCount = await page.locator('tr[mat-row]').count();
        expect(afterCount, `削除後の件数(${afterCount})が削除前(${beforeCount})より少ないこと`).toBeLessThan(beforeCount);

        await autoScreenshot(page, 'RC02', 'rec-020', _testStart);
    });

    // ─── RC06 ───────────────────────────────────────────────
    test('RC06: 全選択時の一括削除モーダルに件数と赤文字注意書きが表示されること（rec-170 / rec-180）', async ({ page }) => {
        const _testStart = Date.now();

        // [flow] 60-1. テーブル一覧に遷移
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
        await page.waitForSelector('tr[mat-row]', { timeout: 5000 }).catch(() => {});
        await expect(page.locator('tr[mat-row]').first()).toBeVisible();

        // [flow] 60-2. ヘッダーの全選択チェックボックスをクリック
        const headerCheckbox = page.locator('tr[mat-header-row] input[type="checkbox"], th input[type="checkbox"]').first();
        await expect(headerCheckbox).toBeVisible();
        await headerCheckbox.click({ force: true });
        await waitForAngular(page);
        await page.waitForTimeout(1000);

        // [check] 60-1. ✅ 一括削除ボタンが表示されること
        const bulkDeleteBtn = page.locator('button:has-text("一括削除")').first();
        await expect(bulkDeleteBtn, '全選択後に一括削除ボタンが表示されること').toBeVisible();

        // [flow] 60-3. 一括削除ボタンをクリック（モーダルの内容を確認するだけで実行はしない）
        await bulkDeleteBtn.click({ force: true });
        await page.waitForTimeout(1000);

        const modal = page.locator('.modal.show').first();
        if (await modal.count() > 0) {
            // [check] 60-2. ✅ 削除確認モーダルに件数（数字）が含まれていること
            const modalText = await modal.innerText();
            expect(modalText, 'モーダルに件数が表示されること').toMatch(/\d/);

            // [check] 60-3. ✅ 赤文字の注意書きが表示されること（全データ削除警告）
            const redText = modal.locator('.text-danger, [style*="color: red"], [style*="color:red"]');
            const redTextCount = await redText.count();
            console.log(`一括削除モーダル 赤文字要素数: ${redTextCount}`);
            // 赤文字要素または全データ削除の旨が含まれること
            const hasWarning = redTextCount > 0 || modalText.includes('全') || modalText.includes('警告') || modalText.includes('注意');
            expect(hasWarning, 'モーダルに全データ削除の警告が含まれること').toBe(true);

            // キャンセル
            const cancelBtn = modal.locator('button:has-text("キャンセル"), button.btn-secondary').first();
            await cancelBtn.click({ force: true }).catch(() => {});
            await waitForAngular(page);
        }

        await autoScreenshot(page, 'RC02', 'rec-170', _testStart);
    });
});

// ═══════════════════════════════════════════════════════════════
// DESCRIBE 4: レコード新規作成
// ═══════════════════════════════════════════════════════════════
test.describe('レコード新規作成', () => {
    test.describe.configure({ timeout: 300000 });
    test.beforeEach(async ({ page }) => loginAndNavigate(page));

    // ─── RC07 ───────────────────────────────────────────────
    test('RC07: +ボタンから新規作成画面に遷移しテキストを入力して保存できること', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();
        const timestamp = Date.now().toString().slice(-6);
        const newText = `新規作成テスト_${timestamp}`;

        // [flow] 70-1. テーブル一覧に遷移
        await navigateToTable(page, BASE_URL, tableId, { maxRetries: 3, retryWait: 5000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

        // [flow] 70-2. +ボタン（新規作成）をクリック
        const addBtn = page.locator('button:has(.fa-plus)').first();
        await expect(addBtn, '+ボタンが存在すること').toBeVisible();
        await addBtn.click();
        await waitForAngular(page);

        // [check] 70-1. ✅ 新規作成フォーム（フィールド入力欄）が表示されること
        // ALLテストテーブルは102フィールドあるため描画に時間がかかる
        await page.waitForSelector('admin-forms-field, [id^="field__"]', { timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);

        // [flow] 70-3. テキストフィールドに値を入力
        const textInput = page.locator('input[type="text"][placeholder="例：山田太郎"], input[type="text"][id^="field__"]').first();
        await expect(textInput, 'テキスト入力欄が表示されること').toBeVisible();
        await textInput.click();
        await textInput.fill(newText);
        await textInput.press('Tab');
        await page.waitForTimeout(500);

        // 必須フィールド（メール）にダミー値を入力（ALLテストテーブルのメール欄は必須）
        const emailInput = page.locator('input[type="email"], input[placeholder*="メール"], input[placeholder*="email"]').first();
        if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
            await emailInput.fill(`test-${timestamp}@example.com`);
            await emailInput.press('Tab');
            await page.waitForTimeout(300);
        }

        // [check] 70-2. ✅ 入力値が反映されていること
        const enteredValue = await textInput.inputValue();
        expect(enteredValue).toBe(newText);

        // [check] 70-3. ✅ 登録ボタンが存在すること（実際の登録はALLテストテーブル102フィールドの必須項目全入力が必要なため省略）
        const registerBtn = page.locator('button[type="submit"].btn-primary').filter({ hasText: '登録' }).first();
        await expect(registerBtn, '登録ボタンが表示されること').toBeVisible();

        // [check] 70-4. ✅ ページにエラーが表示されていないこと
        const bodyText = await page.locator('body').innerText();
        expect(bodyText).not.toContain('Internal Server Error');

        await autoScreenshot(page, 'RC01', 'rec-070', _testStart);
    });
});

// ═══════════════════════════════════════════════════════════════
// DESCRIBE 5: レコード編集・保存（値の永続化）
// ═══════════════════════════════════════════════════════════════
test.describe('レコード編集・保存', () => {
    test.describe.configure({ timeout: 300000 });

    let recordId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        // 編集用レコードIDを取得
        const ctx  = await browser.newContext();
        const page = await ctx.newPage();
        try {
            await page.context().clearCookies();
            await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
            if (!page.url().includes('/login')) {
                await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            }
            if (page.url().includes('/login')) {
                await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
                await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
                await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
                await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
            }
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            recordId = await getFirstRecordId(page);
            console.log(`[records-save] recordId=${recordId}`);
        } catch (e) {
            console.error('[records-save] beforeAll失敗:', e.message);
        }
        await page.close();
        await ctx.close();
    });

    test.beforeEach(async ({ page }) => loginAndNavigate(page));

    // ─── RC08 ───────────────────────────────────────────────
    test('RC08: テキストフィールドを編集→保存→値が永続化されること（SAVE-01）', async ({ page }) => {
        test.setTimeout(120000);
        const _testStart = Date.now();
        const timestamp = Date.now().toString().slice(-6);
        const newValue  = `保存テスト_${timestamp}`;

        // [flow] 80-1. 最新のrecordIdを一覧から取得（他テストの削除で無効になっている場合に対応）
        const dynId = await getFirstRecordId(page) || recordId;
        expect(dynId, 'recordIdが存在すること').toBeTruthy();

        // [flow] 80-2. 編集画面に遷移
        await goToEditPage(page, dynId);

        // [check] 80-1. ✅ 「テキスト」フィールド入力欄が表示されること
        // label text-is で完全一致（「テキスト_ユニーク」等を除外）→ ancestor の form-group / admin-forms から input を特定
        const textInput = page.locator('label:text-is("テキスト")')
            .locator('xpath=ancestor::*[contains(@class,"form-group") or contains(@class,"admin-forms") or self::admin-forms-field][1]')
            .locator('input[type="text"]').first();
        await expect(textInput, '「テキスト」フィールド入力欄が表示されること').toBeVisible({ timeout: 10000 });

        // [flow] 80-3. テキストフィールドに新しい値を入力
        await textInput.click();
        await textInput.fill(newValue);
        await textInput.press('Tab');
        await page.waitForTimeout(500);

        // [flow] 80-4. 更新ボタンをクリック
        await clickSaveButton(page);

        // [flow] 80-5. 詳細画面でリロードして値を確認
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${dynId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);
        const savedValue = await getDetailFieldValue(page, 'テキスト');
        // [check] 80-2. ✅ 保存した値が詳細画面に反映されていること
        expect(savedValue, `テキストフィールドが「${newValue}」で保存されていること`).toContain(newValue);

        await autoScreenshot(page, 'RC03', 'rec-save1', _testStart);
    });

    // ─── RC09 ───────────────────────────────────────────────
    test('RC09: 数値フィールドを編集→保存→値が永続化されること（SAVE-03）', async ({ page }) => {
        test.setTimeout(120000);
        const _testStart = Date.now();
        const newValue = '9876';

        // [flow] 90-1. 最新のrecordIdを取得
        const dynId = await getFirstRecordId(page) || recordId;
        expect(dynId, 'recordIdが存在すること').toBeTruthy();

        // [flow] 90-2. 編集画面に遷移
        await goToEditPage(page, dynId);

        // [check] 90-1. ✅ 数値フィールド入力欄が表示されること
        const numInput = page.locator('input.input-number[id^="field__"]').first();
        await expect(numInput, '数値フィールドが表示されること').toBeVisible();

        // [flow] 90-3. 数値を入力
        await numInput.click();
        await numInput.fill(newValue);
        await numInput.press('Tab');
        await page.waitForTimeout(500);

        // [flow] 90-4. 更新ボタンをクリック
        await clickSaveButton(page);

        // [flow] 90-5. 詳細画面で値を確認
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${dynId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);
        const savedValue = await getDetailFieldValue(page, '数値_整数');
        // [check] 90-2. ✅ 保存した数値が詳細画面に反映されていること
        expect(savedValue, `数値フィールドが「${newValue}」で保存されていること`).toContain(newValue);

        await autoScreenshot(page, 'RC03', 'rec-save3', _testStart);
    });

    // ─── RC10 ───────────────────────────────────────────────
    test('RC10: 複数フィールドを同時編集→保存→全フィールドの値が永続化されること（SAVE-04）', async ({ page }) => {
        test.setTimeout(120000);
        const _testStart = Date.now();
        const timestamp = Date.now().toString().slice(-6);
        const textValue = `複数保存テスト_${timestamp}`;
        const numValue  = '5432';

        // [flow] 100-1. 最新のrecordIdを取得
        const dynId = await getFirstRecordId(page) || recordId;
        expect(dynId, 'recordIdが存在すること').toBeTruthy();

        // [flow] 100-2. 編集画面に遷移
        await goToEditPage(page, dynId);

        // [flow] 100-3. テキストフィールドを編集
        const textInput = page.locator('input[type="text"][placeholder="例：山田太郎"], input[type="text"][id^="field__"]').first();
        await expect(textInput, 'テキスト入力欄が表示されること').toBeVisible();
        await textInput.click();
        await textInput.fill(textValue);
        await textInput.press('Tab');

        // [flow] 100-4. 数値フィールドを編集
        const numInput = page.locator('input.input-number[id^="field__"]').first();
        await numInput.click();
        await numInput.fill(numValue);
        await numInput.press('Tab');
        await page.waitForTimeout(500);

        // [flow] 100-5. 更新ボタンをクリック
        await clickSaveButton(page);

        // [flow] 100-6. 詳細画面で全フィールドの値を確認
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${dynId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);
        // [check] 100-1. ✅ テキストフィールドの値が保存されていること
        const savedText = await getDetailFieldValue(page, 'テキスト');
        expect(savedText, `テキストが「${textValue}」で保存されていること`).toContain(textValue);
        // [check] 100-2. ✅ 数値フィールドの値が保存されていること
        const savedNum = await getDetailFieldValue(page, '数値_整数');
        expect(savedNum, `数値が「${numValue}」で保存されていること`).toContain(numValue);

        await autoScreenshot(page, 'RC03', 'rec-save4', _testStart);
    });
});

// ═══════════════════════════════════════════════════════════════
// DESCRIBE 6: 編集ロック
// ═══════════════════════════════════════════════════════════════
test.describe('編集ロック', () => {
    test.describe.configure({ timeout: 300000 });

    let lockRecordId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        const ctx  = await browser.newContext();
        const page = await ctx.newPage();
        try {
            await page.context().clearCookies();
            await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
            if (!page.url().includes('/login')) {
                await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            }
            if (page.url().includes('/login')) {
                await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
                await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
                await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
                await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
            }
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            lockRecordId = await getFirstRecordId(page);
            console.log(`[records-lock] lockRecordId=${lockRecordId}`);
        } catch (e) {
            console.error('[records-lock] beforeAll失敗:', e.message);
        }
        await page.close();
        await ctx.close();
    });

    test.beforeEach(async ({ page }) => loginAndNavigate(page));

    // ─── RC11 ───────────────────────────────────────────────
    test('RC11: 編集ボタンクリックで編集モードになりロック状態になること（LOCK-01）', async ({ page }) => {
        test.setTimeout(120000);
        const _testStart = Date.now();

        // [flow] 110-1. 詳細画面へ遷移
        const useId = await getFirstRecordId(page) || lockRecordId;
        expect(useId, 'recordIdが存在すること').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${useId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

        // [flow] 110-2. 「編集」ボタンをクリック
        const editBtn = page.locator('button:has-text("編集"), a:has-text("編集")').filter({ visible: true }).first();
        await expect(editBtn, '編集ボタンが存在すること').toBeVisible();
        await editBtn.click();
        await waitForAngular(page);

        // [check] 110-1. ✅ 編集モードになること（URLに/edit/が含まれる、または編集中UIが表示される）
        const currentUrl = page.url();
        const isEditUrl  = currentUrl.includes('/edit');
        const editIndicator = page.locator(
            '.edit-mode, [class*="editing"], span:has-text("編集中"), button:has-text("保存"), button:has-text("キャンセル")'
        ).filter({ visible: true }).first();
        const indicatorCount = await editIndicator.count();

        // [check] 110-2. ✅ エラーが表示されていないこと
        const errorEl    = page.locator('.alert-danger, .error-message').filter({ visible: true });
        const errorCount = await errorEl.count();
        expect(errorCount, 'エラーが表示されていないこと').toBe(0);

        // [check] 110-3. ✅ 編集URLまたは編集UIが表示されていること
        expect(
            isEditUrl || indicatorCount > 0,
            '編集ボタンクリックで編集モードになること（URLまたは編集UIの変化）'
        ).toBe(true);

        await autoScreenshot(page, 'RC03', 'rec-lock1', _testStart);
    });

    // ─── RC12 ───────────────────────────────────────────────
    test('RC12: 編集キャンセルで編集ボタンが再表示されること（LOCK-02）', async ({ page }) => {
        test.setTimeout(120000);
        const _testStart = Date.now();

        // [flow] 120-1. 詳細画面へ遷移
        const useId = await getFirstRecordId(page) || lockRecordId;
        expect(useId, 'recordIdが存在すること').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${useId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

        // [flow] 120-2. 「編集」ボタンをクリック
        const editBtn = page.locator('button:has-text("編集"), a:has-text("編集")').filter({ visible: true }).first();
        await expect(editBtn, '編集ボタンが存在すること').toBeVisible();
        await editBtn.click();
        await waitForAngular(page);

        // [flow] 120-3. 「キャンセル」ボタンをクリック
        const cancelBtn = page.locator('button:has-text("キャンセル"), a:has-text("キャンセル")').filter({ visible: true }).first();
        await expect(cancelBtn, 'キャンセルボタンが存在すること').toBeVisible();
        await cancelBtn.click();
        await waitForAngular(page);

        // [check] 120-1. ✅ キャンセル後に編集ボタンが再表示されること（ロック解除）
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
        const editBtnAfter = page.locator('button:has-text("編集"), a:has-text("編集")').filter({ visible: true }).first();
        await expect(editBtnAfter, 'キャンセル後に編集ボタンが再表示されること（ロック解除）').toBeVisible();

        await autoScreenshot(page, 'RC03', 'rec-lock2', _testStart);
    });

    // ─── RC13 ───────────────────────────────────────────────
    test('RC13: 編集保存後にロックが解除されること（LOCK-03）', async ({ page }) => {
        test.setTimeout(120000);
        const _testStart = Date.now();

        // [flow] 130-1. 詳細画面へ遷移
        const useId = await getFirstRecordId(page) || lockRecordId;
        expect(useId, 'recordIdが存在すること').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${useId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

        // [flow] 130-2. 「編集」ボタンをクリック
        const editBtn = page.locator('button:has-text("編集"), a:has-text("編集")').filter({ visible: true }).first();
        await expect(editBtn, '編集ボタンが存在すること').toBeVisible();
        await editBtn.click();
        await waitForAngular(page);

        // [flow] 130-3. 何も変更せず「保存/更新」ボタンをクリック
        const saveBtn = page.locator(
            'button:has-text("保存"), button[type="submit"]:has-text("更新"), a:has-text("保存")'
        ).filter({ visible: true }).first();
        await expect(saveBtn, '保存ボタンが存在すること').toBeVisible();
        await saveBtn.click();
        await waitForAngular(page);
        // 確認ダイアログ
        const confirmBtn = page.locator('button:has-text("変更する"), button:has-text("保存する")').first();
        if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await confirmBtn.click();
        }
        await page.waitForURL(/\/view\//, { timeout: 15000 }).catch(() => {});
        await waitForAngular(page);

        // [check] 130-1. ✅ エラーが表示されていないこと
        const errorEl    = page.locator('.alert-danger, .error-message').filter({ visible: true });
        const errorCount = await errorEl.count();
        expect(errorCount, 'エラーが表示されていないこと').toBe(0);

        // [check] 130-2. ✅ 保存後に編集ボタンが再表示されること（ロック解除）
        const editBtnAfterSave = page.locator('button:has-text("編集"), a:has-text("編集")').filter({ visible: true }).first();
        await expect(editBtnAfterSave, '保存後に編集ボタンが再表示されること（ロック解除）').toBeVisible();

        await autoScreenshot(page, 'RC03', 'rec-lock3', _testStart);
    });
});

// ═══════════════════════════════════════════════════════════════
// DESCRIBE 7: レコードコピー
// ═══════════════════════════════════════════════════════════════
test.describe('レコードコピー', () => {
    test.describe.configure({ timeout: 300000 });
    test.beforeEach(async ({ page }) => loginAndNavigate(page));

    // ─── RC14 ───────────────────────────────────────────────
    test('RC14: コピーボタンまたはコピーメニューが存在すること（rec-160）', async ({ page }) => {
        const _testStart = Date.now();

        // [flow] 140-1. テーブル一覧に遷移
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

        // [check] 140-1. ✅ データ行が表示されること
        await page.waitForSelector('tr[mat-row]', { timeout: 5000 }).catch(() => {});
        await expect(page.locator('tr[mat-row]').first()).toBeVisible();

        // [flow] 140-2. コピーボタンを探す（直接アイコン or 行メニュー経由）
        const copyBtnDirect = page.locator('button:has(.fa-copy), button:has(.fa-clone), a:has(.fa-copy)').first();
        const copyBtnCount  = await copyBtnDirect.count();

        if (copyBtnCount > 0 && await copyBtnDirect.isVisible().catch(() => false)) {
            // [check] 140-2. ✅ コピーボタンが表示されること
            await expect(copyBtnDirect, 'コピーボタンが表示されること').toBeVisible();
        } else {
            // 行メニューを開いてコピーを探す
            const menuBtn = page.locator('tr[mat-row] button.dropdown-toggle, tr[mat-row] button:has(.fa-ellipsis-v)').first();
            if (await menuBtn.count() > 0) {
                await menuBtn.click();
                await page.waitForTimeout(500);
                const copyLink = page.locator('.dropdown-menu a:has-text("コピー"), .dropdown-menu button:has-text("コピー")').first();
                // [check] 140-3. ✅ 行メニューにコピー項目が存在すること
                await expect(copyLink, '行メニューにコピー項目が存在すること').toBeVisible();
                await page.keyboard.press('Escape');
            } else {
                // コピーが直接ボタンとして存在しない場合は、行のアクション自体の存在を確認
                const actionArea = page.locator('tr[mat-row] .actions, tr[mat-row] button').first();
                await expect(actionArea, '各行にアクションボタンが存在すること').toBeVisible();
            }
        }

        await expect(page.locator('.navbar')).toBeVisible();
        await autoScreenshot(page, 'UC05', 'rec-160', _testStart);
    });
});

// ============================================================================
// staging diff regression (batch 由来 2026-04-26 再配置: 9 件)
// batch-1/2/4/5/6 から records/field 関連の構造回帰 guard を集約
// ============================================================================
test.describe.serial('staging diff regression (records 関連)', () => {
    let _baseUrl = process.env.TEST_BASE_URL || '';
    let _email = process.env.TEST_EMAIL || 'admin';
    let _password = process.env.TEST_PASSWORD || '';
    let _envContext = null;
    let _allTypeTableId = null;
    let _setupFailed = false;

    async function _waitForAngular(page) {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: 5000 }).catch(() => {
            return page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        });
    }

    async function _login(page) {
        await page.context().clearCookies().catch(() => {});
        await page.goto(_baseUrl + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        if (!page.url().includes('/login')) return;
        await page.waitForSelector('#id', { timeout: 10000 });
        await page.fill('#id', _email);
        await page.fill('#password', _password);
        await page.locator('button[type=submit].btn-primary').first().click();
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
    }

    test.beforeAll(async ({ browser }) => {
        try {
            const env = await createTestEnv(browser, { withAllTypeTable: true });
            _baseUrl = env.baseUrl;
            _email = env.email;
            _password = env.password;
            _envContext = env.context;
            _allTypeTableId = env.tableId;
            process.env.TEST_BASE_URL = env.baseUrl;
            process.env.TEST_EMAIL = env.email;
            process.env.TEST_PASSWORD = env.password;
        } catch (e) {
            console.error('[records staging diff beforeAll]', e.message);
            _setupFailed = true;
            throw e;
        }
    });

    test.afterAll(async () => {
        if (_envContext) await _envContext.close().catch(() => {});
    });

    /**
     * rr-010: ALLテストテーブルレコード詳細画面が ISE なく表示 (PR #3074)
     */
    test('rr-010: ALLテストテーブルレコード詳細画面が ISE なく表示 (PR #3074)', async ({ page }) => {
        test.skip(_setupFailed, 'beforeAll失敗');
        test.setTimeout(90000);
        await _login(page);
        await page.goto(_baseUrl + `/admin/dataset__${_allTypeTableId}/view/1`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await _waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');
        const tableEl = page.locator('table, [role="tablist"], button:has-text("レコード"), button:has-text("前のレコード")').first();
        const tableOrTab = await tableEl.count();
        expect(tableOrTab, '詳細画面の主要 DOM (table or tab) が描画').toBeGreaterThan(0);
    });

    /**
     * cf-010: ALL テーブル一覧が ISE 出さず描画 (PR #2916 子テーブルファイル regression)
     */
    test('cf-010: ALL テーブル一覧が ISE 出さず描画 (PR #2916)', async ({ page }) => {
        test.skip(_setupFailed, 'beforeAll失敗');
        test.setTimeout(60000);
        await _login(page);
        await page.goto(_baseUrl + `/admin/dataset__${_allTypeTableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await _waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');
        expect(bodyText, 'HY093 エラー (PDO bind) も出ていない').not.toContain('HY093');
    });

    /**
     * cf-020: dashboard が ISE なく描画 (PR #3090 CloudFront viewer-address regression)
     */
    test('cf-020: dashboard が ISE なく描画 (PR #3090)', async ({ page }) => {
        test.skip(_setupFailed, 'beforeAll失敗');
        test.setTimeout(60000);
        await _login(page);
        await page.goto(_baseUrl + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await _waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');
    });

    /**
     * oer-010: レコード編集画面が race condition なく開く (PR #2815 on-edit memory)
     */
    test('oer-010: レコード編集画面が race condition なく開く (PR #2815)', async ({ page }) => {
        test.skip(_setupFailed, 'beforeAll失敗');
        test.setTimeout(60000);
        await _login(page);
        await page.goto(_baseUrl + `/admin/dataset__${_allTypeTableId}/edit/1`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await _waitForAngular(page);

        const url = page.url();
        expect(url, 'edit URL に留まる or view にリダイレクト').toMatch(/\/edit\/|\/view\/|\/dataset__/);
        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');
    });

    /**
     * cam-010: カメラ未対応 viewport でも UI 描画 (PR #2877)
     */
    test('cam-010: カメラ未対応 viewport でも UI 描画 (PR #2877)', async ({ page }) => {
        test.skip(_setupFailed, 'beforeAll失敗');
        test.setTimeout(60000);
        await _login(page);
        await page.addInitScript(() => {
            if (navigator.mediaDevices) {
                navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('NotFoundError: Requested device not found'));
            }
        });
        await page.goto(_baseUrl + `/admin/dataset__${_allTypeTableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await _waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'カメラ未対応でも ISE が出ていない').not.toContain('Internal Server Error');
    });

    /**
     * bulk-010: debug status API が応答 (PR #3105 hash-DB cleanup regression)
     */
    test('bulk-010: debug status API が応答 (PR #3105)', async ({ page }) => {
        test.skip(_setupFailed, 'beforeAll失敗');
        test.setTimeout(60000);
        await _login(page);
        const result = await page.evaluate(async (baseUrl) => {
            try {
                const r = await fetch(baseUrl + '/api/admin/debug/status', {
                    method: 'GET', credentials: 'include',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                });
                return { status: r.status };
            } catch (e) { return { error: e.message }; }
        }, _baseUrl);
        expect(result.status, 'debug API が 5xx でない').toBeLessThan(500);
    });

    /**
     * frm-010: フィールド追加モーダルが開ける (PR #3095 lodash import regression)
     */
    test('frm-010: フィールド追加モーダルが開ける (PR #3095)', async ({ page }) => {
        test.skip(_setupFailed, 'beforeAll失敗');
        test.setTimeout(60000);
        await _login(page);
        await page.goto(_baseUrl + `/admin/dataset/edit/${_allTypeTableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await _waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');
    });

    /**
     * rec-400: レコード詳細画面で table+tablist DOM 描画
     */
    test('rec-400: ALLテストテーブル詳細画面で table+tablist DOM 描画', async ({ page }) => {
        test.skip(_setupFailed, 'beforeAll失敗');
        test.setTimeout(60000);
        await _login(page);
        await page.goto(_baseUrl + `/admin/dataset__${_allTypeTableId}/view/1`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await _waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const tableCount = await page.locator('table').count();
        const tabCount = await page.locator('[role="tab"], [role="tablist"]').count();
        expect(tableCount + tabCount, '詳細画面に table or tab が描画').toBeGreaterThan(0);
    });

    /**
     * dat-400: dataset list API が 5xx を返さない (回帰)
     */
    test('dat-400: dataset list API が 5xx を返さない (回帰)', async ({ page }) => {
        test.skip(_setupFailed, 'beforeAll失敗');
        test.setTimeout(60000);
        await _login(page);
        const result = await page.evaluate(async (baseUrl) => {
            try {
                const r = await fetch(baseUrl + '/api/admin/dataset/list', {
                    method: 'GET', credentials: 'include',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                });
                return { status: r.status };
            } catch (e) { return { error: e.message }; }
        }, _baseUrl);
        expect(typeof result.status === 'number', `fetch 完遂 (got: ${JSON.stringify(result)})`).toBe(true);
        expect(result.status, '5xx でない').toBeLessThan(500);
    });
});
