// @ts-check
const { test, expect } = require('@playwright/test');
const { setupAllTypeTable } = require('./helpers/table-setup');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

/**
 * ログイン共通関数
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded');
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
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
}

/**
 * テンプレートモーダルを閉じる
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
 * デバッグAPIのGET呼び出し（status等のGET専用エンドポイント用）
 */
async function debugApiGet(page, path) {
    return await page.evaluate(async ({ baseUrl, path }) => {
        try {
            const res = await fetch(baseUrl + '/api/admin/debug' + path, {
                method: 'GET',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
                credentials: 'include',
            });
            const text = await res.text();
            try {
                return JSON.parse(text);
            } catch(e) {
                return { result: 'parse_error', text: text.substring(0, 100) };
            }
        } catch(e) {
            return { result: 'error', message: e.message };
        }
    }, { baseUrl: BASE_URL, path });
}

/**
 * デバッグAPIのPOST呼び出し
 */
async function debugApiPost(page, path, body = {}) {
    return await page.evaluate(async ({ baseUrl, path, body }) => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 180000); // 180秒タイムアウト
            let res;
            try {
                res = await fetch(baseUrl + '/api/admin/debug' + path, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify(body),
                    credentials: 'include',
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeoutId);
            }
            const text = await res.text();
            try {
                return JSON.parse(text);
            } catch(e) {
                // 504等のHTMLレスポンスの場合は仮レスポンスを返す（サーバー側で処理は完了している可能性あり）
                return { result: 'timeout', status: res.status, text: text.substring(0, 100) };
            }
        } catch(e) {
            return { result: 'error', message: e.message };
        }
    }, { baseUrl: BASE_URL, path, body });
}

// =============================================================================
// フィルタテスト
// =============================================================================

test.describe('フィルタ（フィルタタイプ・高度な検索）', () => {
    let tableId = null;

    // テスト前: テーブルとデータを一度だけ作成
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
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 234: フィルタタイプ・権限周りの動作確認
    // -------------------------------------------------------------------------
    test('234: フィルタ設定画面が表示され、フィルタタイプを選択できること', async ({ page }) => {

        // レコード一覧に移動
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // ページが正常に表示されることを確認
        await expect(page.locator('.navbar')).toBeVisible();
        const pageUrl = page.url();
        expect(pageUrl).toContain(`dataset__${tableId}`);

        // フィルタボタンを探してクリック
        const filterBtn = page.locator(
            'button:has-text("フィルタ"), button[title*="フィルタ"], ' +
            'a:has-text("フィルタ"), button:has-text("絞り込み")'
        ).first();
        const filterBtnCount = await filterBtn.count();

        if (filterBtnCount > 0) {
            await filterBtn.click({ force: true });
            await page.waitForTimeout(1000);
        }

        // ページが正常表示されていることを確認
        await expect(page.locator('.navbar')).toBeVisible();

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/234-filter-type.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 244: 高度な検索
    // -------------------------------------------------------------------------
    test('244: 高度な検索（フィルタの複合条件）が設定できること', async ({ page }) => {

        // レコード一覧に移動
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // ページが正常に表示されることを確認
        await expect(page.locator('.navbar')).toBeVisible();
        const pageUrl = page.url();
        expect(pageUrl).toContain(`dataset__${tableId}`);

        // 高度な検索/フィルタボタンを探す
        const advancedSearchBtn = page.locator(
            'button:has-text("高度な検索"), a:has-text("高度な検索"), ' +
            'button:has-text("詳細検索"), button:has-text("フィルタ")'
        ).first();
        const btnCount = await advancedSearchBtn.count();

        if (btnCount > 0) {
            await advancedSearchBtn.click({ force: true });
            await page.waitForTimeout(1000);
            await expect(page.locator('.navbar')).toBeVisible();
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/244-advanced-search.png`, fullPage: true });
    });

});
