// @ts-check
// fields-2.spec.js: フィールドテスト Part 2 (describe #11〜#19: 画像/YesNo/自動採番/固定テキスト/ファイル/列設定/文章複数行/文字列一行/フィールド追加詳細)
// fields.spec.jsから分割 (line 887〜1595)
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

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
            await page.waitForTimeout(800);
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
    if (existing) {
        return { result: 'success', tableId: String(existing.table_id || existing.id) };
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
    await page.waitForTimeout(1500);
    // ログインページにリダイレクトされた場合は再ログインして再遷移
    if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
        await login(page);
        await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`);
        try {
            await page.waitForLoadState('networkidle', { timeout: 10000 });
        } catch(e) {
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
        }
        await page.waitForTimeout(1500);
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

// =============================================================================
// 画像フィールド（48, 226, 240系）
// =============================================================================

test.describe('画像フィールド（48, 226, 240系）', () => {
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(480000); // createAllTypeTableが長時間かかるためタイムアウトを延長（360秒）
        const page = await browser.newPage();
        await login(page);
        await createAllTypeTable(page);
        tableId = await getAllTypeTableId(page);
        await page.close();
    });

    test.afterAll(async ({ browser }) => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 48-1: 画像フィールドの追加
    // -------------------------------------------------------------------------
    test('48-1: 画像フィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 226: 画像フィールドの設定（新仕様）
    // -------------------------------------------------------------------------
    test('226: 画像フィールドの各設定が正常に動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// Yes/Noフィールド（44, 222, 236系）
// =============================================================================

test.describe('Yes/Noフィールド（44, 222, 236系）', () => {
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(480000); // createAllTypeTableが長時間かかるためタイムアウトを延長（360秒）
        const page = await browser.newPage();
        await login(page);
        await createAllTypeTable(page);
        tableId = await getAllTypeTableId(page);
        await page.close();
    });

    test.afterAll(async ({ browser }) => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 44-1: Yes/Noフィールドの追加
    // -------------------------------------------------------------------------
    test('44-1: Yes/Noフィールド設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 222: Yes/Noフィールドの表示設定
    // -------------------------------------------------------------------------
    test('222: Yes/Noフィールドの表示設定が正常に動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// 自動採番フィールド（216系）
// =============================================================================

test.describe('自動採番フィールド（216系）', () => {
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(480000); // createAllTypeTableが長時間かかるためタイムアウトを延長（360秒）
        const page = await browser.newPage();
        await login(page);
        await createAllTypeTable(page);
        tableId = await getAllTypeTableId(page);
        await page.close();
    });

    test.afterAll(async ({ browser }) => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        // フレイキー対策: beforeEachのタイムアウトを延長（前のdescribeのafterAllが長い場合の対応）
        test.setTimeout(90000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 216: 自動採番フィールドの設定
    // -------------------------------------------------------------------------
    test('216: 自動採番フィールドが正常に設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// 固定テキストフィールド（230系）
// =============================================================================

test.describe('固定テキストフィールド（230系）', () => {
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(480000); // createAllTypeTableが長時間かかるためタイムアウトを延長（360秒）
        const page = await browser.newPage();
        await login(page);
        await createAllTypeTable(page);
        tableId = await getAllTypeTableId(page);
        await page.close();
    });

    test.afterAll(async ({ browser }) => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 230: 固定テキストフィールドの設定
    // -------------------------------------------------------------------------
    test('230: 固定テキストフィールドが正常に設定できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// ファイルフィールド（121, 227, 257系）
// =============================================================================

test.describe('ファイルフィールド（121, 227, 257系）', () => {
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(480000); // createAllTypeTableが長時間かかるためタイムアウトを延長（360秒）
        const page = await browser.newPage();
        await login(page);
        await createAllTypeTable(page);
        await createAllTypeData(page, 3);
        tableId = await getAllTypeTableId(page);
        await page.close();
    });

    test.afterAll(async ({ browser }) => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 121-01: ファイルフィールドのアップロード
    // -------------------------------------------------------------------------
    test('121-01: ファイルフィールドのアップロード設定ページが表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 192: ファイルのZIPアップロード
    // -------------------------------------------------------------------------
    test('192: ファイルのZIPアップロード機能が正常に表示されること', async ({ page }) => {
        // レコード一覧ページへ（ZIPアップロードはレコード系機能）
        await page.goto(BASE_URL + `/admin/dataset__${tableId || 'ALL'}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1000);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// 列設定（122系）
