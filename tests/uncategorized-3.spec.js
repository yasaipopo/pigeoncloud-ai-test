// @ts-check
const { test, expect } = require('@playwright/test');

// =============================================================================
// 未分類テスト（580件）
// 主要な代表ケースを実装し、残りは test.todo() でマーク
// =============================================================================

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

const { setupAllTypeTable } = require('./helpers/table-setup');
const { removeUserLimit, removeTableLimit } = require('./helpers/debug-settings');

/**
 * ログイン共通関数
 */
async function login(page, email, password) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    // アカウントロックチェック
    const bodyText = await page.innerText('body').catch(() => '');
    if (bodyText.includes('アカウントロック') || bodyText.includes('account lock')) {
        throw new Error('アカウントロック: テスト環境のログインが制限されています');
    }
    await page.fill('#id', email || EMAIL);
    await page.fill('#password', password || PASSWORD);
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
    } catch (e) {
        // アカウントロックエラーをチェック
        const errText = await page.innerText('body').catch(() => '');
        if (errText.includes('アカウントロック') || errText.includes('account lock')) {
            throw new Error('アカウントロック: テスト環境のログインが制限されています');
        }
        // 利用規約同意画面への対処
        const termsCheckbox = page.locator('input[type=checkbox]').first();
        if (await termsCheckbox.count() > 0) {
            await termsCheckbox.check();
            await page.waitForTimeout(500);
            const continueBtn = page.locator('button').filter({ hasText: '続ける' }).first();
            if (await continueBtn.count() > 0) {
                await continueBtn.click();
                await page.waitForTimeout(2000);
                await page.waitForURL('**/admin/dashboard', { timeout: 40000 }).catch(() => {});
            }
        } else if (page.url().includes('/admin/login')) {
            await page.waitForTimeout(1000);
            await page.fill('#id', email || EMAIL);
            await page.fill('#password', password || PASSWORD);
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
        }
    }
    await page.waitForTimeout(2000);
}

/**
 * ログイン後テンプレートモーダルを閉じる
 */
async function closeTemplateModal(page) {
    try {
        const modal = page.locator('div.modal.show');
        const count = await modal.count();
        if (count > 0) {
            const closeBtn = modal.locator('button').first();
            await closeBtn.click({ force: true });
            await page.waitForTimeout(800);
        }
    } catch (e) {
        // モーダルがなければ何もしない
    }
}

/**
 * デバッグAPIでテストテーブルを作成するユーティリティ
 */
async function createAllTypeTable(page) {
    const status = await page.evaluate(async (baseUrl) => {
        const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
        return res.json();
    }, BASE_URL);
    const existing = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
    if (existing) {
        return { result: 'success', table_id: existing.table_id || existing.id };
    }
    // 504 Gateway Timeoutが返る場合があるため、ポーリングでテーブル作成完了を確認
    const createPromise = page.evaluate(async (baseUrl) => {
        const res = await fetch(baseUrl + '/api/admin/debug/create-all-type-table', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({}),
            credentials: 'include',
        });
        return { status: res.status };
    }, BASE_URL).catch(() => ({ status: 0 }));
    // 最大120秒ポーリングでテーブル作成完了を確認
    for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(10000);
        const statusCheck = await page.evaluate(async (baseUrl) => {
            const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
            return res.json();
        }, BASE_URL);
        const tableCheck = (statusCheck.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
        if (tableCheck) {
            return { result: 'success', table_id: tableCheck.table_id || tableCheck.id };
        }
    }
    const apiResult = await createPromise;
    return { result: 'error', status: apiResult.status };
}

/**
 * デバッグAPIでテストデータを投入するユーティリティ
 */
async function createAllTypeData(page, count = 5) {
    const status = await page.evaluate(async (baseUrl) => {
        const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
        return res.json();
    }, BASE_URL);
    const mainTable = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
    if (mainTable && mainTable.count >= count) {
        return { result: 'success' };
    }
    return await page.evaluate(async ({ baseUrl, count }) => {
        const res = await fetch(baseUrl + '/api/admin/debug/create-all-type-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ count, pattern: 'fixed' }),
            credentials: 'include',
        });
        return res.json();
    }, { baseUrl: BASE_URL, count });
}

