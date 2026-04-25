// @ts-check
/**
 * staging 差分 第 3 弾: 10 件 structural regression guard
 *
 * staging↔main 差分から、PR #5/#6 でカバーされていない PR を 10 件抽出。
 *
 * 対象 PR:
 * - cf-010   PR #2916  子テーブルファイル HY093 エラー (backend regression check)
 * - dv-010   PR #3076  dataset createview join reset
 * - wf-070   PR #2894  workflow AND/OR 組織バリデーション
 * - oer-010  PR #2815  on-edit memory race condition
 * - mob-010  PR #2906  hamburger search overlap on mobile (viewport)
 * - ten-010  PR #3132  tenant session isolation auth-260 拡張
 * - dbg-010  PR #2931  debug-status sort column
 * - cam-010  PR #2877  camera no device check
 * - msp-010  PR #3107  master-settings permission checks
 * - sb-010   PR #2864  staging-ui-sidebar-header-fix
 */
const { test, expect } = require('@playwright/test');
const { createTestEnv } = require('./helpers/create-test-env');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { fullLogin } = require('./helpers/ensure-login');

const autoScreenshot = createAutoScreenshot('staging-diff-batch-2');

let BASE_URL = process.env.TEST_BASE_URL || '';
let EMAIL = process.env.TEST_EMAIL || 'admin';
let PASSWORD = process.env.TEST_PASSWORD || '';

let allTypeTableId = null;
let envContext = null;

async function waitForAngular(page, timeout = 10000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

async function login(page) {
    await page.context().clearCookies().catch(() => {});
    await fullLogin(page, EMAIL, PASSWORD);
}

test.describe.serial('staging 差分 第 3 弾 (10 件 structural regression)', () => {
    let fileBeforeAllFailed = false;

    test.beforeAll(async ({ browser }) => {
        try {
            const env = await createTestEnv(browser, { withAllTypeTable: true });
            BASE_URL = env.baseUrl;
            EMAIL = env.email;
            PASSWORD = env.password;
            allTypeTableId = env.tableId;
            envContext = env.context;
            process.env.TEST_BASE_URL = env.baseUrl;
            process.env.TEST_EMAIL = env.email;
            process.env.TEST_PASSWORD = env.password;
        } catch (e) {
            console.error('[staging-diff-batch-2 beforeAll]', e.message);
            fileBeforeAllFailed = true;
            throw e;
        }
    });

    test.afterAll(async () => {
        if (envContext) await envContext.close().catch(() => {});
    });

    // cf-010: records.spec.js に再配置 (2026-04-26 PR #21)
    // dv-010: table-definition.spec.js に再配置 (2026-04-26 PR #20)
    // wf-070: workflow.spec.js に再配置 (2026-04-26 PR #20)
    // oer-010: records.spec.js に再配置 (2026-04-26 PR #21)

    /**
     * mob-010: モバイル viewport でハンバーガーメニュー + 検索が overlap しない
     * @requirements.txt(R-324)
     * 背景: PR #2906 mobile staging でハンバーガー検索 overlap 問題修正。
     */
    test('mob-010: モバイル viewport でハンバーガー + 検索 UI 描画 (PR #2906)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await page.setViewportSize({ width: 375, height: 667 });  // iPhone 8 サイズ
        await login(page);

        // モバイル幅でダッシュボード描画
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        // navbar が存在 (モバイル view でも描画される)
        const navbarCount = await page.locator('.navbar').count();
        expect(navbarCount, 'navbar が DOM に存在').toBeGreaterThan(0);

        await autoScreenshot(page, 'SD3-05', 'mob-010', _testStart);
    });

    // ten-010: auth.spec.js に再配置 (2026-04-26 PR #15)

    /**
     * dbg-010: debug-status エンドポイントが応答する (sort column 修正)
     * @requirements.txt(R-326)
     * 背景: PR #2931 debug-status sort column の修正。
     */
    test('dbg-010: debug-status API が認証済みで応答 (PR #2931)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        const result = await page.evaluate(async (baseUrl) => {
            try {
                const r = await fetch(baseUrl + '/api/admin/debug/status', {
                    method: 'GET',
                    credentials: 'include',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                });
                return { status: r.status, ok: r.ok };
            } catch (e) {
                return { error: e.message };
            }
        }, BASE_URL);
        expect(result.status, 'debug-status API が 5xx でない').toBeLessThan(500);
        expect(result.status, 'debug-status API が 401 でない (認証済み)').not.toBe(401);

        await autoScreenshot(page, 'SD3-07', 'dbg-010', _testStart);
    });

    // cam-010: records.spec.js に再配置 (2026-04-26 PR #21)

    /**
     * msp-010: master-settings.spec.js に再配置 (2026-04-26 PR #18)
     */

    /**
     * sb-010: サイドバーヘッダーが描画される (PR #2864 staging-ui-sidebar-header-fix)
     * @requirements.txt(R-329)
     * 背景: PR #2864 サイドバーヘッダー UI 修正。
     */
    test('sb-010: ダッシュボードでサイドバー + ヘッダーが描画 (PR #2864)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        // サイドバー描画 (sidebar / navigation 系の要素)
        const sidebarCount = await page.locator('aside, .sidebar, nav, .navigation').count();
        expect(sidebarCount, 'サイドバー/ナビゲーション要素が DOM に存在').toBeGreaterThan(0);

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD3-10', 'sb-010', _testStart);
    });
});
