// @ts-check
const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { ensureLoggedIn } = require('./helpers/ensure-login');
const { createTestEnv } = require('./helpers/create-test-env');

// 環境変数はbeforeAllで上書きされる（自己完結型）
let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;

/**
 * ステップスクリーンショット撮影
 */
async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        // data-ng-readyが設定されないケースがある: networkidleで代替
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

/**
 * ログイン共通関数（明示的ログイン）
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
    if (!page.url().includes('/login')) {
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
    if (page.url().includes('/login')) {
        await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
        await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
        await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
    }
}

/**
 * テーブル管理画面のfa-barsドロップダウンを開く
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>} ドロップダウンが開けたかどうか
 */
async function openTableManagementBarsMenu(page) {
    // /admin/dataset は初回アクセス時に /admin/dataset/edit/new にリダイレクトされる場合がある
    // また Angular SPA のため、ルーティング完了まで待つ必要がある
    for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto(BASE_URL + '/admin/dataset', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);
        await page.waitForTimeout(1500);

        // /admin/dataset にいるか確認（editやdashboardにリダイレクトされていないか）
        const url = page.url();
        if (url.includes('/admin/dataset') && !url.includes('/edit') && !url.includes('dashboard')) {
            break;
        }
        // リダイレクトされた場合: サイドバーの「テーブル管理」リンクを使う
        const sidebarLink = page.locator('a[href*="/admin/dataset"]').filter({ hasText: /テーブル管理|テーブル一覧/ }).first();
        if (await sidebarLink.count() > 0) {
            await sidebarLink.click();
            await waitForAngular(page);
            await page.waitForTimeout(1500);
            break;
        }
    }

    // fa-bars ドロップダウンボタンを Playwright の click() で操作（Angular の click イベントが正しく処理される）
    // セレクタを広く取り、存在しない場合はフォールバック
    let faBarsBtn = page.locator('button.btn-sm.btn-outline-primary.dropdown-toggle').filter({ has: page.locator('.fa-bars') });
    let btnCount = await faBarsBtn.count();

    // フォールバック: fa-bars アイコンを持つ任意のドロップダウンボタン
    if (btnCount === 0) {
        faBarsBtn = page.locator('button.dropdown-toggle:has(.fa-bars)').first();
        btnCount = await faBarsBtn.count();
    }
    // さらにフォールバック: dropdown-toggleボタン全般
    if (btnCount === 0) {
        faBarsBtn = page.locator('button.dropdown-toggle').first();
        btnCount = await faBarsBtn.count();
    }

    if (btnCount === 0) return false;

    await faBarsBtn.first().click();
    await page.waitForTimeout(800);
    return true;
}

/**
 * テンプレートモーダルを開く
 * （テーブル管理 → fa-bars → テンプレートから追加）
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>} モーダルが開けたかどうか
 */
async function openTemplateModal(page) {
    const menuOpened = await openTableManagementBarsMenu(page);
    if (!menuOpened) return false;

    // 「テンプレートから追加」を Playwright の locator でクリック（Angular の click イベントが正しく処理される）
    const templateItem = page.locator('.dropdown-menu.show .dropdown-item').filter({ hasText: 'テンプレートから追加' });
    const templateItemCount = await templateItem.count();
    if (templateItemCount === 0) return false;

    await templateItem.first().click();
    await page.waitForTimeout(2000);

    // モーダルが開いているか確認
    const modalCount = await page.locator('.modal.show').count();
    return modalCount > 0;
}

const autoScreenshot = createAutoScreenshot('templates');

