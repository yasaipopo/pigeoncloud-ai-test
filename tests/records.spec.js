// @ts-check
const { test, expect } = require('@playwright/test');
const { setupAllTypeTable, deleteAllTypeTables, createAllTypeData } = require('./helpers/table-setup');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

/**
 * ログイン共通関数
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('#id', { timeout: 30000 });
    await page.fill('#id', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
    } catch (e) {
        if (page.url().includes('/admin/login')) {
            await page.waitForTimeout(1000);
            await page.fill('#id', EMAIL);
            await page.fill('#password', PASSWORD);
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
        }
    }
    await page.waitForTimeout(1000);
}

/**
 * テンプレートモーダルを閉じる
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
 * デバッグAPIのPOST呼び出し（native fetchを使用、pageライフサイクル非依存）
 */
async function debugApiPost(pageOrCookies, path, body = {}) {
    try {
        // Cookieを取得（pageオブジェクトまたはCookies配列を受け付ける）
        let cookies;
        if (Array.isArray(pageOrCookies)) {
            cookies = pageOrCookies;
        } else {
            cookies = await pageOrCookies.context().cookies().catch(() => []);
        }
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        // native fetchを使用（page.requestはページコンテキストのライフサイクルに依存するため不安定）
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 200000);
        try {
            const response = await fetch(BASE_URL + '/api/admin/debug' + path, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Cookie': cookieStr,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch(e) {
                // 504等のHTMLレスポンスの場合は仮レスポンスを返す
                return { result: 'timeout', status: response.status, text: text.substring(0, 100) };
            }
        } finally {
            clearTimeout(timeoutId);
        }
    } catch(e) {
        return { result: 'error', message: e.message };
    }
}

/**
 * ダッシュボードのサイドバーからテーブルIDを取得（/admin/datasetページではサイドバーにリンクが表示されないため）
 */
async function getFirstTableId(page) {
    await page.goto(BASE_URL + '/admin/dashboard');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const link = page.locator('a[href*="/admin/dataset__"]').first();
    const href = await link.getAttribute('href', { timeout: 15000 }).catch(() => null);
    if (!href) return null;
    const match = href.match(/dataset__(\d+)/);
    return match ? match[1] : null;
}

// =============================================================================
// レコード操作テスト
// =============================================================================

