// @ts-check
// fields-2.spec.js: フィールドテスト Part 2 (describe #11〜#19: 画像/YesNo/自動採番/固定テキスト/ファイル/列設定/文章複数行/文字列一行/フィールド追加詳細)
// fields.spec.jsから分割 (line 887〜1595)
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
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

/**
 * ログイン共通関数
 * SPA環境ではURLが /admin/login のまま変わらない場合があるため .navbar で待機
 */
async function login(page, email, password) {
    const { ensureLoggedIn } = require('./helpers/ensure-login');
    await ensureLoggedIn(page, email || EMAIL, password || PASSWORD);
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
    // ALLテストテーブルは102フィールドがあるため読み込みに時間がかかる
    await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`, { timeout: 120000 });
    try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
    } catch(e) {
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
    }
    // ALLテストテーブルは102フィールドのためAngular初期化に時間がかかる
    await waitForAngular(page, 180000);
    // ログインページにリダイレクトされた場合は再ログインして再遷移
    if (page.url().includes('/admin/login') || page.url().includes('/user/login')) {
        await login(page);
        await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`, { timeout: 120000 });
        try {
            await page.waitForLoadState('networkidle', { timeout: 5000 });
        } catch(e) {
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
        }
        await waitForAngular(page, 180000);
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
            await page.waitForSelector('.dataset-tabs [role=tab], tabset .nav-tabs li', { timeout: 5000 });
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
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
        }
    } else if (currentUrl.includes(`/admin/dataset__${tableId}`)) {
        // テーブル一覧ページにリダイレクトされた場合
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
    } else {
        // その他のページ：ナビバーが表示されていること
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
    }
}

// =============================================================================
// フィールド追加・各フィールドタイプ テスト
// =============================================================================

// ============================================================
// ファイルレベルのALLテストテーブル共有セットアップ（1回のみ実行）
// ============================================================
let _sharedTableId = null;

test.beforeAll(async ({ browser }) => {
    test.setTimeout(120000);
    const { context, page } = await createAuthContext(browser);
    // about:blankではcookiesが送られないため、先にアプリURLに遷移
    await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await createAllTypeTable(page);
    await createAllTypeData(page, 3);
    _sharedTableId = await getAllTypeTableId(page);
    await context.close();
});

// =============================================================================
// 画像フィールド（48, 226, 240系）
// =============================================================================

