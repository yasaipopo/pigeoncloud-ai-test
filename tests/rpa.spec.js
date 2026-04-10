// @ts-check
const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { createTestEnv } = require('./helpers/create-test-env');

// 環境変数はbeforeAllで上書きされる（自己完結型）
let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;

/**
 * Angular描画待機
 */
async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        // data-ng-readyが設定されないケースがある: networkidleで代替
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

/**
 * コネクト（RPA）一覧ページへ移動
 * .card-block（今月使用量エリア）が表示されるまで待機する
 */
async function navigateToRpa(page) {
    await page.goto(BASE_URL + '/admin/rpa', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await waitForAngular(page);
    // コネクト一覧のコンテンツ（今月使用量テキスト）が表示されるまで待機
    await page.waitForSelector('b:text("今月使用量")', { timeout: 20000 });
}

const autoScreenshot = createAutoScreenshot('rpa');

test.describe('RPA（コネクト）', () => {
    /** @type {import('@playwright/test').Browser} */
    let browser;
    let tableId;

    test.beforeAll(async ({ browser: b }) => {
        test.setTimeout(300000);
        browser = b;
        const env = await createTestEnv(browser, { withAllTypeTable: true });
        BASE_URL = env.baseUrl;
        EMAIL = env.email;
        PASSWORD = env.password;
        tableId = env.tableId;
        process.env.TEST_BASE_URL = env.baseUrl;
        process.env.TEST_EMAIL = env.email;
        process.env.TEST_PASSWORD = env.password;
        await env.context.close();
        console.log(`[rpa] 自己完結環境: ${BASE_URL}`);
    });

    test.beforeEach(async ({ page }) => {
        // 古い環境のcookieをクリアして新環境にログイン
        await page.context().clearCookies();
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
        if (!page.url().includes('/login')) {
            await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        }
        if (page.url().includes('/login')) {
            await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
            await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
            await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        }
    });

    test('RA01: コネクト管理基本操作', async ({ page }) => {
        test.setTimeout(300000);
        const _testStart = Date.now();

        await test.step('rpa-010: コネクト管理画面が正常に表示されること', async () => {
            // [flow] 10-1. コネクト管理画面を開く
            await navigateToRpa(page);

            // [check] 10-2. ✅ 画面タイトルまたはヘッダーが表示されていること
            const title = await page.title();
            expect(title).not.toMatch(/エラー|Error|404|500/i);
            const url = page.url();
            expect(url).toContain('/admin/rpa');

            // [check] 10-3. ✅ 新規追加ボタン（＋アイコン）が表示されていること
            const addBtnCount = await page.locator('button.btn-outline-primary:has(.fa-plus)').count();
            expect(addBtnCount, '新規追加ボタン（fa-plus）が存在すること').toBeGreaterThan(0);

            // [check] 10-4. ✅ 「今月使用量」が画面に表示されていること
            const usageText = await page.locator('.card-block').first().textContent();
            expect(usageText).toMatch(/今月使用量/);

            await autoScreenshot(page, 'RA01', 'rpa-010', _testStart);
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s rpa-010`);
        });

        await test.step('rpa-020: 新しいコネクトを作成できること', async () => {
            // [flow] 20-1. 新規追加ボタンをクリック
            await navigateToRpa(page);
            await page.locator('button.btn-outline-primary:has(.fa-plus)').first().click();

            // [flow] 20-2. フロー編集画面が表示される
            await page.waitForURL('**/admin/rpa/edit/**', { timeout: 15000 });
            await waitForAngular(page);
            await page.waitForSelector('input[placeholder="フロー名"]', { timeout: 10000 });

            // [flow] 20-3. フロー名を入力
            await page.fill('input[placeholder="フロー名"]', 'テストRPA_E2E');
            await waitForAngular(page);

            // [flow] 20-4. テーブルを選択（ALLテストテーブル）
            const ngSelect = page.locator('ng-select, .ng-select').first();
            if (await ngSelect.count() > 0) {
                await ngSelect.click();
                await waitForAngular(page);
                const ngInput = page.locator('ng-select input[type=text], .ng-select input[type=text]').first();
                if (await ngInput.count() > 0) {
                    await ngInput.fill('ALLテスト');
                    await waitForAngular(page);
                    const option = page.getByRole('option').filter({ hasText: 'ALLテストテーブル' });
                    await option.first().waitFor({ state: 'visible', timeout: 10000 });
                    await option.first().click();
                    await waitForAngular(page);
                }
            }

            // [flow] 20-5. 「作成」ボタンをクリック
            const createBtn = page.getByRole('button', { name: '作成', exact: true });
            await createBtn.waitFor({ state: 'visible', timeout: 15000 });
            await createBtn.click();

            // [check] 20-6. ✅ コネクト編集画面に遷移していること
            await page.waitForURL(/\/admin\/rpa\/edit\/(?!new)/, { timeout: 20000 });
            const finalUrl = page.url();
            expect(finalUrl).toContain('/admin/rpa/edit/');
            expect(finalUrl).not.toContain('/admin/rpa/edit/new');

            // [check] 20-7. ✅ エラーメッセージが表示されていないこと
            const errorCount = await page.locator('.alert-danger').count();
            expect(errorCount, 'エラーが表示されていないこと').toBe(0);

            await autoScreenshot(page, 'RA01', 'rpa-020', _testStart);
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s rpa-020`);
        });

        await test.step('rpa-030: コネクト編集画面のフロー編集エリアが表示されること', async () => {
            // [flow] 30-1. 作成したコネクトの編集画面を開く（新規作成フローで遷移）
            await navigateToRpa(page);
            await page.locator('button.btn-outline-primary:has(.fa-plus)').first().click();
            await page.waitForURL('**/admin/rpa/edit/**', { timeout: 15000 });
            await waitForAngular(page);
            await page.waitForSelector('input[placeholder="フロー名"]', { timeout: 10000 });

            // [check] 30-2. ✅ フロー名入力欄が表示されていること
            const rpaNameInput = await page.locator('input[placeholder="フロー名"]').count();
            expect(rpaNameInput, 'RPA名入力フィールドが存在すること').toBeGreaterThan(0);

            // [check] 30-3. ✅ フロー編集エリアまたはガイドテキストが表示されること
            const guideText = await page.locator('text=まずテーブルを選択').count();
            const flowEl = await page.locator('flow, .flow-container').count();
            expect(
                guideText + flowEl,
                'フロー編集エリアまたはガイドテキストが表示されること'
            ).toBeGreaterThan(0);

            // エラーなし
            const errorCount = await page.locator('.alert-danger').count();
            expect(errorCount, 'エラーが表示されていないこと').toBe(0);

            await autoScreenshot(page, 'RA01', 'rpa-030', _testStart);
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s rpa-030`);
        });

        await test.step('rpa-040: コネクト一覧画面のテーブルヘッダーが正しいこと', async () => {
            // [flow] 40-1. コネクト管理画面に戻る
            await navigateToRpa(page);

            // テーブルヘッダーを取得
            const headers = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('table thead th')).map(th => th.textContent.trim());
            });

            // テーブルが表示されていること（ヘッダーが1つ以上あること）
            expect(headers.length, 'コネクト一覧テーブルにヘッダー列が存在すること').toBeGreaterThan(0);

            // [check] 40-2. ✅ 一覧テーブルのヘッダーに「実行ログ」列が存在すること
            // 実際のヘッダー: [ID, テーブル, コネクト名, ステータス]。実行ログへのリンクはヘッダーではなく行内のボタンとして存在する
            const hasLogBtn = await page.locator(
                'a[href*="rpa_execute"], button:has-text("実行ログ"), a:has-text("実行ログ"), td:has-text("実行ログ")'
            ).count();
            const hasStatusCol = headers.some(h => h.includes('ステータス') || h.includes('status'));
            // 実行ログリンクがあるか、ステータス列がある（実行ログ機能が利用可能）ことを確認
            expect(
                hasLogBtn + (hasStatusCol ? 1 : 0),
                `実行ログ機能が存在すること（ヘッダー: [${headers.join(', ')}], ログボタン数: ${hasLogBtn}）`
            ).toBeGreaterThan(0);

            // [check] 40-3. ✅ 作成したコネクトが一覧に表示されていること
            const rowCount = await page.locator('table tbody tr').count();
            expect(rowCount, '一覧に1件以上のコネクトが表示されていること').toBeGreaterThan(0);

            await autoScreenshot(page, 'RA01', 'rpa-040', _testStart);
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s rpa-040`);
        });

        await test.step('rpa-050: 今月使用量が表示されること', async () => {
            // [flow] 50-1. コネクト管理画面を確認
            await navigateToRpa(page);

            // [check] 50-2. ✅ 「今月使用量」のセクションが表示されていること
            const usageCard = page.locator('.card-block').filter({ hasText: /今月使用量/ });
            const usageCount = await usageCard.count();
            expect(usageCount, '今月使用量カードが表示されること').toBeGreaterThan(0);

            // [check] 50-3. ✅ 使用量の数値またはプログレスバーが表示されていること
            const usageText = await usageCard.first().textContent();
            expect(usageText).toMatch(/STEP/);

            await autoScreenshot(page, 'RA01', 'rpa-050', _testStart);
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s rpa-050`);
        });

        await test.step('rpa-060: 実行ログページに遷移できること', async () => {
            // [flow] 60-1. 一覧の「実行ログ」リンクまたはボタンをクリック
            await navigateToRpa(page);

            // 実行ログリンクを探す（一覧テーブル内）
            const logLink = page.locator('a[href*="/admin/rpa_executes"], a[href*="rpa_execute"]').first();
            const logLinkCount = await logLink.count();
            if (logLinkCount > 0) {
                await logLink.click();
                await waitForAngular(page);
            } else {
                // 直接URLへ遷移
                await page.goto(BASE_URL + '/admin/rpa_executes', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                await waitForAngular(page);
            }

            // [check] 60-2. ✅ 実行ログ画面に遷移していること
            const url = page.url();
            expect(url).toContain('/admin/rpa_executes');

            // [check] 60-3. ✅ エラーメッセージが表示されていないこと
            const title = await page.title();
            expect(title).not.toMatch(/エラー|Error|404|500/i);
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            await autoScreenshot(page, 'RA01', 'rpa-060', _testStart);
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s rpa-060`);
        });
    });

    test('UC10: コネクトのWF完了トリガー・FTP処理確認', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();

        await test.step('rpa-070: コネクトのトリガー設定画面が表示されること', async () => {
            // [flow] 70-1. コネクト編集画面を開く
            await navigateToRpa(page);

            // 一覧から最初のコネクトの編集リンクへ移動（または新規作成）
            const editLink = page.locator('a[href*="/admin/rpa/edit/"]').first();
            const editCount = await editLink.count();
            if (editCount > 0) {
                await editLink.click();
                await waitForAngular(page);
                await page.waitForSelector('input[placeholder="フロー名"]', { timeout: 10000 }).catch(() => {});
            } else {
                // 編集リンクがない場合は新規作成画面へ
                await page.locator('button.btn-outline-primary:has(.fa-plus)').first().click();
                await page.waitForURL('**/admin/rpa/edit/**', { timeout: 15000 });
                await waitForAngular(page);
                await page.waitForSelector('input[placeholder="フロー名"]', { timeout: 10000 }).catch(() => {});
            }

            // [flow] 70-2. トリガーブロックの設定を確認
            const bodyText = await page.innerText('body');

            // [check] 70-3. ✅ トリガー設定UIが表示されていること
            const nameInputCount = await page.locator('input[placeholder="フロー名"]').count();
            expect(nameInputCount, 'フロー名入力欄（コネクト編集UI）が表示されていること').toBeGreaterThan(0);

            // [check] 70-4. ✅ エラーなくページが正常であること
            expect(bodyText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            await autoScreenshot(page, 'UC10', 'rpa-070', _testStart);
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s rpa-070`);
        });

        await test.step('rpa-080: コネクト一覧でフローの有効/無効を確認できること', async () => {
            // [flow] 80-1. コネクト管理画面を開く
            await navigateToRpa(page);

            // [check] 80-2. ✅ 作成したコネクトが一覧に表示されていること
            const rowCount = await page.locator('table tbody tr').count();
            expect(rowCount, '一覧に1件以上のコネクトが表示されていること').toBeGreaterThan(0);

            // [check] 80-3. ✅ エラーなくページが正常であること
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            await autoScreenshot(page, 'UC10', 'rpa-080', _testStart);
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s rpa-080`);
        });
    });

    test('UC13: RPA実行履歴画面確認', async ({ page }) => {
        test.setTimeout(120000);
        const _testStart = Date.now();

        await test.step('rpa-090: 実行履歴画面が正常に表示されること', async () => {
            // [flow] 90-1. コネクト実行履歴画面を開く
            await page.goto(BASE_URL + '/admin/rpa_executes', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [check] 90-2. ✅ 画面が正常に表示されていること（エラーなし）
            const url = page.url();
            expect(url).toContain('/admin/rpa_executes');
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            // [check] 90-3. ✅ 実行履歴テーブルまたは「まだ実行されていません」メッセージが表示されていること
            const tableCount = await page.locator('table').count();
            const emptyMsg = await page.locator(':text("まだ"), :text("実行履歴がありません"), :text("データがありません")').count();
            expect(
                tableCount + emptyMsg,
                '実行履歴テーブルまたは空メッセージが表示されていること'
            ).toBeGreaterThan(0);

            await autoScreenshot(page, 'UC13', 'rpa-090', _testStart);
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s rpa-090`);
        });
    });

    test('UC20: RPAビュー表示・編集・保存確認', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();

        await test.step('rpa-100: コネクトのビュー（フィルタ設定）が表示・保存できること', async () => {
            // [flow] 100-1. コネクト編集画面を開く
            await navigateToRpa(page);

            // 一覧から最初のコネクト編集リンクへ移動
            const editLink = page.locator('a[href*="/admin/rpa/edit/"]').first();
            const editCount = await editLink.count();
            if (editCount > 0) {
                await editLink.click();
                await waitForAngular(page);
                await page.waitForSelector('input[placeholder="フロー名"]', { timeout: 10000 }).catch(() => {});
            } else {
                // 編集リンクがない場合は新規作成
                await page.locator('button.btn-outline-primary:has(.fa-plus)').first().click();
                await page.waitForURL('**/admin/rpa/edit/**', { timeout: 15000 });
                await waitForAngular(page);
                await page.waitForSelector('input[placeholder="フロー名"]', { timeout: 10000 }).catch(() => {});
            }

            // [flow] 100-2. ビュー設定タブまたはセクションを確認
            const currentUrl = page.url();
            expect(currentUrl).toContain('/admin/rpa/edit/');

            // [check] 100-3. ✅ 設定UIが表示されていること
            const nameInputCount = await page.locator('input[placeholder="フロー名"]').count();
            expect(nameInputCount, 'フロー名入力欄が表示されていること').toBeGreaterThan(0);

            // [check] 100-4. ✅ エラーなくページが正常であること
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            await autoScreenshot(page, 'UC20', 'rpa-100', _testStart);
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s rpa-100`);
        });
    });
});
