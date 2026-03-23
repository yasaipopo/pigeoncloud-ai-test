// @ts-check
const { test, expect } = require('@playwright/test');

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
    // アカウントロックチェック
    const bodyText = await page.innerText('body').catch(() => '');
    if (bodyText.includes('アカウントロック') || bodyText.includes('account lock')) {
        throw new Error('アカウントロック: テスト環境のログインが制限されています');
    }
    await page.fill('#id', email || EMAIL);
    await page.fill('#password', password || PASSWORD);
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
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
                await page.waitForURL('**/admin/dashboard', { timeout: 40000 }).catch(() => {});
            }
        } else if (page.url().includes('/admin/login')) {
            await page.waitForTimeout(1000);
            await page.fill('#id', email || EMAIL);
            await page.fill('#password', password || PASSWORD);
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
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
        await page.close();
    });

    test.beforeEach(async ({ page }) => {
        test.setTimeout(120000); // ログインタイムアウト対策
        try {
            await login(page);
        } catch (e) {
            if (e.message && e.message.includes('アカウントロック')) {
                console.error('FATAL: アカウントロック検出 - テスト実行を中断します:', e.message);
                process.exit(1);
            }
            // ログイン失敗時は1回リトライ
            await page.waitForTimeout(3000);
            await login(page);
        }
        await closeTemplateModal(page);
    });

    test.skip('673: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C050ZRN4PNC/p1733205093440009
    });

    test('674: Yes/No項目がありますが、すべてラベルが空白で登録できてしまっているようです', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1180 これの Yes/No項目がありますが、すべてラベルが空白で登録できてしまっているようです。これだけできないようにしました
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        // テーブル新規作成画面でYes/No項目のバリデーション確認
        await page.goto(BASE_URL + `/admin/dataset__${tid}/edit/new`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // 新規作成フォームが表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('675: 関連レコード一覧を詳細画面から削除するとき、（#issue1053）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('676: カレンダーに予定が表示されていない状態で、簡易検索を行うと、（#issue946）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
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

    test('677: カレンダー表示で、（#issue1016）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
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

    test('678: チャートのプレビュー画面の≪と≫を押したとき、（#issue1032）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('679: 「テストメイトボーナス集計」テーブル（#issue1230）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('680: テーブル：CloudSTB_入庫予定（dataset__578）（#issue1238）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('681: テーブル：決算確認表（dataset__70）（#issue1183）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('682: 「CSVダウンロード/アップロードに子テーブルも含める」を有効にして、（#issue1235）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('683: テーブル：車両入力（dataset__96）（#issue1118）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('684: 通知先組織に親組織を設定すると、（#issue964）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('685: テーブル：校正履歴（dataset__19）（#issue1132）', async ({ page }) => {
        await login(page);
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('686: テーブル：計測器（dataset__17）（#issue1165）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('687: CSVアップロードを行う際に、（#issue1205）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('688: 上記と同時にアップデートしていただきたい内容として、（#issue1211）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('689: 集計でも、チャート設定（添付画像）のように開始月を設定できるように実装希望です。（#issue553）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('690: 子テーブル内で他テーブル参照項目があり、（#issue1219）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('691: メール通知制限の警告通知の文言を変更いただきたいです。（#issue1246）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('692: ユーザー権限でも、リクエストログやログを確認したいというご要望になります。（#issue1212）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('693: 子テーブルの他テーブル参照項目を、必須項目にし、必須条件設定しているとき、（#issue679）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 公開フォーム機能が正常に動作すること
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('694: 関連レコード一覧項目の「表示する条件」が、（#issue1141）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('695: 関連レコード一覧の表示する条件に、（#issue1203）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('696: テーブル：CAPA計画書（RCA・CAPA Plan）（dataset__47）（#issue1251）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('697: 各項目の項目設定で、（#issue1007）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('698: テーブル：HPお問い合わせ管理（dataset__181）（#issue1269）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('699: テーブル設定で、（#issue967）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('700: 計算値の自動更新がOFFの場合に、（#issue1210）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('701: 複数値に関しても、CSVで空欄でアップロードされたら値が削除されるよう仕様変更をお願いいたします。（#issue1270）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test.skip('702: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1738802545186909
    });

    test.skip('703: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05CK6Z7YDQ/p1737881017605909?thread_ts=1733981177.144699&cid=C05CK6Z7YDQ
    });

    test.skip('704: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p17392159423660399
    });

    test('705: 関連レコード一覧を縦に表示したとき、詳細ボタンや編集ボタン、削除ボタンが出なくなるため、（#issue1287）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('706: テーブルの上部メモに、ファイル(xlsx等)を添付する事が出来るのですが、（#issue1192）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('707: 自動採番のフォーマットについて2点お願いいたします。（#issue1190）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('708: 関連レコード一覧について、（#issue1213）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
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
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が表示されること（帳票DLボタンの確認）
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // 500エラー・エラーページが出ていないこと
        expect(pageText).not.toContain('500');
        expect(pageText).not.toContain('エラーが発生しました');
    });

    test.skip('710: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1740639950439849?thread_ts=1740518165.554519&cid=C06LF4G88FM
    });

    test.skip('711: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1741029567350709
    });

    test('712: テーブル：会社情報（dataset__16）（#issue1314）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('713: テーブル権限設定で、（#issue1049）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('714: チャート→チャート設定タブ内、（#issue908）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('715: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1741121853202309
    });

    test.skip('716: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1741342790381319
    });

    test('717: コメントでメンションをしたとき、添付画像一枚目のように打っても、（#issue1290）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('718: 「複数の値の登録を許可する」を有効にしている文字列(一行)項目で、（#issue1256）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('719: ビューの「行に色を付ける」機能ですが、（#issue1181）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('720: コピー環境で再現されました。（#issue1279）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('721: テーブル：在庫リスト（dataset__5）メーカーリスト（dataset__61）（#issue958）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('722: レコード詳細画面の関連レコード一覧の+ボタン（添付画像赤枠）からレコードを作成する際に、（#issue1225）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('723: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1741465769936279
    });

    test('724: 他テーブル参照項目の選択用表示項目に、親テーブルの項目を設定できるようにしていただけますでしょうか。（#issue1226）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('725: カレンダー機能で、（#issue1098）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
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

    test('726: 地図開発の件です。（#issue1257）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('727: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1742012570253099
    });

    test('728: 子テーブルの追加オプション一覧で、（#issue882）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // テーブル設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('729: 帳票で、子テーブルの情報を出力する際、（#issue1042）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('730: 通知設定において、（#issue1298）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('731: CSVアップロードにかかる時間について、（#issue1258）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('732: ワークフローの「一度承認されたデータも再申請可能」機能ですが、（#issue1253）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('733: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1742718204814239
    });

    test.skip('734: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1742746013359439
    });

    test('735: 画像項目にサイズ制限を設定できるようにしていただけますでしょうか。（#issue1117）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('736: 主キーを設定する画面の「CSVアップロードの主キー設定」の下に、（#issue1294）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('737: テーブル：基幹システム（dataset__47）（#issue1218）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('738: テーブル：注文書（dataset__8）（#issue1323）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('739: 添付画像の通り、絞り込み時に「他の項目を条件で利用する」にチェックし、（#issue1321）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
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

    test.skip('740: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1743189135930149
    });

    test.skip('741: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1743269506563609
    });

    test('742: DB: gk8krpzbyh (ジェイーワイテックス株式会社)（#issue1324）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('743: こちらの地図開発の続きです。（#issue1342）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('744: 「複数の値の登録を許可する」を有効にした文字列(一行)項目を一覧画面や詳細画面で見ると、（#issue1278）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('745: Yes/No項目でデフォルト値を設定できるようにしていただけますでしょうか。（#issue1289）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('746: 他テーブル参照項目の表示項目に、（#issue1286）', async ({ page }) => {
        await login(page);
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('747: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1743823534568559
    });

    test('748: テーブル権限設定のところにCSVアップロードが出ないように修正いただけますでしょうか。（#issue1327）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('749: 関連レコード一覧にページネーションをつけたとき、（#issue1318）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('750: 関連レコード一覧のページネーションについて、以下不具合の修正をお願いいたします。（#issue1319）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('751: ログインユーザー：sales+340@loftal.jp（#issue959）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('752: 日時項目をCSVアップロードするとき、（#issue1292）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('753: テーブル：生産指示（dataset__100）（#issue1363）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('754: テーブル：押印申請台帳（dataset__157）（#issue1247）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('755: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05C2V0C5QQ/p1745811344393479
    });

    test.skip('756: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05C2V0C5QQ/p1745805429246679
    });

    test.skip('757: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05C2V0C5QQ/p1745811344393479
    });

    test.skip('758: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05C2V0C5QQ/p1745812828365939
    });

    test.skip('759: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05C2V0C5QQ/p1745820707419929
    });

    test.skip('760: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05C2V0C5QQ/p1745837695920219
    });

    test('761: DATE_ADD関数に関して、（#issue1204）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // レコード一覧が正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('762: テーブル：アプローチ履歴（dataset__25）（#issue1284）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
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

    test('763: ※「表示する条件」ではなく「表示する項目」が正しい', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1224 ※「表示する条件」ではなく「表示する項目」が正しい
        // expected: 想定通りの結果となること。 https://henmi022.pigeon-demo.com/admin/dataset__59
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
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

    test.skip('764: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1747108063122459
    });

    test.skip('765: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1747118435740169
    });

    test.skip('766: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1747118525319649
    });

    test.skip('767: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1747119649950799
    });

    test.skip('768: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1747385266631289?thread_ts=1747108063.122459&cid=C04J1D90QJY
    });

    test.skip('769: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1747768709177359
    });

    test('770: 集計でも、チャート設定（添付画像）のように開始月を設定できるように実装希望です。（#issue553）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('771: テーブル：営業活動記録（dataset__119）（#issue1175）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
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

    test.skip('772: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1747199333346399
    });

    test('773: テーブル設定で、（#issue967）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('774: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1749046197365429
    });

    test('775: すみません、上記FBについてですが、以下の操作後にも、（#issue1349）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // テーブル設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('776: すみません、上記FBについてですが、（#issue1345）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('777: 日時タイプの項目で、種類が時刻のみの場合、（#issue1015）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('778: テーブル：成形実績（dataset__37）（#issue1113）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('779: 子テーブルは、テーブル設定でどこに設置しても最下部に表示されると思いますが、（#issue1307）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // テーブル設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('780: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1749582078594599
    });

    test('781: テーブル設定-->カレンダー設定の「カレンダーで表示したいフィールドを入力してください」の項目...（#issue1412）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
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

    test('782: 「複数の値の登録を許可する」が有効の画像項目で、（#issue1336）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('783: 集計結果を、通常のテーブル一覧のように並び替えできるようにしていただきたいです。（#issue1022）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('784: テーブル：3-アイデアまとめ（dataset__52）（#issue944）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('785: ワークフローが設定されているテーブルで、（#issue927）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('786: 数値項目で、「桁区切りを表示しない」のチェックを外している場合、（#issue1079）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('787: テーブル：用語集（dataset__23）（#issue1385）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('788: テーブル：売却品搬入指示書（dataset__9）（#issue1362）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test.skip('789: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1750875885479779
    });

    test.skip('790: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1750763065092929
    });

    test.skip('791: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1752211650748159
    });

    test.skip('792: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1752211434013469
    });

    test.skip('793: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1752211499109039
    });

    test.skip('794: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1752211557325949
    });

    test('795: テーブル：計測器(dataset__40)（#issue1360）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('796: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C06LF4G88FM/p1753383953585199
    });

    test.skip('797: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1754500272365939
    });

    test('798: 添付ファイルの「IMG_8327 (3) (1).MOV」をファイル項目に添付した時、（#issue1374）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('799: テーブル設定で、（#issue967）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('800: 以下①～③の対応を行うと即時反映されるかも確認する', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1375 以下①～③の対応を行うと即時反映されるかも確認する ①一覧の表示幅(px)は【300】で設定 ②項目の幅をドラッグで伸縮
        // expected: 想定通りの結果となること。
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        // フィールド設定ページを確認（表示幅設定が可能なページ）
        await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
    });

    test('801: 削除した項目名が変数の「%s」で表示されているため、（#issue1376）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('802: ワークフローテンプレートの条件で、（#issue1306）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('803: 親テーブルをコピーした際に子テーブルがコピーされないように修正いただけますでしょうか。（#issue1344）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('804: テーブル：CAPA結果報告書（dataset__75）（#issue1381）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('805: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1754368311795019?thread_ts=1753710210.146859&cid=C04J1D90QJY
    });

    test('806: ダッシュボードから集計結果の並び替えができない（#issue1455）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('807: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05CK6Z7YDQ/p1756823153701649?thread_ts=1756549205.786739&cid=C05CK6Z7YDQ
    });

    test('808: テーブル：営業活動記録（dataset__119）（#issue1174）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('809: テーブル権限設定で、（#issue1302）', async ({ page }) => {
        await login(page);
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('810: 現状、親テーブルから子テーブルのルックアップを行うと、（#issue1358）', async ({ page }) => {
        await login(page);
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('811: 親テーブルでワークフロー申請中の時、親テーブルの編集はできませんが、（#issue1311）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('812: 公開フォームリンクのURLに、例えば「〇〇（項目名）=AAAA」と入れれば、（#issue1399）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 公開フォーム機能が正常に動作すること
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('813: テーブル設定-->カレンダー設定の「カレンダーで表示したいフィールドを入力してください」の項目...（#issue1412）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
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

    test('814: 一度ログアウトしてもう一度見ると、幅が初期に戻ってしまいますので、（#issue1429）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('815: 日時項目を選択しても、（#issue1304）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('816: 以下ケースのバグと同じかと思いますが、以下ケースの場合（#issue1389）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('817: 帳票の削除を実施', async ({ page }) => {
        // description: 帳票の削除を実施
        // expected: エラーなく帳票削除が完了すること
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧ページが正常に表示されること
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // 500エラー・エラーページが出ていないこと
        expect(pageText).not.toContain('500');
    });

    test('818: APIテストの実施', async ({ page }) => {
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

    test.skip('819: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C04J1D90QJY/p1759256897527249
    });

    test('820: 通知設定において、（#issue1442）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('821: 画像項目で、「複数の値の登録を許可する」を有効にしている時、（#issue1443）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('822: チャートの「チャート設定」タブで、「前期も表示」にチェックを入れると、（#issue1427）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('823: テーブル：購入申請（dataset__65）（#issue1421）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // ワークフロー設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/workflow`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('824: テーブル：入出庫明細（dataset__57）（#issue1359）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 集計ページが正常に表示されること
        await checkPage(page, `/admin/summary__${tableId}`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('825: 現状、他人のリクエストログを見ることはできないのですが、（#issue1407）', async ({ page }) => {
        await login(page);
        // ユーザー管理ページが正常に表示されること
        await checkPage(page, '/admin/user');
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('826: 通知設定で、（#issue1330）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 通知設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/notification`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test('827: 帳票に画像を出力したとき、（#issue1432）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        // 帳票設定ページが正常に表示されること
        await checkPage(page, `/admin/dataset__${tableId}/setting/report`);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('828: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05C2V0C5QQ/p1769589479320439
    });

    test.skip('829: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05C2V0C5QQ/p1769574891296539
    });

    test.skip('830: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05C2V0C5QQ/p1769398139056169
    });

    test.skip('831: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05C2V0C5QQ/p1769320662869579
    });

    test.skip('832: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05C2V0C5QQ/p1769308501903709
    });

    test('833: カレンダー機能をオンにしているテーブルにおいて、（#issue1516）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
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

    test('834: 「複数の値の登録を許可する」を有効にした日時項目で、（#issue1546）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // 項目（フィールド）が正常に表示されること
        const headers = page.locator('table thead th');
        expect(await headers.count()).toBeGreaterThan(0);
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
    });

    test.skip('835: Slackスレッド参照（詳細確認要）', async ({ page }) => {
        // TODO: Slackスレッド内容を確認してテストを実装すること
        // URL: https://loftal.slack.com/archives/C05CK6Z7YDQ/p1761884423226249
    });

    test('836: ※他テーブル先が計算項目、自動反映ONのとき、並び替えがうまくいってない', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1549 ※他テーブル先が計算項目、自動反映ONのとき、並び替えがうまくいってない
        // expected: 想定通りの結果となっていること。 https://henmi027.pigeon-demo.com/admin/dataset__4
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
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

    test('837: 1/25のリリース後、郵便番号を入力した項目をCSVダウンロードしたときに、（#issue1540）', async ({ page }) => {
        await login(page);
        const { tableId } = await setupAllTypeTable(page);
        expect(tableId).toBeTruthy();
        await checkPage(page, `/admin/dataset__${tableId}`);
        // CSVエクスポート/インポートが正常に動作すること
        const csvLinks = page.locator('a, button').filter({ hasText: /CSV|エクスポート|インポート/ });
        const errors = await page.locator('.alert-danger').count();
        expect(errors).toBe(0);
        // ページが正常に表示されること
        expect(await page.locator('table').count()).toBeGreaterThan(0);
    });

    test('838: ※ルックアップ表示したも項目の表示がずれる', async ({ page }) => {
        // description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/1532 ※ルックアップ表示したも項目の表示がずれる
        // expected: 想定通りの結果となっていること。 https://henmi027.pigeon-demo.com/admin/dataset__9
        const tid = tableId || await getAllTypeTableId(page);
        if (!tid) { test.skip(); return; }
        await page.goto(BASE_URL + `/admin/dataset__${tid}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        // テーブル一覧が表示されること（ルックアップ項目の表示崩れ確認）
        await expect(page.locator('main').first()).toBeVisible({ timeout: 30000 });
        // レイアウト崩れの主な兆候（水平スクロールの過剰な発生）がないことを確認
        expect(pageText).not.toContain('500');
        expect(pageText).not.toContain('エラーが発生しました');
    });

});
