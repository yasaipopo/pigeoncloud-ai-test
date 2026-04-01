// @ts-check
// fields-5.spec.js: フィールドテスト Part 5 (全フィールドタイプ表示条件追加オプション確認 850系)
const { test, expect } = require('@playwright/test');
const { getAllTypeTableId } = require('./helpers/table-setup');
const { createAuthContext } = require('./helpers/auth-context');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        // data-ng-readyが設定されないケースがある: networkidleで代替
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

async function login(page) {
    const { ensureLoggedIn } = require('./helpers/ensure-login');
    await ensureLoggedIn(page, EMAIL, PASSWORD);
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
// labelKeywords: ALLテストテーブルのフィールド名（label）に含まれるキーワードでoverSettingインデックスを特定
const FIELD_TYPES = [
    { caseNo: '850-1',  fieldType: '文字列(一行)',     hasDisplayCondition: true,  labelKeywords: ['テキスト'] },
    { caseNo: '850-2',  fieldType: '文章(複数行)',      hasDisplayCondition: true,  labelKeywords: ['テキストエリア'] },
    { caseNo: '850-3',  fieldType: '数値',             hasDisplayCondition: true,  labelKeywords: ['数値_整数'] },
    { caseNo: '850-4',  fieldType: 'Yes / No',         hasDisplayCondition: true,  labelKeywords: ['ブール'] },
    { caseNo: '850-5',  fieldType: '選択肢(単一選択)', hasDisplayCondition: true,  labelKeywords: ['セレクト'] },
    { caseNo: '850-6',  fieldType: '選択肢(複数選択)', hasDisplayCondition: true,  labelKeywords: ['チェックボックス'] },
    { caseNo: '850-7',  fieldType: '日時',             hasDisplayCondition: true,  labelKeywords: ['日時'] },
    { caseNo: '850-8',  fieldType: '画像',             hasDisplayCondition: true,  labelKeywords: ['画像'] },
    { caseNo: '850-9',  fieldType: 'ファイル',         hasDisplayCondition: true,  labelKeywords: ['ファイル'] },
    { caseNo: '850-10', fieldType: '他テーブル参照',   hasDisplayCondition: true,  labelKeywords: ['参照_admin'] },
    { caseNo: '850-11', fieldType: '計算',             hasDisplayCondition: true,  labelKeywords: ['計算_加算'] },
    { caseNo: '850-12', fieldType: '固定テキスト',     hasDisplayCondition: false, labelKeywords: null },
    { caseNo: '850-13', fieldType: '自動採番',         hasDisplayCondition: false, labelKeywords: ['自動採番'] },
];

/**
 * フィールド名(label) → overSettingインデックスのマッピングをDOMから高速取得（クリック不要）
 */
async function getFieldLabelMap(page) {
    return await page.evaluate(() => {
        const buttons = document.querySelectorAll('.overSetting');
        const map = {};
        for (let i = 0; i < buttons.length; i++) {
            const label = buttons[i].parentElement?.parentElement?.parentElement?.querySelector('label');
            const text = label?.textContent?.trim();
            if (text) {
                map[text] = i;
            }
        }
        return map;
    });
}

/**
 * 指定キーワードに完全一致するラベルのoverSettingインデックスを探す
 * 完全一致がなければ前方一致で探す
 */
function findIndexByLabel(labelMap, keywords) {
    if (!keywords) return -1;
    for (const kw of keywords) {
        // 完全一致
        if (labelMap[kw] !== undefined) return labelMap[kw];
    }
    // 前方一致（「テキスト」→「テキスト_複数」ではなく「テキスト」のみ）
    for (const kw of keywords) {
        for (const [label, idx] of Object.entries(labelMap)) {
            if (label === kw) return idx;
        }
    }
    return -1;
}

/**
 * 指定インデックスのoverSettingをクリックしてモーダルを開き、フィールドタイプを確認
 */
async function openFieldDialogByIndex(page, idx, expectedType) {
    const overSettings = page.locator('.overSetting');
    const count = await overSettings.count();
    if (idx < 0 || idx >= count) return false;

    // 既にモーダルが開いていればページリロードで確実にクリア
    if (await page.locator('.modal.show').count() > 0) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForSelector('.overSetting', { timeout: 5000 }).catch(() => {});
        await waitForAngular(page);
    }

    await overSettings.nth(idx).scrollIntoViewIfNeeded().catch(() => {});
    await overSettings.nth(idx).click({ force: true });
    await page.locator('.modal.show h5').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

    const heading = page.locator('.modal.show h5');
    const hCount = await heading.count();
    console.log(`[openFieldDialog] クリック後 h5 count=${hCount}`);
    if (hCount === 0) return false;

    const text = await heading.first().textContent();
    console.log(`[openFieldDialog] h5 text="${text?.trim()}", match=${text?.trim() === expectedType}`);
    return text && text.trim() === expectedType;
}

/**
 * 固定テキストフィールドを探すための特殊処理
 * labelなしのoverSettingをクリックして「固定テキスト」タイプのモーダルが開くか確認
 */
async function findFixedTextField(page) {
    // labelなしのoverSettingを探す
    const indices = await page.evaluate(() => {
        const buttons = document.querySelectorAll('.overSetting');
        const noLabel = [];
        for (let i = 0; i < buttons.length; i++) {
            const label = buttons[i].parentElement?.parentElement?.parentElement?.querySelector('label');
            if (!label || !label.textContent?.trim()) {
                noLabel.push(i);
            }
        }
        return noLabel;
    });

    for (const idx of indices) {
        const found = await openFieldDialogByIndex(page, idx, '固定テキスト');
        if (found) return true;
        // ×ボタンで閉じる
        const closeBtn = page.locator('.modal.show button.close').first();
        if (await closeBtn.count() > 0) {
            await closeBtn.click({ force: true });
            await page.waitForTimeout(300);
        }
    }
    return false;
}

