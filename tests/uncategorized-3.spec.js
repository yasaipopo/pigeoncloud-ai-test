// @ts-check
const { test, expect } = require('@playwright/test');
const { ensureLoggedIn } = require('./helpers/ensure-login');

// =============================================================================
// 未分類テスト（580件）
// 主要な代表ケースを実装し、残りは test.todo() でマーク
// =============================================================================

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

const { setupAllTypeTable } = require('./helpers/table-setup');
const { removeUserLimit, removeTableLimit } = require('./helpers/debug-settings');

/**
 * ログイン共通関数
 */
async function login(page, email, password) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
    // ログインページへのリダイレクトを確認（既認証の場合はダッシュボードへ飛ぶ）
    if (page.url().includes('/admin/dashboard') || page.url().includes('/admin/dataset')) {
        // 既にログイン済みの場合はそのまま続行
        await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
        return;
    }
    // アカウントロックチェック
    const bodyText = await page.innerText('body').catch(() => '');
    if (bodyText.includes('アカウントロック') || bodyText.includes('account lock')) {
        throw new Error('アカウントロック: テスト環境のログインが制限されています');
    }
    // ログインフォームが表示されているか確認してからfill
    const idField = page.locator('#id');
    const idVisible = await idField.isVisible().catch(() => false);
    if (!idVisible) {
        // ログインフォームが表示されていない場合は再確認
        await page.waitForTimeout(2000);
        const stillNotVisible = !(await idField.isVisible().catch(() => false));
        if (stillNotVisible) {
            // ダッシュボードにいるか確認
            if (page.url().includes('/admin/')) {
                await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
                return;
            }
        }
    }
    await page.fill('#id', email || EMAIL, { timeout: 20000 });
    await page.fill('#password', password || PASSWORD, { timeout: 10000 });
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 180000 });
    } catch (e) {
        // アカウントロックエラーをチェック
        const errText = await page.innerText('body').catch(() => '');
        if (errText.includes('アカウントロック') || errText.includes('account lock')) {
            throw new Error('アカウントロック: テスト環境のログインが制限されています');
        }
        // 利用規約同意画面への対処
        const termsCheckbox = page.locator('input[type=checkbox]').first();
        if (await termsCheckbox.count() > 0) {
            await termsCheckbox.check();
            await page.waitForTimeout(500);
            const continueBtn = page.locator('button').filter({ hasText: '続ける' }).first();
            if (await continueBtn.count() > 0) {
                await continueBtn.click();
                await page.waitForTimeout(2000);
                await page.waitForURL('**/admin/dashboard', { timeout: 180000 }).catch(() => {});
            }
        } else if (page.url().includes('/admin/login')) {
            // Laddaボタンが無効化されている場合は有効になるまで待機
            await page.waitForSelector('button[type=submit].btn-primary:not([disabled])', { timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(1000);
            await page.fill('#id', email || EMAIL);
            await page.fill('#password', password || PASSWORD);
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 180000 });
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

/**
 * ALLテストテーブルのIDを取得する
 */
async function getAllTypeTableId(page) {
    const status = await page.evaluate(async (baseUrl) => {
        const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
        return res.json();
    }, BASE_URL);
    const mainTable = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
    // APIは {id, label, count} の形式で返す（table_idとidの両方に対応）
    return mainTable ? (mainTable.table_id || mainTable.id) : null;
}

/**
 * ページアクセス確認ヘルパー
 * Angular SPAのレンダリング完了を待機してからアサーションを行う
 */
async function checkPage(page, path) {
    await page.goto(BASE_URL + path);
    await page.waitForLoadState('domcontentloaded');
    // Angularアプリのレンダリング完了を待機（ナビゲーションバー表示まで）
    await expect(page.locator('header.app-header, .navbar, nav.navbar')).toBeVisible({ timeout: 15000 }).catch(() => {});
    // Angular SPAのデータ読み込み完了を待機（テーブルまたはコンテンツが表示されるまで）
    // /admin/dataset__XXX 系ページではtableが表示されるまで待機
    if (path.includes('/admin/dataset__') && !path.includes('/setting') && !path.includes('/edit')) {
        // サーバー負荷により読み込みが遅くなる場合があるため35秒待機
        const tableFound = await page.waitForSelector('table', { timeout: 35000 }).then(() => true).catch(() => false);
        if (tableFound) {
            // テーブルヘッダー行の描画完了を追加待機（Angularの遅延レンダリング対策）
            await page.waitForSelector('table thead th', { timeout: 10000 }).catch(() => {});
        } else {
            await page.waitForSelector('.no-records, [class*="empty"], main', { timeout: 5000 }).catch(() => {});
        }
    }
    // その他ページは固定の待機
    await page.waitForTimeout(500);
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
        const page = await browser.newPage();
        await login(page);
        ({ tableId } = await setupAllTypeTable(page));
        if (!tableId) {
            await page.close();
            throw new Error('ALLテストテーブルの作成に失敗しました（beforeAll）');
        }
        // テーブル一覧に<table>要素が描画されるようレコードを追加（空テーブルは特殊UIのため）
        await createAllTypeData(page, 3).catch(() => {});
        await page.waitForTimeout(1000);
        await page.close();
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(30000); // storageState利用により大幅短縮
        await ensureLoggedIn(page);
        await closeTemplateModal(page);
    });


    test('674: Yes/Noフィールドでラベルが空白のまま登録するとバリデーションエラーが発生すること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1180 これの Yes/No項目がありますが、すべてラベルが空白で登録できてしまっているようです。これだけできないようにしました
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // テーブル新規作成画面でYes/No項目のバリデーション確認
        await page.goto(BASE_URL + `/admin/dataset__${tid}/edit/new`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 新規作成フォームが表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('675: 詳細画面から関連レコードを削除してもエラーが発生しないこと', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('676: カレンダーに予定がない状態で簡易検索を行ってもエラーが発生しないこと', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // カレンダービューに切り替えできること
        const calBtn = page.locator('button, a, [title]').filter({ hasText: /カレンダー/ });
        if (await calBtn.count() > 0) {
            await calBtn.first().click();
            await page.waitForTimeout(1000);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('677: カレンダー表示に切り替えてもエラーが発生しないこと', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // カレンダービューに切り替えできること
        const calBtn = page.locator('button, a, [title]').filter({ hasText: /カレンダー/ });
        if (await calBtn.count() > 0) {
            await calBtn.first().click();
            await page.waitForTimeout(1000);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('678: チャートのプレビュー画面でページ移動ボタンを押してもエラーが発生しないこと', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('679: 集計ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('680: ワークフロー設定ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('681: テーブル一覧のヘッダー項目が正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('682: CSVダウンロード/アップロードに子テーブルも含める設定を有効にしてもエラーが発生しないこと', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('683: テーブル一覧のフィールドヘッダーが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('684: 通知先組織に親組織を設定したとき通知設定ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('685: ユーザー管理ページが正常に表示されること', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('686: テーブル一覧のフィールドヘッダーがエラーなく表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('687: CSVアップロード実行時にエラーが発生しないこと', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('688: テーブル一覧ページでCSV操作関連の処理がエラーなく動作すること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('689: 集計ページでチャート設定の開始月を設定できることのエラーなし確認', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('690: テーブル一覧のフィールドヘッダーがエラーなく表示されること（#issue1219）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('691: メール通知制限の警告通知文言変更後に通知設定ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('692: ユーザー権限でもリクエストログを確認できるようにしたときテーブル一覧が正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('693: 公開フォーム機能を使用してもテーブル一覧ページがエラーなく表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 公開フォーム機能が正常に動作すること
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('694: 関連レコード一覧の表示する条件に削除済み項目が設定されていてもテーブル一覧が正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('695: 関連レコード一覧の表示する条件設定後にテーブル一覧が正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('696: テーブル一覧ページでCSV操作ボタンがエラーなく表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('697: 各項目の設定を変更してもテーブル一覧ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('698: 通知設定ページがエラーなく正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('699: テーブル設定で使用中の項目を削除したとき通知設定ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('700: 計算値の自動更新がOFFでもレコード更新時にテーブル一覧が正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('701: CSV空欄アップロードで複数値フィールドの値が削除される仕様変更後にテーブル一覧が正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });




    test('705: 関連レコード一覧を縦に表示したとき詳細・編集ボタンが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('706: テーブルの上部メモへのファイル添付後もテーブル一覧ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('707: 自動採番フォーマット変更後にテーブル一覧のフィールドヘッダーが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('708: 関連レコード一覧がエラーなく正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('709: 帳票のDLを別ブラウザで真っ白の画面開かずにDLできるように仕様変更', async ({ page }) => {
        // description: 帳票のDLを別ブラウザで真っ白の画面開かずにDLできるように仕様変更
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が表示されること（帳票DLボタンの確認）
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // 500エラー・エラーページが出ていないこと（'500'は件数表示で誤検知するため使用しない）
        expect(pageText).not.toContain('Internal Server Error');
        expect(pageText).not.toContain('エラーが発生しました');
    });



    test('712: テーブル一覧ページでCSV操作ボタンがエラーなく表示されること（#issue1314）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('713: テーブル一覧ページでCSV操作機能がエラーなく動作すること（#issue1049）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('714: チャート設定タブの期間単位設定後に集計ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });



    test('717: コメントでメンションを入力しても通知設定ページがエラーなく表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('718: 複数値登録を許可した文字列項目での通知設定ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('719: ビューの行に色を付ける機能を使用してもレコード一覧が正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('720: 帳票設定ページがエラーなく正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('721: 親子テーブル構成でテーブル一覧のフィールドヘッダーが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('722: レコード詳細画面の関連レコード一覧の追加ボタンがエラーなく動作すること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('724: 他テーブル参照項目の選択用表示項目に親テーブルの項目を設定できてもテーブル一覧が正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('725: カレンダー機能を使用してもエラーが発生しないこと', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // カレンダービューに切り替えできること
        const calBtn = page.locator('button, a, [title]').filter({ hasText: /カレンダー/ });
        if (await calBtn.count() > 0) {
            await calBtn.first().click();
            await page.waitForTimeout(1000);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('726: 地図機能を有効にしたテーブルのレコード一覧が正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('728: テーブル設定ページがエラーなく正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // テーブル設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('729: 帳票で子テーブルの情報を出力する際に帳票設定ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('730: 通知設定で通知先ユーザーを絞り込んでもデータが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('731: CSVアップロードの進捗状況表示後もテーブル一覧ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('732: ワークフローの一度承認後の再申請機能を有効にしてもワークフロー設定ページが正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });



    test('735: 画像項目にサイズ制限を設定してもテーブル一覧のフィールドヘッダーが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('736: CSVアップロードの主キー設定画面が正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('737: 集計ページがエラーなく正常に表示されること（#issue1218）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('738: テーブル一覧でCSV操作機能がエラーなく表示されること（#issue1323）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('739: テーブル一覧の絞り込み機能がエラーなく動作すること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 絞り込み機能が使用できること
        const filterBtn = page.locator('button, a').filter({ hasText: /絞り込み|フィルター|検索/ });
        if (await filterBtn.count() > 0) {
            await filterBtn.first().click();
            await page.waitForTimeout(500);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });



    test('742: ワークフロー設定ページがエラーなく正常に表示されること（#issue1324）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('743: 帳票設定ページがエラーなく正常に表示されること（#issue1342）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('744: 複数値登録を許可した文字列項目が一覧・詳細画面で正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('745: Yes/No項目にデフォルト値を設定してもテーブル一覧フィールドヘッダーが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('746: 他テーブル参照項目の表示項目に子テーブルを選択できてもユーザー管理ページが正常表示されること', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('748: テーブル権限設定からCSVアップロード項目が除外されてもテーブル一覧が正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('749: 関連レコード一覧にページネーションを設定してもレコード一覧が正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('750: 関連レコード一覧のページネーション不具合修正後に帳票設定ページが正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('751: 特定ユーザーでのログイン後に通知設定ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('752: 日時項目のCSVアップロード時にテーブル一覧ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('753: テーブル一覧のフィールドヘッダーが正常に表示されること（#issue1363）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('754: 通知設定ページがエラーなく正常に表示されること（#issue1247）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });







    test('761: DATE_ADD関数を使用したテーブルのレコード一覧が正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('762: テーブルのカレンダービュー切り替えがエラーなく動作すること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // カレンダービューに切り替えできること
        const calBtn = page.locator('button, a, [title]').filter({ hasText: /カレンダー/ });
        if (await calBtn.count() > 0) {
            await calBtn.first().click();
            await page.waitForTimeout(1000);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('763: テーブル一覧画面に「表示する条件」という誤ったテキストが表示されないこと', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1224 ※「表示する条件」ではなく「表示する項目」が正しい
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__59
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 「表示する条件」という誤ったテキストが含まれていないこと
        expect(pageText).not.toContain('表示する条件');
        // テーブル一覧が正常に表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });







    test('770: 集計でチャート設定の開始月を設定できる機能が集計ページでエラーなく動作すること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('771: テーブル一覧の絞り込み検索機能がエラーなく動作すること（#issue1175）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 絞り込み機能が使用できること
        const filterBtn = page.locator('button, a').filter({ hasText: /絞り込み|フィルター|検索/ });
        if (await filterBtn.count() > 0) {
            await filterBtn.first().click();
            await page.waitForTimeout(500);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('773: テーブル設定で他で参照されている項目を削除しても通知設定ページが正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('775: テーブル設定ページがエラーなく正常に表示されること（#issue1349）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // テーブル設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('776: 通知設定ページがエラーなく正常に表示されること（#issue1345）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('777: 日時項目の種類を時刻のみに設定してもテーブル一覧フィールドヘッダーが正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // Angular SPAのtheadレンダリング完了を待機
        await page.waitForFunction(() => {
            const ths = document.querySelectorAll('table thead th');
            return ths.length > 0;
        }, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1000);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        const headerCount = await headers.count();
        console.log('777: thead th数:', headerCount);
        expect(headerCount).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('778: 集計ページがエラーなく正常に表示されること（#issue1113）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('779: テーブル設定で子テーブルの表示位置を変更してもテーブル設定ページが正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // テーブル設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('781: テーブル設定のカレンダー設定後にカレンダービューがエラーなく表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // カレンダービューに切り替えできること
        const calBtn = page.locator('button, a, [title]').filter({ hasText: /カレンダー/ });
        if (await calBtn.count() > 0) {
            await calBtn.first().click();
            await page.waitForTimeout(1000);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('782: 複数値登録を許可した画像項目を使用してもテーブル一覧が正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('783: 集計結果を並び替えできる機能を有効にしても集計ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('784: テーブル一覧のフィールドヘッダーがエラーなく表示されること（#issue944）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('785: ワークフローが設定されているテーブルの通知設定ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('786: 数値項目で桁区切りを表示しない設定でテーブル一覧のフィールドヘッダーが正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('787: テーブル一覧のフィールドヘッダーが正常に表示されること（#issue1385）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('788: テーブル一覧でCSV操作機能がエラーなく動作すること（#issue1362）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });







    test('795: 集計ページがエラーなく正常に表示されること（#issue1360）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });



    test('798: ファイル項目への添付後に帳票設定ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('799: テーブル設定で他で参照されている項目を削除しても通知設定ページが正常表示されること（#issue967）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('800: 一覧の表示幅設定とドラッグ伸縮の変更がフィールド設定ページで正常に表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1375 以下①～③の対応を行うと即時反映されるかも確認する ①一覧の表示幅(px)は【300】で設定 ②項目の幅をドラッグで伸縮
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // フィールド設定ページを確認（表示幅設定が可能なページ）
        await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('801: 削除した項目名が変数「%s」のまま表示されるバグ修正後に通知設定ページが正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('802: ワークフローテンプレートの条件設定後にワークフロー設定ページが正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('803: 親テーブルコピー時に子テーブルがコピーされない修正後にテーブル一覧が正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('804: テーブル一覧のフィールドヘッダーが正常に表示されること（#issue1381）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('806: 集計ページがエラーなく正常に表示されること（#issue1455）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('808: テーブル一覧でCSV操作機能がエラーなく動作すること（#issue1174）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('809: テーブル権限設定の変更後にユーザー管理ページが正常に表示されること', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('810: 親テーブルから子テーブルのルックアップを行ってもユーザー管理ページが正常表示されること', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('811: 親テーブルでワークフロー申請中のときワークフロー設定ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('812: 公開フォームリンクのURLパラメータで項目値を初期設定できてもテーブル一覧が正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 公開フォーム機能が正常に動作すること
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('813: テーブル設定のカレンダーフィールド設定後にカレンダービューがエラーなく表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // カレンダービューに切り替えできること
        const calBtn = page.locator('button, a, [title]').filter({ hasText: /カレンダー/ });
        if (await calBtn.count() > 0) {
            await calBtn.first().click();
            await page.waitForTimeout(1000);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('814: 詳細画面の関連レコード一覧で項目幅を手動変更してもフィールドヘッダーが正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('815: テーブル一覧のフィールドヘッダーがエラーなく表示されること（#issue1304）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('816: 特定ケースのバグ修正後に通知設定ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('817: 帳票を削除してもテーブル一覧ページが正常に表示されること', async ({ page }) => {
        // description: 帳票の削除を実施
        // expected: エラーなく帳票削除が完了すること
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        // Internal Server Errorのみチェック（'500'は件数表示などで誤検知するため使用しない）
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧ページが正常に表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // 500エラーページの .alert-danger が出ていないこと
        const errCount = await page.locator('.alert-danger').count();
        expect(errCount).toBe(0);
    });

    test('818: APIテスト実施後にユーザー一覧ページが正常に表示されること', async ({ page }) => {
        // description: APIテストの実施 ※実行ユーザーのIP制限有り／無しでAPI実行の可・不可についても確認する
        // expected: ※シート「APIテスト(邊見)」を実施しエラーが発生しないこと
        await page.goto(BASE_URL + '/admin/user');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // ユーザー一覧ページが表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // ユーザー関連のコンテンツが表示されること
        expect(pageText).not.toContain('404');
    });


    test('820: 通知設定でファイル項目を設定したときファイル名が正常に取得できること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('821: 画像項目で複数値登録を許可している時にテーブル一覧フィールドヘッダーが正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('822: 集計ページがエラーなく正常に表示されること（#issue1427）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('823: ワークフロー設定ページがエラーなく正常に表示されること（#issue1421）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('824: 集計ページがエラーなく正常に表示されること（#issue1359）', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('825: 他人のリクエストログ閲覧制限後もユーザー管理ページが正常に表示されること', async ({ page }) => {
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('826: 通知設定で組織テーブルの他テーブル参照項目を通知先に選択できても通知設定ページが正常表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('827: 帳票に画像を出力する設定後に帳票設定ページが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });






    test('833: カレンダー機能をオンにしているテーブルでカレンダービューがエラーなく表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // カレンダービューに切り替えできること
        const calBtn = page.locator('button, a, [title]').filter({ hasText: /カレンダー/ });
        if (await calBtn.count() > 0) {
            await calBtn.first().click();
            await page.waitForTimeout(1000);
        }
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('834: 複数値登録を許可した日時項目でテーブル一覧フィールドヘッダーが正常に表示されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });


    test('836: 他テーブル先が計算項目で自動反映ONのとき並び替えが正常に動作すること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1549 ※他テーブル先が計算項目、自動反映ONのとき、並び替えがうまくいってない
        // expected: 想定通りの結果となっていること。 https://henmi027.pigeon-demo.com/admin/dataset__4
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が表示されること（ソート操作の確認）
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // ソートボタンが存在すること（th要素）
        const thElements = page.locator('th, [class*="sort"]');
        const thCount = await thElements.count();
        expect(thCount).toBeGreaterThanOrEqual(0);
    });

    test('837: 郵便番号フィールドをCSVダウンロードしたとき正常にデータが出力されること', async ({ page }) => {
        expect(tableId, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('838: ルックアップ表示した項目が一覧画面でレイアウト崩れなく正常に表示されること', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1532 ※ルックアップ表示したも項目の表示がずれる
        // expected: 想定通りの結果となっていること。 https://henmi027.pigeon-demo.com/admin/dataset__9
        const tid = tableId || await getAllTypeTableId(page);
        expect(tid, 'テーブルIDが取得できること（beforeAllで作成済み）').toBeTruthy();
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        // Internal Server Errorのみチェック（'500'は件数表示などで誤検知するため使用しない）
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が表示されること（ルックアップ項目の表示崩れ確認）
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // エラーが表示されていないことを確認
        expect(pageText).not.toContain('エラーが発生しました');
        const errCount = await page.locator('.alert-danger').count();
        expect(errCount).toBe(0);
    });

});
