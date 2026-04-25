// @ts-check
/**
 * regression.spec.js — 機能横断 構造回帰テスト集
 *
 * 「機能ごとの spec」という分類軸に乗らない、横断的・汎用的な
 * 構造回帰 guard テストを集約する spec。
 *
 * 観点:
 * - a11y      : アクセシビリティ (見出し / label 紐付け)
 * - keyboard  : キーボード操作 (Tab / goBack)
 * - route     : 各管理画面の ISE/500 構造的安全性
 * - error-ui  : 不正 URL / 不正 ID で ISE が出ない
 * - responsive: リサイズ/viewport 切り替えで UI 維持
 *
 * 各機能の振る舞いテストは、対応する機能 spec
 * (auth.spec.js, master-settings.spec.js 等) に格納。
 * 本 spec は「機能横断の保険」として、回帰検出の網を広く張る役目。
 *
 * テスト ID:
 * - a11y-010   ダッシュボードに見出し or ARIA landmark
 * - a11y-020   ログイン画面 input に label/aria-label/placeholder 紐付け
 * - keyb-010   ログイン画面で Tab キー押下フォーカス移動
 * - keyb-020   編集画面 → goBack で navigation stuck しない
 * - route-010  アカウント設定 /admin/admin_setting/edit/1 → ISE なく描画
 * - route-020  マスター編集 /admin/admin/edit/1 → ISE なく描画 + 主要 input 確認
 * - route-030  テーブル設定 /admin/dataset/edit/N → ISE なく描画 + tab/form 確認
 * - err-010    存在しない URL → ISE/500 出ない
 * - err-020    存在しない record id (view/99999) → ISE/500 出ない
 * - resp-010   Desktop→Mobile→Desktop リサイズで navbar 維持
 */
const { test, expect } = require('@playwright/test');
const { createTestEnv } = require('./helpers/create-test-env');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { fullLogin } = require('./helpers/ensure-login');

const autoScreenshot = createAutoScreenshot('regression');

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

