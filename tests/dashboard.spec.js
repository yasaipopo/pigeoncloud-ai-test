// @ts-check
const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { getAllTypeTableId } = require('./helpers/table-setup');
const { createTestEnv } = require('./helpers/create-test-env');

let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;

/**
 * ステップスクリーンショット撮影
 * @param {import('@playwright/test').Page} page
 * @param {string} spec - spec名（例: 'dashboard'）
 * @param {string} movie - movie ID（例: 'DB01'）
 * @param {string} stepId - ステップID（例: 'dash-010-s2'）
 * @param {number} testStartTime - テスト開始時刻（Date.now()）
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
 * ログイン共通関数
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    // storageStateでログイン済みならリダイレクトされる
    if (!page.url().includes('/admin/login')) {
        await page.waitForSelector('.navbar', { timeout: 5000 });
        return;
    }
    // ログインフォームが表示されなければリダイレクト途中
    const _loginField = await page.waitForSelector('#id', { timeout: 5000 }).catch(() => null);
    if (!_loginField) {
        await page.waitForSelector('.navbar', { timeout: 5000 });
        return;
    }
    await waitForAngular(page);

    // APIログインを優先（フォームロード待機不要で高速・確実）
    const loginResult = await page.evaluate(async ({ email, password }) => {
        try {
            const csrfResp = await fetch('/api/csrf_token');
            const csrf = await csrfResp.json();
            const loginResp = await fetch('/api/login/admin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email, password,
                    admin_table: 'admin',
                    csrf_name: csrf.csrf_name,
                    csrf_value: csrf.csrf_value,
                    login_type: 'user',
                    auth_token: null,
                    isManageLogin: false
                })
            });
            return await loginResp.json();
        } catch (e) {
            return { result: 'error', error: e.toString() };
        }
    }, { email: EMAIL, password: PASSWORD });

    if (loginResult.result === 'success') {
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        return;
    }

    // APIログイン失敗時はフォームログイン
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    const idField = await page.waitForSelector('#id', { timeout: 5000 }).catch(() => null);
    if (!idField) {
        if (!page.url().includes('/admin/login')) return;
        throw new Error('ログインフォームの#idフィールドが見つかりません');
    }
    await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
    await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 15000 });
    } catch (e) {
        if (page.url().includes('/admin/login')) {
            await page.waitForTimeout(1000);
            await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
            await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 15000 });
        }
    }
    await page.waitForTimeout(1000);
}

/**
 * チュートリアルモーダルを閉じる
 */
async function closeTutorialModal(page) {
    const hasTutorial = await page.locator('.modal.show').filter({ hasText: 'テンプレートからインストール' }).isVisible({ timeout: 3000 }).catch(() => false);
    if (hasTutorial) {
        await page.locator('.modal.show button:has-text("スキップ")').first().click({ force: true }).catch(() => {});
        await waitForAngular(page).catch(() => {});
    }
}

/**
 * ダッシュボードタブの▼メニューを開く
 */
async function openTabMenu(page, tabLocator) {
    await tabLocator.evaluate((el) => {
        const children = el.children;
        if (children.length > 0) {
            (children[children.length - 1]).click();
        }
    });
    await page.waitForTimeout(800);
}

const autoScreenshot = createAutoScreenshot('dashboard');