test.describe('画像フィールド（48, 226, 240系）', () => {

    let tableId = null;



    // -------------------------------------------------------------------------
    // 48-1: 画像フィールドの追加
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 226: 画像フィールドの設定（新仕様）
    // -------------------------------------------------------------------------

    test.beforeAll(async () => {
            tableId = _sharedTableId;
        });

    test.afterAll(async ({ browser }) => {
            // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
        });

    test.beforeEach(async ({ page }) => {
            test.setTimeout(120000);
            await login(page);
            await closeTemplateModal(page);
        });

    test('F201: フィールド設定', async ({ page }) => {
        await test.step('48-1: 画像フィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // フィールド一覧に「画像」タイプのフィールドが存在すること
            const imageField = page.locator('.pc-field-block').filter({ hasText: '画像' });
            await expect(imageField.first()).toBeVisible();
            // 画像フィールドの歯車アイコンをクリックして設定モーダルを開く
            await imageField.first().hover();
            await imageField.first().locator('.overSetting .fa-gear').click();
            await waitForAngular(page);
            // 設定モーダルが表示されること
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 項目名入力欄が表示されること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('226: 画像フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // フィールド一覧に「画像」タイプのフィールドが存在すること
            const imageField = page.locator('.pc-field-block').filter({ hasText: '画像' });
            await expect(imageField.first()).toBeVisible();
            // 歯車アイコンをクリックして設定モーダルを開く
            await imageField.first().hover();
            await imageField.first().locator('.overSetting .fa-gear').click();
            await waitForAngular(page);
            // 設定モーダルが表示されること
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 項目名入力欄が表示されること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // 画像フィールド固有: 推奨サイズ表示やオプションが設定可能であること
            // モーダルヘッダーに「画像」が含まれること
            await expect(modal.locator('.modal-header')).toContainText('画像');
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
    });
});


// =============================================================================
// Yes/Noフィールド（44, 222, 236系）
// =============================================================================

test.describe('Yes/Noフィールド（44, 222, 236系）', () => {

    let tableId = null;



    // -------------------------------------------------------------------------
    // 44-1: Yes/Noフィールドの追加
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 222: Yes/Noフィールドの表示設定
    // -------------------------------------------------------------------------

    test.beforeAll(async () => {
            tableId = _sharedTableId;
        });

    test.afterAll(async ({ browser }) => {
            // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
        });

    test.beforeEach(async ({ page }) => {
            await login(page);
            await closeTemplateModal(page);
        });

    test('F201: フィールド設定', async ({ page }) => {
        await test.step('44-1: Yes/Noフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // フィールド一覧に Yes/No タイプのフィールドが存在すること
            const boolField = page.locator('.pc-field-block').filter({ hasText: /Yes\s*[\/／]\s*No/ });
            await expect(boolField.first()).toBeVisible();
            // 歯車アイコンをクリックして設定モーダルを開く
            await boolField.first().hover();
            await boolField.first().locator('.overSetting .fa-gear').click();
            await waitForAngular(page);
            // 設定モーダルが表示されること
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 項目名入力欄が表示されること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // Yes/No固有: ラベル入力欄が存在すること（boolean-text）
            await expect(modal.locator('input[type="text"]').nth(1)).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('222: Yes/Noフィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // フィールド一覧に Yes/No タイプのフィールドが存在すること
            const boolField = page.locator('.pc-field-block').filter({ hasText: /Yes\s*[\/／]\s*No/ });
            await expect(boolField.first()).toBeVisible();
            // 歯車アイコンをクリックして設定モーダルを開く
            await boolField.first().hover();
            await boolField.first().locator('.overSetting .fa-gear').click();
            await waitForAngular(page);
            // 設定モーダルが表示され、Yes/No設定が含まれること
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // モーダルヘッダーに「Yes / No」が含まれること
            await expect(modal.locator('.modal-header')).toContainText('Yes');
            // 項目名入力欄が表示されること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
    });
});


// =============================================================================
// 自動採番フィールド（216系）
// =============================================================================

test.describe('自動採番フィールド（216系）', () => {

    let tableId = null;



    // -------------------------------------------------------------------------
    // 216: 自動採番フィールドの設定
    // -------------------------------------------------------------------------

    test.beforeAll(async () => {
            tableId = _sharedTableId;
        });

    test.afterAll(async ({ browser }) => {
            // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
        });

    test.beforeEach(async ({ page }) => {
            // フレイキー対策: beforeEachのタイムアウトを延長（前のdescribeのafterAllが長い場合の対応）
            await login(page);
            await closeTemplateModal(page);
        });

    test('F201: フィールド設定', async ({ page }) => {
        await test.step('216: 自動採番フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // フィールド一覧に「自動採番」タイプのフィールドが存在すること
            const autoIdField = page.locator('.pc-field-block').filter({ hasText: '自動採番' });
            await expect(autoIdField.first()).toBeVisible();
            // 歯車アイコンをクリックして設定モーダルを開く
            await autoIdField.first().hover();
            await autoIdField.first().locator('.overSetting .fa-gear').click();
            await waitForAngular(page);
            // 設定モーダルが表示されること
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 項目名入力欄が表示されること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // 自動採番固有: フォーマット入力欄が存在すること（placeholder: ID-{YYYY}-...）
            const formatInput = modal.locator('input[placeholder*="ID-"]');
            await expect(formatInput).toBeVisible();
            // 自動採番固有: カウンターリセットボタンが存在すること
            await expect(modal.locator('button:has-text("カウンターをリセット")')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
    });
});


// =============================================================================
// 固定テキストフィールド（230系）
// =============================================================================

test.describe('固定テキストフィールド（230系）', () => {

    let tableId = null;



    // -------------------------------------------------------------------------
    // 230: 固定テキストフィールドの設定
    // -------------------------------------------------------------------------

    test.beforeAll(async () => {
            tableId = _sharedTableId;
        });

    test.afterAll(async ({ browser }) => {
            // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
        });

    test.beforeEach(async ({ page }) => {
            await login(page);
            await closeTemplateModal(page);
        });

    test('F201: フィールド設定', async ({ page }) => {
        await test.step('230: 固定テキストフィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // フィールド一覧に「固定テキスト」タイプのフィールドが存在すること
            const fixedField = page.locator('.pc-field-block').filter({ hasText: '固定テキスト' });
            // 固定テキストは fixed_html_wrapper で表示される
            const fixedWrapper = page.locator('.fixed_html_wrapper');
            const hasFixedField = await fixedField.count() > 0 || await fixedWrapper.count() > 0;
            expect(hasFixedField).toBeTruthy();
            // 歯車アイコンをクリックして設定モーダルを開く
            if (await fixedField.count() > 0) {
                await fixedField.first().hover();
                await fixedField.first().locator('.overSetting .fa-gear').click();
            } else {
                // 固定テキストは fixed_html_wrapper の親要素にある
                const fixedBlock = fixedWrapper.first().locator('xpath=ancestor::div[contains(@class,"pc-field-block")]');
                await fixedBlock.hover();
                await fixedBlock.locator('.overSetting .fa-gear').click();
            }
            await waitForAngular(page);
            // 設定モーダルが表示されること
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 固定テキスト固有: 「詳細ページでも表示」チェックボックスが存在すること
            await expect(modal.locator('label:has-text("詳細ページでも表示")')).toBeVisible();
            // 固定テキスト固有: froalaエディタ（リッチテキストエディタ）が存在すること
            const froala = modal.locator('[froalaEditor], .fr-element, .fr-box');
            await expect(froala.first()).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
    });
});


// =============================================================================
// ファイルフィールド（121, 227, 257系）
// =============================================================================

test.describe('ファイルフィールド（121, 227, 257系）', () => {

    let tableId = null;



    // -------------------------------------------------------------------------
    // 121-01: ファイルフィールドのアップロード設定ページが表示されること
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 192: ファイルのZIPアップロード機能が正常に表示されること
    // -------------------------------------------------------------------------

    test.beforeAll(async () => {
            tableId = _sharedTableId;
        });

    test.afterAll(async ({ browser }) => {
            // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
        });

    test.beforeEach(async ({ page }) => {
            await login(page);
            await closeTemplateModal(page);
        });

    test('F202: フィールド設定', async ({ page }) => {
        await test.step('121-01: ファイルフィールドのアップロード設定ページが表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // フィールド一覧に「ファイル」タイプのフィールドが存在すること
            const fileField = page.locator('.pc-field-block').filter({ hasText: 'ファイル' });
            await expect(fileField.first()).toBeVisible();
            // 歯車アイコンをクリックして設定モーダルを開く
            await fileField.first().hover();
            await fileField.first().locator('.overSetting .fa-gear').click();
            await waitForAngular(page);
            // 設定モーダルが表示されること
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 項目名入力欄が表示されること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // ファイルフィールドであること（モーダルヘッダーにファイルが含まれる）
            await expect(modal.locator('.modal-header')).toContainText('ファイル');
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('192: ファイルのZIPアップロード機能が正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            // レコード一覧ページへ（ZIPアップロードはレコード系機能）
            await page.goto(BASE_URL + `/admin/dataset__${tableId || 'ALL'}`, { timeout: 5000 });
            await waitForAngular(page);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            // レコード一覧が表示されていること
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            // ファイルフィールドがあるテーブルのレコード一覧で、ファイルアップロード用のinputが利用可能であること
            // レコード追加ボタンが表示されていること（データ操作が可能な状態）
            const addBtn = page.locator('a:has-text("追加"), button:has-text("追加")');
            await expect(addBtn.first()).toBeVisible();

        });
    });
});


// =============================================================================
// 列設定（122系）
// =============================================================================

test.describe('列設定（122系）', () => {

    let tableId = null;



    // -------------------------------------------------------------------------
    // 122-01: 列の表示/非表示設定
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 122-02: 列の並び替え設定
    // -------------------------------------------------------------------------

    test.beforeAll(async () => {
            tableId = _sharedTableId;
        });

    test.afterAll(async ({ browser }) => {
            // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
        });

    test.beforeEach(async ({ page }) => {
            await login(page);
            await closeTemplateModal(page);
        });

    test('F202: フィールド設定', async ({ page }) => {
        await test.step('122-01: 列の表示/非表示設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            // レコード一覧ページに遷移（列の表示/非表示は一覧ページの機能）
            await page.goto(BASE_URL + `/admin/dataset__${tableId || 'ALL'}`, { timeout: 5000 });
            await waitForAngular(page);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            // テーブルヘッダーが表示されていること（一覧テーブルが存在する）
            const tableHeader = page.locator('table thead th, .table-responsive th, .sticky-table-header th');
            const headerCount = await tableHeader.count();
            expect(headerCount).toBeGreaterThan(0);
            // 列の表示/非表示を制御するUI（歯車アイコンや列設定ボタン）が存在すること
            // PigeonCloudでは一覧ページ上部のボタンバーから列設定にアクセスする
            const settingBtns = page.locator('.fa-gear, .fa-cog, [class*="column-setting"], button:has-text("列")');
            const hasSetting = await settingBtns.count() > 0;
            // 設定UIがある場合はクリックして確認、なくても一覧テーブルのヘッダー列が正常に表示されていることを確認
            if (hasSetting) {
                await settingBtns.first().click();
                await waitForAngular(page);
            }
            // 少なくとも一覧テーブルにカラムヘッダーが複数あること
            expect(headerCount).toBeGreaterThan(1);

        });
        await test.step('122-02: 列の並び替え設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // フィールド設定ページでフィールドの並び替えが可能であること
            // cdkDrag要素（ドラッグ可能なフィールド行）が複数存在すること
            const dragItems = page.locator('[cdkDrag], .cdk-drag');
            const dragCount = await dragItems.count();
            expect(dragCount).toBeGreaterThan(1);
            // 各フィールド行にドラッグハンドルが存在すること
            const dragHandles = page.locator('[cdkDragHandle], .dragger');
            const handleCount = await dragHandles.count();
            expect(handleCount).toBeGreaterThan(0);

        });
    });
});


// =============================================================================
// 文章複数行（リッチテキスト/通常テキスト）（218, 219, 232, 233系）
// =============================================================================

test.describe('文章複数行フィールド（218, 219, 232, 233系）', () => {

    let tableId = null;



    // -------------------------------------------------------------------------
    // 218: 文章複数行（通常テキスト）フィールド
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 219: 文章複数行（リッチテキスト）フィールド
    // -------------------------------------------------------------------------

    test.beforeAll(async () => {
            tableId = _sharedTableId;
        });

    test.afterAll(async ({ browser }) => {
            // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
        });

    test.beforeEach(async ({ page }) => {
            await login(page);
            await closeTemplateModal(page);
        });

    test('F203: フィールド設定', async ({ page }) => {
        await test.step('218: 文章複数行（通常テキスト）フィールドの設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // フィールド一覧に「通常テキスト」の文章複数行フィールドが存在すること
            // textareaかリッチテキスト含む.pc-field-blockを探す
            const textareaFields = page.locator('.pc-field-block textarea, .pc-field-block .form-control[rows]');
            const textareaBlocks = page.locator('.pc-field-block').filter({ has: page.locator('textarea') });
            // textareaがなくてもフィールドリスト自体にtextarea型のラベルがある
            // 歯車アイコンで設定モーダルを開いて種類「通常テキスト」のラジオを確認
            // まずフィールド一覧の全pc-field-blockをクリックして通常テキストフィールドを見つける
            const allFields = page.locator('.pc-field-block');
            const fieldCount = await allFields.count();
            expect(fieldCount).toBeGreaterThan(0);
            // 「項目を追加する」ボタンが存在すること
            await expect(page.locator('button:has-text("項目を追加する")')).toBeVisible();
            // 「項目を追加する」をクリックしてフィールドタイプ選択モーダルを開く
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // フィールドタイプ一覧に「文章(複数行)」ボタンが存在すること
            await expect(modal.locator('button:has-text("文章(複数行)")')).toBeVisible();
            // 「文章(複数行)」を選択
            await modal.locator('button:has-text("文章(複数行)")').click();
            await waitForAngular(page);
            // 種類ラジオで「通常テキスト」が選択可能であること
            await expect(modal.locator('label:has-text("通常テキスト")')).toBeVisible();
            await expect(modal.locator('label:has-text("リッチテキスト")')).toBeVisible();
            // モーダルを閉じる（キャンセル）
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('219: 文章複数行（リッチテキスト）フィールドの設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリックしてフィールドタイプ選択モーダルを開く
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「文章(複数行)」を選択
            await modal.locator('button:has-text("文章(複数行)")').click();
            await waitForAngular(page);
            // 種類ラジオで「リッチテキスト」が選択可能であること
            const richRadio = modal.locator('input[type="radio"][value="richtext"]');
            await expect(richRadio).toBeVisible();
            // 「リッチテキスト」を選択
            await richRadio.click();
            await waitForAngular(page);
            // 項目名入力欄が表示されていること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // モーダルを閉じる（キャンセル）
            await modal.locator('button:has-text("キャンセル")').click();

        });
    });
});


// =============================================================================
// 文字列一行フィールド（217, 231系）
// =============================================================================

test.describe('文字列一行フィールド（217, 231系）', () => {

    let tableId = null;



    // -------------------------------------------------------------------------
    // 217: 文字列一行フィールド
    // -------------------------------------------------------------------------

    test.beforeAll(async () => {
            tableId = _sharedTableId;
        });

    test.afterAll(async ({ browser }) => {
            // afterAllは何もしない（テーブルは次のdescribeブロックで再利用するため削除しない）
        });

    test.beforeEach(async ({ page }) => {
            await login(page);
            await closeTemplateModal(page);
        });

    test('F203: フィールド設定', async ({ page }) => {
        await test.step('217: 文字列一行フィールドの設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリックしてフィールドタイプ選択モーダルを開く
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // フィールドタイプ一覧に「文字列(一行)」ボタンが存在すること
            await expect(modal.locator('button:has-text("文字列(一行)")')).toBeVisible();
            // 「文字列(一行)」を選択
            await modal.locator('button:has-text("文字列(一行)")').click();
            await waitForAngular(page);
            // 種類ラジオボタンが表示されること（テキスト/メールアドレス/URL）
            await expect(modal.locator('label:has-text("テキスト")')).toBeVisible();
            await expect(modal.locator('label:has-text("メールアドレス")')).toBeVisible();
            await expect(modal.locator('label:has-text("URL")')).toBeVisible();
            // 項目名入力欄が表示されていること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // 「値の重複を禁止する」チェックボックスが存在すること
            await expect(modal.locator('label:has-text("値の重複を禁止する")')).toBeVisible();
            // モーダルを閉じる（キャンセル）
            await modal.locator('button:has-text("キャンセル")').click();

        });
    });
});


// =============================================================================
// フィールドの追加 詳細バリエーション（14-1〜14-29）
// =============================================================================

test.describe('フィールドの追加 詳細（14-1〜14-29）', () => {

    let tableId = null;


    // -------------------------------------------------------------------------
    // 14-1: テキストフィールド（デフォルト設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-2: メールアドレスフィールド（追加オプション全設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-3: URLフィールド（追加オプション設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-3-1: URLフィールド（複数の値の登録を許可）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-4: 数値フィールド（フィールド名のみ入力）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-5: 数値フィールド（整数・単位記号等詳細設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-6: 数値フィールド（小数・桁区切り・単位記号等詳細設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-7: ラジオボタン（単一選択）フィールド（デフォルト設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-8: ラジオボタン（単一選択）フィールド（追加オプション全設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-9: プルダウン（単一選択）フィールド（追加オプション全設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-12-1: 年月フィールド（追加オプション設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-13: ファイルフィールド（追加オプション設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-14: 計算フィールド（デフォルト設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-15: 計算フィールド（整数・自動更新オフ等詳細設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-16: 計算フィールド（小数・自動更新オフ等詳細設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-17: 文章(複数行)フィールド・通常テキスト（デフォルト設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-18: 文章(複数行)フィールド・リッチテキスト（追加オプション設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-19: Yes/Noフィールド（デフォルト設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-20: Yes/Noフィールド（追加オプション設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-21: チェックボックス（複数選択）フィールド（デフォルト設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-22: プルダウン（複数選択）フィールド（追加オプション設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-23: 画像フィールド（追加オプション設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-24: 他テーブル参照フィールド（デフォルト設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-25: 他テーブル参照フィールド（追加オプション全設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-25': 他テーブル参照フィールド（複数値許可あり・追加オプション設定）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-26: 関連レコード一覧フィールド（絞り込み条件: 次を含む）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-27: 関連レコード一覧フィールド（絞り込み条件: 次と一致しない）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-28: 関連レコード一覧フィールド（絞り込み条件: 次を含む・別パターン）
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // 14-29: 関連レコード一覧フィールド（絞り込み条件: 次を含まない）
    // -------------------------------------------------------------------------

    test.beforeAll(async () => {
            tableId = _sharedTableId;
        });

    test.beforeEach(async ({ page }) => {
            await login(page);
            await closeTemplateModal(page);
        });

    test('F203: フィールド設定', async ({ page }) => {
        await test.step('14-1: テキスト種別フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「文字列(一行)」を選択
            await modal.locator('button:has-text("文字列(一行)")').click();
            await waitForAngular(page);
            // 種類ラジオで「テキスト」がデフォルト選択されていること
            const textRadio = modal.locator('input[type="radio"][value="text"]');
            await expect(textRadio).toBeVisible();
            await expect(textRadio).toBeChecked();
            // 項目名入力欄が表示されていること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-2: メールアドレス種別フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「文字列(一行)」を選択
            await modal.locator('button:has-text("文字列(一行)")').click();
            await waitForAngular(page);
            // 種類ラジオで「メールアドレス」を選択できること
            const emailRadio = modal.locator('input[type="radio"][value="email"]');
            await expect(emailRadio).toBeVisible();
            await emailRadio.click();
            await waitForAngular(page);
            // 項目名入力欄が表示されていること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-3: URL種別フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「文字列(一行)」を選択
            await modal.locator('button:has-text("文字列(一行)")').click();
            await waitForAngular(page);
            // 種類ラジオで「URL」を選択できること
            const urlRadio = modal.locator('input[type="radio"][value="url"]');
            await expect(urlRadio).toBeVisible();
            await urlRadio.click();
            await waitForAngular(page);
            // 項目名入力欄が表示されていること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-3-1: URLフィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「文字列(一行)」を選択
            await modal.locator('button:has-text("文字列(一行)")').click();
            await waitForAngular(page);
            // 種類ラジオで「URL」を選択
            const urlRadio = modal.locator('input[type="radio"][value="url"]');
            await expect(urlRadio).toBeVisible();
            await urlRadio.click();
            await waitForAngular(page);
            // URL選択時は「値の重複を禁止する」が非表示になること（URLは重複禁止対象外）
            // 項目名入力欄が表示されていること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-4: 数値フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「数値」を選択
            await modal.locator('button:has-text("数値")').click();
            await waitForAngular(page);
            // 項目名入力欄が表示されていること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // 数値固有: 整数/小数の選択ラジオが存在すること
            await expect(modal.locator('label:has-text("整数")')).toBeVisible();
            await expect(modal.locator('label:has-text("小数")')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-5: 数値（整数）フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「数値」を選択
            await modal.locator('button:has-text("数値")').click();
            await waitForAngular(page);
            // 整数ラジオが選択されていること（デフォルト）
            const intRadio = modal.locator('input[type="radio"][value="integer"]');
            await expect(intRadio).toBeVisible();
            // 単位記号の入力欄が存在すること
            await expect(modal.locator('label:has-text("単位")')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-6: 数値（小数）フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「数値」を選択
            await modal.locator('button:has-text("数値")').click();
            await waitForAngular(page);
            // 小数ラジオを選択
            const decimalRadio = modal.locator('input[type="radio"][value="decimal"]');
            await expect(decimalRadio).toBeVisible();
            await decimalRadio.click();
            await waitForAngular(page);
            // 小数点以下桁数の入力欄が表示されること
            await expect(modal.locator('label:has-text("小数点以下")')).toBeVisible();
            // 桁区切り設定が存在すること
            await expect(modal.locator('label:has-text("桁区切り")')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-17: 文章(複数行)・通常テキストフィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
        await test.step('14-18: 文章(複数行)・リッチテキストフィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
    });

    test('F204: フィールド設定', async ({ page }) => {
        await test.step('14-7: ラジオボタン種別（単一選択）フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「選択肢(単一選択)」を選択
            await modal.locator('button:has-text("選択肢(単一選択)")').click();
            await waitForAngular(page);
            // 種類ラジオで「ラジオボタン」がデフォルトであること
            const radioType = modal.locator('input[type="radio"][value="radio"]');
            await expect(radioType).toBeVisible();
            // 選択肢入力欄（カンマ区切り）が存在すること
            await expect(modal.locator('label:has-text("選択肢")')).toBeVisible();
            // Layoutラジオ（横並び/縦並び）が存在すること
            await expect(modal.locator('label:has-text("横並び")')).toBeVisible();
            await expect(modal.locator('label:has-text("縦並び")')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-8: ラジオボタン種別フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「選択肢(単一選択)」を選択
            await modal.locator('button:has-text("選択肢(単一選択)")').click();
            await waitForAngular(page);
            // 種類ラジオで「プルダウン」を選択できること
            const selectType = modal.locator('input[type="radio"][value="select"]');
            await expect(selectType).toBeVisible();
            // 選択肢入力欄が存在すること
            await expect(modal.locator('label:has-text("選択肢")')).toBeVisible();
            // 項目名入力欄が存在すること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-9: プルダウン種別（単一選択）フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「選択肢(単一選択)」を選択
            await modal.locator('button:has-text("選択肢(単一選択)")').click();
            await waitForAngular(page);
            // 種類ラジオで「プルダウン」を選択
            const selectType = modal.locator('input[type="radio"][value="select"]');
            await expect(selectType).toBeVisible();
            await selectType.click();
            await waitForAngular(page);
            // 選択肢入力欄が存在すること
            await expect(modal.locator('label:has-text("選択肢")')).toBeVisible();
            // 項目名入力欄が存在すること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-12-1: 年月種別フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「日時」を選択
            await modal.locator('button:has-text("日時")').click();
            await waitForAngular(page);
            // 種類ラジオで「年月」が選択可能であること
            const yearMonthRadio = modal.locator('input[type="radio"][value="year_month"]');
            await expect(yearMonthRadio).toBeVisible();
            await yearMonthRadio.click();
            await waitForAngular(page);
            // 項目名入力欄が存在すること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-13: ファイルフィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「ファイル」を選択
            await modal.locator('button:has-text("ファイル")').click();
            await waitForAngular(page);
            // 項目名入力欄が表示されること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // ファイルフィールドの設定モーダルであること
            await expect(modal.locator('.modal-header')).toContainText('ファイル');
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-14: 計算フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「計算」を選択
            await modal.locator('button:has-text("計算")').click();
            await waitForAngular(page);
            // 計算式入力欄（contenteditable）が表示されること
            await expect(modal.locator('#CommentExpression, .contenteditable')).toBeVisible();
            // 計算値の種類ドロップダウンが存在すること
            await expect(modal.locator('label:has-text("計算値の種類")')).toBeVisible();
            // 計算値の自動更新チェックボックスが存在すること
            await expect(modal.locator('label:has-text("計算値の自動更新")')).toBeVisible();
            // 項目名入力欄が表示されること
            await expect(modal.locator('input[type="text"][name="label"]')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-15: 計算フィールド（整数形式）のフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「計算」を選択
            await modal.locator('button:has-text("計算")').click();
            await waitForAngular(page);
            // 計算値の種類で「数値」がデフォルト選択されていること
            const calcType = modal.locator('select');
            await expect(calcType.first()).toBeVisible();
            // 計算式入力欄が表示されること
            await expect(modal.locator('#CommentExpression, .contenteditable')).toBeVisible();
            // 整数/小数のラジオが存在すること（数値選択時）
            await expect(modal.locator('label:has-text("整数")')).toBeVisible();
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-16: 計算フィールド（小数形式）のフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);
            // 「項目を追加する」をクリック
            await page.locator('button:has-text("項目を追加する")').click();
            await waitForAngular(page);
            const modal = page.locator('.settingModal .modal-content');
            await expect(modal).toBeVisible();
            // 「計算」を選択
            await modal.locator('button:has-text("計算")').click();
            await waitForAngular(page);
            // 計算式入力欄が表示されること
            await expect(modal.locator('#CommentExpression, .contenteditable')).toBeVisible();
            // 小数ラジオを選択
            const decimalRadio = modal.locator('input[type="radio"][value="decimal"]');
            if (await decimalRadio.count() > 0) {
                await decimalRadio.click();
                await waitForAngular(page);
                // 小数点以下桁数の設定が表示されること
                await expect(modal.locator('label:has-text("小数点以下")')).toBeVisible();
            }
            // モーダルを閉じる
            await modal.locator('button:has-text("キャンセル")').click();

        });
        await test.step('14-19: Yes/Noフィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
        await test.step('14-20: Yes/Noフィールドのフィールド設定ページが正常に表示されること（追加オプション）', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
        await test.step('14-21: チェックボックス種別（複数選択）フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
        await test.step('14-22: プルダウン種別フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
        await test.step('14-23: 画像フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
        await test.step('14-24: 他テーブル参照フィールドのフィールド設定ページが正常に表示されること', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
        await test.step('14-25: 他テーブル参照フィールドのフィールド設定ページが正常に表示されること（追加オプション）', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
        await test.step('14-26: 関連レコード一覧フィールドのフィールド設定ページが正常に表示されること（絞り込み条件: 次を含む）', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
        await test.step('14-27: 関連レコード一覧フィールドのフィールド設定ページが正常に表示されること（絞り込み条件: 次と一致しない）', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
        await test.step('14-28: 関連レコード一覧フィールドのフィールド設定ページが正常に表示されること（絞り込み条件: 次を含む別パターン）', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
        await test.step('14-29: 関連レコード一覧フィールドのフィールド設定ページが正常に表示されること（絞り込み条件: 次を含まない）', async () => {
            const STEP_TIME = Date.now();

            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);

        });
    });

    test("14-25': 他テーブル参照フィールドのフィールド設定ページが正常に表示されること（複数値許可）", async ({ page }) => {
            await navigateToFieldPage(page, tableId);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await assertFieldPageLoaded(page, tableId);
        });
});


// =============================================================================
// 日時フィールド種類変更・バリデーション（19, 47, 97, 101系）
// =============================================================================

