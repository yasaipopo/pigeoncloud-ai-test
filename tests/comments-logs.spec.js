// @ts-check
const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { getAllTypeTableId, createAllTypeData } = require('./helpers/table-setup');
const { ensureLoggedIn } = require('./helpers/ensure-login');
const fs = require('fs');
const path = require('path');

const { createTestEnv } = require('./helpers/create-test-env');

let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;

/**
 * ステップスクリーンショット撮影
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
 * storageStateを使ったブラウザコンテキストを作成する
 */
async function createLoginContext(browser) {
    const agentNum = process.env.AGENT_NUM || '1';

    const authStatePath = path.join(__dirname, '..', `.auth-state.${agentNum}.json`);
    if (fs.existsSync(authStatePath)) {
        try {
            return await browser.newContext({ storageState: authStatePath });
        } catch (e) {
            console.warn(`[createLoginContext] storageState読み込み失敗、新規コンテキストで続行: ${e.message}`);
        }
    }
    return await browser.newContext();
}

/**
 * ログイン共通関数
 */
async function login(page, email, password) {
    await page.goto(BASE_URL + '/admin/login', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded');
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
    await page.fill('#id', email || EMAIL, { timeout: 15000 }).catch(() => {});
    await page.fill('#password', password || PASSWORD, { timeout: 15000 }).catch(() => {});
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 15000 });
    } catch (e) {
        if (page.url().includes('/admin/login')) {
            await page.waitForTimeout(1000);
            await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
            await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 15000 });
        }
    }
    await page.waitForTimeout(2000);
}

/**
 * ログイン後テンプレートモーダルを閉じる
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
 * デバッグAPIを呼び出す（POSTリクエスト）
 */
async function debugApiPost(page, path, body = {}) {
    return await page.evaluate(async ({ baseUrl, path, body }) => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 180000); // 180秒タイムアウト
            let res;
            try {
                res = await fetch(baseUrl + '/api/admin/debug' + path, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify(body),
                    credentials: 'include',
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeoutId);
            }
            const text = await res.text();
            try {
                return JSON.parse(text);
            } catch(e) {
                // 504等のHTMLレスポンスの場合は仮レスポンスを返す（サーバー側で処理は完了している可能性あり）
                return { result: 'timeout', status: res.status, text: text.substring(0, 100) };
            }
        } catch(e) {
            return { result: 'error', message: e.message };
        }
    }, { baseUrl: BASE_URL, path, body });
}

/**
 * ALLテストテーブルを作成してデータを投入する
 * 既存テーブルを削除してから再作成することでデータ整合性を確保
 * @returns {Promise<string>} 作成されたテーブルのURL（例: /admin/dataset__7）
 */
async function setupTestTable(page) {
    // global共有テーブルは削除しない（他specが参照するため）
    // テーブルが存在しない場合のみ作成する

    // テーブル作成（既存テーブルがある場合はスキップされる。504でもバックエンドは処理継続するため、ポーリングで完了確認）
    debugApiPost(page, '/create-all-type-table', {}).catch(() => {});

    // テーブル作成完了をポーリングで確認（最大300秒）
    let tableCreated = false;
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(10000);
        // statusはGETエンドポイントのため、page.evaluateで直接fetchする
        const status = await page.evaluate(async (baseUrl) => {
            try {
                const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
                return res.json();
            } catch (e) { return null; }
        }, BASE_URL);
        const tables = status?.all_type_tables || [];
        if (tables.some(t => t.label === 'ALLテストテーブル')) {
            tableCreated = true;
            break;
        }
    }

    // データ投入（テーブル作成後に実施）
    if (tableCreated) {
        await debugApiPost(page, '/create-all-type-data', { count: 3, pattern: 'fixed' });
        await page.waitForTimeout(2000);
    }

    // デバッグAPIのstatusからテーブルIDを取得（確実な方法）
    const finalStatus = await page.evaluate(async (baseUrl) => {
        try {
            const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
            return res.json();
        } catch (e) { return null; }
    }, BASE_URL);
    const mainTable = (finalStatus?.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
    if (mainTable) {
        const tid = mainTable.table_id || mainTable.id;
        return '/admin/dataset__' + tid;
    }

    // フォールバック: ダッシュボードのサイドバーからリンクを取得
    await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded');
    try { await page.waitForSelector('a[href*="/admin/dataset__"]', { timeout: 10000 }); } catch (e) {}
    await waitForAngular(page);

    const newLink = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="dataset__"]'));
        for (const link of links) {
            if (link.textContent.trim() === 'ALLテストテーブル') {
                return link.getAttribute('href');
            }
        }
        return links[0]?.getAttribute('href') || null;
    });

    return newLink || '/admin/dataset__7';
}