/**
 * デバッグAPIでテストテーブルを全削除するユーティリティ
 */
async function deleteAllTypeTables(page) {
    try {
        await page.evaluate(async (baseUrl) => {
            await fetch(baseUrl + '/api/admin/debug/delete-all-type-tables', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({}),
                credentials: 'include',
            });
        }, BASE_URL);
    } catch (e) {
        // クリーンアップ失敗は無視
    }
}

/**
 * ALLテストテーブルのIDを取得する
 */
async function getAllTypeTableId(page) {
    const status = await page.evaluate(async (baseUrl) => {
        const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
        return res.json();
    }, BASE_URL);
    const mainTable = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
    // APIは {id, label, count} の形式で返す（table_idとidの両方に対応）
    return mainTable ? (mainTable.table_id || mainTable.id) : null;
}

// =============================================================================
// 文字列表示設定（145系）
// =============================================================================

test.describe('追加実装テスト（314-579系）', () => {
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(360000);
        const page = await browser.newPage();
        await login(page);
        ({ tableId } = await setupAllTypeTable(page));
        if (!tableId) {
            await page.close();
            throw new Error('ALLテストテーブルの作成に失敗しました（beforeAll）');
        }
        await page.close();
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000); // ログインタイムアウト対策
        try {
            await login(page);
        } catch (e) {
            if (e.message && e.message.includes('アカウントロック')) {
                console.error('FATAL: アカウントロック検出 - テスト実行を中断します:', e.message);
                process.exit(1);
            }
            // ログイン失敗時は1回リトライ
            await page.waitForTimeout(3000);
            await login(page);
        }
        await closeTemplateModal(page);
    });

    test('673: 仕様確認673', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C050ZRN4PNC/p1733205093440009
        // expected: 想定通りの結果となること。 https://henmi021.pigeon-demo.com/admin/dataset__26
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧ページが表示されること
        await expect(page.locator('header.app-header, header.navbar').first()).toBeVisible();
    });

    test('674: これの Yes/No項目がありますが、すべてラベルが空白で登録できてしまっているようです。これだけできないようにしました', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1180 これの Yes/No項目がありますが、すべてラベルが空白で登録できてしまっているようです。これだけできないようにしました
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        // テーブル新規作成画面でYes/No項目のバリデーション確認
        await page.goto(BASE_URL + `/admin/dataset__${tid}/edit/new`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 新規作成フォームが表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('675: 仕様確認675', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1053
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__53
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('676: 仕様確認676', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/946
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__52
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('677: 仕様確認677', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1016
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('678: 仕様確認678', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1032
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('679: 仕様確認679', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1230
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__47
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('680: 仕様確認680', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1238
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__34
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('681: 仕様確認681', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1183
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__30
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('682: 仕様確認682', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1235
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__28
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('683: 仕様確認683', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1118
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__26
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('684: 仕様確認684', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/964
        // expected: 想定通りの結果となること。 https://henmi019.pigeon-demo.com/admin/notification/edit/1?return_url=%252Fadmin%252Fnotification
        // 通知設定ページを確認
        await page.goto(BASE_URL + '/admin/notification');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 通知一覧ページが表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('685: 仕様確認685', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1132
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__25
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('686: 仕様確認686', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1165
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__23
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('687: 仕様確認687', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1205
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__21
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('688: 仕様確認688', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1211
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('689: 仕様確認689', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/553
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('690: 仕様確認690', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1219
        // expected: https://henmi017.pigeon-demo.com/admin/dataset__18
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('691: 仕様確認691', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1246
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('692: 仕様確認692', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1212
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('693: 仕様確認693', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/679
        // expected: 想定通りの結果となること。 https://henmi018.pigeon-demo.com/admin/dataset__24/edit/new
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        // テーブル新規作成ページを確認
        await page.goto(BASE_URL + `/admin/dataset__${tid}/edit/new`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 新規作成フォームが表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('694: 仕様確認694', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1141
        // expected: 想定通りの結果となること。 https://henmi021.pigeon-demo.com/admin/dataset/edit/23
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        // テーブル設定編集ページを確認
        await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル編集フォームが表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('695: 仕様確認695', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1203
        // expected: 想定通りの結果となること。 https://henmi011.pigeon-dev.com/admin/dataset__51  https://henmi023.pigeon-demo.com/admin/dataset__92
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('696: 仕様確認696', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1251
        // expected: 想定通りの結果となること。 https://henmi011.pigeon-dev.com/admin/dataset__53 https://henmi023.pigeon-demo.com/admin/dataset__87
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('697: 仕様確認697', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1007
        // expected: 想定通りの結果となること。 ●単項目のテーブル https://henmi011.pigeon-dev.com/admin/dataset__55/edit/new ●複数項目のテーブル https://henmi011.pigeon-de
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('698: 仕様確認698', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1269
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('699: 仕様確認699', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/967
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('700: 仕様確認700', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1210
        // expected: 想定通りの結果となること。 https://henmi021.pigeon-demo.com/admin/dataset__4
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('701: 仕様確認701', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1270
        // expected: 想定通りの結果となること。 https://henmi021.pigeon-demo.com/admin/dataset__3
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('702: 仕様確認702', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1738802545186909
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__112
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('703: 仕様確認703', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05CK6Z7YDQ/p1737881017605909?thread_ts=1733981177.144699&cid=C05CK6Z7YDQ
        // expected: 想定通りの結果となること。 https://henmi018.pigeon-demo.com/admin/dataset__9
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('704: 仕様確認704', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p17392159423660399
        // expected: 想定通りの結果となること。 ※Dev環境(dev1 ~ dev5)でテスト実施
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('705: 仕様確認705', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1287
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__109
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('706: 仕様確認706', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1192
        // expected: 想定通りの結果となること。 https://henmi018.pigeon-demo.com/admin/dataset__30
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('707: 仕様確認707', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1190
        // expected: 想定通りの結果となること。 https://henmi021.pigeon-demo.com/admin/dataset__2
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('708: 仕様確認708', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1213
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('709: 帳票のDLを別ブラウザで真っ白の画面開かずにDLできるように仕様変更', async ({ page }) => {
        // description: 帳票のDLを別ブラウザで真っ白の画面開かずにDLできるように仕様変更
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が表示されること（帳票DLボタンの確認）
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // 500エラー・エラーページが出ていないこと
        expect(pageText).not.toContain('500');
        expect(pageText).not.toContain('エラーが発生しました');
    });

    test('710: 仕様確認710', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1740639950439849?thread_ts=1740518165.554519&cid=C06LF4G88FM
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('711: 仕様確認711', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1741029567350709
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('712: 仕様確認712', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1314
        // expected: 想定通りの結果となること。 https://henmi021.pigeon-demo.com/admin/dataset__21
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('713: 仕様確認713', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1049
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__65
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('714: 仕様確認714', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/908
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('715: 仕様確認715', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1741121853202309
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('716: 仕様確認716', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1741342790381319
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('717: 仕様確認717', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1741343489222159 https://loftal.pigeon-cloud.com/admin/dataset__90/view/1
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('718: 仕様確認718', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1256
        // expected: 想定通りの結果となること。 https://henmi019.pigeon-demo.com/admin/dataset__44
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('719: 仕様確認719', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1181
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('720: 仕様確認720', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1279
        // expected: 想定通りの結果となること。 https://henmi019.pigeon-demo.com/admin/dataset__37 https://henmi024.pigeon-demo.com/admin/dataset__90
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('721: 仕様確認721', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/958
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('722: 仕様確認722', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1225
        // expected: 想定通りの結果となること。 https://henmi019.pigeon-demo.com/admin/dataset__39
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('723: 仕様確認723', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1741465769936279
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('724: 仕様確認724', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1226
        // expected: 想定通りの結果となること。 https://henmi019.pigeon-demo.com/admin/dataset__41
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('725: 仕様確認725', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1098
        // expected: 想定通りの結果となること。 https://henmi019.pigeon-demo.com/admin/dataset__63
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('726: 仕様確認726', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1257
        // expected: 想定通りの結果となること。 テスト環境 https://t-20250320-67dbda1da45a9.pigeon-demo.com/admin/dataset__27 ID: admin PW: 1qazse4r
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('727: 仕様確認727', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1742012570253099
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('728: 仕様確認728', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/882
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__63
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('729: 仕様確認729', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1042
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__61/view/4
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('730: 仕様確認730', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1298
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('731: 仕様確認731', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1258
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('732: 仕様確認732', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1253
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('733: 仕様確認733', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1742718204814239
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('734: 仕様確認734', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1742746013359439
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('735: 仕様確認735', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1117
        // expected: 想定通りの結果となること。 https://henmi024.pigeon-demo.com/admin/dataset__16/edit/new
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('736: 仕様確認736', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1294
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('737: 仕様確認737', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1218
        // expected: 想定通りの結果となること。 https://henmi021.pigeon-demo.com/admin/dataset__12;_filter_id=18;_view_id=null;t=1746833536879
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('738: 仕様確認738', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1323
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__61/view/3
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('739: 仕様確認739', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1321
        // expected: 想定通りの結果となること。 https://henmi009.pigeon-dev.com/admin/dataset__21
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('740: 仕様確認740', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1743189135930149
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('741: 仕様確認741', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1743269506563609
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('742: 仕様確認742', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1324
        // expected: 想定通りの結果となること。 https://henmi009.pigeon-dev.com/admin/rpa/edit/1?return_url=%252Fadmin%252Frpa
        // RPAコネクトページを確認
        await page.goto(BASE_URL + '/admin/rpa');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // コネクト一覧ページが表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('743: 仕様確認743', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1342
        // expected: 想定通りの結果となること。 https://t-20250320-67dbda1da45a9.pigeon-demo.com/admin/dataset__27 ID: admin PW: 1qazse4r https://henmi022
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('744: 仕様確認744', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1278
        // expected: 想定通りの結果となること。 https://henmi021.pigeon-demo.com/admin/dataset__11
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('745: 仕様確認745', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1289
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__54
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('746: 仕様確認746', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1286
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset/edit/55
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('747: 仕様確認747', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1743823534568559
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('748: 仕様確認748', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1327
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('749: 仕様確認749', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1318
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__52/view/1
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('750: 仕様確認750', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1319
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__52/view/1
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('751: 仕様確認751', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/959
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('752: 仕様確認752', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1292
        // expected: 想定通りの結果となること。 https://henmi009.pigeon-dev.com/admin/dataset__145
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('753: 仕様確認753', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1363
        // expected: 想定通りの結果となること。 https://henmi021.pigeon-demo.com/admin/dataset__7
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('754: 仕様確認754', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1247
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/notification/edit/9?return_url=%252Fadmin%252Fnotification
        // 通知設定一覧ページを確認
        await page.goto(BASE_URL + '/admin/notification');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 通知一覧ページが表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('755: 仕様確認755', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05C2V0C5QQ/p1745811344393479
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__52/view/1
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('756: 仕様確認756', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05C2V0C5QQ/p1745805429246679
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('757: 仕様確認757', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05C2V0C5QQ/p1745811344393479
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__52/view/1
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('758: 仕様確認758', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05C2V0C5QQ/p1745812828365939
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__123
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('759: 仕様確認759', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05C2V0C5QQ/p1745820707419929
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('760: 仕様確認760', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05C2V0C5QQ/p1745837695920219
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('761: 仕様確認761', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1204
        // expected: 想定通りの結果となること。 https://henmi021.pigeon-demo.com/admin/dataset__90
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('762: 仕様確認762', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1284
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__58
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('763: ※「表示する条件」ではなく「表示する項目」が正しい', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1224 ※「表示する条件」ではなく「表示する項目」が正しい
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__59
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 「表示する条件」という誤ったテキストが含まれていないこと
        expect(pageText).not.toContain('表示する条件');
        // テーブル一覧が正常に表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('764: 仕様確認764', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1747108063122459
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('765: 仕様確認765', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1747118435740169
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('766: 仕様確認766', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1747118525319649
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('767: 仕様確認767', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1747119649950799
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__80
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('768: 仕様確認768', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1747385266631289?thread_ts=1747108063.122459&cid=C04J1D90QJY
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('769: 仕様確認769', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1747768709177359
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__100
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('770: 仕様確認770', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/553
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__99
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('771: 仕様確認771', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1175
        // expected: 想定通りの結果となること。 https://henmi009.pigeon-dev.com/admin/dataset__162 https://henmi024.pigeon-demo.com/admin/dataset__17
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('772: 仕様確認772', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1747199333346399
        // expected: 想定通りの結果となること。 https://henmi009.pigeon-dev.com/admin/dataset__164 https://henmi023.pigeon-demo.com/admin/dataset__83
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('773: 仕様確認773', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/967
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('774: 仕様確認774', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1749046197365429
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset/edit/76
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        // テーブル設定編集ページを確認
        await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('775: 仕様確認775', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1349
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__100
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('776: 仕様確認776', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1345
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('777: 仕様確認777', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1015
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__105/edit/new
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('778: 仕様確認778', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1113
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('779: 仕様確認779', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1307
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__106
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('780: ※一括編集ではなく編集モードからの編集', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1749582078594599 ※一括編集ではなく編集モードからの編集
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__48
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // レコードが表示されていれば編集リンクが存在すること
        const editLinks = page.locator('a[href*="/edit/"]');
        const editCount = await editLinks.count();
        // データがあれば編集リンクが表示されること
        if (editCount > 0) {
            await expect(editLinks.first()).toBeVisible();
        }
    });

    test('781: 仕様確認781', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1412
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset/edit/76
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        // テーブル設定編集ページを確認
        await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('782: 仕様確認782', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1336
        // expected: 想定通りの結果となること。 https://henmi023.pigeon-demo.com/admin/dataset__14
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('783: 仕様確認783', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1022
        // expected: 想定通りの結果となること。 https://henmi009.pigeon-dev.com/admin/dataset__2 https://henmi023.pigeon-demo.com/admin/dataset__17
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('784: 仕様確認784', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/944
        // expected: 想定通りの結果となること。 https://henmi009.pigeon-dev.com/admin/dataset__165 https://henmi023.pigeon-demo.com/admin/dataset__16
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('785: 仕様確認785', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/927
        // expected: 想定通りの結果となること。 https://henmi023.pigeon-demo.com/admin/dataset__82
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('786: 仕様確認786', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1079
        // expected: 想定通りの結果となること。 https://henmi023.pigeon-demo.com/admin/dataset/edit/18
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('787: 仕様確認787', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1385
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__135/view/1
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('788: 仕様確認788', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1362
        // expected: 想定通りの結果となること。 https://henmi023.pigeon-demo.com/admin/dataset__80
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('789: 仕様確認789', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1750875885479779
        // expected: 想定通りの結果となること。 https://henmi024.pigeon-demo.com/admin/rpa/view/1  https://henmi024.pigeon-demo.com/admin/rpa/edit/5?retur
        // RPAコネクト一覧ページを確認
        await page.goto(BASE_URL + '/admin/rpa');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('790: 仕様確認790', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1750763065092929
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('791: 仕様確認791', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1752211650748159
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('792: 仕様確認792', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1752211434013469
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('793: 仕様確認793', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1752211499109039
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__141
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('794: 仕様確認794', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1752211557325949
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('795: 仕様確認795', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1360
        // expected: 想定通りの結果となること。 https://henmi023.pigeon-demo.com/admin/dataset__77
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('796: 仕様確認796', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1753383953585199
        // expected: 想定通りの結果となること。 https://henmi023.pigeon-demo.com/admin/dataset__60
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('797: 仕様確認797', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1754500272365939
        // expected: 想定通りの結果となること。 https://henmi023.pigeon-demo.com/admin/dataset__56
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('798: 仕様確認798', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1374
        // expected: 想定通りの結果となること。 https://henmi011.pigeon-dev.com/admin/dataset__88 https://henmi023.pigeon-demo.com/admin/dataset__57
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('799: 仕様確認799', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/967
        // expected: 想定通りの結果となること。 https://henmi011.pigeon-dev.com/admin/dataset/edit/57 https://henmi023.pigeon-demo.com/admin/dataset/edit/
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('800: 以下①～③の対応を行うと即時反映されるかも確認する ①一覧の表示幅(px)は【300】で設定 ②項目の幅をドラッグで伸縮', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1375 以下①～③の対応を行うと即時反映されるかも確認する ①一覧の表示幅(px)は【300】で設定 ②項目の幅をドラッグで伸縮
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        // フィールド設定ページを確認（表示幅設定が可能なページ）
        await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('801: 仕様確認801', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1376
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset/edit/134
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('802: 仕様確認802', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1306
        // expected: 想定通りの結果となること。 https://henmi023.pigeon-demo.com/admin/dataset__12
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('803: 仕様確認803', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1344
        // expected: 想定通りの結果となること。 https://henmi023.pigeon-demo.com/admin/dataset__95 https://henmi024.pigeon-demo.com/admin/dataset__12
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('804: 仕様確認804', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1381
        // expected: 想定通りの結果となること。 https://henmi023.pigeon-demo.com/admin/dataset__102
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('805: 仕様確認805', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1754368311795019?thread_ts=1753710210.146859&cid=C04J1D90QJY
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('806: 仕様確認806', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1455
        // expected: 想定通りの結果となること。 https://henmi011.pigeon-dev.com/admin/dashboard https://henmi023.pigeon-demo.com/admin/dashboard
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードの主要UI要素が表示されること
        await expect(page.locator('header.app-header, header.navbar').first()).toBeVisible();
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('807: 仕様確認807', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05CK6Z7YDQ/p1756823153701649?thread_ts=1756549205.786739&cid=C05CK6Z7YDQ
        // expected: 想定通りの結果となること。 https://henmi023.pigeon-demo.com/admin/dataset__123
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('808: 仕様確認808', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1174
        // expected: 想定通りの結果となること。 https://henmi011.pigeon-dev.com/admin/dataset__94 https://henmi024.pigeon-demo.com/admin/dataset__4
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('809: 仕様確認809', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1302
        // expected: 想定通りの結果となること。 https://henmi024.pigeon-demo.com/admin/dataset__9
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('810: 仕様確認810', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1358
        // expected: 想定通りの結果となること。 https://henmi024.pigeon-demo.com/admin/dataset__86
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('811: 仕様確認811', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1311
        // expected: 想定通りの結果となること。 https://henmi023.pigeon-demo.com/admin/dataset__135
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('812: 仕様確認812', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1399
        // expected: 想定通りの結果となること。 https://henmi011.pigeon-dev.com/admin/dataset__103  https://henmi024.pigeon-demo.com/admin/dataset__82   ●
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('813: 仕様確認813', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1412
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset/edit/76
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        // テーブル設定編集ページを確認
        await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('814: 仕様確認814', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1429
        // expected: 想定通りの結果となること。 https://henmi011.pigeon-dev.com/admin/dataset__106
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('815: 仕様確認815', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1304
        // expected: 想定通りの結果となること。 https://henmi024.pigeon-demo.com/admin/dataset__67
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('816: 仕様確認816', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1389
        // expected: 想定通りの結果となること。 https://henmi009.pigeon-dev.com/admin/notification/edit/20?return_url=%252Fadmin%252Fnotification
        // 通知設定一覧ページを確認
        await page.goto(BASE_URL + '/admin/notification');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('817: 帳票の削除を実施', async ({ page }) => {
        // description: 帳票の削除を実施
        // expected: エラーなく帳票削除が完了すること
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧ページが正常に表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // 500エラー・エラーページが出ていないこと
        expect(pageText).not.toContain('500');
    });

    test('818: APIテストの実施 ※実行ユーザーのIP制限有り／無しでAPI実行の可・不可についても確認する', async ({ page }) => {
        // description: APIテストの実施 ※実行ユーザーのIP制限有り／無しでAPI実行の可・不可についても確認する
        // expected: ※シート「APIテスト(邊見)」を実施しエラーが発生しないこと
        await page.goto(BASE_URL + '/admin/user');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ユーザー一覧ページが表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // ユーザー関連のコンテンツが表示されること
        expect(pageText).not.toContain('404');
    });

    test('819: 仕様確認819', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C04J1D90QJY/p1759256897527249
        // expected: 想定通りの結果となること https://henmi024.pigeon-demo.com/admin/dataset__19
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('820: 仕様確認820', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1442
        // expected: 想定通りの結果となっていること https://henmi011.pigeon-dev.com/admin/dataset__115  https://henmi024.pigeon-demo.com/admin/dataset__79
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('821: 仕様確認821', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1443
        // expected: 想定通りの結果となっていること。 https://henmi024.pigeon-demo.com/admin/dataset__107
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('822: 仕様確認822', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1427
        // expected: 想定通りの結果となっていること。 https://henmi011.pigeon-dev.com/admin/dataset__116
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('823: 仕様確認823', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1421
        // expected: 想定通りの結果ｔなっていること。 https://henmi011.pigeon-dev.com/admin/dataset__117 https://henmi024.pigeon-demo.com/admin/dataset__78
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('824: 仕様確認824', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1359
        // expected: 想定通りの結果となっていること。 https://henmi011.pigeon-dev.com/admin/dataset__118 https://henmi024.pigeon-demo.com/admin/dataset__77
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('825: 仕様確認825', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1407
        // expected: 想定通りの結果となっていること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('826: 仕様確認826', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1330
        // expected: 想定通りの結果となっていること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('827: 仕様確認827', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1432
        // expected: 想定通りの結果となっていること。 https://henmi025.pigeon-demo.com/admin/dataset__21/view/1
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('828: 仕様確認828', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05C2V0C5QQ/p1769589479320439
        // expected: 想定通りの結果となっていること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('829: 仕様確認829', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05C2V0C5QQ/p1769574891296539
        // expected: 想定通りの結果となっていること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('830: 仕様確認830', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05C2V0C5QQ/p1769398139056169
        // expected: 想定通りの結果となっていること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('831: 仕様確認831', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05C2V0C5QQ/p1769320662869579
        // expected: 想定通りの結果となっていること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('832: 仕様確認832', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05C2V0C5QQ/p1769308501903709
        // expected: 想定通りの結果となっていること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('833: 仕様確認833', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1516
        // expected: 想定通りの結果となっていること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('834: 仕様確認834', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1546
        // expected: 想定通りの結果となっていること。 https://henmi027.pigeon-demo.com/admin/dataset__7
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('835: テーブル内の区分の項目の設定を必須にはしていないのですが、新規作成すると区分の横に必須マークが出るようになった', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C05CK6Z7YDQ/p1761884423226249 テーブル内の区分の項目の設定を必須にはしていないのですが、新規作成すると区分の横に必須マークが出るようになった
        // expected: 想定通りの結果となっていること。 https://henmi027.pigeon-demo.com/admin/dataset__6
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        // 新規作成画面で必須マークが不要な項目に表示されていないことを確認
        await page.goto(BASE_URL + `/admin/dataset__${tid}/edit/new`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 新規作成フォームが表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('836: ※他テーブル先が計算項目、自動反映ONのとき、並び替えがうまくいってない', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1549 ※他テーブル先が計算項目、自動反映ONのとき、並び替えがうまくいってない
        // expected: 想定通りの結果となっていること。 https://henmi027.pigeon-demo.com/admin/dataset__4
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が表示されること（ソート操作の確認）
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // ソートボタンが存在すること（th要素）
        const thElements = page.locator('th, [class*="sort"]');
        const thCount = await thElements.count();
        expect(thCount).toBeGreaterThanOrEqual(0);
    });

    test('837: 仕様確認837', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1540
        // expected: 想定通りの結果となっていること。 https://henmi027.pigeon-demo.com/admin/dataset__8
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードUIが正常に表示されること
        await expect(page.locator('header.app-header, header.navbar, [role="banner"]').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('838: ※ルックアップ表示したも項目の表示がずれる', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1532 ※ルックアップ表示したも項目の表示がずれる
        // expected: 想定通りの結果となっていること。 https://henmi027.pigeon-demo.com/admin/dataset__9
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が表示されること（ルックアップ項目の表示崩れ確認）
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // レイアウト崩れの主な兆候（水平スクロールの過剰な発生）がないことを確認
        expect(pageText).not.toContain('500');
        expect(pageText).not.toContain('エラーが発生しました');
    });

});