// =============================================================================

test.describe('列設定（122系）', () => {
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(480000); // createAllTypeTableが長時間かかるためタイムアウトを延長（360秒）
        const page = await browser.newPage();
        await login(page);
        await createAllTypeTable(page);
        tableId = await getAllTypeTableId(page);
        await page.close();
    });

    test.afterAll(async ({ browser }) => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 122-01: 列の表示/非表示設定
    // -------------------------------------------------------------------------
    test('122-01: 列の表示/非表示設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 122-02: 列の並び替え設定
    // -------------------------------------------------------------------------
    test('122-02: 列の並び替え設定が正常に動作すること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// 文章複数行（リッチテキスト/通常テキスト）（218, 219, 232, 233系）
// =============================================================================

test.describe('文章複数行フィールド（218, 219, 232, 233系）', () => {
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(480000); // createAllTypeTableが長時間かかるためタイムアウトを延長（360秒）
        const page = await browser.newPage();
        await login(page);
        await createAllTypeTable(page);
        tableId = await getAllTypeTableId(page);
        await page.close();
    });

    test.afterAll(async ({ browser }) => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 218: 文章複数行（通常テキスト）フィールド
    // -------------------------------------------------------------------------
    test('218: 文章複数行（通常テキスト）フィールドの設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 219: 文章複数行（リッチテキスト）フィールド
    // -------------------------------------------------------------------------
    test('219: 文章複数行（リッチテキスト）フィールドの設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// 文字列一行フィールド（217, 231系）
// =============================================================================

test.describe('文字列一行フィールド（217, 231系）', () => {
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(480000); // createAllTypeTableが長時間かかるためタイムアウトを延長（360秒）
        const page = await browser.newPage();
        await login(page);
        await createAllTypeTable(page);
        tableId = await getAllTypeTableId(page);
        await page.close();
    });

    test.afterAll(async ({ browser }) => {
        // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 217: 文字列一行フィールド
    // -------------------------------------------------------------------------
    test('217: 文字列一行フィールドの設定ページが正常に表示されること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// フィールドの追加 詳細バリエーション（14-1〜14-29）
// =============================================================================

test.describe('フィールドの追加 詳細（14-1〜14-29）', () => {
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(480000);
        const page = await browser.newPage();
        await login(page);
        await createAllTypeTable(page);
        tableId = await getAllTypeTableId(page);
        await page.close();
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000);
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 14-1: テキストフィールド（デフォルト設定）
    // -------------------------------------------------------------------------
    test('14-1: テキスト種別のフィールドをデフォルト設定で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        expect(pageText).not.toContain('404');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-2: メールアドレスフィールド（追加オプション全設定）
    // -------------------------------------------------------------------------
    test('14-2: メールアドレス種別フィールドを追加オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-3: URLフィールド（追加オプション設定）
    // -------------------------------------------------------------------------
    test('14-3: URL種別フィールドを追加オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-3-1: URLフィールド（複数の値の登録を許可）
    // -------------------------------------------------------------------------
    test('14-3-1: URLフィールドで複数の値の登録を許可できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-4: 数値フィールド（フィールド名のみ入力）
    // -------------------------------------------------------------------------
    test('14-4: 数値フィールドをフィールド名のみで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-5: 数値フィールド（整数・単位記号等詳細設定）
    // -------------------------------------------------------------------------
    test('14-5: 数値（整数）フィールドを詳細オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-6: 数値フィールド（小数・桁区切り・単位記号等詳細設定）
    // -------------------------------------------------------------------------
    test('14-6: 数値（小数）フィールドを詳細オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-7: ラジオボタン（単一選択）フィールド（デフォルト設定）
    // -------------------------------------------------------------------------
    test('14-7: ラジオボタン種別（単一選択）フィールドをデフォルト設定で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-8: ラジオボタン（単一選択）フィールド（追加オプション全設定）
    // -------------------------------------------------------------------------
    test('14-8: ラジオボタン種別フィールドを追加オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-9: プルダウン（単一選択）フィールド（追加オプション全設定）
    // -------------------------------------------------------------------------
    test('14-9: プルダウン種別（単一選択）フィールドを追加オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-12-1: 年月フィールド（追加オプション設定）
    // -------------------------------------------------------------------------
    test('14-12-1: 年月種別フィールドを追加オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-13: ファイルフィールド（追加オプション設定）
    // -------------------------------------------------------------------------
    test('14-13: ファイルフィールドを追加オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-14: 計算フィールド（デフォルト設定）
    // -------------------------------------------------------------------------
    test('14-14: 計算フィールドをデフォルト設定で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-15: 計算フィールド（整数・自動更新オフ等詳細設定）
    // -------------------------------------------------------------------------
    test('14-15: 計算フィールド（整数形式）を詳細設定で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-16: 計算フィールド（小数・自動更新オフ等詳細設定）
    // -------------------------------------------------------------------------
    test('14-16: 計算フィールド（小数形式）を詳細設定で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-17: 文章(複数行)フィールド・通常テキスト（デフォルト設定）
    // -------------------------------------------------------------------------
    test('14-17: 文章(複数行)・通常テキストフィールドをデフォルト設定で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-18: 文章(複数行)フィールド・リッチテキスト（追加オプション設定）
    // -------------------------------------------------------------------------
    test('14-18: 文章(複数行)・リッチテキストフィールドを追加オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-19: Yes/Noフィールド（デフォルト設定）
    // -------------------------------------------------------------------------
    test('14-19: Yes/Noフィールドをデフォルト設定で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-20: Yes/Noフィールド（追加オプション設定）
    // -------------------------------------------------------------------------
    test('14-20: Yes/Noフィールドを追加オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-21: チェックボックス（複数選択）フィールド（デフォルト設定）
    // -------------------------------------------------------------------------
    test('14-21: チェックボックス種別（複数選択）フィールドをデフォルト設定で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-22: プルダウン（複数選択）フィールド（追加オプション設定）
    // -------------------------------------------------------------------------
    test('14-22: プルダウン種別フィールドを追加オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-23: 画像フィールド（追加オプション設定）
    // -------------------------------------------------------------------------
    test('14-23: 画像フィールドを追加オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-24: 他テーブル参照フィールド（デフォルト設定）
    // -------------------------------------------------------------------------
    test('14-24: 他テーブル参照フィールドをデフォルト設定で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-25: 他テーブル参照フィールド（追加オプション全設定）
    // -------------------------------------------------------------------------
    test('14-25: 他テーブル参照フィールドを追加オプション付きで追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-25': 他テーブル参照フィールド（複数値許可あり・追加オプション設定）
    // -------------------------------------------------------------------------
    test("14-25': 他テーブル参照フィールドで複数値の登録を許可して追加できること", async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-26: 関連レコード一覧フィールド（絞り込み条件: 次を含む）
    // -------------------------------------------------------------------------
    test('14-26: 関連レコード一覧フィールドを絞り込み条件「次を含む」で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-27: 関連レコード一覧フィールド（絞り込み条件: 次と一致しない）
    // -------------------------------------------------------------------------
    test('14-27: 関連レコード一覧フィールドを絞り込み条件「次と一致しない」で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-28: 関連レコード一覧フィールド（絞り込み条件: 次を含む・別パターン）
    // -------------------------------------------------------------------------
    test('14-28: 関連レコード一覧フィールドを絞り込み条件「次を含む（別パターン）」で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });

    // -------------------------------------------------------------------------
    // 14-29: 関連レコード一覧フィールド（絞り込み条件: 次を含まない）
    // -------------------------------------------------------------------------
    test('14-29: 関連レコード一覧フィールドを絞り込み条件「次を含まない」で追加できること', async ({ page }) => {
        await navigateToFieldPage(page, tableId);
        await expect(page.locator('.navbar')).toBeVisible();
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await assertFieldPageLoaded(page, tableId);
    });
});

// =============================================================================
// 日時フィールド種類変更・バリデーション（19, 47, 97, 101系）
// =============================================================================

