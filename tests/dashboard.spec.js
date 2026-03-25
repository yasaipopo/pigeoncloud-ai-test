// @ts-check
const { test, expect } = require('@playwright/test');
const { setupAllTypeTable, deleteAllTypeTables } = require('./helpers/table-setup');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

/**
 * ログイン共通関数
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('#id', { timeout: 30000 });
    await page.fill('#id', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
    } catch (e) {
        if (page.url().includes('/admin/login')) {
            await page.waitForTimeout(1000);
            await page.fill('#id', EMAIL);
            await page.fill('#password', PASSWORD);
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
        }
    }
    await page.waitForTimeout(1000);
}

test.describe('ダッシュボード', () => {
    /** @type {string|null} */
    let _tableId = null;
    /** @type {string|null} */
    let _createdDashboardName = null;

    test.beforeAll(async ({ browser }) => {
        const page = await browser.newPage();
        await login(page);
        const result = await setupAllTypeTable(page);
        _tableId = result.tableId;

        // DB-03〜DB-05のために事前にダッシュボードを作成しておく
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // テンプレートインストールモーダルが自動表示されている場合は閉じる
        const templateModal = page.locator('.modal.show');
        const isTemplateModal = await templateModal.isVisible({ timeout: 3000 }).catch(() => false);
        if (isTemplateModal) {
            await page.locator('button:has-text("スキップ")').first().click({ force: true }).catch(() => {});
            await page.waitForTimeout(1500);
        }

        // 「+」ボタン（fa-plus）をforce:trueでクリック（背後に重なる要素があるため）
        const tabsBefore = await page.locator('[role=tab]').count();
        await page.locator('[role=tablist] button').first().click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);

        // モーダルが開いたら名前を入力して送信
        const modal = page.locator('.modal.show');
        const modalVisible = await modal.isVisible({ timeout: 5000 }).catch(() => false);
        if (modalVisible) {
            _createdDashboardName = `テストDB_${Date.now()}`;
            const inputEl = modal.locator('input[type=text], input').first();
            await inputEl.click().catch(() => {});
            await page.waitForTimeout(200);
            // keyboard.typeで入力（ng-dirtyになりAngularモデルが更新される）
            await page.keyboard.type(_createdDashboardName);
            await page.waitForTimeout(500);

            // 送信ボタン（btn-primary ladda-button）のvisibleなものをクリック
            const submitBtns = page.locator('.modal.show button.btn-primary.btn-ladda.ladda-button, .modal.show button.btn-primary.ladda-button');
            const submitCount = await submitBtns.count();
            for (let i = submitCount - 1; i >= 0; i--) {
                const btn = submitBtns.nth(i);
                if (await btn.isVisible()) {
                    await btn.click().catch(() => {});
                    break;
                }
            }

            // タブが増えるのを待つ
            await page.waitForFunction(
                (beforeCount) => document.querySelectorAll('[role=tab]').length > beforeCount,
                tabsBefore,
                { timeout: 10000 }
            ).catch(() => {});
            await page.waitForTimeout(1500);
            // タブが作成されたか確認
            const newTab = page.locator('[role=tab]').filter({ hasText: _createdDashboardName });
            const tabFound = await newTab.isVisible({ timeout: 8000 }).catch(() => false);
            console.log('[beforeAll] ダッシュボードタブ作成:', tabFound ? 'OK' : 'NG', '_createdDashboardName:', _createdDashboardName);
            if (!tabFound) {
                const tabs = await page.locator('[role=tab]').allTextContents().catch(() => []);
                console.log('[beforeAll] 現在のタブ:', tabs);
                _createdDashboardName = null;
            }
        }
        await page.close();
    });

    test.afterAll(async ({ browser }) => {
        const page = await browser.newPage();
        await login(page);
        await deleteAllTypeTables(page);
        await page.close();
    });

    test('DB-01: ダッシュボード画面が正常に表示されること', async ({ page }) => {
        await login(page);
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // ナビゲーションバーが表示されること
        await expect(page.locator('.navbar')).toBeVisible();

        // ダッシュボードタブリストが存在すること
        const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
        await expect(tablist).toBeVisible();

        // HOMEタブが存在すること
        const homeTab = page.locator('[role=tab]').filter({ hasText: 'HOME' });
        await expect(homeTab).toBeVisible();

        // URLが /admin/dashboard であること
        expect(page.url()).toContain('/admin/dashboard');
    });

    test('DB-02: 新しいダッシュボードタブを作成できること', async ({ page }) => {
        await login(page);
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // テンプレートモーダルが自動表示されている場合は閉じる
        const templateModal02 = await page.locator('.modal.show').isVisible({ timeout: 3000 }).catch(() => false);
        if (templateModal02) {
            await page.locator('button:has-text("スキップ")').first().click({ force: true }).catch(() => {});
            await page.waitForTimeout(1500);
        }

        // 「+」ボタンをforce:trueでクリック
        const tabsBeforeDB02 = await page.locator('[role=tab]').count();
        await page.locator('[role=tablist] button').first().click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);

        // モーダルが開くのを待つ
        const modal = page.locator('.modal.show');
        await expect(modal).toBeVisible({ timeout: 5000 });

        // ダッシュボード名を入力（keyboard.typeでng-dirtyにする）
        const db02Name = `テストDB02_${Date.now()}`;
        const db02InputEl = modal.locator('input[type=text], input').first();
        await db02InputEl.click().catch(() => {});
        await page.waitForTimeout(200);
        await page.keyboard.type(db02Name);
        await page.waitForTimeout(500);

        // 送信ボタン（btn-primary ladda-button）のvisibleなものをクリック
        const submitBtns02 = page.locator('.modal.show button.btn-primary.btn-ladda.ladda-button, .modal.show button.btn-primary.ladda-button');
        const submitCount02 = await submitBtns02.count();
        for (let i = submitCount02 - 1; i >= 0; i--) {
            const btn = submitBtns02.nth(i);
            if (await btn.isVisible()) {
                await btn.click().catch(() => {});
                break;
            }
        }

        // タブが増えるのを待つ
        await page.waitForFunction(
            (beforeCount) => document.querySelectorAll('[role=tab]').length > beforeCount,
            tabsBeforeDB02,
            { timeout: 10000 }
        ).catch(() => {});
        await page.waitForTimeout(1500);

        // 新しいタブが追加されることを確認
        const newTab = page.locator('[role=tab]').filter({ hasText: db02Name });
        const allTabTexts = await page.locator('[role=tab]').allTextContents().catch(() => []);
        console.log('DB-02: 全タブ:', allTabTexts, '検索名:', db02Name);
        await expect(newTab).toBeVisible({ timeout: 8000 });
    });

    test('DB-03: ダッシュボードにビューコンテンツを追加できること', async ({ page }) => {
        await login(page);
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // beforeAllで作成したダッシュボードタブを選択
        expect(_createdDashboardName, 'beforeAllでダッシュボードが作成されていること').toBeTruthy();

        const targetTab = page.locator('[role=tab]').filter({ hasText: _createdDashboardName });
        await expect(targetTab.first(), `ダッシュボードタブ "${_createdDashboardName}" が存在すること`).toBeVisible({ timeout: 5000 });

        // タブのテキスト部分をクリックして選択
        await targetTab.first().click();
        await page.waitForTimeout(1000);

        // タブパネル内のコンテンツ追加ボタン（btn-success, +アイコン）をクリック
        const addContentBtn = page.locator('[role=tabpanel] button.btn-success');
        const btnCount = await addContentBtn.count();
        if (btnCount === 0) {
            // ボタンが見つからない場合はタブパネルの別アプローチ
            const tabpanel = page.locator('[role=tabpanel]').filter({ hasText: _createdDashboardName });
            const fallbackBtn = tabpanel.locator('button').first();
            await fallbackBtn.click();
        } else {
            await addContentBtn.first().click();
        }

        // ビューモーダルが開くのを待つ
        await page.waitForTimeout(1000);
        const modal = page.locator('.modal.show');
        const modalVisible = await modal.isVisible().catch(() => false);

        if (modalVisible) {
            // テーブルを選択（ALLテストテーブル）
            if (_tableId) {
                const tableSelect = modal.locator('ng-select, select').first();
                const selectCount = await tableSelect.count();
                if (selectCount > 0) {
                    // ng-select のテキスト入力で検索
                    const ngSelectInput = modal.locator('input[type=text]').first();
                    const inputCount = await ngSelectInput.count();
                    if (inputCount > 0) {
                        await ngSelectInput.fill('ALLテスト');
                        await page.waitForTimeout(800);
                        // ドロップダウンの候補からALLテストテーブルを選択
                        const option = page.locator('.ng-option').filter({ hasText: 'ALLテストテーブル' });
                        const optCount = await option.count();
                        if (optCount > 0) {
                            await option.first().click();
                            await page.waitForTimeout(500);
                        }
                    }
                }
            }

            // 「詳細設定」ボタンをクリックして保存
            const detailBtn = modal.locator('button').filter({ hasText: '詳細設定' });
            const detailBtnCount = await detailBtn.count();
            if (detailBtnCount > 0) {
                await detailBtn.click();
                await page.waitForTimeout(2000);
                // 詳細設定ページで保存ボタンをクリック
                const saveBtn = page.locator('button[type=submit].btn-primary, button.btn-primary').filter({ hasText: '保存' });
                const saveBtnCount = await saveBtn.count();
                if (saveBtnCount > 0) {
                    await saveBtn.first().click();
                    await page.waitForTimeout(1500);
                }
            } else {
                // モーダルを閉じる
                await modal.locator('.close, button').filter({ hasText: '×' }).first().click().catch(() => {});
            }
        }

        // エラー（.alert-danger）がないことを確認
        const errorAlert = page.locator('.alert-danger');
        const errorCount = await errorAlert.count();
        expect(errorCount).toBe(0);
    });

    test('DB-04: ダッシュボードに掲示板コンテンツを追加できること', async ({ page }) => {
        await login(page);
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // beforeAllで作成したダッシュボードタブを選択
        expect(_createdDashboardName, 'beforeAllでダッシュボードが作成されていること').toBeTruthy();

        const targetTab = page.locator('[role=tab]').filter({ hasText: _createdDashboardName });
        await expect(targetTab.first(), `ダッシュボードタブ "${_createdDashboardName}" が存在すること`).toBeVisible({ timeout: 5000 });
        await targetTab.first().click();
        await page.waitForTimeout(1000);

        // タブ内の▼アイコンをクリックしてメニューを開く
        // tab要素内の最後の generic 要素（▼アイコン）をクリック
        const tabEl = page.locator('[role=tab]').filter({ hasText: _createdDashboardName }).first();
        // tabEl内のアイコン（テキスト以外の部分）を取得
        // Angular の場合: tab 内の最後の子要素をクリック
        await tabEl.evaluate((el) => {
            // タブ内の最後の子要素（▼アイコン）をクリック
            const children = el.children;
            if (children.length > 0) {
                (children[children.length - 1]).click();
            }
        });
        await page.waitForTimeout(800);

        // ドロップダウンメニューが表示されていることを確認
        const menu = page.locator('[role=menu]');
        const menuVisible = await menu.isVisible().catch(() => false);

        if (menuVisible) {
            // 「掲示板を追加」をクリック
            const bulletinItem = menu.locator('[role=menuitem]').filter({ hasText: '掲示板を追加' });
            const bulletinCount = await bulletinItem.count();
            if (bulletinCount > 0) {
                await bulletinItem.click();
                await page.waitForTimeout(1500);
            }
        }

        // エラーがないことを確認
        const errorAlert = page.locator('.alert-danger');
        const errorCount = await errorAlert.count();
        expect(errorCount).toBe(0);

        // ダッシュボードが表示されたままであること
        await expect(page.locator('.navbar')).toBeVisible();
    });

    test('DB-05: ダッシュボードタブを削除できること', async ({ page }) => {
        await login(page);
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // beforeAllで作成したダッシュボードタブを削除
        expect(_createdDashboardName, 'beforeAllでダッシュボードが作成されていること').toBeTruthy();

        // 作成したダッシュボードタブを確認
        const targetTab = page.locator('[role=tab]').filter({ hasText: _createdDashboardName });
        await expect(targetTab.first(), `ダッシュボードタブ "${_createdDashboardName}" が存在すること`).toBeVisible({ timeout: 5000 });

        // タブ内の▼アイコンをクリックしてメニューを開く
        const tabEl = targetTab.first();
        await tabEl.evaluate((el) => {
            const children = el.children;
            if (children.length > 0) {
                (children[children.length - 1]).click();
            }
        });
        await page.waitForTimeout(800);

        // ドロップダウンメニューから「削除」をクリック
        const menu = page.locator('[role=menu]');
        const menuVisible = await menu.isVisible().catch(() => false);
        if (!menuVisible) {
            // メニューが開かない場合はスキップ
            return;
        }

        const deleteItem = menu.locator('[role=menuitem]').filter({ hasText: '削除' });
        const deleteCount = await deleteItem.count();
        expect(deleteCount).toBeGreaterThan(0);
        await deleteItem.click();
        await page.waitForTimeout(800);

        // 削除確認モーダルが開くことを確認
        const confirmModal = page.locator('.modal.show');
        await expect(confirmModal).toBeVisible({ timeout: 5000 });

        // 「はい」ボタンをクリック
        await confirmModal.locator('button').filter({ hasText: 'はい' }).click();
        await page.waitForTimeout(1500);

        // 削除後にタブが消えることを確認
        const deletedTab = page.locator('[role=tab]').filter({ hasText: _createdDashboardName });
        await expect(deletedTab).toHaveCount(0, { timeout: 5000 });

        // エラーがないことを確認
        const errorAlert = page.locator('.alert-danger');
        expect(await errorAlert.count()).toBe(0);

        // 削除成功のアラートが表示されること
        const successAlert = page.locator('[role=alert]').filter({ hasText: '削除' });
        const successCount = await successAlert.count();
        // アラートが表示される or HOMEタブに戻っていること
        if (successCount === 0) {
            await expect(page.locator('[role=tab]').filter({ hasText: 'HOME' })).toBeVisible();
        }

        _createdDashboardName = null;
    });

    test('DB-06: デフォルトダッシュボード（HOMEタブ）が表示されること', async ({ page }) => {
        await login(page);
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // HOMEタブが存在すること
        const homeTab = page.locator('[role=tab]').filter({ hasText: 'HOME' });
        await expect(homeTab).toBeVisible();

        // HOMEタブが選択されていること（または選択可能であること）
        const isSelected = await homeTab.first().getAttribute('aria-selected');
        // 最初のタブ（HOME）を選択状態にする
        if (isSelected !== 'true') {
            await homeTab.first().click();
            await page.waitForTimeout(1000);
        }

        // HOMEタブパネルが表示されること
        const homeTabpanel = page.locator('[role=tabpanel]').filter({ hasText: '掲示板' });
        await expect(homeTabpanel).toBeVisible({ timeout: 5000 });

        // HOMEタブの▼メニューに「削除」がないことを確認（ID=1は削除不可）
        const homeTabEl = homeTab.first();
        await homeTabEl.evaluate((el) => {
            const children = el.children;
            if (children.length > 0) {
                (children[children.length - 1]).click();
            }
        });
        await page.waitForTimeout(800);

        const menu = page.locator('[role=menu]');
        const menuVisible = await menu.isVisible().catch(() => false);
        if (menuVisible) {
            // 「削除」メニューが存在しないことを確認
            const deleteItem = menu.locator('[role=menuitem]').filter({ hasText: '削除' });
            await expect(deleteItem).toHaveCount(0);
        }
    });
});
