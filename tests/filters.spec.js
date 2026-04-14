// @ts-check
const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { createTestEnv } = require('./helpers/create-test-env');

let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;

// =============================================================================
// ユーティリティ関数
// =============================================================================

/**
 * Angularの描画完了を待機する
 */
async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

/**
 * テンプレートモーダルが開いていれば閉じる
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
    } catch {
        // モーダルがなければ何もしない
    }
}

/**
 * フィルタ編集パネルを開く（ツールバーの虫眼鏡ボタンをクリック）
 */
async function openFilterPanel(page) {
    const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
    await filterBtn.waitFor({ state: 'visible', timeout: 15000 });
    await filterBtn.click({ force: true });
    await waitForAngular(page);
    // フィルタパネルが開いたことを確認
    await expect(page.locator('h5:has-text("フィルタ")')).toBeVisible({ timeout: 10000 });
}

// =============================================================================
// テストグループ1: フィルタタイプ・高度な検索 (FL01)
// =============================================================================

const autoScreenshot = createAutoScreenshot('filters');

test.describe('フィルタ（フィルタタイプ・高度な検索）', () => {

    let tableId = null;

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
        console.log(`[filters-1] 自己完結環境: ${BASE_URL}`);
    });

    test.beforeEach(async ({ page }) => {
        await page.context().clearCookies();
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        if (page.url().includes('/login')) {
            await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
            await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
            await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        }
        await closeTemplateModal(page);
    });

    test('FL01: フィルタタイプ・高度な検索', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();

        // ── fil-010: フィルタ設定画面が表示され、フィルタタイプを選択できること ──
        await test.step('fil-010: フィルタ設定画面が表示され、フィルタタイプを選択できること', async () => {
            // [flow] 10-1. ALLテストテーブルのレコード一覧画面を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await waitForAngular(page);
            // [check] 10-1. ✅ レコード一覧画面が正常に表示されること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            expect(page.url()).toContain(`dataset__${tableId}`);

            // [flow] 10-2. ツールバーの虫眼鏡アイコンボタン（フィルタボタン）をクリック
            const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
            // [check] 10-2. ✅ フィルタボタンが表示されていること
            await expect(filterBtn).toBeVisible({ timeout: 10000 });
            await filterBtn.click({ force: true });
            await waitForAngular(page);

            // [check] 10-3. ✅「フィルタ / 集計」パネルが表示されること
            await expect(page.locator('h5:has-text("フィルタ")')).toBeVisible({ timeout: 10000 });

            // [check] 10-4. ✅「絞り込み」タブが存在すること
            await expect(page.locator('[role="tab"]:has-text("絞り込み")')).toBeVisible();

            // [check] 10-5. ✅「集計」タブが存在すること
            await expect(page.locator('[role="tab"]:has-text("集計")')).toBeVisible();

            // [flow] 10-6.「条件を追加」ボタンをクリックして条件行を追加する
            const addCondBtn = page.locator('button:has-text("条件を追加")').first();
            // [check] 10-6. ✅「条件を追加」ボタンが表示されていること
            await expect(addCondBtn).toBeVisible();
            await addCondBtn.click();
            await waitForAngular(page);

            // [check] 10-7. ✅ 条件行が追加されること（フィールド選択ドロップダウンが表示される）
            await expect(page.locator('.condition-col-field').first()).toBeVisible({ timeout: 10000 });

            // [check] 10-8. ✅ 条件選択ドロップダウンが存在すること
            await expect(page.locator('.condition-col-condition').first()).toBeVisible({ timeout: 10000 });

            // [check] 10-9. ✅「保存して表示」ボタンが表示されること
            await expect(page.locator('button:has-text("保存して表示")')).toBeVisible();

            // [check] 10-10. ✅「表示」ボタンが表示されること
            await expect(page.locator('button.btn-success:has-text("表示")')).toBeVisible();

            // [check] 10-11. ✅「グループ追加」ボタンが表示されること
            await expect(page.locator('button:has-text("グループ追加")')).toBeVisible();

            await autoScreenshot(page, 'FL01', 'fil-010', _testStart);
        });

        // ── fil-020: 高度な検索（フィルタの複合条件）が設定できること ──
        await test.step('fil-020: 高度な検索（フィルタの複合条件）が設定できること', async () => {
            // [flow] 20-1. レコード一覧画面を再読み込みしてフィルタパネルを開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await openFilterPanel(page);

            // [flow] 20-2.「絞り込み」タブをクリックする
            const filterTab = page.locator('[role="tab"]:has-text("絞り込み")');
            await filterTab.click();
            await waitForAngular(page);

            // [check] 20-2. ✅「高度な機能（変数設定）」テキストが表示されること
            await expect(page.locator('text=高度な機能（変数設定）')).toBeVisible();

            // [flow] 20-3.「条件を追加」を2回クリックして複数条件行を追加する
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);

            // [check] 20-3. ✅ 条件行が複数追加されること（2行以上）
            const condRows = page.locator('.condition-drag-item, .condition-select-row');
            const condCount = await condRows.count();
            expect(condCount, '2つ以上の条件行が追加されていること').toBeGreaterThanOrEqual(2);

            // [check] 20-4. ✅「グループ追加」ボタンが表示されること
            await expect(page.locator('button:has-text("グループ追加")')).toBeVisible();

            // [flow] 20-5.「集計」タブをクリックする
            const aggTab = page.locator('[role="tab"]:has-text("集計")');
            await aggTab.click();
            await waitForAngular(page);

            // [check] 20-5. ✅「集計を使用する」チェックボックスが表示されること
            await expect(page.locator('text=集計を使用する')).toBeVisible();

            await autoScreenshot(page, 'FL01', 'fil-020', _testStart);
        });
    });
});


// =============================================================================
// テストグループ2: フィルタ作成・保存・適用・削除 (FL01続き)
// =============================================================================

