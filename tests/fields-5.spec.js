// @ts-check
// fields-5.spec.js: フィールドテスト Part 5 (全フィールドタイプ表示条件追加オプション確認 850系)
const { test, expect } = require('@playwright/test');
const { getAllTypeTableId, setupAllTypeTable } = require('./helpers/table-setup');
const { createAuthContext } = require('./helpers/auth-context');
const { ensureLoggedIn } = require('./helpers/ensure-login');

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

async function login(page) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded');
    await page.fill('#id', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 90000 });
    } catch (e) {
        if (page.url().includes('/admin/login')) {
            await page.waitForTimeout(1000);
            await page.fill('#id', EMAIL);
            await page.fill('#password', PASSWORD);
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 90000 });
        }
    }
    await page.waitForSelector('.navbar', { timeout: 30000 }).catch(() => {});
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

    // 既にモーダルが開いていれば閉じる
    const openModal = page.locator('.modal.show');
    if (await openModal.count() > 0) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
    }

    await overSettings.nth(idx).scrollIntoViewIfNeeded().catch(() => {});
    await overSettings.nth(idx).click({ force: true });
    await page.waitForTimeout(800);

    const heading = page.locator('.modal.show h5');
    if (await heading.count() === 0) return false;

    const text = await heading.first().textContent();
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
        // 閉じる
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
    }
    return false;
}

test.describe('フィールド追加オプション（表示条件）- 850系', () => {
    test.describe.configure({ timeout: 300000 });

    let tableId = null;
    let editUrl = null;
    let beforeAllFailed = false;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(360000);
        const { context, page } = await createAuthContext(browser);
        try {
            // about:blankではcookiesが送られないため、先にアプリURLに遷移
            await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            await closeTemplateModal(page);
            // setupAllTypeTable（ヘルパー）を使って確実にテーブルを取得・作成する
            const result = await setupAllTypeTable(page);
            if (result.tableId) {
                tableId = result.tableId;
                editUrl = `${BASE_URL}/admin/dataset/edit/${tableId}`;
                console.log(`[beforeAll] tableId=${tableId}, editUrl=${editUrl}`);
            } else {
                console.error('[beforeAll] テーブルID取得が失敗。テストはスキップされます。');
                beforeAllFailed = true;
            }
        } catch (e) {
            console.error(`[beforeAll] 例外: ${e.message}`);
            beforeAllFailed = true;
        }
        await context.close();
    });

    test.beforeEach(async ({ page }) => {
        test.skip(beforeAllFailed, 'beforeAllが失敗したためスキップ');
        await login(page);
        await closeTemplateModal(page);
    });

    for (const { caseNo, fieldType, hasDisplayCondition, labelKeywords } of FIELD_TYPES) {
        test(`${caseNo}: ${fieldType}フィールドの追加オプション（表示条件）UIが確認できること`, async ({ page }) => {
            test.setTimeout(300000);

            expect(editUrl, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();

            // ALLテストテーブルは102フィールドあるため読み込みに時間がかかる
            // 最大3回リトライし、各回で180秒まで待機
            for (let attempt = 0; attempt < 3; attempt++) {
                await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
                await page.waitForSelector('.navbar', { timeout: 60000 }).catch(() => {});
                const loaded = await page.waitForSelector('.overSetting', { timeout: 180000 }).then(() => true).catch(() => false);
                if (loaded) break;
                console.log(`[${caseNo}] .overSetting timeout (attempt ${attempt + 1}/3), リトライ`);
                await ensureLoggedIn(page);
                // ページを完全にリロードしてリトライ
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            }
            await waitForAngular(page);

            let found = false;

            if (fieldType === '固定テキスト') {
                // 固定テキストはlabelがないため特殊処理
                found = await findFixedTextField(page);
            } else {
                // フィールドラベルからoverSettingインデックスを高速特定
                const labelMap = await getFieldLabelMap(page);
                const idx = findIndexByLabel(labelMap, labelKeywords);
                console.log(`${caseNo}: labelMap lookup → index=${idx}`);

                if (idx >= 0) {
                    found = await openFieldDialogByIndex(page, idx, fieldType);
                }

                // フォールバック: 近い名前のフィールドを試す
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
                await expect(additionalOptionsBtn).toBeVisible({ timeout: 5000 });

                await additionalOptionsBtn.click();
                await waitForAngular(page);

                const displayConditionSection = page.locator('.modal.show').locator('text=表示条件設定').first();
                await expect(displayConditionSection).toBeVisible({ timeout: 5000 });
                console.log(`${caseNo}: ${fieldType} - 表示条件設定セクション: 確認OK`);

                const addConditionBtn = page.locator('.modal.show button').filter({ hasText: '条件追加' });
                const btnCount = await addConditionBtn.count();
                expect(btnCount).toBeGreaterThan(0);
                console.log(`${caseNo}: ${fieldType} - 条件追加ボタン: ${btnCount}個確認OK`);
            } else {
                const modalH5 = page.locator('.modal.show h5').filter({ hasText: fieldType });
                const modalOpen = await modalH5.count() > 0;
                console.log(`${caseNo}: ${fieldType} - モーダル開閉確認: ${modalOpen}`);
                expect(modalOpen).toBe(true);
            }
        });
    }
});
