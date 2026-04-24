// @ts-check
const { test, expect } = require('@playwright/test');
const { createTestEnv } = require('./helpers/create-test-env');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');

const autoScreenshot = createAutoScreenshot('master-settings');

let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;

// =============================================================================
// マスター向け統合設定画面 (/admin/master-settings)
// PR #3091 で追加。8 項目 (システム利用状況 / メール取り込み / kintone / SSO /
// 契約設定 / 請求情報 / 権限設定 / その他設定) を集約
// =============================================================================

async function waitForAngular(page) {
    await page.waitForSelector('body[data-ng-ready="true"]', { timeout: 5000 }).catch(() => {
        return page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    });
}

async function login(page, email, password) {
    // 新環境にログインするため、前のセッション Cookie を明示的にクリア
    await page.context().clearCookies().catch(() => {});

    await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    // 少し待って redirect が落ち着くのを待つ
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // すでにダッシュボードに redirect されているならログイン不要
    if (!page.url().includes('/login')) {
        await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
        return;
    }

    await page.waitForSelector('#id', { timeout: 10000 });
    await page.fill('#id', email || EMAIL);
    await page.fill('#password', password || PASSWORD);
    await page.locator('button[type=submit].btn-primary').first().click();
    await page.waitForURL(/\/(admin\/dashboard|admin\/[a-z_]+)/, { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.navbar', { timeout: 15000 });
}

async function logout(page) {
    await page.evaluate(() => fetch('/api/admin/logout', { method: 'GET', credentials: 'include' })).catch(() => {});
    await page.context().clearCookies().catch(() => {});
}

test.describe.serial('マスター向け統合設定画面', () => {
    let fileBeforeAllFailed = false;

    test.beforeAll(async ({ browser }) => {
        try {
            const env = await createTestEnv(browser, { withAllTypeTable: false });
            BASE_URL = env.baseUrl;
            EMAIL = env.email;
            PASSWORD = env.password;
            process.env.TEST_BASE_URL = BASE_URL;
            process.env.TEST_EMAIL = EMAIL;
            process.env.TEST_PASSWORD = PASSWORD;
        } catch (e) {
            console.error('[master-settings beforeAll] createTestEnv 失敗:', e.message);
            fileBeforeAllFailed = true;
            throw e;
        }
    });

    /**
     * ms-010: マスターユーザーで統合設定画面の全項目が表示されること
     * @requirements.txt(R-263)
     */
    test('ms-010: マスターで master-settings 画面が開き、主要項目が表示される', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        const stepCount = 6;
        test.setTimeout(Math.max(60000, stepCount * 15000 + 30000));
        const _testStart = Date.now();

        // [flow] 10-1. マスター (admin) でログイン
        await login(page, EMAIL, PASSWORD);

        // [flow] 10-2. /admin/master-settings にアクセス
        await page.goto(BASE_URL + '/admin/master-settings', { waitUntil: 'domcontentloaded' });
        await waitForAngular(page);

        // [check] 10-3. ✅ 統合設定レイアウト (master-settings-page) が表示される
        await expect(page.locator('.master-settings-page')).toBeVisible({ timeout: 15000 });

        // [check] 10-4. ✅ タイトル「管理者設定」が表示される
        await expect(page.locator('.topbar-title').getByText('管理者設定')).toBeVisible();

        // [check] 10-5. ✅ サイドメニューに常設項目 (権限設定 / その他設定 / メール取り込み / SSO) が表示される
        const sidebar = page.locator('.master-settings-sidebar');
        await expect(sidebar).toBeVisible();
        const requiredItems = ['権限設定', 'その他設定', 'メール取り込み設定', 'シングルサインオン'];
        for (const label of requiredItems) {
            await expect(sidebar.locator('.sidebar-item', { hasText: label }).first()).toBeVisible({
                timeout: 5000,
            });
        }

        // [check] 10-6. ✅ 「閉じる」ボタンが表示される
        await expect(page.locator('.btn-close-settings')).toBeVisible();

        await autoScreenshot(page, 'MS01', 'ms-010', _testStart);
    });

    /**
     * ms-020: 非マスターユーザーで master-settings にアクセスするとダッシュボードへリダイレクト
     * @requirements.txt(R-264)
     */
    test('ms-020: 非マスターユーザーは master-settings にアクセスできずダッシュボードへ戻される', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        const stepCount = 6;
        test.setTimeout(Math.max(60000, stepCount * 15000 + 30000));
        const _testStart = Date.now();

        expect(BASE_URL && EMAIL && PASSWORD, 'テスト環境が初期化されていること').toBeTruthy();

        // [flow] 20-1. マスターでログインしてデバッグAPIで一般ユーザーを作成
        await login(page, EMAIL, PASSWORD);

        const createResp = await page.request.post(BASE_URL + '/api/admin/debug/create-user', {
            data: {},
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            failOnStatusCode: false,
        });
        const createStatus = createResp.status();
        const createBody = (await createResp.text());
        expect(createStatus, `create-user API 応答 (body: ${createBody.slice(0, 500)})`).toBeGreaterThanOrEqual(200);
        expect(createStatus).toBeLessThan(500);

        // レスポンスから作成された email / password を抽出 (ishikawa+N@loftal.jp / admin)
        let userEmail = null;
        let userPassword = null;
        try {
            const parsed = JSON.parse(createBody);
            userEmail = parsed.email || (parsed.result && parsed.result.email);
            userPassword = parsed.password || (parsed.result && parsed.result.password) || 'admin';
        } catch {}
        expect(userEmail, `create-user レスポンスから email が取得できること: ${createBody.slice(0, 500)}`).toBeTruthy();

        // [flow] 20-2. マスターをログアウト
        await logout(page);

        // [flow] 20-3. 一般ユーザーでログイン
        await login(page, userEmail, userPassword);
        // ログインに失敗する場合もあるので /dashboard までは必須チェックしない
        await page.waitForLoadState('domcontentloaded').catch(() => {});

        // [flow] 20-4. /admin/master-settings に直接 goto
        await page.goto(BASE_URL + '/admin/master-settings', { waitUntil: 'domcontentloaded' });
        await waitForAngular(page);
        await page.waitForTimeout(1500); // リダイレクト完了待ち (ngOnInit の非同期 loadAdminDatas)

        const currentUrl = page.url();

        // [check] 20-5. ✅ master-settings に留まっていない (ダッシュボード or ログイン画面へ戻される)
        const isRedirected = !currentUrl.includes('/master-settings') ||
                             currentUrl.includes('/dashboard') ||
                             currentUrl.includes('/login');
        expect(isRedirected, `URL: ${currentUrl}`).toBe(true);

        // [check] 20-6. ✅ master-settings-page が表示されていない (または visible でない)
        const pageVisible = await page.locator('.master-settings-page').isVisible().catch(() => false);
        expect(pageVisible).toBe(false);

        await autoScreenshot(page, 'MS02', 'ms-020', _testStart);
    });

    /**
     * ms-030: アカウントロック解除ボタンの表示条件 (非ロック時は非表示)
     * @requirements.txt(R-265)
     *
     * 注: MAX_LOGIN_FAIL=20 への到達と「account_locked」判定は
     *   skip_lock_check = !IS_PRODUCTION && NetCommon::isDebugIp()
     * により staging + VPN IP 環境で常にスキップされるため、
     * 実ロック→解除フローは E2E 検証不可 (`.claude/test-env-limitations.md` 参照)。
     * ここでは UI の非表示条件 (ngIf) の基本動作を検証する。
     */
    test('ms-030: 非ロック時はアカウントロック解除ボタンが表示されない (UI 条件検証)', async ({ page }) => {
        test.skip(fileBeforeAllFailed, 'beforeAll失敗のためスキップ');
        const stepCount = 6;
        test.setTimeout(Math.max(60000, stepCount * 15000 + 30000));
        const _testStart = Date.now();

        expect(BASE_URL && EMAIL && PASSWORD, 'テスト環境が初期化されていること').toBeTruthy();

        // [flow] 30-1. マスターでログイン
        await login(page, EMAIL, PASSWORD);

        // [flow] 30-2. 自分 (admin id=1) の admin view 画面にアクセス
        await page.goto(BASE_URL + '/admin/admin/view/1', { waitUntil: 'domcontentloaded' });
        await waitForAngular(page);
        await page.waitForSelector('.navbar', { timeout: 15000 });
        // view コンポーネントが描画されるまで待機 (最大 10 秒)
        await page.waitForTimeout(3000);

        // [check] 30-3. ✅ ページが `/admin/admin/view/1` のままでありリダイレクトされていない
        expect(page.url()).toContain('/admin/admin/view/1');

        // [check] 30-4. ✅ アカウントロック解除ボタンは非表示 (account_locked=false のため)
        //        ngIf="table === 'admin' && isMasterUser && account_locked" の account_locked=false 分岐
        const unlockBtn = page.locator('button.btn-outline-danger', { hasText: 'アカウントロック解除' });
        const unlockCount = await unlockBtn.count();
        expect(unlockCount, '非ロック時は unlock ボタンが DOM に存在しない (ngIf=false)').toBe(0);

        // [check] 30-5. ✅ Internal Server Error が出ていない (view ページが 500 で死んでいない)
        const bodyText = await page.locator('body').innerText();
        expect(bodyText).not.toContain('Internal Server Error');

        await autoScreenshot(page, 'MS03', 'ms-030', _testStart);
    });
});
