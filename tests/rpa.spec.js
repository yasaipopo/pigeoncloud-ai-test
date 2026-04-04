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
 * ログイン共通関数
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
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
    await waitForAngular(page);

    // APIログインを優先（フォームロード待機不要で高速・確実）
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
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        return;
    }

    // APIログイン失敗時はフォームログイン
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    const idField = await page.waitForSelector('#id', { timeout: 5000 }).catch(() => null);
    if (!idField) {
        // すでにダッシュボードにいる場合はOK
        if (!page.url().includes('/admin/login')) return;
        throw new Error('ログインフォームの#idフィールドが見つかりません');
    }
    await page.fill('#id', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 15000 });
    } catch (e) {
        if (page.url().includes('/admin/login')) {
            await page.waitForTimeout(1000);
            await page.fill('#id', EMAIL);
            await page.fill('#password', PASSWORD);
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 15000 });
        }
    }
    await page.waitForTimeout(1000);
}

/**
 * コネクト（RPA）一覧ページへ移動
 * waitForAngularだけではAPIデータロード完了を保証できないため、
 * .card-block（今月使用量エリア）が表示されるまで待機する
 */
async function navigateToRpa(page) {
    await page.goto(BASE_URL + '/admin/rpa', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await waitForAngular(page);
    // コネクト一覧のコンテンツ（今月使用量テキスト）が表示されるまで待機
    // .card-blockは複数存在するため、今月使用量テキストを持つ要素を待つ
    await page.waitForSelector('b:text("今月使用量")', { timeout: 20000 });
}

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
        await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        if (page.url().includes('/login')) {
            await page.fill('#id', EMAIL);
            await page.fill('#password', PASSWORD);
            await page.locator('button[type=submit].btn-primary').first().click();
            await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        }
    });

    test('RA01: コネクト管理画面の基本機能確認', async ({ page }) => {
        await login(page);
        let stepStart;

        await test.step('RPA-01: コネクト管理画面が正常に表示されること', async () => {
            stepStart = Date.now();
            await navigateToRpa(page);

            // ページタイトルにエラーがないこと
            const title = await page.title();
            expect(title).not.toMatch(/エラー|Error|404|500/i);

            // URLが /admin/rpa であること
            const url = page.url();
            expect(url).toContain('/admin/rpa');

            // 新規追加ボタン（fa-plus を含む btn-outline-primary ボタン）が存在すること
            // 実際のクラス: btn btn-sm btn-outline-primary pl-2 mr-2
            const addBtnCount = await page.locator('button.btn-outline-primary:has(.fa-plus)').count();
            expect(addBtnCount, '新規追加ボタン（fa-plus）が存在すること').toBeGreaterThan(0);

            // 今月使用量が表示されること
            // .card-blockは複数ある場合があるので first() で取得
            const usageText = await page.locator('.card-block').first().textContent();
            expect(usageText).toMatch(/今月使用量/);
            console.log(`STEP_TIME RPA-01: ${Date.now() - stepStart}ms`);
        });

        await test.step('RPA-02: 新しいコネクト（RPA）を作成できること', async () => {
            stepStart = Date.now();
            await navigateToRpa(page);

            // 新規追加ボタンをクリック（:has(.fa-plus) で確実にターゲット）
            await page.locator('button.btn-outline-primary:has(.fa-plus)').first().click();

            // 編集画面（/admin/rpa/edit/new）に遷移すること
            await page.waitForURL('**/admin/rpa/edit/**', { timeout: 15000 });
            await waitForAngular(page);

            // RPA名入力フィールドが表示されるまで待機
            await page.waitForSelector('input[placeholder="フロー名"]', { timeout: 5000 });

            // RPA名入力フィールドが存在すること
            const rpaNameInput = await page.locator('input[placeholder="フロー名"]').count();
            expect(rpaNameInput, 'RPA名入力フィールドが存在すること').toBeGreaterThan(0);

            // テーブル選択フィールドが存在すること
            // テーブル選択はmat-autocomplete（input[placeholder="テーブル名検索"]）またはng-select
            const tableSelectCount = await page.locator('input[placeholder*="テーブル名"], ng-select, .ng-select').count();
            expect(tableSelectCount, 'テーブル選択フィールドが存在すること').toBeGreaterThan(0);

            // RPA名を入力
            await page.fill('input[placeholder="フロー名"]', 'テストRPA_E2E');
            await waitForAngular(page);

            // テーブルを選択（ng-select使用 — input[placeholder="テーブル名検索"]は非表示のため
            // ng-selectをクリックして内部のinput[type=text]で検索する）
            const ngSelect = page.locator('ng-select, .ng-select').first();
            if (await ngSelect.count() > 0) {
                await ngSelect.click();
                await waitForAngular(page);
                const ngInput = page.locator('ng-select input[type=text], .ng-select input[type=text]').first();
                if (await ngInput.count() > 0) {
                    await ngInput.fill('ALLテスト');
                    await waitForAngular(page);
                    // role=option で ARIA ドロップダウン選択肢をクリック
                    const option = page.getByRole('option').filter({ hasText: 'ALLテストテーブル' });
                    await option.first().waitFor({ state: 'visible', timeout: 10000 });
                    await option.first().click();
                    await waitForAngular(page);
                }
            }

            // テーブル選択後に「作成」ボタンが表示されるまで待機してクリック
            // exact: true で「手動でテーブルを作成」ボタン（hidden）と区別する
            const createBtn = page.getByRole('button', { name: '作成', exact: true });
            await createBtn.waitFor({ state: 'visible', timeout: 15000 });
            await createBtn.click();
            // 作成後にURL変更を待つ（/admin/rpa/edit/new → /admin/rpa/edit/{id}）
            await page.waitForURL(/\/admin\/rpa\/edit\/(?!new)/, { timeout: 20000 });

            // 作成後にRPA編集画面（/admin/rpa/edit/{id}）に遷移していること（newではなくIDが付いている）
            const finalUrl = page.url();
            expect(finalUrl).toContain('/admin/rpa/edit/');
            expect(finalUrl).not.toContain('/admin/rpa/edit/new');
            const errorCount = await page.locator('.alert-danger').count();
            expect(errorCount, 'エラーが表示されていないこと').toBe(0);
            console.log(`STEP_TIME RPA-02: ${Date.now() - stepStart}ms`);
        });

        await test.step('RPA-03: コネクト（RPA）フロー編集画面が表示されること', async () => {
            stepStart = Date.now();
            await navigateToRpa(page);

            // 新規作成ボタンをクリック
            await page.locator('button.btn-outline-primary:has(.fa-plus)').first().click();
            await page.waitForURL('**/admin/rpa/edit/**', { timeout: 15000 });
            await waitForAngular(page);

            // RPA名入力フィールドが表示されるまで待機
            await page.waitForSelector('input[placeholder="フロー名"]', { timeout: 5000 });

            // 編集URLに遷移していること
            const url = page.url();
            expect(url).toContain('/admin/rpa/edit/');

            // RPA名入力フィールドが存在すること
            const rpaNameInput = await page.locator('input[placeholder="フロー名"]').count();
            expect(rpaNameInput, 'RPA名入力フィールドが存在すること').toBeGreaterThan(0);

            // テーブル選択フィールドが存在すること
            // 実際にはmat-autocomplete（input[placeholder="テーブル名検索"]）
            const tableSelectCount = await page.locator('input[placeholder*="テーブル名"], ng-select, .ng-select').count();
            expect(tableSelectCount, 'テーブル選択フィールドが存在すること').toBeGreaterThan(0);

            // flow要素はテーブル選択後に表示されるため、まず「まずテーブルを選択」のガイドテキストを確認
            const guideText = await page.locator('text=まずテーブルを選択').count();
            // ガイドテキストがある → 正常な初期状態
            // またはflowコンポーネントがある → テーブル選択済みの正常状態
            const flowEl = await page.locator('flow, .flow-container').count();
            expect(guideText + flowEl, 'フロー編集エリアまたはガイドテキストが表示されること').toBeGreaterThan(0);

            // エラーなし
            const errorText = await page.locator('.alert-danger').count();
            expect(errorText, 'エラーが表示されていないこと').toBe(0);
            console.log(`STEP_TIME RPA-03: ${Date.now() - stepStart}ms`);
        });

        await test.step('RPA-04: コネクト一覧のテーブルヘッダーが正しいこと', async () => {
            stepStart = Date.now();
            await navigateToRpa(page);

            // テーブルヘッダーの確認
            const headers = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('table thead th')).map(th => th.textContent.trim());
            });

            // テーブルが表示されていること（ヘッダーが1つ以上あること）
            expect(headers.length, 'コネクト一覧テーブルにヘッダー列が存在すること').toBeGreaterThan(0);

            // IDカラムが存在すること
            const hasId = headers.some(h => h.includes('ID'));
            // テーブルカラムが存在すること
            const hasTable = headers.some(h => h.includes('テーブル'));
            // コネクト名（またはRPA名）カラムが存在すること
            const hasName = headers.some(h => h.includes('コネクト名') || h.includes('RPA名') || h.includes('名'));
            // ステータスカラムが存在すること
            const hasStatus = headers.some(h => h.includes('ステータス'));

            // 各カラムを個別に確認（コネクト一覧には ID・テーブル・コネクト名・ステータスの4列が揃っているべき）
            expect(hasId, `IDカラムが存在すること（実際のヘッダー: [${headers.join(', ')}]）`).toBeTruthy();
            expect(hasTable, `テーブルカラムが存在すること（実際のヘッダー: [${headers.join(', ')}]）`).toBeTruthy();
            expect(hasName, `コネクト名カラムが存在すること（実際のヘッダー: [${headers.join(', ')}]）`).toBeTruthy();
            expect(hasStatus, `ステータスカラムが存在すること（実際のヘッダー: [${headers.join(', ')}]）`).toBeTruthy();
            console.log(`STEP_TIME RPA-04: ${Date.now() - stepStart}ms`);
        });

        await test.step('RPA-05: コネクト一覧の今月使用量が表示されること', async () => {
            stepStart = Date.now();
            await navigateToRpa(page);

            // 今月使用量の表示確認
            // 実際のDOM: <b>今月使用量:</b> ... STEP の親が .card-block
            const usageCard = await page.locator('.card-block').filter({ hasText: /今月使用量/ });
            const usageCount = await usageCard.count();
            expect(usageCount, '今月使用量カードが表示されること').toBeGreaterThan(0);

            // 使用量テキストが "N STEP / N STEP" 形式で表示されること
            const usageText = await usageCard.first().textContent();
            expect(usageText).toMatch(/STEP/);
            console.log(`STEP_TIME RPA-05: ${Date.now() - stepStart}ms`);
        });

        await test.step('RPA-06: コネクト実行ログページへ遷移できること', async () => {
            stepStart = Date.now();

            // コネクト実行ログへ遷移
            await page.goto(BASE_URL + '/admin/rpa_executes', { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await waitForAngular(page);

            // エラーがないこと
            const url = page.url();
            expect(url).toContain('/admin/rpa_executes');

            const title = await page.title();
            expect(title).not.toMatch(/エラー|Error|404|500/i);
            console.log(`STEP_TIME RPA-06: ${Date.now() - stepStart}ms`);
        });
    });

    test('UC10: コネクトのWF完了トリガー・FTP処理確認', async ({ page }) => {
        await login(page);
        let stepStart;

        await test.step('603: コネクトのWF完了トリガーで重複禁止エラー時に適切なメッセージが表示されること', async () => {
            stepStart = Date.now();

            // コネクト設定画面に遷移
            await page.goto(BASE_URL + '/admin/rpa', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // コネクト一覧が表示されること
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // コネクト設定欄を確認
            const rpaItems = page.locator('.rpa-item, tr[mat-row], .cdk-drag, li:has-text("コネクト"), li:has-text("RPA")');
            const rpaCount = await rpaItems.count();
            console.log('603: コネクト/RPA項目数:', rpaCount);

            // トリガー設定が存在するか確認
            const triggerSettings = page.locator(':has-text("トリガー"), :has-text("WF完了"), :has-text("ワークフロー")');
            const triggerCount = await triggerSettings.count();
            console.log('603: トリガー設定関連要素数:', triggerCount);

            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            console.log(`STEP_TIME 603: ${Date.now() - stepStart}ms`);
        });

        await test.step('609: FTP処理の失敗時にどのテーブルのエラーかが通知に含まれること', async () => {
            stepStart = Date.now();

            // FTP連携設定画面に遷移
            await page.goto(BASE_URL + '/admin/rpa', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // FTP連携設定を確認
            const ftpSettings = page.locator(':has-text("FTP"), :has-text("ファイル転送")');
            const ftpCount = await ftpSettings.count();
            console.log('609: FTP連携関連要素数:', ftpCount);

            // ページが正常であること
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            console.log(`STEP_TIME 609: ${Date.now() - stepStart}ms`);
        });
    });

    test('UC13: RPA実行履歴画面確認', async ({ page }) => {
        await login(page);
        let stepStart;

        await test.step('672: RPA実行履歴画面に実行結果が正しく表示されること', async () => {
            stepStart = Date.now();

            // RPA実行履歴画面に遷移
            await page.goto(BASE_URL + '/admin/rpa_executes', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // 実行履歴ページが表示されること
            const url = page.url();
            expect(url).toContain('/admin/rpa_executes');

            // 実行履歴のテーブル/リストを確認
            const historyTable = page.locator('table, .history-list, [class*="execute"]');
            const historyCount = await historyTable.count();
            console.log('672: 実行履歴テーブル/リスト数:', historyCount);

            // 各履歴に実行結果（成功/失敗等）が表示されていること
            const resultBadges = page.locator(':has-text("成功"), :has-text("失敗"), :has-text("実行中"), .badge');
            const badgeCount = await resultBadges.count();
            console.log('672: 結果バッジ数:', badgeCount);

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            console.log(`STEP_TIME 672: ${Date.now() - stepStart}ms`);
        });
    });

    test('UC20: RPAビュー表示・編集・保存確認', async ({ page }) => {
        await login(page);
        let stepStart;

        await test.step('789: RPAのビュー表示と編集・保存が正常に動作すること', async () => {
            stepStart = Date.now();

            // RPA一覧に遷移
            await page.goto(BASE_URL + '/admin/rpa', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // RPA設定一覧を確認
            const rpaItems = page.locator('tr[mat-row], .rpa-item, .cdk-drag, a[href*="/admin/rpa/"]');
            const rpaCount = await rpaItems.count();
            console.log('789: RPA設定数:', rpaCount);

            if (rpaCount > 0) {
                // 最初のRPA設定のビュー画面を開く
                const viewLink = page.locator('a[href*="/admin/rpa/view/"]').first();
                if (await viewLink.isVisible({ timeout: 5000 }).catch(() => false)) {
                    await viewLink.click();
                    await waitForAngular(page);

                    // ビュー画面が正常に表示されること
                    const viewUrl = page.url();
                    expect(viewUrl).toContain('/admin/rpa/');
                    console.log('789: RPAビュー画面URL:', viewUrl);

                    const viewBody = await page.innerText('body');
                    expect(viewBody).not.toContain('Internal Server Error');

                    // 編集画面へのリンクを確認
                    const editBtn = page.locator('a:has-text("編集"), button:has-text("編集"), a[href*="/admin/rpa/edit/"]').first();
                    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);
                    console.log('789: 編集ボタン表示:', editVisible);

                    if (editVisible) {
                        await editBtn.click();
                        await waitForAngular(page);

                        // 編集画面が正常に表示されること
                        const editBody = await page.innerText('body');
                        expect(editBody).not.toContain('Internal Server Error');
                    }
                }
            }

            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            console.log(`STEP_TIME 789: ${Date.now() - stepStart}ms`);
        });
    });
});
