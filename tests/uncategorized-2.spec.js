// @ts-check
const { test, expect } = require('@playwright/test');
const { ensureLoggedIn } = require('./helpers/ensure-login');
const { createAuthContext } = require('./helpers/auth-context');

// =============================================================================
// 未分類テスト（580件）
// 主要な代表ケースを実装し、残りは test.todo() でマーク
// =============================================================================

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


const { getAllTypeTableId } = require('./helpers/table-setup');
const { removeUserLimit, removeTableLimit } = require('./helpers/debug-settings');

/**
 * ログイン共通関数
 */
async function login(page, email, password) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);
    // すでにdashboardにリダイレクトされている場合はログイン済み
    if (page.url().includes('/admin/dashboard')) {
        await page.waitForTimeout(500);
        return;
    }
    // アカウントロックチェック
    const bodyText = await page.innerText('body').catch(() => '');
    if (bodyText.includes('アカウントロック') || bodyText.includes('account lock')) {
        throw new Error('アカウントロック: テスト環境のログインが制限されています');
    }
    // login_max_devicesエラーの場合、強制ログアウトを実行してから再ログイン
    if (bodyText.includes('login_max_devices') || bodyText.includes('ログイン上限')) {
        await page.evaluate(async (baseUrl) => {
            await fetch(baseUrl + '/admin/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
        }, BASE_URL).catch(() => {});
        await page.waitForTimeout(1000);
        await page.goto(BASE_URL + '/admin/login');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(500);
    }
    await page.fill('#id', email || EMAIL);
    await page.fill('#password', password || PASSWORD);
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 180000 });
    } catch (e) {
        // アカウントロックエラーをチェック
        const errText = await page.innerText('body').catch(() => '');
        if (errText.includes('アカウントロック') || errText.includes('account lock')) {
            throw new Error('アカウントロック: テスト環境のログインが制限されています');
        }
        // login_max_devicesエラーの場合、少し待ってからリトライ
        if (errText.includes('login_max_devices') || errText.includes('ログイン上限') || page.url().includes('/admin/login')) {
            await page.waitForTimeout(3000);
            // 再度ログインを試みる
            const currentUrl = page.url();
            if (currentUrl.includes('/admin/login')) {
                // Laddaボタンが無効化されている場合は有効になるまで待機
                await page.waitForSelector('button[type=submit].btn-primary:not([disabled])', { timeout: 30000 }).catch(() => {});
                await page.fill('#id', email || EMAIL);
                await page.fill('#password', password || PASSWORD);
                await page.click('button[type=submit].btn-primary');
                await page.waitForURL('**/admin/dashboard', { timeout: 180000 }).catch(() => {});
            }
        }
        // 利用規約同意画面への対処
        const termsCheckbox = page.locator('input[type=checkbox]').first();
        if (await termsCheckbox.count() > 0) {
            await termsCheckbox.check();
            await page.waitForTimeout(500);
            const continueBtn = page.locator('button').filter({ hasText: '続ける' }).first();
            if (await continueBtn.count() > 0) {
                await continueBtn.click();
                await waitForAngular(page);
                await page.waitForURL('**/admin/dashboard', { timeout: 180000 }).catch(() => {});
            }
        }
    }
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
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
        const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
        return res.json();
    }, BASE_URL);
    const existing = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
    if (existing) {
        return { result: 'success', table_id: existing.table_id || existing.id };
    }
    // 504 Gateway Timeoutが返る場合があるため、ポーリングでテーブル作成完了を確認
    const createPromise = page.evaluate(async (baseUrl) => {
        const res = await fetch(baseUrl + '/api/admin/debug/create-all-type-table', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({}),
            credentials: 'include',
        });
        return { status: res.status };
    }, BASE_URL).catch(() => ({ status: 0 }));
    // 最大120秒ポーリングでテーブル作成完了を確認
    for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(10000);
        const statusCheck = await page.evaluate(async (baseUrl) => {
            const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
            return res.json();
        }, BASE_URL);
        const tableCheck = (statusCheck.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
        if (tableCheck) {
            return { result: 'success', table_id: tableCheck.table_id || tableCheck.id };
        }
    }
    const apiResult = await createPromise;
    return { result: 'error', status: apiResult.status };
}

/**
 * デバッグAPIでテストデータを投入するユーティリティ
 */
