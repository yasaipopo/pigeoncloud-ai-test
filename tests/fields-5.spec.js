// @ts-check
// fields-5.spec.js: フィールドテスト Part 5 (全フィールドタイプ表示条件追加オプション確認 850系)
const { test, expect } = require('@playwright/test');
const { getAllTypeTableId } = require('./helpers/table-setup');
const { createAuthContext } = require('./helpers/auth-context');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

async function waitForAngular(page, timeout = 15000) {
    await page.waitForSelector('body[data-ng-ready="true"]', { timeout });
}

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
}

async function closeTemplateModal(page) {
    try {
        const modal = page.locator('div.modal.show');
        const count = await modal.count();
        if (count > 0) {
            await modal.locator('button').first().click({ force: true });
            await waitForAngular(page);
        }
    } catch (e) {}
}

// フィールドタイプとケース番号の対応
// fieldType はダイアログのh5に表示されるタイプ名
const FIELD_TYPES = [
    { caseNo: '850-1',  fieldType: '文字列(一行)',     hasDisplayCondition: true },
    { caseNo: '850-2',  fieldType: '文章(複数行)',      hasDisplayCondition: true },
    { caseNo: '850-3',  fieldType: '数値',             hasDisplayCondition: true },
    { caseNo: '850-4',  fieldType: 'Yes / No',         hasDisplayCondition: true },
    { caseNo: '850-5',  fieldType: '選択肢(単一選択)', hasDisplayCondition: true },
    { caseNo: '850-6',  fieldType: '選択肢(複数選択)', hasDisplayCondition: true },
    { caseNo: '850-7',  fieldType: '日時',             hasDisplayCondition: true },
    { caseNo: '850-8',  fieldType: '画像',             hasDisplayCondition: true },
    { caseNo: '850-9',  fieldType: 'ファイル',         hasDisplayCondition: true },
    { caseNo: '850-10', fieldType: '他テーブル参照',   hasDisplayCondition: true },
    { caseNo: '850-11', fieldType: '計算',             hasDisplayCondition: true },
    { caseNo: '850-12', fieldType: '固定テキスト',     hasDisplayCondition: false },
    { caseNo: '850-13', fieldType: '自動採番',         hasDisplayCondition: false },
];

// ファイルレベル: beforeAllで設定されるフィールドタイプ → overSettingボタンインデックスのマッピング
let _fieldIndexMap = null;

/**
 * ALLテストテーブルのフィールド編集ページで指定タイプのフィールドを探してダイアログを開く
 * @param {import('@playwright/test').Page} page
 * @param {string} fieldType - ダイアログのh5に表示されるフィールドタイプ名
 * @returns {boolean} - 見つかったかどうか
 */
async function openFieldDialogByType(page, fieldType) {
    // マッピングが利用可能であれば直接インデックスでクリック（高速）
    if (_fieldIndexMap !== null && _fieldIndexMap[fieldType] !== undefined) {
        const idx = _fieldIndexMap[fieldType];
        try {
            const overSettings = page.locator('.overSetting');
            await overSettings.nth(idx).scrollIntoViewIfNeeded().catch(() => {});
            await overSettings.nth(idx).click({ force: true });
            await waitForAngular(page);
            const heading = page.locator('.modal.show h5').filter({ hasText: fieldType });
            if (await heading.count() > 0) return true;
            // 失敗したら閉じてフォールバックへ
            await page.keyboard.press('Escape');
            await waitForAngular(page);
        } catch (e) {}
    }

    // フォールバック: page.evaluate内でループ（Playwrightオーバーヘッドなし・高速）
    const foundIdx = await page.evaluate(async (targetType) => {
        const buttons = document.querySelectorAll('.overSetting');
        for (let i = 0; i < buttons.length; i++) {
            // 既にモーダルが開いていれば閉じる
            const openModal = document.querySelector('.modal.show');
            if (openModal) {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                await new Promise(r => setTimeout(r, 150));
            }
            buttons[i].scrollIntoView({ block: 'center' });
            buttons[i].click();
            await new Promise(r => setTimeout(r, 400));

            const modal = document.querySelector('.modal.show');
            if (!modal) continue;

            const h5 = modal.querySelector('h5');
            if (h5 && h5.textContent?.trim() === targetType) {
                return i; // 見つかった - モーダルを開いたまま返す
            }

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
            await new Promise(r => setTimeout(r, 150));
        }
        return -1;
    }, fieldType);

    return foundIdx >= 0;
}

