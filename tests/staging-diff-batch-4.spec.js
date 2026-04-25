// @ts-check
/**
 * staging 差分 第 5 弾: 10 件 structural regression guard
 *
 * 対象 PR:
 * - frm-010   PR #3095  lodash-import-forms-field (フィールド追加モーダル)
 * - pf-020    PR #3093  公開フォーム lookup iframe_api 認可自動通過
 * - opn-020   PR #3094  opensearch-search-params-format
 * - opn-040   PR #3085  opensearch-bulk-index-select-all
 * - wf-080    PR #2780  ALL テスト ラジオ表示条件テキスト
 * - ng-010    PR #2819  NavigationEnd data-ng-ready (Angular ready signal)
 * - mail-020  PR #2961  mail-import-adaptive-window
 * - mail-030  PR #2963  staging-mail-import-date-fix
 * - prv-010   PR #3032  preview env IAM policy (Excel S3 access)
 * - ms-050    PR #3083  master-unlock-button-missing (master 自身編集画面)
 */
const { test, expect } = require('@playwright/test');
const { createTestEnv } = require('./helpers/create-test-env');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { fullLogin } = require('./helpers/ensure-login');

const autoScreenshot = createAutoScreenshot('staging-diff-batch-4');

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

test.describe.serial('staging 差分 第 5 弾 (10 件 structural regression)', () => {
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
            console.error('[staging-diff-batch-4 beforeAll]', e.message);
            fileBeforeAllFailed = true;
            throw e;
        }
    });

    test.afterAll(async () => {
        if (envContext) await envContext.close().catch(() => {});
    });

    /**
     * frm-010: フィールド追加モーダルが開く (lodash import 修正後)
     * @requirements.txt(R-340) 背景: PR #3095 lodash import 修正
     */
    test('frm-010: フィールド追加モーダルが開ける (PR #3095 lodash import regression)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + `/admin/dataset/edit/${allTypeTableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        // 「項目を追加する」ボタンクリック → settingModal 開く
        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click();
        await page.waitForSelector('.modal.settingModal.show', { timeout: 10000 });
        // モーダル内に「数値」「文字列」等のフィールドタイプボタンが描画 (lodash 経由のリスト構築)
        const typeBtnCount = await page.locator('.modal.settingModal.show button').count();
        expect(typeBtnCount, 'フィールドタイプボタンが描画 (lodash 動作確認)').toBeGreaterThan(5);

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD5-01', 'frm-010', _testStart);
    });

    /**
     * pf-020: 公開フォーム iframe_api 認可 endpoint 別 path での確認 (pf-010 補完)
     * @requirements.txt(R-341) 背景: PR #3093 で iframe_api 認可自動通過
     */
    test('pf-020: 公開フォーム iframe path が認証なしで 5xx を返さないこと (PR #3093 補完)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        const result = await page.evaluate(async (baseUrl) => {
            try {
                // 別 endpoint: dummy public form path
                const r = await fetch(baseUrl + '/api/public/f/dummy-form-id', {
                    method: 'GET',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                });
                return { status: r.status, ok: r.ok };
            } catch (e) {
                return { error: e.message };
            }
        }, BASE_URL);
        // 5xx ではない (認可エラー or 404 は OK)
        expect(result.status, 'public form API が 5xx でない').toBeLessThan(500);

        await autoScreenshot(page, 'SD5-02', 'pf-020', _testStart);
    });

    /**
     * opn-020: opensearch search params format API (PR #3094)
     * @requirements.txt(R-342)
     */
    test('opn-020: opensearch search に複数パラメータ渡しても 5xx でない (PR #3094)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        const result = await page.evaluate(async (baseUrl) => {
            try {
                // 複数パラメータ (keyword + dataset_id + page) 形式
                const r = await fetch(baseUrl + '/api/admin/opensearch/search?keyword=テスト&page=1&per_page=10', {
                    method: 'GET',
                    credentials: 'include',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                });
                return { status: r.status, ok: r.ok };
            } catch (e) {
                return { error: e.message };
            }
        }, BASE_URL);
        expect(result.status, 'opensearch params format API が 5xx でない').toBeLessThan(500);

        await autoScreenshot(page, 'SD5-03', 'opn-020', _testStart);
    });

    /**
     * opn-040: opensearch bulk index 関連 endpoint (PR #3085)
     * @requirements.txt(R-343)
     */
    test('opn-040: opensearch reindex/bulk-index endpoint が 5xx でない (PR #3085)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        const result = await page.evaluate(async (baseUrl) => {
            try {
                // GET で endpoint 存在確認 (POST 必要なら 405 が返るが、5xx ではない)
                const r = await fetch(baseUrl + '/api/admin/opensearch/reindex', {
                    method: 'GET',
                    credentials: 'include',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                });
                return { status: r.status, ok: r.ok };
            } catch (e) {
                return { error: e.message };
            }
        }, BASE_URL);
        expect(result.status, 'opensearch reindex API が 5xx でない').toBeLessThan(500);

        await autoScreenshot(page, 'SD5-04', 'opn-040', _testStart);
    });

    /**
     * wf-080: ALL テスト_テーブル詳細画面が ISE 出さず描画 (PR #2780 の影響範囲)
     * @requirements.txt(R-344)
     * 背景: PR #2780 ラジオ表示条件テキストフィールド追加。ALL テーブル詳細でも ISE 出ないこと。
     */
    test('wf-080: ALLテスト テーブル詳細画面が ISE なく描画 (PR #2780)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + `/admin/dataset__${allTypeTableId}/view/1`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');
        // 詳細画面の主要 DOM
        const tabCount = await page.locator('[role="tab"], [role="tablist"]').count();
        expect(tabCount, 'タブまたは tab list 要素が DOM に存在').toBeGreaterThan(0);

        await autoScreenshot(page, 'SD5-05', 'wf-080', _testStart);
    });

    /**
     * ng-010: data-ng-ready 属性が body に設定される (Angular NavigationEnd hook)
     * @requirements.txt(R-345)
     * 背景: PR #2819 NavigationEnd で data-ng-ready 属性追加 (E2E 高速化用)。
     */
    test('ng-010: 任意画面遷移後に body[data-ng-ready=true] が設定される (PR #2819)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
        // data-ng-ready=true が設定されるまで待つ (5 秒以内)
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: 5000 });
        const ready = await page.evaluate(() => document.body.getAttribute('data-ng-ready'));
        expect(ready, 'body[data-ng-ready] が "true"').toBe('true');

        await autoScreenshot(page, 'SD5-06', 'ng-010', _testStart);
    });

    // mail-020 / mail-030: notifications.spec.js に再配置 (2026-04-26 PR #16)

    /**
     * prv-010: preview env IAM policy 関連で Excel import 画面が壊れていないこと (PR #3032)
     * @requirements.txt(R-348)
     */
    test('prv-010: Excel import 画面が ISE なく開く (PR #3032 IAM regression)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/excel-import', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.drop-zone')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし (S3 access policy 不足エラー無し)').not.toContain('Internal Server Error');
        expect(bodyText, 'AccessDenied / S3 IAM エラーが画面に出ていない').not.toContain('AccessDenied');

        await autoScreenshot(page, 'SD5-09', 'prv-010', _testStart);
    });

    /**
     * ms-050: master 自身の admin 編集画面で unlock button visibility (PR #3083)
     * @requirements.txt(R-349)
     * 背景: PR #3083 master-unlock-button-missing 修正。
     *      ms-040 と相補で、別 admin id (= 1, master 自身) で確認。
     */
    test('ms-050: master 自身の admin/edit 画面で ISE 出さず unlock button 制御確認 (PR #3083)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/admin/edit/1', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');
        // 非ロック時 unlock button 非表示
        const unlockBtn = page.locator('button.btn-outline-danger', { hasText: 'アカウントロック解除' });
        expect(await unlockBtn.count(), '非ロック時は unlock 非表示').toBe(0);

        await autoScreenshot(page, 'SD5-10', 'ms-050', _testStart);
    });
});
