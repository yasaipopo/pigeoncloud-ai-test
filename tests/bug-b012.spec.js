// @ts-check
const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { createTestEnv } = require('./helpers/create-test-env');

let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;

/**
 * Angular描画完了を待機
 */
async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

/**
 * 明示的ログイン
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    if (page.url().includes('/login')) {
        await page.fill('#id', EMAIL);
        await page.fill('#password', PASSWORD);
        await page.locator('button[type=submit].btn-primary').first().click();
        await page.waitForSelector('.navbar', { timeout: 20000 });
    }
}

const autoScreenshot = createAutoScreenshot('bug-b012');

test.describe('Slack報告バグ B012: kintone移行結果からの遷移', () => {
    test.beforeAll(async ({ browser }) => {
        test.setTimeout(120000);
        const env = await createTestEnv(browser, { withAllTypeTable: false });
        BASE_URL = env.baseUrl;
        EMAIL = env.email;
        PASSWORD = env.password;
        process.env.TEST_BASE_URL = env.baseUrl;
        process.env.TEST_EMAIL = env.email;
        process.env.TEST_PASSWORD = env.password;
        await env.context.close();
    });

    test('B012: kintone移行結果の「開く」ボタンからテーブル一覧に遷移できること', async ({ page }) => {
        test.setTimeout(120000);
        const _testStart = Date.now();

        await login(page);

        // 1. テスト用のテーブルを作成して ID を取得する
        const tableName = 'B012テストテーブル';
        const createTableRes = await page.evaluate(async (name) => {
            const res = await fetch('/api/admin/debug/create-light-table', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name,
                    fields: [{ name: 'テキスト', type: 'text' }]
                })
            });
            return await res.json();
        }, tableName);

        const tableId = createTableRes.table_id;
        expect(tableId).toBeDefined();
        console.log(`[B012] 作成されたテーブルID: ${tableId}`);

        // 2. kintone移行結果 API を mock する
        await page.route('**/api/admin/kintone/result/999', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    result: 'success',
                    status: 'done',
                    result_data: {
                        apps: [
                            {
                                status: 'success',
                                app_name: tableName,
                                table_id: tableId,
                                inserted: 10,
                                errors: {}
                            }
                        ],
                        total_inserted: 10
                    },
                    process_start: new Date().toISOString(),
                    process_end: new Date().toISOString()
                })
            });
        });

        // 3. 移行結果ページに遷移
        // [flow] B012-1. /admin/kintone-migration-result/999 に直接遷移（API mockを事前に仕込む）
        await page.goto(BASE_URL + '/admin/kintone-migration-result/999');
        await waitForAngular(page);

        // 結果が表示されるまで待機
        await expect(page.locator('.app-result-item.success')).toBeVisible({ timeout: 10000 });
        await expect(page.locator('strong')).toContainText(tableName);

        // 4. 「開く」ボタンをクリック
        // [flow] B012-2. リストに表示された「開く」ボタンをクリック
        const openBtn = page.locator('button').filter({ hasText: '開く' });
        await expect(openBtn).toBeVisible();
        await openBtn.click();

        // 5. 遷移先の URL を確認
        // [check] B012-3. ✅ 該当テーブルの一覧画面（/admin/dataset__N）に遷移していること
        // バグがある場合、/admin/list/N に行こうとして失敗するか、誤った URL になる
        const expectedUrl = new RegExp(`/admin/dataset__${tableId}`);
        await expect(page).toHaveURL(expectedUrl, { timeout: 10000 });

        await autoScreenshot(page, 'B012', 'result-navigation', _testStart);
    });
});
