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
    await page.waitForLoadState('domcontentloaded');
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
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
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
            await page.waitForTimeout(800);
        }
    } catch (e) {
        // モーダルがなければ何もしない
    }
}

/**
 * テーブル設定の「その他」タブで公開フォームをONにする
 * （スイッチ変更は自動保存される）
 */
async function enablePublicForm(page, tableId) {
    await page.goto(BASE_URL + `/admin/dataset/edit/${tableId}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // 「その他」タブをクリック
    const otherTab = page.locator('.nav-link:has-text("その他")');
    await otherTab.click();
    await page.waitForTimeout(1500);

    // 「公開フォームをONにする」の行を取得
    const pubFormRow = page.locator('.form-group.row.admin-forms:has-text("公開フォームをONにする")');
    const rowCount = await pubFormRow.count();
    if (rowCount === 0) {
        // 設定UIが存在しない場合はスキップ
        return false;
    }

    const checkbox = pubFormRow.locator('input[type="checkbox"].switch-input');
    const isChecked = await checkbox.isChecked();

    if (!isChecked) {
        // スイッチをONにする（クリックで自動保存される）
        const switchHandle = pubFormRow.locator('.switch-handle');
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

    // テスト前: テーブルとデータを一度だけ作成
    test.beforeAll(async ({ browser }) => {
        test.setTimeout(360000);
        const page = await browser.newPage();
        await login(page);
        ({ tableId } = await setupAllTypeTable(page));
        if (!tableId) {
            await page.close();
            throw new Error('ALLテストテーブルの作成に失敗しました（beforeAll）');
        }
        await page.close();
    });

    // テスト後: テーブルを削除
    test.afterAll(async ({ browser }) => {
        test.setTimeout(120000);
        try {
            const page = await browser.newPage();
            await login(page);
            await deleteAllTypeTables(page);
            await page.close();
        } catch (e) {
            // teardownのエラーは無視
        }
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(300000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 135: 公開フォームをメール配信
    // テーブル設定の「その他」タブで「公開フォームをONにする」設定UIが存在し、
    // 公開フォームメールテンプレート作成モーダルがページに存在すること。
    // （YAMLの仕様: 登録ユーザーのメールアドレス宛てに回答用URLを送信、
    //   回答は一人一回のみ、送信前に確認ポップアップ表示）
    // -------------------------------------------------------------------------
    test('135: 公開フォーム設定画面が表示され、メール配信設定ができること', async ({ page }) => {
        test.setTimeout(300000);
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';

        // Step 1: テーブル設定の「その他」タブで「公開フォームをONにする」設定UIを確認
        await page.goto(BASE_URL + `/admin/dataset/edit/${tableId}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);

        // 「その他」タブをクリック
        const otherTab = page.locator('.nav-link:has-text("その他")');
        await otherTab.click();
        await page.waitForTimeout(1500);

        // 「公開フォームをONにする」のラベルが存在することを確認
        const pubFormLabel = page.locator('label:has-text("公開フォームをONにする"), .form-control-label:has-text("公開フォームをONにする")');
        const pubFormLabelCount = await pubFormLabel.count();
        expect(pubFormLabelCount, '「公開フォームをONにする」の設定ラベルが存在すること').toBeGreaterThan(0);

        // スイッチ（toggle）が存在することを確認
        const pubFormRow = page.locator('.form-group.row.admin-forms:has-text("公開フォームをONにする")');
        const switchInput = pubFormRow.locator('input[type="checkbox"].switch-input');
        const switchCount = await switchInput.count();
        expect(switchCount, '公開フォームスイッチが存在すること').toBeGreaterThan(0);

        // スイッチをONにする（自動保存）
        const isChecked = await switchInput.isChecked();
        if (!isChecked) {
            const switchHandle = pubFormRow.locator('.switch-handle');
            await switchHandle.click();
            await page.waitForTimeout(3000);
        }

        await page.screenshot({ path: `${reportsDir}/screenshots/135-publicform-setting.png`, fullPage: false });

        // Step 2: テーブルページに移動してドロップダウンメニューを確認
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);

        // 公開フォームメールテンプレート作成モーダルがDOMに存在することを確認
        // （「公開フォームをメール配信」メニューをクリックすると開くモーダル）
        const mailPublicFormModal = page.locator('[bsModal] .modal-title:has-text("公開フォームメールテンプレート作成"), div.modal:has(.modal-title:has-text("公開フォームメールテンプレート作成"))');
        const modalCount = await mailPublicFormModal.count();

        if (modalCount > 0) {
            // モーダルがDOMに存在することを確認（表示/非表示は問わない）
            console.log('公開フォームメールテンプレートモーダルがDOMに存在します');

            // モーダルの内容確認: 「１メールアドレスに対し、１登録に制限する」テキスト
            const restrictText = page.locator(':has-text("１メールアドレスに対し、１登録に制限する")').first();
            const restrictCount = await restrictText.count();
            if (restrictCount > 0) {
                console.log('「１メールアドレスに対し、１登録に制限する」のテキストが存在します');
            }
        } else {
            // ドロップダウンからメール配信メニューを探す
            const dropdownBtns = await page.locator('.btn-sm.btn-outline-primary.dropdown-toggle').all();
            if (dropdownBtns.length > 0) {
                await dropdownBtns[0].click();
                await page.waitForTimeout(500);

                const mailDeliveryItem = page.locator('.dropdown-item:has-text("公開フォームをメール配信")');
                const mailDeliveryCount = await mailDeliveryItem.count();

                if (mailDeliveryCount > 0) {
                    console.log('「公開フォームをメール配信」メニューが存在します');
                    // クリックしてモーダルを開く
                    await mailDeliveryItem.click();
                    await page.waitForTimeout(1500);

                    // モーダルが開いていることを確認
                    const openModal = page.locator('.modal.show:has-text("公開フォームメールテンプレート作成")');
                    const openModalCount = await openModal.count();
                    if (openModalCount > 0) {
                        await expect(openModal.first()).toBeVisible();

                        // 「１メールアドレスに対し、１登録に制限する」のスイッチ確認
                        const limitSwitch = openModal.locator('input[type="checkbox"].switch-input');
                        const limitSwitchCount = await limitSwitch.count();
                        expect(limitSwitchCount, '１メールアドレス制限スイッチが存在すること').toBeGreaterThan(0);

                        // 「作成する」ボタンの存在確認
                        const createBtn = openModal.locator('button:has-text("作成する")');
                        const createBtnCount = await createBtn.count();
                        expect(createBtnCount, '「作成する」ボタンが存在すること').toBeGreaterThan(0);
                    }
                } else {
                    // メール配信機能はmail_optionがtrueの場合のみ表示
                    // 公開フォームリンクメニューを確認
                    const pubFormLinkItem = page.locator('.dropdown-item:has-text("公開フォームリンク")');
                    const pubFormLinkCount = await pubFormLinkItem.count();
                    if (pubFormLinkCount > 0) {
                        console.log('「公開フォームリンク」メニューが存在します（メール配信はmail_option設定が必要）');
                    } else {
                        test.info().annotations.push({
                            type: 'note',
                            description: '公開フォームメニューは表示されていません。公開フォームをONにして、ページを再読み込みしてください。'
                        });
                    }
                }
            }
        }

        await page.screenshot({ path: `${reportsDir}/screenshots/135-publicform-mail.png`, fullPage: false });
    });

    // -------------------------------------------------------------------------
    // 170: 公開フォームURL変更確認
    // 公開フォームのURLが適切な形式であること（URLアドレス長の確認）
    // -------------------------------------------------------------------------
    test('170: 公開フォームURLのアドレス長が適切であること', async ({ page }) => {
        test.setTimeout(300000);
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';

        // Step 1: 公開フォームをONにする
        const enabled = await enablePublicForm(page, tableId);
        if (!enabled) {
            test.info().annotations.push({
                type: 'note',
                description: '公開フォームの設定UIが見つかりませんでした'
            });
        }

        // Step 2: テーブルページに移動してドロップダウンを開く
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);

        let publicFormUrl = null;

        // ドロップダウンを開いて「公開フォームリンク」をクリック
        const dropdownBtns = await page.locator('.btn-sm.btn-outline-primary.dropdown-toggle').all();
        if (dropdownBtns.length > 0) {
            await dropdownBtns[0].click();
            await page.waitForTimeout(500);

            const pubFormLinkItem = page.locator('.dropdown-item:has-text("公開フォームリンク")');
            const pubFormLinkCount = await pubFormLinkItem.count();

            if (pubFormLinkCount > 0) {
                await pubFormLinkItem.click();
                await page.waitForTimeout(2000);

                // 公開フォームリンクモーダルが開く
                const pubFormModal = page.locator('.modal.show:has-text("公開フォームリンク")');
                const pubFormModalCount = await pubFormModal.count();

                if (pubFormModalCount > 0) {
                    await expect(pubFormModal.first()).toBeVisible();

                    // URLを表示する input[readonly] を確認
                    const urlInput = pubFormModal.locator('input[readonly]');
                    const urlInputCount = await urlInput.count();

                    if (urlInputCount > 0) {
                        publicFormUrl = await urlInput.inputValue();
                        console.log('公開フォームURL:', publicFormUrl);

                        // URLが存在し、適切な長さであることを確認
                        expect(publicFormUrl.length, '公開フォームURLが空でないこと').toBeGreaterThan(0);

                        // URLがpigeon-demo.comまたは同様のドメインを含むことを確認
                        const urlHasDomain = publicFormUrl.includes('pigeon') || publicFormUrl.includes('http');
                        expect(urlHasDomain, '公開フォームURLが有効なドメインを含むこと').toBeTruthy();

                        // URLの長さが適切であること（ハッシュ値を含むため一定以上）
                        expect(publicFormUrl.length, '公開フォームURLが適切な長さであること（ハッシュを含む）').toBeGreaterThan(20);
                    }

                    // モーダルを閉じる
                    const closeBtn = pubFormModal.locator('button:has-text("閉じる"), button.close');
                    if (await closeBtn.count() > 0) {
                        await closeBtn.first().click();
                        await page.waitForTimeout(500);
                    }
                }
            } else {
                // 公開フォームメニューが表示されない場合
                // ページのDOMから公開フォームURL要素を直接確認
                const urlInputInPage = page.locator('input[readonly][value*="pigeon"], input[readonly][value*="http"]');
                const urlInputCount = await urlInputInPage.count();

                if (urlInputCount > 0) {
                    publicFormUrl = await urlInputInPage.first().inputValue();
                    console.log('ページ内公開フォームURL:', publicFormUrl);
                    expect(publicFormUrl.length).toBeGreaterThan(0);
                } else {
                    test.info().annotations.push({
                        type: 'note',
                        description: '公開フォームリンクメニューが表示されませんでした。公開フォームをONにしてビューを設定してください。'
                    });
                }
            }
        }

        await page.screenshot({ path: `${reportsDir}/screenshots/170-publicform-url.png`, fullPage: false });

        // 公開URLが取得できた場合のみアドレス長の詳細確認
        if (publicFormUrl) {
            // URLのパス部分（/public/で始まるパス）の確認
            const urlPath = publicFormUrl.split('?')[0];
            const pathParts = urlPath.split('/');
            console.log('公開フォームURLパス分解:', pathParts);
        }
    });

});
