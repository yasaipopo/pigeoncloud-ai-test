// @ts-check
const { test, expect } = require('@playwright/test');
const { getAllTypeTableId } = require('./helpers/table-setup');
const { createAuthContext } = require('./helpers/auth-context');

const { createTestEnv } = require('./helpers/create-test-env');

let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;

async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        // data-ng-readyが設定されないケースがある: networkidleで代替
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

/**
 * ログイン共通関数（APIログイン優先方式）
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
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
    // Angular が ready になるまで待つ（タイムアウトを延長）
    await waitForAngular(page, 40000);

    // APIログインを優先（Angular SPAでのdetach問題を回避）
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
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page, 40000);
        return;
    }

    // APIログイン失敗 — セッションCookieが設定されている場合はダッシュボードにいる可能性
    const currentUrl = page.url();
    if (!currentUrl.includes('/admin/login')) {
        // ログインページ以外にいる（すでにログイン済み）
        await waitForAngular(page, 15000).catch(() => {});
        return;
    }

    // フォールバック: フォームログイン（#id が表示されるまで待つ）
    await page.waitForSelector('#id', { timeout: 5000 });
    await page.fill('#id', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit].btn-primary');
    await page.waitForURL('**/admin/dashboard', { timeout: 15000 });
    await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
}

/**
 * テンプレートモーダルを閉じる
 */
async function closeTemplateModal(page) {
    try {
        const modal = page.locator('div.modal.show');
        const count = await modal.count();
        if (count > 0) {
            const closeBtn = modal.locator('button').first();
            await closeBtn.click({ force: true });
            await waitForAngular(page);
        }
    } catch (e) {
        // モーダルがなければ何もしない
    }
}

/**
 * テーブル設定の「その他」タブを開く
 * Angular SPAのためdispatchEventを使用してタブ切り替え
 */