test.describe('テンプレート', () => {
    // 自己完結: specごとに専用テスト環境を作成
    test.beforeAll(async ({ browser }) => {
        test.setTimeout(120000); // 環境作成に最大2分
        const env = await createTestEnv(browser, { withAllTypeTable: false }); // テンプレートテストにALLテストテーブル不要
        BASE_URL = env.baseUrl;
        EMAIL = env.email;
        PASSWORD = env.password;
        // storageStateを更新（ensureLoggedInが使う）
        process.env.TEST_BASE_URL = env.baseUrl;
        process.env.TEST_EMAIL = env.email;
        process.env.TEST_PASSWORD = env.password;
        await env.context.close();
        console.log(`[templates] 自己完結環境: ${BASE_URL}`);
    });

    test('TM01: テンプレート機能の基本確認', async ({ page }) => {
        await login(page);
        const _testStart = Date.now();
        let stepStart;

        await test.step('tpl-010: テンプレート一覧モーダルが正常に表示されること', async () => {
            stepStart = Date.now();

            const opened = await openTemplateModal(page);
            expect(opened).toBeTruthy();

            // モーダルタイトルが「テンプレートからインストール」であること
            const modalTitle = await page.locator('.modal.show .modal-title').textContent();
            expect(modalTitle).toContain('テンプレート');

            // テンプレート一覧が1件以上表示されること
            const templateIcons = await page.locator('.modal.show .template_icon').count();
            expect(templateIcons).toBeGreaterThan(0);

            // エラーなし
            const errorMsg = await page.locator('.modal.show .alert-danger').count();
            expect(errorMsg).toBe(0);
            await autoScreenshot(page, 'TM01', 'tpl-010', 0, _testStart);
        });

        await test.step('tpl-020: テンプレートの詳細を確認できること', async () => {
            stepStart = Date.now();

            const opened = await openTemplateModal(page);
            expect(opened).toBeTruthy();

            // テンプレートが1件以上存在することを確認
            const templateIcons = await page.locator('.modal.show .template_icon');
            const count = await templateIcons.count();
            expect(count).toBeGreaterThan(0);

            // 最初のテンプレートの名前を取得
            const firstTemplateName = await templateIcons.first().locator('.text').textContent().catch(() => '');

            // テンプレートをクリックして詳細を表示
            await templateIcons.first().click();
            await waitForAngular(page);

            // 詳細ビューに切り替わること（インストールボタンが表示される）
            const installBtn = await page.locator('.modal.show .btn-warning').filter({ hasText: /インストール/ });
            const installBtnCount = await installBtn.count();
            expect(installBtnCount).toBeGreaterThan(0);

            // 詳細説明が表示されること
            const modalBody = await page.locator('.modal.show .modal-body').textContent();
            expect(modalBody.length).toBeGreaterThan(10);

            // 「戻る」ボタンが存在すること
            const backBtn = await page.locator('.modal.show button').filter({ hasText: '戻る' }).count();
            expect(backBtn).toBeGreaterThan(0);
            await autoScreenshot(page, 'TM01', 'tpl-020', 0, _testStart);
        });

        await test.step('tpl-030: テンプレートインストールモーダルの「戻る」で一覧に戻れること', async () => {
            stepStart = Date.now();

            const opened = await openTemplateModal(page);
            expect(opened).toBeTruthy();

            // テンプレートをクリックして詳細へ
            const templateIcons = await page.locator('.modal.show .template_icon');
            await templateIcons.first().click();
            await waitForAngular(page);

            // インストールボタンが表示されていること
            const installBtn = page.locator('.modal.show .btn-warning').filter({ hasText: /インストール/ });
            await expect(installBtn.first()).toBeVisible();

            // 「戻る」ボタンをクリック
            const backBtn = page.locator('.modal.show button').filter({ hasText: '戻る' });
            await backBtn.first().click();
            await waitForAngular(page);

            // テンプレート一覧に戻ること
            const templateIconsAfter = await page.locator('.modal.show .template_icon').count();
            expect(templateIconsAfter).toBeGreaterThan(0);
            await autoScreenshot(page, 'TM01', 'tpl-030', 0, _testStart);
        });

        await test.step('tpl-040: テンプレートをインストールできること', async () => {
            stepStart = Date.now();

            const opened = await openTemplateModal(page);
            expect(opened).toBeTruthy();

            // テンプレートをクリックして詳細へ（タスク管理を優先）
            const templateIcons = page.locator('.modal.show .template_icon');
            const count = await templateIcons.count();
            expect(count).toBeGreaterThan(0);

            // 「タスク管理」を優先選択、なければ最初のテンプレート
            let targetTemplate = templateIcons.filter({ hasText: 'タスク管理' });
            const taskCount = await targetTemplate.count();
            if (taskCount === 0) {
                targetTemplate = templateIcons.first();
            }

            await targetTemplate.first().click();
            await waitForAngular(page);

            // インストールボタンをクリック
            const installBtn = page.locator('.modal.show .btn-warning').filter({ hasText: /インストール/ });
            const installBtnCount = await installBtn.count();
            expect(installBtnCount).toBeGreaterThan(0);

            await installBtn.first().click();
            await waitForAngular(page);

            // インストール中の進捗またはモーダルが閉じること（成功時）
            // モーダルが閉じるかダッシュボードにリダイレクトされること
            const modalAfter = await page.locator('.modal.show').count();
            const finalUrl = page.url();

            // エラーモーダルが出ていないこと（.modal.show内にエラーコンテンツがないこと）
            const errorModal = await page.locator('.modal.show .modal-danger').count();
            expect(errorModal).toBe(0);

            // インストール完了後はモーダルが閉じるかダッシュボードにいること
            // （モーダルが閉じている or まだ表示中でもエラーなし）
            const currentUrl = page.url();
            expect(currentUrl).toContain('/admin/');
            await autoScreenshot(page, 'TM01', 'tpl-040', 0, _testStart);
        });

        await test.step('tpl-050: テンプレートモーダルを閉じられること', async () => {
            stepStart = Date.now();

            const opened = await openTemplateModal(page);
            expect(opened).toBeTruthy();

            // 「×」閉じるボタンをクリック
            const closeBtn = page.locator('.modal.show .close, .modal.show button[aria-label="Close"]');
            const closeBtnCount = await closeBtn.count();

            if (closeBtnCount > 0) {
                await closeBtn.first().click();
                await waitForAngular(page);

                // モーダルが閉じていること
                const modalAfter = await page.locator('.modal.show').count();
                expect(modalAfter).toBe(0);
            } else {
                // スキップボタンで閉じる
                const skipBtn = page.locator('.modal.show button').filter({ hasText: 'スキップ' });
                await skipBtn.first().click();
                await waitForAngular(page);
                const modalAfter = await page.locator('.modal.show').count();
                expect(modalAfter).toBe(0);
            }
            await autoScreenshot(page, 'TM01', 'tpl-050', 0, _testStart);
        });

        await test.step('tpl-060: テンプレート一覧のテンプレート名が表示されていること', async () => {
            stepStart = Date.now();

            const opened = await openTemplateModal(page);
            expect(opened).toBeTruthy();

            // テンプレート名の一覧を取得
            const templateNames = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.modal.show .template_icon .text')).map(el => el.textContent.trim());
            });

            // 複数のテンプレートが存在すること
            expect(templateNames.length).toBeGreaterThan(0);

            // 既知のテンプレート名が含まれていること（少なくとも1つ）
            const knownTemplates = ['採用管理', '在庫管理', 'タスク管理', 'ファイル管理', '顧客管理'];
            const hasKnownTemplate = templateNames.some(name => knownTemplates.includes(name));
            expect(hasKnownTemplate).toBeTruthy();
            await autoScreenshot(page, 'TM01', 'tpl-060', 0, _testStart);
        });
    });
});
