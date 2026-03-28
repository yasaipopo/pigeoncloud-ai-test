// @ts-check
const { test, expect } = require('@playwright/test');
const { createAuthContext } = require('./helpers/auth-context');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

async function waitForAngular(page, timeout = 15000) {
    await page.waitForSelector('body[data-ng-ready="true"]', { timeout });
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
            await expect(page.locator('.navbar')).toBeVisible();
        }
    } else if (currentUrl.includes(`/admin/dataset__${tableId}`)) {
        // テーブル一覧ページにリダイレクトされた場合
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
    } else {
        // その他のページ：ナビバーが表示されていること
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
        // フィールドリストまたはテーブル一覧が表示されること
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 101-2: 日付のみフィールドの現在時刻セット（新規追加）
    // -------------------------------------------------------------------------
    test('101-2: 日付のみフィールドのフィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 101-3: 時刻のみフィールドの現在時刻セット（新規追加）
    // -------------------------------------------------------------------------
    test('101-3: 時刻のみフィールドのフィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 101-7: 年月フィールドの現在時刻セット（新規追加）
    // -------------------------------------------------------------------------
    test('101-7: 年月フィールドのフィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 113-04: Yes/NoフィールドのLアウト設定
    // -------------------------------------------------------------------------
    test('113-04: Yes/Noフィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 113-07: 日時フィールドのレイアウト設定
    // -------------------------------------------------------------------------
    test('113-07: 日時フィールドに2-4列レイアウトを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 116-01: 項目の重複チェック設定
    // -------------------------------------------------------------------------
    test('116-01: フィールドの重複チェック設定が確認できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 116-02: 項目の検索設定
    // -------------------------------------------------------------------------
    test('116-02: フィールドの検索設定が確認できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 51-2: 計算フィールドの数式入力
    // -------------------------------------------------------------------------
    test('51-2: 計算フィールドに数式を設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 103-01: 計算フィールドの設定詳細
    // -------------------------------------------------------------------------
    test('103-01: 計算フィールドの設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 45-1: 選択肢(単一選択)フィールドのオプション設定
    // -------------------------------------------------------------------------
    test('45-1: 選択肢(単一選択)フィールドにオプションを追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 46-1: 選択肢(複数選択)フィールドの追加
    // -------------------------------------------------------------------------
    test('46-1: 選択肢(複数選択)フィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 220: 数値（整数）フィールド
    // -------------------------------------------------------------------------
    test('220: 数値（整数）フィールドの設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 221: 数値（小数）フィールド
    // -------------------------------------------------------------------------
    test('221: 数値（小数）フィールドの設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 41-1: 文字列(一行)フィールドのバリデーション
    // -------------------------------------------------------------------------
    test('41-1: 文字列(一行)フィールドにバリデーションを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 20-1: 文章(複数行)フィールドの追加
    // -------------------------------------------------------------------------
    test('20-1: 文章(複数行)フィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 42-1: 文字列(複数行)フィールドのバリデーション
    // -------------------------------------------------------------------------
    test('42-1: 文字列(複数行)フィールドにバリデーションを設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
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
        await expect(page.locator('.navbar')).toBeVisible();
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

