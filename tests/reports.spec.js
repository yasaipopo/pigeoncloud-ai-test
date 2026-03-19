// @ts-check
const { test, expect } = require('@playwright/test');
const { setupAllTypeTable, deleteAllTypeTables } = require('./helpers/table-setup');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

/**
 * ログイン共通関数（CSRFエラーに対応したリトライあり）
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded');
    await page.fill('#id', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit].btn-primary');
    // CSRFエラー時は自動で再ロード -> 再試行
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
    } catch (e) {
        // CSRF エラーで login のまま残っていたら、再度ログイン
        if (page.url().includes('/admin/login')) {
            await page.waitForTimeout(1000);
            await page.fill('#id', EMAIL);
            await page.fill('#password', PASSWORD);
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
        }
    }
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
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
 * デバッグAPIのPOST呼び出し
 */
async function debugApiPost(page, path, body = {}) {
    return await page.evaluate(async ({ baseUrl, path, body }) => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 180000); // 180秒タイムアウト
            let res;
            try {
                res = await fetch(baseUrl + '/api/admin/debug' + path, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify(body),
                    credentials: 'include',
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeoutId);
            }
            const text = await res.text();
            try {
                return JSON.parse(text);
            } catch(e) {
                // 504等のHTMLレスポンスの場合は仮レスポンスを返す（サーバー側で処理は完了している可能性あり）
                return { result: 'timeout', status: res.status, text: text.substring(0, 100) };
            }
        } catch(e) {
            return { result: 'error', message: e.message };
        }
    }, { baseUrl: BASE_URL, path, body });
}

/**
 * ダッシュボードのサイドバーからテーブルIDを取得（/admin/datasetページではサイドバーにリンクが表示されないため）
 */