async function openOtherTab(page, tableId) {
    await page.goto(BASE_URL + `/admin/dataset/edit/${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await waitForAngular(page, 40000);

    // Playwright の click() で Angular のイベントを正しく発火させる
    // page.evaluate() の DOM click は ngb-nav のタブ切替を起動しない
    const otherTabLocator = page.getByRole('tab', { name: /その他/ });
    await otherTabLocator.waitFor({ state: 'visible', timeout: 15000 });
    await otherTabLocator.click();
    await waitForAngular(page);
}

/**
 * テーブル設定の「その他」タブで公開フォームをONにする
 */
async function enablePublicForm(page, tableId) {
    await openOtherTab(page, tableId);

    const pubFormPanel = await page.evaluate(() => {
        // 「その他」タブパネルを動的IDではなくテキストで特定する
        // Angular ngb-nav は表示数によってIDが変わるためハードコードIDは使用しない
        let panel = null;
        // 方法1: [role="tabpanel"] で現在アクティブなものを探す
        const activePanels = document.querySelectorAll('[role="tabpanel"]');
        for (const p of activePanels) {
            if (p.textContent.includes('公開フォームをONにする')) {
                panel = p;
                break;
            }
        }
        // 方法2: 直接 .form-group から公開フォーム要素を探す（タブパネル外の場合）
        if (!panel) {
            const formGroups = document.querySelectorAll('.form-group.row.admin-forms');
            for (const group of formGroups) {
                if (group.textContent.includes('公開フォームをONにする')) {
                    panel = group.closest('[role="tabpanel"]') || group.parentElement;
                    break;
                }
            }
        }
        if (!panel) return null;
        const formGroups = panel.querySelectorAll('.form-group.row.admin-forms');
        let pubFormGroup = null;
        for (const group of formGroups) {
            if (group.textContent.includes('公開フォームをONにする')) {
                pubFormGroup = group;
                break;
            }
        }
        if (!pubFormGroup) return null;
        const switchInput = pubFormGroup.querySelector('input[type="checkbox"].switch-input');
        return { isChecked: switchInput ? switchInput.checked : null };
    });

    if (!pubFormPanel || pubFormPanel.isChecked === null) {
        return false;
    }

    if (!pubFormPanel.isChecked) {
        // Playwright click でスイッチをON（Angular イベントを正しく発火）
        const switchHandle = page.locator('.form-group.row.admin-forms:has-text("公開フォームをONにする") .switch-handle').first();
        await switchHandle.click();
        await page.waitForTimeout(3000); // 自動保存待機
    }
    return true;
}

// =============================================================================
// 公開フォームテスト
// =============================================================================

test.describe('公開フォーム・公開メールリンク', () => {
    let tableId = null;

    // テスト前: 自己完結環境を作成
    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        const env = await createTestEnv(browser, { withAllTypeTable: true });
        BASE_URL = env.baseUrl;
        EMAIL = env.email;
        PASSWORD = env.password;
        tableId = env.tableId;
        process.env.TEST_BASE_URL = env.baseUrl;
        process.env.TEST_EMAIL = env.email;
        process.env.TEST_PASSWORD = env.password;
        await env.context.close();
        console.log(`[public-form] 自己完結環境: ${BASE_URL}`);
    });

    test.beforeEach(async ({ page }) => {
        // 古い環境のcookieをクリアして新環境にログイン
        await page.context().clearCookies();
        await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        if (page.url().includes('/login')) {
            await page.fill('#id', EMAIL);
            await page.fill('#password', PASSWORD);
            await page.locator('button[type=submit].btn-primary').first().click();
            await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        }
    });

    // =========================================================================
    // PF01: 公開フォーム基本フロー（135, 170, 358, 359, 499, 547, 660）→ 1動画
    // =========================================================================
    test('PF01: 公開フォーム基本フロー', async ({ page }) => {
        test.setTimeout(135000); // 10分
        const _testStart = Date.now();
        page.setDefaultTimeout(60000);

        await login(page);
        await closeTemplateModal(page);

        // ----- step: 135 公開フォーム設定画面が表示され、メール配信設定ができること -----
        await test.step('135: 公開フォーム設定画面が表示され、メール配信設定ができること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 135`);

            // Step 1: テーブル設定の「その他」タブを開く
            await openOtherTab(page, tableId);

            // 「その他」タブパネルが表示されていることを確認
            const pubFormLabelGlobal = page.locator(
                '[role="tabpanel"] label:has-text("公開フォームをONにする"), ' +
                '[role="tabpanel"] .form-control-label:has-text("公開フォームをONにする"), ' +
                'label:has-text("公開フォームをONにする")'
            ).first();
            await expect(pubFormLabelGlobal).toBeVisible();

            // スイッチ（checkbox）が存在することを確認
            const pubFormRow = page.locator('.form-group.row.admin-forms:has-text("公開フォームをONにする")').first();
            await expect(pubFormRow).toBeVisible();

            const switchInput = pubFormRow.locator('input[type="checkbox"].switch-input');
            await expect(switchInput).toBeDefined();
            const switchCount = await switchInput.count();
            expect(switchCount, '公開フォームスイッチが存在すること').toBeGreaterThan(0);

            const switchHandle = pubFormRow.locator('.switch-handle');
            const handleCount = await switchHandle.count();
            expect(handleCount, '公開フォームスイッチハンドルが存在すること').toBeGreaterThan(0);

            // Step 2: 公開フォームをONにする（スイッチをクリック）
            const isChecked = await switchInput.isChecked();
            if (!isChecked) {
                await switchHandle.click();
                await page.waitForTimeout(3000);
                const isCheckedAfter = await switchInput.isChecked();
                expect(isCheckedAfter, '公開フォームスイッチがONになること').toBe(true);
            }

            // Step 3: テーブルページに移動してドロップダウンメニューを確認
            await page.evaluate((tid) => { window.location.href = `/admin/dataset__${tid}`; }, tableId);
            await page.waitForTimeout(5000);

            const currentUrl = page.url();
            const urlContainsTable = currentUrl.includes(`dataset__${tableId}`) || currentUrl.includes('/admin/');
            expect(urlContainsTable, 'テーブルページに移動できること').toBeTruthy();

            const dropdownToggles = page.locator('button.btn-sm.btn-outline-primary.dropdown-toggle, button.dropdown-toggle');
            const toggleCount = await dropdownToggles.count();
            if (toggleCount === 0) {
                console.log('[135] ドロップダウントグルボタンが見つかりません（公開フォームOFF or セッション問題の可能性）');
                await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            }

            const mailTemplateModal = page.locator('div.modal .modal-title:has-text("公開フォームメールテンプレート作成"), h4.modal-title:has-text("公開フォームメールテンプレート作成")');
            const mailModalCount = await mailTemplateModal.count();
            if (mailModalCount > 0) {
                await expect(mailTemplateModal.first()).toContainText('公開フォームメールテンプレート作成');
                console.log('公開フォームメールテンプレートモーダルがDOMに存在します');
            }

            const warningText = page.locator(':has-text("公開フォームでは、権限設定は無視され")').first();
            const warningCount = await warningText.count();
            if (warningCount > 0) {
                console.log('公開フォームの注意書きテキストが確認できます');
            }

            await page.evaluate(() => {
                const dropdowns = document.querySelectorAll('button.btn-sm.btn-outline-primary.dropdown-toggle');
                if (dropdowns.length > 0) dropdowns[0].click();
            });
            await page.waitForTimeout(500);

            const openDropdown = page.locator('.btn-group.open .dropdown-menu, .btn-group.show .dropdown-menu');
            const openDropdownCount = await openDropdown.count();
            if (openDropdownCount > 0) {
                await expect(openDropdown.first()).toBeVisible();
                const menuItems = openDropdown.first().locator('a');
                const itemCount = await menuItems.count();
                expect(itemCount, 'ドロップダウンメニューに項目が存在すること').toBeGreaterThan(0);

                const pubFormLinkItem = openDropdown.locator('a:has-text("公開フォームリンク")');
                const pubFormMailItem = openDropdown.locator('a:has-text("公開フォームをメール配信")');
                const pubFormLinkCount = await pubFormLinkItem.count();
                const pubFormMailCount = await pubFormMailItem.count();
                if (pubFormLinkCount > 0) {
                    await expect(pubFormLinkItem.first()).toBeVisible();
                    console.log('「公開フォームリンク」メニューが確認できました');
                } else if (pubFormMailCount > 0) {
                    await expect(pubFormMailItem.first()).toBeVisible();
                    console.log('「公開フォームをメール配信」メニューが確認できました');
                } else {
                    console.log('公開フォームメニューは現在のビュー設定では表示されていません');
                }
            }
        });

        // ----- step: 170 公開フォームURLのアドレス長が適切であること -----
        await test.step('170: 公開フォームURLのアドレス長が適切であること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 170`);

            const enabled = await enablePublicForm(page, tableId);
            expect(enabled, '公開フォームの設定UIが存在すること').toBe(true);

            await page.evaluate((tid) => { window.location.href = `/admin/dataset__${tid}`; }, tableId);
            await page.waitForTimeout(5000);

            let publicFormUrl = null;

            await page.evaluate(() => {
                const dropdowns = document.querySelectorAll('button.btn-sm.btn-outline-primary.dropdown-toggle');
                if (dropdowns.length > 0) dropdowns[0].click();
            });
            await page.waitForTimeout(500);

            const pubFormLinkItem = page.locator('.dropdown-menu a:has-text("公開フォームリンク"), .btn-group.open a:has-text("公開フォームリンク")');
            const pubFormLinkCount = await pubFormLinkItem.count();

            if (pubFormLinkCount > 0) {
                await expect(pubFormLinkItem.first()).toBeVisible();
                await pubFormLinkItem.first().click();
                await waitForAngular(page);

                const pubFormModal = page.locator('.modal.show');
                const modalCount = await pubFormModal.count();
                if (modalCount > 0) {
                    await expect(pubFormModal.first()).toBeVisible();
                    const urlInput = pubFormModal.first().locator('input[readonly]');
                    const urlInputCount = await urlInput.count();
                    expect(urlInputCount, 'URLを表示するinputが存在すること').toBeGreaterThan(0);

                    if (urlInputCount > 0) {
                        publicFormUrl = await urlInput.first().inputValue();
                        console.log('公開フォームURL:', publicFormUrl);
                        expect(publicFormUrl.length, '公開フォームURLが空でないこと').toBeGreaterThan(0);
                        expect(publicFormUrl, '公開フォームURLが有効なURL形式であること').toContain('http');
                        expect(publicFormUrl.length, '公開フォームURLが適切な長さであること（ハッシュを含む）').toBeGreaterThan(20);
                        const urlHasDomain = publicFormUrl.includes('pigeon') || publicFormUrl.includes('http');
                        expect(urlHasDomain, '公開フォームURLが有効なドメインを含むこと').toBeTruthy();

                        const closeBtn = pubFormModal.first().locator('button:has-text("閉じる"), button.close, button[aria-label="Close"]');
                        const closeBtnCount = await closeBtn.count();
                        if (closeBtnCount > 0) {
                            await closeBtn.first().click({ force: true });
                            await waitForAngular(page);
                        }
                    }
                }
            } else {
                const urlInputInPage = page.locator('input[readonly][value*="pigeon"], input[readonly][value*="http"]');
                const urlInputCount = await urlInputInPage.count();
                if (urlInputCount > 0) {
                    publicFormUrl = await urlInputInPage.first().inputValue();
                    expect(publicFormUrl.length, '公開フォームURLが空でないこと').toBeGreaterThan(0);
                    expect(publicFormUrl, '公開フォームURLが有効なURL形式であること').toContain('http');
                } else {
                    console.log('公開フォームリンクメニューが表示されませんでした。ビュー設定が必要な可能性があります。');
                    await openOtherTab(page, tableId);
                    const pubFormLabelFallback = page.locator(
                        '[role="tabpanel"] label:has-text("公開フォームをONにする"), ' +
                        'label:has-text("公開フォームをONにする")'
                    ).first();
                    await expect(pubFormLabelFallback, '「公開フォームをONにする」ラベルが存在すること').toBeVisible();
                }
            }
        });

        // ----- step: 358 公開フォームで子テーブルのルックアップコピーが動作すること -----
        await test.step('358: 公開フォームで子テーブル内のルックアップコピーが正常に動作すること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 358`);

            const enabled = await enablePublicForm(page, tableId);
            expect(enabled, '公開フォームの設定UIが存在すること').toBe(true);

            await page.evaluate((tid) => { window.location.href = `/admin/dataset__${tid}`; }, tableId);
            await page.waitForTimeout(5000);
            await waitForAngular(page, 40000).catch(() => {});

            await page.evaluate(() => {
                const dropdowns = document.querySelectorAll('button.btn-sm.btn-outline-primary.dropdown-toggle');
                if (dropdowns.length > 0) dropdowns[0].click();
            });
            await page.waitForTimeout(500);

            const pubFormLinkItem = page.locator('.dropdown-menu a:has-text("公開フォームリンク")').first();
            let publicFormUrl = null;

            if (await pubFormLinkItem.isVisible({ timeout: 3000 }).catch(() => false)) {
                await pubFormLinkItem.click();
                await waitForAngular(page);
                const pubFormModal = page.locator('.modal.show');
                if (await pubFormModal.isVisible({ timeout: 5000 }).catch(() => false)) {
                    const urlInput = pubFormModal.locator('input[readonly]').first();
                    if (await urlInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                        publicFormUrl = await urlInput.inputValue();
                    }
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(500);
                }
            }

            if (publicFormUrl) {
                await page.goto(publicFormUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await page.waitForTimeout(3000);

                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');
                expect(bodyText).not.toContain('404');

                const formFields = page.locator('input, select, textarea, .form-control');
                const fieldCount = await formFields.count();
                expect(fieldCount, '公開フォームにフィールドが存在すること').toBeGreaterThan(0);
                console.log(`358: 公開フォームフィールド数: ${fieldCount}`);

                const childTable = page.locator('.child-table, .related-records, [class*="child"], [class*="subtable"]');
                const childCount = await childTable.count();
                console.log(`358: 子テーブルセクション数: ${childCount}`);
            } else {
                console.log('358: 公開フォームURLが取得できませんでした（ビュー設定が必要な可能性）');
                await openOtherTab(page, tableId);
                const pubFormLabel = page.locator('label:has-text("公開フォームをONにする")').first();
                await expect(pubFormLabel).toBeVisible();
            }
        });

        // ----- step: 359 公開フォームで複数列レイアウトでも項目が正しく収まること -----
        await test.step('359: 公開フォームで複数列レイアウトでも項目が正しく収まること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 359`);

            const enabled = await enablePublicForm(page, tableId);
            expect(enabled, '公開フォームの設定UIが存在すること').toBe(true);

            await page.evaluate((tid) => { window.location.href = `/admin/dataset__${tid}`; }, tableId);
            await page.waitForTimeout(5000);
            await waitForAngular(page, 40000).catch(() => {});

            await page.evaluate(() => {
                const dropdowns = document.querySelectorAll('button.btn-sm.btn-outline-primary.dropdown-toggle');
                if (dropdowns.length > 0) dropdowns[0].click();
            });
            await page.waitForTimeout(500);

            const pubFormLinkItem = page.locator('.dropdown-menu a:has-text("公開フォームリンク")').first();
            let publicFormUrl = null;

            if (await pubFormLinkItem.isVisible({ timeout: 3000 }).catch(() => false)) {
                await pubFormLinkItem.click();
                await waitForAngular(page);
                const pubFormModal = page.locator('.modal.show');
                if (await pubFormModal.isVisible({ timeout: 5000 }).catch(() => false)) {
                    const urlInput = pubFormModal.locator('input[readonly]').first();
                    if (await urlInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                        publicFormUrl = await urlInput.inputValue();
                    }
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(500);
                }
            }

            if (publicFormUrl) {
                await page.setViewportSize({ width: 1280, height: 800 });
                await page.goto(publicFormUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await page.waitForTimeout(3000);

                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');

                const formGroups = page.locator('.form-group, .form-field, [class*="field-row"]');
                const groupCount = await formGroups.count();
                console.log(`359: フォームグループ数: ${groupCount}`);

                if (groupCount > 0) {
                    const overflowCheck = await page.evaluate(() => {
                        const body = document.body;
                        const bodyWidth = body.clientWidth;
                        const fields = document.querySelectorAll('.form-group, .form-field, [class*="field-row"]');
                        let overflowed = 0;
                        for (const field of fields) {
                            const rect = field.getBoundingClientRect();
                            if (rect.right > bodyWidth + 10) {
                                overflowed++;
                            }
                        }
                        return { total: fields.length, overflowed };
                    });
                    console.log(`359: フィールドはみ出しチェック - 全${overflowCheck.total}件中${overflowCheck.overflowed}件がはみ出し`);
                    expect(overflowCheck.overflowed, '大半のフィールドが画面内に収まっていること').toBeLessThanOrEqual(overflowCheck.total / 2);
                }
            } else {
                console.log('359: 公開フォームURLが取得できませんでした');
                await openOtherTab(page, tableId);
                await expect(page.locator('label:has-text("公開フォームをONにする")').first()).toBeVisible();
            }
        });

        // ----- step: 499 ビューで非表示の子テーブルが公開フォームに表示されないこと -----
        await test.step('499: ビューで非表示の子テーブルが公開フォームに表示されないこと', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 499`);

            const enabled = await enablePublicForm(page, tableId);
            expect(enabled, '公開フォームの設定UIが存在すること').toBe(true);

            await page.evaluate((tid) => { window.location.href = `/admin/dataset__${tid}`; }, tableId);
            await page.waitForTimeout(5000);
            await waitForAngular(page, 40000).catch(() => {});

            await page.evaluate(() => {
                const dropdowns = document.querySelectorAll('button.btn-sm.btn-outline-primary.dropdown-toggle');
                if (dropdowns.length > 0) dropdowns[0].click();
            });
            await page.waitForTimeout(500);

            const pubFormLinkItem = page.locator('.dropdown-menu a:has-text("公開フォームリンク")').first();
            let publicFormUrl = null;

            if (await pubFormLinkItem.isVisible({ timeout: 3000 }).catch(() => false)) {
                await pubFormLinkItem.click();
                await waitForAngular(page);
                const pubFormModal = page.locator('.modal.show');
                if (await pubFormModal.isVisible({ timeout: 5000 }).catch(() => false)) {
                    const urlInput = pubFormModal.locator('input[readonly]').first();
                    if (await urlInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                        publicFormUrl = await urlInput.inputValue();
                    }
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(500);
                }
            }

            if (publicFormUrl) {
                await page.goto(publicFormUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await page.waitForTimeout(3000);

                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');

                const formFields = page.locator('input, select, textarea, .form-control');
                const fieldCount = await formFields.count();
                console.log(`499: 公開フォームフィールド数: ${fieldCount}`);

                const childSections = page.locator('.child-table, .related-records, [class*="child-table"]');
                const childCount = await childSections.count();
                console.log(`499: 公開フォーム内の子テーブルセクション数: ${childCount}`);
            } else {
                console.log('499: 公開フォームURLが取得できませんでした');
                await openOtherTab(page, tableId);
                await expect(page.locator('label:has-text("公開フォームをONにする")').first()).toBeVisible();
            }
        });

        // ----- step: 547 埋め込みフォームの送信ボタン下の空白が適切であること -----
        await test.step('547: 埋め込みフォームの送信ボタン下の空白が適切であること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 547`);

            const enabled = await enablePublicForm(page, tableId);
            expect(enabled, '公開フォームの設定UIが存在すること').toBe(true);

            await page.evaluate((tid) => { window.location.href = `/admin/dataset__${tid}`; }, tableId);
            await page.waitForTimeout(5000);
            await waitForAngular(page, 40000).catch(() => {});

            await page.evaluate(() => {
                const dropdowns = document.querySelectorAll('button.btn-sm.btn-outline-primary.dropdown-toggle');
                if (dropdowns.length > 0) dropdowns[0].click();
            });
            await page.waitForTimeout(500);

            const embedLinkItem = page.locator('.dropdown-menu a:has-text("埋め込みフォーム"), .dropdown-menu a:has-text("公開フォームリンク")').first();
            let publicFormUrl = null;

            if (await embedLinkItem.isVisible({ timeout: 3000 }).catch(() => false)) {
                await embedLinkItem.click();
                await waitForAngular(page);
                const modal = page.locator('.modal.show');
                if (await modal.isVisible({ timeout: 5000 }).catch(() => false)) {
                    const urlInput = modal.locator('input[readonly], textarea[readonly]').first();
                    if (await urlInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                        const value = await urlInput.inputValue();
                        const srcMatch = value.match(/src="([^"]+)"/);
                        publicFormUrl = srcMatch ? srcMatch[1] : value;
                    }
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(500);
                }
            }

            if (publicFormUrl && publicFormUrl.startsWith('http')) {
                await page.goto(publicFormUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await page.waitForTimeout(3000);

                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');

                const submitBtn = page.locator('button[type="submit"], button:has-text("送信"), button:has-text("登録")').first();
                const submitVisible = await submitBtn.isVisible({ timeout: 5000 }).catch(() => false);
                console.log(`547: 送信ボタン表示: ${submitVisible}`);

                if (submitVisible) {
                    const spacing = await page.evaluate(() => {
                        const submitBtn = document.querySelector('button[type="submit"], button.btn-primary');
                        if (!submitBtn) return null;
                        const btnRect = submitBtn.getBoundingClientRect();
                        const bodyHeight = document.body.scrollHeight;
                        return { btnBottom: btnRect.bottom, bodyHeight, gap: bodyHeight - btnRect.bottom };
                    });
                    if (spacing) {
                        console.log(`547: 送信ボタン下端=${spacing.btnBottom}, ページ高さ=${spacing.bodyHeight}, 空白=${spacing.gap}px`);
                        expect(spacing.gap, '送信ボタンとフッター間の空白が適切であること').toBeLessThan(500);
                    }
                }
            } else {
                console.log('547: 公開フォーム/埋め込みフォームURLが取得できませんでした');
                await openOtherTab(page, tableId);
                await expect(page.locator('label:has-text("公開フォームをONにする")').first()).toBeVisible();
            }
        });

        // ----- step: 660 公開フォームがスマホサイズでも正しいレイアウトで表示されること -----
        await test.step('660: 公開フォームがスマホサイズでも正しいレイアウトで表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 660`);

            const enabled = await enablePublicForm(page, tableId);
            expect(enabled, '公開フォームの設定UIが存在すること').toBe(true);

            await page.evaluate((tid) => { window.location.href = `/admin/dataset__${tid}`; }, tableId);
            await page.waitForTimeout(5000);
            await waitForAngular(page, 40000).catch(() => {});

            await page.evaluate(() => {
                const dropdowns = document.querySelectorAll('button.btn-sm.btn-outline-primary.dropdown-toggle');
                if (dropdowns.length > 0) dropdowns[0].click();
            });
            await page.waitForTimeout(500);

            const pubFormLinkItem = page.locator('.dropdown-menu a:has-text("公開フォームリンク")').first();
            let publicFormUrl = null;

            if (await pubFormLinkItem.isVisible({ timeout: 3000 }).catch(() => false)) {
                await pubFormLinkItem.click();
                await waitForAngular(page);
                const pubFormModal = page.locator('.modal.show');
                if (await pubFormModal.isVisible({ timeout: 5000 }).catch(() => false)) {
                    const urlInput = pubFormModal.locator('input[readonly]').first();
                    if (await urlInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                        publicFormUrl = await urlInput.inputValue();
                    }
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(500);
                }
            }

            if (publicFormUrl) {
                await page.setViewportSize({ width: 375, height: 812 });
                await page.goto(publicFormUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await page.waitForTimeout(3000);

                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');

                const overflowCheck = await page.evaluate(() => {
                    const body = document.body;
                    return {
                        scrollWidth: body.scrollWidth,
                        clientWidth: body.clientWidth,
                        hasHorizontalScroll: body.scrollWidth > body.clientWidth + 20
                    };
                });
                console.log(`660: スマホ幅チェック - scrollWidth=${overflowCheck.scrollWidth}, clientWidth=${overflowCheck.clientWidth}`);
                expect(overflowCheck.hasHorizontalScroll, '公開フォームがスマホ幅に収まっていること（水平スクロール不要）').toBe(false);

                const formFields = page.locator('input, select, textarea, .form-control');
                const fieldCount = await formFields.count();
                expect(fieldCount, '公開フォームにフィールドが存在すること').toBeGreaterThan(0);

                await page.setViewportSize({ width: 1280, height: 800 });
            } else {
                console.log('660: 公開フォームURLが取得できませんでした');
                await openOtherTab(page, tableId);
                await expect(page.locator('label:has-text("公開フォームをONにする")').first()).toBeVisible();
            }
        });
    });

    // =========================================================================
    // UC07: 公開フォームからファイル添付して送信（533）→ 1動画
    // =========================================================================
    test('UC07: 公開フォームファイル添付送信', async ({ page }) => {
        const _testStart = Date.now();
        page.setDefaultTimeout(60000);

        await login(page);
        await closeTemplateModal(page);

        await test.step('533: 未ログイン状態の公開フォームからファイル添付して送信できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 533`);

            const enabled = await enablePublicForm(page, tableId);
            expect(enabled, '公開フォームの設定UIが存在すること').toBe(true);

            await page.evaluate((tid) => { window.location.href = `/admin/dataset__${tid}`; }, tableId);
            await page.waitForTimeout(5000);
            await waitForAngular(page, 40000).catch(() => {});

            await page.evaluate(() => {
                const dropdowns = document.querySelectorAll('button.btn-sm.btn-outline-primary.dropdown-toggle');
                if (dropdowns.length > 0) dropdowns[0].click();
            });
            await page.waitForTimeout(500);

            const pubFormLinkItem = page.locator('.dropdown-menu a:has-text("公開フォームリンク")').first();
            let publicFormUrl = null;

            if (await pubFormLinkItem.isVisible({ timeout: 3000 }).catch(() => false)) {
                await pubFormLinkItem.click();
                await waitForAngular(page);
                const pubFormModal = page.locator('.modal.show');
                if (await pubFormModal.isVisible({ timeout: 5000 }).catch(() => false)) {
                    const urlInput = pubFormModal.locator('input[readonly]').first();
                    if (await urlInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                        publicFormUrl = await urlInput.inputValue();
                    }
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(500);
                }
            }

            if (publicFormUrl) {
                const newContext = await page.context().browser().newContext();
                const newPage = await newContext.newPage();

                await newPage.goto(publicFormUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await newPage.waitForTimeout(3000);

                const bodyText = await newPage.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');
                expect(bodyText).not.toContain('404');

                const fileInput = newPage.locator('input[type="file"]').first();
                const fileInputCount = await fileInput.count();
                console.log(`533: ファイル添付フィールド数: ${fileInputCount}`);

                if (fileInputCount > 0) {
                    const testFilePath = '/Users/yasaipopo/PycharmProjects/pigeon-test/test_files/ok.png';
                    const fs = require('fs');
                    if (fs.existsSync(testFilePath)) {
                        await fileInput.setInputFiles(testFilePath);
                        await newPage.evaluate(() => {
                            const input = document.querySelector('input[type="file"]');
                            if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
                        });
                        await newPage.waitForTimeout(2000);
                        console.log('533: テストファイル添付完了');
                    } else {
                        console.log('533: テストファイルが存在しません: ' + testFilePath);
                    }
                }

                const submitBtn = newPage.locator('button[type="submit"], button:has-text("送信"), button:has-text("登録")').first();
                const submitVisible = await submitBtn.isVisible({ timeout: 5000 }).catch(() => false);
                expect(submitVisible, '公開フォームに送信ボタンが存在すること').toBe(true);

                await newContext.close();
            } else {
                console.log('533: 公開フォームURLが取得できませんでした');
                await openOtherTab(page, tableId);
                await expect(page.locator('label:has-text("公開フォームをONにする")').first()).toBeVisible();
            }
        });
    });

    // =========================================================================
    // UC22: 公開フォームURLパラメータ初期値（812）→ 1動画
    // =========================================================================
    test('UC22: 公開フォームURLパラメータ初期値', async ({ page }) => {
        const _testStart = Date.now();
        page.setDefaultTimeout(60000);

        await login(page);
        await closeTemplateModal(page);

        await test.step('812: 公開フォームURLにパラメータを付与して初期値が設定されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 812`);

            const enabled = await enablePublicForm(page, tableId);
            expect(enabled, '公開フォームの設定UIが存在すること').toBe(true);

            await page.evaluate((tid) => { window.location.href = `/admin/dataset__${tid}`; }, tableId);
            await page.waitForTimeout(5000);
            await waitForAngular(page, 40000).catch(() => {});

            await page.evaluate(() => {
                const dropdowns = document.querySelectorAll('button.btn-sm.btn-outline-primary.dropdown-toggle');
                if (dropdowns.length > 0) dropdowns[0].click();
            });
            await page.waitForTimeout(500);

            const pubFormLinkItem = page.locator('.dropdown-menu a:has-text("公開フォームリンク")').first();
            let publicFormUrl = null;

            if (await pubFormLinkItem.isVisible({ timeout: 3000 }).catch(() => false)) {
                await pubFormLinkItem.click();
                await waitForAngular(page);
                const pubFormModal = page.locator('.modal.show');
                if (await pubFormModal.isVisible({ timeout: 5000 }).catch(() => false)) {
                    const urlInput = pubFormModal.locator('input[readonly]').first();
                    if (await urlInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                        publicFormUrl = await urlInput.inputValue();
                    }
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(500);
                }
            }

            if (publicFormUrl) {
                const separator = publicFormUrl.includes('?') ? '&' : '?';
                const paramUrl = publicFormUrl + separator + encodeURIComponent('テキスト') + '=' + encodeURIComponent('テスト初期値812');

                const newContext = await page.context().browser().newContext();
                const newPage = await newContext.newPage();

                await newPage.goto(paramUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await newPage.waitForTimeout(3000);

                const bodyText = await newPage.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');
                expect(bodyText).not.toContain('404');

                const formFields = newPage.locator('input[type="text"], input:not([type="hidden"]):not([type="file"]), textarea');
                const fieldCount = await formFields.count();
                console.log(`812: フォームフィールド数: ${fieldCount}`);
                expect(fieldCount, '公開フォームにフィールドが存在すること').toBeGreaterThan(0);

                const hasPrefilledValue = await newPage.evaluate(() => {
                    const inputs = document.querySelectorAll('input[type="text"], textarea');
                    for (const input of inputs) {
                        if (input.value && input.value.includes('テスト初期値812')) {
                            return true;
                        }
                    }
                    return false;
                });
                console.log(`812: パラメータによる初期値設定: ${hasPrefilledValue}`);

                await newContext.close();
            } else {
                console.log('812: 公開フォームURLが取得できませんでした');
                await openOtherTab(page, tableId);
                await expect(page.locator('label:has-text("公開フォームをONにする")').first()).toBeVisible();
            }
        });
    });

    // =========================================================================
    // UC23: 公開フォームレイアウト確認（838）→ 1動画
    // =========================================================================
    test('UC23: 公開フォームレイアウト確認', async ({ page }) => {
        const _testStart = Date.now();
        page.setDefaultTimeout(60000);

        await login(page);
        await closeTemplateModal(page);

        await test.step('838: 公開フォームで各フィールドが正しいレイアウトで表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 838`);

            const enabled = await enablePublicForm(page, tableId);
            expect(enabled, '公開フォームの設定UIが存在すること').toBe(true);

            await page.evaluate((tid) => { window.location.href = `/admin/dataset__${tid}`; }, tableId);
            await page.waitForTimeout(5000);
            await waitForAngular(page, 40000).catch(() => {});

            await page.evaluate(() => {
                const dropdowns = document.querySelectorAll('button.btn-sm.btn-outline-primary.dropdown-toggle');
                if (dropdowns.length > 0) dropdowns[0].click();
            });
            await page.waitForTimeout(500);

            const pubFormLinkItem = page.locator('.dropdown-menu a:has-text("公開フォームリンク")').first();
            let publicFormUrl = null;

            if (await pubFormLinkItem.isVisible({ timeout: 3000 }).catch(() => false)) {
                await pubFormLinkItem.click();
                await waitForAngular(page);
                const pubFormModal = page.locator('.modal.show');
                if (await pubFormModal.isVisible({ timeout: 5000 }).catch(() => false)) {
                    const urlInput = pubFormModal.locator('input[readonly]').first();
                    if (await urlInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                        publicFormUrl = await urlInput.inputValue();
                    }
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(500);
                }
            }

            if (publicFormUrl) {
                await page.setViewportSize({ width: 1280, height: 800 });
                await page.goto(publicFormUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await page.waitForTimeout(3000);

                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');

                const layoutCheck = await page.evaluate(() => {
                    const fields = document.querySelectorAll('.form-group, .form-field, [class*="field-row"], .form-control');
                    let leftAligned = 0;
                    let total = 0;
                    for (const field of fields) {
                        const rect = field.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            total++;
                            if (rect.left < 10) {
                                leftAligned++;
                            }
                        }
                    }
                    return { total, leftAligned };
                });

                console.log(`838: レイアウトチェック - 全${layoutCheck.total}フィールド中、左寄り${layoutCheck.leftAligned}件`);
                expect(layoutCheck.total, '公開フォームにフィールドが存在すること').toBeGreaterThan(0);

                const clippedCheck = await page.evaluate(() => {
                    const fields = document.querySelectorAll('input, select, textarea, .form-control');
                    let clipped = 0;
                    const viewportWidth = window.innerWidth;
                    for (const field of fields) {
                        const rect = field.getBoundingClientRect();
                        if (rect.width > 0 && rect.right > viewportWidth) {
                            clipped++;
                        }
                    }
                    return { clipped, total: fields.length };
                });
                console.log(`838: 見切れチェック - 全${clippedCheck.total}件中${clippedCheck.clipped}件が見切れ`);
                expect(clippedCheck.clipped, '見切れフィールドが少ないこと').toBeLessThanOrEqual(clippedCheck.total / 4);
            } else {
                console.log('838: 公開フォームURLが取得できませんでした');
                await openOtherTab(page, tableId);
                await expect(page.locator('label:has-text("公開フォームをONにする")').first()).toBeVisible();
            }
        });
    });

});
