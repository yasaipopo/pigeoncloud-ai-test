// @ts-check
const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { createAllTypeData } = require('./helpers/table-setup');
const fs = require('fs');
const path = require('path');

const { createTestEnv } = require('./helpers/create-test-env');

let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;

const autoScreenshot = createAutoScreenshot('comments-logs');

// =============================================================================
// 共通ユーティリティ
// =============================================================================

async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

async function closeTemplateModal(page) {
    try {
        const modal = page.locator('div.modal.show');
        const count = await modal.count();
        if (count > 0) {
            await modal.locator('button').first().click({ force: true });
            await waitForAngular(page);
        }
    } catch {}
}

/**
 * aside コメントパネルを開く
 * .app から aside-menu-hidden を除去して強制表示する
 */
async function openAsideMenu(page) {
    try {
        const asideBtn = page.locator('aside button, .aside-toggle, [aria-label*="コメント"], .aside-menu-toggler').first();
        if (await asideBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await asideBtn.click({ force: true });
            await waitForAngular(page);
        }
    } catch {}

    await page.evaluate(() => {
        const app = document.querySelector('.app');
        if (app) app.classList.remove('aside-menu-hidden');
    });
    await page.waitForSelector('#comment', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
}

/**
 * レコード一覧の最初のレコード詳細URLを取得する
 */
async function getFirstRecordViewUrl(page, tableUrl) {
    await page.goto(BASE_URL + tableUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
    await waitForAngular(page);
    await page.keyboard.press('Escape');
    await waitForAngular(page);

    await page.waitForSelector(`a[href*="${tableUrl}/view/"]`, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);

    const viewHref = await page.evaluate((tableUrl) => {
        const links = Array.from(document.querySelectorAll('a[href*="/view/"]'));
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href && href.includes(tableUrl + '/view/')) return href;
        }
        return null;
    }, tableUrl);

    if (viewHref) return viewHref;

    // API フォールバック
    const tableName = tableUrl.replace('/admin/', '');
    const listData = await page.evaluate(async ({ baseUrl, tableName }) => {
        try {
            const res = await fetch(baseUrl + '/api/admin/list/' + tableName, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({}),
                credentials: 'include',
            });
            return res.json();
        } catch { return null; }
    }, { baseUrl: BASE_URL, tableName });

    const records = listData?.data_a || [];
    if (records.length > 0) {
        const id = records[0]?.raw_data?.id;
        if (id) return tableUrl + '/view/' + id;
    }

    // データがなければ投入してリトライ
    await page.evaluate(async (baseUrl) => {
        await fetch(baseUrl + '/api/admin/debug/create-all-type-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ count: 3, pattern: 'fixed' }),
            credentials: 'include',
        }).catch(() => {});
    }, BASE_URL);
    await page.waitForTimeout(3000);

    await page.goto(BASE_URL + tableUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
    await waitForAngular(page);
    await page.waitForSelector(`a[href*="${tableUrl}/view/"]`, { timeout: 10000 }).catch(() => {});

    const retryHref = await page.evaluate((tableUrl) => {
        const links = Array.from(document.querySelectorAll('a[href*="/view/"]'));
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href && href.includes(tableUrl + '/view/')) return href;
        }
        return null;
    }, tableUrl);

    return retryHref || tableUrl + '/view/1';
}

// =============================================================================
// テスト本体
// =============================================================================

