// @ts-check
const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { createTestEnv } = require('./helpers/create-test-env');

let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;
let tableId = null;

const autoScreenshot = createAutoScreenshot('bug-b001');

/**
 * Angular描画待ち
 */
async function waitForAngular(page, timeout = 10000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

/**
 * ログイン後のテンプレートモーダルを閉じる
 */
async function closeModal(page) {
    const modal = page.locator('div.modal.show');
    if (await modal.count() > 0) {
        // ×ボタンまたは閉じるボタンを探す
        const closeBtn = modal.locator('button.close, button:has-text("閉じる"), button:has-text("キャンセル")').first();
        if (await closeBtn.count() > 0) {
            await closeBtn.click({ force: true }).catch(() => {});
        } else {
            await page.keyboard.press('Escape');
        }
        await page.waitForTimeout(500);
    }
}

test.describe('Slack報告バグ B001: Excelインポートのプレビューテーブルはみ出し', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        // 新規環境作成（ALLテストテーブル付き）
        const env = await createTestEnv(browser, { withAllTypeTable: true });
        BASE_URL = env.baseUrl;
        EMAIL = env.email;
        PASSWORD = env.password;
        tableId = env.tableId;
        process.env.TEST_BASE_URL = env.baseUrl;
        process.env.TEST_EMAIL = env.email;
        process.env.TEST_PASSWORD = env.password;
    });

    test.beforeEach(async ({ page }) => {
        // ログイン
        await page.goto(BASE_URL + '/admin/login');
        await page.fill('#id', EMAIL);
        await page.fill('#password', PASSWORD);
        await page.click('button[type=submit]');
        await page.waitForSelector('.navbar');
        await waitForAngular(page);
        await closeModal(page);
    });

    test('B001: 多項目のExcel(CSV)をインポートした際、プレビューテーブルが適切に表示（スクロール）されること', async ({ page }) => {
        const _testStart = Date.now();
        test.setTimeout(120000);

        // [flow] 1. テーブル管理画面（/admin/dataset）へ遷移
        await page.goto(BASE_URL + '/admin/dataset');
        await waitForAngular(page);

        // [flow] 2. ハンバーガーメニューから「エクセルから追加」を選択
        const hamburgerBtn = page.locator('button.dropdown-toggle:has(.fa-bars)').first();
        await hamburgerBtn.click();
        const excelBtn = page.locator('a.dropdown-item').filter({ hasText: /エクセルから追加|Excelから追加|Excel/ }).first();
        await expect(excelBtn).toBeVisible();
        await excelBtn.click();
        await waitForAngular(page);

        // [flow] 3. 多項目のCSVファイルを準備してアップロード
        // (test_files/b001_many_columns.csv は事前に作成済み)
        const fileInput = page.locator('input[type="file"]');
        await fileInput.setInputFiles('test_files/b001_many_columns.csv');
        // Angularに通知するためにchangeイベントを発火
        await fileInput.dispatchEvent('change');
        await waitForAngular(page);

        // [check] 4. ✅ データプレビューが表示されること
        // プレビュー内のテーブルを探す。ヘッダーに "col1" が含まれているはず
        const previewTable = page.locator('table').filter({ has: page.locator('th').filter({ hasText: 'col1' }) }).first();
        await expect(previewTable).toBeVisible({ timeout: 20000 });
        console.log('[B001] プレビューテーブル表示確認OK');

        // [check] 5. ✅ プレビューテーブルが親要素（モーダル幅）を突き抜けていないこと、または水平スクロールが有効であること
        const modalBody = page.locator('.modal-body').first();
        await expect(modalBody).toBeVisible();

        const modalBox = await modalBody.boundingBox();
        const tableBox = await previewTable.boundingBox();

        if (!modalBox || !tableBox) {
            throw new Error('Bounding box could not be determined');
        }

        console.log(`[B001] Modal Width: ${modalBox.width}, Table Width: ${tableBox.width}`);

        // テーブルの親コンテナ（スクロール用のはず）のCSSを確認
        const container = previewTable.locator('xpath=..');
        const overflowX = await container.evaluate(el => window.getComputedStyle(el).overflowX);
        const display = await container.evaluate(el => window.getComputedStyle(el).display);

        console.log(`[B001] Container Overflow-X: ${overflowX}, Display: ${display}`);

        // assertion を緩めない: 具体的な検証
        // バグ B001 の「実際: はみ出し」とは、テーブルがモーダル幅を超えているのにスクロールできない状態を指す。
        
        const isScrollable = overflowX === 'auto' || overflowX === 'scroll';
        
        if (!isScrollable) {
            // スクロール不可の場合、テーブル幅はモーダル幅に収まっている必要がある
            // 多少のパディング（15px程度）を考慮
            expect(tableBox.width, 'スクロールが無効な場合、テーブル幅はモーダル幅内に収まっている必要があります').toBeLessThanOrEqual(modalBox.width + 1);
        } else {
            // スクロール可能な場合、親コンテナの幅がモーダル幅内に収まっていることを確認
            const containerBox = await container.boundingBox();
            if (containerBox) {
                expect(containerBox.width, 'スクロールコンテナの幅はモーダル幅内に収まっている必要があります').toBeLessThanOrEqual(modalBox.width + 1);
            }
        }

        // 追加の検証: 50列目が存在し、スクロールなしでは見えない（またはスクロールで見えるようになる）ことを確認
        const col50 = previewTable.locator('th').filter({ hasText: 'col50' });
        await expect(col50).toBeAttached();

        await autoScreenshot(page, 'B001', 'preview-scrolling', _testStart);
    });
});
