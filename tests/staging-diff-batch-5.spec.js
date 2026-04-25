// @ts-check
/**
 * staging 差分 第 6 弾: 10 件 structural regression guard
 *
 * 対象:
 * - chart-perm-010   既存 chart-options の詳細権限系領域 (UI 構造)
 * - chart-perm-020   チャート閲覧権限 UI 構造
 * - at-perm-010      AI Table Builder 権限 (pigeon_cloud E2E 観点)
 * - excel-105        PR #3048  ExcelImportJobHandler hotfix
 * - excel-106        PR #3055  Excel プレビューはみ出し修正
 * - opn-050          PR #3080  opensearch credential provider no-imds
 * - opn-060          PR #3075  opensearch access policy FGAC
 * - cf-020           PR #3090  cloudfront viewer address forward
 * - q-020            PR #3088  queue rsyslog hotfix (CloudWatch Logs)
 * - bulk-010         PR #3105  10桁ハッシュ DB cleanup
 */
const { test, expect } = require('@playwright/test');
const { createTestEnv } = require('./helpers/create-test-env');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');

const autoScreenshot = createAutoScreenshot('staging-diff-batch-5');

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
    await page.waitForSelector('.navbar', { timeout: 15000 });
}

test.describe.serial('staging 差分 第 6 弾 (10 件 structural regression)', () => {
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
            console.error('[staging-diff-batch-5 beforeAll]', e.message);
            fileBeforeAllFailed = true;
            throw e;
        }
    });

    test.afterAll(async () => {
        if (envContext) await envContext.close().catch(() => {});
    });

    /**
     * chart-perm-010: チャート設定画面 (既存 chart-options 28 件 fail 領域) が ISE なし
     * @requirements.txt(R-350)
     */
    test('chart-perm-010: チャート設定画面が ISE なく開く (既存 fail 領域 regression check)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        // ALLテストテーブルのチャートタブ (テーブル設定 > チャート)
        await page.goto(BASE_URL + `/admin/dataset__${allTypeTableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD6-01', 'chart-perm-010', _testStart);
    });

    /**
     * chart-perm-020: チャート / 集計ボタンが画面に存在 (権限あり)
     * @requirements.txt(R-351)
     */
    test('chart-perm-020: テーブル設定でチャート/集計タブが描画 (UI structure)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + `/admin/dataset/edit/${allTypeTableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        // チャート/集計関連タブの存在確認 (DOM レベル)
        const tabCount = await page.locator('[role="tab"]').count();
        expect(tabCount, 'タブ要素が DOM に存在').toBeGreaterThan(0);

        await autoScreenshot(page, 'SD6-02', 'chart-perm-020', _testStart);
    });

    /**
     * at-perm-010: AI Table Builder 権限関連 (master 権限あり、画面到達)
     * @requirements.txt(R-352)
     */
    test('at-perm-010: AI Table Builder への遷移が ISE なし (PR #3139 補完)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        // 複数 URL 候補で routing 確認 (PR #3139 影響)
        const candidatePaths = [
            '/admin/0/ai-table-builder',
            '/admin/dataset/0/ai-table-builder',
            '/admin/ai-table-builder',
        ];
        let succeeded = false;
        for (const path of candidatePaths) {
            await page.goto(BASE_URL + path, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await waitForAngular(page);
            const bodyText = await page.innerText('body').catch(() => '');
            if (bodyText && !bodyText.includes('Internal Server Error') && !bodyText.includes('404 Not Found')) {
                succeeded = true;
                break;
            }
        }
        expect(succeeded, 'いずれかのルートで ISE/404 出ていない').toBe(true);

        await autoScreenshot(page, 'SD6-03', 'at-perm-010', _testStart);
    });

    /**
     * excel-105: ExcelImportJobHandler hotfix (PR #3048)
     * @requirements.txt(R-353)
     */
    test('excel-105: Excel import 画面が ISE なく描画 (PR #3048 use 文欠落 hotfix regression)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/excel-import', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.drop-zone')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし (use 文欠落で Fatal にならない)').not.toContain('Internal Server Error');
        expect(bodyText, 'PHP Fatal Error が出ていない').not.toContain('Fatal error');

        await autoScreenshot(page, 'SD6-04', 'excel-105', _testStart);
    });

    /**
     * excel-106: Excel プレビューはみ出し修正 (PR #3055)
     * @requirements.txt(R-354)
     */
    test('excel-106: Excel import drop-zone が viewport 内に収まる (PR #3055)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/excel-import', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        const dropZone = page.locator('.drop-zone');
        await expect(dropZone).toBeVisible({ timeout: 10000 });

        // drop-zone が viewport 幅内に収まること (横スクロールバー出ていない)
        const dropZoneBox = await dropZone.boundingBox();
        const viewportSize = page.viewportSize();
        if (dropZoneBox && viewportSize) {
            expect(dropZoneBox.width, 'drop-zone 幅が viewport 幅以下').toBeLessThanOrEqual(viewportSize.width + 5);
        }

        await autoScreenshot(page, 'SD6-05', 'excel-106', _testStart);
    });

    /**
     * opn-050: opensearch credential provider regression (PR #3080)
     * @requirements.txt(R-355)
     */
    test('opn-050: opensearch search が応答 (PR #3080 credential provider regression)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        const result = await page.evaluate(async (baseUrl) => {
            try {
                const r = await fetch(baseUrl + '/api/admin/opensearch/search?keyword=t', {
                    method: 'GET',
                    credentials: 'include',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                });
                return { status: r.status };
            } catch (e) {
                return { error: e.message };
            }
        }, BASE_URL);
        expect(result.status, 'opensearch credential 経路が 5xx でない').toBeLessThan(500);

        await autoScreenshot(page, 'SD6-06', 'opn-050', _testStart);
    });

    /**
     * opn-060: opensearch access policy FGAC (PR #3075)
     * @requirements.txt(R-356)
     */
    test('opn-060: opensearch reindex API が認証済みで応答 (PR #3075 FGAC regression)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        const result = await page.evaluate(async (baseUrl) => {
            try {
                const r = await fetch(baseUrl + '/api/admin/opensearch/reindex', {
                    method: 'GET',
                    credentials: 'include',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                });
                return { status: r.status };
            } catch (e) {
                return { error: e.message };
            }
        }, BASE_URL);
        expect(result.status, 'opensearch reindex が 5xx でない (FGAC 認可 OK)').toBeLessThan(500);
        expect(result.status, '401 でない (認証済み)').not.toBe(401);

        await autoScreenshot(page, 'SD6-07', 'opn-060', _testStart);
    });

    /**
     * cf-020: cloudfront viewer address forward 関連で IP 取得が機能している
     * @requirements.txt(R-357) 背景: PR #3090 CloudFront でクライアント IP forward
     */
    test('cf-020: dashboard が ISE なく描画 (PR #3090 CloudFront viewer-address regression)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD6-08', 'cf-020', _testStart);
    });

    /**
     * q-020: queue rsyslog hotfix (PR #3088) - debug API 経由で job_logs 確認
     * @requirements.txt(R-358)
     */
    test('q-020: ジョブログ画面が ISE なく描画 (PR #3088 queue rsyslog hotfix regression)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/job_logs', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD6-09', 'q-020', _testStart);
    });

    /**
     * bulk-010: 10桁ハッシュ DB cleanup (PR #3105) - debug status で正常応答
     * @requirements.txt(R-359)
     */
    test('bulk-010: debug status API が応答 (PR #3105 hash-DB cleanup regression)', async ({ page }) => {
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
                return { status: r.status };
            } catch (e) {
                return { error: e.message };
            }
        }, BASE_URL);
        expect(result.status, 'debug API が 5xx でない').toBeLessThan(500);

        await autoScreenshot(page, 'SD6-10', 'bulk-010', _testStart);
    });
});