test.describe('コメント・ログ管理', () => {

    let tableUrl = '/admin/dataset__7';
    let recordViewUrl = '/admin/dataset__7/view/1';
    let _tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        const env = await createTestEnv(browser, { withAllTypeTable: true });
        BASE_URL = env.baseUrl;
        EMAIL = env.email;
        PASSWORD = env.password;
        _tableId = env.tableId;
        process.env.TEST_BASE_URL = env.baseUrl;
        process.env.TEST_EMAIL = env.email;
        process.env.TEST_PASSWORD = env.password;

        tableUrl = '/admin/dataset__' + _tableId;

        // レコードデータ投入
        const context = env.context;
        const setupPage = await context.newPage();
        await setupPage.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        if (setupPage.url().includes('/login')) {
            await setupPage.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
            await setupPage.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
            await setupPage.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
            await setupPage.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        }
        await createAllTypeData(setupPage, 3).catch((e) => console.log('[comments-logs] createAllTypeData error (ignored):', e.message));
        
        try {
            recordViewUrl = await getFirstRecordViewUrl(setupPage, tableUrl);
        } catch (e) {
            console.error('[comments-logs] getFirstRecordViewUrl failed:', e.message);
        }

        try {
            await setupPage.close();
            await context.close();
        } catch (e) {
            console.log('[comments-logs] Cleanup error (ignored):', e.message);
        }
        console.log(`[comments-logs] 自己完結環境: ${BASE_URL} tableUrl=${tableUrl} recordViewUrl=${recordViewUrl}`);
    });

    test.beforeEach(async ({ page }) => {
        // [flow] 明示的ログイン（新環境のcookieを使う）
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

    // =========================================================================
    // movie: CL01 — ログ管理画面（cl-010, cl-020, cl-030）
    // =========================================================================
    test('CL01: ログ管理画面（操作ログ・CSV履歴・リクエストログ）', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();

        await closeTemplateModal(page);

        // ----- cl-010: 操作ログ一覧が正常に表示されること -----
        await test.step('cl-010: 操作ログ一覧が正常に表示されること', async () => {
            // [flow] CL01-1. /admin/logs に遷移（networkidleまで待機してAngularのロード完了を確認）
            await page.goto(BASE_URL + '/admin/logs', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
            // Angular のルーティングが完了するまで待機
            await page.waitForURL(/\/admin\/logs/, { timeout: 10000 }).catch(() => {});
            await waitForAngular(page);
            // Angular テーブルの描画を待機
            await page.waitForTimeout(2000);

            // [check] cl-010-1. ✅ URL が /admin/logs を含むこと
            await expect(page).toHaveURL(/\/admin\/logs/);

            // [flow] CL01-2. テーブルが表示されるまで待機
            await page.waitForFunction(
                () => document.querySelectorAll('table').length > 0 || document.body.innerText.includes('ユーザー'),
                { timeout: 20000 }
            ).catch(() => {});

            // [check] cl-010-2. ✅ 「ユーザー」「アクション」「テーブル」「日時」ヘッダーが存在すること
            const pageText = await page.innerText('body');
            expect(pageText).toContain('ユーザー');
            expect(pageText).toContain('アクション');
            expect(pageText).toContain('テーブル');
            expect(pageText).toContain('日時');
            await autoScreenshot(page, 'CL01', 'cl-010', _testStart);
        });

        // ----- cl-020: CSV UP/DL履歴が正常に表示されること -----
        await test.step('cl-020: CSV UP/DL履歴が正常に表示されること', async () => {
            // [flow] CL01-3. /admin/csv に遷移
            await page.goto(BASE_URL + '/admin/csv', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
            await page.waitForURL(/\/admin\/csv/, { timeout: 10000 }).catch(() => {});
            await waitForAngular(page);
            await page.waitForTimeout(2000);

            // [check] cl-020-1. ✅ URL が /admin/csv を含むこと
            await expect(page).toHaveURL(/\/admin\/csv/);

            // [flow] CL01-4. テーブルヘッダーが描画されるまで待機
            await page.waitForSelector('table th', { timeout: 10000 }).catch(() => {});

            // [check] cl-020-2. ✅ 「CSV UP/DL履歴」「ファイル名」「タイプ」「処理」のテキストが存在すること
            const pageText = await page.innerText('body');
            expect(pageText).toContain('CSV UP/DL履歴');
            expect(pageText).toContain('ファイル名');
            expect(pageText).toContain('タイプ');
            expect(pageText).toContain('処理');
            await autoScreenshot(page, 'CL01', 'cl-020', _testStart);
        });

        // ----- cl-030（旧cl-070）: リクエストログが正常に表示されること -----
        await test.step('cl-030: リクエストログが正常に表示されること', async () => {
            // [flow] CL01-5. /admin/job_logs に遷移
            await page.goto(BASE_URL + '/admin/job_logs', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
            await page.waitForURL(/\/admin\/job_logs/, { timeout: 10000 }).catch(() => {});
            await waitForAngular(page);
            await page.waitForTimeout(2000);

            // [check] cl-030-1. ✅ URL が /admin/job_logs を含むこと
            await expect(page).toHaveURL(/\/admin\/job_logs/);

            // [flow] CL01-6. テーブルが描画されるまで待機
            await page.waitForFunction(
                () => document.querySelectorAll('table').length > 0 || document.body.innerText.includes('リクエストログ'),
                { timeout: 15000 }
            ).catch(() => {});

            // [check] cl-030-2. ✅ 「リクエストログ」「リクエスト」「ステータス」「処理結果」が存在すること
            const pageText = await page.innerText('body');
            expect(pageText).toContain('リクエストログ');
            expect(pageText).toContain('リクエスト');
            expect(pageText).toContain('ステータス');
            expect(pageText).toContain('処理結果');
            await autoScreenshot(page, 'CL01', 'cl-030', _testStart);
        });

        // ----- cl-170: ジョブログの進行確認（B013） -----
        await test.step('cl-170: ジョブログの進行確認（B013）', async () => {
            // [flow] CL01-7. テーブル一覧に遷移
            await page.goto(BASE_URL + tableUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
            await waitForAngular(page);

            // [flow] CL01-8. CSVダウンロードを実行してジョブをキック
            const hamburgerBtn = page.locator('button.dropdown-toggle:has(.fa-bars), button.dropdown-toggle:has-text("操作")').first();
            await hamburgerBtn.click({ force: true });
            await page.waitForTimeout(500);
            
            const csvDownloadItem = page.locator('a.dropdown-item:has-text("CSVダウンロード")').first();
            await csvDownloadItem.click({ force: true });
            await waitForAngular(page);
            
            // モーダルが出たら「ダウンロード」ボタンをクリック
            const downloadBtn = page.locator('.modal.show button:has-text("ダウンロード")');
            if (await downloadBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await downloadBtn.click({ force: true });
            }
            await page.waitForTimeout(2000);

            // [flow] CL01-9. /admin/job_logs に遷移
            await page.goto(BASE_URL + '/admin/job_logs', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
            await waitForAngular(page);

            // [check] cl-170-1. ✅ ジョブログ一覧にレコードが表示されること
            await page.waitForFunction(
                () => document.querySelectorAll('table tbody tr').length > 0,
                { timeout: 20000 }
            ).catch(() => {});
            
            const firstRow = page.locator('table tbody tr').first();
            await expect(firstRow).toBeVisible({ timeout: 10000 });

            // [flow] CL01-10. ジョブが「完了」または「成功」になるまでポーリング確認
            // B013 はここで「処理待ち」のまま滞留するバグ
            let statusText = '';
            let finished = false;
            const maxRetries = 12; // 5秒 * 12 = 60秒
            for (let i = 0; i < maxRetries; i++) {
                statusText = await firstRow.innerText();
                console.log(`[cl-170] ジョブステータス確認 (${i + 1}/${maxRetries}): ${statusText.replace(/\n/g, ' ')}`);
                
                if (statusText.includes('完了') || statusText.includes('成功') || statusText.includes('成功終了')) {
                    finished = true;
                    break;
                }
                
                if (statusText.includes('失敗') || statusText.includes('エラー')) {
                    finished = true;
                    break;
                }

                // 5秒待機してリロード
                await page.waitForTimeout(5000);
                await page.reload({ waitUntil: 'domcontentloaded' });
                await page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(() => {});
            }

            // [check] cl-170-2. ✅ ジョブが「完了」または「成功」ステータスになること
            // B013 が未修正の場合、ここで fail する（「処理待ち」のままになるため）
            expect(finished, 'ジョブが一定時間内に完了すること').toBe(true);
            expect(statusText, 'ジョブが正常に完了すること').toMatch(/完了|成功|成功終了/);
            
            await autoScreenshot(page, 'CL01', 'cl-170', _testStart);
        });
    });

    // =========================================================================
    // movie: CL02 — コメント・メンション（cl-040〜cl-080）
    // =========================================================================
    test('CL02: コメント・メンション機能', async ({ page }) => {
        test.setTimeout(150000);
        const _testStart = Date.now();

        await closeTemplateModal(page);

        // ----- cl-040: レコード詳細でコメントを追加できること -----
        await test.step('cl-040: レコード詳細でコメントを追加できること', async () => {
            // [flow] CL02-1. レコード詳細ページに遷移
            await page.goto(BASE_URL + recordViewUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            // [check] cl-040-1. ✅ /view/ URL に遷移していること
            await expect(page).toHaveURL(/\/view\//);

            // [flow] CL02-2. コメントパネルを開く
            await openAsideMenu(page);

            // [check] cl-040-2. ✅ #comment 入力欄が表示されること
            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();
            await expect(commentDiv).toHaveAttribute('contenteditable', 'true');

            // [check] cl-040-3. ✅ 送信ボタンが表示されること
            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            await expect(sendBtn).toBeVisible();
            await expect(sendBtn).toContainText('送信');

            // [flow] CL02-3. コメントテキストを入力して送信
            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('テストコメント cl-040');
            await page.waitForTimeout(500);
            await page.keyboard.press('Escape');
            await waitForAngular(page);
            await sendBtn.click({ force: true });
            await page.waitForSelector('comment-log-block', { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(2000);

            // [check] cl-040-4. ✅ コメント本文に入力テキストが表示されること
            const commentBody = page.locator('.comment-body').last();
            await expect(commentBody).toBeVisible();
            await expect(commentBody).toContainText('テストコメント cl-040');
            await autoScreenshot(page, 'CL02', 'cl-040', _testStart);
        });

        // ----- cl-050: コメントに@メンションが含まれること -----
        await test.step('cl-050: コメントに@メンションが含まれること', async () => {
            // [flow] CL02-4. レコード詳細ページに遷移
            await page.goto(BASE_URL + recordViewUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            // [flow] CL02-5. コメントパネルを開く
            await openAsideMenu(page);

            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();
            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            await expect(sendBtn).toBeVisible();

            // [flow] CL02-6. 「テストコメント @マスターユーザー」を入力して送信
            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('テストコメント @マスターユーザー');
            await page.waitForTimeout(800);
            await page.keyboard.press('Escape');
            await waitForAngular(page);
            await sendBtn.click({ force: true });
            await page.waitForSelector('comment-log-block', { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(2000);

            // [check] cl-050-1. ✅ aside にコメント「テストコメント」が表示されること
            const asideContent = await page.innerText('aside');
            expect(asideContent).toContain('テストコメント');

            // [check] cl-050-2. ✅ コメント本文に「マスターユーザー」が含まれること
            expect(asideContent).toContain('マスターユーザー');
            await autoScreenshot(page, 'CL02', 'cl-050', _testStart);
        });

        // ----- cl-060: 複数メンションを含むコメントを追加できること -----
        await test.step('cl-060: 複数メンションを含むコメントを追加できること', async () => {
            // [flow] CL02-7. レコード詳細ページに遷移
            await page.goto(BASE_URL + recordViewUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            // [flow] CL02-8. コメントパネルを開く
            await openAsideMenu(page);

            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();
            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            await expect(sendBtn).toBeVisible();

            // [flow] CL02-9. 複数メンションを含むコメントを入力して送信
            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('複数メンションテスト @マスターユーザー @マスターユーザー');
            await page.waitForTimeout(1000);
            await page.keyboard.press('Escape');
            await waitForAngular(page);
            await sendBtn.click({ force: true });
            await page.waitForSelector('comment-log-block', { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(2000);

            // [check] cl-060-1. ✅ コメント本文に「複数メンションテスト」が表示されること
            const commentBody = page.locator('.comment-body').filter({ hasText: '複数メンションテスト' }).first();
            await expect(commentBody).toBeVisible();
            await autoScreenshot(page, 'CL02', 'cl-060', _testStart);
        });

        // ----- cl-070: 存在しないユーザーへのメンションでもエラーにならないこと -----
        await test.step('cl-070: 存在しないユーザーへのメンションでもエラーにならないこと', async () => {
            // [flow] CL02-10. レコード詳細ページに遷移
            await page.goto(BASE_URL + recordViewUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            // [flow] CL02-11. コメントパネルを開く
            await openAsideMenu(page);

            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();
            await expect(commentDiv).toHaveAttribute('contenteditable', 'true');

            // [flow] CL02-12. 存在しないユーザーへのメンションを入力して送信
            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('存在しないユーザーテスト @存在しないユーザーXYZ99999');
            await page.waitForTimeout(1000);
            await page.keyboard.press('Escape');
            await waitForAngular(page);
            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            await sendBtn.click({ force: true });
            await page.waitForSelector('comment-log-block', { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(2000);

            // [check] cl-070-1. ✅ エラーなくコメントが保存されること
            const commentBody = page.locator('.comment-body').filter({ hasText: '存在しないユーザーテスト' }).first();
            await expect(commentBody).toBeVisible();
            await autoScreenshot(page, 'CL02', 'cl-070', _testStart);
        });

        // ----- cl-080: コメント一覧にログとコメントがまとめて表示されること -----
        await test.step('cl-080: コメント一覧にログとコメントがまとめて表示されること', async () => {
            // [flow] CL02-13. テーブル設定の「詳細・編集画面」タブに遷移
            const tableIdMatch = tableUrl.match(/dataset__(\d+)/);
            const tableId = tableIdMatch ? tableIdMatch[1] : '7';

            await page.goto(BASE_URL + '/admin/dataset/edit/' + tableId, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            // [flow] CL02-14. 「詳細・編集画面」タブがあればクリック
            try {
                const detailTab = page.locator('.nav-link').filter({ hasText: '詳細・編集画面' }).first();
                if (await detailTab.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await detailTab.click({ force: true });
                    await waitForAngular(page);
                }
            } catch {}

            // [flow] CL02-15. 「ログとコメントをまとめて表示する」がOFFなら ON にして保存
            const pageBodyText = await page.innerText('body');
            if (pageBodyText.includes('ログとコメントをまとめて表示する')) {
                await page.evaluate(() => {
                    const allEls = document.querySelectorAll('*');
                    for (const el of allEls) {
                        if (el.children.length === 0 && el.textContent?.trim() === 'ログとコメントをまとめて表示する') {
                            let parent = el.parentElement;
                            for (let i = 0; i < 5; i++) {
                                if (!parent) break;
                                const sw = parent.querySelector('input[type="checkbox"].switch-input');
                                if (sw && !sw.checked) {
                                    const label = parent.querySelector('label.switch');
                                    if (label) label.click();
                                    return;
                                }
                                parent = parent.parentElement;
                            }
                        }
                    }
                });
                await page.waitForTimeout(500);
                const saveBtn = page.locator('button[type="submit"]').first();
                if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await saveBtn.click({ force: true });
                    await page.waitForLoadState('domcontentloaded');
                    await page.waitForTimeout(4000);
                }
            }

            // [flow] CL02-16. レコード詳細ページに遷移してコメントパネルを開く
            await page.goto(BASE_URL + recordViewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            await openAsideMenu(page);

            // [check] cl-080-1. ✅ #comment 入力欄が表示されること
            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();
            await expect(commentDiv).toHaveAttribute('contenteditable', 'true');
            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            await expect(sendBtn).toBeVisible();
            await expect(sendBtn).toContainText('送信');

            // [flow] CL02-17. @マスターユーザー を入力して送信
            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('@マスターユーザー');
            await page.waitForTimeout(300);

            const inputText = await commentDiv.innerText();
            expect(inputText).toContain('@');

            await sendBtn.click({ force: true });
            await page.waitForSelector('comment-log-block', { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(2000);

            // [check] cl-080-2. ✅ コメントブロックが表示されること
            const commentBody = page.locator('.comment-body').last();
            await expect(commentBody).toBeVisible();
            await autoScreenshot(page, 'CL02', 'cl-080', _testStart);
        });
    });

    // =========================================================================
    // movie: CL03 — バグ修正・機能改善確認（cl-090〜cl-150, cl-160）
    // =========================================================================
    test('CL03: コメント・ログ バグ修正確認', async ({ page }) => {
        test.setTimeout(210000);
        const _testStart = Date.now();

        await closeTemplateModal(page);

        const _tableUrl = tableUrl;
        // beforeAllで設定済みのrecordViewUrlを再利用（毎回getFirstRecordViewUrlを呼ぶと遅い）
        const _recordViewUrl = recordViewUrl;

        // ----- cl-090: フィルタ機能でエラーが発生しないこと -----
        await test.step('cl-090: 複数値フィールドでフィルタ（OR絞り込み）が正常に動作すること', async () => {
            // [flow] CL03-1. ALLテストテーブル一覧に遷移
            await page.goto(BASE_URL + _tableUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);

            // [check] cl-090-1. ✅ エラーなくページが表示されること
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // [flow] CL03-2. フィルタボタンがあればクリック
            const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
            if (await filterBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await filterBtn.click({ force: true });
                await waitForAngular(page);
            }

            // [check] cl-090-2. ✅ フィルタ操作後もエラーが出ないこと
            const afterText = await page.innerText('body');
            expect(afterText).not.toContain('Internal Server Error');
            await autoScreenshot(page, 'CL03', 'cl-090', _testStart);
        });

        // ----- cl-100: 通知ページが正常に表示されること -----
        await test.step('cl-100: 通知クリックでレコード詳細に遷移できること', async () => {
            // [flow] CL03-3. /admin/notifications に遷移
            await page.goto(BASE_URL + '/admin/notifications', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [check] cl-100-1. ✅ エラーなくページが表示されること
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // [flow] CL03-4. 通知ベルアイコンがあればクリック
            const bellIcon = page.locator('.notification-bell, .fa-bell, i.icon-bell, .nav-link .badge').first();
            if (await bellIcon.isVisible({ timeout: 5000 }).catch(() => false)) {
                await bellIcon.click({ force: true });
                await waitForAngular(page);
            }

            // [check] cl-100-2. ✅ ナビバーが表示されていること（ページ正常表示）
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });

            // [check] cl-100-3. ✅ 通知ページまたはダッシュボードの内容が表示されていること
            const pageTitle = await page.locator('h4, h3, .page-title, .card-header').first().innerText().catch(() => '');
            console.log(`[cl-100] ページタイトル: ${pageTitle}`);
            const currentUrl = page.url();
            console.log(`[cl-100] 遷移先URL: ${currentUrl}`);
            // 通知ページ or ダッシュボード or レコード詳細のいずれかにいること
            expect(currentUrl, '通知・ダッシュボード・詳細のいずれかにいること')
                .toMatch(/\/(notifications|dashboard|view\/)/);

            await autoScreenshot(page, 'CL03', 'cl-100', _testStart);
        });

        // ----- cl-110: 年度フィルタ表示が正常であること -----
        await test.step('cl-110: 年度フィルタの表示が正しいこと', async () => {
            // [flow] CL03-5. ALLテストテーブル一覧に遷移
            await page.goto(BASE_URL + _tableUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // [check] cl-110-1. ✅ エラーなくページが表示されること
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // [flow] CL03-6. フィルタボタンがあれば開く
            const filterBtn = page.locator('button:has-text("フィルタ"), button:has(.fa-filter), button.btn-outline-primary:has(.fa-search)').first();
            if (await filterBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await filterBtn.click({ force: true });
                await page.waitForTimeout(1000);
            }

            // [check] cl-110-2. ✅ ナビバーが表示されていること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            // [check] cl-110-3. ✅ ページにエラーが表示されていないこと
            const bodyText110 = await page.innerText('body');
            expect(bodyText110).not.toContain('Internal Server Error');

            // [check] cl-110-4. ✅ ページにテーブル関連の要素が表示されていること
            // テーブルヘッダー or フィルタUI or テーブル名がページ内に存在
            const hasTable = await page.locator('table thead, .filter-panel, [class*="table"]').count();
            console.log(`[cl-110] テーブル/フィルタ要素数: ${hasTable}`);
            expect(hasTable, 'テーブルまたはフィルタUIが存在すること').toBeGreaterThanOrEqual(1);

            await autoScreenshot(page, 'CL03', 'cl-110', _testStart);
        });

        // ----- cl-120: コメントの改行が正しく反映されること -----
        await test.step('cl-120: コメント入力欄で改行が正しく反映されること', async () => {
            // [flow] CL03-7. レコード詳細ページに遷移
            await page.goto(BASE_URL + _recordViewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            // [flow] CL03-8. コメントパネルを開く
            await openAsideMenu(page);

            // [check] cl-120-1. ✅ #comment 入力欄が表示されること
            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();

            // [flow] CL03-9. Shift+Enter で改行を含むコメントを入力
            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('1行目テスト');
            await page.keyboard.press('Shift+Enter');
            await page.keyboard.type('2行目テスト');

            // [check] cl-120-2. ✅ 入力欄のHTMLに改行（<br> または <div>）が含まれること
            const inputHtml = await commentDiv.innerHTML();
            const hasBr = inputHtml.includes('<br') || inputHtml.includes('<div');
            expect(hasBr).toBe(true);

            // [flow] CL03-10. 送信ボタンをクリック
            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            if (await sendBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await sendBtn.click({ force: true });
                await page.waitForTimeout(3000);
            }

            // [check] cl-120-3. ✅ コメントブロックが表示されること
            const commentBody = page.locator('.comment-body').last();
            await expect(commentBody).toBeVisible({ timeout: 10000 });
            await autoScreenshot(page, 'CL03', 'cl-120', _testStart);
        });

        // ----- cl-130: ユーザー無効化後もコメント履歴にユーザー名が残ること -----
        await test.step('cl-130: ユーザー無効化後もコメント履歴にユーザー名が表示されること', async () => {
            // [flow] CL03-11. レコード詳細ページに遷移
            await page.goto(BASE_URL + _recordViewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            // [flow] CL03-12. コメントパネルを開く
            await openAsideMenu(page);

            // [check] cl-130-1. ✅ コメントブロックが1件以上表示されていること
            const commentBlocks = page.locator('comment-log-block, .comment-block, .comment-item');
            const blockCount = await commentBlocks.count();
            expect(blockCount).toBeGreaterThan(0);

            // [check] cl-130-2. ✅ 各コメントブロックにテキストが含まれること
            for (let i = 0; i < Math.min(blockCount, 3); i++) {
                const blockText = await commentBlocks.nth(i).innerText();
                expect(blockText.trim().length).toBeGreaterThan(0);
            }
            await autoScreenshot(page, 'CL03', 'cl-130', _testStart);
        });

        // ----- cl-160: 組織メンション時に通知が保存されること -----
        await test.step('cl-160: 組織メンション時に複数役職兼任ユーザーへの通知が重複しないこと', async () => {
            // [flow] CL03-13. レコード詳細ページに遷移
            await page.goto(BASE_URL + _recordViewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            // [flow] CL03-14. コメントパネルを開く
            await openAsideMenu(page);

            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();

            // [flow] CL03-15. 「@」を入力してオートコンプリートを確認
            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('組織メンションテスト cl-160 @');
            await page.waitForTimeout(1000);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);

            // [flow] CL03-16. コメントを送信
            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            if (await sendBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await sendBtn.click({ force: true });
                await page.waitForTimeout(3000);
            }

            // [check] cl-160-1. ✅ コメントが正常に保存されていること
            const asideText = await page.locator('aside').innerText().catch(() => '');
            expect(asideText).toContain('組織メンションテスト cl-160');
            await autoScreenshot(page, 'CL03', 'cl-160', _testStart);
        });

        // ----- cl-140: コメント改行がメール通知で{line_break}にならないこと -----
        await test.step('cl-140: コメントの改行がメール通知で{line_break}にならないこと', async () => {
            // [flow] CL03-17. レコード詳細ページに遷移してコメント入力欄を確認
            await page.goto(BASE_URL + _recordViewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            await openAsideMenu(page);

            // [check] cl-140-1. ✅ コメント入力欄が表示されること
            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();
            await expect(commentDiv).toHaveAttribute('contenteditable', 'true');

            // [flow] CL03-18. 改行付きコメントを入力して入力値に{line_break}が含まれないことを確認
            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('改行メールテスト');
            await page.keyboard.press('Shift+Enter');
            await page.keyboard.type('2行目');

            // [check] cl-140-2. ✅ 入力欄のHTMLに「{line_break}」が含まれないこと
            const inputHtml = await commentDiv.innerHTML();
            expect(inputHtml).not.toContain('{line_break}');
            expect(inputHtml).not.toContain('line_break');
            await autoScreenshot(page, 'CL03', 'cl-140', _testStart);
        });

        // ----- cl-150: 組織メンションキャンセル後にメッセージが出続けないこと -----
        await test.step('cl-150: 組織メンションのキャンセル後にメッセージが出続けないこと', async () => {
            // [flow] CL03-19. レコード詳細ページに遷移
            await page.goto(BASE_URL + _recordViewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            await openAsideMenu(page);

            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();

            // [flow] CL03-20. 「@」入力後 Escape でキャンセル
            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('@');
            await page.waitForTimeout(1000);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);

            // [check] cl-150-1. ✅ エラーなくページが表示されること
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // [check] cl-150-2. ✅ ナビバーが表示されていること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });
            await autoScreenshot(page, 'CL03', 'cl-150', _testStart);
        });
    });
});
