
const { test, expect } = require('@playwright/test');
const { createTestEnv } = require('./helpers/create-test-env');
const { createLightTable } = require('./helpers/create-light-table');
const { waitForAngular, goTableEdit, saveRecordEdit } = require('./helpers/ui-operations');
const { autoScreenshot } = require('./helpers/auto-screenshot');

test.describe('Bug B005: 子テーブル内の計算値の自動更新-OFF項目の計算検証', () => {
    let baseUrl, tableId, page, context;

    test.beforeAll(async ({ browser }) => {
        // [flow] 0-1. テスト環境の作成
        const env = await createTestEnv(browser, { withAllTypeTable: false });
        baseUrl = env.baseUrl;
        page = env.page;
        context = env.context;
        
        // [flow] 0-2. 親テーブルを作成
        tableId = await createLightTable(page, 'B005 Parent', [{ type: 'text', label: '親レコード名' }]);
    });

    test('B005 reproduction', async ({ page: _page }) => {
        const _testStart = Date.now();
        
        await test.step('BUG-005-01: 子テーブル内に自動更新OFFの計算項目を含む計算が正しく保存・反映されること', async () => {
            // [flow] BUG-005-01-1. 親テーブルの設定画面へ遷移
            await goTableEdit(page, tableId);
            
            // [flow] BUG-005-01-2. 子テーブルフィールド（関連レコード一覧）を追加
            await page.locator('button:has-text("項目を追加する")').first().click();
            await waitForAngular(page);
            
            // 子テーブル（関連レコード一覧）を選択
            await page.locator('.modal.show button:has-text("子テーブル"), .modal.show button:has-text("関連レコード一覧")').first().click();
            await page.locator('.modal.show input[name="label"]').fill('テスト子テーブル');
            
            // 新規作成を選択
            const createNewRadio = page.locator('.modal.show label:has-text("新規作成")');
            if (await createNewRadio.count() > 0) {
                await createNewRadio.click();
            }
            
            // 保存してフィールド追加
            await page.locator('.modal.show button.btn-primary').click();
            await waitForAngular(page);
            await expect(page.locator('.modal.show')).toHaveCount(0, { timeout: 10000 });

            // [flow] BUG-005-01-3. 作成された子テーブルのIDを特定して、そのテーブルの設定画面へ
            await page.goto(baseUrl + '/admin/dataset');
            await waitForAngular(page);
            
            const childTableLink = page.locator('li:has-text("テスト子テーブル") a, tr:has-text("テスト子テーブル") a').first();
            await expect(childTableLink, '作成された子テーブルへのリンクが存在すること').toBeVisible();
            const childTableHref = await childTableLink.getAttribute('href');
            const childTableIdMatch = childTableHref.match(/dataset__(\d+)|edit\/(\d+)/);
            const childTableId = childTableIdMatch[1] || childTableIdMatch[2];
            
            await page.goto(baseUrl + `/admin/dataset/edit/${childTableId}`);
            await waitForAngular(page);

            // [flow] BUG-005-01-4. 子テーブルに数値項目と計算項目を追加
            // 数値項目「数値1」
            await page.locator('button:has-text("項目を追加する")').first().click();
            await page.locator('.modal.show button:has-text("数値")').first().click();
            await page.locator('.modal.show input[name="label"]').fill('数値1');
            await page.locator('.modal.show button.btn-primary').click();
            await waitForAngular(page);

            // 計算項目「更新OFF計算」: {数値1} * 2, 自動更新=OFF
            await page.locator('button:has-text("項目を追加する")').first().click();
            await page.locator('.modal.show button:has-text("計算")').first().click();
            await page.locator('.modal.show input[name="label"]').fill('更新OFF計算');
            const formulaArea = page.locator('.modal.show #CommentExpression, .modal.show .contenteditable, .modal.show textarea[name="expression"]').first();
            await formulaArea.click();
            await page.keyboard.type('{数値1} * 2');
            
            // 自動更新をOFFにする
            const autoUpdateCheckbox = page.locator('.modal.show label:has-text("計算値の自動更新") input[type="checkbox"], .modal.show input[type="checkbox"]#auto_update');
            if (await autoUpdateCheckbox.count() > 0) {
                if (await autoUpdateCheckbox.isChecked()) {
                    await page.locator('.modal.show label:has-text("計算値の自動更新")').click();
                }
            } else {
                await page.locator('.modal.show label:has-text("計算値の自動更新")').click();
            }
            await page.locator('.modal.show button.btn-primary').click();
            await waitForAngular(page);

            // 計算項目「最終結果」: {更新OFF計算} + 10
            await page.locator('button:has-text("項目を追加する")').first().click();
            await page.locator('.modal.show button:has-text("計算")').first().click();
            await page.locator('.modal.show input[name="label"]').fill('最終結果');
            const formulaArea2 = page.locator('.modal.show #CommentExpression, .modal.show .contenteditable, .modal.show textarea[name="expression"]').first();
            await formulaArea2.click();
            await page.keyboard.type('{更新OFF計算} + 10');
            await page.locator('.modal.show button.btn-primary').click();
            await waitForAngular(page);

            // [flow] BUG-005-01-5. 親テーブルでレコードを追加し、子テーブルの値を入力する
            await page.goto(baseUrl + `/admin/dataset__${tableId}`);
            await waitForAngular(page);
            await page.locator('button:visible:has(.fa-plus)').first().click();
            await waitForAngular(page);
            await page.locator('input.form-control').first().fill('B005 Test Record');
            
            // 子テーブルに行を追加
            const addChildRowBtn = page.locator('.child-table button:has-text("追加"), button:has-text("行を追加")').filter({ visible: true }).first();
            await addChildRowBtn.click();
            await waitForAngular(page);
            
            // 数値1 に 100 を入力
            const numInput = page.locator('.child-table input[data-label="数値1"], .child-table input[placeholder*="数値1"], .sub-table input').first();
            await numInput.fill('100');
            
            // [flow] BUG-005-01-6. レコードを保存する
            await saveRecordEdit(page);
            const confirmBtn = page.locator('button:has-text("変更する"), button:has-text("保存する"), button:has-text("はい")').first();
            if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                await confirmBtn.click();
            }
            await waitForAngular(page);
            await page.waitForURL(/\/view\//, { timeout: 30000 }).catch(() => {});

            // [check] BUG-005-01-7. ✅ 詳細画面で子テーブルの計算結果が正しく反映されていることを検証
            const offCalcValue = page.locator('td').filter({ hasText: /^200$/ }).first();
            const finalCalcValue = page.locator('td').filter({ hasText: /^210$/ }).first();
            
            // [check] BUG-005-01-8. ✅ 子テーブルの自動更新OFF項目が 200 と表示されていること
            await expect(offCalcValue, '自動更新OFF項目（100 * 2）が 200 と表示されていること').toBeVisible({ timeout: 10000 });
            
            // [check] BUG-005-01-9. ✅ 子テーブルの自動更新OFF項目を参照する計算項目が 210 と表示されていること
            await expect(finalCalcValue, '自動更新OFF項目を参照する計算（200 + 10）が 210 と表示されていること').toBeVisible({ timeout: 10000 });
            
            // [check] BUG-005-01-10. ✅ 画面上にエラーが表示されていないこと
            const errors = await page.locator('.alert-danger, .error-message').filter({ visible: true }).count();
            expect(errors, '画面上にエラーが表示されていないこと').toBe(0);

            await autoScreenshot(page, 'BUG01', 'BUG-005-01', _testStart);
        });


    });
});