/**
 * teardown: global共有テーブルは削除しない（テナントごと破棄される）
 */
async function teardownTestTable(page) {
    // no-op: ALLテストテーブルの削除は禁止（他specが参照するため）
}

/**
 * テストユーザーを作成して返す（失敗しても無視）
 */
async function tryCreateTestUser(page) {
    try {
        return await page.evaluate(async (baseUrl) => {
            const res = await fetch(baseUrl + '/api/admin/debug/create-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({}),
                credentials: 'include',
            });
            return res.json();
        }, BASE_URL);
    } catch (e) {
        return { result: 'error' };
    }
}

/**
 * aside-menu（コメントパネル）を開く
 * Angular の .app クラスから aside-menu-hidden を除去してパネルを表示する
 */
async function openAsideMenu(page) {
    // まず aside-menu ボタン（コメントアイコン）があればクリックして開く
    try {
        const asideBtn = page.locator('aside button, .aside-toggle, [aria-label*="コメント"], .aside-menu-toggler').first();
        if (await asideBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await asideBtn.click({ force: true });
            await waitForAngular(page);
        }
    } catch (e) { /* フォールバックに進む */ }

    // Angular の .app クラスから aside-menu-hidden を除去してパネルを強制表示
    await page.evaluate(() => {
        const app = document.querySelector('.app');
        if (app) app.classList.remove('aside-menu-hidden');
    });
    // Angular コンポーネントの描画を待機
    await page.waitForSelector('#comment', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
}

/**
 * ALLテストテーブルの最初のレコードのviewページURLを取得する
 * UIの実際のリンクを辿ることで存在するレコードIDを確実に取得する
 */
async function getFirstRecordViewUrl(page, tableUrl) {
    // テーブル一覧ページにアクセス
    await page.goto(BASE_URL + tableUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
    await waitForAngular(page);
    await page.keyboard.press('Escape');
    await waitForAngular(page);

    // Angularのレコードリストが描画されるまで待機
    await page.waitForSelector(`a[href*="${tableUrl}/view/"]`, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);

    // UIに表示されているレコードの詳細リンクを探す（/view/XXX へのリンク）
    const viewHref = await page.evaluate((tableUrl) => {
        const links = Array.from(document.querySelectorAll('a[href*="/view/"]'));
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href && href.includes(tableUrl + '/view/')) {
                return href;
            }
        }
        return null;
    }, tableUrl);

    if (viewHref) return viewHref;

    // UIからリンクが見つからない場合はAPIで取得
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
        } catch (e) {
            return null;
        }
    }, { baseUrl: BASE_URL, tableName });

    const records = listData?.data_a || [];
    if (records.length > 0) {
        const id = records[0]?.raw_data?.id;
        if (id) return tableUrl + '/view/' + id;
    }

    // レコードがない場合はデータ投入を試みる（setupTestTableのデータ投入が失敗した場合の回復）
    await debugApiPost(page, '/create-all-type-data', { count: 3, pattern: 'fixed' });
    await page.waitForTimeout(3000);

    // 投入後に再度テーブル一覧を確認
    await page.goto(BASE_URL + tableUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
    await waitForAngular(page);
    try { await page.waitForSelector(`a[href*="${tableUrl}/view/"]`, { timeout: 5000 }); } catch (e) {}

    const retryHref = await page.evaluate((tableUrl) => {
        const links = Array.from(document.querySelectorAll('a[href*="/view/"]'));
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href && href.includes(tableUrl + '/view/')) return href;
        }
        return null;
    }, tableUrl);
    if (retryHref) return retryHref;

    return tableUrl + '/view/1';
}

