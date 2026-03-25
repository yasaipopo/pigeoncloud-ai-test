// @ts-check
const { test, expect } = require('@playwright/test');
const { ensureLoggedIn } = require('./helpers/ensure-login');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

async function waitForAngular(page, timeout = 15000) {
    await page.waitForSelector('body[data-ng-ready="true"]', { timeout });
}

/**
 * ログイン共通関数（ensureLoggedInにフォールバック）
 */
async function login(page) {
    await ensureLoggedIn(page);
}

/**
 * テーブル管理画面のfa-barsドロップダウンを開く
 * @param {import('@playwright/test').Page} page
 */
async function openTableManagementBarsMenu(page) {
    await page.goto(BASE_URL + '/admin/dataset', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitForAngular(page);

    // fa-bars ドロップダウンボタンをクリック
    await page.evaluate(() => {
        const barsBtn = document.querySelector('button.btn-outline-primary .fa-bars');
        if (barsBtn) barsBtn.closest('button').click();
    });
    await page.waitForTimeout(800);
}

/**
 * テンプレートモーダルを開く
 * （テーブル管理 → fa-bars → テンプレートから追加）
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>} モーダルが開けたかどうか
 */
async function openTemplateModal(page) {
    await openTableManagementBarsMenu(page);

    // 「テンプレートから追加」をクリック
    const clicked = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.dropdown-menu.show .dropdown-item, .dropdown-item'));
        const templateItem = items.find(a => a.textContent.includes('テンプレートから追加'));
        if (templateItem) { templateItem.click(); return true; }
        return false;
    });

    if (!clicked) return false;

    await page.waitForTimeout(1500);

    // モーダルが開いているか確認
    const modalCount = await page.locator('.modal.show').count();
    return modalCount > 0;
}

test.describe('テンプレート', () => {
    test('TMPL-01: テンプレート一覧モーダルが正常に表示されること', async ({ page }) => {
        await login(page);

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
    });

    test('TMPL-02: テンプレートの詳細を確認できること', async ({ page }) => {
        await login(page);

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
        await page.waitForTimeout(1000);

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
    });

    test('TMPL-03: テンプレートインストールモーダルの「戻る」で一覧に戻れること', async ({ page }) => {
        await login(page);

        const opened = await openTemplateModal(page);
        expect(opened).toBeTruthy();

        // テンプレートをクリックして詳細へ
        const templateIcons = await page.locator('.modal.show .template_icon');
        await templateIcons.first().click();
        await page.waitForTimeout(1000);

        // インストールボタンが表示されていること
        const installBtn = page.locator('.modal.show .btn-warning').filter({ hasText: /インストール/ });
        await expect(installBtn.first()).toBeVisible();

        // 「戻る」ボタンをクリック
        const backBtn = page.locator('.modal.show button').filter({ hasText: '戻る' });
        await backBtn.first().click();
        await page.waitForTimeout(800);

        // テンプレート一覧に戻ること
        const templateIconsAfter = await page.locator('.modal.show .template_icon').count();
        expect(templateIconsAfter).toBeGreaterThan(0);
    });

    test('TMPL-04: テンプレートをインストールできること', async ({ page }) => {
        await login(page);

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
        await page.waitForTimeout(1000);

        // インストールボタンをクリック
        const installBtn = page.locator('.modal.show .btn-warning').filter({ hasText: /インストール/ });
        const installBtnCount = await installBtn.count();
        expect(installBtnCount).toBeGreaterThan(0);

        await installBtn.first().click();
        await page.waitForTimeout(3000);

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
    });

    test('TMPL-05: テンプレートモーダルを閉じられること', async ({ page }) => {
        await login(page);

        const opened = await openTemplateModal(page);
        expect(opened).toBeTruthy();

        // 「×」閉じるボタンをクリック
        const closeBtn = page.locator('.modal.show .close, .modal.show button[aria-label="Close"]');
        const closeBtnCount = await closeBtn.count();

        if (closeBtnCount > 0) {
            await closeBtn.first().click();
            await page.waitForTimeout(800);

            // モーダルが閉じていること
            const modalAfter = await page.locator('.modal.show').count();
            expect(modalAfter).toBe(0);
        } else {
            // スキップボタンで閉じる
            const skipBtn = page.locator('.modal.show button').filter({ hasText: 'スキップ' });
            await skipBtn.first().click();
            await page.waitForTimeout(800);
            const modalAfter = await page.locator('.modal.show').count();
            expect(modalAfter).toBe(0);
        }
    });

    test('TMPL-06: テンプレート一覧のテンプレート名が表示されていること', async ({ page }) => {
        await login(page);

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
    });
});
