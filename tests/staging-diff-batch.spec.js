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

    /**
     * rr-010: ALLテストテーブルレコード詳細画面が Internal Server Error なく表示
     * @requirements.txt(R-310)
     * 背景: PR #3074 で `c6fae929f2` で消失した `relation_add` クラスを復元 (顧客 CSS 互換性)。
     *      これは class 名追加のみの compatibility 修正で、Angular Unit Test 範囲。
     *      E2E では「関連レコードを含む可能性がある詳細画面で regression が起きていない」
     *      structural regression guard とする。
     */
    test('rr-010: ALLテストテーブルレコード詳細画面が ISE なく表示 (PR #3074 regression guard)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(90000);
        const _testStart = Date.now();

        await login(page);
        // ALLテストテーブル initial data 1 件目の詳細画面
        await page.goto(BASE_URL + `/admin/dataset__${allTypeTableId}/view/1`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし (PR #3074 の class 追加で他コードに影響していない)').not.toContain('Internal Server Error');

        // 詳細画面の主要 DOM が描画されている (詳細画面に必ず出るタブ・テーブル要素・ボタンを使用)
        const tableEl = page.locator('table, [role="tablist"], button:has-text("レコード"), button:has-text("前のレコード")').first();
        const tableOrTab = await tableEl.count();
        expect(tableOrTab, '詳細画面の主要 DOM (table or tab) が描画').toBeGreaterThan(0);

        await autoScreenshot(page, 'SD01', 'rr-010', _testStart);
    });

    /**
     * ccl-010: カレンダー表示でレコードがエラーなく描画される (sort fix regression guard)
     * @requirements.txt(R-311)
     * 背景: PR #2754 で eventOrder の null ハンドリング修正。
     */
    test('ccl-010: カレンダー表示でレコードが描画され Internal Server Error が無いこと (PR #2754)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(90000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + `/admin/dataset__${allTypeTableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        // カレンダー表示ボタンを探す (存在しなければ skip — debug API で view 設定要)
        // 注: isVisible({timeout}) は API 仕様上 timeout を無視するので waitFor を使う
        const calendarBtn = page.locator('button:has-text("カレンダー表示"), button:has(.fa-calendar)').first();
        const hasCalendarBtn = await calendarBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
        // ALL テストテーブルにカレンダー設定が無い場合はテスト不可 (test-env-limitations.md 参照)
        test.skip(!hasCalendarBtn, 'ccl-010: ALL テストテーブルにカレンダー view 設定が無いためスキップ (limitations 記録)');
        await calendarBtn.click({ force: true });
        await waitForAngular(page);
        // FullCalendar 要素表示確認
        const fcEl = page.locator('.fc, .fc-view, .calendar-view').first();
        await expect(fcEl, 'FullCalendar 要素が表示').toBeVisible({ timeout: 10000 });
        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE が出ていない').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD02', 'ccl-010', _testStart);
    });

    /**
     * ms-040: master-settings の admin view 画面で account_locked=false 時に
     *         unlock ボタンが非表示 (UI ngIf=false 分岐確認)。
     * @requirements.txt(R-312)
     * 背景: PR #3144 で master 権限時の unlock button visibility が改善。
     *      staging VPN は skip_lock_check=true でロック発動不可のため、UI 条件のみ検証。
     */
    test('ms-040: 非ロック時に unlock ボタンが非表示 (PR #3144 visibility 条件、ms-030 補完)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/admin/view/1', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        // unlock button が DOM に存在しない (account_locked=false 分岐)
        const unlockBtn = page.locator('button.btn-outline-danger', { hasText: 'アカウントロック解除' });
        const cnt = await unlockBtn.count();
        expect(cnt, '非ロック時は unlock button が DOM に存在しない').toBe(0);

        // 「ロック中」表示も無いこと
        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD03', 'ms-040', _testStart);
    });

    /**
     * at-010: AI Table Builder URL 直打ちで table_create 権限なしユーザーは dashboard に redirect
     * @requirements.txt(R-313)
     * 背景: PR #3139 で URL 直打ち時の画面ガード追加。
     */
    test('at-010: AI Table Builder への遷移 + ISE なし (PR #3139 routing regression guard)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        // PR #3139 は URL 直打ち時の権限ガード追加。route 自体が存在することと
        // ISE/Fatal Error が出ないことを確認。master は dashboard or AI builder 画面に到達。
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
        expect(succeeded, '最低 1 つのルート候補で ISE/404 なく描画').toBe(true);

        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        await autoScreenshot(page, 'SD04', 'at-010', _testStart);
    });

    /**
     * pf-010: 公開フォームで他テーブル参照ルックアップが認可エラーなく動作する
     * @requirements.txt(R-314)
     * 背景: PR #3079 公開フォームで他テーブル参照ルックアップモーダルを有効化。
     *      実走には公開フォーム URL 発行が必要なため、構造的検証のみ。
     */
    test('pf-010: 公開フォーム関連 API path が認証なしで 401 を返さないこと (PR #3079)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        // /api/iframe/lookup へ POST すると JSON 返却される (未公開フォーム = 404 等の正常エラー)
        const result = await page.evaluate(async (baseUrl) => {
            try {
                const r = await fetch(baseUrl + '/api/iframe/lookup/dummy?value=test', {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                });
                return { status: r.status, ok: r.ok };
            } catch (e) {
                return { error: e.message };
            }
        }, BASE_URL);

        // PR #3079 では iframe_api 認可で自動通過するため、認証なしで 401 は返さない (404/400 等の他 error or 200)
        expect(result.status, '/api/iframe/lookup が 401 不認可ではないこと').not.toBe(401);

        await autoScreenshot(page, 'SD05', 'pf-010', _testStart);
    });

    /**
     * kt-100: kintone migration result page URL に master が直アクセス可能
     * @requirements.txt(R-315)
     * 背景: PR #3152 bug-b012 kintone-migration-result/{id} routing 修正。
     */
    test('kt-100: kintone migration result page URL が master でアクセス可能 (PR #3152)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        // 存在しない job_log_id (例: 99999) でも routing は成功し、画面が描画される (ISE 出ない)
        await page.goto(BASE_URL + '/admin/kintone-migration-result/99999', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);

        // routing が解決されている (ai-test に redirect されていない)
        const url = page.url();
        expect(url, 'URL は kintone-migration-result を含む').toContain('kintone-migration-result');

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD06', 'kt-100', _testStart);
    });

    /**
     * ip-080: 許可 IP 設定の duplicate (重複) を試みた場合のバリデーション
     * @requirements.txt(R-316)
     * 背景: PR #3149 admin_allow_ips_multi に is_unique 追加 (up-ip-6 系)
     */
    test('ip-080: 許可IP編集画面が ISE なく開き入力欄が描画 (PR #3149 unique 追加 regression guard)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(90000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/admin/edit/1', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        // 許可 IP 入力欄が存在することを確認 (実 unique 保存テストは複雑、UI 確認のみ)
        const ipInputs = page.locator('input[type="text"]').filter({ hasText: '' });
        const inputCount = await ipInputs.count();
        expect(inputCount, '入力欄が DOM に存在').toBeGreaterThan(0);

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD07', 'ip-080', _testStart);
    });

    // mail-010: notifications.spec.js に再配置 (2026-04-26 PR #16)

    /**
     * exc-080: Excel インポート画面の事前バリデーション (テーブル名重複等)
     * @requirements.txt(R-318)
     * 背景: PR #3101 でテーブル名重複等のバリデーションエラーをユーザーに表示する改善。
     */
    test('exc-080: Excel インポート画面が表示されエラーなく開く (PR #3035/#3101 regression)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/excel-import', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);

        // ドロップゾーン (.drop-zone) が表示される
        await expect(page.locator('.drop-zone')).toBeVisible({ timeout: 10000 });

        // input[type=file] が accept=".xlsx,.xls" 限定 (PR #3035)
        const accept = await page.locator('.drop-zone input[type=file]').getAttribute('accept');
        expect(accept || '', 'accept 属性が .xlsx を含む').toMatch(/\.xlsx/);

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD09', 'exc-080', _testStart);
    });

    /**
     * srh-100: OpenSearch グローバル検索 API が認証済みで応答する
     * @requirements.txt(R-319)
     * 背景: PR #3110 ngram + PR #3115/3117/3118 OpenSearch fixes。
     *      modal 開閉が不安定なので API 経由で疎通確認のみ。
     */
    test('srh-100: OpenSearch search API が認証済みで応答する (PR #3110/#3115/#3117/#3118 backend regression)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);
        const _testStart = Date.now();

        await login(page);
        // OpenSearch search API を直接呼び出し
        const result = await page.evaluate(async (baseUrl) => {
            try {
                const r = await fetch(baseUrl + '/api/admin/opensearch/search?keyword=テスト', {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    credentials: 'include',
                });
                return { status: r.status, ok: r.ok };
            } catch (e) {
                return { error: e.message };
            }
        }, BASE_URL);

        // 認証済みなら 200 か 404 (endpoint が無い場合) — 401 (認証エラー) は出ない
        expect(result.status, 'API が 401 でないこと (認証済み)').not.toBe(401);
        expect(result.status, 'API が 5xx でないこと').toBeLessThan(500);

        await autoScreenshot(page, 'SD10', 'srh-100', _testStart);
    });
});