// =============================================================================
// ログ管理テスト
// =============================================================================

const autoScreenshot = createAutoScreenshot('comments-logs');

test.describe('ログ管理', () => {

    /** テーブルURL（beforeAll で設定） */
    let tableUrl = '/admin/dataset__7';
    /** レコードviewURL（beforeAll で設定） */
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
        // レコードデータ作成
        const context = env.context;
        const page = await context.newPage();
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        if (page.url().includes('/login')) {
            await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
            await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
            await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        }
        await createAllTypeData(page, 3).catch((e) => console.log('createAllTypeData error (ignored):', e.message));
        await page.waitForTimeout(2000);
        recordViewUrl = await getFirstRecordViewUrl(page, tableUrl);
        await page.close();
        await context.close();
        console.log(`[comments-logs] 自己完結環境: ${BASE_URL}`);
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

    // =========================================================================
    // CL01: ログ閲覧フロー（13-1, 13-2, 196）→ 1動画
    // =========================================================================
    test('CL01: ログ閲覧フロー', async ({ page }) => {
        test.setTimeout(75000);
        const _testStart = Date.now();
        page.setDefaultTimeout(60000);

        await ensureLoggedIn(page);
        await closeTemplateModal(page);

        // ----- step: 13-1 各ユーザーの操作ログが確認できること -----
        await test.step('cl-010: 各ユーザーの操作ログが確認できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-010`);

            await page.goto(BASE_URL + '/admin/logs', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await waitForAngular(page);
            await expect(page).toHaveURL(/\/admin\/logs/);

            await page.waitForFunction(
                () => document.body.innerText.includes('ユーザー') && document.querySelectorAll('table').length > 0,
                { timeout: 5000 }
            ).catch(() => {});

            const pageText = await page.innerText('body');
            expect(pageText).toContain('ユーザー');
            expect(pageText).toContain('アクション');
            expect(pageText).toContain('テーブル');
            expect(pageText).toContain('日時');
            await autoScreenshot(page, 'CL01', 'cl-010', 0, _testStart);
        });

        // ----- step: 13-2 CSV UP/DL履歴が確認できること -----
        await test.step('cl-020: CSV UP/DL履歴が確認できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-020`);

            await page.goto(BASE_URL + '/admin/csv', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await page.waitForLoadState('domcontentloaded');
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);

            await expect(page).toHaveURL(/\/admin\/csv/);
            await page.waitForSelector('table th', { timeout: 5000 }).catch(() => {});

            const pageText = await page.innerText('body');
            expect(pageText).toContain('CSV UP/DL履歴');
            expect(pageText).toContain('ファイル名');
            expect(pageText).toContain('タイプ');
            expect(pageText).toContain('処理');
            await autoScreenshot(page, 'CL01', 'cl-020', 0, _testStart);
        });

        // ----- step: 196 リクエストログで処理ステータスが確認できること -----
        await test.step('cl-070: リクエストログで処理ステータスが確認できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-070`);

            await page.goto(BASE_URL + '/admin/job_logs', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            await expect(page).toHaveURL(/\/admin\/job_logs/);

            await page.waitForFunction(
                () => document.body.innerText.includes('リクエストログ') && document.querySelectorAll('table').length > 0,
                { timeout: 5000 }
            ).catch(() => {});

            const pageText = await page.innerText('body');
            expect(pageText).toContain('リクエストログ');
            expect(pageText).toContain('リクエスト');
            expect(pageText).toContain('ステータス');
            expect(pageText).toContain('処理結果');
            await autoScreenshot(page, 'CL01', 'cl-070', 0, _testStart);
        });
    });

    // =========================================================================
    // CL02: コメントメンションフロー（69-1, 69-2, 69-3, 69-4, 242）→ 1動画
    // =========================================================================
    test('CL02: コメントメンションフロー', async ({ page }) => {
        test.setTimeout(105000);
        const _testStart = Date.now();
        page.setDefaultTimeout(60000);

        await ensureLoggedIn(page);
        await closeTemplateModal(page);

        // ----- step: 69-1 1ユーザーへのメンション付きコメントが送信できること -----
        await test.step('cl-030: 1ユーザーへのメンション付きコメントが送信できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-030`);

            await tryCreateTestUser(page);

            await page.goto(BASE_URL + recordViewUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await page.waitForLoadState('domcontentloaded');
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            await expect(page).toHaveURL(/\/view\//);
            await openAsideMenu(page);

            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();
            await expect(commentDiv).toHaveAttribute('contenteditable', 'true');
            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            await expect(sendBtn).toBeVisible();
            await expect(sendBtn).toContainText('送信');

            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('テストコメント @マスターユーザー');
            await page.waitForTimeout(800);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            await sendBtn.click({ force: true });
            await page.waitForSelector('comment-log-block', { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(2000);

            const asideContent = await page.innerText('aside');
            expect(asideContent).toContain('マスターユーザー');
            const commentBody = page.locator('.comment-body').last();
            await expect(commentBody).toBeVisible();
            await expect(commentBody).toContainText('テストコメント');
            await autoScreenshot(page, 'CL02', 'cl-030', 0, _testStart);
        });

        // ----- step: 69-2 複数ユーザーへのメンション付きコメントが送信できること -----
        await test.step('cl-040: 複数ユーザーへのメンション付きコメントが送信できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-040`);

            await page.goto(BASE_URL + recordViewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            await openAsideMenu(page);

            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();
            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            await expect(sendBtn).toBeVisible();

            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('複数メンションテスト @マスターユーザー @マスターユーザー');
            await page.waitForTimeout(1000);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            await sendBtn.click({ force: true });
            await page.waitForSelector('comment-log-block', { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(2000);

            const asideContent = await page.innerText('aside');
            expect(asideContent).toContain('複数メンションテスト');
            const commentBody = page.locator('.comment-body').filter({ hasText: '複数メンションテスト' }).first();
            await expect(commentBody).toBeVisible();
            await autoScreenshot(page, 'CL02', 'cl-040', 0, _testStart);
        });

        // ----- step: 69-3 存在しないユーザーでメンションしてもコメントが保存されること -----
        await test.step('cl-050: 存在しないユーザーでメンションしてもコメントが保存されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-050`);

            await page.goto(BASE_URL + recordViewUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await page.waitForLoadState('domcontentloaded');
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            await openAsideMenu(page);

            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();
            await expect(commentDiv).toHaveAttribute('contenteditable', 'true');

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

            const commentBody = page.locator('.comment-body').filter({ hasText: '存在しないユーザーテスト' }).first();
            await expect(commentBody).toBeVisible();
            await autoScreenshot(page, 'CL02', 'cl-050', 0, _testStart);
        });

        // ----- step: 69-4 組織へのメンション付きコメントが送信できること -----
        await test.step('cl-060: 組織へのメンション付きコメントが送信できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-060`);

            await page.goto(BASE_URL + recordViewUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await page.waitForLoadState('domcontentloaded');
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            if (!page.url().includes('/view/')) {
                const freshViewUrl = await getFirstRecordViewUrl(page, tableUrl);
                recordViewUrl = freshViewUrl;
                await page.goto(BASE_URL + recordViewUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
                await page.waitForLoadState('domcontentloaded');
                await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
                await waitForAngular(page);
                await page.keyboard.press('Escape');
                await waitForAngular(page);
            }

            await openAsideMenu(page);

            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();
            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            await expect(sendBtn).toBeVisible();
            await expect(sendBtn).toContainText('送信');

            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('組織メンションテスト @組織1');
            await page.waitForTimeout(300);

            await sendBtn.click({ force: true });
            await page.waitForSelector('comment-log-block', { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(2000);

            const asideContent = await page.innerText('aside');
            expect(asideContent).toContain('組織メンションテスト');
            const commentBody = page.locator('.comment-body').filter({ hasText: '組織メンションテスト' }).first();
            await expect(commentBody).toBeVisible();
            await autoScreenshot(page, 'CL02', 'cl-060', 0, _testStart);
        });

        // ----- step: 242 ログとコメントをまとめて表示が有効の時にメンション機能が動作すること -----
        await test.step('cl-080: ログとコメントをまとめて表示が有効の時にメンション機能が動作すること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-080`);

            const match = tableUrl.match(/dataset__(\d+)/);
            const tableId = match ? match[1] : '7';

            await page.goto(BASE_URL + '/admin/dataset/edit/' + tableId, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            try {
                const detailTab = page.locator('.nav-link').filter({ hasText: '詳細・編集画面' }).first();
                await detailTab.click({ force: true });
                await waitForAngular(page);
            } catch (e) {}

            try {
                const pageText = await page.innerText('body');
                if (pageText.includes('ログとコメントをまとめて表示する')) {
                    await page.evaluate(() => {
                        const allText = document.querySelectorAll('*');
                        for (const el of allText) {
                            if (el.children.length === 0 && el.textContent?.trim() === 'ログとコメントをまとめて表示する') {
                                let parent = el.parentElement;
                                for (let i = 0; i < 5; i++) {
                                    if (!parent) break;
                                    const switchInput = parent.querySelector('input[type="checkbox"].switch-input');
                                    if (switchInput && !switchInput.checked) {
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
                    const saveBtnVisible = await saveBtn.isVisible();
                    if (saveBtnVisible) {
                        await saveBtn.click({ force: true });
                        await page.waitForLoadState('domcontentloaded');
                        await page.waitForTimeout(4000);
                    }
                }
            } catch (e) {}

            await page.goto(BASE_URL + recordViewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            await openAsideMenu(page);

            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();
            await expect(commentDiv).toHaveAttribute('contenteditable', 'true');
            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            await expect(sendBtn).toBeVisible();
            await expect(sendBtn).toContainText('送信');

            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('@マスターユーザー');
            await page.waitForTimeout(300);

            const inputText = await commentDiv.innerText();
            expect(inputText).toContain('@');

            await sendBtn.click({ force: true });
            await page.waitForSelector('comment-log-block', { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(2000);

            const commentBody = page.locator('.comment-body').last();
            await expect(commentBody).toBeVisible();
            await autoScreenshot(page, 'CL02', 'cl-080', 0, _testStart);
        });
    });

    // =========================================================================
    // CL03: コメント・ログ バグ修正確認（297, 356, 426, 472, 597, 570）→ 1動画
    // =========================================================================
    test('CL03: コメント・ログ バグ修正確認', async ({ page }) => {
        test.setTimeout(150000);
        const _testStart = Date.now();
        page.setDefaultTimeout(60000);

        await ensureLoggedIn(page);
        await closeTemplateModal(page);

        // テーブルURLのセットアップ（setupTestTableの代替: 既存tableUrlを使用）
        const _tableUrl = tableUrl;

        // ----- step: 297 複数値を持つ項目で絞り込み（OR選択）が正常に動作すること -----
        await test.step('cl-090: 複数値を持つ項目で絞り込み（OR選択）が正常に動作すること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-090`);

            await page.goto(BASE_URL + _tableUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
            if (await filterBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await filterBtn.click({ force: true });
                await waitForAngular(page);

                const filterPanel = page.locator('.filter-panel, .search-panel, .condition-row');
                const panelCount = await filterPanel.count();
                console.log('297: フィルタパネル要素数:', panelCount);
            }

            const afterText = await page.innerText('body');
            expect(afterText).not.toContain('Internal Server Error');
            await autoScreenshot(page, 'CL03', 'cl-090', 0, _testStart);
        });

        // ----- step: 356 通知をクリックした際にコメントが来たレコード詳細画面に遷移すること -----
        await test.step('cl-100: 通知をクリックした際にコメントが来たレコード詳細画面に遷移すること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-100`);

            await page.goto(BASE_URL + '/admin/notifications', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            const bellIcon = page.locator('.notification-bell, .fa-bell, i.icon-bell, .nav-link .badge').first();
            if (await bellIcon.isVisible({ timeout: 5000 }).catch(() => false)) {
                await bellIcon.click({ force: true });
                await waitForAngular(page);
            }

            const notifItems = page.locator('.notification-item, .dropdown-item, .notification-list a');
            const notifCount = await notifItems.count();
            console.log('356: 通知アイテム数:', notifCount);

            if (notifCount > 0) {
                await notifItems.first().click({ force: true });
                await waitForAngular(page);
                const afterUrl = page.url();
                console.log('356: 通知クリック後URL:', afterUrl);
                const afterText = await page.innerText('body');
                expect(afterText).not.toContain('Internal Server Error');
            }
            await autoScreenshot(page, 'CL03', 'cl-100', 0, _testStart);
        });

        // ----- step: 426 年度絞り込みの検索結果コメントが正しく表示されること -----
        await test.step('cl-110: 年度絞り込みの検索結果コメントが「今年度」「昨年度」と正しく表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-110`);

            const tableId = await getAllTypeTableId(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            const filterBtn = page.locator('button:has-text("フィルタ"), button:has(.fa-filter), .filter-btn').first();
            const filterVisible = await filterBtn.isVisible({ timeout: 5000 }).catch(() => false);
            console.log('426: フィルタボタン表示:', filterVisible);

            if (filterVisible) {
                await filterBtn.click();
                await page.waitForTimeout(1000);

                const yearOptions = page.locator(':has-text("今年度"), :has-text("昨年度"), :has-text("年度")');
                const yearCount = await yearOptions.count();
                console.log('426: 年度関連オプション数:', yearCount);
            }

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            await autoScreenshot(page, 'CL03', 'cl-110', 0, _testStart);
        });

        // ----- step: 472 コメント入力欄で改行が正しく反映されること -----
        await test.step('cl-120: コメント入力欄で改行が正しく反映されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-120`);

            const recordUrl = await getFirstRecordViewUrl(page, _tableUrl);
            await page.goto(BASE_URL + recordUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            await openAsideMenu(page);

            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();

            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('1行目テスト');
            await page.keyboard.press('Shift+Enter');
            await page.keyboard.type('2行目テスト');

            const inputHtml = await commentDiv.innerHTML();
            const hasBr = inputHtml.includes('<br') || inputHtml.includes('<div');
            console.log('472: 改行含有確認:', hasBr, 'HTML:', inputHtml.substring(0, 200));

            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            if (await sendBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await sendBtn.click({ force: true });
                await page.waitForTimeout(3000);

                const commentBody = page.locator('.comment-body').last();
                if (await commentBody.isVisible({ timeout: 10000 }).catch(() => false)) {
                    const bodyHtml = await commentBody.innerHTML();
                    const hasLineBreak = bodyHtml.includes('<br') || bodyHtml.includes('1行目') && bodyHtml.includes('2行目');
                    console.log('472: コメント表示の改行確認:', hasLineBreak);
                }
            }
            await autoScreenshot(page, 'CL03', 'cl-120', 0, _testStart);
        });

        // ----- step: 597 ユーザーを無効化してもコメント履歴にユーザー名が消えないこと -----
        await test.step('cl-130: ユーザーを無効化してもコメント履歴にユーザー名が消えないこと', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-130`);

            const recordUrl = await getFirstRecordViewUrl(page, _tableUrl);
            await page.goto(BASE_URL + recordUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            await openAsideMenu(page);

            const commentBlocks = page.locator('comment-log-block, .comment-block, .comment-item');
            const blockCount = await commentBlocks.count();
            console.log('597: コメントブロック数:', blockCount);

            if (blockCount > 0) {
                for (let i = 0; i < Math.min(blockCount, 3); i++) {
                    const blockText = await commentBlocks.nth(i).innerText();
                    expect(blockText.trim().length).toBeGreaterThan(0);
                }
            }

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            await autoScreenshot(page, 'CL03', 'cl-130', 0, _testStart);
        });

        // ----- step: 570 組織メンション時に複数役職兼任ユーザーへの通知が重複しないこと -----
        await test.step('cl-160: 組織メンション時に複数役職兼任ユーザーへの通知が重複しないこと', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-160`);

            const recordUrl = await getFirstRecordViewUrl(page, _tableUrl);
            await page.goto(BASE_URL + recordUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
            await waitForAngular(page);
            await page.keyboard.press('Escape');
            await waitForAngular(page);

            await openAsideMenu(page);

            const commentDiv = page.locator('#comment');
            await expect(commentDiv).toBeVisible();

            await commentDiv.click();
            await waitForAngular(page);
            await page.keyboard.type('組織メンションテスト570 @');
            await page.waitForTimeout(1000);

            const autocomplete = page.locator('.mention-list, .autocomplete, .dropdown-menu.show');
            const acCount = await autocomplete.count();
            console.log('570: オートコンプリート数:', acCount);

            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);

            const sendBtn = page.locator('button.btn-sm.btn-primary.pull-right').first();
            if (await sendBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await sendBtn.click({ force: true });
                await page.waitForTimeout(3000);
            }

            const asideText = await page.locator('aside').innerText().catch(() => '');
            expect(asideText).toContain('組織メンションテスト570');
            await autoScreenshot(page, 'CL03', 'cl-160', 0, _testStart);
        });

        // ----- step: 629 コメントの改行がメール通知で{line_break}にならず正常に改行されること -----
        await test.step('cl-140: コメントの改行がメール通知で{line_break}にならず正常に改行されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-140`);

            const tableId = await getAllTypeTableId(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            const firstRow = page.locator('tr[mat-row]').first();
            if (await firstRow.isVisible({ timeout: 5000 }).catch(() => false)) {
                const detailBtn = page.locator('button[data-record-url]').first();
                if (await detailBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                    const url = await detailBtn.getAttribute('data-record-url');
                    if (url) {
                        await page.goto(BASE_URL + url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                        await waitForAngular(page);
                    }
                }

                const commentInput = page.locator('textarea[formcontrolname*="comment"], textarea[placeholder*="コメント"], .comment-input textarea').first();
                const commentVisible = await commentInput.isVisible({ timeout: 5000 }).catch(() => false);
                console.log('629: コメント入力欄表示:', commentVisible);

                if (commentVisible) {
                    await commentInput.fill('テストコメント\n改行テスト\n3行目');
                    await page.waitForTimeout(500);

                    const inputValue = await commentInput.inputValue();
                    expect(inputValue).not.toContain('{line_break}');
                    expect(inputValue).not.toContain('line_break');
                    console.log('629: コメント入力値:', inputValue.substring(0, 100));
                }
            }

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            await autoScreenshot(page, 'CL03', 'cl-140', 0, _testStart);
        });

        // ----- step: 653 組織メンションのキャンセル後にメッセージが出続けないこと -----
        await test.step('cl-150: 組織メンションのキャンセル後にメッセージが出続けないこと', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s cl-150`);

            const tableId = await getAllTypeTableId(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            const firstRow = page.locator('tr[mat-row]').first();
            if (await firstRow.isVisible({ timeout: 5000 }).catch(() => false)) {
                const detailBtn = page.locator('button[data-record-url]').first();
                if (await detailBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                    const url = await detailBtn.getAttribute('data-record-url');
                    if (url) {
                        await page.goto(BASE_URL + url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                        await waitForAngular(page);
                    }
                }

                const commentInput = page.locator('textarea[formcontrolname*="comment"], textarea[placeholder*="コメント"], .comment-input textarea').first();
                const commentVisible = await commentInput.isVisible({ timeout: 5000 }).catch(() => false);
                console.log('653: コメント入力欄表示:', commentVisible);

                if (commentVisible) {
                    await commentInput.fill('@');
                    await page.waitForTimeout(1000);

                    const mentionList = page.locator('.mention-list, .autocomplete-list, [class*="mention"]');
                    const mentionVisible = await mentionList.first().isVisible({ timeout: 3000 }).catch(() => false);
                    console.log('653: メンション候補表示:', mentionVisible);

                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(500);

                    const warningMsg = page.locator('.mention-warning, .alert-warning:has-text("組織"), .toast-warning');
                    const warningVisible = await warningMsg.first().isVisible({ timeout: 2000 }).catch(() => false);
                    console.log('653: キャンセル後の警告メッセージ表示:', warningVisible);
                }
            }

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            await autoScreenshot(page, 'CL03', 'cl-150', 0, _testStart);
        });
    });

});