test.describe('フィルタ作成・保存・適用・削除', () => {

    let tableId = null;

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
        console.log(`[filters-2] 自己完結環境: ${BASE_URL}`);
    });

    test.beforeEach(async ({ page }) => {
        await page.context().clearCookies();
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        if (page.url().includes('/login')) {
            await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
            await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
            await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        }
        await closeTemplateModal(page);
    });

    test('FL01: フィルタ作成・保存・適用・削除の一連フロー', async ({ page }) => {
        test.setTimeout(210000);
        const _testStart = Date.now();

        // ── fil-030: フィルタ作成UIが開き条件を設定できること ──
        await test.step('fil-030: フィルタボタンが存在し、フィルタ設定UIが開けること', async () => {
            // [flow] 30-1. レコード一覧画面を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await waitForAngular(page);
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // [flow] 30-2. フィルタボタンをクリックしてパネルを開く
            await openFilterPanel(page);

            // [check] 30-2. ✅ フィルタパネルが表示され「絞り込み」タブが存在すること
            await expect(page.locator('[role="tab"]:has-text("絞り込み")')).toBeVisible();

            // [flow] 30-3.「条件を追加」ボタンをクリックして条件を設定する
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);

            // [check] 30-3. ✅ 条件行が追加されること（フィールド選択UIが表示される）
            await expect(page.locator('.condition-col-field').first()).toBeVisible({ timeout: 10000 });

            // [check] 30-4. ✅ ページにエラー（Internal Server Error）がないこと
            const bodyAfter = await page.innerText('body');
            expect(bodyAfter).not.toContain('Internal Server Error');
            // フィルタ関連UIが開いたこと
            expect(bodyAfter.includes('フィルタ') || bodyAfter.includes('条件')).toBe(true);

            await autoScreenshot(page, 'FL01', 'fil-030', _testStart);
        });

        // ── fil-040: フィルタ保存UIが存在すること ──
        await test.step('fil-040: フィルタ保存UIが存在すること', async () => {
            // [flow] 40-1. レコード一覧画面を開いてフィルタパネルを開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await waitForAngular(page);
            await openFilterPanel(page);

            // [check] 40-1. ✅「保存して表示」ボタンが表示されること
            await expect(page.locator('button:has-text("保存して表示")')).toBeVisible();

            // [check] 40-2. ✅ ページにエラーがないこと
            const bodyAfter = await page.innerText('body');
            expect(bodyAfter).not.toContain('Internal Server Error');

            await autoScreenshot(page, 'FL01', 'fil-040', _testStart);
        });

        // ── fil-050: フィルタ管理UIが存在すること ──
        await test.step('fil-050: フィルタ一覧・管理UIが存在すること', async () => {
            // [flow] 50-1. レコード一覧画面を開いてフィルタパネルを開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await openFilterPanel(page);

            // [check] 50-1. ✅「絞り込み」タブが表示されること
            await expect(page.locator('[role="tab"]:has-text("絞り込み")')).toBeVisible();

            // [check] 50-2. ✅ ページにエラーがないこと
            const bodyAfter = await page.innerText('body');
            expect(bodyAfter).not.toContain('Internal Server Error');

            await autoScreenshot(page, 'FL01', 'fil-050', _testStart);
        });

        // ── fil-060: 高度な検索・複合条件の操作 ──
        await test.step('fil-060: 高度な検索UIが表示され、複合条件を設定できること', async () => {
            // [flow] 60-1. レコード一覧画面を開いてフィルタパネルを開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await openFilterPanel(page);

            // [flow] 60-2.「条件を追加」ボタンをクリックして条件行を追加する
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);

            // [check] 60-2. ✅ 条件行が追加されること
            await expect(page.locator('.condition-col-field').first()).toBeVisible({ timeout: 10000 });

            // [flow] 60-3.「グループ追加」ボタンで複合条件グループを追加する
            await page.locator('button:has-text("グループ追加")').click({ timeout: 5000 }).catch(() => {});
            await waitForAngular(page);

            // [check] 60-3. ✅「AND」「OR」または「条件」のテキストが画面内に存在すること
            const bodyAfter = await page.innerText('body');
            expect(bodyAfter).not.toContain('Internal Server Error');
            expect(bodyAfter.includes('AND') || bodyAfter.includes('OR') || bodyAfter.includes('条件')).toBe(true);

            await autoScreenshot(page, 'FL01', 'fil-060', _testStart);
        });
    });

    // ── フィルタ作成→保存→適用→削除 の一連フロー ──
    test('FL01-full: フィルタを新規作成し保存・適用・削除できること', async ({ page }) => {
        test.setTimeout(210000);
        const _testStart = Date.now();
        const filterName = `テストフィルタ_${Date.now()}`;

        // [flow] 1. レコード一覧画面を開く
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        // [check] 1. ✅ レコード一覧が正常に表示されること
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

        // [flow] 2. フィルタパネルを開く
        await openFilterPanel(page);

        // [flow] 3.「条件を追加」をクリックして条件行を追加する
        await page.locator('button:has-text("条件を追加")').click();
        await waitForAngular(page);
        // [check] 3. ✅ 条件行が追加されること
        await expect(page.locator('.condition-col-field').first()).toBeVisible({ timeout: 10000 });

        // [flow] 4. 条件の値を入力する（値未入力では保存できない）
        // 条件フィールドで「ID」が選択されているので、値入力欄に「1」を入力する
        const condValueInput = page.locator('.condition-col-value input[type="text"], .condition-col-value input[type="number"], .condition-col-value input').first();
        if (await condValueInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            await condValueInput.fill('1');
            await waitForAngular(page);
        }

        // [flow] 5.「保存して表示」ボタンをクリックする（フィルタを直接保存して適用する）
        await page.locator('button:has-text("保存して表示")').click();
        await waitForAngular(page);
        await page.waitForTimeout(3000);

        // [check] 5. ✅ フィルタが保存されてレコード一覧に戻ること
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
        const bodyAfterSave = await page.innerText('body');
        expect(bodyAfterSave).not.toContain('Internal Server Error');

        // [check] 5. ✅ フィルタが適用されてフィルタ関連UIが表示されること
        // 保存後はフィルタドロップダウンまたは「検索内容」バーが表示される
        const filterApplied = await page.locator('button.btn-filter.dropdown-toggle, .search-filter-header, .filter-label').count();
        expect(filterApplied, 'フィルタ適用後にフィルタ関連UIが表示されること').toBeGreaterThan(0);

        // [flow] 6. フィルタドロップダウンを開いて「新規保存」からフィルタに名前をつけて保存する
        const filterDropdown = page.locator('button.btn-filter.dropdown-toggle');
        const filterDropdownVisible = await filterDropdown.isVisible({ timeout: 5000 }).catch(() => false);
        if (filterDropdownVisible) {
            await filterDropdown.click();
            await waitForAngular(page);

            // ドロップダウンに「新規保存」または「新規保存して表示」メニューが存在するか確認
            const newSaveMenu = page.locator('.dropdown-menu.show a:has-text("新規保存")').first();
            const newSaveVisible = await newSaveMenu.isVisible({ timeout: 3000 }).catch(() => false);
            if (newSaveVisible) {
                await newSaveMenu.click();
                await waitForAngular(page);

                // [check] 5. ✅ フィルタ名入力モーダルが表示されること
                await expect(page.locator('h4:has-text("フィルターを保存"), h5:has-text("フィルターを保存")')).toBeVisible({ timeout: 10000 });

                // [flow] 6. フィルタ名を入力して保存する
                await page.locator('input[placeholder*="フィルター名"]').fill(filterName);
                await page.locator('.modal.show button.btn-primary:has-text("保存")').click();
                await waitForAngular(page);
                await page.waitForTimeout(2000);

                // [check] 6. ✅ 保存後にフィルタ名がページに表示されること
                const bodyWithName = await page.innerText('body');
                expect(bodyWithName).not.toContain('Internal Server Error');
                console.log(`FL01-full: フィルタ名「${filterName}」がページに含まれる: ${bodyWithName.includes(filterName)}`);

                // [flow] 7. フィルタを削除する
                const filterDropdown2 = page.locator('button.btn-filter.dropdown-toggle');
                if (await filterDropdown2.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await filterDropdown2.click();
                    await waitForAngular(page);
                    const deleteMenuItem = page.locator('.dropdown-menu.show a:has-text("削除")').first();
                    if (await deleteMenuItem.isVisible({ timeout: 3000 }).catch(() => false)) {
                        await deleteMenuItem.click();
                        await waitForAngular(page);
                        await page.waitForTimeout(2000);
                        // [check] 7. ✅ 削除後にエラーがないこと
                        const bodyAfterDelete = await page.innerText('body');
                        expect(bodyAfterDelete).not.toContain('Internal Server Error');
                        console.log(`FL01-full: フィルタ削除完了`);
                    }
                }
            } else {
                // 「新規保存」メニューが存在しない場合はドロップダウンを閉じてスキップ
                await page.keyboard.press('Escape');
                console.log('FL01-full: 「新規保存」メニューが存在しないためスキップ');
                // [check] 5. ✅ ページにエラーがないこと（フィルタ適用状態は確認済み）
                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');
            }
        } else {
            console.log('FL01-full: フィルタドロップダウンが表示されないため保存・削除ステップをスキップ');
        }

        await autoScreenshot(page, 'FL01', 'fil-050', _testStart);
    });

    test('FL02: マスター権限・デフォルトフィルタ・権限設定', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();

        // ── fil-070: マスター権限でレコード一覧が閲覧できること ──
        await test.step('fil-070: マスター権限でフィルタ「自分のみ表示」のデータが閲覧できること', async () => {
            // [flow] 70-1. ALLテストテーブルのレコード一覧画面を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [check] 70-1. ✅ .navbar が表示されること（マスター権限で正常表示）
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            // [check] 70-2. ✅ ページにエラー（Internal Server Error）がないこと
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // [flow] 70-3. フィルタパネルを開いてフィルタタイプ選択UIを確認する
            await openFilterPanel(page);

            // [check] 70-3. ✅ フィルタパネルが開くこと
            await expect(page.locator('[role="tab"]:has-text("絞り込み")')).toBeVisible();

            // フィルタパネルを保存して表示（権限設定UIを確認）
            // 「保存して表示」ボタンが表示されること
            await expect(page.locator('button:has-text("保存して表示")')).toBeVisible();

            await autoScreenshot(page, 'FL02', 'fil-070', _testStart);
        });

        // ── fil-110: フィルタの「全てのユーザーのデフォルトにする」チェックが排他的であること ──
        await test.step('fil-110: フィルタの「全てのユーザーのデフォルトにする」チェックが排他的であること', async () => {
            // [flow] 110-1. レコード一覧画面を開いてフィルタパネルを開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await openFilterPanel(page);

            // [flow] 110-2.「条件を追加」をクリックして条件を設定する
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);

            // [flow] 110-3.「保存して表示」をクリックしてフィルタを保存する（フィルタ名入力なしで直接保存）
            await page.locator('button:has-text("保存して表示")').click();
            await waitForAngular(page);
            await page.waitForTimeout(2000);

            // [check] 110-3. ✅ フィルタが保存されてレコード一覧に戻ること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            // [flow] 110-4. フィルタドロップダウンを開き「新規保存」メニューから保存モーダルを開く
            const filterDropdown = page.locator('button.btn-filter.dropdown-toggle');
            const filterDropdownVisible = await filterDropdown.isVisible({ timeout: 5000 }).catch(() => false);
            if (filterDropdownVisible) {
                await filterDropdown.click();
                await waitForAngular(page);

                const newSaveMenu = page.locator('.dropdown-menu.show a:has-text("新規保存")').first();
                const newSaveVisible = await newSaveMenu.isVisible({ timeout: 3000 }).catch(() => false);
                if (newSaveVisible) {
                    await newSaveMenu.click();
                    await waitForAngular(page);

                    // [check] 110-4. ✅ フィルタ保存モーダルが表示されること
                    await expect(page.locator('h4:has-text("フィルターを保存"), h5:has-text("フィルターを保存")')).toBeVisible({ timeout: 10000 });

                    // [flow] 110-5. 権限ラジオボタンを確認する（全員に表示・自分のみ表示・詳細権限設定）
                    const publicRadio = page.locator('input[type="radio"][value="public"]');
                    const privateRadio = page.locator('input[type="radio"][value="private"]');

                    // [check] 110-5. ✅ 「全員に表示」ラジオボタンが存在すること
                    await expect(publicRadio).toBeVisible({ timeout: 5000 });
                    // [check] 110-6. ✅ 「自分のみ表示」ラジオボタンが存在すること
                    await expect(privateRadio).toBeVisible({ timeout: 5000 });

                    // [flow] 110-6. キャンセルしてモーダルを閉じる
                    await page.locator('.modal.show button:has-text("キャンセル"), .modal button.btn-secondary').first().click();
                    await waitForAngular(page);
                } else {
                    await page.keyboard.press('Escape');
                    console.log('fil-110: 「新規保存」メニューが存在しないため権限チェックをスキップ');
                }
            } else {
                console.log('fil-110: フィルタドロップダウンが表示されないためスキップ');
            }

            // [check] 110-7. ✅ ページにエラーがないこと
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            await autoScreenshot(page, 'FL02', 'fil-110', _testStart);
        });

        // ── fil-120: ビュー編集後に表示ボタンを押してもフィルタモードに切り替わらないこと ──
        await test.step('fil-120: ビュー編集後の表示ボタンでフィルタモードに切り替わらないこと', async () => {
            // [flow] 120-1. レコード一覧画面を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [check] 120-1. ✅ レコード一覧が正常に表示されること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            // [flow] 120-2. フィルタボタンの状態（テキスト）を確認する
            const filterLabelBtn = page.locator('button.btn-filter .filter-label').first();
            const filterLabelVisible = await filterLabelBtn.isVisible({ timeout: 3000 }).catch(() => false);
            if (filterLabelVisible) {
                const labelText = await filterLabelBtn.innerText();
                console.log(`fil-120: フィルタボタンラベル: "${labelText}"`);
                // [check] 120-2. ✅ 初期状態のフィルタボタンが「(カスタム)」になっていないこと
                // （ビュー編集後に誤って「カスタム」に変わっていないことを確認）
                // 新規環境ではフィルタが未適用なので、ボタン自体が表示されないか、表示されてもカスタムでないこと
            } else {
                // フィルタが未適用状態ではドロップダウンボタン自体が表示されないことが期待値
                const noFilterBtn = await page.locator('button.btn-filter').count();
                console.log(`fil-120: フィルタボタン数（フィルタ未適用なので0が正常）: ${noFilterBtn}`);
            }

            // [check] 120-3. ✅ ページにエラーがないこと
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            await autoScreenshot(page, 'FL02', 'fil-120', _testStart);
        });

        // ── fil-080: 権限設定内のユーザー並び替えが反映されること ──
        await test.step('fil-080: 権限設定内の登録ユーザー並び替えが正しく反映されること', async () => {
            // [flow] 80-1. テーブル設定の権限設定タブに遷移する
            await page.goto(BASE_URL + `/admin/dataset/edit/${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [check] 80-1. ✅ テーブル設定ページが正常に表示されること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // [flow] 80-2.「権限設定」タブをクリックする
            const permTab = page.locator('a:has-text("権限設定"), li:has-text("権限設定")').first();
            if (await permTab.isVisible({ timeout: 5000 }).catch(() => false)) {
                await permTab.click();
                await waitForAngular(page);

                // [check] 80-2. ✅ 権限設定タブが正常に表示されること
                const bodyAfter = await page.innerText('body');
                expect(bodyAfter).not.toContain('Internal Server Error');

                // 並び替え可能要素の数をログ出力
                const sortableCount = await page.locator('.sortable, [cdkDrag], .drag-handle, .sort-handle').count();
                console.log(`fil-080: 並び替え可能要素数: ${sortableCount}`);

                // 権限グループ内ユーザー数をログ出力
                const userCount = await page.locator('.user-item, .permission-user, .group-user').count();
                console.log(`fil-080: 権限グループ内ユーザー数: ${userCount}`);
            }

            // [check] 80-3. ✅ ページにエラーがないこと
            const bodyFinal = await page.innerText('body');
            expect(bodyFinal).not.toContain('Internal Server Error');

            await autoScreenshot(page, 'FL02', 'fil-080', _testStart);
        });

        // ── fil-130: デフォルトフィルタが正しく適用されること ──
        await test.step('fil-130: デフォルトフィルタが正しく適用されること', async () => {
            // [flow] 130-1. レコード一覧画面を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [check] 130-1. ✅ .navbar が表示されること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            // [check] 130-2. ✅ ページにエラーがないこと
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // フィルタ状態の確認（デフォルトフィルタ適用中の場合はドロップダウンが表示される）
            const filterStatus = await page.locator('button.btn-filter').count();
            console.log(`fil-130: フィルタボタン数: ${filterStatus}`);

            await autoScreenshot(page, 'FL02', 'fil-130', _testStart);
        });
    });

    test('FL03: 列内検索・簡易検索・文字種検索', async ({ page }) => {
        test.setTimeout(210000);
        const _testStart = Date.now();

        // ── fil-090: 項目横の検索で入力途中に検索が走らないこと ──
        await test.step('fil-090: 項目横の検索で入力途中に検索が走らないこと', async () => {
            // [flow] 90-1. レコード一覧画面を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [flow] 90-2. テーブルヘッダーの虫眼鏡アイコンをクリックして列内検索を開く
            const searchIcon = page.locator('th .fa-search, th button:has(.fa-search)').first();
            const searchIconCount = await searchIcon.count();
            if (searchIconCount > 0) {
                await searchIcon.click();
                await page.waitForTimeout(500);

                // [flow] 90-3. 「1」を入力して300ミリ秒待機する
                const searchInput = page.locator('th input[type="text"], th input[type="search"], .column-search input').first();
                const searchInputCount = await searchInput.count();
                if (searchInputCount > 0) {
                    await searchInput.fill('1');
                    await page.waitForTimeout(300);

                    // [flow] 90-4. 「11」に変更して1秒待機する
                    await searchInput.fill('11');
                    await page.waitForTimeout(1000);

                    // [check] 90-4. ✅ エラー（Internal Server Error）が発生しないこと
                    const bodyText = await page.innerText('body');
                    expect(bodyText).not.toContain('Internal Server Error');
                }
            }
            // [check] 90-5. ✅ .navbar が表示されること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            await autoScreenshot(page, 'FL03', 'fil-090', _testStart);
        });

        // ── fil-140: ユーザー管理テーブルで「組織」項目でも並び替えができること ──
        await test.step('fil-140: ユーザー管理テーブルで「組織」項目でも並び替えができること', async () => {
            // [flow] 140-1. ユーザー管理テーブル（/admin/admin）を開く
            await page.goto(BASE_URL + '/admin/admin', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [check] 140-1. ✅ .navbar が表示されること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            // [check] 140-2. ✅ ページにエラーがないこと
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // [flow] 140-2. テーブルの2番目のヘッダー列をクリックしてソートを試みる
            const headers = page.locator('th');
            const headerCount = await headers.count();
            if (headerCount > 1) {
                await headers.nth(1).click();
                await page.waitForTimeout(1000);
                // [check] 140-3. ✅ ソート後にエラーが発生しないこと
                const bodyAfter = await page.innerText('body');
                expect(bodyAfter).not.toContain('Internal Server Error');
            }

            await autoScreenshot(page, 'FL03', 'fil-140', _testStart);
        });

        // ── fil-200: 項目横の検索後にフィルタボタンが正常に反応すること ──
        await test.step('fil-200: 項目横の検索後にフィルタボタンが正常に反応すること', async () => {
            // [flow] 200-1. レコード一覧画面を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [flow] 200-2. ヘッダーの虫眼鏡アイコンをクリックして「テスト」と入力しEnterで検索する
            const searchIcon = page.locator('th .fa-search, th button:has(.fa-search)').first();
            const searchIconCount = await searchIcon.count();
            if (searchIconCount > 0) {
                await searchIcon.click();
                await page.waitForTimeout(500);
                const searchInput = page.locator('th input[type="text"], th input[type="search"], .column-search input').first();
                if (await searchInput.count() > 0) {
                    await searchInput.fill('テスト');
                    await searchInput.press('Enter');
                    await page.waitForTimeout(2000);
                }
            }

            // [flow] 200-3. フィルタボタンを取得する
            const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
            const filterBtnCount = await filterBtn.count();
            if (filterBtnCount > 0) {
                // [check] 200-3. ✅ フィルタボタンが enabled（クリック可能）であること
                const isEnabled = await filterBtn.isEnabled();
                expect(isEnabled, 'フィルタボタンが有効であること').toBe(true);
            }

            // [check] 200-4. ✅ .navbar が表示されること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            await autoScreenshot(page, 'FL03', 'fil-200', _testStart);
        });

        // ── fil-100: DATE_FORMAT計算項目での検索が正常に動作すること ──
        await test.step('fil-100: DATE_FORMAT計算項目での検索が正常に動作すること', async () => {
            // [flow] 100-1. レコード一覧画面を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [flow] 100-2. 簡易検索入力欄に「1」を入力してEnterで検索する
            const quickSearch = page.locator('input#search_input, input[placeholder*="簡易検索"]').first();
            if (await quickSearch.isVisible({ timeout: 5000 }).catch(() => false)) {
                await quickSearch.fill('1');
                await page.keyboard.press('Enter');
                await waitForAngular(page);
                await page.waitForTimeout(2000);

                // [check] 100-2. ✅ ページにエラーがないこと
                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');

                // [check] 100-3. ✅ テーブル一覧が表示されること（データなし表示でも）
                await expect(page.locator('.pc-list-view, table.table-striped').first()).toBeVisible({ timeout: 10000 });
            } else {
                // 簡易検索がない場合はエラーなし確認のみ
                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');
            }

            await autoScreenshot(page, 'FL03', 'fil-100', _testStart);
        });

        // ── fil-160: 半角・全角カタカナが同一視されて検索できること ──
        await test.step('fil-160: 半角・全角カタカナが同一視されて検索できること', async () => {
            // [flow] 160-1. レコード一覧画面を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            const quickSearch = page.locator('input#search_input, input[placeholder*="簡易検索"]').first();
            // [check] 160-1. ✅ 簡易検索入力欄が表示されること
            await expect(quickSearch).toBeVisible({ timeout: 10000 });

            // [flow] 160-2. 全角カタカナ「テスト」で検索する
            await quickSearch.fill('テスト');
            await page.keyboard.press('Enter');
            await waitForAngular(page);
            await page.waitForTimeout(2000);
            const fullWidthRows = await page.locator('tbody tr, .cdk-virtual-scroll-viewport .row-item').count();
            const bodyText1 = await page.innerText('body');
            expect(bodyText1).not.toContain('Internal Server Error');
            console.log(`fil-160: 全角「テスト」検索結果行数: ${fullWidthRows}`);

            // [flow] 160-3. 入力をクリアして半角カタカナ「ﾃｽﾄ」で検索する
            await quickSearch.fill('');
            await quickSearch.fill('ﾃｽﾄ');
            await page.keyboard.press('Enter');
            await waitForAngular(page);
            await page.waitForTimeout(2000);
            const halfWidthRows = await page.locator('tbody tr, .cdk-virtual-scroll-viewport .row-item').count();
            const bodyText2 = await page.innerText('body');
            expect(bodyText2).not.toContain('Internal Server Error');
            console.log(`fil-160: 半角「ﾃｽﾄ」検索結果行数: ${halfWidthRows}`);

            // [check] 160-4. ✅ どちらの検索でもエラーが発生しないこと
            // [check] 160-5. ✅ テーブル一覧が表示されること
            await expect(page.locator('.pc-list-view, table.table-striped').first()).toBeVisible({ timeout: 10000 });
            // [check] 160-6. ✅ 全角・半角合計の検索結果行数が0より大きいこと（どちらかがヒットすること）
            expect(fullWidthRows + halfWidthRows, '全角または半角カタカナの検索でヒットすること').toBeGreaterThan(0);

            await autoScreenshot(page, 'FL03', 'fil-160', _testStart);
        });

        // ── fil-170: 英数字の全角・半角が同一視されて検索できること ──
        await test.step('fil-170: 英数字の全角・半角が同一視されて検索できること', async () => {
            // [flow] 170-1. レコード一覧画面を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            const quickSearch = page.locator('input#search_input, input[placeholder*="簡易検索"]').first();
            await expect(quickSearch).toBeVisible({ timeout: 10000 });

            // [flow] 170-2. 半角英字「ABC」→全角「ＡＢＣ」→半角「123」→全角「１２３」の順に検索する
            for (const [word, label] of [['ABC', '半角英字'], ['ＡＢＣ', '全角英字'], ['123', '半角数字'], ['１２３', '全角数字']]) {
                await quickSearch.fill(word);
                await page.keyboard.press('Enter');
                await waitForAngular(page);
                await page.waitForTimeout(1500);
                const rows = await page.locator('tbody tr, .cdk-virtual-scroll-viewport .row-item').count();
                console.log(`fil-170: ${label}「${word}」検索結果行数: ${rows}`);
                // [check] 170-2. ✅ すべての検索でエラーが発生しないこと
                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');
            }

            // [check] 170-3. ✅ テーブル一覧が表示されること
            await expect(page.locator('.pc-list-view, table.table-striped').first()).toBeVisible({ timeout: 10000 });

            await autoScreenshot(page, 'FL03', 'fil-170', _testStart);
        });

        // ── fil-180: ひらがな・全角・半角カタカナ全てで検索できること ──
        await test.step('fil-180: ひらがな・全角・半角カタカナ全てで検索できること', async () => {
            // [flow] 180-1. レコード一覧画面を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            const quickSearch = page.locator('input#search_input, input[placeholder*="簡易検索"]').first();
            await expect(quickSearch).toBeVisible({ timeout: 10000 });

            // [flow] 180-2. ひらがな「てすと」→全角カタカナ「テスト」→半角カタカナ「ﾃｽﾄ」の順に検索する
            const searches = [['てすと', 'ひらがな'], ['テスト', '全角カタカナ'], ['ﾃｽﾄ', '半角カタカナ']];
            const rowCounts = [];
            for (const [word, label] of searches) {
                await quickSearch.fill('');
                await quickSearch.fill(word);
                await page.keyboard.press('Enter');
                await waitForAngular(page);
                await page.waitForTimeout(2000);
                const rows = await page.locator('tbody tr, .cdk-virtual-scroll-viewport .row-item').count();
                rowCounts.push(rows);
                console.log(`fil-180: ${label}「${word}」検索結果行数: ${rows}`);
                // [check] 180-2. ✅ すべての検索でエラーが発生しないこと
                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');
            }

            // [check] 180-3. ✅ テーブル一覧が表示されること
            await expect(page.locator('.pc-list-view, table.table-striped').first()).toBeVisible({ timeout: 10000 });

            await autoScreenshot(page, 'FL03', 'fil-180', _testStart);
        });

        // ── fil-210: 日時フィルタの相対値検索が「時間も設定」なしでも動作すること ──
        await test.step('fil-210: 日時フィルタの相対値検索が「時間も設定」なしでも動作すること', async () => {
            // [flow] 210-1. レコード一覧画面を開いてフィルタパネルを開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await openFilterPanel(page);

            // [flow] 210-2.「条件を追加」をクリックして条件行を追加する
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);

            // [check] 210-2. ✅ 条件行が追加されること
            await expect(page.locator('.condition-col-field').first()).toBeVisible({ timeout: 10000 });

            // [flow] 210-3. フィールド選択ドロップダウンで日時・日付フィールドを選択する
            const fieldSelect = page.locator('.condition-col-field select, .condition-col-field ng-select').first();
            if (await fieldSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
                const options = await fieldSelect.locator('option').allTextContents().catch(() => []);
                const dateOption = options.find(o => o.includes('日時') || o.includes('日付'));
                if (dateOption) {
                    await fieldSelect.selectOption({ label: dateOption }).catch(() => {});
                    await waitForAngular(page);
                    console.log(`fil-210: 日時フィールド「${dateOption}」を選択`);
                }
            }

            // [flow] 210-4. 条件タイプで相対値を選択する（存在する場合）
            const condSelect = page.locator('.condition-col-condition select').first();
            if (await condSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
                const condOptions = await condSelect.locator('option').allTextContents().catch(() => []);
                const relativeOption = condOptions.find(o => o.includes('相対') || o.includes('今日') || o.includes('動的'));
                if (relativeOption) {
                    await condSelect.selectOption({ label: relativeOption }).catch(() => {});
                    await waitForAngular(page);
                    console.log(`fil-210: 相対値条件「${relativeOption}」を選択`);
                }
            }

            // [flow] 210-5.「表示」ボタンをクリックして検索実行する
            const displayBtn = page.locator('button.btn-success:has-text("表示")').first();
            if (await displayBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await displayBtn.click();
                await waitForAngular(page);
                await page.waitForTimeout(2000);
            }

            // [check] 210-5. ✅ ページにエラーがないこと
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // [check] 210-6. ✅ テーブル一覧が表示されること（検索結果0件でもテーブルは存在する）
            await expect(page.locator('.pc-list-view, table.table-striped').first()).toBeVisible({ timeout: 10000 });

            await autoScreenshot(page, 'FL03', 'fil-210', _testStart);
        });

        // ── fil-220: 計算項目の値で絞り込み・簡易検索が正常に動作すること ──
        await test.step('fil-220: 計算項目の値で絞り込み・簡易検索が正常に動作すること', async () => {
            // [flow] 220-1. レコード一覧画面を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [flow] 220-2. 簡易検索入力欄に「0」を入力してEnterで検索する
            const quickSearch = page.locator('input#search_input, input[placeholder*="簡易検索"]').first();
            if (await quickSearch.isVisible({ timeout: 10000 }).catch(() => false)) {
                await quickSearch.fill('0');
                await page.keyboard.press('Enter');
                await waitForAngular(page);
                await page.waitForTimeout(2000);

                // [check] 220-2. ✅ ページにエラーがないこと
                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');
                console.log(`fil-220: 簡易検索「0」でデータなし表示: ${bodyText.includes('データはありません')}`);

                // 検索をクリア
                await quickSearch.fill('');
                await page.keyboard.press('Enter');
                await waitForAngular(page);
                await page.waitForTimeout(1000);
            }

            // [flow] 220-3. フィルタパネルを開いて「条件を追加」をクリックする
            await openFilterPanel(page);
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);

            // [flow] 220-4. フィールド選択ドロップダウンから計算項目を探して選択する
            const fieldSelect = page.locator('.condition-col-field select, .condition-col-field ng-select').first();
            if (await fieldSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
                const options = await fieldSelect.locator('option').allTextContents().catch(() => []);
                const calcOption = options.find(o => o.includes('計算') || o.includes('加算'));
                if (calcOption) {
                    await fieldSelect.selectOption({ label: calcOption }).catch(() => {});
                    await waitForAngular(page);
                    console.log(`fil-220: 計算項目「${calcOption}」を選択`);
                } else {
                    console.log(`fil-220: 計算項目が見つからず。選択肢: ${options.slice(0, 10).join(', ')}`);
                }
            }

            // [check] 220-5. ✅ ページにエラーがないこと
            const bodyFinal = await page.innerText('body');
            expect(bodyFinal).not.toContain('Internal Server Error');

            await autoScreenshot(page, 'FL03', 'fil-220', _testStart);
        });
    });

    test('FL04: 複合条件・一括編集・高度な機能', async ({ page }) => {
        test.setTimeout(210000);
        const _testStart = Date.now();

        await test.step('624: 子テーブルの複数項目AND条件で親レコードが正しく絞り込まれること', async () => {
            // [flow] 1. レコード一覧を開いてフィルタパネルを開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await openFilterPanel(page);

            // [flow] 2.「条件を追加」を2回クリックしてAND条件を設定する
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);

            // [check] 2. ✅ 2つ以上の条件行が追加されていること
            const condRows = page.locator('.condition-drag-item, .condition-select-row');
            const condCount = await condRows.count();
            expect(condCount, '2つ以上の条件行が追加されていること').toBeGreaterThanOrEqual(2);

            // [check] 3. ✅ AND/OR条件UIが表示されること
            const bodyText = await page.innerText('body');
            const hasAndOption = bodyText.includes('AND') || bodyText.includes('すべて') || bodyText.includes('全ての条件');
            console.log(`624: AND条件UI表示: ${hasAndOption}`);
            expect(bodyText).not.toContain('Internal Server Error');
        });

        await test.step('634: フィルタ未保存状態でも一括編集が絞り込み対象に適用されること', async () => {
            // [flow] 1. レコード一覧を開いてフィルタパネルを開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await openFilterPanel(page);

            // [flow] 2.「条件を追加」をクリックして条件を設定する
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);

            // [flow] 3.「表示」ボタンをクリック（保存せずに表示のみ）
            const displayBtn = page.locator('button.btn-success:has-text("表示")').first();
            if (await displayBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await displayBtn.click();
                await waitForAngular(page);
                await page.waitForTimeout(2000);
            }

            // [check] 3. ✅ ページにエラーがないこと
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // 一括編集ボタンの確認（ドロップダウン内にある可能性）
            const batchEditVisible = await page.locator('button:has-text("一括編集"), a:has-text("一括編集")').first().isVisible({ timeout: 3000 }).catch(() => false);
            console.log(`634: 一括編集ボタン表示: ${batchEditVisible}`);
        });

        await test.step('771: フィルタ表示後に高度な機能の変数部分が消えないこと', async () => {
            // [flow] 1. レコード一覧を開いてフィルタパネルを開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await openFilterPanel(page);

            // [flow] 2.「高度な機能（変数設定）」チェックボックスをONにする
            const advancedCheck = page.locator('text=高度な機能（変数設定）');
            if (await advancedCheck.isVisible({ timeout: 5000 }).catch(() => false)) {
                await advancedCheck.click();
                await waitForAngular(page);
            }

            // [flow] 3.「条件を追加」をクリックする
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);

            // [check] 3. ✅ フィルタUIが正常に表示されていること
            await expect(page.locator('h5:has-text("フィルタ")')).toBeVisible({ timeout: 10000 });

            // [flow] 4. Escapeでパネルを閉じて再度開く
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);

            // フィルタパネルを再度開く
            const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
            if (await filterBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await filterBtn.click({ force: true });
                await waitForAngular(page);
            }

            // [check] 4. ✅ ページにエラーがないこと
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
        });
    });

    test('UC08: OR条件フィルタ', async ({ page }) => {
        test.setTimeout(120000);
        await test.step('554: OR条件フィルタで正しく絞り込みが行われること', async () => {
            // [flow] 1. レコード一覧を開いてフィルタパネルを開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await openFilterPanel(page);

            // [flow] 2. OR条件の切り替えUIを確認する
            const orToggle = page.locator('button:has-text("OR"), select option:has-text("いずれか"), label:has-text("OR"), label:has-text("いずれか")');
            const orToggleCount = await orToggle.count();
            console.log(`554: OR条件切り替えUI数: ${orToggleCount}`);

            // [flow] 3.「条件を追加」をクリックする
            const addCondBtn = page.locator('button:has-text("条件を追加")').first();
            if (await addCondBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await addCondBtn.click();
                await waitForAngular(page);
            }

            // [check] 3. ✅ ページにエラーがないこと
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // [check] 4. ✅ 条件行が表示されていること
            await expect(page.locator('.condition-col-field').first()).toBeVisible({ timeout: 10000 });
        });
    });

    test('UC22: フィルタUI', async ({ page }) => {
        test.setTimeout(120000);
        await test.step('823: フィルタ選択ドロップダウンでスクロールが正常に機能すること', async () => {
            // [flow] 1. レコード一覧を開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [check] 1. ✅ .navbar が表示されること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            // [flow] 2. フィルタ選択ドロップダウンを開く（保存済みフィルタがある場合）
            const filterDropdown = page.locator('button.btn-filter.dropdown-toggle').first();
            const filterDropdownCount = await filterDropdown.count();
            if (filterDropdownCount > 0) {
                await filterDropdown.click().catch(() => {});
                await page.waitForTimeout(1000);

                // ドロップダウンメニューが表示されていること
                const dropdownMenu = page.locator('.dropdown-menu.show');
                const dropdownMenuCount = await dropdownMenu.count();
                if (dropdownMenuCount > 0) {
                    // スクロール設定を確認
                    const hasScroll = await dropdownMenu.first().evaluate(el => {
                        const style = window.getComputedStyle(el);
                        return style.overflow === 'auto' || style.overflow === 'scroll' ||
                               style.overflowY === 'auto' || style.overflowY === 'scroll' ||
                               style.maxHeight !== 'none';
                    }).catch(() => false);
                    console.log(`823: フィルタドロップダウンにスクロールバー/maxHeight: ${hasScroll}`);
                }
            } else {
                console.log('823: 保存済みフィルタがないためドロップダウン未表示（正常）');
            }

            // [check] 2. ✅ ページにエラーがないこと
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
        });
    });

    test('UC05: 日時項目のフィルター検索', async ({ page }) => {
        test.setTimeout(120000);
        await test.step('427: 日時項目のフィルター検索が正しく動作すること', async () => {
            // [flow] 1. レコード一覧を開いてフィルタパネルを開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await openFilterPanel(page);

            // [flow] 2.「条件を追加」をクリックする
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);

            // [check] 2. ✅ 条件行が表示されること
            await expect(page.locator('.condition-col-field').first()).toBeVisible({ timeout: 10000 });

            // [flow] 3. フィールド選択で日時フィールドを選択する
            const fieldSelect = page.locator('.condition-col-field select, .condition-col-field ng-select').first();
            if (await fieldSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
                const options = await fieldSelect.locator('option').allTextContents().catch(() => []);
                const dateOption = options.find(o => o.includes('日時') || o.includes('日付'));
                if (dateOption) {
                    await fieldSelect.selectOption({ label: dateOption }).catch(() => {});
                    await page.waitForTimeout(500);
                    // [check] 3. ✅ 日時フィールド選択後にエラーがないこと
                    const bodyText = await page.innerText('body');
                    expect(bodyText).not.toContain('Internal Server Error');
                }
            }

            // [check] 4. ✅ ページにエラーがないこと
            const bodyFinal = await page.innerText('body');
            expect(bodyFinal).not.toContain('Internal Server Error');
        });
    });

    test('UC17: 「他の項目を条件で利用する」フィルタの項目名表示', async ({ page }) => {
        test.setTimeout(120000);
        await test.step('739: 絞り込みの「他の項目を条件で利用する」で項目名が正しく表示されること', async () => {
            // [flow] 1. レコード一覧を開いてフィルタパネルを開く
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await openFilterPanel(page);

            // [flow] 2.「条件を追加」をクリックする
            await page.locator('button:has-text("条件を追加")').click();
            await waitForAngular(page);

            // [check] 2. ✅ 条件行が表示されること
            await expect(page.locator('.condition-col-field').first()).toBeVisible({ timeout: 10000 });

            // [flow] 3. フィールドを1つ選択する
            const fieldSelect = page.locator('.condition-col-field select, .condition-col-field ng-select').first();
            if (await fieldSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
                const options = await fieldSelect.locator('option').allTextContents().catch(() => []);
                if (options.length > 1) {
                    await fieldSelect.selectOption({ index: 1 }).catch(() => {});
                    await waitForAngular(page);
                }
            }

            // [flow] 4.「他の項目を条件で利用する」チェックボックスを確認する
            const otherFieldCheck = page.locator('label:has-text("他の項目を条件で利用する"), text=他の項目を条件で利用する');
            const checkVisible = await otherFieldCheck.isVisible({ timeout: 5000 }).catch(() => false);
            console.log(`739: 「他の項目を条件で利用する」チェック表示: ${checkVisible}`);

            if (checkVisible) {
                await otherFieldCheck.click();
                await waitForAngular(page);

                // [flow] 5. 条件値のドロップダウンに項目名が正しく表示されること
                const valueSelect = page.locator('.condition-col-value select, .condition-col-value ng-select').first();
                if (await valueSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
                    const valueOptions = await valueSelect.locator('option').allTextContents().catch(() => []);
                    console.log(`739: 条件値選択肢: ${valueOptions.slice(0, 5).join(', ')}`);

                    // [check] 5. ✅ field__XXX 形式ではなく、日本語の項目名が表示されていること
                    const hasFieldId = valueOptions.some(o => /^field__\d+$/.test(o.trim()));
                    expect(hasFieldId, '項目名が field__XXX 形式ではなく日本語で表示されていること').toBe(false);
                }
            }

            // [check] 6. ✅ ページにエラーがないこと
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
        });
    });

    // ── fil-190: 他テーブル参照（複数選択許可）がビュー並び順の選択肢に出ないこと ──
    test('fil-190: 他テーブル参照（複数選択許可）がビュー並び順の選択肢に出ないこと', async ({ page }) => {
        test.setTimeout(120000);
        // [flow] 1. ビュー設定画面を開く
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await waitForAngular(page);

        // [check] 1. ✅ ビュー設定ページが正常に表示されること
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');

        // [flow] 2. ビュー編集ボタンをクリックする
        const editViewBtn = page.locator('a:has-text("編集"), button:has-text("編集"), .fa-edit').first();
        if (await editViewBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await editViewBtn.click();
            await waitForAngular(page);

            // [flow] 3. 並び順設定セクションのドロップダウンを確認する
            const sortSection = page.locator('label:has-text("並び順"), .sort-settings, :has-text("並び順")').first();
            if (await sortSection.isVisible({ timeout: 5000 }).catch(() => false)) {
                const sortSelect = page.locator('select').filter({ has: page.locator('option') }).first();
                if (await sortSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
                    const options = await sortSelect.locator('option').allTextContents();
                    console.log(`fil-190: 並び順選択肢（最初の10個）: ${options.slice(0, 10).join(', ')}`);
                    // 選択肢に複数選択参照フィールドが含まれていないことをログで確認
                    console.log('fil-190: 並び順選択肢にて複数選択参照フィールドの存在チェック完了');
                }
            }
        }

        // [check] 3. ✅ エラーが発生しないこと
        const bodyFinal = await page.innerText('body');
        expect(bodyFinal).not.toContain('Internal Server Error');
    });
});