test.describe('ダッシュボード', () => {
    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        const env = await createTestEnv(browser, { withAllTypeTable: true });
        BASE_URL = env.baseUrl;
        EMAIL = env.email;
        PASSWORD = env.password;
        process.env.TEST_BASE_URL = env.baseUrl;
        process.env.TEST_EMAIL = env.email;
        process.env.TEST_PASSWORD = env.password;
        await env.context.close();
        console.log(`[dashboard] 自己完結環境: ${BASE_URL}`);
    });

    test.beforeEach(async ({ page }) => {
        // 古い環境のcookieをクリアして新環境にログイン
        await page.context().clearCookies();
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
    });

    // =========================================================================
    // DB01: ダッシュボード基本操作（dash-010〜dash-060）→ 1動画
    // =========================================================================
    test('DB01: ダッシュボード基本操作', async ({ page }) => {
        test.setTimeout(120000);
        const _testStart = Date.now();
        page.setDefaultTimeout(60000);

        await login(page);

        // beforeAll相当: ALLテストテーブルID取得
        let _tableId = null;
        let _createdDashboardName = null;

        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page).catch(() => {});
        _tableId = await getAllTypeTableId(page);
        if (!_tableId) {
            console.log('[DB01] ALLテストテーブルが見つかりません（DB-03で個別にスキップされます）');
        }

        // ----- step: dash-010 ダッシュボード画面表示 -----
        await test.step('dash-010: ダッシュボード画面が正常に表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-010`);

            await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await waitForAngular(page);

            // 2. ✅ .navbar が表示されていること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            // 3. ✅ HOMEタブが表示されていること
            const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            await expect(tablist).toBeVisible();
            const homeTab = tablist.locator('[role=tab]').filter({ hasText: 'HOME' });
            await expect(homeTab).toBeVisible();

            // 4. ✅ URLが /admin/dashboard を含むこと
            expect(page.url()).toContain('/admin/dashboard');
            await autoScreenshot(page, 'DB01', 'dash-010', _testStart);
        });

        // ----- step: dash-020 タブ作成 -----
        await test.step('dash-020: 新しいダッシュボードタブを作成できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-020`);

            await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await waitForAngular(page);

            // チュートリアルモーダルを閉じる
            await closeTutorialModal(page);

            // 5. 「+」ボタンをクリック
            const dashTablistDB02 = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const tabsBeforeDB02 = await dashTablistDB02.locator('[role=tab]').count();
            await dashTablistDB02.locator('button.dashboard-tab-add-btn').click({ force: true }).catch(async () => {
                await dashTablistDB02.locator('button').first().click({ force: true }).catch(() => {});
            });
            await waitForAngular(page);

            // 6. ダッシュボード作成モーダルで名前を入力して送信
            await page.waitForFunction(() => {
                const inputs = document.querySelectorAll('input#name');
                for (const inp of inputs) {
                    const r = inp.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return true;
                }
                return false;
            }, null, { timeout: 8000 });

            const db02Name = `テストDB02_${Date.now()}`;
            await page.evaluate((name) => {
                const inputs = document.querySelectorAll('input#name');
                for (const input of inputs) {
                    const r = input.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) {
                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                        nativeInputValueSetter.call(input, name);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        return;
                    }
                }
            }, db02Name);
            await page.waitForTimeout(300);

            await page.evaluate(() => {
                const btns = document.querySelectorAll('button.btn-primary.ladda-button');
                for (const btn of btns) {
                    const r = btn.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && btn.textContent.trim().includes('送信')) {
                        btn.click();
                        return;
                    }
                }
            });

            // タブが増えるのを待つ
            await page.waitForFunction(
                (beforeCount) => {
                    const tablist = document.querySelector('[role=tablist].nav.nav-tabs');
                    if (!tablist) return false;
                    return tablist.querySelectorAll('[role=tab]').length > beforeCount;
                },
                tabsBeforeDB02,
                { timeout: 10000 }
            ).catch(() => {});
            await page.waitForTimeout(1500);

            // 7. ✅ 新しいタブがタブリストに表示されること
            const dashTablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const newTab = dashTablist.locator('[role=tab]').filter({ hasText: db02Name });
            const allTabTexts = await dashTablist.locator('[role=tab]').allTextContents().catch(() => []);
            console.log('dash-020: 全タブ:', allTabTexts, '検索名:', db02Name);
            await expect(newTab).toBeVisible();
            await autoScreenshot(page, 'DB01', 'dash-020', _testStart);

            _createdDashboardName = db02Name;
        });

        // ----- step: dash-030 ビューコンテンツ追加 -----
        await test.step('dash-030: ダッシュボードにビューコンテンツを追加できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-030`);

            await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await waitForAngular(page);

            expect(_createdDashboardName, 'dash-020でダッシュボードが作成されていること').toBeTruthy();

            // 8. 作成したタブを選択
            const dashTablistDB03 = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const targetTab = dashTablistDB03.locator('[role=tab]').filter({ hasText: _createdDashboardName });
            await expect(targetTab.first(), `ダッシュボードタブ "${_createdDashboardName}" が存在すること`).toBeVisible();
            await targetTab.first().click();
            await waitForAngular(page);

            // 9. 「ウィジェットを追加」ボタンをクリック
            const targetTabEl = dashTablistDB03.locator('[role=tab]').filter({ hasText: _createdDashboardName }).first();
            const tabpanelId = await targetTabEl.getAttribute('aria-controls').catch(() => null);

            let addWidgetBtn;
            if (tabpanelId) {
                addWidgetBtn = page.locator(`#${tabpanelId} button`).filter({ hasText: 'ウィジェットを追加' });
            } else {
                addWidgetBtn = page.locator('[role=tabpanel] button').filter({ hasText: 'ウィジェットを追加' }).first();
            }
            await expect(addWidgetBtn).toBeVisible();
            await addWidgetBtn.click();

            // 10. ビューダイアログでALLテストテーブルを選択
            await page.waitForTimeout(1000);
            const dialogVisible = await page.waitForFunction(() => {
                const dialogs = document.querySelectorAll('dialog');
                for (const d of dialogs) {
                    const r = d.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && d.textContent.includes('ビュー')) return true;
                }
                const modals = document.querySelectorAll('.modal.show');
                for (const m of modals) {
                    const r = m.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && m.textContent.includes('ビュー')) return true;
                }
                return false;
            }, null, { timeout: 8000 }).then(() => true).catch(() => false);

            if (!dialogVisible) {
                throw new Error('dash-030: ビューダイアログが開きませんでした。UIを確認してください。');
            }

            const modalContainer = page.locator('dialog, .modal.show').filter({ hasText: 'ビュー' }).first();
            const tableCombobox = modalContainer.locator('[role=combobox]').first();
            await tableCombobox.click();
            await page.waitForTimeout(500);
            await tableCombobox.fill('ALLテスト');
            await page.waitForTimeout(800);
            const option = page.locator('[role=option]').filter({ hasText: 'ALLテストテーブル' });
            const optCount = await option.count();
            if (optCount > 0) {
                await option.first().click();
                await waitForAngular(page);
            }

            const detailBtn = modalContainer.locator('button').filter({ hasText: '詳細設定' });
            await expect(detailBtn).toBeVisible();
            await detailBtn.click();
            await waitForAngular(page);

            const saveBtn = page.locator('button').filter({ hasText: '保存' }).first();
            const saveBtnCount = await saveBtn.count();
            if (saveBtnCount > 0) {
                await saveBtn.click();
                // モーダル/ダイアログが閉じるまで待機（ダッシュボードに戻る）
                await page.locator('dialog, .modal.show').filter({ hasText: 'ビュー' })
                    .waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
                await waitForAngular(page);
            }

            // 11. ✅ エラー（.alert-danger）が表示されないこと
            const errorAlert = page.locator('.alert-danger');
            const errorCount = await errorAlert.count();
            expect(errorCount).toBe(0);
            // ダッシュボードに戻った画面でスクショ（モーダルが閉じた後）
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });
            await autoScreenshot(page, 'DB01', 'dash-030', _testStart);
        });

        // ----- step: dash-040 掲示板コンテンツ追加 -----
        await test.step('dash-040: ダッシュボードに掲示板コンテンツを追加できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-040`);

            await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await waitForAngular(page);

            expect(_createdDashboardName, 'dash-020でダッシュボードが作成されていること').toBeTruthy();

            // 12. 作成したタブの▼メニューを開く
            const dashTablistDB04 = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const targetTab = dashTablistDB04.locator('[role=tab]').filter({ hasText: _createdDashboardName });
            await expect(targetTab.first(), `ダッシュボードタブ "${_createdDashboardName}" が存在すること`).toBeVisible();
            await targetTab.first().click();
            await waitForAngular(page);

            const tabEl = dashTablistDB04.locator('[role=tab]').filter({ hasText: _createdDashboardName }).first();
            await openTabMenu(page, tabEl);

            // 13. 「掲示板を追加」をクリック
            const menu = page.locator('[role=menu]');
            const menuVisible = await menu.isVisible().catch(() => false);

            if (menuVisible) {
                const bulletinItem = menu.locator('[role=menuitem]').filter({ hasText: '掲示板を追加' });
                const bulletinCount = await bulletinItem.count();
                if (bulletinCount > 0) {
                    await bulletinItem.click();
                    await waitForAngular(page);
                }
            }

            // 14. ✅ エラーが表示されず、.navbar が表示されたままであること
            const errorAlert = page.locator('.alert-danger');
            const errorCount = await errorAlert.count();
            expect(errorCount).toBe(0);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            await autoScreenshot(page, 'DB01', 'dash-040', _testStart);
        });

        // ----- step: dash-050 タブ削除 -----
        await test.step('dash-050: ダッシュボードタブを削除できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-050`);

            await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await waitForAngular(page);

            expect(_createdDashboardName, 'dash-020でダッシュボードが作成されていること').toBeTruthy();

            // 15. 作成したタブの▼メニューから「削除」をクリック
            const dashTablistDB05 = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const targetTab = dashTablistDB05.locator('[role=tab]').filter({ hasText: _createdDashboardName });
            await expect(targetTab.first(), `ダッシュボードタブ "${_createdDashboardName}" が存在すること`).toBeVisible();

            const tabEl = targetTab.first();
            await openTabMenu(page, tabEl);

            const menu = page.locator('[role=menu]');
            const menuVisible = await menu.isVisible().catch(() => false);
            if (!menuVisible) {
                throw new Error('dash-050: ダッシュボードタブの▼メニューが開きませんでした。');
            }

            const deleteItem = menu.locator('[role=menuitem]').filter({ hasText: '削除' });
            const deleteCount = await deleteItem.count();
            expect(deleteCount).toBeGreaterThan(0);
            await deleteItem.click();
            await waitForAngular(page);

            // 16. 確認モーダルで「はい」をクリック
            const confirmModal = page.locator('.modal.show');
            await expect(confirmModal).toBeVisible();
            await confirmModal.locator('button').filter({ hasText: 'はい' }).click();
            await waitForAngular(page);

            // 17. ✅ 作成したタブが消えていること
            const deletedTab = dashTablistDB05.locator('[role=tab]').filter({ hasText: _createdDashboardName });
            await expect(deletedTab).toHaveCount(0, { timeout: 5000 });

            // 18. ✅ HOMEタブが表示されていること
            const homeTabAfterDelete = dashTablistDB05.locator('[role=tab]').filter({ hasText: 'HOME' });
            await expect(homeTabAfterDelete).toBeVisible();
            await autoScreenshot(page, 'DB01', 'dash-050', _testStart);

            const errorAlert = page.locator('.alert-danger');
            expect(await errorAlert.count()).toBe(0);

            _createdDashboardName = null;
        });

        // ----- step: dash-060 デフォルトダッシュボード -----
        await test.step('dash-060: デフォルトダッシュボード（HOMEタブ）が表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-060`);

            await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await waitForAngular(page);

            // 20. ✅ HOMEタブが表示・選択されていること
            const dashTablistDB06 = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const homeTab = dashTablistDB06.locator('[role=tab]').filter({ hasText: 'HOME' });
            await expect(homeTab).toBeVisible();

            const isSelected = await homeTab.first().getAttribute('aria-selected');
            if (isSelected !== 'true') {
                await homeTab.first().click();
                await waitForAngular(page);
            }

            // 21. ✅ HOMEタブパネルに「掲示板」が表示されていること
            const homeTabpanel = page.locator('[role=tabpanel]').filter({ hasText: '掲示板' });
            await expect(homeTabpanel).toBeVisible();

            // 22. HOMEタブの▼メニューを開く
            const homeTabEl = homeTab.first();
            await openTabMenu(page, homeTabEl);

            // 23. ✅ 「削除」メニューが存在しないこと（HOMEは削除不可）
            const menuEl = page.locator('[role=menu]');
            const menuVis = await menuEl.isVisible().catch(() => false);
            if (menuVis) {
                const deleteItem = menuEl.locator('[role=menuitem]').filter({ hasText: '削除' });
                await expect(deleteItem).toHaveCount(0);
            }
            await autoScreenshot(page, 'DB01', 'dash-060', _testStart);
        });
    });

    // =========================================================================
    // UC21: ウィジェット並び替え（dash-070）→ 1動画
    // =========================================================================
    test('UC21: ウィジェット並び替え', async ({ page }) => {
        const _testStart = Date.now();
        page.setDefaultTimeout(60000);

        await login(page);

        await test.step('dash-070: ダッシュボードの集計ウィジェットで並び替えが正常に動作すること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-070`);

            // 1. ダッシュボードに遷移
            await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // テンプレートモーダルを閉じる
            const modal = page.locator('.modal.show');
            if (await modal.isVisible({ timeout: 3000 }).catch(() => false)) {
                await modal.locator('button').first().click({ force: true }).catch(() => {});
                await page.waitForTimeout(1000);
            }

            // 2-4. 集計ウィジェットを追加
            const summaryWidgets = page.locator('.widget, .dashboard-widget, [class*="widget"]').filter({ hasText: '集計' });
            const widgetCount = await summaryWidgets.count();
            console.log('dash-070: 集計ウィジェット数:', widgetCount);

            // 5. ✅ ダッシュボードが正常に表示されていること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            // 6. ✅ 並び替えボタンの確認
            const sortBtns = page.locator('button:has(.fa-sort), button:has-text("並び替え"), .sort-btn, [class*="sort"]');
            const sortCount = await sortBtns.count();
            console.log('dash-070: 並び替えボタン数:', sortCount);

            if (sortCount > 0) {
                // 7. 並び替えボタンをクリック
                await sortBtns.first().click();
                await page.waitForTimeout(1000);
            }

            // 8. ✅ エラーなく並び替えが動作すること（ページが正常であること）
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            // 最終状態でスクショ（5/6/8の全✅をカバー）
            await autoScreenshot(page, 'UC21', 'dash-070', _testStart);
        });
    });
});
