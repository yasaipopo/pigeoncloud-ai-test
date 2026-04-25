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
    // 古い環境の cookie をクリア
    await page.context().clearCookies().catch(() => {});

    await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    if (!page.url().includes('/login')) {
        await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
        return;
    }

    await page.waitForSelector('#id', { timeout: 10000 });
    await page.fill('#id', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.locator('button[type=submit].btn-primary').first().click();
    await page.waitForURL(/\/(admin\/dashboard|admin\/[a-z_]+)/, { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.navbar', { timeout: 15000 });
}

const autoScreenshot = createAutoScreenshot('kintone');

test.describe('kintone移行機能', () => {
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

    test.beforeEach(async ({ page }) => {
        await login(page);
    });

    test('b007-010: kintone移行：アプリ一覧取得〜移行開始（正常系）', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();

        // 1. /admin/kintone-migration に直接遷移
        await page.goto(BASE_URL + '/admin/kintone-migration');
        await waitForAngular(page);

        // 移行前の注意事項
        await expect(page.locator('.disclaimer-box')).toContainText('移行前の注意事項');

        // 2. 注意事項に同意して次へ
        await page.check('label.agree-label input[type="checkbox"]');
        await page.click('button:has-text("同意して続ける")');

        // 資格情報入力画面
        await expect(page.getByText('kintone認証情報を入力')).toBeVisible();

        // 3. 資格情報を入力してアプリ一覧を取得
        await page.route('**/api/admin/kintone/apps', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    result: 'success',
                    apps: [
                        { appId: '1', name: '顧客管理アプリ', description: '', spaceId: null, createdAt: '' },
                        { appId: '2', name: '案件管理アプリ', description: '', spaceId: null, createdAt: '' }
                    ]
                })
            });
        });

        await page.fill('input[placeholder="your-company"]', 'test-domain');
        await page.fill('input[placeholder="admin@example.com"]', 'test-user');
        await page.fill('input[placeholder="パスワード"]', 'test-password');
        
        await page.click('button:has-text("アプリ一覧を取得")');
        await expect(page.locator('.app-name').filter({ hasText: '顧客管理アプリ' })).toBeVisible({ timeout: 15000 });

        // 4. アプリを選択して移行確認へ
        await page.click('text=顧客管理アプリ');
        await page.click('button:has-text("1件のアプリを移行する")');

        // 5. 一括移行開始
        await page.route('**/api/admin/kintone/migrate-async', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ result: 'success', job_log_id: 999, message: 'started' })
            });
        });

        await page.click('button:has-text("1件のアプリを一括移行する")');
        
        // キュー投入完了
        await expect(page.getByText('バックグラウンドで移行を開始しました')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('.queued-info')).toContainText('ジョブID: 999');
        
        // 結果ページへ
        await page.click('button:has-text("結果ページを開く")');
        await page.waitForURL(new RegExp(`/admin/kintone-migration-result/999`));
        
        await autoScreenshot(page, 'KT01', 'b007-010', _testStart);
    });

    test('b007-020: kintone移行：同一テーブル名バリデーション', async ({ page }) => {
        const _testStart = Date.now();

        await page.goto(BASE_URL + '/admin/kintone-migration');
        await page.check('label.agree-label input[type="checkbox"]');
        await page.click('button:has-text("同意して続ける")');

        await page.route('**/api/admin/kintone/apps', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ 
                    result: 'success',
                    apps: [{ appId: '1', name: '既存テーブル', description: '', spaceId: null, createdAt: '' }] 
                })
            });
        });

        await page.fill('input[placeholder="your-company"]', 'test');
        await page.fill('input[placeholder="admin@example.com"]', 'test');
        await page.fill('input[placeholder="パスワード"]', 'test');
        await page.click('button:has-text("アプリ一覧を取得")');

        await page.click('text=既存テーブル');
        await page.click('button:has-text("1件のアプリを移行する")');

        // Mock error from migrate-async (API level validation)
        // status 200 + result:error で next() 分岐の error_a パスを通す
        // (status 400 だと Angular HttpClient が err.error に body を入れるが
        //  Connect サービスが間で wrap する可能性があるため status 200 で返す)
        await page.route('**/api/admin/kintone/migrate-async', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ result: 'error', error_a: ['既に存在するテーブル名です'] })
            });
        });

        await page.click('button:has-text("1件のアプリを一括移行する")');

        // Check error message in .alert-danger
        await expect(page.locator('.alert-danger')).toContainText('既に存在するテーブル名です');

        await autoScreenshot(page, 'KT01', 'b007-020', _testStart);
    });

    test('b007-030: kintone移行：レコード移行オプションの確認', async ({ page }) => {
        const _testStart = Date.now();

        await page.goto(BASE_URL + '/admin/kintone-migration');
        await page.check('label.agree-label input[type="checkbox"]');
        await page.click('button:has-text("同意して続ける")');

        await page.route('**/api/admin/kintone/apps', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ 
                    result: 'success',
                    apps: [
                        { appId: '1', name: 'テストアプリ1', description: '', spaceId: null, createdAt: '' },
                        { appId: '2', name: 'テストアプリ2', description: '', spaceId: null, createdAt: '' }
                    ] 
                })
            });
        });
        await page.fill('input[placeholder="your-company"]', 'test');
        await page.fill('input[placeholder="admin@example.com"]', 'test');
        await page.fill('input[placeholder="パスワード"]', 'test');
        await page.click('button:has-text("アプリ一覧を取得")');
        
        await expect(page.locator('.app-name').filter({ hasText: 'テストアプリ1' })).toBeVisible({ timeout: 15000 });
        await expect(page.locator('.app-meta').filter({ hasText: 'アプリID: 1' })).toBeVisible();

        // 全選択テスト (button.btn-primary は複数あるため getByRole で絞る)
        await page.click('button:has-text("全選択")');
        await expect(page.locator('.selected-count')).toContainText('2件選択中');
        const migrateBtn = page.getByRole('button', { name: /件のアプリを移行する/ });
        await expect(migrateBtn).toContainText('2件のアプリを移行する');

        // 全解除テスト
        await page.click('button:has-text("全解除")');
        await expect(page.locator('.selected-count')).not.toBeVisible();
        await expect(migrateBtn).toBeDisabled();

        // 個別選択
        await page.click('text=テストアプリ1');
        await expect(page.locator('.selected-count')).toContainText('1件選択中');

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