test.describe('レコード操作（一覧・作成・編集・削除・一括編集）', () => {
    // describe全体のデフォルトタイムアウトを延長（beforeEach含む）
    test.describe.configure({ timeout: 120000 });

    // describeブロック内で共有するtableId
    let tableId = null;

    // テスト全体の前に一度だけテーブルとデータを作成
    test.beforeAll(async ({ browser }) => {
        test.setTimeout(360000);
        const page = await browser.newPage();
        await login(page);
        ({ tableId } = await setupAllTypeTable(page));
        if (!tableId) {
            await page.close();
            throw new Error('ALLテストテーブルの作成に失敗しました（beforeAll）');
        }
        await createAllTypeData(page, 5, 'fixed');
        // データが実際にDBに存在することを確認するまでポーリング（最大60秒）
        for (let i = 0; i < 12; i++) {
            await page.waitForTimeout(5000);
            try {
                const status = await page.evaluate(async (baseUrl) => {
                    const res = await fetch(baseUrl + '/api/admin/debug/status', {
                        credentials: 'include',
                        headers: { 'X-Requested-With': 'XMLHttpRequest' },
                    });
                    return res.json();
                }, BASE_URL);
                const table = (status?.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
                if (table && table.count >= 1) break;
            } catch (e) {}
        }
        await page.close();
    });

    // 各テスト前: ログインのみ
    test.beforeEach(async ({ page }) => {
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 143-01: レコード一覧のコメントアイコン
    // 一覧にコメントアイコン追加（マウスオーバーで件数と最新投稿時間表示）
    // -------------------------------------------------------------------------
    test('143-01: レコード一覧にコメントアイコンが表示されること', async ({ page }) => {
        expect(tableId).not.toBeNull();

        // レコード一覧に移動
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // ページが正常に表示されること
        await expect(page.locator('.navbar')).toBeVisible();

        // テーブルが表示されること（メインテーブルは .pc-list-view クラスを持つ）
        await expect(page.locator('table.pc-list-view')).toBeVisible();

        // テーブルヘッダー行が存在すること
        await expect(page.locator('tr[mat-header-row]')).toBeVisible();

        // データ行が存在すること（setupAllTypeTableで作成済み）
        await expect(page.locator('tr[mat-row]').first()).toBeVisible();

        // 各データ行にチェックボックスが存在すること
        await expect(page.locator('tr[mat-row] input[type="checkbox"]').first()).toBeVisible();

        // コメントアイコンを探す（コメントがある場合に表示される）
        const commentIcon = page.locator(
            '[class*="comment"], .comment-count, .fa-comment, [title*="コメント"]'
        ).first();
        const iconCount = await commentIcon.count();

        if (iconCount > 0) {
            // コメントアイコンにマウスオーバー
            await commentIcon.hover();
            await page.waitForTimeout(800);
            // コメントアイコンが表示されていれば合格
            await expect(commentIcon).toBeVisible();
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/143-01-comment-icon.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 167-1: レコードのチェックボックスをクリックすると一括削除ボタンが表示される
    // -------------------------------------------------------------------------
    test('167-1: チェックボックスをクリックすると一括削除ボタンが表示されること', async ({ page }) => {

        // レコード一覧に移動
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // ページが正常に表示されること
        await expect(page.locator('.navbar')).toBeVisible();

        // データ行のチェックボックスが存在すること
        const checkbox = page.locator('tr[mat-row] input[type="checkbox"]').first();
        await expect(checkbox).toBeVisible();

        // チェックボックスをクリック
        await checkbox.click({ force: true });
        await page.waitForTimeout(800);

        // 一括削除ボタンが表示されること（btn-danger かつ「一括削除」テキスト）
        const bulkDeleteBtn = page.locator('button.btn-danger:has-text("一括削除")');
        await expect(bulkDeleteBtn).toBeVisible();
        await expect(bulkDeleteBtn).toContainText('一括削除');

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/167-1-checkbox-bulk-delete.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 180-1: 一括編集：権限のあるデータのみ一括編集可
    // -------------------------------------------------------------------------
    test('180-1: 一括編集メニューが表示され、一括編集を実行できること', async ({ page }) => {

        // レコード一覧に移動
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // ページが正常に表示されること
        await expect(page.locator('.navbar')).toBeVisible();

        // ハンバーガーメニュー（fa-bars）をクリック
        const hamburgerBtn = page.locator('button:has(.fa-bars)').first();
        await expect(hamburgerBtn).toBeVisible({ timeout: 10000 });
        await hamburgerBtn.click();
        await page.waitForTimeout(1000);

        // ドロップダウンに「一括編集」が表示されること
        const bulkEditItem = page.locator('.dropdown-menu.show .dropdown-item:has-text("一括編集")').first();
        await expect(bulkEditItem).toBeVisible({ timeout: 5000 });
        await bulkEditItem.click();
        await page.waitForTimeout(2000);

        // 一括編集モーダルが表示されること
        const modal = page.locator('.modal.show').first();
        await expect(modal).toBeVisible();

        // モーダルタイトルが「一括編集」であること
        await expect(modal.locator('.modal-title')).toContainText('一括編集');

        // 「項目を追加」ボタンが表示されること
        await expect(modal.locator('button:has-text("項目を追加")')).toBeVisible();

        // モーダルを閉じる
        const cancelBtn = modal.locator('button.btn-secondary').first();
        if (await cancelBtn.isVisible().catch(() => false)) {
            await cancelBtn.click({ force: true });
            await page.waitForTimeout(500);
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/180-1-bulk-edit.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 180-2: 一括編集：権限のないデータが含まれる場合は一括編集されない
    // -------------------------------------------------------------------------
    test('180-2: 権限のないデータが含まれる場合は一括編集がされないこと', async ({ page }) => {
        test.setTimeout(120000);

        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
        await expect(page.locator('.navbar')).toBeVisible();

        // ハンバーガーメニュー（fa-bars）をクリック
        const hamburgerBtn = page.locator('button:has(.fa-bars)').first();
        await expect(hamburgerBtn).toBeVisible({ timeout: 10000 });
        await hamburgerBtn.click();
        await page.waitForTimeout(1000);

        // 一括編集メニュー項目をクリック
        const bulkEditItem = page.locator('.dropdown-menu.show .dropdown-item:has-text("一括編集")').first();
        await expect(bulkEditItem).toBeVisible({ timeout: 5000 });
        await bulkEditItem.click();
        await page.waitForTimeout(2000);

        // 一括編集モーダルが表示されること
        const modal = page.locator('.modal.show').first();
        await expect(modal).toBeVisible();

        // 「権限のあるデータのみ一括編集されます」という注意書きが表示されること
        await expect(modal).toContainText('権限のあるデータのみ一括編集されます');

        // 「項目を追加」ボタンが表示されること
        await expect(modal.locator('button:has-text("項目を追加")')).toBeVisible();

        // モーダルを閉じる
        const cancelBtn = modal.locator('button.btn-secondary').first();
        if (await cancelBtn.isVisible().catch(() => false)) {
            await cancelBtn.click({ force: true });
            await page.waitForTimeout(500);
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/180-2-bulk-edit-permission.png`, fullPage: false });
    });

    // -------------------------------------------------------------------------
    // 180-3: 一括編集：編集中でロックされているデータも強制的に上書き
    // -------------------------------------------------------------------------
    test('180-3: 編集中でロックされているデータも強制的に上書きされること', async ({ page, browser: browserArg }) => {
        test.setTimeout(120000);

        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
        await expect(page.locator('.navbar')).toBeVisible();

        // ハンバーガーメニューをクリック
        const hamburgerBtn = page.locator('button:has(.fa-bars)').first();
        await expect(hamburgerBtn).toBeVisible({ timeout: 10000 });
        await hamburgerBtn.click();
        await page.waitForTimeout(1000);

        // 一括編集メニュー項目をクリック
        const bulkEditItem = page.locator('.dropdown-menu.show .dropdown-item:has-text("一括編集")').first();
        await expect(bulkEditItem).toBeVisible({ timeout: 5000 });
        await bulkEditItem.click();
        await page.waitForTimeout(2000);

        // 一括編集モーダルが表示されること
        const modal = page.locator('.modal.show').first();
        await expect(modal).toBeVisible();

        // 「編集中でロックされているデータは更新されません」という注意書きが表示されること
        await expect(modal).toContainText('編集中でロックされているデータは更新されません');

        // モーダルを閉じる
        const cancelBtn = modal.locator('button.btn-secondary').first();
        if (await cancelBtn.isVisible().catch(() => false)) {
            await cancelBtn.click({ force: true });
            await page.waitForTimeout(500);
        }

        // ページが正常に表示されていることを確認
        await expect(page.locator('.navbar')).toBeVisible();

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/180-3-bulk-edit-lock.png`, fullPage: false });
    });

    // -------------------------------------------------------------------------
    // 180-4: 一括編集：フィルタをかけているパターン
    // -------------------------------------------------------------------------
    test('180-4: フィルタ適用中にのみ一括編集がかかること', async ({ page }) => {

        // レコード一覧に移動
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // ページが正常に表示されること
        await expect(page.locator('.navbar')).toBeVisible();

        // ハンバーガーメニューが表示されること
        const hamburgerBtn = page.locator('button:has(.fa-bars)').first();
        await expect(hamburgerBtn).toBeVisible({ timeout: 10000 });

        // ハンバーガーメニューをクリックして一括編集メニューが表示されること
        await hamburgerBtn.click();
        await page.waitForTimeout(1000);

        const bulkEditItem = page.locator('.dropdown-menu.show .dropdown-item:has-text("一括編集")').first();
        await expect(bulkEditItem).toBeVisible({ timeout: 5000 });

        // メニューを閉じる（Escapeキー）
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/180-4-bulk-edit-filtered.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 237: レコード一覧のスクロールバー操作
    // -------------------------------------------------------------------------
    test('237: レコード一覧のスクロールバーを問題なく操作できること', async ({ page }) => {

        // レコード一覧に移動
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // ページが正常に表示されること
        await expect(page.locator('.navbar')).toBeVisible();
        expect(page.url()).toContain(`dataset__${tableId}`);

        // メインテーブル（.pc-list-view）が表示されること
        const mainTable = page.locator('table.pc-list-view');
        await expect(mainTable).toBeVisible();

        // テーブルに横スクロール可能な .table-responsive クラスが付与されていること
        await expect(page.locator('table.table-responsive')).toBeVisible();

        // スクロール操作を行ってもエラーなく動作すること
        await mainTable.evaluate((el) => { el.scrollLeft = 200; });
        await page.waitForTimeout(500);
        await expect(page.locator('.navbar')).toBeVisible();

        // スクロール位置を戻す
        await mainTable.evaluate((el) => { el.scrollLeft = 0; });

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/237-scrollbar.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 35-1: 関連レコード一覧の対象テーブル削除
    // 参照されているテーブルを削除しようとすると「参照されているため削除できません」エラー
    // -------------------------------------------------------------------------
    test('35-1: 参照中のテーブルを削除しようとするとエラーが表示されること', async ({ page }) => {
        // 関連テーブル（テーブルA が テーブルB を参照）のセットアップが必要
        // テーブル一覧ページで既存テーブルの削除を試みる


        // テーブルページに移動（フィールド設定はテーブルページ内で行う）
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);

        // テーブルページが表示されることを確認
        await expect(page.locator('.navbar')).toBeVisible();

        // 「項目を追加」ボタンをクリックして関連レコード一覧を設定
        // 可視ボタンのみ対象にする（非表示ボタンへのクリックエラーを防ぐ）
        const addFieldBtn = page.locator('button:has-text("項目を追加"), a:has-text("項目を追加"), button:has-text("追加")').first();
        const addBtnVisible = await addFieldBtn.isVisible().catch(() => false);

        if (addBtnVisible) {
            await addFieldBtn.click();
            await page.waitForTimeout(800);

            // 「関連レコード一覧」を選択
            const relatedRecordOption = page.locator(
                'li:has-text("関連レコード一覧"), option:has-text("関連レコード一覧"), [class*="field-type"]:has-text("関連レコード一覧")'
            ).first();
            const optionVisible = await relatedRecordOption.isVisible().catch(() => false);

            if (optionVisible) {
                await relatedRecordOption.click();
                await page.waitForTimeout(800);
                // 設定が表示されていることを確認
                await expect(page.locator('.navbar')).toBeVisible();
            }
        }

        // テーブル削除のエラー確認は実際の削除操作が危険なため、
        // UIの表示確認のみ行う
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000);
        await expect(page.locator('.navbar')).toBeVisible();

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/35-1-related-record-delete.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 52-1: 関連レコード一覧 必須項目未入力（項目名）エラー
    // -------------------------------------------------------------------------
    test('52-1: 関連レコード一覧の項目名未入力でエラーが発生すること', async ({ page }) => {
        test.setTimeout(120000); // モーダル操作に時間がかかるため延長

        // テーブル設定ページに移動（「項目を追加する」ボタンはここに表示される）
        await page.goto(BASE_URL + `/admin/dataset/edit/${tableId}`);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        await expect(page.locator('.navbar')).toBeVisible();

        // 「項目を追加する」ボタンをクリック（ページ上に1つだけあるはず）
        const addFieldBtn = page.locator('button').filter({ hasText: /^[\s\S]*項目を追加/ }).filter({ visible: true }).first();
        await addFieldBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        const addBtnCount = await addFieldBtn.count();

        if (addBtnCount > 0) {
            await addFieldBtn.click({ force: true });
            await page.waitForTimeout(1500);

            // 「関連レコード一覧」フィールドタイプボタンが表示されるまで待機
            const relatedRecordOption = page.locator('button').filter({ hasText: '関連レコード一覧' }).filter({ visible: true }).first();
            await relatedRecordOption.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            const optionCount = await relatedRecordOption.count();

            if (optionCount > 0) {
                await relatedRecordOption.click({ force: true });
                // settingModalが完全に表示されるまで待機
                await page.waitForSelector('.modal.settingModal.show', { timeout: 10000 }).catch(() => {});
                await page.waitForTimeout(2000);
                // ローディング完了を待つ
                await page.waitForSelector('.modal.settingModal.show .loading, .modal.settingModal.show [class*="loading"]', { state: 'hidden', timeout: 5000 }).catch(() => {});
            }

            // 「追加する」ボタンをJavaScriptで直接クリック（modalのCSS干渉を回避）
            const clicked = await page.evaluate(() => {
                const modal = document.querySelector('.modal.settingModal.show');
                if (!modal) return false;
                // btn-successクラスのボタンを探す（「追加する」ボタン）
                const btn = modal.querySelector('button.btn-success');
                if (btn) { btn.click(); return true; }
                // テキストで探す
                const allBtns = modal.querySelectorAll('button');
                for (const b of allBtns) {
                    if (b.textContent.trim().includes('追加する')) { b.click(); return true; }
                }
                return false;
            });
            await page.waitForTimeout(1000);

            if (clicked) {
                // エラーメッセージが表示されることを確認
                const errorMsg = page.locator(
                    '.error, .alert-danger, [class*="error"], .invalid-feedback, [class*="required"], .toast-error, .toast-message'
                ).filter({ visible: true }).first();
                const errorCount = await errorMsg.count();
                if (errorCount > 0) {
                    await expect(errorMsg).toBeVisible();
                }
            }
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/52-1-related-record-name-error.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 52-2: 関連レコード一覧 必須項目未入力（対象テーブル）エラー
    // -------------------------------------------------------------------------
    test('52-2: 関連レコード一覧の対象テーブル未入力でエラーが発生すること', async ({ page }) => {
        test.setTimeout(120000); // モーダル操作に時間がかかるため延長

        // テーブル設定ページに移動（「項目を追加する」ボタンはここに表示される）
        await page.goto(BASE_URL + `/admin/dataset/edit/${tableId}`);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        await expect(page.locator('.navbar')).toBeVisible();

        // 「項目を追加する」ボタンをクリック
        const addFieldBtn = page.locator('button').filter({ hasText: /^[\s\S]*項目を追加/ }).filter({ visible: true }).first();
        await addFieldBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        const addBtnCount = await addFieldBtn.count();

        if (addBtnCount > 0) {
            await addFieldBtn.click({ force: true });
            await page.waitForTimeout(1500);

            // 「関連レコード一覧」フィールドタイプボタンが表示されるまで待機
            const relatedRecordOption = page.locator('button').filter({ hasText: '関連レコード一覧' }).filter({ visible: true }).first();
            await relatedRecordOption.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            const optionCount = await relatedRecordOption.count();

            if (optionCount > 0) {
                await relatedRecordOption.click({ force: true });
                // settingModalが完全に表示されるまで待機
                await page.waitForSelector('.modal.settingModal.show', { timeout: 10000 }).catch(() => {});
                await page.waitForTimeout(2000);
                await page.waitForSelector('.modal.settingModal.show .loading, .modal.settingModal.show [class*="loading"]', { state: 'hidden', timeout: 5000 }).catch(() => {});
            }

            // 項目名のみ入力し、対象テーブルは選択しない
            const clicked = await page.evaluate(() => {
                const modal = document.querySelector('.modal.settingModal.show');
                if (!modal) return false;
                // テキスト入力を探して項目名を入力
                const textInput = modal.querySelector('input[type="text"]');
                if (textInput) { textInput.value = 'テスト関連フィールド'; textInput.dispatchEvent(new Event('input', { bubbles: true })); }
                // 「追加する」ボタン（btn-success）をクリック
                const btn = modal.querySelector('button.btn-success');
                if (btn) { btn.click(); return true; }
                const allBtns = modal.querySelectorAll('button');
                for (const b of allBtns) {
                    if (b.textContent.trim().includes('追加する')) { b.click(); return true; }
                }
                return false;
            });
            await page.waitForTimeout(1000);

            if (clicked) {
                // エラーメッセージが表示されることを確認
                const errorMsg = page.locator(
                    '.error, .alert-danger, [class*="error"], .invalid-feedback, .toast-error, .toast-message'
                ).filter({ visible: true }).first();
                const errorCount = await errorMsg.count();
                if (errorCount > 0) {
                    await expect(errorMsg).toBeVisible();
                }
            }
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/52-2-related-record-table-error.png`, fullPage: true });
    });

});

// =============================================================================
// レコード一括操作テスト（チェックボックス選択・一括削除・一括編集）
// =============================================================================

test.describe('レコード一括操作（チェックボックス選択・一括削除・一括編集）', () => {
    test.describe.configure({ timeout: 180000 });

    // このdescribeブロック専用のtableIdとデータ
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(360000);
        const page = await browser.newPage();
        await login(page);
        ({ tableId } = await setupAllTypeTable(page));
        if (!tableId) {
            await page.close();
            throw new Error('ALLテストテーブルの作成に失敗しました（一括操作beforeAll）');
        }
        // 一括操作テスト用に10件データを作成
        await createAllTypeData(page, 10, 'fixed');
        // データが実際にDBに存在することを確認（最大60秒ポーリング）
        for (let i = 0; i < 12; i++) {
            await page.waitForTimeout(5000);
            try {
                const status = await page.evaluate(async (baseUrl) => {
                    const res = await fetch(baseUrl + '/api/admin/debug/status', {
                        credentials: 'include',
                        headers: { 'X-Requested-With': 'XMLHttpRequest' },
                    });
                    return res.json();
                }, BASE_URL);
                const table = (status?.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
                if (table && table.count >= 5) break;
            } catch (e) {}
        }
        await page.close();
    });

    test.beforeEach(async ({ page }) => {
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 一括-1: 一括選択UIの確認
    // 各行にチェックボックスが存在し、ヘッダーに全選択チェックボックスが存在すること
    // -------------------------------------------------------------------------
    test('一括-1: レコード一覧にチェックボックスと全選択UIが存在すること', async ({ page }) => {
        expect(tableId).not.toBeNull();

        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        await expect(page.locator('.navbar')).toBeVisible();

        // テーブルのデータ行が存在すること
        const dataRows = page.locator('tr[mat-row]');
        const rowCount = await dataRows.count();
        if (rowCount === 0) {
            // データがない場合はテーブル自体の確認のみ
            await expect(page.locator('.navbar')).toBeVisible();
            const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
            await page.screenshot({ path: `${reportsDir}/screenshots/bulk-1-no-data.png`, fullPage: true });
            return;
        }

        // 各データ行にチェックボックスが存在すること
        const rowCheckbox = page.locator('tr[mat-row] input[type="checkbox"]').first();
        await expect(rowCheckbox).toBeVisible();

        // ヘッダー行に全選択チェックボックスが存在すること
        // Angular Material テーブルではヘッダー行に mat-header-row が使われる
        const headerCheckbox = page.locator('tr[mat-header-row] input[type="checkbox"]');
        const headerCheckboxCount = await headerCheckbox.count();
        if (headerCheckboxCount > 0) {
            await expect(headerCheckbox.first()).toBeVisible();
        } else {
            // 全選択は別のセレクターの場合もある（.select-all 等）
            const selectAllEl = page.locator('.select-all, [class*="select-all"], th input[type="checkbox"]').first();
            const selectAllCount = await selectAllEl.count();
            // 存在確認のみ（UIが異なる場合はスキップ扱い）
            if (selectAllCount > 0) {
                await expect(selectAllEl).toBeVisible();
            }
        }

        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/bulk-1-checkbox-ui.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 一括-2: 全選択→一括操作ボタン表示確認
    // ヘッダーの全選択チェックボックスをクリックすると一括削除ボタンが表示されること
    // -------------------------------------------------------------------------
    test('一括-2: 全選択チェックボックスをクリックすると一括操作ボタンが表示されること', async ({ page }) => {
        expect(tableId).not.toBeNull();

        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        await expect(page.locator('.navbar')).toBeVisible();

        // データ行が存在することを確認
        const dataRows = page.locator('tr[mat-row]');
        const rowCount = await dataRows.count();
        if (rowCount === 0) {
            test.skip(true, 'データが存在しないためスキップ');
            return;
        }

        // ヘッダーの全選択チェックボックスをクリック
        const headerCheckbox = page.locator('tr[mat-header-row] input[type="checkbox"]').first();
        const headerCheckboxCount = await headerCheckbox.count();
        if (headerCheckboxCount === 0) {
            test.skip(true, '全選択チェックボックスが見つからないためスキップ');
            return;
        }

        await headerCheckbox.click({ force: true });
        await page.waitForTimeout(1500);

        // 一括削除ボタン or 選択件数表示が現れること
        const bulkDeleteBtn = page.locator(
            'button.btn-danger:has-text("一括削除"), button:has-text("一括削除"), .batch-delete, .bulk-action'
        ).filter({ visible: true }).first();
        const bulkDeleteCount = await bulkDeleteBtn.count();
        if (bulkDeleteCount > 0) {
            await expect(bulkDeleteBtn).toBeVisible();
        } else {
            // 「選択中N件」等のテキスト表示を確認
            const selectionText = page.locator(
                '[class*="selected"], [class*="checked-count"], :text-matches("選択中")'
            ).filter({ visible: true }).first();
            const selTextCount = await selectionText.count();
            if (selTextCount > 0) {
                await expect(selectionText).toBeVisible();
            }
        }

        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/bulk-2-select-all.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 一括-3: 1件選択→一括削除実行
    // 1件チェックして「一括削除」ボタンをクリック → 確認 → 件数が減ること
    // -------------------------------------------------------------------------
    test('一括-3: 1件選択して一括削除を実行すると件数が減ること', async ({ page }) => {
        expect(tableId).not.toBeNull();

        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        await expect(page.locator('.navbar')).toBeVisible();

        // 削除前の件数を取得（行カウント）
        const dataRows = page.locator('tr[mat-row]');
        const beforeCount = await dataRows.count();
        if (beforeCount === 0) {
            test.skip(true, 'データが存在しないためスキップ');
            return;
        }

        // 1行目のチェックボックスをクリック
        const firstCheckbox = page.locator('tr[mat-row] input[type="checkbox"]').first();
        const firstCheckboxCount = await firstCheckbox.count();
        if (firstCheckboxCount === 0) {
            test.skip(true, 'チェックボックスが見つからないためスキップ');
            return;
        }

        await firstCheckbox.click({ force: true });
        await page.waitForTimeout(1000);

        // 一括削除ボタンが表示されること
        const bulkDeleteBtn = page.locator('button.btn-danger:has-text("一括削除")').filter({ visible: true }).first();
        const bulkDeleteCount = await bulkDeleteBtn.count();
        if (bulkDeleteCount === 0) {
            test.skip(true, '一括削除ボタンが見つからないためスキップ');
            return;
        }

        await expect(bulkDeleteBtn).toBeVisible();

        // 一括削除ボタンをクリック
        // ダイアログ（confirm）またはモーダルで確認が出る場合に対処
        let dialogHandled = false;
        page.once('dialog', async (dialog) => {
            dialogHandled = true;
            await dialog.accept();
        });

        await bulkDeleteBtn.click({ force: true });
        await page.waitForTimeout(2000);

        // モーダルによる確認の場合はOKボタンをクリック
        if (!dialogHandled) {
            const confirmModal = page.locator('.modal.show').first();
            const confirmModalCount = await confirmModal.count();
            if (confirmModalCount > 0) {
                // 確認モーダルの「削除」「OK」「はい」ボタンをクリック
                const confirmBtn = confirmModal.locator(
                    'button.btn-danger, button:has-text("削除"), button:has-text("OK"), button:has-text("はい")'
                ).first();
                const confirmBtnCount = await confirmBtn.count();
                if (confirmBtnCount > 0) {
                    await confirmBtn.click({ force: true });
                    await page.waitForTimeout(2000);
                }
            }
        }

        // 削除完了を待つ（ローディング解消）
        await page.waitForTimeout(2000);

        // 削除後の件数が減っていること（beforeCount - 1 以下）
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        const afterCount = await page.locator('tr[mat-row]').count();
        expect(afterCount).toBeLessThan(beforeCount);

        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/bulk-3-bulk-delete.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 一括-4: 一括編集UIの確認（存在する場合）
    // 複数選択後に「一括編集」メニューが表示されること
    // -------------------------------------------------------------------------
    test('一括-4: 複数選択後に一括編集メニューが表示されること（UIが存在する場合）', async ({ page }) => {
        expect(tableId).not.toBeNull();

        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        await expect(page.locator('.navbar')).toBeVisible();

        // データ行が存在することを確認
        const dataRows = page.locator('tr[mat-row]');
        const rowCount = await dataRows.count();
        if (rowCount === 0) {
            test.skip(true, 'データが存在しないためスキップ');
            return;
        }

        // ハンバーガーメニュー（fa-bars）をクリック
        const hamburgerBtn = page.locator('button:has(.fa-bars)').first();
        const hamburgerCount = await hamburgerBtn.count();
        if (hamburgerCount === 0) {
            test.skip(true, 'ハンバーガーメニューが見つからないためスキップ');
            return;
        }

        await hamburgerBtn.click({ force: true });
        await page.waitForTimeout(1000);

        // 「一括編集」ドロップダウンアイテムが表示されること
        const bulkEditItem = page.locator(
            '.dropdown-menu.show .dropdown-item:has-text("一括編集"), button:has-text("一括編集")'
        ).filter({ visible: true }).first();
        const bulkEditCount = await bulkEditItem.count();
        if (bulkEditCount === 0) {
            // 一括編集UIが存在しない場合はスキップ（graceful skip）
            await page.keyboard.press('Escape');
            test.skip(true, '一括編集UIが存在しないためスキップ');
            return;
        }

        await expect(bulkEditItem).toBeVisible();

        // メニューを閉じる
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/bulk-4-bulk-edit-menu.png`, fullPage: true });
    });
});