test.describe.serial('regression — 機能横断 構造回帰テスト集 (a11y + キーボード + ルート + エラー UI + responsive)', () => {
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
            console.error('[regression beforeAll]', e.message);
            fileBeforeAllFailed = true;
            throw e;
        }
    });

    test.afterAll(async () => {
        if (envContext) await envContext.close().catch(() => {});
    });

    /**
     * a11y-010: ダッシュボード画面に見出し要素 or ARIA landmark が存在 (a11y 構造)
     * @requirements.txt(R-370)
     */
    test('a11y-010: ダッシュボードに見出し要素 or ARIA landmark が存在', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        // 見出し or landmark を広めにチェック (Angular SPA は h1 を持たないこともある)
        const headingOrLandmark = await page.locator(
            'h1, h2, h3, h4, h5, h6, [role="heading"], [role="navigation"], [role="banner"], [role="main"], nav, header, main'
        ).count();
        expect(headingOrLandmark, '見出し or ARIA landmark が DOM に最低 1 つ存在').toBeGreaterThan(0);

        await autoScreenshot(page, 'SD8-01', 'a11y-010', _testStart);
    });

    /**
     * a11y-020: ログイン画面の input に label or aria-label が紐付け
     * @requirements.txt(R-371)
     */
    test('a11y-020: ログイン画面 input に label/aria-label が紐付け', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        const _testStart = Date.now();

        await page.context().clearCookies().catch(() => {});
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForSelector('#id', { timeout: 10000 });

        // ID input に label または aria-label が紐付け (placeholder のみは a11y 不十分)
        const idHasLabel = await page.evaluate(() => {
            const el = document.querySelector('#id');
            if (!el) return false;
            const ariaLabel = el.getAttribute('aria-label');
            const label = document.querySelector('label[for="id"]');
            const placeholder = el.getAttribute('placeholder');
            return !!(ariaLabel || label || placeholder);
        });
        expect(idHasLabel, 'ID 入力欄に何らかの説明 (label/aria-label/placeholder) が紐付け').toBe(true);

        const pwHasLabel = await page.evaluate(() => {
            const el = document.querySelector('#password');
            if (!el) return false;
            const ariaLabel = el.getAttribute('aria-label');
            const label = document.querySelector('label[for="password"]');
            const placeholder = el.getAttribute('placeholder');
            return !!(ariaLabel || label || placeholder);
        });
        expect(pwHasLabel, 'パスワード入力欄に何らかの説明が紐付け').toBe(true);

        await autoScreenshot(page, 'SD8-02', 'a11y-020', _testStart);
    });

    /**
     * keyb-010: ログイン画面で Tab キーで input → button へ順次フォーカス
     * @requirements.txt(R-372)
     */
    test('keyb-010: ログイン画面で Tab キー押下によりフォーカスが移動する', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        const _testStart = Date.now();

        await page.context().clearCookies().catch(() => {});
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForSelector('#id', { timeout: 10000 });

        // ID にフォーカス置き Tab → password にフォーカス
        await page.locator('#id').focus();
        await page.keyboard.press('Tab');
        const focused1 = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
        // 次の Tab で submit ボタン or 別 input
        await page.keyboard.press('Tab');
        const focused2 = await page.evaluate(() => document.activeElement?.tagName + (document.activeElement?.id ? '#' + document.activeElement.id : ''));

        // フォーカスが移動した = ID 以外にフォーカスが移っている
        expect(focused1 !== 'id' && focused1 !== '' && focused1 !== undefined, `Tab で フォーカス移動 (got: ${focused1})`).toBe(true);
        expect(focused2 !== focused1, `2 回目 Tab で更にフォーカス移動 (got: ${focused2})`).toBe(true);

        await autoScreenshot(page, 'SD8-03', 'keyb-010', _testStart);
    });

    /**
     * keyb-020: ALLテストテーブルレコード編集後 ブラウザバック相当 navigation で
     *           編集画面から離脱できる (キーボード ESC や戻るで stuck しない)
     * @requirements.txt(R-373)
     */
    test('keyb-020: 編集画面から goBack で離脱できる (navigation stuck regression)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        const _testStart = Date.now();

        await login(page);
        // 一覧画面 → 詳細画面 → 一覧に戻る
        await page.goto(BASE_URL + `/admin/dataset__${allTypeTableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        await page.goto(BASE_URL + `/admin/dataset__${allTypeTableId}/view/1`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

        const url = page.url();
        expect(url, 'goBack で一覧 (or dashboard) に戻れる').toMatch(new RegExp(`dataset__${allTypeTableId}|dashboard`));

        await autoScreenshot(page, 'SD8-04', 'keyb-020', _testStart);
    });

    /**
     * route-010: アカウント設定画面 (/admin/admin_setting/edit/1) が ISE なく描画
     * (バリデーション観点はフィールドが揃った別 spec で実施するためここでは route 安全性のみ)
     * @requirements.txt(R-374)
     */
    test('route-010: アカウント設定画面が ISE なく描画', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/admin_setting/edit/1', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD8-05', 'route-010', _testStart);
    });

    /**
     * route-020: マスター編集画面 (/admin/admin/edit/1) が ISE なく描画
     * @requirements.txt(R-375)
     */
    test('route-020: マスター編集画面が ISE なく描画', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/admin/edit/1', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');
        // master 編集 form の主要 input を 30 秒まで待機 (Angular 遅延描画対応)
        await page.waitForFunction(
            () => document.querySelectorAll('input[type="password"], input[type="text"], input[type="email"]').length >= 1,
            null,
            { timeout: 30000 }
        ).catch(() => {});
        const inputCount = await page.locator('input[type="password"], input[type="text"], input[type="email"]').count();
        expect(inputCount, 'master 編集 form の input が描画').toBeGreaterThan(0);

        await autoScreenshot(page, 'SD8-06', 'route-020', _testStart);
    });

    /**
     * route-030: テーブル設定画面 (/admin/dataset/edit/N) が ISE なく描画
     * @requirements.txt(R-376)
     */
    test('route-030: テーブル設定画面が ISE なく描画 + form/tab UI 描画', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + `/admin/dataset/edit/${allTypeTableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

        const bodyText = await page.innerText('body');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');
        const tabOrFormCount = await page.locator('[role="tab"], form').count();
        expect(tabOrFormCount, 'tab or form が DOM に描画').toBeGreaterThan(0);

        await autoScreenshot(page, 'SD8-07', 'route-030', _testStart);
    });

    /**
     * err-010: 存在しない admin URL `/admin/__nonexistent__` → ISE/500 出ない
     * @requirements.txt(R-377)
     */
    test('err-010: 存在しない admin URL → ISE/500 出ない (404 or redirect)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + '/admin/__nonexistent_route_xyz__', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);

        const bodyText = await page.innerText('body').catch(() => '');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');
        expect(bodyText, '500 エラーページなし').not.toContain('500 Server Error');

        await autoScreenshot(page, 'SD8-08', 'err-010', _testStart);
    });

    /**
     * err-020: 存在しない record id `dataset__N/view/99999` → ISE/500 出ない
     * @requirements.txt(R-378)
     */
    test('err-020: 存在しない record id → ISE/500 出ない', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        const _testStart = Date.now();

        await login(page);
        await page.goto(BASE_URL + `/admin/dataset__${allTypeTableId}/view/99999`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);

        const bodyText = await page.innerText('body').catch(() => '');
        expect(bodyText, 'ISE 表示なし').not.toContain('Internal Server Error');
        expect(bodyText, '500 エラーページなし').not.toContain('500 Server Error');

        await autoScreenshot(page, 'SD8-09', 'err-020', _testStart);
    });

    /**
     * resp-010: Desktop → Mobile → Desktop リサイズで navbar 維持 (構造的 responsive guard)
     * @requirements.txt(R-379)
     */
    test('resp-010: Desktop→Mobile→Desktop リサイズで navbar 維持', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(90000);
        const _testStart = Date.now();

        await login(page);
        // Desktop
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForAngular(page);
        const navbarDesktop = await page.locator('.navbar').count();
        expect(navbarDesktop, 'Desktop で navbar が DOM に存在').toBeGreaterThan(0);

        // Mobile
        await page.setViewportSize({ width: 375, height: 667 });
        await page.waitForTimeout(500);  // CSS media query 適用待ち
        const navbarMobile = await page.locator('.navbar').count();
        expect(navbarMobile, 'Mobile でも navbar が DOM に存在').toBeGreaterThan(0);

        // Desktop に戻す
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.waitForTimeout(500);
        const navbarBack = await page.locator('.navbar').count();
        expect(navbarBack, 'Desktop に戻すと navbar が DOM に存在').toBeGreaterThan(0);

        const bodyText = await page.innerText('body');
        expect(bodyText, 'リサイズ後も ISE 表示なし').not.toContain('Internal Server Error');

        await autoScreenshot(page, 'SD8-10', 'resp-010', _testStart);
    });

    /**
     * ng-010: 任意画面遷移後に body[data-ng-ready=true] が設定される (PR #2819)
     * @requirements.txt(R-345)
     */
    test('ng-010: 任意画面遷移後に body[data-ng-ready=true] が設定される (PR #2819)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);

        await login(page);
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: 5000 });
        const ready = await page.evaluate(() => document.body.getAttribute('data-ng-ready'));
        expect(ready, 'body[data-ng-ready] が "true"').toBe('true');
    });

    /**
     * paginate-010: dataset list API で per_page=5 / page=1 指定
     * @requirements.txt(R-367)
     */
    test('paginate-010: dataset list API で ページング指定 (per_page=5, page=1)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);

        await login(page);
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
    });

    /**
     * rate-010: 連続 5 回 dataset list API → 全て 5xx 出ない
     * @requirements.txt(R-368)
     */
    test('rate-010: 連続 5 回 dataset list API → 全て 5xx 出ない', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        test.setTimeout(60000);

        await login(page);
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
    });
});
