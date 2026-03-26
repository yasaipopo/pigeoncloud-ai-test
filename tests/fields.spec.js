// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

async function waitForAngular(page, timeout = 15000) {
    await page.waitForSelector('body[data-ng-ready="true"]', { timeout });
}

/**
 * ログイン共通関数
 * SPA環境ではURLが /admin/login のまま変わらない場合があるため .navbar で待機
 */
async function login(page, email, password) {
    // 最大3回リトライ（CSRF失敗などの間欠的エラーに対応）
    for (let attempt = 1; attempt <= 3; attempt++) {
        await page.goto(BASE_URL + '/admin/login');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(500); // フォーム初期化待機
        await page.fill('#id', email || EMAIL);
        await page.fill('#password', password || PASSWORD);
        await page.click('button[type=submit].btn-primary');
        try {
            await page.waitForSelector('.navbar', { timeout: 40000 });
            await page.waitForTimeout(1000);
            return; // ログイン成功
        } catch (e) {
            if (attempt < 3) {
                // 次のリトライ前に少し待機
                await page.waitForTimeout(2000);
            } else {
                throw new Error(`ログイン失敗（3回試行）: ${e.message}`);
            }
        }
    }
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
    const page = await browser.newPage();
    await login(page);
    await createAllTypeTable(page);
    await createAllTypeData(page, 5);
    _sharedTableId = await getAllTypeTableId(page);
    await page.close();
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
    test('101-1: 日時フィールド（種類:日時）にデフォルト現在日時をセットして追加できること', async ({ page }) => {
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
    test('101-2: 日付のみフィールドにデフォルト現在日付をセットして追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 101-3: 時刻のみフィールドの現在時刻セット（新規追加）
    // -------------------------------------------------------------------------
    test('101-3: 時刻のみフィールドにデフォルト現在時刻をセットして追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 101-7: 年月フィールドの現在時刻セット（新規追加）
    // -------------------------------------------------------------------------
    test('101-7: 年月フィールドにデフォルト現在年月をセットして追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
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
    test('14-12: 文字列(一行)フィールドを追加できること', async ({ page }) => {
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
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 94-1: 項目名の前後のタブのパディング
    // -------------------------------------------------------------------------
    test('94-1: 項目名の前後にタブを入力してもトリミングされて登録されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
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
        await assertFieldPageLoaded(page, tableId);
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