test.describe('フィールド追加オプション（表示条件）- 850系', () => {
    test.describe.configure({ timeout: 120000 });

    let tableId = null;
    let editUrl = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(480000);
        const { context, page } = await createAuthContext(browser);
        await closeTemplateModal(page);

        // getAllTypeTableId でテーブルID取得（global-setupで作成済み）
        tableId = await getAllTypeTableId(page);

        if (tableId) {
            editUrl = `${BASE_URL}/admin/dataset/edit/${tableId}`;

            // フィールドタイプ → overSettingボタンインデックスのマッピングを一括取得
            // （各テストで毎回ループせず、1回だけ実行してキャッシュ）
            await page.goto(editUrl);
            await page.waitForSelector('.overSetting', { timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            _fieldIndexMap = await page.evaluate(async () => {
                const map = {};
                const buttons = document.querySelectorAll('.overSetting');
                for (let i = 0; i < buttons.length; i++) {
                    // 既にモーダルが開いていれば閉じる
                    const openModal = document.querySelector('.modal.show');
                    if (openModal) {
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                        await new Promise(r => setTimeout(r, 150));
                    }
                    buttons[i].scrollIntoView({ block: 'center' });
                    buttons[i].click();
                    await new Promise(r => setTimeout(r, 400));

                    const modal = document.querySelector('.modal.show');
                    if (!modal) continue;

                    const h5 = modal.querySelector('h5');
                    const type = h5?.textContent?.trim();
                    if (type && map[type] === undefined) {
                        map[type] = i;
                    }

                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
                    await new Promise(r => setTimeout(r, 150));
                }
                return map;
            });

            console.log(`[beforeAll] fieldIndexMap: ${JSON.stringify(_fieldIndexMap)}`);
        }

        console.log(`[beforeAll] tableId=${tableId}, editUrl=${editUrl}`);
        await context.close();
    });

    test.beforeEach(async ({ page }) => {
        await login(page);
        await closeTemplateModal(page);
    });

    // 各フィールドタイプの表示条件確認テストを動的に生成
    for (const { caseNo, fieldType, hasDisplayCondition } of FIELD_TYPES) {
        test(`${caseNo}: ${fieldType}フィールドの追加オプション（表示条件）UIが確認できること`, async ({ page }) => {
            test.setTimeout(120000);

            expect(editUrl, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();

            await page.goto(editUrl);
            await page.waitForLoadState('domcontentloaded');
            await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
            // Angular アプリの読み込み完了を待つ
            await page.waitForSelector('.overSetting', { timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // 対象フィールドタイプのダイアログを開く
            const found = await openFieldDialogByType(page, fieldType);

            expect(found, `フィールドタイプ "${fieldType}" がALLテストテーブルに存在すること`).toBeTruthy();

            if (hasDisplayCondition) {
                // 「追加オプション設定」ボタンが表示されること（開いているモーダル内）
                const additionalOptionsBtn = page.locator('.modal.show button').filter({ hasText: '追加オプション設定' }).first();
                await expect(additionalOptionsBtn).toBeVisible({ timeout: 5000 });

                // 「追加オプション設定」をクリック
                await additionalOptionsBtn.click();
                await waitForAngular(page);

                // 「表示条件設定」セクションが存在することを確認（開いているモーダル内）
                const displayConditionSection = page.locator('.modal.show').locator('text=表示条件設定').first();
                await expect(displayConditionSection).toBeVisible({ timeout: 5000 });
                console.log(`${caseNo}: ${fieldType} - 表示条件設定セクション: 確認OK`);

                // 「条件追加」ボタンが存在すること（開いているモーダル内）
                const addConditionBtn = page.locator('.modal.show button').filter({ hasText: '条件追加' });
                const btnCount = await addConditionBtn.count();
                expect(btnCount).toBeGreaterThan(0);
                console.log(`${caseNo}: ${fieldType} - 条件追加ボタン: ${btnCount}個確認OK`);
            } else {
                // 自動採番・固定テキストなど: モーダルが正常に開いたことのみ確認（追加オプション設定なし）
                const modalH5 = page.locator('.modal.show h5').filter({ hasText: fieldType });
                const modalOpen = await modalH5.count() > 0;
                console.log(`${caseNo}: ${fieldType} - モーダル開閉確認: ${modalOpen}`);
                expect(modalOpen).toBe(true);
            }
        });
    }
});
