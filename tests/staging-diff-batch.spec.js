// @ts-check
/**
 * staging 差分 第 2 弾: 10 件 structural regression guard
 *
 * staging↔main 差分から、wf-040/050 / kintone / data-ops 以外で重要な PR を
 * カバーする structural test 群。
 *
 * 対象 PR:
 * - rr-010   PR #3074  関連レコード一覧 + ボタン relation_add class 復元
 * - ccl-010  PR #2754  カレンダー表示ソート
 * - ms-040   PR #3144  master-settings ロック解除ボタン visibility
 * - at-010   PR #3139  AI Table Builder URL 直打ち権限ガード
 * - pf-010   PR #3079  公開フォーム他テーブル参照ルックアップ API
 * - kt-100   PR #3152  kintone migration result route bug-b012
 * - ip-080   PR #3149  IP allow-validation up-ip-6 (重複登録時のエラー)
 * - mail-010 PR #3148  メール取り込み日付 JST 保存 (UI 側影響)
 * - exc-080  PR #3035  Excel import バリデーションエラー (テーブル名重複等)
 * - srh-100  PR #3110  OpenSearch ngram (debug 経由 API)
 */
const { test, expect } = require('@playwright/test');
const { createTestEnv } = require('./helpers/create-test-env');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { fullLogin } = require('./helpers/ensure-login');

const autoScreenshot = createAutoScreenshot('staging-diff-batch');

let BASE_URL = process.env.TEST_BASE_URL || '';
let EMAIL = process.env.TEST_EMAIL || 'admin';
let PASSWORD = process.env.TEST_PASSWORD || '';

let allTypeTableId = null;
let envContext = null;
let envPage = null;

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

test.describe.serial('staging 差分 第 2 弾 (10 件 structural regression)', () => {
    let fileBeforeAllFailed = false;

    test.beforeAll(async ({ browser }) => {
        try {
            const env = await createTestEnv(browser, { withAllTypeTable: true });
            BASE_URL = env.baseUrl;
            EMAIL = env.email;
            PASSWORD = env.password;
            allTypeTableId = env.tableId;
            envContext = env.context;
            envPage = env.page;
            // helper の getBaseUrl() に伝えるため process.env にも反映
            process.env.TEST_BASE_URL = env.baseUrl;
            process.env.TEST_EMAIL = env.email;
            process.env.TEST_PASSWORD = env.password;
        } catch (e) {
            console.error('[staging-diff-batch beforeAll] createTestEnv 失敗:', e.message);
            fileBeforeAllFailed = true;
            throw e;
        }
    });

    test.afterAll(async () => {
        if (envContext) await envContext.close().catch(() => {});
    });

    // rr-010: records.spec.js に再配置 (2026-04-26 PR #21)

    // ccl-010: chart-permissions.spec.js に再配置 (2026-04-26 PR #20)

    /**
     * ms-040 / at-010: master-settings.spec.js に再配置 (2026-04-26 PR #18)
     * pf-010: public-form.spec.js に再配置 (2026-04-26 PR #18)
     * kt-100: kintone.spec.js に再配置 (2026-04-26 PR #18)
     */

    // ip-080: users-permissions.spec.js に再配置 (2026-04-26 PR #17)

    // mail-010: notifications.spec.js に再配置 (2026-04-26 PR #16)

    // exc-080: excel-import.spec.js に再配置 (2026-04-26 PR #19)
    // srh-100: global-search.spec.js に再配置 (2026-04-26 PR #19)
});