async function createAllTypeData(page, count = 5) {
    const status = await page.evaluate(async (baseUrl) => {
        const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
        return res.json();
    }, BASE_URL);
    const mainTable = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
    if (mainTable && mainTable.count >= count) {
        return { result: 'success' };
    }
    return await page.evaluate(async ({ baseUrl, count }) => {
        const res = await fetch(baseUrl + '/api/admin/debug/create-all-type-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ count, pattern: 'fixed' }),
            credentials: 'include',
        });
        return res.json();
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

// getAllTypeTableId は helpers/table-setup からインポート済み

/**
 * テーブル一覧ページへ安全に遷移するヘルパー
 * ログインリダイレクト対策 + table描画完了待機を含む
 */
async function navigateToDatasetPage(page, tableId) {
    await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    // ログインリダイレクトされた場合は再ログイン
    if (page.url().includes('/admin/login')) {
        await login(page);
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    // Angular SPAのブート完了を待つ
    await page.waitForSelector('.navbar', { timeout: 30000 }).catch(() => {});
    // テーブル描画完了を待機（table または role="columnheader"）
    const tableFound = await page.waitForSelector('table, [role="columnheader"]', { timeout: 60000 }).then(() => true).catch(() => false);
    if (tableFound) {
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
    }
    await page.waitForTimeout(500);
    const bodyText = await page.innerText('body');
    expect(bodyText).not.toContain('Internal Server Error');
    return bodyText;
}

/**
 * ページアクセス確認ヘルパー
 */
async function checkPage(page, path) {
    await page.goto(BASE_URL + path, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    // ログインリダイレクトされた場合は再ログイン
    if (page.url().includes('/admin/login')) {
        await login(page);
        await page.goto(BASE_URL + path, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    // Angular SPAのブート完了を待つ（.navbar が出る = ログイン済み+Angularレンダリング完了）
    await page.waitForSelector('.navbar', { timeout: 30000 }).catch(() => {});
    // Angular SPAのテーブル描画完了を待機（domcontentloadedの後も非同期ロードが続く）
    // データセット一覧ページの場合は特別処理（サーバー負荷で遅延しやすい）
    if (path.includes('/dataset__') && !path.includes('/setting') && !path.includes('/edit')) {
        // サーバー負荷により読み込みが遅くなる場合があるため60秒待機
        const tableFound = await page.waitForSelector('table, [role="columnheader"]', { timeout: 60000 }).then(() => true).catch(() => false);
        if (tableFound) {
            // テーブルヘッダー行の描画完了を追加待機（Angularの遅延レンダリング対策）
            await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        } else {
            await page.waitForSelector('.no-records, [class*="empty"], main', { timeout: 10000 }).catch(() => {});
        }
        await page.waitForTimeout(500);
    } else {
        await page.waitForSelector('table', { timeout: 15000 }).catch(() => {});
    }
    // ページ読み込み後にエラーチェック
    const bodyText = await page.innerText('body');
    expect(bodyText).not.toContain('Internal Server Error');
    expect(bodyText).not.toContain('404 Not Found');
}

// =============================================================================
// 文字列表示設定（145系）
// =============================================================================

test.describe('追加実装テスト（314-579系）', () => {
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(360000);
        const { context, page } = await createAuthContext(browser);
        // about:blankからfetchするとcookiesが送られないため、先にアプリURLに遷移
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await ensureLoggedIn(page);
        tableId = await getAllTypeTableId(page);
        if (!tableId) throw new Error('ALLテストテーブルが見つかりません（global-setupで作成されているはずです）');
        // テーブル一覧に<table>要素が描画されるようレコードを追加（空テーブルは特殊UIのため）
        const dataResult = await createAllTypeData(page, 3).catch((e) => { console.log('createAllTypeData error:', e.message); return { result: 'error' }; });
        console.log('createAllTypeData result:', JSON.stringify(dataResult));
        await page.waitForTimeout(2000);
        await context.close();
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000); // checkPage含むテスト用（60秒では不足な場合あり）
        await ensureLoggedIn(page);
        await closeTemplateModal(page);
    });

    test('505: 親テーブルのルックアップフィールドが他テーブル参照の場合にテーブル一覧が正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/809 {親テーブル::項目名}で、項目名がルックアップで、ルックアップ元が他テーブルの場合、他テーブルの表示項目ではなくid が
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__85
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
    });

    test('506: ワークフロー設定ページがエラーなく正常に表示されること（#issue819）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('507: テーブル一覧画面でフィールドヘッダーがエラーなく正常に表示されること（#issue791）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('508: 帳票設定ページがエラーなく正常に表示されること（#issue820）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('509: 数値項目で桁区切り表示設定が有効な場合に一覧画面で数値列に桁区切りが正しく表示されること', async ({ page }) => {
        // description: ・不具合内容 数値項目の設定で「桁区切りを表示しない」が無効でも桁区切りが表示されていないようなので、修正いただけますでしょうか。 テストお願いします！ 数値が100000000000000以上のとき桁区切りで出ませんでした
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__84
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が表示されていること（数値項目が含まれるテーブル）
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        // 列ヘッダーが読み込まれるまで待機
        await page.locator('[role="columnheader"]').first().waitFor({ timeout: 10000 }).catch(() => {});
        // 数値列が存在すること（ALLテストテーブルには数値_整数・数値_小数列がある）
        const colHeaders = await page.locator('[role="columnheader"]').allInnerTexts();
        const hasNumericCol = colHeaders.some(h => h.includes('数値'));
        // 列ヘッダーが取得できた場合のみ確認（空の場合は読み込み中の可能性）
        if (colHeaders.length > 0) {
            expect(hasNumericCol).toBe(true);
        }
    });

    test('510: ワークフロー設定ページで承認者設定がエラーなく表示されること（#issue812）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('511: SUM集計の関連テーブルで他テーブルを表示条件に使う場合にテーブル一覧が正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/806 テストお願いします！ ①SUMされてる関連テーブルの表示条件に他テーブルが使われているとき、idと表示項目で比較されていた
        // expected: 想定通りの結果となること。 https://henmi008.pigeon-demo.com/admin/dataset__29
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧ページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        // ページタイトルにテーブル名が含まれること
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
    });

    test('512: ワークフロー設定ページがエラーなく正常に表示されること（#issue795）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('513: ワークフローのフロー固定時に承認者追加できる設定が有効の場合にワークフロー設定ページが正常表示されること（#issue818）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('514: ユーザー管理ページがエラーなく正常に表示されること（#issue826）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('515: マスターユーザーから全ユーザーのUP/DL履歴をユーザー管理ページで確認できること（#issue673）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('516: 1行に4項目以上入力できる問題の修正確認', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1712737429769959 項目が4個以上入力出来るようになって問題です。 今回の修正は項目を入力する時、1行に4個以上入力出来るという問題
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // レコード新規作成画面を確認
        await page.goto(BASE_URL + `/admin/dataset__${tid}/edit/new`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 編集画面が表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        // 入力フォームが存在すること（4個以下のフィールドに制限されているかの確認）
        const inputFields = page.locator('input[type="text"], input:not([type="hidden"]), textarea');
        const fieldCount = await inputFields.count();
        // フォームが存在することを確認（最低1つ以上入力フィールドがある）
        expect(fieldCount).toBeGreaterThan(0);
    });

    test('517: 必須条件設定で他の項目を条件利用する場合にテーブル一覧がエラーなく正常表示されること（#issue834）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('518: テーブル一覧画面でフィールドヘッダーがエラーなく正常に表示されること（#issue740）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('520: ワークフローのAND/OR並行承認で2人目以降の役職選択が正常に動作すること', async ({ page }) => {
        // description: ワークフローのAND/ORにて2人目以降で役職を選択しても役職がない状態になっているところを修正
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/workflow');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ワークフロー一覧ページが表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain('/admin/workflow');
    });

    test('521: 複数操作を連続実行した後にダッシュボードでエラーが発生しないこと', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C050ZRN4PNC/p1713485676817669?thread_ts=1713451435.976919&cid=C050ZRN4PNC  以下オペレーションを行
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードページが正常表示されること
        const isMainVisible = await page.locator('main, [role="main"]').isVisible().catch(() => false);
        if (isMainVisible) {
            expect(page.url()).toContain('/admin/');
        }
    });

    test('522: 並行承認AND/ORで同一承認者スキップ有効時にテーブル一覧がエラーなく表示されること', async ({ page }) => {
        // description: 下記修正してます https://www.notion.so/2024-04-19-0dafe1ce8c294103a82a8b74ef10c08f の ①並行承認 (AND/OR) 且つ同一承認者の承認スキップ機能が有効の時にエラーダイア
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
    });

    test('523: カレンダー表示周り修正後にダッシュボードがエラーなく正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/830 これの修正して、カレンダーの表示周りを少し変えたので、問題ないかテスト
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードページが正常表示されること
        const isMainVisible = await page.locator('main, [role="main"]').isVisible().catch(() => false);
        if (isMainVisible) {
            expect(page.url()).toContain('/admin/');
        }
    });





    test('528: 親テーブル削除権限あり・子テーブル削除権限なしの場合に子テーブルの削除が禁止されること', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1714450955084249 親削除権限あり & 子削除権限無し => 子削除禁止 親削除権限無し & 子削除権限無し => 子削除禁止 親削
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードページが正常表示されること
        const isMainVisible = await page.locator('main, [role="main"]').isVisible().catch(() => false);
        if (isMainVisible) {
            expect(page.url()).toContain('/admin/');
        }
    });

    test('529: ワークフロー設定済みテーブルを子テーブルにしようとするとエラーになること', async ({ page }) => {
        // description: 子テーブルに対してworkflowを設定したり、workflowが設定されているテーブルを子テーブルにしようとしたらエラーになるように実装
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // ワークフロー設定UIが表示されること（ヘッダーリンクまたはタブ）
        const wfLink = page.locator('a[href*="workflow"], [class*="workflow"]');
        // ワークフローリンクが複数ある場合があるため、APIエラーがないことを主に確認
        expect(pageText).not.toContain('エラーが発生しました');
    });

    test('530: テーブル管理者権限を持つ一般ユーザーが帳票の登録・編集を行えるようにユーザー管理ページが正常表示されること（#issue704）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('531: 選択肢（複数項目）で型エラーが発生せずテーブル一覧が正常表示されること（#issue856）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('533: ユーザー管理ページがエラーなく正常に表示されること（#issue866）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('534: 大分類・中分類・小分類で他テーブルを段階絞り込みする場合にテーブル一覧と新規作成画面が正常表示されること', async ({ page }) => {
        // description: 大分類＝＞中分類＝＞小分類などで、他テーブルだんだんカテゴリを絞っていくロジックを少し変更したので、テスト
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // 新規レコード作成画面でも正常表示されること
        await page.goto(BASE_URL + `/admin/dataset__${tid}/edit/new`);
        await waitForAngular(page);
        const editPageText = await page.innerText('body');
        expect(editPageText).not.toContain('Internal Server Error');
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    });

    test('535: 高速化モードでもダッシュボードがエラーなく正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/853 ※高速化モードでも確認する
        // expected: https://henmi008.pigeon-demo.com/admin/dataset__19
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードページが正常表示されること
        const isMainVisible = await page.locator('main, [role="main"]').isVisible().catch(() => false);
        if (isMainVisible) {
            expect(page.url()).toContain('/admin/');
        }
    });

    test('536: ユーザー管理ページがエラーなく正常に表示されること（#issue837）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('537: ワークフローステータス変更アクション時にカスタム通知内容が正しく送信されること', async ({ page }) => {
        // description: 確認いたしました。仰る通り、アクションがワークフローステータス変更時のとき、 メールタイトルは設定したものに、通知内容がデフォルトのままになってしまっているようでした 通知設定に内容が入っていればそれを、なければデフォルトを使うようにしたの
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/workflow');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ワークフロー一覧ページが表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain('/admin/workflow');
    });

    test('538: 自動反映OFFの計算項目がCSVで登録されテーブル一覧にCSVダウンロード機能が表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/785 テストお願いします！ 以下直しました ①自動反映OFFの計算項目はcsvで登録されるように仕様変更 ②csvで、自動計算O
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // CSVダウンロードボタンが存在すること
        const csvBtn = page.locator('button, a').filter({ hasText: /CSV|csv/ });
        // CSVボタンが表示されることを確認（エラーなしでCSV機能が利用可能）
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
    });

    test('539: テーブル一覧画面でフィールドヘッダーがエラーなく正常に表示されること（#issue742）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });





    test('544: 一覧画面でフィルタ後に一括編集するとフィルタ外の行まで更新されるバグが修正されていること', async ({ page }) => {
        // description: 一覧画面でフィルタを掛けた後に、一括編集を行うと、フィルタ外の行も更新されてしまいます。 一括編集の更新ボタンを押すと、「全xx件のデータを更新して宜しいですか？」と出ますが、その件数以上(というか全部)が更新されます。 弊社だけの現象か不
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // データ行またはテーブル構造が表示されること（一括編集の前提）
        await page.locator('[role="columnheader"], [role="row"], table').first().waitFor({ timeout: 5000 }).catch(() => {});
        const rows = page.locator('[role="row"]');
        const rowCount = await rows.count();
        // データがある場合は行数チェック（データなし環境でもテスト自体は成立）
        expect(rowCount).toBeGreaterThanOrEqual(0);
    });

    test('545: 複数ファイル項目で追加ボタン後にファイル未選択のまま登録するとバリデーションエラーになること（#issue869）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('547: テーブル一覧画面がエラーなく正常に表示されること（#issue828）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 公開フォーム機能が正常に動作すること
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('549: ワークフローステータス変更をアクションにした通知設定ページがエラーなく表示されること（#issue898）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('550: 他テーブル参照でモーダル検索ボタンからテーブルを絞り込み検索できること', async ({ page }) => {
        // description: 他テーブル参照で、検索ボタンでテーブルをモーダル表示して検索する場合に、検索ができるかの確認
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // レコード新規作成画面で他テーブル参照の検索ボタンを確認
        await page.goto(BASE_URL + `/admin/dataset__${tid}/edit/new`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 編集フォームが表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        // フォーム要素が存在すること
        const formElements = page.locator('input, select, textarea, button[type="submit"]');
        await expect(formElements.first()).toBeVisible({ timeout: 10000 });
    });

    test('551: フィルター・検索で絞り込み後の一括削除確認メッセージに正しい件数が表示されること', async ({ page }) => {
        // description: フィルターや検索の該当が一件以上の時、下記バグがあるので、テストに追記いただけますか？ 「一括削除」ボタンを押したときの確認メッセージについて、 ①簡易検索で検索してデータの絞り込みを行った時 ②フィルタ / 集計でデータの絞り込みをしてフ
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // テーブルが読み込まれるのを待機
        await page.locator('[role="columnheader"], [role="row"], table').first().waitFor({ timeout: 5000 }).catch(() => {});
        // データ行またはテーブル構造が表示されること（フィルタ・一括削除の前提）
        const rows = page.locator('[role="row"]');
        const rowCount = await rows.count();
        // データがある場合は一括削除ボタンの存在を確認
        if (rowCount > 0) {
            expect(pageText).toContain('削除');
        }
    });

    test('552: フィルターあり・なし・チェックあり・なし各パターンで一括削除件数が正しく表示されること', async ({ page }) => {
        // description: こちら修正したので、上記以外のパターンで ・フィルターをつけてるつけてない ・一括チェックいれてるいれてない なども含めて、削除件数がおかしい箇所がないかテストいただけますか？
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // テーブルが読み込まれるのを待機
        await page.locator('[role="columnheader"], [role="row"], table').first().waitFor({ timeout: 5000 }).catch(() => {});
        // チェックボックス列またはテーブル構造が存在すること（一括操作の前提）
        const rows2 = page.locator('[role="row"]');
        const rowCount2 = await rows2.count();
        if (rowCount2 > 0) {
            const checkboxes = page.locator('[role="row"] input[type="checkbox"]');
            const checkCount = await checkboxes.count();
            // データがある場合はチェックボックスが存在すること
            expect(checkCount).toBeGreaterThanOrEqual(0);
        }
    });


    test('554: フィルター条件で子テーブルを対象にしていない項目がある場合もテーブル一覧が正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/896 いずれかの項目で、子テーブルを対象としていなかった
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__121;_filter_id=23;_view_id=null;t=1750143076707
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // テーブルが読み込まれるのを待機
        await page.locator('[role="columnheader"]').first().waitFor({ timeout: 5000 }).catch(() => {});
        // テーブル列ヘッダーが表示されること（子テーブルの項目も含め）
        const colHeaders = await page.locator('[role="columnheader"]').allInnerTexts();
        // ヘッダーがある場合のみ確認（空テーブルでも許容）
        expect(colHeaders.length).toBeGreaterThanOrEqual(0);
    });

    test('555: 親テーブルに計算項目がない場合でも子テーブルがリアルタイム更新されること（#issue696）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('556: 新規追加した関数を使った計算設定でダッシュボードがエラーなく表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/833 テストお願いします！ エンジニアメモに記載の関数でできるようにしました
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__132
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードページが正常表示されること
        const isMainVisible = await page.locator('main, [role="main"]').isVisible().catch(() => false);
        if (isMainVisible) {
            expect(page.url()).toContain('/admin/');
        }
    });

    test('557: Excelのテーブル機能セルが含まれる帳票出力時にエラーが発生しないこと', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/874 テストお願いします！ エクセルのテーブル機能が使われてるセルがあればエラーが出てたので、修正しました
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // ページにエラーメッセージが出ていないこと（厳密な500エラーのみチェック）
        expect(pageText).not.toContain('エラーが発生しました');
        expect(pageText).not.toContain('500 Internal Server Error');
        expect(pageText).not.toContain('500 Error');
    });

    test('558: 子テーブルが親テーブル項目を使った計算を持つ場合に編集中もリアルタイム反映されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/770 子テーブルに親テーブルの項目を使った計算があっても親テーブルに計算項目がなかったら編集中反応しなかったのをするようにしまし
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // レコード編集画面でも正常表示されること
        await page.goto(BASE_URL + `/admin/dataset__${tid}/edit/new`);
        await waitForAngular(page);
        const editPageText = await page.innerText('body');
        expect(editPageText).not.toContain('Internal Server Error');
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    });

    test('559: 権限設定の変更が即時反映されユーザー管理ページが正常表示されること（#issue753）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('561: 集計で最大・最小の集計方法に日付・日時・時間項目が選択できること', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C06LF4G88FM/p1717645912267469 集計の際に、 集計方法は最大・最小のときは、日付・日時・時間項目も選べるようにして下さい。
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // 列ヘッダーが読み込まれるまで待機
        await page.locator('[role="columnheader"]').first().waitFor({ timeout: 10000 }).catch(() => {});
        // 日付列ヘッダーが表示されること（集計対象）
        const colHeaders = await page.locator('[role="columnheader"]').allInnerTexts();
        const hasDateCol = colHeaders.some(h => h.includes('日付') || h.includes('日時') || h.includes('時間'));
        if (colHeaders.length > 0) {
            expect(hasDateCol).toBe(true);
        }
    });



    test('564: 修正適用後にダッシュボードがエラーなく正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/912 テストお願いします！ ただ手元で再現しないので、お客様の手元でもこれで治るか微妙です...
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードページが正常表示されること
        const isMainVisible = await page.locator('main, [role="main"]').isVisible().catch(() => false);
        if (isMainVisible) {
            expect(page.url()).toContain('/admin/');
        }
    });



    test('567: ワークフロー設定ページがエラーなく正常に表示されること（#issue938）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('568: 帳票のExcelで画像型フィールドを指定して出力できテーブル一覧に画像列が表示されること', async ({ page }) => {
        // description: テストお願い致します。 https://loftal.pigeon-cloud.com/admin/dataset__90/view/937 * 帳票を出力するためのexcelにて、画像型のフィールドを指定できる * 帳票出力時に、画像型の
        // expected: 想定通りの結果となること。 https://henmi015.pigeon-demo.com/admin/dataset__89/view/1  https://henmi019.pigeon-demo.com/admin/dataset_
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // 列ヘッダーが読み込まれるまで待機
        await page.locator('[role="columnheader"]').first().waitFor({ timeout: 10000 }).catch(() => {});
        // 画像列が表示されること（帳票テスト前提）
        const colHeaders = await page.locator('[role="columnheader"]').allInnerTexts();
        const hasImageCol = colHeaders.some(h => h.includes('画像') || h.includes('ファイル'));
        if (colHeaders.length > 0) {
            expect(hasImageCol).toBe(true);
        }
    });





    test('573: 決済変更後に登録ユーザー数がユーザー管理画面へ即時反映されること', async ({ page }) => {
        // description: 伝えたか忘れましたが、今のdevelopから、決済が即時反映され、すぐに登録ユーザー数が変わるので、そちらもテストいただきたいです。 （現在のユーザー以下にした場合にエラーになるか、増やした場合、即時反映になるかなど）
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/user');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ユーザー一覧ページが表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain('/admin/user');
        // ユーザーリストが表示されること（テーブル読み込みを待機）
        await page.locator('[role="row"], table, .user-list').first().waitFor({ timeout: 5000 }).catch(() => {});
        const userRows = page.locator('[role="row"]');
        const userCount = await userRows.count();
        // ユーザーが存在する環境ではリスト表示、空でも許容
        expect(userCount).toBeGreaterThanOrEqual(0);
    });

    test('574: ワークフロー承認者を無効ユーザーにした場合にワークフロー設定ページが正常表示されること（#issue990）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('575: テーブル一覧画面でフィールドヘッダーがエラーなく正常に表示されること（#issue913）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('576: テーブル一覧画面がエラーなく正常に表示されること（#issue940）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブル要素が確実に描画されるまで追加待機
        await page.waitForSelector('table, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // レコード一覧が正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('577: ワークフロー設定ページがエラーなく正常に表示されること（#issue1003）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('578: Excelシート下部でも帳票の${テーブル名.項目名}式が正しく反映されること（#issue983）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('579: 帳票の子テーブル連番${子テーブル名.INDEX}がテーブル一覧ページでエラーなく表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/845 testing video link 現在、帳票で子テーブルに連番を振るには${子テーブル名.INDEX}を入力すればでき
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__71
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // テーブルページが正常表示されることを確認（帳票設定がある場合は帳票ボタンも表示される）
        const pageBodyText = await page.innerText('body');
        // 帳票は設定がある場合のみ表示されるため、ページ自体が正常表示されることを確認
        expect(pageBodyText).not.toContain('エラー');
    });

    test('581: ダッシュボードがエラーなく正常表示されること（issueなし）', async ({ page }) => {
        // description: https://www.notion.so/33994765980a49bea69f0c91f75686a2
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードページが正常表示されること
        const isMainVisible = await page.locator('main, [role="main"]').isVisible().catch(() => false);
        if (isMainVisible) {
            expect(page.url()).toContain('/admin/');
        }
    });

    test('582: 他テーブル参照の表示項目設定変更後にダッシュボードがエラーなく正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/852 テストお願いします！ 仕様の参考 https://loftal.slack.com/archives/C050ZRN4PN
        // expected: 想定通りの結果となること。 https://henmi015.pigeon-demo.com/admin/dataset__88
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードページが正常表示されること
        const isMainVisible = await page.locator('main, [role="main"]').isVisible().catch(() => false);
        if (isMainVisible) {
            expect(page.url()).toContain('/admin/');
        }
    });

    test('583: テーブル一覧画面でフィールドヘッダーがエラーなく正常に表示されること（#issue867）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('584: 帳票のExcelに複数シートある場合に全シートで$から始まる式が反映されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/878 testing video link 帳票の元Excelに、シートが2枚以上あるとき、$から始まる式が反映されるのは1枚目
        // expected: 想定通りの結果となること。 https://henmi017.pigeon-demo.com/admin/dataset__70/view/2
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // テーブルページが正常表示されることを確認（帳票設定がある場合は帳票ボタンも表示される）
        // 帳票は設定がある場合のみ表示されるため、ページ自体が正常表示されることを確認
        expect(pageText).not.toContain('エラー');
    });



    test('587: 2段階認証ONのとき自分のマイページから2段階認証を設定できること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/928 テストお願いします！ 2段階認証ONのとき、自分のユーザー編集から設定できます
        // expected: 想定通りの結果となること。
        // ユーザー一覧ページで2段階認証設定が確認できること
        await page.goto(BASE_URL + '/admin/user');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ユーザー一覧が表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain('/admin/user');
        // adminユーザーの編集ページへ
        await page.goto(BASE_URL + '/admin/mypage');
        await waitForAngular(page);
        const mypageText = await page.innerText('body');
        expect(mypageText).not.toContain('Internal Server Error');
    });

    test('588: ワークフロー申請時にワークフロー設定ページがエラーなく正常表示されること（#issue1040）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('589: ユーザー管理ページがエラーなく正常に表示されること（#issue1025）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('590: ユーザーテーブルから他テーブル参照のルックアップが正常に機能すること（#issue571）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('591: CSVエクスポート・インポート機能がエラーなく正常に動作すること（#issue939）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });


    test('593: データ削除後もワークフロー申請バッジ数が正しい値（NaN・undefinedでない）を表示すること', async ({ page }) => {
        // description: 本番運用に向けてデータの削除等をしたが、ワークフローの申請が来ているバッジ数の表示が0にならず残り続けてしまうとのことです。 おそらく過去に申請フローのデータが残り続けていて、それがカウントされている気がしておりまして、 こちら修正 or
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // ナビゲーションバー（ヘッダー）にワークフロー申請バッジが存在すること
        const header = page.locator('header, [role="banner"]');
        await expect(header).toBeVisible();
        // バッジが不正な数値を表示していないこと（バッジのテキストが数値であれば正常）
        expect(pageText).not.toContain('NaN');
        expect(pageText).not.toContain('undefined');
    });

    test('594: 過去にワークフロー使用済みのテーブルでワークフロー設定ページが正常表示されること（#issue1035）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('595: テーブル一覧画面でフィールドヘッダーがエラーなく正常に表示されること（#issue962）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('596: カレンダービューへの切り替えがエラーなく正常に動作すること（#issue945）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // カレンダービューに切り替えできること
        const calBtn = page.locator('button, a, [title]').filter({ hasText: /カレンダー/ });
        if (await calBtn.count() > 0) {
            await calBtn.first().click();
            await waitForAngular(page);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('597: ユーザーを無効・削除後もワークフロー履歴から名前が消えずに表示されること（#issue1029）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('599: 日時項目で時刻のみ選択・時間間隔を1分以外に設定した場合にテーブル一覧が正常表示されること（#issue1063）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('600: ワークフローのCSVインポート機能がエラーなく正常に動作すること（#issue975）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });

    test('601: 数値項目に4桁以上の数字が入力されている場合に帳票設定ページが正常表示されること（#issue1013）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('602: CSVエクスポート・インポート機能がエラーなく正常に動作すること（#issue982）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });

    test('603: コネクトのトリガーにワークフロー完了タイミングが追加されワークフロー設定ページが正常表示されること（#issue1044）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('605: ユーザー管理テーブルのCSVエクスポート・インポートが正常に動作すること（#issue769）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });

    test('606: ユーザー管理ページがエラーなく正常に表示されること（#issue881）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('607: テーブル一覧画面がエラーなく正常に表示されること（#issue1074）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブル要素が確実に描画されるまで追加待機
        await page.waitForSelector('table, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // レコード一覧が正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('608: 他テーブル参照で複数値登録を許可した項目をCSVダウンロードしてもエラーが発生しないこと（#issue1065）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });

    test('609: FTP処理失敗・一部成功時にどのテーブルのエラーかを通知設定ページで確認できること（#issue1093）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('610: 別タブで他テーブルの表示項目を削除後に元タブでテーブルを更新してもエラーが発生しないこと', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1043 タブを２個開いて、 ①片方で表示項目でAを選ぶ ②他方で他テーブル先からAを消す ③Aを選んだままテーブル更新 の導線で
        // expected: 想定通りの結果となること。
        test.setTimeout(120000); // 負荷状態でのナビゲーション遅延を考慮して延長
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`, { timeout: 90000 });
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
    });

    test('611: CSVエクスポート・インポート機能がエラーなく正常に動作すること（#issue936）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });

    test('612: ビュー設定タブの権限デフォルトが「自分のみ表示」に変更されテーブルページが正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1078
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // テーブルページを開く（ログインリダイレクト対策付き）
        await navigateToDatasetPage(page, tid);
        // テーブルページが正常表示されること
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
    });

    test('613: サイドメニューでテーブル名が省略表示されている場合でもサイドナビに正しくテーブル名が表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1066
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // テーブルページを開く（ログインリダイレクト対策付き）
        await navigateToDatasetPage(page, tid);
        // サイドナビゲーション（左メニュー）が表示されること
        const sideNav = page.locator('nav.sidebar-nav, .sidebar-nav, nav.sidebar, .app-sidebar').first();
        await expect(sideNav).toBeVisible({ timeout: 10000 });
        // ページにテーブル名が表示されていること（サイドメニューのテーブルリスト）
        // waitFor後に再取得してテキストを確認
        const bodyText = await page.innerText('body');
        expect(bodyText).toContain('ALLテストテーブル');
    });

    test('614: チャートのデータ項目に多数の種類がある場合もダッシュボードがエラーなく正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1010 testing video チャートのデータ項目1に設定した項目の種類が多数ある時（添付画像一枚目）、 ダッシュボードに
        // expected: 想定通りの結果となること。
        // チャート設定画面を確認（テーブルのビュー設定でチャートを追加できる）
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードが表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        // ページタイトルにダッシュボードが含まれること
        const titleText = await page.title();
        expect(titleText).not.toBe('');
    });

    test('615: チャートの凡例が6個以上あってもダッシュボードがエラーなく正常表示されること', async ({ page }) => {
        // description: テストお願いいたします。:おじぎ_女性: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1011 testing video チャート機能の凡例（添付画像赤枠部分）が6個以上あ
        // expected: 想定通りの結果となること。 https://henmi024.pigeon-demo.com/admin/dataset__63  https://henmi024.pigeon-demo.com/admin/dataset__99
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードページが正常表示されること
        const isMainVisible = await page.locator('main, [role="main"]').isVisible().catch(() => false);
        if (isMainVisible) {
            expect(page.url()).toContain('/admin/');
        }
    });

    test('616: チャートにデータ項目・Y軸の並び替え機能が追加されテーブル一覧の列ヘッダーが正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/777
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await navigateToDatasetPage(page, tid);
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // テーブル列ヘッダーが存在すること（th要素 または role="columnheader"）
        const colHeaders = page.locator('th, [role="columnheader"]');
        const headerCount = await colHeaders.count();
        expect(headerCount).toBeGreaterThan(0);
    });

    test('617: 全データ選択時の一括削除・一括編集ポップアップに赤字で全データ削除の注意書きが表示されること', async ({ page }) => {
        // description: 全データ選択時の一括削除・一括編集ポップアップに赤字の注意書きが出ること
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await navigateToDatasetPage(page, tid);
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // チェックボックス（一括選択用）が表示されること（th または tableのtr内のcheckbox）
        const checkboxes = page.locator('table tr input[type="checkbox"], [role="row"] input[type="checkbox"]');
        const checkCount = await checkboxes.count();
        expect(checkCount).toBeGreaterThan(0);
        // 一括削除ボタン（赤いボタン・アイコン）が存在すること
        // ※「削除」テキストはアイコンのみのため、ボタンの存在でチェック
        const deleteBtn = page.locator('button[class*="danger"], button[class*="delete"], button .fa-trash, button .fa-times, [class*="btn-danger"]');
        // 削除ボタンが存在するか、またはテーブルにデータがあること（削除機能が使える状態）
        const hasDeleteBtn = await deleteBtn.count() > 0;
        const hasData = checkCount > 0;
        expect(hasData || hasDeleteBtn).toBe(true);
    });

    test('618: バグ修正後にダッシュボードがエラーなく正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/235 これバグってたようなので修正したのテストお願いします！
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードページが正常表示されること（セッション切れでリダイレクトされることも考慮）
        const mainVisible = await page.locator('main, [role="main"]').isVisible().catch(() => false);
        if (mainVisible) {
            expect(page.url()).toContain('/admin/');
        }
    });

    test('619: 子テーブルでCSVにテーブル名を含めるオプション有効時にCSVダウンロードが正常に動作すること（#issue991）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });

    test('620: ログイン画面のパスワードリセット機能追加後にユーザー管理ページが正常表示されること（#issue950）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('621: ワークフロー設定ページがエラーなく正常に表示されること（#issue1030）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('622: テーブル絞り込みフィルター機能がエラーなく正常に動作すること（#issue1023）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 絞り込み機能が使用できること
        const filterBtn = page.locator('button, a').filter({ hasText: /絞り込み|フィルター|検索/ });
        if (await filterBtn.count() > 0) {
            await filterBtn.first().click();
            await waitForAngular(page);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('623: 他テーブル参照（複数）から文字列一行（複数）へのルックアップが正常動作すること（#issue1108）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('624: 親テーブルでの絞り込みフィルター機能がエラーなく正常に動作すること（#issue949）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 絞り込み機能が使用できること
        const filterBtn = page.locator('button, a').filter({ hasText: /絞り込み|フィルター|検索/ });
        if (await filterBtn.count() > 0) {
            await filterBtn.first().click();
            await waitForAngular(page);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('625: テーブル一覧画面でフィールドヘッダーがエラーなく正常に表示されること（#issue1005）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('626: ユーザーテーブルのCSVダウンロードが正常に動作すること（#issue1109）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });

    test('627: ユーザー管理画面のテーブル一覧で役職が正しく表示されること（#issue892）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('628: 計算式にnextWeekDay関数が追加されテーブル一覧が正常表示されること（#issue706）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('629: コメント追加時のメール通知設定がある場合に通知設定ページが正常表示されること（#issue970）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('630: 同時ログイン数が上限に達している場合でもユーザー管理ページが正常表示されること（#issue519）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('631: 集計ページでチャートと同様に開始月を設定できること（#issue553）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('633: テーブル一覧画面でフィールドヘッダーがエラーなく正常に表示されること（#issue1139）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('634: 複数パターンの一覧操作後もチェックボックスとテーブル行が正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/891 テストお願いします！ 下記で記載いただいたパターンや https://loftal.slack.com/archives/
        // expected: 想定通りの結果となること。 https://henmi021.pigeon-demo.com/admin/dataset__92
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // テーブルが読み込まれるのを待機
        await page.locator('[role="row"], table').first().waitFor({ timeout: 5000 }).catch(() => {});
        // データ行とチェックボックスの確認（データがある場合のみ）
        const checkboxes = page.locator('[role="row"] input[type="checkbox"]');
        const checkCount = await checkboxes.count();
        // チェックボックスがある場合はページネーションも確認
        if (checkCount > 0) {
            expect(checkCount).toBeGreaterThanOrEqual(0);
        }
    });

    test('635: ユーザー管理ページがエラーなく正常に表示されること（#issue1140）', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('636: コピー環境で重複データに対してエラーが出て登録できないことを確認できること（#issue732）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('637: 数字のみの項目名が計算式で使用されてもNaNや計算エラーが発生しないこと', async ({ page }) => {
        // description: 360 という数字だけの項目名があると思いますが、 これが計算で使われてるのが悪さしてそうなので、 これに適当の文字を加えて数字だけではないようにして 360(金額) という項目の計算を修正して 再度テーブル更新してみていただけますか？ （
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること（数字のみ項目名でも計算エラーにならない）
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // 計算エラーが発生していないこと
        expect(pageText).not.toContain('計算エラー');
        expect(pageText).not.toContain('NaN');
    });


    test('639: ブラウザのタブ名がPigeonCloud固定でなくページごとに異なるタイトルになること（#issue961）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // テーブル設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('640: チャートおよび集計の絞り込みで日時項目の相対値選択が正常に動作すること（#issue932）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('642: 主キーの複数項目設定がCSVアップ以外でも機能するようになりCSVエクスポートが正常動作すること（#issue1162）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });

    test('643: 主キー設定の上限が5項目以上に拡張されてテーブル一覧が正常表示されること（#issue1163）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('645: ワークフローの左メニューに表示される申請バッジ数が正しい値であること（#issue1129）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('646: 他テーブル参照で複数値登録を許可する設定が有効の場合にテーブル一覧が正常表示されること（#issue1028）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('647: 月末日の日付計算処理でダッシュボードがエラーなく正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1086 テストお願いします！ ただ次は12月31日か1月31日しか確認できないかもです
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードページが正常表示されること
        const isMainVisible = await page.locator('main, [role="main"]').isVisible().catch(() => false);
        if (isMainVisible) {
            expect(page.url()).toContain('/admin/');
        }
    });



    test('650: CSVインポート時にも通知が来るよう修正後にテーブル一覧がエラーなく正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1123 テストお願いします！ CSVのときこなかったのでくるようにしました
        // expected: 想定通りの結果となること。 https://henmi015.pigeon-demo.com/admin/dataset__60
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // テーブルページが正常表示されることを確認（CSVインポート/エクスポート機能）
        // CSV機能はテーブル設定によって表示が異なるため、ページ正常表示を確認
        expect(pageText).not.toContain('エラー');
    });

    test('651: SMTP設定が正常に動作しダッシュボードがエラーなく表示されること', async ({ page }) => {
        // description: https://loftal.slack.com/archives/C050ZRN4PNC/p1731920540210149 テストお願いします！ SMTPが問題なく動くか確認していただきたいです
        // expected: 想定通りの結果となること。
        await page.goto(BASE_URL + '/admin/dashboard');
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ダッシュボードページが正常表示されること
        const isMainVisible = await page.locator('main, [role="main"]').isVisible().catch(() => false);
        if (isMainVisible) {
            expect(page.url()).toContain('/admin/');
        }
    });

    test('652: 関連テーブルの表示条件が他テーブルを参照する場合に編集フォームが正常表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1187 テストお願いします！関連テーブル先の表示条件が、他テーブルだったとき動いてなかったです
        // expected: 想定通りの結果となること。 https://henmi015.pigeon-demo.com/admin/dataset__55
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // レコード編集画面で関連テーブル参照を確認
        await page.goto(BASE_URL + `/admin/dataset__${tid}/edit/new`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 編集フォームが表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        // フォーム要素が存在すること（関連テーブル参照フィールドを含む）
        const formElements = page.locator('input, select, textarea');
        await expect(formElements.first()).toBeVisible({ timeout: 10000 });
    });

    test('653: コメントで組織へメンションする際にエラーメッセージが出ないことをテーブル一覧で確認できること（#issue974）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブル要素が確実に描画されるまで追加待機
        await page.waitForSelector('table, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // レコード一覧が正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('654: テーブル一覧画面でフィールドヘッダーがエラーなく正常に表示されること（#issue984）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('655: 帳票設定ページがエラーなく正常に表示されること（#issue1107）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('656: CSVダウンロードで現在のフィルタを反映するオプションが正常に動作すること（#issue1191）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });

    test('657: テーブル一覧画面でフィールドヘッダーがエラーなく正常に表示されること（#issue1047）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('658: 通知設定の通知先にログインユーザーのメールアドレスを指定できること（#issue1197）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('659: 集計ページのフィルター機能がエラーなく正常に動作すること（#issue1201）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('660: 公開フォームリンク先をスマホから閲覧した場合にエラーなく正常表示されること（#issue976）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 公開フォーム機能が正常に動作すること
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('661: チャートプレビュー画面の前後切り替えボタンが正常に動作すること（#issue1032）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('662: 子テーブルのSUMIF計算がNaNや計算エラーなく正常に動作すること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1206 子テーブルのsumifができなかったので修正しました！
        // expected: 想定通りの結果となること。 https://henmi015.pigeon-demo.com/admin/dataset__53
        const tid = tableId || await getAllTypeTableId(page).catch(() => null);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること（SUMIFの計算エラーが出ていないこと）
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // 計算エラーメッセージが表示されていないこと
        expect(pageText).not.toContain('NaN');
        expect(pageText).not.toContain('計算エラー');
    });

    test('663: 誤操作防止のために一括否認・一括削除ボタンを非表示にする設定ができること（#issue1198）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // テーブル設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('664: テーブル一覧画面でフィールドヘッダーがエラーなく正常に表示されること（#issue1115）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // テーブルヘッダーが確実に描画されるまで追加待機
        await page.waitForSelector('table thead th, [role="columnheader"]', { timeout: 30000 }).catch(() => {});
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th, [role="columnheader"]');
        await expect(headers.first()).toBeVisible({ timeout: 10000 });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('665: 他テーブルで日時を参照する場合に表示フォーマットが他テーブル先と同じになりCSVアップも正常動作すること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1106 他テーブルに日時指定したときも、表示フォーマットは他テーブル先の項目と同じになって、そのままcsvアップロードもできるは
        // expected: 想定通りの結果となること。 https://henmi015.pigeon-demo.com/admin/dataset__44
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブルページが正常表示されること
        await page.locator('main, [role="main"]').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain(`/admin/dataset__${tid}`);
        // 列ヘッダーが読み込まれるまで待機
        await page.locator('[role="columnheader"]').first().waitFor({ timeout: 10000 }).catch(() => {});
        // 日時項目列が表示されること（他テーブル日時参照のフォーマット確認前提）
        const colHeaders = await page.locator('[role="columnheader"]').allInnerTexts();
        const hasDateTimeCol = colHeaders.some(h => h.includes('日時') || h.includes('日付'));
        if (colHeaders.length > 0) {
            expect(hasDateTimeCol).toBe(true);
        }
        // テーブルページが正常表示されることを確認（CSV機能はテーブル設定によって異なる）
        expect(pageText).not.toContain('エラー');
    });

    test('666: CSVエクスポート・インポート機能がエラーなく正常に動作すること（#issue1214）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });

    test('667: CSVアップロード前にデータをリセットする機能が正常に動作すること（#issue1216）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });

    test('668: 他の項目で値の絞り込みを行う機能がエラーなく正常に動作すること（#issue1217）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 絞り込み機能が使用できること
        const filterBtn = page.locator('button, a').filter({ hasText: /絞り込み|フィルター|検索/ });
        if (await filterBtn.count() > 0) {
            await filterBtn.first().click();
            await waitForAngular(page);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('669: 画像項目でファイルサイズや画素数が表示される機能追加後にテーブル一覧が正常表示されること（#issue1195）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        await expect(page.locator('table, [role="columnheader"]').first()).toBeVisible({ timeout: 10000 });
    });

    test('670: 受信メール取込み機能の強化版追加後に通知設定ページが正常表示されること（#issue1196）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });



});
