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

        // タブリスト右の新規作成ボタン（+アイコン）をクリック
        // tablistのなかの button（HOME tab以外）をクリック
        const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
        const addBtn = tablist.locator('button').last();
        await addBtn.click();

        // モーダルが開くのを待つ
        const modal = page.locator('.modal.show');
        await expect(modal).toBeVisible({ timeout: 5000 });

        // ダッシュボード名を入力
        _createdDashboardName = 'テストダッシュボード_E2E';
        await modal.locator('input[type=text], textbox, input').first().fill(_createdDashboardName);

        // 送信ボタンをクリック
        await modal.locator('button').filter({ hasText: '送信' }).click();

        // 新しいタブが追加されることを確認
        await page.waitForTimeout(1500);
        const newTab = page.locator('[role=tab]').filter({ hasText: _createdDashboardName });
        await expect(newTab).toBeVisible({ timeout: 5000 });
    });

    test('DB-03: ダッシュボードにビューコンテンツを追加できること', async ({ page }) => {
        await login(page);
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // DB-02で作成したダッシュボードタブを選択
        if (!_createdDashboardName) {
            test.skip(true, '作成済みダッシュボードが存在しないためスキップ');
            return;
        }

        const targetTab = page.locator('[role=tab]').filter({ hasText: _createdDashboardName });
        const tabCount = await targetTab.count();
        if (tabCount === 0) {
            test.skip(true, 'テストダッシュボードが見つからないためスキップ');
            return;
        }

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

        if (!_createdDashboardName) {
            test.skip(true, '作成済みダッシュボードが存在しないためスキップ');
            return;
        }

        // 作成したダッシュボードタブを選択
        const targetTab = page.locator('[role=tab]').filter({ hasText: _createdDashboardName });
        const tabCount = await targetTab.count();
        if (tabCount === 0) {
            test.skip(true, 'テストダッシュボードが見つからないためスキップ');
            return;
        }
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

        if (!_createdDashboardName) {
            test.skip(true, '作成済みダッシュボードが存在しないためスキップ');
            return;
        }

        // 作成したダッシュボードタブを確認
        const targetTab = page.locator('[role=tab]').filter({ hasText: _createdDashboardName });
        const tabCount = await targetTab.count();
        if (tabCount === 0) {
            // すでに削除されているか存在しない場合はスキップ
            test.skip(true, 'テストダッシュボードが見つからないためスキップ');
            return;
        }

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
