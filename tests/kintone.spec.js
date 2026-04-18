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

const autoScreenshot = createAutoScreenshot('kintone');

test.describe('kintone移行機能', () => {
    test.beforeAll(async ({ browser }) => {
        test.setTimeout(120000);
        // テスト環境の作成
        const env = await createTestEnv(browser, { withAllTypeTable: false });
        BASE_URL = env.baseUrl;
        EMAIL = env.email;
        PASSWORD = env.password;
        process.env.TEST_BASE_URL = env.baseUrl;
        process.env.TEST_EMAIL = env.email;
        process.env.TEST_PASSWORD = env.password;
        await env.context.close();
    });

    test.beforeEach(async ({ page }) => {
        await login(page);
    });

    test('b007-010: kintone移行：アプリ一覧取得〜移行開始（正常系）', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();

        // [flow] 1. /admin/kintone-migration に直接遷移
        await page.goto(BASE_URL + '/admin/kintone-migration');
        await waitForAngular(page);

        // [check] 移行前の注意事項が表示されていること
        await expect(page.locator('body')).toContainText('kintoneから乗り換え');
        await expect(page.locator('body')).toContainText('移行前の注意事項');

        // [flow] 2. 注意事項に同意して次へ
        await page.click('input[type="checkbox"]');
        await page.click('button:has-text("同意して続ける")');
        await page.waitForTimeout(1000);

        // [check] 資格情報入力画面が表示されること
        await expect(page.locator('body')).toContainText('kintone ログイン情報');

        // [flow] 3. 資格情報を入力してアプリ一覧を取得（API mock）
        await page.route('**/api/admin/kintone/apps', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    apps: [
                        { app_id: '1', name: '顧客管理アプリ' },
                        { app_id: '2', name: '案件管理アプリ' }
                    ]
                })
            });
        });

        await page.fill('input[placeholder="your-company"]', 'test-domain');
        await page.fill('input[placeholder="admin@example.com"]', 'test-user');
        await page.fill('input[placeholder="パスワード"]', 'test-password');
        
        await page.click('button:has-text("アプリ一覧を取得")');
        await page.waitForTimeout(1000);

        // [check] 10. ✅ kintoneのアプリ一覧が表示されること（API mock）
        await expect(page.locator('body')).toContainText('移行するアプリを選択');
        await expect(page.locator('body')).toContainText('顧客管理アプリ');

        // [flow] 4. アプリを選択して設定画面へ（API mock）
        await page.route('**/api/admin/kintone/app-details/1', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    app_id: '1',
                    name: '顧客管理アプリ',
                    fields: [
                        { code: 'company_name', label: '会社名', type: 'SINGLE_LINE_TEXT' },
                        { code: 'address', label: '住所', type: 'SINGLE_LINE_TEXT' }
                    ]
                })
            });
        });

        await page.click('text=顧客管理アプリ');
        await page.click('button:has-text("次へ")');
        await page.waitForTimeout(1000);

        // [check] 12. ✅ 移行設定画面（テーブル名、項目一覧）が表示されること
        await expect(page.locator('body')).toContainText('移行設定');
        await expect(page.locator('input[value="顧客管理アプリ"]')).toBeVisible();

        // [flow] 5. 移行開始（API mock）
        await page.route('**/api/admin/kintone/migrate', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ job_id: '999' })
            });
        });

        await page.click('button:has-text("移行開始")');
        await page.waitForURL(/admin\/kintone-migration-result\/999/);
        
        await autoScreenshot(page, 'KT01', 'b007-010', _testStart);
    });

    test('b007-020: kintone移行：同一テーブル名バリデーション', async ({ page }) => {
        const _testStart = Date.now();

        await page.goto(BASE_URL + '/admin/kintone-migration');
        await page.click('input[type="checkbox"]');
        await page.click('button:has-text("同意して続ける")');

        await page.route('**/api/admin/kintone/apps', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ apps: [{ app_id: '1', name: '既存テーブル' }] })
            });
        });

        await page.fill('input[placeholder="your-company"]', 'test');
        await page.fill('input[placeholder="admin@example.com"]', 'test');
        await page.fill('input[placeholder="パスワード"]', 'test');
        await page.click('button:has-text("アプリ一覧を取得")');

        await page.route('**/api/admin/kintone/app-details/1', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ app_id: '1', name: '既存テーブル', fields: [] })
            });
        });

        await page.click('text=既存テーブル');
        await page.click('button:has-text("次へ")');

        await page.fill('input[label="移行先テーブル名"]', '既存テーブル'); 
        
        await page.route('**/api/admin/kintone/migrate', async (route) => {
            await route.fulfill({
                status: 400,
                contentType: 'application/json',
                body: JSON.stringify({ error: '既に存在するテーブル名です' })
            });
        });

        await page.click('button:has-text("移行開始")');

        await expect(page.locator('.text-danger')).toContainText('既に存在するテーブル名です');

        await autoScreenshot(page, 'KT01', 'b007-020', _testStart);
    });

    test('b007-030: kintone移行：レコード移行オプションの確認', async ({ page }) => {
        const _testStart = Date.now();

        await page.goto(BASE_URL + '/admin/kintone-migration');
        await page.click('input[type="checkbox"]');
        await page.click('button:has-text("同意して続ける")');

        await page.route('**/api/admin/kintone/apps', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ apps: [{ app_id: '1', name: 'テストアプリ' }] })
            });
        });
        await page.fill('input[placeholder="your-company"]', 'test');
        await page.fill('input[placeholder="admin@example.com"]', 'test');
        await page.fill('input[placeholder="パスワード"]', 'test');
        await page.click('button:has-text("アプリ一覧を取得")');

        await page.route('**/api/admin/kintone/app-details/1', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    app_id: '1',
                    name: 'テストアプリ',
                    fields: [
                        { code: 'f1', label: '項目1', type: 'SINGLE_LINE_TEXT' },
                        { code: 'f2', label: '項目2', type: 'SINGLE_LINE_TEXT' }
                    ]
                })
            });
        });

        await page.click('text=テストアプリ');
        await page.click('button:has-text("次へ")');

        const recordOption = page.locator('label:has-text("レコードも移行する")').locator('input[type="checkbox"]');
        await expect(recordOption).toBeVisible();
        await recordOption.check();
        expect(await recordOption.isChecked()).toBe(true);
        await recordOption.uncheck();
        expect(await recordOption.isChecked()).toBe(false);

        await expect(page.locator('body')).toContainText('項目1');
        await expect(page.locator('body')).toContainText('項目2');

        await autoScreenshot(page, 'KT01', 'b007-030', _testStart);
    });

    test('B012: kintone移行結果の「開く」ボタンからテーブル一覧に遷移できること', async ({ page }) => {
        test.setTimeout(120000);
        const _testStart = Date.now();

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
        await page.goto(BASE_URL + '/admin/kintone-migration-result/999');
        await waitForAngular(page);

        await expect(page.locator('.app-result-item.success')).toBeVisible({ timeout: 10000 });
        await expect(page.locator('strong')).toContainText(tableName);

        // 4. 「開く」ボタンをクリック
        const openBtn = page.locator('button').filter({ hasText: '開く' });
        await expect(openBtn).toBeVisible();
        await openBtn.click();

        // 5. 遷移先の URL を確認
        const expectedUrl = new RegExp(`/admin/dataset__${tableId}`);
        await expect(page).toHaveURL(expectedUrl, { timeout: 10000 });

        await autoScreenshot(page, 'KT01', 'B012-result-navigation', _testStart);
    });
});
