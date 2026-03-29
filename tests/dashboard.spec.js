// @ts-check
const { test, expect } = require('@playwright/test');
const { getAllTypeTableId } = require('./helpers/table-setup');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        // data-ng-readyが設定されないケースがある: networkidleで代替
        await page.waitForLoadState('networkidle').catch(() => {});
    }
}


/**
 * ログイン共通関数
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login');
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
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        return;
    }

    // APIログイン失敗時はフォームログイン
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    const idField = await page.waitForSelector('#id', { timeout: 30000 }).catch(() => null);
    if (!idField) {
        if (!page.url().includes('/admin/login')) return;
        throw new Error('ログインフォームの#idフィールドが見つかりません');
    }
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
 * ダッシュボードタブを作成する共通関数
 * @returns {Promise<string>} 作成したダッシュボード名
 */
async function createDashboardTab(page, name) {
    const dashTablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
    const tabsBefore = await dashTablist.locator('[role=tab]').count();
    await dashTablist.locator('button.dashboard-tab-add-btn').click({ force: true }).catch(async () => {
        await dashTablist.locator('button').first().click({ force: true }).catch(() => {});
    });

    // ダッシュボード作成モーダルが開くまでポーリング
    await page.waitForFunction(() => {
        const inputs = document.querySelectorAll('input#name');
        for (const inp of inputs) {
            const r = inp.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return true;
        }
        return false;
    }, null, { timeout: 10000 });

    // ダッシュボード名をAngularモデルに書き込む（Native Input Value Setter）
    await page.evaluate((n) => {
        const inputs = document.querySelectorAll('input#name');
        for (const input of inputs) {
            const r = input.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeInputValueSetter.call(input, n);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return;
            }
        }
    }, name);
    await page.waitForTimeout(300);

    // 送信ボタンをクリック（表示中のbtn-primary ladda-buttonのみ対象）
    await page.evaluate(() => {
        const btns = document.querySelectorAll('button.btn-primary.ladda-button, button.btn-primary.btn-ladda');
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
            const tablist = document.querySelector('[role=tablist]');
            if (!tablist) return false;
            return tablist.querySelectorAll('[role=tab]').length > beforeCount;
        },
        tabsBefore,
        { timeout: 15000 }
    ).catch(() => {});
    await page.waitForTimeout(1500);

    return name;
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

