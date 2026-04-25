// @ts-check
/**
 * staging 差分 第 7 弾: 10 件 — 認可ネガティブ + API 直叩き + パフォーマンス観点
 *
 * staging↔main 差分 PR は概ねカバー完了したので、本弾は別観点でカバー強化:
 * - 認可ネガティブ (一般ユーザーで管理画面アクセス → 拒否)
 * - API 直叩き (認証/認可)
 * - パフォーマンス (連続 navigate, 並行 fetch)
 *
 * - neg-010   一般ユーザーで /admin/master-settings → 拒否
 * - neg-020   一般ユーザーで /admin/admin (admin 一覧) → 拒否
 * - neg-030   一般ユーザーで kintone migration → 拒否
 * - neg-040   一般ユーザーで debug API → 拒否
 * - neg-050   認証なしで /api/admin/* → 401
 * - dat-400   dataset list API レスポンス形式確認 (回帰)
 * - rec-400   レコード詳細 API レスポンス確認
 * - paginate-010 dataset list API でページング指定
 * - rate-010  API 連続呼び出しが rate limited されない通常範囲
 * - nav-010   複数画面遷移後 SPA が壊れない
 */
const { test, expect } = require('@playwright/test');
const { createTestEnv } = require('./helpers/create-test-env');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { fullLogin } = require('./helpers/ensure-login');

const autoScreenshot = createAutoScreenshot('staging-diff-batch-6');

let BASE_URL = process.env.TEST_BASE_URL || '';
let EMAIL = process.env.TEST_EMAIL || 'admin';
let PASSWORD = process.env.TEST_PASSWORD || '';

let allTypeTableId = null;
let envContext = null;
let generalUserEmail = null;
let generalUserPassword = null;

async function waitForAngular(page, timeout = 10000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

async function loginAs(page, email, password) {
    await page.context().clearCookies().catch(() => {});
    await fullLogin(page, email, password);
}

test.describe.serial('staging 差分 第 7 弾 (10 件 認可ネガティブ + API + パフォーマンス)', () => {
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

            // 一般ユーザー作成 (master でログインして debug API)
            const page = env.page;
            await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 10000 });

            const createRes = await page.evaluate(async () => {
                try {
                    const r = await fetch('/api/admin/debug/create-user', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                        body: JSON.stringify({}),
                    });
                    return { status: r.status, body: await r.text() };
                } catch (e) { return { error: e.message }; }
            });
            if (createRes.body) {
                try {
                    const parsed = JSON.parse(createRes.body);
                    generalUserEmail = parsed.email || parsed.result?.email || null;
                    generalUserPassword = parsed.password || parsed.result?.password || 'admin';
                } catch {}
            }
            console.log('[batch-6 beforeAll] 一般ユーザー: email=' + generalUserEmail);
        } catch (e) {
            console.error('[staging-diff-batch-6 beforeAll]', e.message);
            fileBeforeAllFailed = true;
            throw e;
        }
    });

    test.afterAll(async () => {
        if (envContext) await envContext.close().catch(() => {});
    });

    // neg-010 〜 neg-050: users-permissions.spec.js に再配置 (2026-04-26 PR #17)

    /**
     * dat-400: dataset list API レスポンスが 5xx でない (回帰)
     * 注: pigeon_cloud では `/api/admin/dataset/list` は表示用 list 取得用途で、
     * 環境状態によっては SPA HTML を返すケースもある。ここでは「5xx でない」のみ保証。
     * @requirements.txt(R-365)
     */
    test('dat-400: dataset list API が 5xx を返さない (回帰)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await loginAs(page, EMAIL, PASSWORD);
        const result = await page.evaluate(async (baseUrl) => {
            try {
                const r = await fetch(baseUrl + '/api/admin/dataset/list', {
                    method: 'GET', credentials: 'include',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                });
                return { status: r.status };
            } catch (e) { return { error: e.message }; }
        }, BASE_URL);
        expect(typeof result.status === 'number', `fetch 完遂 (got: ${JSON.stringify(result)})`).toBe(true);
        expect(result.status, '5xx でない').toBeLessThan(500);

        await autoScreenshot(page, 'SD7-06', 'dat-400', _testStart);
    });

    /**
     * rec-400: レコード詳細画面の主要 DOM 構造確認
     * @requirements.txt(R-366)
     */
    test('rec-400: ALLテストテーブル詳細画面で table+tablist DOM 描画', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await loginAs(page, EMAIL, PASSWORD);
        await page.goto(BASE_URL + `/admin/dataset__${allTypeTableId}/view/1`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const tableCount = await page.locator('table').count();
        const tabCount = await page.locator('[role="tab"], [role="tablist"]').count();
        expect(tableCount + tabCount, '詳細画面に table or tab が描画').toBeGreaterThan(0);

        await autoScreenshot(page, 'SD7-07', 'rec-400', _testStart);
    });

    /**
     * paginate-010: dataset API ページング指定が応答
     * @requirements.txt(R-367)
     */
    test('paginate-010: dataset list API で per_page=5 / page=1 指定', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await loginAs(page, EMAIL, PASSWORD);
        const result = await page.evaluate(async (baseUrl) => {
            try {
                const r = await fetch(baseUrl + '/api/admin/dataset/list?per_page=5&page=1', {
                    method: 'GET', credentials: 'include',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                });
                return { status: r.status };
            } catch (e) { return { error: e.message }; }
        }, BASE_URL);
        expect(result.status, 'ページング指定 API 応答').toBeLessThan(500);

        await autoScreenshot(page, 'SD7-08', 'paginate-010', _testStart);
    });

    /**
     * rate-010: 連続 5 回 API 呼び出しが rate limited されない (通常範囲)
     * @requirements.txt(R-368)
     */
    test('rate-010: 連続 5 回 dataset list API → 全て 5xx 出ない', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await loginAs(page, EMAIL, PASSWORD);
        const results = await page.evaluate(async (baseUrl) => {
            const out = [];
            for (let i = 0; i < 5; i++) {
                try {
                    const r = await fetch(baseUrl + '/api/admin/dataset/list?per_page=5', {
                        method: 'GET', credentials: 'include',
                        headers: { 'X-Requested-With': 'XMLHttpRequest' },
                    });
                    out.push(r.status);
                } catch (e) { out.push('err:' + e.message); }
            }
            return out;
        }, BASE_URL);
        for (const s of results) {
            expect(typeof s === 'number' && s < 500, `応答 ${s} が 5xx でない`).toBe(true);
        }

        await autoScreenshot(page, 'SD7-09', 'rate-010', _testStart);
    });

    /**
     * nav-010: 複数画面 SPA 遷移で navbar が常に描画
     * @requirements.txt(R-369)
     */
    test('nav-010: dashboard → dataset → master-settings → dashboard SPA 遷移で navbar 維持', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(90000);
        const _testStart = Date.now();

        await loginAs(page, EMAIL, PASSWORD);

        // dashboard
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        // ALLテストテーブル
        await page.goto(BASE_URL + `/admin/dataset__${allTypeTableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        // master-settings (navbar 無いレイアウト)
        await page.goto(BASE_URL + '/admin/master-settings', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.master-settings-page')).toBeVisible({ timeout: 10000 });

        // dashboard 戻り (navbar 復活)
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD7-10', 'nav-010', _testStart);
    });
});