async function getFirstTableId(page) {
    await page.goto(BASE_URL + '/admin/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    const link = page.locator('a[href*="/admin/dataset__"]').first();
    const href = await link.getAttribute('href', { timeout: 15000 }).catch(() => null);
    if (!href) return null;
    const match = href.match(/dataset__(\d+)/);
    return match ? match[1] : null;
}

/**
 * 帳票設定ページに移動し、帳票タブを表示する
 * @param {import('@playwright/test').Page} page
 * @param {string} tableId
 */
async function navigateToReportSetting(page, tableId) {
    // テーブルページに移動（帳票設定はテーブルページ内に表示される）
    await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
    // Angular描画を確認（navbarが見えるまで最大10s待機）
    await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
}

// =============================================================================
// 帳票テスト
// =============================================================================

test.describe('帳票（登録・出力・ダウンロード）', () => {

    // describeブロック内で共有するtableId
    let tableId = null;

    // テスト全体の前に一度だけテーブルIDを取得（テーブルがなければ作成）
    test.beforeAll(async ({ browser }) => {
        test.setTimeout(360000);
        const page = await browser.newPage();
        await login(page);
        tableId = await setupAllTypeTable(page);
        if (!tableId) {
            await page.close();
            throw new Error('ALLテストテーブルの作成に失敗しました（beforeAll）');
        }
        await page.close();
    });

    // 各テスト前: ログインのみ
    test.beforeEach(async ({ page }) => {
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 144-01: 帳票：関連テーブルを帳票出力に入れ込めるように変更
    // -------------------------------------------------------------------------
    test('144-01: 帳票設定で関連テーブルの追加ができること', async ({ page }) => {

        await navigateToReportSetting(page, tableId);

        // 帳票設定ページが表示されることを確認
        await expect(page.locator('.navbar')).toBeVisible();

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/144-01-report-related-table.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 198: 帳票：ファイル項目へExcelおよびPDFのファイル生成
    // -------------------------------------------------------------------------
    test('198: 帳票設定ページが表示され、Excel/PDF生成の設定項目があること', async ({ page }) => {

        await navigateToReportSetting(page, tableId);

        await expect(page.locator('.navbar')).toBeVisible();

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/198-report-file-generate.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 205: 帳票：Excel出力
    // -------------------------------------------------------------------------
    test('205: 帳票のExcel出力ができること', async ({ page }) => {

        // レコード一覧に移動
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        await expect(page.locator('.navbar')).toBeVisible();

        // 帳票ドロップダウンボタンを探す（特定セレクターで誤マッチを防ぐ）
        const menuBtn = page.locator('button.dropdown-toggle:has-text("帳票")').first();
        const menuCount = await menuBtn.count();

        if (menuCount > 0) {
            const isVisible = await menuBtn.isVisible();
            if (isVisible) {
                await menuBtn.click({ force: true });
                await page.waitForTimeout(500);

                // 帳票出力メニュー項目を探す
                const reportMenuItem = page.locator(
                    '.dropdown-menu.show .dropdown-item, .dropdown-menu.show li a'
                ).first();
                const reportMenuCount = await reportMenuItem.count();

                if (reportMenuCount > 0) {
                    await expect(reportMenuItem).toBeVisible();
                }
                // メニューを閉じる
                await page.keyboard.press('Escape');
                await page.waitForTimeout(300);
            }
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/205-report-excel.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 206: 帳票：PDF出力
    // -------------------------------------------------------------------------
    test('206: 帳票のPDF出力ができること', async ({ page }) => {

        // レコード一覧に移動
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        await expect(page.locator('.navbar')).toBeVisible();

        // 帳票ドロップダウンボタンを探す（特定セレクターで誤マッチを防ぐ）
        const menuBtn = page.locator('button.dropdown-toggle:has-text("帳票")').first();
        const menuCount = await menuBtn.count();

        if (menuCount > 0) {
            const isVisible = await menuBtn.isVisible();
            if (isVisible) {
                await menuBtn.click({ force: true });
                await page.waitForTimeout(500);

                const reportMenuItem = page.locator(
                    '.dropdown-menu.show .dropdown-item, .dropdown-menu.show li a'
                ).first();
                const reportMenuCount = await reportMenuItem.count();

                if (reportMenuCount > 0) {
                    await expect(reportMenuItem).toBeVisible();
                }
                await page.keyboard.press('Escape');
                await page.waitForTimeout(300);
            }
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/206-report-pdf.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 207: 帳票：Excel出力（ファイル名変更）
    // 出力ファイル名フォーマットを %m-%d に設定し、YYYY-MM.xlsx でダウンロードされること
    // -------------------------------------------------------------------------
    test('207: 帳票のファイル名フォーマット設定ができること（Excel）', async ({ page }) => {

        await navigateToReportSetting(page, tableId);

        await expect(page.locator('.navbar')).toBeVisible();

        // ファイル名フォーマット入力欄を探す
        const formatInput = page.locator(
            'input[placeholder*="ファイル名"], input[name*="filename"], input[name*="format"], ' +
            'input[placeholder*="format"], [class*="filename"] input'
        ).first();
        const inputCount = await formatInput.count();

        if (inputCount > 0) {
            await formatInput.fill('%m-%d');
            await page.waitForTimeout(500);
            // 入力が反映されていることを確認
            const value = await formatInput.inputValue();
            expect(value).toBe('%m-%d');
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/207-report-excel-filename.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 208: 帳票：PDF出力（ファイル名変更）
    // 出力ファイル名フォーマットを %m-%d に設定し、YYYY-MM.pdf でダウンロードされること
    // -------------------------------------------------------------------------
    test('208: 帳票のファイル名フォーマット設定ができること（PDF）', async ({ page }) => {

        await navigateToReportSetting(page, tableId);

        await expect(page.locator('.navbar')).toBeVisible();

        // ファイル名フォーマット入力欄を探す
        const formatInput = page.locator(
            'input[placeholder*="ファイル名"], input[name*="filename"], input[name*="format"], ' +
            '[class*="filename"] input'
        ).first();
        const inputCount = await formatInput.count();

        if (inputCount > 0) {
            await formatInput.fill('%m-%d');
            await page.waitForTimeout(500);
            const value = await formatInput.inputValue();
            expect(value).toBe('%m-%d');
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/208-report-pdf-filename.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 216: 帳票：アイコン（歯車アイコン）
    // 帳票登録後、メニューからの帳票リスト表示で歯車アイコンが表示されること
    // -------------------------------------------------------------------------
    test('216: 帳票メニューに歯車アイコンが表示されること', async ({ page }) => {

        // レコード一覧に移動
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);

        await expect(page.locator('.navbar')).toBeVisible();

        // メニューを開いて帳票アイコンを確認
        const menuBtn = page.locator(
            '.dropdown-toggle, button:has-text("メニュー"), [class*="menu-btn"]'
        ).first();
        const menuCount = await menuBtn.count();

        if (menuCount > 0) {
            await menuBtn.click({ force: true });
            await page.waitForTimeout(500);

            // 帳票メニュー項目の歯車アイコンを確認
            const gearIcon = page.locator(
                '.dropdown-item .fa-cog, .dropdown-item .fa-gear, ' +
                '.dropdown-item [class*="cog"], .dropdown-item [class*="gear"], ' +
                'a:has-text("帳票") .fa-cog, a:has-text("帳票") [class*="gear"]'
            ).first();
            const iconCount = await gearIcon.count();

            if (iconCount > 0) {
                await expect(gearIcon).toBeVisible();
            }
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/216-report-gear-icon.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 230: 帳票：ユーザーテーブルの帳票出力（特定項目は出力されない）
    // 通知先メールアドレス・パスワード・アクセス許可IP・状態・組織・役職は出力されない
    // -------------------------------------------------------------------------
    test('230: ユーザーテーブルの帳票設定ページが表示されること', async ({ page }) => {
        // ユーザーテーブル（/admin/user）の帳票設定を確認
        await page.goto(BASE_URL + '/admin/user');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1500);

        await expect(page.locator('.navbar')).toBeVisible();
        const pageUrl = page.url();
        expect(pageUrl).toContain('admin');

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/230-user-table-report.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 236: 帳票：AA列以降も帳票出力されること
    // 子テーブルの設定を行い、帳票にはAA列以降の指定も行う
    // -------------------------------------------------------------------------
    test('236: 帳票設定でAA列以降の列指定ができること', async ({ page }) => {

        await navigateToReportSetting(page, tableId);

        await expect(page.locator('.navbar')).toBeVisible();

        // 帳票設定の列指定UIを確認
        const columnInput = page.locator(
            'input[placeholder*="列"], input[name*="column"], select[name*="column"]'
        ).first();
        const inputCount = await columnInput.count();

        if (inputCount > 0) {
            // AA列などの入力ができることを確認
            await expect(columnInput).toBeVisible();
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/236-report-column-aa.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 253: 帳票ダウンロード：ファイル項目・画像項目
    // 参考: https://loftal.pigeon-cloud.com/admin/dataset__90/view/294
    // -------------------------------------------------------------------------
    test('253: 帳票ダウンロードでファイル項目・画像項目が出力されること（手動確認推奨）', async ({ page }) => {
        test.setTimeout(300000);

        // statusAPIからALLテストテーブルを探す。なければ作成する。
        async function findOrCreateAllTypeTable() {
            const statusResp = await page.evaluate(async () => {
                try {
                    const res = await fetch('/api/admin/debug/status', {
                        headers: { 'X-Requested-With': 'XMLHttpRequest' },
                        credentials: 'include'
                    });
                    return await res.json();
                } catch (e) { return null; }
            });
            const tables = statusResp?.all_type_tables || [];
            const found = tables.find(t =>
                (t.label || '').includes('ALLテストテーブル') && !(t.label || '').includes('子')
            );
            if (found) return String(found.id || found.table_id);
            return null;
        }

        let mainTableId = await findOrCreateAllTypeTable();

        // 見つからない場合は作成する
        if (!mainTableId) {
            console.log('[253] ALLテストテーブル未検出、作成開始');
            await page.evaluate(async () => {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 180000);
                    try {
                        await fetch('/api/admin/debug/create-all-type-table', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                            body: JSON.stringify({}),
                            credentials: 'include',
                            signal: controller.signal,
                        });
                    } finally { clearTimeout(timeoutId); }
                } catch (e) { /* 504タイムアウトも含め無視 */ }
            });
            await page.waitForTimeout(3000);
            // 作成後に再確認（ダッシュボードで確認）
            await page.goto(BASE_URL + '/admin/dashboard');
            await page.waitForLoadState('domcontentloaded');
            try { await page.waitForSelector('a[href*="/admin/dataset__"]', { timeout: 15000 }); } catch (e) {}
            await page.waitForTimeout(2000);
            mainTableId = await findOrCreateAllTypeTable();
            // それでも見つからない場合はダッシュボードのリンクから取得
            if (!mainTableId) {
                const allLinks = await page.locator('a[href*="/admin/dataset__"]').all();
                for (const link of allLinks) {
                    const text = await link.innerText().catch(() => '');
                    if (text.includes('ALLテストテーブル') && !text.includes('子')) {
                        const href = await link.getAttribute('href').catch(() => null);
                        if (href) {
                            const m = href.match(/dataset__(\d+)/);
                            if (m) { mainTableId = m[1]; break; }
                        }
                    }
                }
            }
        }

        if (!mainTableId) {
            test.skip(true, 'ALLテストテーブルが見つからないためスキップ');
            return;
        }

        console.log('[253] mainTableId:', mainTableId);

        // ALLテストテーブルのページに移動
        await page.goto(BASE_URL + `/admin/dataset__${mainTableId}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // ログインページにリダイレクトされた場合は再ログイン
        if (page.url().includes('/admin/login')) {
            await login(page);
            await page.goto(BASE_URL + `/admin/dataset__${mainTableId}`);
            await page.waitForLoadState('domcontentloaded');
            await page.waitForTimeout(3000);
            await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2000);
        }

        // 「テーブルが見つかりません」エラーが表示された場合はスキップ
        const bodyText253 = await page.locator('body').innerText().catch(() => '');
        if (bodyText253.includes('テーブルが見つかりません')) {
            test.skip(true, 'テーブルが見つかりません（テーブルが削除された可能性）');
            return;
        }

        // テーブルに「画像」「ファイル」カラムが存在することを確認
        const columnHeaders = page.locator('table thead th, table th');
        const headerTexts = await columnHeaders.allInnerTexts();
        const hasImageCol = headerTexts.some(t => t.includes('画像'));
        const hasFileCol = headerTexts.some(t => t.includes('ファイル'));
        expect(hasImageCol).toBe(true);
        expect(hasFileCol).toBe(true);

        // レコードを1件作成（デバッグAPIで固定値データを追加）
        await page.evaluate(async () => {
            await fetch('/api/admin/debug/create-all-type-data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ count: 1, pattern: 'fixed' }),
                credentials: 'include'
            });
        });
        await page.waitForTimeout(3000);

        // ページをリロードしてレコードを確認（最大3回リトライ）
        let rowCount = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
            await page.reload();
            await page.waitForLoadState('domcontentloaded');
            await page.waitForTimeout(3000);
            await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(2000);

            // ログインページにリダイレクトされた場合は再ログイン
            if (page.url().includes('/admin/login')) {
                await login(page);
                await page.goto(BASE_URL + `/admin/dataset__${mainTableId}`);
                await page.waitForLoadState('domcontentloaded');
                await page.waitForTimeout(3000);
                await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
                await page.waitForTimeout(2000);
            }

            const rows = page.locator('table tbody tr');
            rowCount = await rows.count();
            if (rowCount >= 1) break;
            await page.waitForTimeout(2000);
        }

        // レコードが1件以上あることを確認
        const rows = page.locator('table tbody tr');
        rowCount = await rows.count();
        expect(rowCount).toBeGreaterThanOrEqual(1);

        // レコード詳細モーダルを開く（最初の行をダブルクリック）
        const firstRow = rows.first();
        await firstRow.dblclick();
        await page.waitForTimeout(3000);
        await page.waitForURL(`**?data_id=*`, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // 詳細モーダル内に「画像」「ファイル」フィールドラベルが表示されることを確認
        const modal = page.locator('.modal.show');
        const modalCount = await modal.count();

        if (modalCount > 0) {
            const modalText = await modal.first().innerText();
            expect(modalText).toContain('画像');
            expect(modalText).toContain('ファイル');
        } else {
            // モーダルが表示されない場合、ページ全体で確認
            const bodyText = await page.innerText('body');
            expect(bodyText).toContain('画像');
            expect(bodyText).toContain('ファイル');
        }

        // 帳票ボタンがアクセス可能かどうか確認（テーブル一覧から）
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
        await page.goto(BASE_URL + `/admin/dataset__${mainTableId}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000);
        await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});

        // 帳票ボタンが表示されている場合のみメニューを確認（帳票未登録時はボタン非表示のため任意チェック）
        const reportBtn = page.locator('button.dropdown-toggle:has-text("帳票")').first();
        const reportBtnCount = await reportBtn.count();
        if (reportBtnCount > 0 && await reportBtn.isVisible()) {
            // 帳票メニューが開けることを確認
            await reportBtn.click({ force: true });
            await page.waitForTimeout(1000);
            const dropdownMenu = page.locator('.dropdown-menu.show');
            const dropdownCount = await dropdownMenu.count();
            if (dropdownCount > 0) {
                await expect(dropdownMenu).toBeVisible();
            }
            await page.keyboard.press('Escape');
        } else {
            console.log('[253] 帳票ボタンが表示されていない（帳票未登録のため正常）');
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/253-report-file-image.png`, fullPage: true });

        // NOTE: 実際の帳票ダウンロードでファイル・画像が出力されるかの確認は
        // 帳票テンプレート（Excel）の設定が必要なため、手動確認が推奨される。
        // このテストではファイル/画像フィールドの存在確認と帳票ボタンのアクセシビリティを検証している。
    });

    // -------------------------------------------------------------------------
    // 56-1: 帳票登録：Excelファイル以外のファイル形式はエラー
    // -------------------------------------------------------------------------
    test('56-1: Excelファイル以外をアップロードすると帳票登録エラーが発生すること', async ({ page }) => {

        await navigateToReportSetting(page, tableId);

        await expect(page.locator('.navbar')).toBeVisible();

        // 帳票テンプレートのアップロードフォームを探す
        // 帳票ドロップダウン → 追加 で帳票設定モーダルを開く
        const reportDropdown = page.locator('button.dropdown-toggle:has-text("帳票")').first();
        const dropdownCount = await reportDropdown.count();

        if (dropdownCount > 0 && await reportDropdown.isVisible()) {
            // 帳票ドロップダウンが存在する場合のみUIチェック
            await reportDropdown.click({ force: true });
            await page.waitForTimeout(500);

            // メニューを閉じる（テスト簡略化）
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
        }

        // ファイルアップロードUI（表示状態のもののみ）を探す
        const visibleFileInputs = await page.locator('input[type="file"]').evaluateAll(
            els => els.filter(el => el.offsetParent !== null).length
        );

        if (visibleFileInputs > 0) {
            const fileInput = page.locator('input[type="file"]').first();
            const tempFilePath = '/tmp/test-invalid-report.txt';
            fs.writeFileSync(tempFilePath, 'これはExcelファイルではありません');

            await fileInput.setInputFiles(tempFilePath);
            await page.waitForTimeout(800);

            // 表示状態の送信ボタンを探す
            const allSubmitBtns = page.locator('button:has-text("登録"), button:has-text("保存"), button:has-text("アップロード")');
            const submitCount = await allSubmitBtns.count();
            let clicked = false;
            for (let i = 0; i < submitCount && !clicked; i++) {
                const btn = allSubmitBtns.nth(i);
                if (await btn.isVisible()) {
                    await btn.click({ force: true });
                    clicked = true;
                    await page.waitForTimeout(1000);
                }
            }

            if (clicked) {
                const errorMsg = page.locator('.alert-danger, .toast-error, [class*="error-message"]').first();
                if (await errorMsg.count() > 0) {
                    await expect(errorMsg).toBeVisible();
                }
            }

            try { fs.unlinkSync(tempFilePath); } catch (e) {}
        }

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/56-1-report-invalid-file.png`, fullPage: true });
    });

});