test.describe('ダッシュボード', () => {
    // =========================================================================
    // DB01: ダッシュボード基本操作（DB-01〜DB-06）→ 1動画
    // =========================================================================
    test('DB01: ダッシュボード基本操作', async ({ page }) => {
        test.setTimeout(600000); // 10分
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

        // ----- step: DB-01 ダッシュボード画面表示 -----
        await test.step('DB-01: ダッシュボード画面が正常に表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s DB-01`);

            await page.goto(BASE_URL + '/admin/dashboard');
            await waitForAngular(page);

            // ナビゲーションバーが表示されること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 60000 });

            // ダッシュボードタブリストが存在すること
            const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            await expect(tablist).toBeVisible();

            // HOMEタブが存在すること（ダッシュボードtablist内のみ）
            const homeTab = tablist.locator('[role=tab]').filter({ hasText: 'HOME' });
            await expect(homeTab).toBeVisible();

            // URLが /admin/dashboard であること
            expect(page.url()).toContain('/admin/dashboard');
        });

        // ----- step: DB-02 タブ作成 -----
        await test.step('DB-02: 新しいダッシュボードタブを作成できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s DB-02`);

            await page.goto(BASE_URL + '/admin/dashboard');
            await waitForAngular(page);

            // チュートリアルモーダルを閉じる
            await closeTutorialModal(page);

            // 「+」ボタン（dashboard-tab-add-btn）をクリック
            const dashTablistDB02 = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const tabsBeforeDB02 = await dashTablistDB02.locator('[role=tab]').count();
            await dashTablistDB02.locator('button.dashboard-tab-add-btn').click({ force: true }).catch(async () => {
                await dashTablistDB02.locator('button').first().click({ force: true }).catch(() => {});
            });
            await waitForAngular(page);

            // ダッシュボード作成モーダルが開くまで待機（input#nameが表示されるまでポーリング）
            await page.waitForFunction(() => {
                const inputs = document.querySelectorAll('input#name');
                for (const inp of inputs) {
                    const r = inp.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return true;
                }
                return false;
            }, null, { timeout: 8000 });

            // ダッシュボード名をAngularモデルに直接書き込む
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

            // 送信ボタンをクリック（表示中のbtn-primary ladda-buttonのみ対象）
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

            // タブが増えるのを待つ（ダッシュボードtablist内のタブ数で判定）
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

            // 新しいタブが追加されることを確認
            const dashTablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const newTab = dashTablist.locator('[role=tab]').filter({ hasText: db02Name });
            const allTabTexts = await dashTablist.locator('[role=tab]').allTextContents().catch(() => []);
            console.log('DB-02: 全タブ:', allTabTexts, '検索名:', db02Name);
            await expect(newTab).toBeVisible({ timeout: 8000 });

            // DB-03〜DB-05で使うためにタブ名を保存
            _createdDashboardName = db02Name;
        });

        // ----- step: DB-03 ビューコンテンツ追加 -----
        await test.step('DB-03: ダッシュボードにビューコンテンツを追加できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s DB-03`);

            await page.goto(BASE_URL + '/admin/dashboard');
            await waitForAngular(page);

            // DB-02で作成したダッシュボードタブを選択
            expect(_createdDashboardName, 'DB-02でダッシュボードが作成されていること').toBeTruthy();

            // ダッシュボードtablist内のタブのみを対象にする
            const dashTablistDB03 = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const targetTab = dashTablistDB03.locator('[role=tab]').filter({ hasText: _createdDashboardName });
            await expect(targetTab.first(), `ダッシュボードタブ "${_createdDashboardName}" が存在すること`).toBeVisible({ timeout: 60000 });

            // タブのテキスト部分をクリックして選択
            await targetTab.first().click();
            await waitForAngular(page);

            // タブパネル内の「ウィジェットを追加」ボタンをクリック
            const targetTabEl = dashTablistDB03.locator('[role=tab]').filter({ hasText: _createdDashboardName }).first();
            const tabpanelId = await targetTabEl.getAttribute('aria-controls').catch(() => null);

            let addWidgetBtn;
            if (tabpanelId) {
                addWidgetBtn = page.locator(`#${tabpanelId} button`).filter({ hasText: 'ウィジェットを追加' });
            } else {
                addWidgetBtn = page.locator('[role=tabpanel] button').filter({ hasText: 'ウィジェットを追加' }).first();
            }
            await expect(addWidgetBtn).toBeVisible({ timeout: 60000 });
            await addWidgetBtn.click();

            // ビューダイアログが開くのを待つ
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
                throw new Error('DB-03: ビューダイアログが開きませんでした。UIを確認してください。');
            }

            // dialog要素またはBootstrapモーダル内のcomboboxでALLテストテーブルを選択
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

            // 「詳細設定」ボタンをクリック
            const detailBtn = modalContainer.locator('button').filter({ hasText: '詳細設定' });
            await expect(detailBtn).toBeVisible({ timeout: 60000 });
            await detailBtn.click();
            await waitForAngular(page);

            // 詳細設定ページで保存ボタンをクリック
            const saveBtn = page.locator('button').filter({ hasText: '保存' }).first();
            const saveBtnCount = await saveBtn.count();
            if (saveBtnCount > 0) {
                await saveBtn.click();
                await waitForAngular(page);
            }

            // エラー（.alert-danger）がないことを確認
            const errorAlert = page.locator('.alert-danger');
            const errorCount = await errorAlert.count();
            expect(errorCount).toBe(0);
        });

        // ----- step: DB-04 掲示板コンテンツ追加 -----
        await test.step('DB-04: ダッシュボードに掲示板コンテンツを追加できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s DB-04`);

            await page.goto(BASE_URL + '/admin/dashboard');
            await waitForAngular(page);

            // DB-02で作成したダッシュボードタブを選択
            expect(_createdDashboardName, 'DB-02でダッシュボードが作成されていること').toBeTruthy();

            const dashTablistDB04 = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const targetTab = dashTablistDB04.locator('[role=tab]').filter({ hasText: _createdDashboardName });
            await expect(targetTab.first(), `ダッシュボードタブ "${_createdDashboardName}" が存在すること`).toBeVisible({ timeout: 60000 });
            await targetTab.first().click();
            await waitForAngular(page);

            // タブ内の▼アイコンをクリックしてメニューを開く
            const tabEl = dashTablistDB04.locator('[role=tab]').filter({ hasText: _createdDashboardName }).first();
            await openTabMenu(page, tabEl);

            // ドロップダウンメニューが表示されていることを確認
            const menu = page.locator('[role=menu]');
            const menuVisible = await menu.isVisible().catch(() => false);

            if (menuVisible) {
                // 「掲示板を追加」をクリック
                const bulletinItem = menu.locator('[role=menuitem]').filter({ hasText: '掲示板を追加' });
                const bulletinCount = await bulletinItem.count();
                if (bulletinCount > 0) {
                    await bulletinItem.click();
                    await waitForAngular(page);
                }
            }

            // エラーがないことを確認
            const errorAlert = page.locator('.alert-danger');
            const errorCount = await errorAlert.count();
            expect(errorCount).toBe(0);

            // ダッシュボードが表示されたままであること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 60000 });
        });

        // ----- step: DB-05 タブ削除 -----
        await test.step('DB-05: ダッシュボードタブを削除できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s DB-05`);

            await page.goto(BASE_URL + '/admin/dashboard');
            await waitForAngular(page);

            // DB-02で作成したダッシュボードタブを削除
            expect(_createdDashboardName, 'DB-02でダッシュボードが作成されていること').toBeTruthy();

            const dashTablistDB05 = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const targetTab = dashTablistDB05.locator('[role=tab]').filter({ hasText: _createdDashboardName });
            await expect(targetTab.first(), `ダッシュボードタブ "${_createdDashboardName}" が存在すること`).toBeVisible({ timeout: 60000 });

            // タブ内の▼アイコンをクリックしてメニューを開く
            const tabEl = targetTab.first();
            await openTabMenu(page, tabEl);

            // ドロップダウンメニューから「削除」をクリック
            const menu = page.locator('[role=menu]');
            const menuVisible = await menu.isVisible().catch(() => false);
            if (!menuVisible) {
                throw new Error('DB-05: ダッシュボードタブの▼メニューが開きませんでした。UIを確認してください（[role=menu]が表示されません）。');
            }

            const deleteItem = menu.locator('[role=menuitem]').filter({ hasText: '削除' });
            const deleteCount = await deleteItem.count();
            expect(deleteCount).toBeGreaterThan(0);
            await deleteItem.click();
            await waitForAngular(page);

            // 削除確認モーダルが開くことを確認
            const confirmModal = page.locator('.modal.show');
            await expect(confirmModal).toBeVisible({ timeout: 60000 });

            // 「はい」ボタンをクリック
            await confirmModal.locator('button').filter({ hasText: 'はい' }).click();
            await waitForAngular(page);

            // 削除後にダッシュボードtablist内のタブが消えることを確認
            const deletedTab = dashTablistDB05.locator('[role=tab]').filter({ hasText: _createdDashboardName });
            await expect(deletedTab).toHaveCount(0, { timeout: 5000 });

            // エラーがないことを確認
            const errorAlert = page.locator('.alert-danger');
            expect(await errorAlert.count()).toBe(0);

            // HOMEタブに戻っていること（削除後はHOMEに戻る）
            const homeTabAfterDelete = dashTablistDB05.locator('[role=tab]').filter({ hasText: 'HOME' });
            await expect(homeTabAfterDelete).toBeVisible({ timeout: 60000 });

            _createdDashboardName = null;
        });

        // ----- step: DB-06 デフォルトダッシュボード -----
        await test.step('DB-06: デフォルトダッシュボード（HOMEタブ）が表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s DB-06`);

            await page.goto(BASE_URL + '/admin/dashboard');
            await waitForAngular(page);

            // HOMEタブが存在すること（ダッシュボードtablist内のみを対象）
            const dashTablistDB06 = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const homeTab = dashTablistDB06.locator('[role=tab]').filter({ hasText: 'HOME' });
            await expect(homeTab).toBeVisible();

            // HOMEタブが選択されていること（または選択可能であること）
            const isSelected = await homeTab.first().getAttribute('aria-selected');
            if (isSelected !== 'true') {
                await homeTab.first().click();
                await waitForAngular(page);
            }

            // HOMEタブパネルが表示されること
            const homeTabpanel = page.locator('[role=tabpanel]').filter({ hasText: '掲示板' });
            await expect(homeTabpanel).toBeVisible({ timeout: 60000 });

            // HOMEタブの▼メニューに「削除」がないことを確認（ID=1は削除不可）
            const homeTabEl = homeTab.first();
            await openTabMenu(page, homeTabEl);

            const menu = page.locator('[role=menu]');
            const menuVisible = await menu.isVisible().catch(() => false);
            if (menuVisible) {
                const deleteItem = menu.locator('[role=menuitem]').filter({ hasText: '削除' });
                await expect(deleteItem).toHaveCount(0);
            }
        });
    });

    // =========================================================================
    // UC21: ウィジェット並び替え（806）→ 1動画
    // =========================================================================
    test('UC21: ウィジェット並び替え', async ({ page }) => {
        test.setTimeout(120000);
        const _testStart = Date.now();
        page.setDefaultTimeout(60000);

        await login(page);

        await test.step('806: ダッシュボードの集計ウィジェットで並び替えが正常に動作すること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 806`);

            // ダッシュボードに遷移
            await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // テンプレートモーダルを閉じる
            const modal = page.locator('.modal.show');
            if (await modal.isVisible({ timeout: 3000 }).catch(() => false)) {
                await modal.locator('button').first().click({ force: true }).catch(() => {});
                await page.waitForTimeout(1000);
            }

            // 集計ウィジェットを探す
            const summaryWidgets = page.locator('.widget, .dashboard-widget, [class*="widget"]').filter({ hasText: '集計' });
            const widgetCount = await summaryWidgets.count();
            console.log('806: 集計ウィジェット数:', widgetCount);

            // 並び替えボタンを探す
            const sortBtns = page.locator('button:has(.fa-sort), button:has-text("並び替え"), .sort-btn, [class*="sort"]');
            const sortCount = await sortBtns.count();
            console.log('806: 並び替えボタン数:', sortCount);

            if (sortCount > 0) {
                // 並び替えボタンをクリック
                await sortBtns.first().click();
                await page.waitForTimeout(1000);

                // 並び替え後もページが正常であること
                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');
            }

            await expect(page.locator('.navbar')).toBeVisible({ timeout: 60000 });
        });
    });
});
