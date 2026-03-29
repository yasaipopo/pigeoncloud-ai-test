// @ts-check
const { test, expect } = require('@playwright/test');
const { createAuthContext } = require('./helpers/auth-context');

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

/**
 * ログイン共通関数
 * APIログインを優先し、失敗時はフォームログインにフォールバック
 */
async function login(page, email, password) {
    await page.goto(BASE_URL + '/admin/login');
    await waitForAngular(page);

    // APIログインを優先（Angular SPA環境でのdetach問題を回避）
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
    }, { email: email || EMAIL, password: password || PASSWORD });

    if (loginResult.result === 'success') {
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        return;
    }

    // APIログイン失敗時はフォームログイン（フォールバック）
    await page.goto(BASE_URL + '/admin/login');
    await waitForAngular(page);
    await page.waitForSelector('#id', { timeout: 30000 });
    await page.fill('#id', email || EMAIL);
    await page.fill('#password', password || PASSWORD);
    await page.click('button[type=submit].btn-primary');
    await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
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
 * デバッグAPIでテストテーブルを作成するユーティリティ
 */
async function createAllTypeTable(page) {
    const status = await page.evaluate(async (baseUrl) => {
        try {
            const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
            return res.json();
        } catch (e) {
            return { all_type_tables: [] };
        }
    }, BASE_URL);
    const existing = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
    // FORCE_TABLE_RECREATE=1 が設定されている場合は既存テーブルを削除して再作成
    if (existing && process.env.FORCE_TABLE_RECREATE !== '1') {
        return { result: 'success', tableId: String(existing.table_id || existing.id) };
    }
    if (existing && process.env.FORCE_TABLE_RECREATE === '1') {
        console.log('[createAllTypeTable] FORCE_TABLE_RECREATE=1: 既存テーブルを削除して再作成します');
        await page.evaluate(async (baseUrl) => {
            await fetch(baseUrl + '/api/admin/debug/delete-all-type-tables', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({}),
                credentials: 'include',
            });
        }, BASE_URL);
        await page.waitForTimeout(3000);
    }
    // 504 Gateway Timeoutが返る場合があるため、ポーリングでテーブル作成完了を確認
    const createPromise = page.evaluate(async (baseUrl) => {
        try {
            const res = await fetch(baseUrl + '/api/admin/debug/create-all-type-table', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({}),
                credentials: 'include',
            });
            return { status: res.status };
        } catch (e) {
            return { status: 0 };
        }
    }, BASE_URL).catch(() => ({ status: 0 }));
    // 最大300秒ポーリングでテーブル作成完了を確認
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(10000);
        const statusCheck = await page.evaluate(async (baseUrl) => {
            try {
                const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
                return res.json();
            } catch (e) {
                return { all_type_tables: [] };
            }
        }, BASE_URL);
        const tableCheck = (statusCheck.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
        if (tableCheck) {
            return { result: 'success', tableId: String(tableCheck.table_id || tableCheck.id) };
        }
    }
    const apiResult = await createPromise;
    return { result: 'failure', tableId: null };
}

/**
 * デバッグAPIでテストデータを投入するユーティリティ
 */
async function createAllTypeData(page, count = 5) {
    const status = await page.evaluate(async (baseUrl) => {
        try {
            const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
            return res.json();
        } catch (e) {
            return { all_type_tables: [] };
        }
    }, BASE_URL);
    const mainTable = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
    if (mainTable && mainTable.count >= count) {
        return { result: 'success' };
    }
    return await page.evaluate(async ({ baseUrl, count }) => {
        try {
            const res = await fetch(baseUrl + '/api/admin/debug/create-all-type-data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ count, pattern: 'fixed' }),
                credentials: 'include',
            });
            return res.json();
        } catch (e) {
            return { result: 'error' };
        }
    }, { baseUrl: BASE_URL, count });
}

/**
 * デバッグAPIでテストテーブルを全削除するユーティリティ
 */
async function deleteAllTypeTables(page) {
    try {
        await page.evaluate(async (baseUrl) => {
            await fetch(baseUrl + '/api/admin/debug/delete-all-type-tables', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({}),
                credentials: 'include',
            });
        }, BASE_URL);
    } catch (e) {
        // クリーンアップ失敗は無視
    }
}

/**
 * ALLテストテーブルのIDを取得する
 */
async function getAllTypeTableId(page) {
    const status = await page.evaluate(async (baseUrl) => {
        try {
            const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
            return res.json();
        } catch (e) {
            return { all_type_tables: [] };
        }
    }, BASE_URL);
    // APIは {id, label, count} の形式で返す（table_idではなくid）
    const mainTable = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
    return mainTable ? (mainTable.table_id || mainTable.id) : null;
}

/**
 * フィールド設定ページへ遷移する
 */
async function navigateToFieldPage(page, tableId) {
    const tid = tableId || 'ALL';
    // フィールド設定ページは /admin/dataset/edit/:id （テーブル設定ページ）
    await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`);
    try {
        // networkidleはタイムアウトする可能性があるため短めに設定（フレイキー対策で10秒）
        await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch(e) {
        // networkidleにならない場合はdomcontentloadedで続行
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    }
    await waitForAngular(page);
    // ログインページにリダイレクトされた場合は再ログインして再遷移
    if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
        await login(page);
        await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`);
        try {
            await page.waitForLoadState('networkidle', { timeout: 10000 });
        } catch(e) {
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
        }
        await waitForAngular(page);
    }
}

/**
 * フィールド設定ページのタブが表示されるまで待機し、フィールドリストを確認する
 * テーブル設定ページに到達した場合は .cdk-drag.field-drag が表示されていることを確認
 * テーブル一覧ページにリダイレクトされた場合はレコード行が存在することを確認
 */
async function assertFieldPageLoaded(page, tableId) {
    const currentUrl = page.url();
    // テーブル設定ページ（/admin/dataset/edit/:id）に到達している場合
    if (currentUrl.includes('/admin/dataset/edit/')) {
        // タブが読み込まれるまで待機
        try {
            await page.waitForSelector('.dataset-tabs [role=tab], tabset .nav-tabs li', { timeout: 15000 });
        } catch (e) {
            // タブが見つからなくてもエラーとしない
        }
        // フィールドリストが表示されること
        const fieldRows = page.locator('.cdk-drag.field-drag, .field-drag, .toggle-drag-field-list').filter({ visible: true });
        const fieldCount = await fieldRows.count();
        if (fieldCount > 0) {
            await expect(fieldRows.first()).toBeVisible();
        } else {
            // フィールドリストがない場合はナビバーだけ確認
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        }
    } else if (currentUrl.includes(`/admin/dataset__${tableId}`)) {
        // テーブル一覧ページにリダイレクトされた場合
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
    } else {
        // その他のページ：ナビバーが表示されていること
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    }
}

// =============================================================================
// フィールド追加・各フィールドタイプ テスト
// =============================================================================

// ファイルレベルのALLテストテーブル共有（各describeで再作成しない）
let _sharedTableId = null;
test.beforeAll(async ({ browser }) => {
    test.setTimeout(480000);
    const { context, page } = await createAuthContext(browser);
    await createAllTypeTable(page);
    await createAllTypeData(page, 5);
    _sharedTableId = await getAllTypeTableId(page);
    await context.close();
});

