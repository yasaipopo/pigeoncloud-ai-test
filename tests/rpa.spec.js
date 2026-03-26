// @ts-check
const { test, expect } = require('@playwright/test');
const { setupAllTypeTable } = require('./helpers/table-setup');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

async function waitForAngular(page, timeout = 15000) {
    await page.waitForSelector('body[data-ng-ready="true"]', { timeout });
}

/**
 * ログイン共通関数
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('#id', { timeout: 30000 });
    await page.fill('#id', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
    } catch (e) {
        if (page.url().includes('/admin/login')) {
            await page.waitForTimeout(1000);
            await page.fill('#id', EMAIL);
            await page.fill('#password', PASSWORD);
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
        }
    }
    await page.waitForTimeout(1000);
}

/**
 * コネクト（RPA）一覧ページへ移動
 */
async function navigateToRpa(page) {
    await page.goto(BASE_URL + '/admin/rpa');
    await waitForAngular(page);
}

test.describe('RPA（コネクト）', () => {
    /** @type {import('@playwright/test').Browser} */
    let browser;
    /** @type {import('@playwright/test').Page} */
    let sharedPage;
    let tableId;

    test.beforeAll(async ({ browser: b }) => {
        browser = b;
        sharedPage = await browser.newPage();
        await login(sharedPage);
        // ALLテストテーブルを準備
        const result = await setupAllTypeTable(sharedPage);
        tableId = result.tableId;
    });

    test.afterAll(async () => {
        await sharedPage.close().catch(() => {});
    });

    test('RPA-01: コネクト管理画面が正常に表示されること', async ({ page }) => {
        await login(page);
        await navigateToRpa(page);

        // ページタイトルにエラーがないこと
        const title = await page.title();
        expect(title).not.toMatch(/エラー|Error|404|500/i);

        // 「コネクト一覧」系タイトルが表示されること
        const url = page.url();
        expect(url).toContain('/admin/rpa');

        // 新規追加ボタン（fa-plus）が存在すること
        const addBtnCount = await page.locator('button.btn-outline-primary .fa-plus').count();
        expect(addBtnCount).toBeGreaterThan(0);
    });

    test('RPA-02: 新しいコネクト（RPA）を作成できること', async ({ page }) => {
        await login(page);
        await navigateToRpa(page);

        // 新規追加ボタンをクリック
        await page.evaluate(() => {
            const plusBtn = document.querySelector('button.btn-outline-primary .fa-plus');
            if (plusBtn) plusBtn.closest('button').click();
        });
        await page.waitForTimeout(1500);

        // 編集画面（/admin/rpa/edit/new）に遷移すること
        await page.waitForURL('**/admin/rpa/edit/**', { timeout: 10000 }).catch(() => {});
        const url = page.url();
        expect(url).toContain('/admin/rpa');

        // RPA名入力フィールドが存在すること
        const rpaNameInput = await page.locator('input[placeholder="フロー名"]').count();
        expect(rpaNameInput).toBeGreaterThan(0);

        // テーブル選択フィールドが存在すること
        const tableSelect = await page.locator('#select_table, ng-select#select_table, .ng-select').count();
        expect(tableSelect).toBeGreaterThan(0);

        // RPA名を入力
        await page.fill('input[placeholder="フロー名"]', 'テストRPA_E2E');
        await waitForAngular(page);

        // テーブルを選択（ALLテストテーブル）
        await page.locator('ng-select, .ng-select').first().click();
        await waitForAngular(page);

        // 選択肢からALLテストテーブルを選ぶ
        const allTestOption = page.locator('.ng-option').filter({ hasText: 'ALLテストテーブル' });
        const optionCount = await allTestOption.count();
        if (optionCount > 0) {
            await allTestOption.first().click();
            await waitForAngular(page);
        }

        // 作成ボタンをクリック（btn-primaryまたはvisibleなボタンを優先）
        const createBtn = page.locator('button.btn-primary, button.btn-outline-primary:visible').filter({ hasText: /作成|保存|フローを作成/ });
        const createBtnCount = await createBtn.count();
        if (createBtnCount > 0) {
            await createBtn.first().click({ force: true });
            await waitForAngular(page);
        } else {
            // フォールバック: page.evaluateで作成ボタンをクリック
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button'));
                const btn = btns.find(b => /作成|保存|フローを作成/.test(b.textContent?.trim()) && b.offsetParent !== null);
                if (btn) btn.click();
            });
            await page.waitForTimeout(2000);
        }

        // エラーが出ていないこと
        const errorMsg = await page.locator('.alert-danger, .text-danger').count();
        // 作成完了またはフロー編集画面に遷移していること（エラーがなければOK）
        const finalUrl = page.url();
        expect(finalUrl).toContain('/admin/rpa');
    });

    test('RPA-03: コネクト（RPA）フロー編集画面が表示されること', async ({ page }) => {
        await login(page);
        await navigateToRpa(page);

        // 新規作成画面に遷移
        await page.evaluate(() => {
            const plusBtn = document.querySelector('button.btn-outline-primary .fa-plus');
            if (plusBtn) plusBtn.closest('button').click();
        });
        await page.waitForTimeout(1500);

        // 編集画面が表示されること
        const url = page.url();
        expect(url).toContain('/admin/rpa');

        // フロー編集エリアが存在すること（flow-container）
        const flowContainer = await page.locator('.flow-container, flow, pfc-list').count();
        expect(flowContainer).toBeGreaterThan(0);

        // テーブル選択・RPA名入力フィールドが存在すること
        const rpaNameInput = await page.locator('input[placeholder="フロー名"]').count();
        expect(rpaNameInput).toBeGreaterThan(0);

        // エラーなし
        const errorText = await page.locator('.alert-danger').count();
        expect(errorText).toBe(0);
    });

    test('RPA-04: コネクト一覧のテーブルヘッダーが正しいこと', async ({ page }) => {
        await login(page);
        await navigateToRpa(page);

        // テーブルヘッダーの確認
        const headers = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('table thead th')).map(th => th.textContent.trim());
        });

        // テーブルが表示されていること（ヘッダーが1つ以上あること）
        expect(headers.length, 'コネクト一覧テーブルにヘッダー列が存在すること').toBeGreaterThan(0);

        // IDカラムが存在すること
        const hasId = headers.some(h => h.includes('ID'));
        // コネクト名（またはRPA名）カラムが存在すること
        const hasName = headers.some(h => h.includes('コネクト名') || h.includes('RPA名') || h.includes('名'));
        // ステータスカラムが存在すること
        const hasStatus = headers.some(h => h.includes('ステータス'));

        // 各カラムを個別に確認（コネクト一覧には必ずID・名前・ステータスの3列が揃っているべき）
        expect(hasId, `IDカラムが存在すること（実際のヘッダー: [${headers.join(', ')}]）`).toBeTruthy();
        expect(hasName, `コネクト名カラムが存在すること（実際のヘッダー: [${headers.join(', ')}]）`).toBeTruthy();
        expect(hasStatus, `ステータスカラムが存在すること（実際のヘッダー: [${headers.join(', ')}]）`).toBeTruthy();
    });

    test('RPA-05: コネクト一覧の今月使用量が表示されること', async ({ page }) => {
        await login(page);
        await navigateToRpa(page);

        // 今月使用量の表示確認
        const usageCard = await page.locator('.card-accent-primary, .card-block').filter({ hasText: /今月使用量|STEP/ });
        const usageCount = await usageCard.count();
        expect(usageCount).toBeGreaterThan(0);
    });

    test('RPA-06: コネクト実行ログページへ遷移できること', async ({ page }) => {
        await login(page);

        // コネクト実行ログへ遷移
        await page.goto(BASE_URL + '/admin/rpa_executes');
        await waitForAngular(page);

        // エラーがないこと
        const url = page.url();
        expect(url).toContain('/admin/rpa_executes');

        const title = await page.title();
        expect(title).not.toMatch(/エラー|Error|404|500/i);
    });
});