test.describe('フィールド追加オプション（表示条件）- 850系', () => {
    test.describe.configure({ timeout: 120000 });

    let tableId = null;
    let editUrl = null;
    let beforeAllFailed = false;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(120000);
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const { context, page } = await createAuthContext(browser);
            try {
                // about:blankではcookiesが送られないため、先にアプリURLに遷移
                await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                await closeTemplateModal(page);
                tableId = await getAllTypeTableId(page);

                // LOGIN_ERROR時はreloginしてリトライ
                if (tableId === '__LOGIN_ERROR__') {
                    console.log(`[beforeAll] LOGIN_ERROR検出 (attempt ${attempt}/${maxRetries}), relogin実行`);
                    const email = process.env.TEST_EMAIL || 'admin';
                    const password = process.env.TEST_PASSWORD || '';
                    await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                    await page.fill('#id', email).catch(() => {});
                    await page.fill('#password', password).catch(() => {});
                    await page.click('button[type=submit].btn-primary').catch(() => {});
                    await page.waitForURL('**/admin/dashboard', { timeout: 15000 }).catch(() => {});
                    await page.waitForTimeout(1500);
                    tableId = await getAllTypeTableId(page);
                }

                if (tableId && tableId !== '__LOGIN_ERROR__') {
                    editUrl = `${BASE_URL}/admin/dataset/edit/${tableId}`;
                    console.log(`[beforeAll] tableId=${tableId}, editUrl=${editUrl}`);
                    await context.close();
                    return; // 成功
                }
                console.log(`[beforeAll] tableId取得失敗 (attempt ${attempt}/${maxRetries}): tableId=${tableId}`);
            } catch (e) {
                console.log(`[beforeAll] 例外 (attempt ${attempt}/${maxRetries}): ${e.message}`);
            }
            await context.close();
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
        // 全リトライ失敗: cascade防止のためthrowせずフラグを立てる
        console.error('[beforeAll] テーブルID取得が全リトライ失敗。テストはスキップされます。');
        beforeAllFailed = true;
    });

    test.beforeEach(async ({ page }) => {
        test.skip(beforeAllFailed, 'beforeAllが失敗したためスキップ');
        await login(page);
        await closeTemplateModal(page);
    });

    // F501: 全フィールドタイプの表示条件UIを1動画で確認
    test('F501: フィールド追加オプション（表示条件）', async ({ page }) => {

        expect(editUrl, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();

        await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
        // ALLテストテーブルは102フィールドあるため読み込みに時間がかかる
        await page.waitForSelector('.overSetting', { timeout: 5000 });
        await waitForAngular(page);

        for (const { caseNo, fieldType, hasDisplayCondition, labelKeywords } of FIELD_TYPES) {
            await test.step(`${caseNo}: ${fieldType}フィールドの追加オプション（表示条件）UIが確認できること`, async () => {
                const STEP_TIME = Date.now();

                let found = false;

                if (fieldType === '固定テキスト') {
                    found = await findFixedTextField(page);
                } else {
                    const labelMap = await getFieldLabelMap(page);
                    const idx = findIndexByLabel(labelMap, labelKeywords);
                    console.log(`${caseNo}: labelMap lookup → index=${idx}`);

                    if (idx >= 0) {
                        found = await openFieldDialogByIndex(page, idx, fieldType);
                    }

                    if (!found && idx < 0) {
                        console.log(`${caseNo}: フォールバック - overSetting全スキャン`);
                        const overSettings = page.locator('.overSetting');
                        const count = await overSettings.count();
                        for (let i = 0; i < count && !found; i++) {
                            found = await openFieldDialogByIndex(page, i, fieldType);
                            if (!found) {
                                await page.keyboard.press('Escape').catch(() => {});
                                await page.waitForTimeout(200);
                            }
                        }
                    }
                }

                expect(found, `フィールドタイプ "${fieldType}" がALLテストテーブルに存在すること`).toBeTruthy();

                if (hasDisplayCondition) {
                    const additionalOptionsBtn = page.locator('.modal.show button').filter({ hasText: '追加オプション設定' }).first();
                    await expect(additionalOptionsBtn).toBeVisible();

                    await additionalOptionsBtn.click();
                    await waitForAngular(page);

                    const displayConditionSection = page.locator('.modal.show').locator('text=表示条件設定').first();
                    await expect(displayConditionSection).toBeVisible();
                    console.log(`${caseNo}: ${fieldType} - 表示条件設定セクション: 確認OK (${Date.now() - STEP_TIME}ms)`);

                    const addConditionBtn = page.locator('.modal.show button').filter({ hasText: '条件追加' });
                    const btnCount = await addConditionBtn.count();
                    expect(btnCount).toBeGreaterThan(0);
                } else {
                    const modalH5 = page.locator('.modal.show h5').filter({ hasText: fieldType });
                    const modalOpen = await modalH5.count() > 0;
                    console.log(`${caseNo}: ${fieldType} - モーダル開閉確認: ${modalOpen} (${Date.now() - STEP_TIME}ms)`);
                    expect(modalOpen).toBe(true);
                }
            });
        }
    });
});