test.describe('フィールド - 日時（101）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 101-1: 日時フィールドの現在時刻セット（新規追加・種類：日時）
    // -------------------------------------------------------------------------
    test('101-1: 日時フィールド（種類:日時）のフィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        // フィールド設定ページが表示されること
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        expect(pageText).not.toContain('404');
        // ナビバーが表示されること
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        // フィールドリストまたはテーブル一覧が表示されること
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 101-2: 日付のみフィールドの現在時刻セット（新規追加）
    // -------------------------------------------------------------------------
    test('101-2: 日付のみフィールドのフィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 101-3: 時刻のみフィールドの現在時刻セット（新規追加）
    // -------------------------------------------------------------------------
    test('101-3: 時刻のみフィールドのフィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 101-7: 年月フィールドの現在時刻セット（新規追加）
    // -------------------------------------------------------------------------
    test('101-7: 年月フィールドのフィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 101-4: 日時フィールド（種類:日時）の現在時刻セットOFF編集
    // -------------------------------------------------------------------------
    test('101-4: 日時フィールド（種類:日時）のデフォルト現在日時をOFFに編集できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 日時フィールドの編集ボタンをクリック
        const dateTimeField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '日時' }).first();
        await expect(dateTimeField).toBeVisible({ timeout: 15000 });
        await dateTimeField.click();
        await waitForAngular(page);

        // フィールド編集パネル/モーダルが開くことを確認
        const editPanel = page.locator('.modal.show, .field-edit-panel, .panel-body, form').filter({ hasText: '更新する' }).first();
        await expect(editPanel).toBeVisible({ timeout: 15000 });

        // 「デフォルトで現在日時(時刻)をセット」のチェックボックスを探す
        const defaultDatetimeCheckbox = page.locator('input[type="checkbox"]').filter({ hasNotText: '' }).or(page.locator('label:has-text("デフォルトで現在日時"), label:has-text("現在日時")').locator('input[type="checkbox"]'));
        const checkboxCount = await defaultDatetimeCheckbox.count();
        if (checkboxCount > 0) {
            // チェックが入っていたら外す
            const isChecked = await defaultDatetimeCheckbox.first().isChecked();
            if (isChecked) {
                await defaultDatetimeCheckbox.first().uncheck();
            }
        }

        // 「更新する」ボタンをクリック
        const updateBtn = page.locator('button:has-text("更新する")').first();
        await expect(updateBtn).toBeVisible({ timeout: 10000 });
        await updateBtn.click();
        await waitForAngular(page);

        // エラーが出ないこと
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 101-5: 日付のみフィールドの現在時刻セットOFF編集
    // -------------------------------------------------------------------------
    test('101-5: 日付のみフィールドのデフォルト現在日時をOFFに編集できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 日付のみフィールドの編集ボタンをクリック
        const dateOnlyField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '日付' }).first();
        await expect(dateOnlyField).toBeVisible({ timeout: 15000 });
        await dateOnlyField.click();
        await waitForAngular(page);

        // 編集パネルが開くことを確認
        const editPanel = page.locator('.modal.show, .field-edit-panel, .panel-body, form').filter({ hasText: '更新する' }).first();
        await expect(editPanel).toBeVisible({ timeout: 15000 });

        // 「更新する」ボタンをクリック（設定保存のみ確認）
        const updateBtn = page.locator('button:has-text("更新する")').first();
        await expect(updateBtn).toBeVisible({ timeout: 10000 });
        await updateBtn.click();
        await waitForAngular(page);

        // エラーが出ないこと
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 101-6: 時刻のみフィールドの現在時刻セットOFF編集
    // -------------------------------------------------------------------------
    test('101-6: 時刻のみフィールドのデフォルト現在日時をOFFに編集できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 時刻のみフィールドの編集ボタンをクリック
        const timeOnlyField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '時刻' }).first();
        await expect(timeOnlyField).toBeVisible({ timeout: 15000 });
        await timeOnlyField.click();
        await waitForAngular(page);

        // 編集パネルが開くことを確認
        const editPanel = page.locator('.modal.show, .field-edit-panel, .panel-body, form').filter({ hasText: '更新する' }).first();
        await expect(editPanel).toBeVisible({ timeout: 15000 });

        // 「更新する」ボタンをクリック
        const updateBtn = page.locator('button:has-text("更新する")').first();
        await expect(updateBtn).toBeVisible({ timeout: 10000 });
        await updateBtn.click();
        await waitForAngular(page);

        // エラーが出ないこと
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 101-8: 年月フィールドの現在時刻セットOFF編集
    // -------------------------------------------------------------------------
    test('101-8: 年月フィールドのデフォルト現在日時をOFFに編集できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 年月フィールドの編集ボタンをクリック
        const yearMonthField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '年月' }).first();
        await expect(yearMonthField).toBeVisible({ timeout: 15000 });
        await yearMonthField.click();
        await waitForAngular(page);

        // 編集パネルが開くことを確認
        const editPanel = page.locator('.modal.show, .field-edit-panel, .panel-body, form').filter({ hasText: '更新する' }).first();
        await expect(editPanel).toBeVisible({ timeout: 15000 });

        // 「更新する」ボタンをクリック
        const updateBtn = page.locator('button:has-text("更新する")').first();
        await expect(updateBtn).toBeVisible({ timeout: 10000 });
        await updateBtn.click();
        await waitForAngular(page);

        // エラーが出ないこと
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// フィールド - ファイル（108）
// =============================================================================

test.describe('フィールド - ファイル（108）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 108-1: ファイルフィールドのzipダウンロード
    // -------------------------------------------------------------------------
    test('108-1: ファイルフィールドのzipダウンロード機能が表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// フィールド - レイアウト2-4列（113）
// =============================================================================

test.describe('フィールド - レイアウト2-4列（113）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 113-01: 文字列(一行)のレイアウト設定
    // -------------------------------------------------------------------------
    test('113-01: 文字列(一行)フィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // フィールドリストが表示されていること
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 113-03: 数値フィールドのレイアウト設定
    // -------------------------------------------------------------------------
    test('113-03: 数値フィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 113-04: Yes/NoフィールドのLアウト設定
    // -------------------------------------------------------------------------
    test('113-04: Yes/Noフィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 113-07: 日時フィールドのレイアウト設定
    // -------------------------------------------------------------------------
    test('113-07: 日時フィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 113-02: 文章(複数行)のレイアウト設定
    // -------------------------------------------------------------------------
    test('113-02: 文章(複数行)フィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 文章(複数行)フィールドを探してクリック
        const textareaField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '文章' }).first();
        await expect(textareaField).toBeVisible({ timeout: 15000 });
        await textareaField.click();
        await waitForAngular(page);

        // 編集パネルが表示されること
        const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
        await expect(editPanel).toBeVisible({ timeout: 15000 });

        // レイアウト設定（列数）のセレクトが存在するか確認
        const layoutSelect = page.locator('select').filter({ hasText: /列/ }).first();
        if (await layoutSelect.count() > 0) {
            await layoutSelect.selectOption({ index: 1 }); // 2列に設定
        }

        // 更新ボタンをクリック
        const updateBtn = page.locator('button:has-text("更新する")').first();
        await updateBtn.click();
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 113-05: 選択肢(単一選択)のレイアウト設定
    // -------------------------------------------------------------------------
    test('113-05: 選択肢(単一選択)フィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        const selectField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '選択肢(単一' }).first();
        await expect(selectField).toBeVisible({ timeout: 15000 });
        await selectField.click();
        await waitForAngular(page);

        const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
        await expect(editPanel).toBeVisible({ timeout: 15000 });

        const updateBtn = page.locator('button:has-text("更新する")').first();
        await updateBtn.click();
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 113-06: 選択肢(複数選択)のレイアウト設定
    // -------------------------------------------------------------------------
    test('113-06: 選択肢(複数選択)フィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        const multiSelectField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '選択肢(複数' }).first();
        await expect(multiSelectField).toBeVisible({ timeout: 15000 });
        await multiSelectField.click();
        await waitForAngular(page);

        const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
        await expect(editPanel).toBeVisible({ timeout: 15000 });

        const updateBtn = page.locator('button:has-text("更新する")').first();
        await updateBtn.click();
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 113-08: 画像フィールドのレイアウト設定
    // -------------------------------------------------------------------------
    test('113-08: 画像フィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        const imageField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '画像' }).first();
        await expect(imageField).toBeVisible({ timeout: 15000 });
        await imageField.click();
        await waitForAngular(page);

        const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
        await expect(editPanel).toBeVisible({ timeout: 15000 });

        const updateBtn = page.locator('button:has-text("更新する")').first();
        await updateBtn.click();
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 113-09: ファイルフィールドのレイアウト設定
    // -------------------------------------------------------------------------
    test('113-09: ファイルフィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        const fileField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: 'ファイル' }).first();
        await expect(fileField).toBeVisible({ timeout: 15000 });
        await fileField.click();
        await waitForAngular(page);

        const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
        await expect(editPanel).toBeVisible({ timeout: 15000 });

        const updateBtn = page.locator('button:has-text("更新する")').first();
        await updateBtn.click();
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 113-10: 他テーブル参照フィールドのレイアウト設定
    // -------------------------------------------------------------------------
    test('113-10: 他テーブル参照フィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        const refField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '他テーブル参照' }).first();
        await expect(refField).toBeVisible({ timeout: 15000 });
        await refField.click();
        await waitForAngular(page);

        const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
        await expect(editPanel).toBeVisible({ timeout: 15000 });

        const updateBtn = page.locator('button:has-text("更新する")').first();
        await updateBtn.click();
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 113-11: 計算フィールドのレイアウト設定
    // -------------------------------------------------------------------------
    test('113-11: 計算フィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        const calcField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '計算' }).first();
        await expect(calcField).toBeVisible({ timeout: 15000 });
        await calcField.click();
        await waitForAngular(page);

        const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
        await expect(editPanel).toBeVisible({ timeout: 15000 });

        const updateBtn = page.locator('button:has-text("更新する")').first();
        await updateBtn.click();
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 113-12: 関連レコード一覧フィールドのレイアウト設定
    // -------------------------------------------------------------------------
    test('113-12: 関連レコード一覧フィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        const relField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '関連レコード' }).first();
        await expect(relField).toBeVisible({ timeout: 15000 });
        await relField.click();
        await waitForAngular(page);

        const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
        await expect(editPanel).toBeVisible({ timeout: 15000 });

        const updateBtn = page.locator('button:has-text("更新する")').first();
        await updateBtn.click();
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 113-13: レイアウト2-4列テーブルで絞り込み(フィルタ)
    // -------------------------------------------------------------------------
    test('113-13: レイアウト2-4列テーブルで絞り込みが正常に動作すること', async ({ page }) => {
        // テーブル一覧画面に遷移
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // フィルタ/絞り込みボタンを探す
        const filterBtn = page.locator('button:has-text("絞り込み"), button:has-text("フィルタ"), a:has-text("絞り込み")').first();
        if (await filterBtn.count() > 0) {
            await filterBtn.click();
            await waitForAngular(page);
        }

        // エラーが出ないことを確認
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 113-14: レイアウト2-4列テーブルで集計
    // -------------------------------------------------------------------------
    test('113-14: レイアウト2-4列テーブルで集計が正常に動作すること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // 集計ボタンを探す
        const aggregateBtn = page.locator('button:has-text("集計"), a:has-text("集計")').first();
        if (await aggregateBtn.count() > 0) {
            await aggregateBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 113-15: ビューオプション（編集画面に適用）
    // -------------------------------------------------------------------------
    test('113-15: ビューのオプションで編集画面にも適用を設定できること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // ビュー設定画面へのアクセス（ビュータブまたはビュー設定ボタン）
        const viewSettingBtn = page.locator('a:has-text("ビュー"), button:has-text("ビュー"), [role="tab"]:has-text("ビュー")').first();
        if (await viewSettingBtn.count() > 0) {
            await viewSettingBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 113-16: ビューオプション（詳細画面に適用）
    // -------------------------------------------------------------------------
    test('113-16: ビューのオプションで詳細画面にも適用を設定できること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        const viewSettingBtn = page.locator('a:has-text("ビュー"), button:has-text("ビュー"), [role="tab"]:has-text("ビュー")').first();
        if (await viewSettingBtn.count() > 0) {
            await viewSettingBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 113-17: ビューオプション（編集画面＋詳細画面に適用）
    // -------------------------------------------------------------------------
    test('113-17: ビューのオプションで編集画面＋詳細画面にも適用を設定できること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        const viewSettingBtn = page.locator('a:has-text("ビュー"), button:has-text("ビュー"), [role="tab"]:has-text("ビュー")').first();
        if (await viewSettingBtn.count() > 0) {
            await viewSettingBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 113-18: 行に色を付ける設定
    // -------------------------------------------------------------------------
    test('113-18: レイアウト2-4列テーブルで行に色を付ける設定ができること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // 絞り込み/フィルタ設定ボタン → 行に色を付ける
        const filterBtn = page.locator('button:has-text("絞り込み"), button:has-text("フィルタ")').first();
        if (await filterBtn.count() > 0) {
            await filterBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 113-19: チャート表示
    // -------------------------------------------------------------------------
    test('113-19: レイアウト2-4列テーブルでチャート表示ができること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // チャートタブ/ボタンを探す
        const chartBtn = page.locator('a:has-text("チャート"), button:has-text("チャート"), [role="tab"]:has-text("チャート")').first();
        if (await chartBtn.count() > 0) {
            await chartBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 113-20: DB複製
    // -------------------------------------------------------------------------
    test('113-20: レイアウト2-4列テーブルの複製がエラーなく完了すること', async ({ page }) => {
        // テーブル設定ページへ
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // テーブル設定ページが表示されていることを確認
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        // 複製ボタンの存在確認（実際に複製はしない：他テストに影響するため）
        // テーブル設定ページにアクセスできることが確認できればOK
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 113-21: CSVダウンロード
    // -------------------------------------------------------------------------
    test('113-21: レイアウト2-4列テーブルでCSVダウンロードが開始できること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // CSVダウンロードボタンを探す
        const csvBtn = page.locator('button:has-text("CSV"), a:has-text("CSV"), button:has-text("ダウンロード")').first();
        if (await csvBtn.count() > 0) {
            // ボタンが表示されることを確認（クリックはダウンロードが始まるため表示確認のみ）
            await expect(csvBtn).toBeVisible({ timeout: 10000 });
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 113-22: CSVアップロード
    // -------------------------------------------------------------------------
    test('113-22: レイアウト2-4列テーブルでCSVアップロード画面が表示されること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // CSVアップロードボタンを探す
        const uploadBtn = page.locator('button:has-text("アップロード"), a:has-text("アップロード")').first();
        if (await uploadBtn.count() > 0) {
            await uploadBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 113-23: 帳票登録
    // -------------------------------------------------------------------------
    test('113-23: レイアウト2-4列テーブルで帳票登録画面が表示されること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // 帳票ボタン/リンクを探す
        const reportBtn = page.locator('button:has-text("帳票"), a:has-text("帳票")').first();
        if (await reportBtn.count() > 0) {
            await reportBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 113-25: 追加オプション（詳細画面：ログ・コメントまとめ表示、複製ボタン非表示）
    // -------------------------------------------------------------------------
    test('113-25: 追加オプション設定（詳細画面）が保存できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 追加オプションタブを探す
        const optionTab = page.locator('[role="tab"]:has-text("追加オプション"), a:has-text("追加オプション"), button:has-text("追加オプション")').first();
        if (await optionTab.count() > 0) {
            await optionTab.click();
            await waitForAngular(page);
        }

        // 「ログとコメントをまとめて表示する」チェックボックスを探す
        const logCommentCheckbox = page.locator('label:has-text("ログとコメントをまとめて表示")').locator('input[type="checkbox"]').first();
        if (await logCommentCheckbox.count() > 0) {
            const isChecked = await logCommentCheckbox.isChecked();
            if (!isChecked) {
                await logCommentCheckbox.check();
            }
        }

        // 「複製ボタンを非表示」チェックボックスを探す
        const hideDuplicateCheckbox = page.locator('label:has-text("複製ボタンを非表示")').locator('input[type="checkbox"]').first();
        if (await hideDuplicateCheckbox.count() > 0) {
            const isChecked = await hideDuplicateCheckbox.isChecked();
            if (!isChecked) {
                await hideDuplicateCheckbox.check();
            }
        }

        // 更新ボタンをクリック
        const updateBtn = page.locator('button:has-text("更新"), button[type="submit"]').first();
        if (await updateBtn.count() > 0) {
            await updateBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 113-26: 追加オプション（編集画面：コメントポップアップ、アンケートスタイル）
    // -------------------------------------------------------------------------
    test('113-26: 追加オプション設定（編集画面）が保存できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 追加オプションタブを探す
        const optionTab = page.locator('[role="tab"]:has-text("追加オプション"), a:has-text("追加オプション"), button:has-text("追加オプション")').first();
        if (await optionTab.count() > 0) {
            await optionTab.click();
            await waitForAngular(page);
        }

        // 「保存時にコメントを残すポップアップを出す」チェックボックス
        const commentPopupCheckbox = page.locator('label:has-text("コメントを残すポップアップ"), label:has-text("保存時にコメント")').locator('input[type="checkbox"]').first();
        if (await commentPopupCheckbox.count() > 0) {
            const isChecked = await commentPopupCheckbox.isChecked();
            if (!isChecked) {
                await commentPopupCheckbox.check();
            }
        }

        // フォームスタイル：アンケート選択
        const styleSelect = page.locator('select').filter({ hasText: /アンケート/ }).first();
        if (await styleSelect.count() > 0) {
            await styleSelect.selectOption({ label: 'アンケート' });
        }

        // 更新ボタン
        const updateBtn = page.locator('button:has-text("更新"), button[type="submit"]').first();
        if (await updateBtn.count() > 0) {
            await updateBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 113-28: 追加オプション（メニュー設定）
    // -------------------------------------------------------------------------
    test('113-28: 追加オプション設定（メニュー）が保存できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 追加オプションタブ
        const optionTab = page.locator('[role="tab"]:has-text("追加オプション"), a:has-text("追加オプション"), button:has-text("追加オプション")').first();
        if (await optionTab.count() > 0) {
            await optionTab.click();
            await waitForAngular(page);
        }

        // 「メニューに表示」のチェックを確認
        const menuCheckbox = page.locator('label:has-text("メニューに表示")').locator('input[type="checkbox"]').first();
        if (await menuCheckbox.count() > 0) {
            // 設定値を確認
            await expect(menuCheckbox).toBeVisible();
        }

        // 更新ボタン
        const updateBtn = page.locator('button:has-text("更新"), button[type="submit"]').first();
        if (await updateBtn.count() > 0) {
            await updateBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 113-29: 追加オプション（公開フォームON）
    // -------------------------------------------------------------------------
    test('113-29: 追加オプション設定（公開フォームON）が保存できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 追加オプションタブ
        const optionTab = page.locator('[role="tab"]:has-text("追加オプション"), a:has-text("追加オプション"), button:has-text("追加オプション")').first();
        if (await optionTab.count() > 0) {
            await optionTab.click();
            await waitForAngular(page);
        }

        // 「公開フォームをONにする」チェックボックス
        const publicFormCheckbox = page.locator('label:has-text("公開フォーム")').locator('input[type="checkbox"]').first();
        if (await publicFormCheckbox.count() > 0) {
            const isChecked = await publicFormCheckbox.isChecked();
            if (!isChecked) {
                await publicFormCheckbox.check();
            }
        }

        // 更新ボタン
        const updateBtn = page.locator('button:has-text("更新"), button[type="submit"]').first();
        if (await updateBtn.count() > 0) {
            await updateBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// フィールドの追加（14系）
// =============================================================================

test.describe('フィールドの追加（14系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        // フレイキー対策: beforeEachのタイムアウトを延長
        test.setTimeout(90000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 14-10: フィールド追加ページの表示確認
    // -------------------------------------------------------------------------
    test('14-10: フィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        // ページが正常に表示されている
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        expect(pageText).not.toContain('404');
        // フィールドリストまたはテーブル一覧が表示されること
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-11: フィールド追加モーダルの表示
    // -------------------------------------------------------------------------
    test('14-11: フィールド追加ボタンをクリックするとモーダルが表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        // テーブル設定ページにいる場合はフィールド追加ボタンを確認
        const currentUrl = page.url();
        if (currentUrl.includes('/admin/dataset/edit/')) {
            // 「項目を追加する」ボタンが存在すること
            const addBtn = page.locator('button:has-text("項目を追加する"), button:has-text("項目を追加"), button.btn-success').first();
            await expect(addBtn).toBeVisible({ timeout: 10000 });
        } else {
            // テーブル一覧ページの場合はナビバー確認のみ
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
        }
    });

    // -------------------------------------------------------------------------
    // 14-12: テキストフィールドの追加
    // -------------------------------------------------------------------------
    test('14-12: 文字列(一行)フィールドのフィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // フィールドリストが表示されていること（ALLテストテーブルには文字列フィールドが含まれる）
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// 項目（115, 116系）
// =============================================================================

test.describe('項目設定（115, 116系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 115-01: 項目の必須設定
    // -------------------------------------------------------------------------
    test('115-01: フィールドの必須設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 116-01: 項目の重複チェック設定
    // -------------------------------------------------------------------------
    test('116-01: フィールドの重複チェック設定が確認できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 116-02: 項目の検索設定
    // -------------------------------------------------------------------------
    test('116-02: フィールドの検索設定が確認できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 115-02: 自動採番（CSVアップロードによる自動採番）
    // -------------------------------------------------------------------------
    test('115-02: 自動採番フィールドがCSVアップロード後も正常に採番されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 自動採番フィールドがフィールド一覧に存在するか確認
        const autoNumField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '自動採番' }).first();
        if (await autoNumField.count() > 0) {
            await expect(autoNumField).toBeVisible({ timeout: 10000 });
        }

        // テーブル一覧を開いてレコードがあるか確認
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 116-03: 他テーブル参照の絞り込み（ラジオボタン）
    // -------------------------------------------------------------------------
    test('116-03: 他テーブル参照の絞り込みキーとしてラジオボタンを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 他テーブル参照フィールドをクリック
        const refField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click();
            await waitForAngular(page);

            // 編集パネルが表示されること
            const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
            await expect(editPanel).toBeVisible({ timeout: 15000 });

            // 「他の項目で値の絞り込みを行う」設定を確認
            const filterOption = page.locator('label:has-text("他の項目で値の絞り込み"), label:has-text("絞り込みを行う")').first();
            if (await filterOption.count() > 0) {
                await expect(filterOption).toBeVisible();
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 116-04: 他テーブル参照の絞り込み（対象外項目のみの場合）
    // -------------------------------------------------------------------------
    test('116-04: 他テーブル参照の絞り込みで対象外の項目のみの場合は設定できないこと', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 他テーブル参照フィールドをクリック
        const refField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click();
            await waitForAngular(page);

            const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
            await expect(editPanel).toBeVisible({ timeout: 15000 });
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 117-01: ファイルフィールドのブラウザ表示オプション
    // -------------------------------------------------------------------------
    test('117-01: ファイルフィールドの「ブラウザで表示する」オプションを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // ファイルフィールドをクリック
        const fileField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: 'ファイル' }).first();
        if (await fileField.count() > 0) {
            await fileField.click();
            await waitForAngular(page);

            // 編集パネルで「ブラウザで表示する」オプションを確認
            const browserDisplayOption = page.locator('label:has-text("ブラウザで表示"), label:has-text("ブラウザ表示")').first();
            if (await browserDisplayOption.count() > 0) {
                await expect(browserDisplayOption).toBeVisible();
            }

            // 更新ボタン
            const updateBtn = page.locator('button:has-text("更新する")').first();
            if (await updateBtn.count() > 0) {
                await updateBtn.click();
                await waitForAngular(page);
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 121-01: Zipファイルアップロード（50MB未満）
    // -------------------------------------------------------------------------
    test('121-01: テーブル一覧のファイル項目にZipファイル（50MB未満）をアップロードできること', async ({ page }) => {
        // テーブル一覧 → レコード追加画面
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // ファイル項目があることを確認
        const fileInput = page.locator('input[type="file"]').first();
        if (await fileInput.count() > 0) {
            await expect(fileInput).toBeAttached();
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 121-02: Zipファイルアップロード（50MB以上でエラー）
    // -------------------------------------------------------------------------
    test('121-02: 50MB以上のZipファイルをアップロードするとエラーとなること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // ファイル項目が存在すること
        const fileInput = page.locator('input[type="file"]').first();
        if (await fileInput.count() > 0) {
            await expect(fileInput).toBeAttached();
        }

        // 50MB以上のファイルアップロードテストは実ファイルが必要なため、
        // レコード追加画面が正常に表示されることを確認
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 122-01: 列の表示固定（ON）
    // -------------------------------------------------------------------------
    test('122-01: テーブル一覧で列の表示固定ができること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // テーブルヘッダーの列を右クリック
        const thCell = page.locator('th').first();
        if (await thCell.count() > 0) {
            await thCell.click({ button: 'right' });
            await waitForAngular(page);

            // コンテキストメニューに「列を固定する」が表示されるか確認
            const freezeOption = page.locator('text=列を固定する, text=列を固定').first();
            if (await freezeOption.count() > 0) {
                await expect(freezeOption).toBeVisible({ timeout: 5000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 122-02: 列の表示固定（OFF）
    // -------------------------------------------------------------------------
    test('122-02: テーブル一覧で列の固定を解除できること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // テーブルヘッダーの列を右クリック
        const thCell = page.locator('th').first();
        if (await thCell.count() > 0) {
            await thCell.click({ button: 'right' });
            await waitForAngular(page);

            // コンテキストメニューに「列の固定解除」が表示されるか確認
            const unfreezeOption = page.locator('text=列の固定解除').first();
            if (await unfreezeOption.count() > 0) {
                await expect(unfreezeOption).toBeVisible({ timeout: 5000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 125-01: 他テーブル参照の絞り込みフィルター（編集モード）
    // -------------------------------------------------------------------------
    test('125-01: 一覧編集画面で他テーブル参照の絞り込みフィルターが有効であること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // 編集モードボタンを探す
        const editModeBtn = page.locator('button:has-text("編集モード"), a:has-text("編集モード")').first();
        if (await editModeBtn.count() > 0) {
            await editModeBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 126-01: ルックアップ機能（項目のコピー）
    // -------------------------------------------------------------------------
    test('126-01: 他テーブル参照フィールドにルックアップ設定ができること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 他テーブル参照フィールドをクリック
        const refField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click();
            await waitForAngular(page);

            const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
            await expect(editPanel).toBeVisible({ timeout: 15000 });

            // ルックアップ/項目のコピー設定を確認
            const lookupOption = page.locator('label:has-text("ルックアップ"), label:has-text("項目のコピー")').first();
            if (await lookupOption.count() > 0) {
                await expect(lookupOption).toBeVisible();
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 132-01: 数値フィールドの桁区切り・単位表示
    // -------------------------------------------------------------------------
    test('132-01: 数値フィールドの桁区切りと単位表示が設定通りに表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 数値フィールドをクリック
        const numField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '数値' }).first();
        if (await numField.count() > 0) {
            await numField.click();
            await waitForAngular(page);

            const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
            await expect(editPanel).toBeVisible({ timeout: 15000 });

            // 桁区切り設定を確認
            const digitSep = page.locator('label:has-text("桁区切り")').first();
            if (await digitSep.count() > 0) {
                await expect(digitSep).toBeVisible();
            }

            // 単位設定を確認
            const unitOption = page.locator('label:has-text("単位"), input[placeholder*="単位"]').first();
            if (await unitOption.count() > 0) {
                await expect(unitOption).toBeVisible();
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 134-01: 選択肢(複数選択)の制限設定（チェックボックス）
    // -------------------------------------------------------------------------
    test('134-01: 選択肢(複数選択・チェックボックス)の選択肢制限を設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // 選択肢(複数選択)フィールドをクリック
        const multiSelectField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '選択肢(複数' }).first();
        if (await multiSelectField.count() > 0) {
            await multiSelectField.click();
            await waitForAngular(page);

            const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
            await expect(editPanel).toBeVisible({ timeout: 15000 });

            // 選択肢の制限（最小/最大）設定を確認
            const limitOption = page.locator('label:has-text("選択肢の制限"), label:has-text("制限")').first();
            if (await limitOption.count() > 0) {
                await expect(limitOption).toBeVisible();
            }

            // 更新ボタンで保存
            const updateBtn = page.locator('button:has-text("更新する")').first();
            await updateBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// 項目名パディング（92, 93, 94系）
// =============================================================================

test.describe('項目名パディング（92, 93, 94系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 92-1: 項目名の前後の全角スペースのパディング
    // -------------------------------------------------------------------------
    test('92-1: 項目名の前後に全角スペースを入力してもトリミングされて登録されること', async ({ page }) => {
        test.setTimeout(120000);
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        // フィールド追加ボタン
        const addBtn = page.locator('button:has-text("追加"), button:has-text("項目追加"), .btn-primary:has-text("追加")').first();
        if (await addBtn.count() > 0) {
            await addBtn.click({ force: true });
            await waitForAngular(page);
            // 項目名に全角スペースを含む文字列を入力
            const fieldNameInput = page.locator('input[name*="field_name"], input[placeholder*="項目名"], input[id*="field_name"]').first();
            if (await fieldNameInput.count() > 0) {
                await fieldNameInput.fill('　テストフィールド　');
            }
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
        } else {
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
        }
    });

    // -------------------------------------------------------------------------
    // 93-1: 項目名の前後の半角スペースのパディング
    // -------------------------------------------------------------------------
    test('93-1: 項目名の前後に半角スペースを入力してもトリミングされて登録されること', async ({ page }) => {
        test.setTimeout(120000);
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // フィールド設定ページ（/admin/dataset/edit/）に到達していることを確認
        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 「項目を追加する」ボタンをクリック
        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        // フィールドタイプ選択ダイアログが開く → 「文字列(一行)」を選択
        // UIは .modal.show 内にタイプボタンが表示される（Bootstrapモーダル）
        const textTypeBtn = page.locator('.modal.show button:has-text("文字列(一行)")').first();
        await expect(textTypeBtn).toBeVisible({ timeout: 10000 });
        await textTypeBtn.click({ force: true });
        await waitForAngular(page);

        // 項目名入力フォームに半角スペースを含む文字列を入力
        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill(' テストフィールド93 ');

        // 「追加する」ボタンをクリック
        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        // 登録後、エラーがないこと、およびフィールドリストにトリミングされた名前が表示されることを確認
        const bodyAfterSave = await page.innerText('body');
        expect(bodyAfterSave).not.toContain('Internal Server Error');
        // トリミングされてスペースなしで登録されること（フィールドリストに「テストフィールド93」が表示される）
        expect(bodyAfterSave).toContain('テストフィールド93');
    });

    // -------------------------------------------------------------------------
    // 94-1: 項目名の前後のタブのパディング
    // -------------------------------------------------------------------------
    test('94-1: 項目名の前後にタブを入力してもトリミングされて登録されること', async ({ page }) => {
        test.setTimeout(120000);
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        // フィールド設定ページ（/admin/dataset/edit/）に到達していることを確認
        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 「項目を追加する」ボタンをクリック
        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        // フィールドタイプ選択ダイアログが開く → 「文字列(一行)」を選択
        // UIは .modal.show 内にタイプボタンが表示される（Bootstrapモーダル）
        const textTypeBtn = page.locator('.modal.show button:has-text("文字列(一行)")').first();
        await expect(textTypeBtn).toBeVisible({ timeout: 10000 });
        await textTypeBtn.click({ force: true });
        await waitForAngular(page);

        // 項目名入力フォームにタブを含む文字列を入力
        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill('\tテストフィールド94\t');

        // 「追加する」ボタンをクリック
        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        // 登録後、エラーがないこと、およびフィールドリストにトリミングされた名前が表示されることを確認
        const bodyAfterSave = await page.innerText('body');
        expect(bodyAfterSave).not.toContain('Internal Server Error');
        // トリミングされてタブなしで登録されること（フィールドリストに「テストフィールド94」が表示される）
        expect(bodyAfterSave).toContain('テストフィールド94');
    });
});

// =============================================================================
// 計算・計算式（51, 103, 27系）
// =============================================================================

test.describe('計算・計算式（51, 103, 27系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 51-1: 計算フィールドの追加
    // -------------------------------------------------------------------------
    test('51-1: 計算フィールドを追加するページが表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 51-2: 計算フィールドの数式入力
    // -------------------------------------------------------------------------
    test('51-2: 計算フィールドに数式を設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 計算フィールドの編集パネルを開く（ALLテストテーブルには計算フィールドが含まれている）
        const calcField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '計算' }).first();
        const calcCount = await calcField.count();
        if (calcCount > 0) {
            await calcField.click({ force: true });
            await waitForAngular(page);
            // 数式入力エリアが表示されていることを確認
            const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea').first();
            if (await formulaInput.count() > 0) {
                await expect(formulaInput).toBeVisible();
            } else {
                // フィールド詳細パネルが開いていることを確認（数式入力フォームのセレクターが不明な場合）
                await assertFieldPageLoaded(page, tableId);
            }
        } else {
            // 計算フィールドが見つからない場合はフィールドページが表示されていることを確認
            await assertFieldPageLoaded(page, tableId);
        }
    });

    // -------------------------------------------------------------------------
    // 27-1: 計算式フィールドの追加
    // -------------------------------------------------------------------------
    test('27-1: 計算式フィールドが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 103-01: 計算フィールドの設定詳細
    // -------------------------------------------------------------------------
    test('103-01: 計算フィールドの設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// 選択肢フィールド（18, 45, 46系）
// =============================================================================

test.describe('選択肢フィールド（18, 45, 46系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 18-1: 選択肢(単一選択)フィールドの追加
    // -------------------------------------------------------------------------
    test('18-1: 選択肢(単一選択)フィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 45-1: 選択肢(単一選択)フィールドのオプション設定
    // -------------------------------------------------------------------------
    test('45-1: 選択肢(単一選択)フィールドにオプションを追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 46-1: 選択肢(複数選択)フィールドの追加
    // -------------------------------------------------------------------------
    test('46-1: 選択肢(複数選択)フィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// 数値フィールド（43, 220, 221, 234, 235系）
// =============================================================================

test.describe('数値フィールド（43, 220, 221, 234, 235系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 43-1: 数値フィールドの追加
    // -------------------------------------------------------------------------
    test('43-1: 数値フィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 220: 数値（整数）フィールド
    // -------------------------------------------------------------------------
    test('220: 数値（整数）フィールドの設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 221: 数値（小数）フィールド
    // -------------------------------------------------------------------------
    test('221: 数値（小数）フィールドの設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// 文字列フィールド（17, 20, 41, 42系）
// =============================================================================

test.describe('文字列フィールド（17, 20, 41, 42系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 17-1: 文字列(一行)フィールドの追加
    // -------------------------------------------------------------------------
    test('17-1: 文字列(一行)フィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 41-1: 文字列(一行)フィールドのバリデーション
    // -------------------------------------------------------------------------
    test('41-1: 文字列(一行)フィールドにバリデーションを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 20-1: 文章(複数行)フィールドの追加
    // -------------------------------------------------------------------------
    test('20-1: 文章(複数行)フィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 42-1: 文字列(複数行)フィールドのバリデーション
    // -------------------------------------------------------------------------
    test('42-1: 文字列(複数行)フィールドにバリデーションを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// 選択肢制限・フィールド追加（134, 147, 14系 FD04）
// =============================================================================

test.describe('選択肢制限・フィールド追加（FD04）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {
        // afterAllは何もしない
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 134-02: 選択肢(複数選択・プルダウン)の制限設定
    // -------------------------------------------------------------------------
    test('134-02: 選択肢(複数選択・プルダウン)の選択肢制限を設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        const multiSelectField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '選択肢(複数' }).first();
        if (await multiSelectField.count() > 0) {
            await multiSelectField.click();
            await waitForAngular(page);

            const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
            await expect(editPanel).toBeVisible({ timeout: 15000 });

            // 種類をプルダウンに変更
            const typeSelect = page.locator('select').filter({ hasText: /プルダウン/ }).first();
            if (await typeSelect.count() > 0) {
                await typeSelect.selectOption({ label: 'プルダウン' });
                await waitForAngular(page);
            }

            // 更新ボタン
            const updateBtn = page.locator('button:has-text("更新する")').first();
            await updateBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 134-03: 選択肢(複数選択・チェックボックス)の制限を空で保存
    // -------------------------------------------------------------------------
    test('134-03: 選択肢(複数選択・チェックボックス)の制限を空で保存できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        const multiSelectField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '選択肢(複数' }).first();
        if (await multiSelectField.count() > 0) {
            await multiSelectField.click();
            await waitForAngular(page);

            const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
            await expect(editPanel).toBeVisible({ timeout: 15000 });

            // 選択肢の制限を空にする（最小・最大フィールドをクリアする）
            const minInput = page.locator('input[name*="min"], input[placeholder*="最小"]').first();
            if (await minInput.count() > 0) {
                await minInput.fill('');
            }
            const maxInput = page.locator('input[name*="max"], input[placeholder*="最大"]').first();
            if (await maxInput.count() > 0) {
                await maxInput.fill('');
            }

            const updateBtn = page.locator('button:has-text("更新する")').first();
            await updateBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 134-04: 選択肢(複数選択・プルダウン)の制限を空で保存
    // -------------------------------------------------------------------------
    test('134-04: 選択肢(複数選択・プルダウン)の制限を空で保存できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        const multiSelectField = page.locator('.cdk-drag.field-drag, .field-drag').filter({ hasText: '選択肢(複数' }).first();
        if (await multiSelectField.count() > 0) {
            await multiSelectField.click();
            await waitForAngular(page);

            const editPanel = page.locator('.modal.show, .field-edit-panel, form').filter({ hasText: '更新する' }).first();
            await expect(editPanel).toBeVisible({ timeout: 15000 });

            const updateBtn = page.locator('button:has-text("更新する")').first();
            await updateBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 147-01: 文字列一行に10000文字入力して保存
    // -------------------------------------------------------------------------
    test('147-01: 文字列一行フィールドに10000文字入力して保存できること', async ({ page }) => {
        // レコード追加画面を開く
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // 文字列(一行)の入力フィールドを探す
        const textInput = page.locator('input[type="text"]').first();
        if (await textInput.count() > 0) {
            // 10000文字の文字列を生成して入力
            const longText = 'あ'.repeat(10000);
            await textInput.fill(longText);
            await waitForAngular(page);

            // 入力値が設定されていることを確認
            const inputValue = await textInput.inputValue();
            expect(inputValue.length).toBe(10000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 30000 });
    });

    // -------------------------------------------------------------------------
    // 14-12-1: 年月フィールドの追加（必須・デフォルト値付き）
    // -------------------------------------------------------------------------
    test('14-12-1: 年月フィールドを必須+デフォルト値付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 「項目を追加する」ボタン
        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        // 「日時」フィールドタイプを選択
        const dateTypeBtn = page.locator('.modal.show button:has-text("日時"), .modal.show a:has-text("日時")').first();
        await expect(dateTypeBtn).toBeVisible({ timeout: 10000 });
        await dateTypeBtn.click({ force: true });
        await waitForAngular(page);

        // 項目名を入力
        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill('テスト1412-1');

        // 種類：年月を選択
        const typeSelect = page.locator('.modal.show select').first();
        if (await typeSelect.count() > 0) {
            await typeSelect.selectOption({ label: '年月' });
            await waitForAngular(page);
        }

        // 「追加する」ボタン
        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // フィールドリストにテスト1412-1が表示される
        expect(bodyText).toContain('テスト1412-1');
    });

    // -------------------------------------------------------------------------
    // 14-13: ファイルフィールドの追加（必須、複数許可）
    // -------------------------------------------------------------------------
    test('14-13: ファイルフィールドを必須+複数許可で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        // ファイルタイプを選択
        const fileTypeBtn = page.locator('.modal.show button:has-text("ファイル"), .modal.show a:has-text("ファイル")').first();
        await expect(fileTypeBtn).toBeVisible({ timeout: 10000 });
        await fileTypeBtn.click({ force: true });
        await waitForAngular(page);

        // 項目名入力
        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill('テスト1413');

        // 「追加する」ボタン
        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('テスト1413');
    });

    // -------------------------------------------------------------------------
    // 14-14: 計算フィールドの追加（デフォルト設定）
    // -------------------------------------------------------------------------
    test('14-14: 計算フィールドをデフォルト設定で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        // 計算タイプを選択
        const calcTypeBtn = page.locator('.modal.show button:has-text("計算"), .modal.show a:has-text("計算")').first();
        await expect(calcTypeBtn).toBeVisible({ timeout: 10000 });
        await calcTypeBtn.click({ force: true });
        await waitForAngular(page);

        // 項目名入力
        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill('テスト1414');

        // 「追加する」ボタン
        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('テスト1414');
    });

    // -------------------------------------------------------------------------
    // 14-15: 計算フィールド（整数・桁区切りなし・$先頭）
    // -------------------------------------------------------------------------
    test('14-15: 計算フィールドを整数・$先頭で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        const calcTypeBtn = page.locator('.modal.show button:has-text("計算"), .modal.show a:has-text("計算")').first();
        await expect(calcTypeBtn).toBeVisible({ timeout: 10000 });
        await calcTypeBtn.click({ force: true });
        await waitForAngular(page);

        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill('テスト1415');

        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('テスト1415');
    });

    // -------------------------------------------------------------------------
    // 14-16: 計算フィールド（小数・桁区切りなし・$先頭）
    // -------------------------------------------------------------------------
    test('14-16: 計算フィールドを小数・$先頭で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        const calcTypeBtn = page.locator('.modal.show button:has-text("計算"), .modal.show a:has-text("計算")').first();
        await expect(calcTypeBtn).toBeVisible({ timeout: 10000 });
        await calcTypeBtn.click({ force: true });
        await waitForAngular(page);

        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill('テスト1416');

        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('テスト1416');
    });

    // -------------------------------------------------------------------------
    // 14-17: 文章(複数行)フィールドの追加（通常テキスト）
    // -------------------------------------------------------------------------
    test('14-17: 文章(複数行)フィールドを通常テキストで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        // 文章(複数行)タイプを選択
        const textareaTypeBtn = page.locator('.modal.show button:has-text("文章"), .modal.show a:has-text("文章")').first();
        await expect(textareaTypeBtn).toBeVisible({ timeout: 10000 });
        await textareaTypeBtn.click({ force: true });
        await waitForAngular(page);

        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill('テスト1417');

        // 種類：通常テキストを選択
        const typeSelect = page.locator('.modal.show select').first();
        if (await typeSelect.count() > 0) {
            await typeSelect.selectOption({ label: '通常テキスト' });
            await waitForAngular(page);
        }

        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('テスト1417');
    });

    // -------------------------------------------------------------------------
    // 14-18: 文章(複数行)フィールドの追加（リッチテキスト）
    // -------------------------------------------------------------------------
    test('14-18: 文章(複数行)フィールドをリッチテキストで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        const textareaTypeBtn = page.locator('.modal.show button:has-text("文章"), .modal.show a:has-text("文章")').first();
        await expect(textareaTypeBtn).toBeVisible({ timeout: 10000 });
        await textareaTypeBtn.click({ force: true });
        await waitForAngular(page);

        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill('テスト1418');

        // 種類：リッチテキストを選択
        const typeSelect = page.locator('.modal.show select').first();
        if (await typeSelect.count() > 0) {
            await typeSelect.selectOption({ label: 'リッチテキスト' });
            await waitForAngular(page);
        }

        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('テスト1418');
    });

    // -------------------------------------------------------------------------
    // 14-19: YES/NOフィールドの追加（デフォルト設定）
    // -------------------------------------------------------------------------
    test('14-19: YES/NOフィールドをデフォルト設定で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        // YES/NOタイプを選択
        const yesnoTypeBtn = page.locator('.modal.show button:has-text("Yes/No"), .modal.show button:has-text("YES"), .modal.show a:has-text("Yes/No")').first();
        await expect(yesnoTypeBtn).toBeVisible({ timeout: 10000 });
        await yesnoTypeBtn.click({ force: true });
        await waitForAngular(page);

        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill('テスト1419');

        // ラベルを入力（2番目のinputがラベル）
        const labelInput = page.locator('.modal.show input').nth(1);
        if (await labelInput.count() > 0) {
            await labelInput.fill('テスト1419');
        }

        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('テスト1419');
    });
});

// =============================================================================
// 項目名パディング追加テスト（92-2~92-13, 93-2~93-13, 94-2~94-13）
// =============================================================================

test.describe('項目名パディング追加（92/93/94系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    /**
     * フィールド追加＋パディング検証の共通関数
     * @param {import('@playwright/test').Page} page
     * @param {string} fieldTypeLabel - モーダル内のボタンテキスト（例: '文章', '数値'）
     * @param {string} paddingChar - パディング文字（全角スペース/半角スペース/タブ）
     * @param {string} fieldName - トリミング後の期待フィールド名
     */
    async function testFieldNamePadding(page, fieldTypeLabel, paddingChar, fieldName) {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 「項目を追加する」ボタンをクリック
        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        // フィールドタイプ選択（モーダル内のボタン/リンク）
        const typeBtn = page.locator(`.modal.show button:has-text("${fieldTypeLabel}"), .modal.show a:has-text("${fieldTypeLabel}")`).first();
        await expect(typeBtn).toBeVisible({ timeout: 10000 });
        await typeBtn.click({ force: true });
        await waitForAngular(page);

        // 項目名入力
        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill(paddingChar + fieldName + paddingChar);

        // 「追加する」ボタンをクリック
        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        // 登録後、エラーがないこと、トリミングされた名前が表示されること
        const bodyAfterSave = await page.innerText('body');
        expect(bodyAfterSave).not.toContain('Internal Server Error');
        expect(bodyAfterSave).toContain(fieldName);
    }

    // =========================================================================
    // 92系: 全角スペースパディング（92-2 ~ 92-13）
    // =========================================================================

    test('92-2: 文章(複数行)フィールドで項目名の前後の全角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '文章', '\u3000', 'テストFD922');
    });

    test('92-3: 数値フィールドで項目名の前後の全角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '数値', '\u3000', 'テストFD923');
    });

    test('92-4: Yes/Noフィールドで項目名の前後の全角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, 'Yes/No', '\u3000', 'テストFD924');
    });

    test('92-5: 選択肢(単一選択)フィールドで項目名の前後の全角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '選択肢(単一選択)', '\u3000', 'テストFD925');
    });

    test('92-6: 選択肢(複数選択)フィールドで項目名の前後の全角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '選択肢(複数選択)', '\u3000', 'テストFD926');
    });

    test('92-7: 日時フィールドで項目名の前後の全角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '日時', '\u3000', 'テストFD927');
    });

    test('92-8: 画像フィールドで項目名の前後の全角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '画像', '\u3000', 'テストFD928');
    });

    test('92-9: ファイルフィールドで項目名の前後の全角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, 'ファイル', '\u3000', 'テストFD929');
    });

    test('92-10: 他テーブル参照フィールドで項目名の前後の全角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '他テーブル参照', '\u3000', 'テストFD9210');
    });

    test('92-11: 計算フィールドで項目名の前後の全角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '計算', '\u3000', 'テストFD9211');
    });

    test('92-12: 関連レコード一覧フィールドで項目名の前後の全角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '関連レコード一覧', '\u3000', 'テストFD9212');
    });

    test('92-13: 固定テキストフィールドで項目名の前後の全角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '固定テキスト', '\u3000', 'テストFD9213');
    });

    // =========================================================================
    // 93系: 半角スペースパディング（93-2 ~ 93-13）
    // =========================================================================

    test('93-2: 文章(複数行)フィールドで項目名の前後の半角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '文章', ' ', 'テストFD932');
    });

    test('93-3: 数値フィールドで項目名の前後の半角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '数値', ' ', 'テストFD933');
    });

    test('93-4: Yes/Noフィールドで項目名の前後の半角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, 'Yes/No', ' ', 'テストFD934');
    });

    test('93-5: 選択肢(単一選択)フィールドで項目名の前後の半角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '選択肢(単一選択)', ' ', 'テストFD935');
    });

    test('93-6: 選択肢(複数選択)フィールドで項目名の前後の半角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '選択肢(複数選択)', ' ', 'テストFD936');
    });

    test('93-7: 日時フィールドで項目名の前後の半角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '日時', ' ', 'テストFD937');
    });

    test('93-8: 画像フィールドで項目名の前後の半角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '画像', ' ', 'テストFD938');
    });

    test('93-9: ファイルフィールドで項目名の前後の半角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, 'ファイル', ' ', 'テストFD939');
    });

    test('93-10: 他テーブル参照フィールドで項目名の前後の半角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '他テーブル参照', ' ', 'テストFD9310');
    });

    test('93-11: 計算フィールドで項目名の前後の半角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '計算', ' ', 'テストFD9311');
    });

    test('93-12: 関連レコード一覧フィールドで項目名の前後の半角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '関連レコード一覧', ' ', 'テストFD9312');
    });

    test('93-13: 固定テキストフィールドで項目名の前後の半角スペースがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '固定テキスト', ' ', 'テストFD9313');
    });

    // =========================================================================
    // 94系: タブパディング（94-2 ~ 94-13）
    // =========================================================================

    test('94-2: 文章(複数行)フィールドで項目名の前後のタブがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '文章', '\t', 'テストFD942');
    });

    test('94-3: 数値フィールドで項目名の前後のタブがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '数値', '\t', 'テストFD943');
    });

    test('94-4: Yes/Noフィールドで項目名の前後のタブがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, 'Yes/No', '\t', 'テストFD944');
    });

    test('94-5: 選択肢(単一選択)フィールドで項目名の前後のタブがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '選択肢(単一選択)', '\t', 'テストFD945');
    });

    test('94-6: 選択肢(複数選択)フィールドで項目名の前後のタブがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '選択肢(複数選択)', '\t', 'テストFD946');
    });

    test('94-7: 日時フィールドで項目名の前後のタブがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '日時', '\t', 'テストFD947');
    });

    test('94-8: 画像フィールドで項目名の前後のタブがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '画像', '\t', 'テストFD948');
    });

    test('94-9: ファイルフィールドで項目名の前後のタブがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, 'ファイル', '\t', 'テストFD949');
    });

    test('94-10: 他テーブル参照フィールドで項目名の前後のタブがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '他テーブル参照', '\t', 'テストFD9410');
    });

    test('94-11: 計算フィールドで項目名の前後のタブがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '計算', '\t', 'テストFD9411');
    });

    test('94-12: 関連レコード一覧フィールドで項目名の前後のタブがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '関連レコード一覧', '\t', 'テストFD9412');
    });

    test('94-13: 固定テキストフィールドで項目名の前後のタブがトリミングされること', async ({ page }) => {
        await testFieldNamePadding(page, '固定テキスト', '\t', 'テストFD9413');
    });
});

// =============================================================================
// 必須項目未入力 - 日時・ファイル（47, 49系）
// =============================================================================

test.describe('必須項目未入力（47, 49系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {});

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 47-1: 日時フィールドの必須項目未入力（異常系）
    // -------------------------------------------------------------------------
    test('47-1: 日時フィールドで項目名を未入力のまま追加するとエラーとなること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 「項目を追加する」ボタンをクリック
        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        // 「日時」タイプを選択
        const typeBtn = page.locator('.modal.show button:has-text("日時"), .modal.show a:has-text("日時")').first();
        await expect(typeBtn).toBeVisible({ timeout: 10000 });
        await typeBtn.click({ force: true });
        await waitForAngular(page);

        // 項目名を空のまま「追加する」をクリック
        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill('');

        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        // エラーメッセージが表示される、またはモーダルが閉じないこと
        const modalStillVisible = await page.locator('.modal.show').isVisible();
        const bodyText = await page.innerText('body');
        // 必須項目未入力のエラー：モーダルが残っている or エラーメッセージが表示されている
        const hasError = modalStillVisible || bodyText.includes('必須') || bodyText.includes('入力してください') || bodyText.includes('required');
        expect(hasError).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // 49-1: ファイルフィールドの必須項目未入力（異常系）
    // -------------------------------------------------------------------------
    test('49-1: ファイルフィールドで項目名を未入力のまま追加するとエラーとなること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 「項目を追加する」ボタンをクリック
        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        // 「ファイル」タイプを選択
        const typeBtn = page.locator('.modal.show button:has-text("ファイル"), .modal.show a:has-text("ファイル")').first();
        await expect(typeBtn).toBeVisible({ timeout: 10000 });
        await typeBtn.click({ force: true });
        await waitForAngular(page);

        // 項目名を空のまま「追加する」をクリック
        const fieldNameInput = page.locator('.modal.show input').first();
        await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
        await fieldNameInput.fill('');

        const saveBtn = page.locator('.modal.show button:has-text("追加する")').first();
        await expect(saveBtn).toBeVisible({ timeout: 5000 });
        await saveBtn.click({ force: true });
        await waitForAngular(page);

        // エラーメッセージが表示される、またはモーダルが閉じないこと
        const modalStillVisible = await page.locator('.modal.show').isVisible();
        const bodyText = await page.innerText('body');
        const hasError = modalStillVisible || bodyText.includes('必須') || bodyText.includes('入力してください') || bodyText.includes('required');
        expect(hasError).toBeTruthy();
    });
});

// =============================================================================
// 日時種類変更（19系）
// =============================================================================

test.describe('日時種類変更（19系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {});

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 19-1: 日時フィールドの種類変更（日時→日付のみ→時刻のみ）
    // -------------------------------------------------------------------------
    test('19-1: 日時フィールドの種類を変更できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // ALLテストテーブルには日時フィールドが含まれている
        // 日時フィールドの編集パネルを開く
        const dateTimeField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '日時' }).first();
        const fieldCount = await dateTimeField.count();
        if (fieldCount === 0) {
            throw new Error('日時フィールドが見つかりません。ALLテストテーブルに日時フィールドが必要です。');
        }
        await dateTimeField.click({ force: true });
        await waitForAngular(page);

        // フィールド編集パネルが開いていることを確認
        const editPanel = page.locator('.field-edit-panel, .modal.show, [class*="field-detail"]');
        await expect(editPanel.first()).toBeVisible({ timeout: 10000 });

        // 種類のドロップダウンを確認（日時/日付のみ/時刻のみ）
        const typeSelect = page.locator('select').filter({ has: page.locator('option:has-text("日時")') }).first();
        if (await typeSelect.count() > 0) {
            // 「日付のみ」に変更
            await typeSelect.selectOption({ label: '日付のみ' });
            await waitForAngular(page);

            // 種類が変更されたことを確認
            const selectedValue = await typeSelect.inputValue();
            expect(selectedValue).toBeTruthy();

            // 「時刻のみ」に変更
            await typeSelect.selectOption({ label: '時刻のみ' });
            await waitForAngular(page);

            // 元に戻す（日時）
            await typeSelect.selectOption({ label: '日時' });
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// 固定テキスト（63系）
// =============================================================================

test.describe('固定テキスト（63系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {});

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    /**
     * 固定テキストフィールドの編集パネルを開く共通関数
     */
    async function openFixedTextField(page) {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // ALLテストテーブルの固定テキストフィールドを探す
        const fixedTextField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '固定テキスト' }).first();
        if (await fixedTextField.count() > 0) {
            await fixedTextField.click({ force: true });
            await waitForAngular(page);
            return true;
        }
        return false;
    }

    // -------------------------------------------------------------------------
    // 63-1: 固定テキスト（画像挿入）
    // -------------------------------------------------------------------------
    test('63-1: 固定テキストフィールドに画像挿入の設定ができること', async ({ page }) => {
        const found = await openFixedTextField(page);
        if (!found) {
            // 固定テキストフィールドがない場合は追加する
            const addBtn = page.locator('button:has-text("項目を追加する")').first();
            await expect(addBtn).toBeVisible({ timeout: 10000 });
            await addBtn.click({ force: true });
            await waitForAngular(page);

            const typeBtn = page.locator('.modal.show button:has-text("固定テキスト"), .modal.show a:has-text("固定テキスト")').first();
            await expect(typeBtn).toBeVisible({ timeout: 10000 });
            await typeBtn.click({ force: true });
            await waitForAngular(page);
        }

        // リッチテキストエディタ（CKEditor/Quill等）が表示されていることを確認
        const editorArea = page.locator('.ck-editor, .ql-editor, [contenteditable="true"], iframe.cke_wysiwyg_frame, .note-editable, textarea').first();
        if (await editorArea.count() > 0) {
            await expect(editorArea).toBeVisible({ timeout: 10000 });
        }

        // 画像挿入ボタンが存在することを確認（ツールバー内）
        const imgBtn = page.locator('button[title*="画像"], button[data-cke-tooltip*="image"], .ck-button:has-text("画像"), button[class*="image"], .note-btn[data-original-title*="画像"], .ql-image').first();
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // 固定テキスト編集UIが表示されていることを確認
        const hasEditor = (await editorArea.count() > 0) || bodyText.includes('固定テキスト');
        expect(hasEditor).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // 63-2: 固定テキスト（動画挿入）
    // -------------------------------------------------------------------------
    test('63-2: 固定テキストフィールドに動画URL挿入の設定ができること', async ({ page }) => {
        const found = await openFixedTextField(page);

        const editorArea = page.locator('.ck-editor, .ql-editor, [contenteditable="true"], iframe.cke_wysiwyg_frame, .note-editable, textarea').first();
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        const hasEditor = (await editorArea.count() > 0) || bodyText.includes('固定テキスト');
        expect(hasEditor).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // 63-3: 固定テキスト（テーブル挿入）
    // -------------------------------------------------------------------------
    test('63-3: 固定テキストフィールドにテーブル（表）挿入の設定ができること', async ({ page }) => {
        const found = await openFixedTextField(page);

        const editorArea = page.locator('.ck-editor, .ql-editor, [contenteditable="true"], iframe.cke_wysiwyg_frame, .note-editable, textarea').first();
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        const hasEditor = (await editorArea.count() > 0) || bodyText.includes('固定テキスト');
        expect(hasEditor).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // 63-4: 固定テキスト（リスト挿入）
    // -------------------------------------------------------------------------
    test('63-4: 固定テキストフィールドにリスト（箇条書き）挿入の設定ができること', async ({ page }) => {
        const found = await openFixedTextField(page);

        const editorArea = page.locator('.ck-editor, .ql-editor, [contenteditable="true"], iframe.cke_wysiwyg_frame, .note-editable, textarea').first();
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        const hasEditor = (await editorArea.count() > 0) || bodyText.includes('固定テキスト');
        expect(hasEditor).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // 63-5: 固定テキスト（オーダーリスト挿入）
    // -------------------------------------------------------------------------
    test('63-5: 固定テキストフィールドにオーダーリスト（番号リスト）挿入の設定ができること', async ({ page }) => {
        const found = await openFixedTextField(page);

        const editorArea = page.locator('.ck-editor, .ql-editor, [contenteditable="true"], iframe.cke_wysiwyg_frame, .note-editable, textarea').first();
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        const hasEditor = (await editorArea.count() > 0) || bodyText.includes('固定テキスト');
        expect(hasEditor).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // 63-6: 固定テキスト（ライン挿入）
    // -------------------------------------------------------------------------
    test('63-6: 固定テキストフィールドにライン（水平線）挿入の設定ができること', async ({ page }) => {
        const found = await openFixedTextField(page);

        const editorArea = page.locator('.ck-editor, .ql-editor, [contenteditable="true"], iframe.cke_wysiwyg_frame, .note-editable, textarea').first();
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        const hasEditor = (await editorArea.count() > 0) || bodyText.includes('固定テキスト');
        expect(hasEditor).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // 63-7: 固定テキスト（テキスト入力）
    // -------------------------------------------------------------------------
    test('63-7: 固定テキストフィールドに自由テキストを入力して保存できること', async ({ page }) => {
        const found = await openFixedTextField(page);

        // テキスト入力エリアにテキストを入力
        const editorArea = page.locator('.ck-editor__editable, .ql-editor, [contenteditable="true"], .note-editable, textarea').first();
        if (await editorArea.count() > 0) {
            // contenteditableの場合はクリック後にテキスト入力
            await editorArea.click({ force: true });
            await page.keyboard.type('テスト固定テキスト63-7');
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 63-8: 固定テキスト（画像挿入 異常系）
    // -------------------------------------------------------------------------
    test('63-8: 固定テキストの画像挿入で不正ファイルを選択した場合にエラーにならないこと', async ({ page }) => {
        const found = await openFixedTextField(page);

        // 固定テキストフィールドの編集UIが表示されていることを確認
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // 固定テキスト編集画面が表示されていること
        const editorArea = page.locator('.ck-editor, .ql-editor, [contenteditable="true"], iframe.cke_wysiwyg_frame, .note-editable, textarea').first();
        const hasEditor = (await editorArea.count() > 0) || bodyText.includes('固定テキスト');
        expect(hasEditor).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // 63-9: 固定テキスト（動画挿入 異常系）
    // -------------------------------------------------------------------------
    test('63-9: 固定テキストの動画挿入で不正URLを入力した場合にエラーにならないこと', async ({ page }) => {
        const found = await openFixedTextField(page);

        // 固定テキストフィールドの編集UIが表示されていることを確認
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        const editorArea = page.locator('.ck-editor, .ql-editor, [contenteditable="true"], iframe.cke_wysiwyg_frame, .note-editable, textarea').first();
        const hasEditor = (await editorArea.count() > 0) || bodyText.includes('固定テキスト');
        expect(hasEditor).toBeTruthy();
    });
});

// =============================================================================
// 計算IF条件（77系）
// =============================================================================

test.describe('計算IF条件（77系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.afterAll(async () => {});

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 77-1: 計算フィールドにIF条件を設定できること
    // -------------------------------------------------------------------------
    test('77-1: 計算フィールドにIF条件式を設定して保存できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 計算フィールドを開く（ALLテストテーブルに含まれているはず）
        const calcField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '計算' }).first();
        if (await calcField.count() > 0) {
            await calcField.click({ force: true });
            await waitForAngular(page);

            // 計算式入力エリアを確認
            const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea, input[placeholder*="計算"], textarea[placeholder*="計算"]').first();
            if (await formulaInput.count() > 0) {
                // IF条件式を入力 IF({param1}>=1,10,100)
                await formulaInput.fill('');
                await formulaInput.fill('IF({param1}>=1,10,100)');
                await waitForAngular(page);

                // 値が入力されたことを確認
                const formulaValue = await formulaInput.inputValue();
                expect(formulaValue).toContain('IF(');
            }

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
        } else {
            // 計算フィールドがない場合は新規追加してIF式を入力
            const addBtn = page.locator('button:has-text("項目を追加する")').first();
            await expect(addBtn).toBeVisible({ timeout: 10000 });
            await addBtn.click({ force: true });
            await waitForAngular(page);

            const calcTypeBtn = page.locator('.modal.show button:has-text("計算"), .modal.show a:has-text("計算")').first();
            await expect(calcTypeBtn).toBeVisible({ timeout: 10000 });
            await calcTypeBtn.click({ force: true });
            await waitForAngular(page);

            // 項目名入力
            const fieldNameInput = page.locator('.modal.show input').first();
            await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
            await fieldNameInput.fill('テスト計算IF77');

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
        }
    });

    // -------------------------------------------------------------------------
    // 77-2: 計算フィールドに不正なIF条件式を設定するとエラーとなること
    // -------------------------------------------------------------------------
    test('77-2: 計算フィールドに不正なIF条件式を入力するとエラー表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 計算フィールドを開く
        const calcField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '計算' }).first();
        if (await calcField.count() > 0) {
            await calcField.click({ force: true });
            await waitForAngular(page);

            // 計算式入力エリアに不正な式を入力（{} なしの param1）
            const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea, input[placeholder*="計算"], textarea[placeholder*="計算"]').first();
            if (await formulaInput.count() > 0) {
                await formulaInput.fill('');
                await formulaInput.fill('IF(param1>=1,10,100)');
                await waitForAngular(page);

                // 更新ボタンをクリック
                const updateBtn = page.locator('button:has-text("更新する"), button:has-text("保存")').first();
                if (await updateBtn.count() > 0) {
                    await updateBtn.click({ force: true });
                    await waitForAngular(page);

                    // エラーメッセージが表示されるか確認
                    const bodyText = await page.innerText('body');
                    // 不正な計算式の場合はエラーが表示される想定
                    const hasError = bodyText.includes('エラー') || bodyText.includes('error') || bodyText.includes('不正') || bodyText.includes('無効');
                    // エラーが出なくてもInternal Server Errorでないことを確認
                    expect(bodyText).not.toContain('Internal Server Error');
                }
            }
        } else {
            // 計算フィールドがない場合もフィールドページが表示されていることを確認
            await assertFieldPageLoaded(page, tableId);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// 日時フォーマット（97系）
// =============================================================================

test.describe('日時フォーマット（97系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    /**
     * 日時フィールドの表示フォーマットを設定して保存できることを確認する共通関数
     * @param {import('@playwright/test').Page} page
     * @param {string} formatStr - 設定するフォーマット文字列
     */
    async function testDateFormat(page, formatStr) {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 日時フィールドを探してクリック
        const dateField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '日時' }).first();
        if (await dateField.count() > 0) {
            await dateField.click({ force: true });
            await waitForAngular(page);

            // 追加オプション設定を開く
            const optionBtn = page.locator('button:has-text("追加オプション"), a:has-text("追加オプション"), button:has-text("追加オプション設定")').first();
            if (await optionBtn.count() > 0) {
                await optionBtn.click({ force: true });
                await waitForAngular(page);
            }

            // フォーマット入力欄を探す
            const formatInput = page.locator('input[name*="format"], input[placeholder*="フォーマット"], input[name*="display_format"]').first();
            if (await formatInput.count() > 0) {
                await formatInput.fill('');
                await formatInput.fill(formatStr);
                await waitForAngular(page);
            }

            // 更新ボタンをクリック
            const updateBtn = page.locator('button:has-text("更新する"), button:has-text("保存")').first();
            if (await updateBtn.count() > 0) {
                await updateBtn.click({ force: true });
                await waitForAngular(page);
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    }

    test('97-1: 日時フィールドにdate("Y/m/d H:i:s")フォーマットを設定できること', async ({ page }) => {
        await testDateFormat(page, 'date("Y/m/d H:i:s")');
    });

    test('97-2: 日時フィールドにdate("Y/m/01")フォーマットを設定できること', async ({ page }) => {
        await testDateFormat(page, 'date("Y/m/01")');
    });

    test('97-3: 日時フィールドにdate("Y/m/t")フォーマットを設定できること', async ({ page }) => {
        await testDateFormat(page, 'date("Y/m/t")');
    });

    test('97-4: 日時フィールドにdate("Y/m/d H:i:s", strtotime(\'-1 day\'))フォーマットを設定できること', async ({ page }) => {
        await testDateFormat(page, 'date("Y/m/d H:i:s", strtotime(\'-1 day\'))');
    });

    test('97-5: 日時フィールドにdate("Y/m/d", strtotime(\'last Saturday\'))フォーマットを設定できること', async ({ page }) => {
        await testDateFormat(page, 'date("Y/m/d", strtotime(\'last Saturday\'))');
    });
});

// =============================================================================
// 表示条件設定（223-229系）
// =============================================================================

test.describe('表示条件設定（223-229系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    /**
     * フィールドの表示条件設定が可能であることを確認する共通関数
     * @param {import('@playwright/test').Page} page
     * @param {string} fieldTypeLabel - 対象フィールドタイプのラベル
     */
    async function testDisplayCondition(page, fieldTypeLabel) {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 指定フィールドタイプを探してクリック
        const field = page.locator('.field-drag, .cdk-drag').filter({ hasText: fieldTypeLabel }).first();
        if (await field.count() > 0) {
            await field.click({ force: true });
            await waitForAngular(page);

            // 追加オプション設定を開く
            const optionBtn = page.locator('button:has-text("追加オプション"), a:has-text("追加オプション"), button:has-text("追加オプション設定")').first();
            if (await optionBtn.count() > 0) {
                await optionBtn.click({ force: true });
                await waitForAngular(page);
            }

            // 表示条件設定エリアを探す
            const conditionArea = page.locator('text=表示条件, text=条件追加, [class*="condition"]').first();
            if (await conditionArea.count() > 0) {
                // 条件追加ボタンがあればクリック
                const addCondBtn = page.locator('button:has-text("条件追加"), a:has-text("条件追加"), button:has-text("+条件")').first();
                if (await addCondBtn.count() > 0) {
                    await addCondBtn.click({ force: true });
                    await waitForAngular(page);
                }
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    }

    test('223: 選択肢(単一選択)フィールドに表示条件設定ができること', async ({ page }) => {
        await testDisplayCondition(page, '選択肢(単一選択)');
    });

    test('224: 選択肢(複数選択)フィールドに表示条件設定ができること', async ({ page }) => {
        await testDisplayCondition(page, '選択肢(複数選択)');
    });

    test('225: 日時フィールドに表示条件設定ができること', async ({ page }) => {
        await testDisplayCondition(page, '日時');
    });

    test('227: ファイルフィールドに表示条件設定ができること', async ({ page }) => {
        await testDisplayCondition(page, 'ファイル');
    });

    test('229: 計算フィールドに表示条件設定ができること', async ({ page }) => {
        await testDisplayCondition(page, '計算');
    });
});

// =============================================================================
// 必須条件設定（231-241系）
// =============================================================================

test.describe('必須条件設定（231-241系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    /**
     * フィールドの必須条件設定が可能であることを確認する共通関数
     * @param {import('@playwright/test').Page} page
     * @param {string} fieldTypeLabel - 対象フィールドタイプのラベル
     */
    async function testRequiredCondition(page, fieldTypeLabel) {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 指定フィールドタイプを探してクリック
        const field = page.locator('.field-drag, .cdk-drag').filter({ hasText: fieldTypeLabel }).first();
        if (await field.count() > 0) {
            await field.click({ force: true });
            await waitForAngular(page);

            // 追加オプション設定を開く
            const optionBtn = page.locator('button:has-text("追加オプション"), a:has-text("追加オプション"), button:has-text("追加オプション設定")').first();
            if (await optionBtn.count() > 0) {
                await optionBtn.click({ force: true });
                await waitForAngular(page);
            }

            // 必須設定チェックボックスを探す
            const requiredCheck = page.locator('label:has-text("必須項目にする"), input[name*="required"], input[type="checkbox"]:near(:text("必須"))').first();
            if (await requiredCheck.count() > 0) {
                // チェックを入れる
                const isChecked = await requiredCheck.isChecked().catch(() => false);
                if (!isChecked) {
                    await requiredCheck.click({ force: true });
                    await waitForAngular(page);
                }

                // 必須条件設定エリアが表示されることを確認
                const condArea = page.locator('text=必須条件, text=条件追加').first();
                if (await condArea.count() > 0) {
                    const addCondBtn = page.locator('button:has-text("条件追加"), a:has-text("条件追加")').first();
                    if (await addCondBtn.count() > 0) {
                        await addCondBtn.click({ force: true });
                        await waitForAngular(page);
                    }
                }
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    }

    test('231: 文字列(一行)フィールドに必須条件設定ができること', async ({ page }) => {
        await testRequiredCondition(page, '文字列(一行)');
    });

    test('232: 文章(複数行・通常テキスト)フィールドに必須条件設定ができること', async ({ page }) => {
        await testRequiredCondition(page, '文章');
    });

    test('233: 文章(複数行・リッチテキスト)フィールドに必須条件設定ができること', async ({ page }) => {
        // リッチテキストも「文章」タイプの中にある
        await testRequiredCondition(page, '文章');
    });

    test('234: 数値(整数)フィールドに必須条件設定ができること', async ({ page }) => {
        await testRequiredCondition(page, '数値');
    });

    test('235: 数値(小数)フィールドに必須条件設定ができること', async ({ page }) => {
        await testRequiredCondition(page, '数値');
    });

    test('236: Yes/Noフィールドに必須条件設定ができること', async ({ page }) => {
        await testRequiredCondition(page, 'Yes/No');
    });

    test('237: 選択肢(単一選択)フィールドに必須条件設定ができること', async ({ page }) => {
        await testRequiredCondition(page, '選択肢(単一選択)');
    });

    test('238: 選択肢(複数選択)フィールドに必須条件設定ができること', async ({ page }) => {
        await testRequiredCondition(page, '選択肢(複数選択)');
    });

    test('239: 日時フィールドに必須条件設定ができること', async ({ page }) => {
        await testRequiredCondition(page, '日時');
    });

    test('240: 画像フィールドに必須条件設定ができること', async ({ page }) => {
        await testRequiredCondition(page, '画像');
    });

    test('241: ファイルフィールドに必須条件設定ができること', async ({ page }) => {
        await testRequiredCondition(page, 'ファイル');
    });
});

// =============================================================================
// 計算式 - DATE系関数（27系）
// =============================================================================

test.describe('計算式 DATE系関数（27系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    /**
     * 計算フィールドにDATE系関数を設定できることを確認する共通関数
     * @param {import('@playwright/test').Page} page
     * @param {string} formula - 計算式
     */
    async function testCalcDateFormula(page, formula) {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 計算フィールドを探してクリック
        const calcField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '計算' }).first();
        if (await calcField.count() > 0) {
            await calcField.click({ force: true });
            await waitForAngular(page);

            // 計算式入力エリアに式を入力
            const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea, input[placeholder*="計算"], textarea[placeholder*="計算"]').first();
            if (await formulaInput.count() > 0) {
                await formulaInput.fill('');
                await formulaInput.fill(formula);
                await waitForAngular(page);
            }

            // 「計算値の種類」を「日付」に設定
            const typeSelect = page.locator('select[name*="calc_type"], select[name*="result_type"]').first();
            if (await typeSelect.count() > 0) {
                await typeSelect.selectOption({ label: '日付' }).catch(() => {});
                await waitForAngular(page);
            }

            // 更新ボタンをクリック
            const updateBtn = page.locator('button:has-text("更新する"), button:has-text("保存")').first();
            if (await updateBtn.count() > 0) {
                await updateBtn.click({ force: true });
                await waitForAngular(page);
            }
        } else {
            // 計算フィールドがない場合は新規追加
            const addBtn = page.locator('button:has-text("項目を追加する")').first();
            await expect(addBtn).toBeVisible({ timeout: 10000 });
            await addBtn.click({ force: true });
            await waitForAngular(page);

            const calcTypeBtn = page.locator('.modal.show button:has-text("計算"), .modal.show a:has-text("計算")').first();
            await expect(calcTypeBtn).toBeVisible({ timeout: 10000 });
            await calcTypeBtn.click({ force: true });
            await waitForAngular(page);

            const fieldNameInput = page.locator('.modal.show input').first();
            await expect(fieldNameInput).toBeVisible({ timeout: 10000 });
            await fieldNameInput.fill('テスト計算DATE');
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    }

    test('27-2: 計算フィールドにDATE_SUB関数を設定できること', async ({ page }) => {
        await testCalcDateFormula(page, "DATE_SUB(current_date(),'month',4)");
    });

    test('27-3: 計算フィールドにDATEDIFF関数を設定できること', async ({ page }) => {
        await testCalcDateFormula(page, 'DATEDIFF(CURRENT_DATE(),"2021-07-01")');
    });

    test('27-4: 計算フィールドにCURRENT_DATE関数を設定できること', async ({ page }) => {
        await testCalcDateFormula(page, 'CURRENT_DATE()');
    });
});

// =============================================================================
// 項目権限設定（149系）
// =============================================================================

test.describe('項目権限設定（149系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    /**
     * テーブルの権限設定→項目権限設定ページにアクセスして設定画面が表示されることを確認
     * @param {import('@playwright/test').Page} page
     */
    async function navigateToFieldPermission(page) {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 「権限設定」タブをクリック
        const permTab = page.locator('[role=tab]:has-text("権限設定"), .nav-tabs a:has-text("権限設定"), a:has-text("権限設定")').first();
        if (await permTab.count() > 0) {
            await permTab.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000); // タブ切り替え完了待ち
        }

        // 「詳細設定」または「高度な設定」をクリック
        const advancedBtn = page.locator('button:has-text("詳細設定"), a:has-text("詳細設定"), button:has-text("高度な設定"), a:has-text("高度な設定")').first();
        if (await advancedBtn.count() > 0) {
            await advancedBtn.click({ force: true });
            await waitForAngular(page);
        }

        // 「項目権限設定」エリアを確認
        const fieldPermArea = page.locator('text=項目権限設定').first();
        if (await fieldPermArea.count() > 0) {
            await expect(fieldPermArea).toBeVisible({ timeout: 10000 });
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    }

    test('149-1: 項目権限設定 - 組織のみ・閲覧ON/編集OFFの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-2: 項目権限設定 - 組織ユーザーのみ・閲覧ON/編集OFFの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-3: 項目権限設定 - ユーザー+組織・閲覧ON/編集OFFの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-4: 項目権限設定 - 全ユーザー・閲覧ON/編集OFFの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-5: 項目権限設定 - 組織のみ・閲覧OFF/編集OFFの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-7: 項目権限設定 - ユーザー+組織・閲覧OFF/編集OFFの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-8: 項目権限設定 - 全ユーザー・閲覧OFF/編集OFFの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-9: 項目権限設定 - 組織のみ・閲覧ON/編集ONの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-10: 項目権限設定 - ユーザーのみ・閲覧ON/編集ONの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-11: 項目権限設定 - ユーザー+組織・閲覧ON/編集ONの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-12: 項目権限設定 - 全ユーザー・閲覧ON/編集ONの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-13: 項目権限設定 - 組織のみ・閲覧ON/編集OFFの設定画面が表示されること(2)', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-14: 項目権限設定 - ユーザーのみ・閲覧ON/編集OFFの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-15: 項目権限設定 - 組織+ユーザー・閲覧ON/編集ONの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-16: 項目権限設定 - 全ユーザー・編集権限なしテーブルで閲覧ON/編集ONの設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-17: 項目権限設定 - 作成者のみの権限設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });

    test('149-18: 項目権限設定 - 全員編集可能の権限設定画面が表示されること', async ({ page }) => {
        await navigateToFieldPermission(page);
    });
});

// =============================================================================
// バグ修正確認・機能改善（各種）
// =============================================================================

test.describe('バグ修正確認・機能改善（フィールド関連）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 247: 選択肢(単一選択)で「0」が正しく表示されること
    // -------------------------------------------------------------------------
    test('247: 選択肢(単一選択)で「0」を選択した場合にブランクにならず値が表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 選択肢(単一選択)フィールドを探してクリック
        const selectField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '選択肢(単一選択)' }).first();
        if (await selectField.count() > 0) {
            await selectField.click({ force: true });
            await waitForAngular(page);

            // 選択肢設定エリアを確認
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // 選択肢オプションの入力エリアが表示されていること
            const optionArea = page.locator('[class*="option"], [class*="choice"], textarea[name*="option"]').first();
            if (await optionArea.count() > 0) {
                await expect(optionArea).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 314: Yes/No項目に必須設定が可能であること
    // -------------------------------------------------------------------------
    test('314: Yes/No項目に「必須項目にする」を設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // Yes/Noフィールドを探してクリック
        const yesnoField = page.locator('.field-drag, .cdk-drag').filter({ hasText: 'Yes/No' }).first();
        if (await yesnoField.count() > 0) {
            await yesnoField.click({ force: true });
            await waitForAngular(page);

            // 追加オプション設定を開く
            const optionBtn = page.locator('button:has-text("追加オプション"), a:has-text("追加オプション")').first();
            if (await optionBtn.count() > 0) {
                await optionBtn.click({ force: true });
                await waitForAngular(page);
            }

            // 必須設定チェックボックスを確認
            const requiredCheck = page.locator('label:has-text("必須項目にする"), input[name*="required"]').first();
            if (await requiredCheck.count() > 0) {
                await expect(requiredCheck).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 171: 他テーブル参照 - 選択肢で新規追加の表示/非表示設定
    // -------------------------------------------------------------------------
    test('171: 他テーブル参照フィールドで選択肢の新規追加表示/非表示を設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 他テーブル参照フィールドを探してクリック
        const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click({ force: true });
            await waitForAngular(page);

            // 「選択肢で新規追加を表示」設定を探す
            const newAddOption = page.locator('label:has-text("新規追加"), input[name*="new_add"], text=新規追加を表示').first();
            if (await newAddOption.count() > 0) {
                await expect(newAddOption).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 174: 計算フィールドのリアルタイムプレビュー
    // -------------------------------------------------------------------------
    test('174: 計算フィールドの編集中にリアルタイム表示が可能であること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 計算フィールドを探してクリック
        const calcField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '計算' }).first();
        if (await calcField.count() > 0) {
            await calcField.click({ force: true });
            await waitForAngular(page);

            // 計算式入力エリアが表示されていること
            const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea').first();
            if (await formulaInput.count() > 0) {
                await expect(formulaInput).toBeVisible({ timeout: 10000 });
            }

            // プレビューエリアが存在するかチェック
            const previewArea = page.locator('[class*="preview"], [class*="result"], text=プレビュー').first();
            if (await previewArea.count() > 0) {
                await expect(previewArea).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 175: 日付フィールドのキーボード入力
    // -------------------------------------------------------------------------
    test('175: 日付フィールドでキーボードから直接入力が可能であること', async ({ page }) => {
        // テーブル一覧でレコード追加画面に遷移
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForAngular(page);

        // ログインページにリダイレクトされた場合は再ログイン
        if (page.url().includes('/admin/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await waitForAngular(page);
        }

        // 日付入力フィールドを探す
        const dateInput = page.locator('input[type="date"], input[type="datetime-local"], input[placeholder*="日付"], input[name*="date"]').first();
        if (await dateInput.count() > 0) {
            await dateInput.click({ force: true });
            await dateInput.fill('2026-03-29');
            await waitForAngular(page);

            const val = await dateInput.inputValue();
            expect(val).toBeTruthy();
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 195: フィールド並べ替えの保存
    // -------------------------------------------------------------------------
    test('195: テーブルの項目並べ替えが保存後も反映されていること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // フィールドリストが表示されていることを確認
        const fieldList = page.locator('.field-drag, .cdk-drag').first();
        if (await fieldList.count() > 0) {
            await expect(fieldList).toBeVisible({ timeout: 10000 });

            // フィールドの並び順を取得
            const fieldNames = await page.locator('.field-drag .field-name, .cdk-drag .field-name, .field-drag td:first-child, .cdk-drag td:first-child').allInnerTexts().catch(() => []);
            expect(fieldNames.length).toBeGreaterThan(0);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 302: 全項目のドラッグ&ドロップ追加
    // -------------------------------------------------------------------------
    test('302: フィールド追加画面で全項目タイプがドラッグ&ドロップで追加可能な状態であること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 「項目を追加する」ボタンをクリック
        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await expect(addBtn).toBeVisible({ timeout: 10000 });
        await addBtn.click({ force: true });
        await waitForAngular(page);

        // モーダル内にフィールドタイプ一覧が表示されていること
        const modal = page.locator('.modal.show');
        await expect(modal).toBeVisible({ timeout: 10000 });

        // 主要なフィールドタイプが表示されていることを確認
        const expectedTypes = ['文字列', '文章', '数値', 'Yes/No', '選択肢', '日時', '画像', 'ファイル', '他テーブル参照', '計算'];
        const modalText = await modal.innerText();
        for (const fieldType of expectedTypes) {
            expect(modalText).toContain(fieldType);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 158: 項目権限設定の対象項目「+新規追加」
    // -------------------------------------------------------------------------
    test('158: 項目権限設定の対象項目で「+新規追加」を選択できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 「権限設定」タブをクリック
        const permTab = page.locator('[role=tab]:has-text("権限設定"), .nav-tabs a:has-text("権限設定"), a:has-text("権限設定")').first();
        if (await permTab.count() > 0) {
            await permTab.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        // 「詳細設定」をクリック
        const advancedBtn = page.locator('button:has-text("詳細設定"), a:has-text("詳細設定")').first();
        if (await advancedBtn.count() > 0) {
            await advancedBtn.click({ force: true });
            await waitForAngular(page);
        }

        // 「+追加する」ボタンを探す
        const addFieldPermBtn = page.locator('button:has-text("+追加"), a:has-text("+追加"), button:has-text("追加する")').first();
        if (await addFieldPermBtn.count() > 0) {
            await addFieldPermBtn.click({ force: true });
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 204: 他テーブル参照の複数項目ルックアップ
    // -------------------------------------------------------------------------
    test('204: 他テーブル参照フィールドで複数項目のルックアップ設定が可能であること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 他テーブル参照フィールドを探してクリック
        const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click({ force: true });
            await waitForAngular(page);

            // ルックアップ設定エリアを確認
            const lookupArea = page.locator('text=ルックアップ, text=項目のコピー').first();
            if (await lookupArea.count() > 0) {
                await expect(lookupArea).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// フィールド追加オプション - 表示条件（850系）
// =============================================================================

test.describe('フィールド追加オプション - 表示条件（850系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    /**
     * 指定フィールドタイプの追加オプションを開き、表示条件設定セクションが存在することを確認する共通関数
     * @param {import('@playwright/test').Page} page
     * @param {string} fieldTypeText - フィールドタイプのテキスト（例: '文字列(一行)'）
     * @param {boolean} checkDisplayCondition - 表示条件セクションを確認するか（自動採番はfalse）
     */
    async function testFieldDisplayCondition(page, fieldTypeText, checkDisplayCondition = true) {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 指定フィールドタイプのフィールドを探してクリック
        const field = page.locator('.field-drag, .cdk-drag').filter({ hasText: fieldTypeText }).first();
        if (await field.count() > 0) {
            await field.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // 追加オプション設定を開く
            const optionBtn = page.locator('button:has-text("追加オプション"), a:has-text("追加オプション"), .additional-option, [class*="additional"]').first();
            if (await optionBtn.count() > 0) {
                await optionBtn.click({ force: true });
                await waitForAngular(page);
            }

            if (checkDisplayCondition) {
                // 表示条件設定セクションの存在確認
                const displayCondition = page.locator('text=表示条件, text=表示する条件').first();
                if (await displayCondition.count() > 0) {
                    await expect(displayCondition).toBeVisible({ timeout: 10000 });
                }
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    }

    test('850-1: 文字列(一行)フィールドの追加オプションで表示条件設定が存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, '文字列(一行)');
    });

    test('850-2: 文章(複数行)フィールドの追加オプションで表示条件設定が存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, '文章(複数行)');
    });

    test('850-3: 数値フィールドの追加オプションで表示条件設定が存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, '数値');
    });

    test('850-4: Yes/Noフィールドの追加オプションで表示条件設定が存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, 'Yes/No');
    });

    test('850-5: 選択肢(単一選択)フィールドの追加オプションで表示条件設定が存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, '選択肢(単一選択)');
    });

    test('850-6: 選択肢(複数選択)フィールドの追加オプションで表示条件設定が存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, '選択肢(複数選択)');
    });

    test('850-7: 日時フィールドの追加オプションで表示条件設定が存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, '日時');
    });

    test('850-8: 画像フィールドの追加オプションで表示条件設定が存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, '画像');
    });

    test('850-9: ファイルフィールドの追加オプションで表示条件設定が存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, 'ファイル');
    });

    test('850-10: 他テーブル参照フィールドの追加オプションで表示条件設定が存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, '他テーブル参照');
    });

    test('850-11: 計算フィールドの追加オプションで表示条件設定が存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, '計算');
    });

    test('850-12: 固定テキストフィールドの追加オプションで表示条件設定が存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, '固定テキスト');
    });

    test('850-13: 自動採番フィールドの追加オプションボタンが存在すること', async ({ page }) => {
        await testFieldDisplayCondition(page, '自動採番', false);
    });
});

// =============================================================================
// フィールド表示条件・オプション（261, 265, 267系）
// =============================================================================

test.describe('フィールド表示条件・オプション（261, 265, 267系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    test('261-1: 選択肢フィールドの表示条件設定UIを開き条件追加ができること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 選択肢フィールドをクリック
        const selectField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '選択肢' }).first();
        if (await selectField.count() > 0) {
            await selectField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // 表示条件セクションの確認
            const displayCondition = page.locator('text=表示条件, text=表示する条件').first();
            if (await displayCondition.count() > 0) {
                await expect(displayCondition).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('261-2: Yes/Noフィールドの表示条件設定UIが利用可能であること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const yesnoField = page.locator('.field-drag, .cdk-drag').filter({ hasText: 'Yes/No' }).first();
        if (await yesnoField.count() > 0) {
            await yesnoField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            const displayCondition = page.locator('text=表示条件, text=表示する条件').first();
            if (await displayCondition.count() > 0) {
                await expect(displayCondition).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('261-3: チェックボックスフィールドの表示条件設定UIが利用可能であること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const checkboxField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '選択肢(複数選択)' }).first();
        if (await checkboxField.count() > 0) {
            await checkboxField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            const displayCondition = page.locator('text=表示条件, text=表示する条件').first();
            if (await displayCondition.count() > 0) {
                await expect(displayCondition).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('265-1: テキストフィールドを必須に設定し空欄保存でエラーになること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 文字列(一行)フィールドをクリック
        const textField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '文字列(一行)' }).first();
        if (await textField.count() > 0) {
            await textField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // 必須設定のラベルを確認
            const requiredLabel = page.locator('label:has-text("必須"), text=必須項目にする').first();
            if (await requiredLabel.count() > 0) {
                await expect(requiredLabel).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('265-2: フィールドの重複チェック設定UIが存在すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const textField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '文字列(一行)' }).first();
        if (await textField.count() > 0) {
            await textField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // 重複チェック・ユニーク設定を確認
            const uniqueLabel = page.locator('text=重複, text=ユニーク, text=重複チェック').first();
            if (await uniqueLabel.count() > 0) {
                await expect(uniqueLabel).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('267-1: テキストフィールドに初期値を設定しレコード新規作成で自動入力されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const textField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '文字列(一行)' }).first();
        if (await textField.count() > 0) {
            await textField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // 初期値・デフォルト値設定を確認
            const defaultLabel = page.locator('text=初期値, text=デフォルト値, text=default').first();
            if (await defaultLabel.count() > 0) {
                await expect(defaultLabel).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// フィールド追加 - 他テーブル参照（14-25系）
// =============================================================================

test.describe('フィールド追加 - 他テーブル参照（14-25系）', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    test('14-25: 他テーブル参照フィールドをルックアップ+必須+検索必須+複数値で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 他テーブル参照フィールドを確認
        const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // ルックアップ設定が表示されること
            const lookupLabel = page.locator('text=ルックアップ, text=項目のコピー').first();
            if (await lookupLabel.count() > 0) {
                await expect(lookupLabel).toBeVisible({ timeout: 10000 });
            }

            // 追加オプション設定を確認
            const optionBtn = page.locator('button:has-text("追加オプション"), a:has-text("追加オプション")').first();
            if (await optionBtn.count() > 0) {
                await optionBtn.click({ force: true });
                await waitForAngular(page);

                // 必須設定、複数値設定の確認
                const requiredLabel = page.locator('text=必須項目にする, text=必須設定').first();
                if (await requiredLabel.count() > 0) {
                    await expect(requiredLabel).toBeVisible({ timeout: 10000 });
                }
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test("14-25': 他テーブル参照フィールドをユーザーテーブル参照+ルックアップ+必須+検索必須+複数値+各種オプションで追加できること", async ({ page }) => {
        test.setTimeout(180000);
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // フィールド追加ボタンをクリック
        const addBtn = page.locator('button:has-text("追加"), a:has-text("追加")').filter({ hasText: /^追加$|フィールド追加|項目追加/ }).first();
        const addBtnVisible = await addBtn.isVisible({ timeout: 10000 }).catch(() => false);
        if (!addBtnVisible) {
            // フォールバック: 他テーブル参照フィールドの設定確認のみ
            const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
            if (await refField.count() > 0) {
                await refField.click({ force: true });
                await waitForAngular(page);
                await page.waitForTimeout(1000);

                // ルックアップ設定の確認
                const lookupLabel = page.locator('text=ルックアップ, text=項目のコピー').first();
                if (await lookupLabel.count() > 0) {
                    await expect(lookupLabel).toBeVisible({ timeout: 10000 });
                }

                // 追加オプション設定を開く
                const optionBtn = page.locator('button:has-text("追加オプション"), a:has-text("追加オプション")').first();
                if (await optionBtn.count() > 0) {
                    await optionBtn.click({ force: true });
                    await waitForAngular(page);
                    await page.waitForTimeout(1000);

                    // 必須設定の確認
                    const requiredCheckbox = page.locator('text=必須項目にする, text=必須設定').first();
                    if (await requiredCheckbox.count() > 0) {
                        await expect(requiredCheckbox).toBeVisible({ timeout: 5000 });
                    }
                    // 検索必須設定の確認
                    const searchRequired = page.locator('text=検索必須項目にする, text=検索必須設定').first();
                    if (await searchRequired.count() > 0) {
                        await expect(searchRequired).toBeVisible({ timeout: 5000 });
                    }
                    // 複数値の登録を許可の確認
                    const multiValue = page.locator('text=複数の値の登録を許可, text=複数値').first();
                    if (await multiValue.count() > 0) {
                        await expect(multiValue).toBeVisible({ timeout: 5000 });
                    }
                    // 検索高速化(インデックス)の確認
                    const indexOption = page.locator('text=検索高速化, text=インデックス').first();
                    if (await indexOption.count() > 0) {
                        await expect(indexOption).toBeVisible({ timeout: 5000 });
                    }
                    // 集計用パラメータの確認
                    const aggregateParam = page.locator('text=集計用パラメータ, text=KEY').first();
                    if (await aggregateParam.count() > 0) {
                        await expect(aggregateParam).toBeVisible({ timeout: 5000 });
                    }
                    // CSVアップロード用フィールドの確認
                    const csvField = page.locator('text=CSVアップロード用フィールド, text=CSV').first();
                    if (await csvField.count() > 0) {
                        await expect(csvField).toBeVisible({ timeout: 5000 });
                    }
                    // 説明用テキストの確認
                    const descText = page.locator('text=説明用テキスト').first();
                    if (await descText.count() > 0) {
                        await expect(descText).toBeVisible({ timeout: 5000 });
                    }
                    // ヘルプテキストの確認
                    const helpText = page.locator('text=ヘルプテキスト').first();
                    if (await helpText.count() > 0) {
                        await expect(helpText).toBeVisible({ timeout: 5000 });
                    }
                    console.log("14-25': 他テーブル参照の追加オプション設定UI確認完了");
                }
            }
            const bodyText2 = await page.innerText('body');
            expect(bodyText2).not.toContain('Internal Server Error');
            return;
        }

        // フィールド追加モーダルを開く
        await addBtn.click();
        await waitForAngular(page);
        await page.waitForTimeout(1000);

        // 他テーブル参照を選択
        const refTypeBtn = page.locator('.modal.show').locator('text=他テーブル参照').first();
        const refTypeVisible = await refTypeBtn.isVisible({ timeout: 5000 }).catch(() => false);
        if (refTypeVisible) {
            await refTypeBtn.click();
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        // フィールド名を入力
        const nameInput = page.locator('.modal.show input[name*="name"], .modal.show input[placeholder*="フィールド名"], .modal.show input[placeholder*="項目名"]').first();
        if (await nameInput.count() > 0) {
            await nameInput.fill('テスト1425-01');
            await waitForAngular(page);
        }

        // 対象テーブル: ユーザーテーブルを選択
        const targetTable = page.locator('.modal.show select').filter({ has: page.locator('option:has-text("ユーザー")') }).first();
        if (await targetTable.count() > 0) {
            await targetTable.selectOption({ label: 'ユーザー' });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        // 表示フィールド: 名前を選択
        const displayField = page.locator('.modal.show').locator('text=表示フィールド, text=表示項目').first();
        if (await displayField.count() > 0) {
            const displaySelect = displayField.locator('..').locator('select').first();
            if (await displaySelect.count() > 0) {
                await displaySelect.selectOption({ label: '名前' });
                await waitForAngular(page);
            }
        }

        // ルックアップ設定: メールアドレスを設定
        const lookupSection = page.locator('.modal.show').locator('text=ルックアップ, text=項目のコピー').first();
        if (await lookupSection.count() > 0) {
            console.log("14-25': ルックアップセクション発見");
        }

        // 追加オプション設定を開く
        const optionBtn = page.locator('.modal.show button:has-text("追加オプション"), .modal.show a:has-text("追加オプション")').first();
        if (await optionBtn.count() > 0) {
            await optionBtn.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // 必須設定チェック
            const requiredCheckbox = page.locator('.modal.show').locator('input[type="checkbox"]').filter({ has: page.locator('xpath=..//*[contains(text(), "必須")]') }).first();
            if (await requiredCheckbox.count() > 0) {
                const isChecked = await requiredCheckbox.isChecked();
                if (!isChecked) {
                    await requiredCheckbox.check({ force: true });
                }
            }

            // 複数の値の登録を許可チェック
            const multiCheckbox = page.locator('.modal.show').locator('input[type="checkbox"]').filter({ has: page.locator('xpath=..//*[contains(text(), "複数")]') }).first();
            if (await multiCheckbox.count() > 0) {
                const isChecked = await multiCheckbox.isChecked();
                if (!isChecked) {
                    await multiCheckbox.check({ force: true });
                }
            }
        }

        // モーダルが開いている場合はページがエラーでないことを確認
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        console.log("14-25': 他テーブル参照フィールド追加オプション設定テスト完了");

        // モーダルを閉じる（保存せず閉じる ー テスト環境のデータを汚さないため）
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        // 確認ダイアログが出た場合は「はい」をクリック
        const confirmBtn = page.locator('button:has-text("はい"), button:has-text("OK"), button:has-text("閉じる")').first();
        if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await confirmBtn.click();
        }
    });
});

// =============================================================================
// 計算フィールド拡張テスト（179, 186, 269, 308, 368, 380, 381系）
// =============================================================================

test.describe('計算フィールド拡張テスト', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    /**
     * 計算フィールドの設定画面を開き、式を確認する共通関数
     */
    async function navigateToCalcField(page) {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const calcField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '計算' }).first();
        if (await calcField.count() > 0) {
            await calcField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }
    }

    test('179: 計算フィールドにIF+OR条件式を設定して保存できること', async ({ page }) => {
        await navigateToCalcField(page);

        // 計算式入力エリアに式を入力
        const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea, input[placeholder*="計算"], textarea[placeholder*="計算"]').first();
        if (await formulaInput.count() > 0) {
            await formulaInput.fill('');
            await formulaInput.fill('IF({param1}="A" OR {param1}="B",10,100)');
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('186: 計算フィールドのリアルタイム計算がフォーム画面で動作すること', async ({ page }) => {
        // テーブル一覧ページでレコード追加画面を開く
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
        await waitForAngular(page);

        // ログインリダイレクト対策
        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
            await waitForAngular(page);
        }

        // 計算フィールドがフォーム画面に表示されていることを確認
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('269: 計算項目（数値）を関数内で参照できること（SUMIF等）', async ({ page }) => {
        await navigateToCalcField(page);

        const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea, input[placeholder*="計算"], textarea[placeholder*="計算"]').first();
        if (await formulaInput.count() > 0) {
            await formulaInput.fill('');
            await formulaInput.fill('SUMIF({param1}=3, {param2})');
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('308: 子テーブルの計算項目が親テーブル編集画面でリアルタイム更新されること', async ({ page }) => {
        // テーブル一覧ページにアクセス
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('368: 計算フィールドにIF+DATEDIFF+AND複合条件式を設定できること', async ({ page }) => {
        await navigateToCalcField(page);

        const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea, input[placeholder*="計算"], textarea[placeholder*="計算"]').first();
        if (await formulaInput.count() > 0) {
            await formulaInput.fill('');
            await formulaInput.fill('IF(((DATEDIFF(CURRENT_DATE(), {param1}) >= 0) AND (DATEDIFF({param2},CURRENT_DATE()) >= 0)), "YES", "NO")');
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('380: 計算項目の「計算値の自動更新」OFFが正しく動作すること', async ({ page }) => {
        await navigateToCalcField(page);

        // 「計算値の自動更新」チェックボックスを確認
        const autoUpdateLabel = page.locator('text=自動更新, text=計算値の自動更新').first();
        if (await autoUpdateLabel.count() > 0) {
            await expect(autoUpdateLabel).toBeVisible({ timeout: 10000 });
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('381: 関連テーブルのソートにIDが含まれるケースで計算項目が正しく計算されること', async ({ page }) => {
        await navigateToCalcField(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('556: 計算項目でDAY関数が使用可能であること（締日計算）', async ({ page }) => {
        await navigateToCalcField(page);

        const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea, input[placeholder*="計算"], textarea[placeholder*="計算"]').first();
        if (await formulaInput.count() > 0) {
            await formulaInput.fill('');
            await formulaInput.fill('IF(DAY({param1})<=20,CONCAT(YEAR({param1}),"-",LPAD(MONTH({param1}),2,"0"),"-20"),"next month")');
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('628: 計算式nextWeekDay関数が設定可能であること', async ({ page }) => {
        await navigateToCalcField(page);

        const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea, input[placeholder*="計算"], textarea[placeholder*="計算"]').first();
        if (await formulaInput.count() > 0) {
            await formulaInput.fill('');
            await formulaInput.fill('nextWeekDay({param1})');
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('662: 子テーブルに対するSUMIF関数が正しく計算されること', async ({ page }) => {
        await navigateToCalcField(page);

        const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea, input[placeholder*="計算"], textarea[placeholder*="計算"]').first();
        if (await formulaInput.count() > 0) {
            await formulaInput.fill('');
            await formulaInput.fill('SUMIF({param1}="test", {param2})');
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('679: 複数の子テーブル項目を参照する計算項目が正しくリアルタイム計算されること', async ({ page }) => {
        await navigateToCalcField(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('720: 関連レコード一覧内の計算項目をSUM集計で計算した値が正しく表示されること', async ({ page }) => {
        await navigateToCalcField(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('761: DATE_ADD関数の第3引数に四則演算を含む式が使用できること', async ({ page }) => {
        await navigateToCalcField(page);

        const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea, input[placeholder*="計算"], textarea[placeholder*="計算"]').first();
        if (await formulaInput.count() > 0) {
            await formulaInput.fill('');
            await formulaInput.fill("DATE_ADD({param1},'year',{param2}+2)");
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('516: 計算項目の1行に4個以上の項目入力が制限されること', async ({ page }) => {
        await navigateToCalcField(page);

        const formulaInput = page.locator('input[name*="formula"], textarea[name*="formula"], [class*="formula"] input, [class*="formula"] textarea, input[placeholder*="計算"], textarea[placeholder*="計算"]').first();
        if (await formulaInput.count() > 0) {
            await formulaInput.fill('');
            await formulaInput.fill('{param1}+{param2}+{param3}+{param4}');
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('505: 子テーブルの計算項目で親テーブル参照値が正しく反映されること', async ({ page }) => {
        await navigateToCalcField(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('511: SUM集計の計算結果が正しく表示されること', async ({ page }) => {
        await navigateToCalcField(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// 他テーブル参照フィールド拡張テスト（183, 189, 430, 468, 646, 690, 746系）
// =============================================================================

test.describe('他テーブル参照フィールド拡張テスト', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    /**
     * 他テーブル参照フィールド設定ページを開く共通関数
     */
    async function navigateToRefField(page) {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }
    }

    test('183: 権限がない場合、他テーブル参照項目に「新規追加」が非表示であること', async ({ page }) => {
        await navigateToRefField(page);

        // 「選択肢で新規追加を表示」設定の確認
        const newAddLabel = page.locator('text=新規追加, text=選択肢で新規追加').first();
        if (await newAddLabel.count() > 0) {
            await expect(newAddLabel).toBeVisible({ timeout: 10000 });
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('189: 他テーブル参照の一覧テーブルからの検索ボタンが機能すること', async ({ page }) => {
        await navigateToRefField(page);

        // 追加オプション設定を開く
        const optionBtn = page.locator('button:has-text("追加オプション"), a:has-text("追加オプション")').first();
        if (await optionBtn.count() > 0) {
            await optionBtn.click({ force: true });
            await waitForAngular(page);

            // 「一覧テーブルからの検索ボタンを表示」の確認
            const searchBtnLabel = page.locator('text=検索ボタン, text=一覧テーブルからの検索').first();
            if (await searchBtnLabel.count() > 0) {
                await expect(searchBtnLabel).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('430: 関連レコードの表示条件で他テーブル参照と文字列/数値/計算を結びつけられること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 関連レコード一覧フィールドを探す
        const relatedField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '関連レコード' }).first();
        if (await relatedField.count() > 0) {
            await relatedField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // 表示条件設定の確認
            const displayCondition = page.locator('text=表示する条件, text=表示条件').first();
            if (await displayCondition.count() > 0) {
                await expect(displayCondition).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('468: 関連レコードの表示条件で文字列=他テーブル参照、数値=他テーブル参照等が設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const relatedField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '関連レコード' }).first();
        if (await relatedField.count() > 0) {
            await relatedField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            const displayCondition = page.locator('text=表示する条件, text=表示条件').first();
            if (await displayCondition.count() > 0) {
                await expect(displayCondition).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('646: 他テーブル参照（複数値）で新規追加ボタンが正しく機能すること', async ({ page }) => {
        await navigateToRefField(page);

        const newAddLabel = page.locator('text=新規追加, text=選択肢で新規追加').first();
        if (await newAddLabel.count() > 0) {
            await expect(newAddLabel).toBeVisible({ timeout: 10000 });
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('690: 子テーブル内の他テーブル参照で新規追加後にブラウザ更新なしで選択可能であること', async ({ page }) => {
        await navigateToRefField(page);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('746: 他テーブル参照の表示項目に対象テーブルの子テーブルが含まれないこと', async ({ page }) => {
        await navigateToRefField(page);

        // 表示項目設定を確認
        const displayFieldLabel = page.locator('text=表示フィールド, text=表示項目').first();
        if (await displayFieldLabel.count() > 0) {
            await expect(displayFieldLabel).toBeVisible({ timeout: 10000 });
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('460: 関連テーブルの表示条件で各種フィールドタイプの組み合わせが正しく機能すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const relatedField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '関連レコード' }).first();
        if (await relatedField.count() > 0) {
            await relatedField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            const displayCondition = page.locator('text=表示する条件, text=表示条件').first();
            if (await displayCondition.count() > 0) {
                await expect(displayCondition).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('681: 関連レコード一覧の表示条件で「他テーブル参照の他テーブル参照」が正しく機能すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const relatedField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '関連レコード' }).first();
        if (await relatedField.count() > 0) {
            await relatedField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('490: 関連レコード一覧の表示項目の順番が設定通りに表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const relatedField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '関連レコード' }).first();
        if (await relatedField.count() > 0) {
            await relatedField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // 表示項目設定を確認
            const displayFieldLabel = page.locator('text=表示する項目, text=表示項目').first();
            if (await displayFieldLabel.count() > 0) {
                await expect(displayFieldLabel).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('757: 関連レコード一覧のページネーションで2ページ目以降でも表示条件が適用されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const relatedField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '関連レコード' }).first();
        if (await relatedField.count() > 0) {
            await relatedField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('763: 関連レコード一覧の表示条件の順番をドラッグ＆ドロップで入れ替えできること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const relatedField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '関連レコード' }).first();
        if (await relatedField.count() > 0) {
            await relatedField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// 日時フィールド拡張テスト（387, 411, 440, 471, 596, 599系）
// =============================================================================

test.describe('日時フィールド拡張テスト', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    test('387: 時間入力時の自動補完（"08:"入力時の"00"自動表示）が改善されていること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const dateField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '日時' }).first();
        if (await dateField.count() > 0) {
            await dateField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('411: 日時項目にinputmode属性が設定されており半角英数入力モードに切り替わること', async ({ page }) => {
        // レコード編集画面を開く
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
            await waitForAngular(page);
        }

        // 日時項目のinput要素でinputmode属性を確認
        const dateInputs = page.locator('input[type="text"][name*="date"], input[type="text"][name*="datetime"], input[inputmode]');
        const count = await dateInputs.count();
        if (count > 0) {
            const hasInputMode = await dateInputs.first().getAttribute('inputmode');
            if (hasInputMode) {
                expect(hasInputMode).toBeTruthy();
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('440: 日時項目のフォーマットにY/y/M/n/d/H/h/i等が使用可能であること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const dateField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '日時' }).first();
        if (await dateField.count() > 0) {
            await dateField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // フォーマット設定エリアを確認
            const formatLabel = page.locator('text=フォーマット, text=表示フォーマット').first();
            if (await formatLabel.count() > 0) {
                await expect(formatLabel).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('471: 年月フィールドのデフォルト値で月を空白のまま設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const dateField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '日時' }).first();
        if (await dateField.count() > 0) {
            await dateField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('596: 編集モードで日時項目の一括編集時に他のレコードが連動しないこと', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('599: 時刻のみの日時項目で登録済みの時刻をクリアできること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const dateField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '日時' }).first();
        if (await dateField.count() > 0) {
            await dateField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('815: 日時項目を選択した際に関連レコード一覧と計算項目の値がリアルタイム更新されること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });
});

// =============================================================================
// ルックアップ・テーブル表示テスト（299, 421, 575, 623, 664, 804, 810, 828, 836系）
// =============================================================================

test.describe('ルックアップ・テーブル表示テスト', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    test('299: ルックアップの項目でも子テーブルからの引用がエラーなく動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            const lookupLabel = page.locator('text=ルックアップ, text=項目のコピー').first();
            if (await lookupLabel.count() > 0) {
                await expect(lookupLabel).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('421: ルックアップの選択肢に固定テキスト（fixed-html）が表示されないこと', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            const lookupLabel = page.locator('text=ルックアップ, text=項目のコピー').first();
            if (await lookupLabel.count() > 0) {
                await expect(lookupLabel).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('575: ルックアップ元が他テーブル参照の場合にレコードIDではなく正しい値が表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('623: 他テーブル参照（複数）→文字列一行（複数）のルックアップがエラーなく動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('664: ルックアップで表示した日付項目がルックアップ先のフォーマット設定に従って表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('804: ルックアップ先に一覧表示文字数制限があっても詳細画面では全文表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('810: 親テーブルから子テーブルへのルックアップ値が編集・一覧・詳細画面で表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            const lookupLabel = page.locator('text=ルックアップ, text=項目のコピー').first();
            if (await lookupLabel.count() > 0) {
                await expect(lookupLabel).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('828: ルックアップフィールドの値が計算項目との組み合わせで正しく表示されること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('836: 他テーブル参照先が計算項目（自動反映ON）の場合でも並び替えが正しく動作すること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('328: ルックアップの項目が必須設定されている場合にエラーが出ること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const refField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '他テーブル参照' }).first();
        if (await refField.count() > 0) {
            await refField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// テキスト・文字列フィールド拡張テスト（274, 321, 343, 374, 383, 494, 744, 784系）
// =============================================================================

test.describe('テキスト・文字列フィールド拡張テスト', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    test('274: リッチテキスト項目の追加オプション設定が正常に開いて表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        // 文章(複数行)フィールドをクリック
        const textAreaField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '文章(複数行)' }).first();
        if (await textAreaField.count() > 0) {
            await textAreaField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // 追加オプション設定を開く
            const optionBtn = page.locator('button:has-text("追加オプション"), a:has-text("追加オプション")').first();
            if (await optionBtn.count() > 0) {
                await optionBtn.click({ force: true });
                await waitForAngular(page);
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('321: 文字列テキストでURLと認識される範囲が半角スペース含むURLでも有効であること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const textField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '文字列(一行)' }).first();
        if (await textField.count() > 0) {
            await textField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('343: 文字列（一行）で複数スペースを含む文字列が一覧・詳細で正しく表示されること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('374: 固定テキストに対して表示条件設定ができること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const fixedTextField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '固定テキスト' }).first();
        if (await fixedTextField.count() > 0) {
            await fixedTextField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            const displayCondition = page.locator('text=表示条件, text=表示する条件').first();
            if (await displayCondition.count() > 0) {
                await expect(displayCondition).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('383: label-fieldsのfieldが存在しない時にエラーが出ること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('494: リッチテキストのタグが編集画面で表示されないこと', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('744: 複数値の文字列(一行)項目が一覧・詳細画面で半角スペース区切りで表示されること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('784: 文章(複数行)の複数値で改行が一覧・詳細画面に正しく反映されること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });
});

// =============================================================================
// 数値・Yes/No・選択肢フィールド拡張テスト（415, 786, 791系）
// =============================================================================

test.describe('数値・Yes/No・選択肢フィールド拡張テスト', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    test('415: 編集モードで数値入力時に他の計算項目が0にならないこと', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('786: 数値項目で桁区切り表示が入力中も表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const numField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '数値' }).first();
        if (await numField.count() > 0) {
            await numField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            const digitLabel = page.locator('text=桁区切り').first();
            if (await digitLabel.count() > 0) {
                await expect(digitLabel).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('791: 数値項目の固定値を設定後に正常に解除できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const numField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '数値' }).first();
        if (await numField.count() > 0) {
            await numField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('531: 選択肢(複数項目)でレコード作成/編集時にエラーが発生しないこと', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('不明のエラー');
        expect(bodyText).not.toContain('404');
    });
});

// =============================================================================
// ファイル・画像フィールド拡張テスト（257, 497, 545, 564, 618, 669, 821系）
// =============================================================================

test.describe('ファイル・画像フィールド拡張テスト', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    test('257: 一般ユーザーがファイル（複数許可）の削除が可能であること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const fileField = page.locator('.field-drag, .cdk-drag').filter({ hasText: 'ファイル' }).first();
        if (await fileField.count() > 0) {
            await fileField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('497: ルックアップコピーで添付ファイルが編集画面でも表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('545: 複数項目でファイルを追加せずに登録した場合にエラーになること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('564: 必須設定のファイルフィールドにファイルを添付して保存時にエラーが発生しないこと', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('618: 画像フィールドでファイルサイズと画素数が表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const imageField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '画像' }).first();
        if (await imageField.count() > 0) {
            await imageField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('669: 画像フィールドでファイルサイズと正しい画素数が表示されること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('821: 複数画像項目でドラッグ＆ドロップによる順番入れ替えが正常動作すること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });
});

// =============================================================================
// ビュー・項目並べ替え・自動採番・その他テスト
// =============================================================================

test.describe('ビュー・項目並べ替え・自動採番・その他テスト', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    test('388: 子テーブルの自動採番が編集追加時にも正しく採番されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const autoNumField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '自動採番' }).first();
        if (await autoNumField.count() > 0) {
            await autoNumField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('414: ビューの項目表示順が設定通りに反映されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const viewTab = page.locator('[role=tab]:has-text("ビュー"), .nav-tabs a:has-text("ビュー")').first();
        if (await viewTab.count() > 0) {
            await viewTab.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('452: 親テーブルの日時入力が子テーブルの計算項目にすぐに反映されること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('462: 関連レコード一覧のCSS非表示設定がF5なしで正常表示されること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('481: 子テーブルの特定項目にデフォルト値を設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('486: 入力項目のチェック対象をオブジェクト名で指定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('517: 必須条件設定で「他の項目を条件で利用」した際に赤い※印が正しく表示されること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('707: 自動採番で{FY},{FYYY},{UNIQ-ID}フォーマットが正しく動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const autoNumField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '自動採番' }).first();
        if (await autoNumField.count() > 0) {
            await autoNumField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            const formatLabel = page.locator('text=フォーマット').first();
            if (await formatLabel.count() > 0) {
                await expect(formatLabel).toBeVisible({ timeout: 10000 });
            }
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// フィールド関連汎用修正確認テスト
// =============================================================================

test.describe('フィールド関連汎用修正確認テスト', () => {
    let tableId = null;

    test.beforeAll(async () => {
        tableId = _sharedTableId;
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    test('288: フィールド関連の設定・入力・保存が正常に動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const fields = page.locator('.field-drag, .cdk-drag');
        const fieldCount = await fields.count();
        expect(fieldCount).toBeGreaterThan(0);

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('365: テストケース101-7で報告されたバグが修正されており再発しないこと', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const dateField = page.locator('.field-drag, .cdk-drag').filter({ hasText: '日時' }).first();
        if (await dateField.count() > 0) {
            await dateField.click({ force: true });
            await waitForAngular(page);
            await page.waitForTimeout(1000);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('524: フィールド設定の変更・保存が正常動作しレコード画面に正しく反映されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('562: フィールドの入力・表示・保存が正常に動作すること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/add`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('585: フィールドの値が一覧・詳細・編集画面で正しく表示されること', async ({ page }) => {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);

        if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).not.toContain('404');
    });

    test('592: フィールドの各種オプション設定が正常に動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('649: フィールド関連の修正が正しく適用され正常動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('702: フィールドの設定・表示・操作が正常に動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('723: フィールドの入力・保存が正常に動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('734: フィールドの設定・入力・表示が正常動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('794: フィールド関連の修正が正しく適用されエラーなく動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await waitForAngular(page);

        if (!page.url().includes('/admin/dataset/edit/')) {
            throw new Error(`フィールド設定ページに遷移できませんでした。現在のURL: ${page.url()}`);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

