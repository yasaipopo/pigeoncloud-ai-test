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
     * pf-020: public-form.spec.js に再配置 (2026-04-26 PR #18)
     */

    // opn-020 / opn-040: global-search.spec.js に再配置 (2026-04-26 PR #19)

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

    // prv-010: excel-import.spec.js に再配置 (2026-04-26 PR #19)

    // ms-050: master-settings.spec.js に再配置 (2026-04-26 PR #18)
});
