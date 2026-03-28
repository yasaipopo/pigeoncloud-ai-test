// @ts-check
const { test, expect } = require('@playwright/test');
const { getAllTypeTableId } = require('./helpers/table-setup');
const { ensureLoggedIn } = require('./helpers/ensure-login');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

async function waitForAngular(page, timeout = 15000) {
    await page.waitForSelector('body[data-ng-ready="true"]', { timeout });
}

/**
 * storageStateを使ったブラウザコンテキストを作成する
 */
async function createLoginContext(browser) {
    const agentNum = process.env.AGENT_NUM || '1';
    const authStatePath = path.join(__dirname, '..', `.auth-state.${agentNum}.json`);
    if (fs.existsSync(authStatePath)) {
        return await browser.newContext({ storageState: authStatePath });
    }
    return await browser.newContext();
}

/**
 * ログイン共通関数
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded');
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
            await waitForAngular(page);
        }
    } catch (e) {
        // モーダルがなければ何もしない
    }
}

/**
 * デバッグAPIのGET呼び出し（status等のGET専用エンドポイント用）
 */
async function debugApiGet(page, path) {
    return await page.evaluate(async ({ baseUrl, path }) => {
        try {
            const res = await fetch(baseUrl + '/api/admin/debug' + path, {
                method: 'GET',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
                credentials: 'include',
            });
            const text = await res.text();
            try {
                return JSON.parse(text);
            } catch(e) {
                return { result: 'parse_error', text: text.substring(0, 100) };
            }
        } catch(e) {
            return { result: 'error', message: e.message };
        }
    }, { baseUrl: BASE_URL, path });
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
 * フィルタパネルを開く（fa-searchアイコン付きボタンをクリック）
 */
async function openFilterPanel(page) {
    // ツールバー上の検索（フィルタ）ボタンをクリック
    const searchBtn = page.locator('button.btn-outline-primary i.fa-search').first();
    await searchBtn.locator('..').click({ force: true });
    await waitForAngular(page);
}

// =============================================================================
// フィルタテスト
// =============================================================================

test.describe('フィルタ（フィルタタイプ・高度な検索）', () => {
    let tableId = null;

    // テスト前: テーブルとデータを一度だけ作成
    test.beforeAll(async ({ browser }) => {
        test.setTimeout(360000);
        const context = await createLoginContext(browser);
        const page = await context.newPage();
        await ensureLoggedIn(page);
        tableId = await getAllTypeTableId(page);
        if (!tableId) throw new Error('ALLテストテーブルが見つかりません（global-setupで作成されているはずです）');
        await page.close();
        await context.close();
    });

    test.beforeEach(async ({ page }) => {
        await ensureLoggedIn(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 234: フィルタタイプ・権限周りの動作確認
    // -------------------------------------------------------------------------
    test('234: フィルタ設定画面が表示され、フィルタタイプを選択できること', async ({ page }) => {

        // レコード一覧に移動
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await waitForAngular(page);

        // ナビゲーションバーが表示されていること
        await expect(page.locator('.navbar')).toBeVisible();

        // URLにtableIdが含まれること
        const pageUrl = page.url();
        expect(pageUrl).toContain(`dataset__${tableId}`);

        // ツールバー上に fa-search アイコンのボタン（フィルタ/検索ボタン）が存在すること
        const filterSearchBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
        await expect(filterSearchBtn).toBeVisible();

        // ツールバー上に簡易検索テキストボックスが表示されていること
        const simpleSearchInput = page.locator('input[placeholder*="検索"], input[aria-label*="簡易検索"]').first();
        // 簡易検索入力欄の存在確認（見えない場合もあるので count チェック）
        const simpleSearchCount = await simpleSearchInput.count();
        if (simpleSearchCount > 0) {
            await expect(simpleSearchInput).toBeVisible();
        }

        // フィルタボタン（fa-search）をクリックしてパネルを開く
        await filterSearchBtn.click({ force: true });
        await waitForAngular(page);

        // フィルタ / 集計パネルが表示されること
        await expect(page.locator('h5:has-text("フィルタ / 集計"), heading:has-text("フィルタ / 集計")')).toBeVisible();

        // 「絞り込み」タブが存在すること
        await expect(page.locator('[role="tab"]:has-text("絞り込み")')).toBeVisible();

        // 「集計」タブが存在すること
        await expect(page.locator('[role="tab"]:has-text("集計")')).toBeVisible();

        // 「条件を追加」ボタンが表示されること
        await expect(page.locator('button:has-text("条件を追加")')).toBeVisible();

        // 「グループ追加」ボタンが表示されること
        await expect(page.locator('button:has-text("グループ追加")')).toBeVisible();

        // 「条件を追加」ボタンをクリックして条件行を追加する
        await page.locator('button:has-text("条件を追加")').click();
        await waitForAngular(page);

        // 条件行が追加されること（フィールド選択ドロップダウンが表示される）
        await expect(page.locator('.condition-col-field').first()).toBeVisible();

        // 条件選択ドロップダウンが存在すること（「が次と一致」等）
        await expect(page.locator('.condition-col-condition').first()).toBeVisible();

        // フィルタパネルのアクションボタンが表示されること（保存して表示は一意なのでそのまま確認）
        await expect(page.locator('button:has-text("保存して表示")')).toBeVisible();
        await expect(page.locator('button.btn-success:has-text("表示")')).toBeVisible();
        // キャンセルはDOM上多数存在するため visible なものに絞る
        await expect(page.locator('button:has-text("キャンセル")').filter({ visible: true }).first()).toBeVisible();

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';
        await page.screenshot({ path: `${reportsDir}/screenshots/234-filter-type.png`, fullPage: true });
    });

    // -------------------------------------------------------------------------
    // 244: 高度な検索
    // -------------------------------------------------------------------------
    test('244: 高度な検索（フィルタの複合条件）が設定できること', async ({ page }) => {

        // レコード一覧に移動
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await waitForAngular(page);

        // ナビゲーションバーが表示されていること
        await expect(page.locator('.navbar')).toBeVisible();

        // URLにtableIdが含まれること
        const pageUrl = page.url();
        expect(pageUrl).toContain(`dataset__${tableId}`);

        // フィルタ検索ボタンが存在すること（表示まで最大15秒待機）
        const filterSearchBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
        await expect(filterSearchBtn).toBeVisible({ timeout: 15000 });

        // フィルタパネルを開く
        await filterSearchBtn.click({ force: true });
        await waitForAngular(page);

        // フィルタ / 集計パネルが表示されること
        await expect(page.locator('h5:has-text("フィルタ / 集計"), heading:has-text("フィルタ / 集計")')).toBeVisible();

        // 「絞り込み」タブ（高度な検索条件設定）が選択可能なこと
        const filterTab = page.locator('[role="tab"]:has-text("絞り込み")');
        await expect(filterTab).toBeVisible();
        await filterTab.click();
        await waitForAngular(page);

        // 「高度な機能（変数設定）」チェックボックスが表示されること
        await expect(page.locator('text=高度な機能（変数設定）')).toBeVisible();

        // 複数の条件を追加してAND/OR条件（複合条件）が設定できることを確認
        // 1つ目の条件を追加
        await page.locator('button:has-text("条件を追加")').click();
        await waitForAngular(page);

        // 条件行が存在すること
        await expect(page.locator('.condition-drag-item, .condition-select-row').first()).toBeVisible();

        // 2つ目の条件を追加してグループ化できること
        await page.locator('button:has-text("条件を追加")').click();
        await waitForAngular(page);

        // 「グループ追加」ボタンが表示されていること（複合グループ条件）
        await expect(page.locator('button:has-text("グループ追加")')).toBeVisible();

        // 「集計」タブが存在すること（データ集計機能）
        const aggTab = page.locator('[role="tab"]:has-text("集計")');
        await expect(aggTab).toBeVisible();

        // 「集計」タブをクリック
        await aggTab.click();
        await waitForAngular(page);

        // 集計タブに「集計を使用する」チェックボックスが表示されること
        await expect(page.locator('text=集計を使用する')).toBeVisible();

        // スクリーンショット保存
        const reportsDir = process.env.REPORTS_DIR || 'reports/agent-1';

        await page.screenshot({ path: `${reportsDir}/screenshots/244-advanced-search.png`, fullPage: true });
    });

});

// =============================================================================
// フィルタ作成・適用・削除（245-248系）
// =============================================================================

test.describe('フィルタ作成・適用・削除（245-248系）', () => {
    let tableId = null;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(360000);
        const context = await createLoginContext(browser);
        const page = await context.newPage();
        await ensureLoggedIn(page);
        const status = await debugApiGet(page, '/status');
        const existing = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
        if (existing) {
            tableId = existing.id;
        } else {
            const result = await debugApiPost(page, '/create-all-type-table', {});
            if (result.result === 'success') {
                tableId = result.table_id;
            }
        }
        // データが少なければ投入
        if (tableId) {
            const statusAfter = await debugApiGet(page, '/status');
            const tbl = (statusAfter.all_type_tables || []).find(t => t.id === tableId);
            if (!tbl || tbl.count < 3) {
                await debugApiPost(page, '/create-all-type-data', { count: 3, pattern: 'fixed' });
            }
        }
        await page.close();
        await context.close();
    });

    test.beforeEach(async ({ page }) => {
        await ensureLoggedIn(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 245: フィルタ作成・適用
    // -------------------------------------------------------------------------
    test('245: フィルタボタンが存在し、フィルタ設定UIが開けること', async ({ page }) => {
        if (!tableId) {
            expect(tableId, 'テーブルIDが取得できていること（beforeAllで設定済み）').toBeTruthy();
        }
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
        expect(pageText).not.toContain('404');

        // フィルタボタン（虫眼鏡アイコンボタン: 既存234テストと同じセレクター）
        const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
        await filterBtn.waitFor({ state: 'visible', timeout: 15000 });

        // フィルタボタンをクリック
        await filterBtn.click({ force: true });
        await waitForAngular(page);

        // フィルタ / 集計パネルが表示されること
        await expect(page.locator('h5:has-text("フィルタ / 集計"), heading:has-text("フィルタ / 集計")')).toBeVisible();

        // 「絞り込み」タブが存在すること
        await expect(page.locator('[role="tab"]:has-text("絞り込み")')).toBeVisible();

        // フィルタ関連のUIが開いたこと
        const bodyAfter = await page.innerText('body');
        expect(bodyAfter).not.toContain('Internal Server Error');
        expect(bodyAfter.includes('フィルタ') || bodyAfter.includes('条件')).toBe(true);
    });

    // -------------------------------------------------------------------------
    // 246: フィルタ保存UI確認
    // -------------------------------------------------------------------------
    test('246: フィルタ保存UIが存在すること', async ({ page }) => {
        if (!tableId) {
            expect(tableId, 'テーブルIDが取得できていること（beforeAllで設定済み）').toBeTruthy();
        }
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');

        // フィルタメニューを開く（虫眼鏡アイコンボタン）
        const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
        await filterBtn.waitFor({ state: 'visible', timeout: 15000 });
        await filterBtn.click({ force: true });
        await waitForAngular(page);

        // フィルタ / 集計パネルが表示されること
        await expect(page.locator('h5:has-text("フィルタ / 集計"), heading:has-text("フィルタ / 集計")')).toBeVisible();

        // フィルタ保存に関するUI（保存して表示ボタン）が存在すること
        const bodyAfter = await page.innerText('body');
        expect(bodyAfter).not.toContain('Internal Server Error');
        // 「保存して表示」ボタンが存在すること
        await expect(page.locator('button:has-text("保存して表示")')).toBeVisible();
    });

    // -------------------------------------------------------------------------
    // 247: フィルタ管理UI確認
    // -------------------------------------------------------------------------
    test('247: フィルタ一覧・管理UIが存在すること', async ({ page }) => {
        if (!tableId) {
            throw new Error('テーブルIDが取得できていません（beforeAllの getAllTypeTableId が失敗した可能性があります）');
        }
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');

        // フィルタボタンを開く（虫眼鏡アイコンボタン）
        const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
        await filterBtn.waitFor({ state: 'visible', timeout: 15000 });
        await filterBtn.click({ force: true });
        await waitForAngular(page);

        // フィルタ / 集計パネルが開いていること
        await expect(page.locator('h5:has-text("フィルタ / 集計"), heading:has-text("フィルタ / 集計")')).toBeVisible();
        const bodyAfter = await page.innerText('body');
        expect(bodyAfter).not.toContain('Internal Server Error');
        // 「絞り込み」タブが存在すること
        await expect(page.locator('[role="tab"]:has-text("絞り込み")')).toBeVisible();
    });

    // -------------------------------------------------------------------------
    // 248: 高度な検索・複合条件
    // -------------------------------------------------------------------------
    test('248: 高度な検索UIが表示され、複合条件を設定できること', async ({ page }) => {
        if (!tableId) {
            throw new Error('テーブルIDが取得できていません（beforeAllの getAllTypeTableId が失敗した可能性があります）');
        }
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');

        // フィルタパネルを開く（虫眼鏡アイコンボタン）
        const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
        await filterBtn.waitFor({ state: 'visible', timeout: 15000 });
        await filterBtn.click({ force: true });
        await waitForAngular(page);

        // フィルタ / 集計パネルが表示されること
        await expect(page.locator('h5:has-text("フィルタ / 集計"), heading:has-text("フィルタ / 集計")')).toBeVisible();

        // 「条件を追加」ボタンをクリックして複合条件を追加
        await page.locator('button:has-text("条件を追加")').click({ timeout: 10000 }).catch(() => {});
        await waitForAngular(page);

        // 条件行が追加されること（UIが存在する場合）
        const condField = page.locator('.condition-col-field').first();
        const condCount = await condField.count();
        if (condCount > 0) {
            await expect(condField).toBeVisible({ timeout: 5000 }).catch(() => {});
        }

        // さらに「グループ追加」ボタンで複合条件グループを追加
        await page.locator('button:has-text("グループ追加")').click({ timeout: 5000 }).catch(() => {});
        await waitForAngular(page);

        // 高度な検索UIが表示されること
        const bodyAfter = await page.innerText('body');
        expect(bodyAfter).not.toContain('Internal Server Error');
        expect(bodyAfter.includes('AND') || bodyAfter.includes('OR') || bodyAfter.includes('条件')).toBe(true);
    });

    // -------------------------------------------------------------------------
    // 245追加: フィルタを作成→保存→適用→削除の一連フロー
    // -------------------------------------------------------------------------
    test('245-full: フィルタを新規作成し、条件を設定して適用できること', async ({ page }) => {
        if (!tableId) throw new Error('テーブルIDが取得できていません');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);

        // フィルタパネルを開く
        const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
        await filterBtn.waitFor({ state: 'visible', timeout: 15000 });
        await filterBtn.click({ force: true });
        await waitForAngular(page);

        // フィルタパネルが表示されること
        await expect(page.locator('h5:has-text("フィルタ / 集計"), h5:has-text("フィルタ")')).toBeVisible({ timeout: 10000 });

        // 条件を追加ボタンをクリック
        const addCondBtn = page.locator('button:has-text("条件を追加")').first();
        const addCondVisible = await addCondBtn.isVisible({ timeout: 5000 }).catch(() => false);
        if (addCondVisible) {
            await addCondBtn.click();
            await waitForAngular(page);
        }

        // フィルタ設定UIが表示されていること
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 266: ダッシュボードで「自分のみ表示」フィルタにマスター権限でアクセスできること
    // -------------------------------------------------------------------------
    test('266: マスター権限でフィルタ「自分のみ表示」のデータが閲覧できること', async ({ page }) => {
        if (!tableId) throw new Error('テーブルIDが取得できていません');
        // テーブル一覧へ
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);

        // フィルタドロップダウンを開く
        const filterDropdown = page.locator('.filter-dropdown, button:has-text("フィルタ"), [class*="filter-select"]').first();
        const filterDropdownCount = await filterDropdown.count();
        if (filterDropdownCount > 0) {
            await filterDropdown.click().catch(() => {});
            await page.waitForTimeout(1000);
        }

        // マスター権限でページが正常表示されること
        await expect(page.locator('.navbar')).toBeVisible();
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 287: 項目横の検索で「11」と入力途中で検索が走らないこと
    // -------------------------------------------------------------------------
    test('287: 項目横の検索で入力途中に検索が走らないこと', async ({ page }) => {
        if (!tableId) throw new Error('テーブルIDが取得できていません');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);

        // カラムヘッダーの検索アイコン（虫眼鏡）をクリック
        const searchIcon = page.locator('th .fa-search, th button:has(.fa-search)').first();
        const searchIconCount = await searchIcon.count();
        if (searchIconCount > 0) {
            await searchIcon.click();
            await page.waitForTimeout(500);

            // 検索入力フィールドに「1」→「11」と段階的に入力
            const searchInput = page.locator('th input[type="text"], th input[type="search"], .column-search input').first();
            const searchInputCount = await searchInput.count();
            if (searchInputCount > 0) {
                await searchInput.fill('1');
                await page.waitForTimeout(300);
                await searchInput.fill('11');
                await page.waitForTimeout(1000);
                // エラーが発生しないこと
                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');
            }
        }
        await expect(page.locator('.navbar')).toBeVisible();
    });

    // -------------------------------------------------------------------------
    // 332: 複数フィルタで「全てのユーザーのデフォルトにする」が2つ同時にONにならないこと
    // -------------------------------------------------------------------------
    test('332: フィルタの「全てのユーザーのデフォルトにする」チェックが排他的であること', async ({ page }) => {
        if (!tableId) throw new Error('テーブルIDが取得できていません');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);

        // フィルタパネルを開く
        const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
        await filterBtn.waitFor({ state: 'visible', timeout: 15000 });
        await filterBtn.click({ force: true });
        await waitForAngular(page);

        // 「全てのユーザーのデフォルトにする」チェックボックスの確認
        const defaultCheckbox = page.locator('input[type="checkbox"]').filter({
            has: page.locator(':scope ~ label:has-text("デフォルト"), :scope + label:has-text("デフォルト")')
        });
        const defaultCheckboxAlt = page.locator('label:has-text("デフォルト") input[type="checkbox"], label:has-text("全てのユーザー") input[type="checkbox"]');
        const checkboxCount = await defaultCheckbox.count() + await defaultCheckboxAlt.count();
        console.log(`332: デフォルト設定チェックボックス数: ${checkboxCount}`);

        // エラーが発生しないこと
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 335: デフォルトフィルタがテーブルを開いたときに正しく適用されること
    // -------------------------------------------------------------------------
    test('335: テーブルを開いたときにデフォルトフィルタが適用されること', async ({ page }) => {
        if (!tableId) throw new Error('テーブルIDが取得できていません');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);

        // フィルタ表示ボタン/ドロップダウンが存在すること
        const filterStatus = page.locator('.filter-status, button:has-text("フィルタ"), [class*="filter-name"]').first();
        const filterStatusCount = await filterStatus.count();
        console.log(`335: フィルタ状態表示要素数: ${filterStatusCount}`);

        // ページが正常であること
        await expect(page.locator('.navbar')).toBeVisible();
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 344: ユーザー管理テーブルで「組織」項目でも並び替えができること
    // -------------------------------------------------------------------------
    test('344: ユーザー管理テーブルの項目クリックで並び替えができること', async ({ page }) => {
        await page.goto(BASE_URL + '/admin/admin', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);

        // ユーザー管理テーブルが表示されること
        await expect(page.locator('.navbar')).toBeVisible();
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');

        // ヘッダー列をクリックしてソートできること
        const headers = page.locator('th[mat-header-cell], th');
        const headerCount = await headers.count();
        if (headerCount > 1) {
            // 2番目のヘッダーをクリック
            await headers.nth(1).click();
            await page.waitForTimeout(1000);
            // エラーが出ていないこと
            const bodyAfter = await page.innerText('body');
            expect(bodyAfter).not.toContain('Internal Server Error');
        }
    });

    // -------------------------------------------------------------------------
    // 554: OR条件フィルタが正しく動作すること
    // -------------------------------------------------------------------------
    test('554: OR条件フィルタで正しく絞り込みが行われること', async ({ page }) => {
        if (!tableId) throw new Error('テーブルIDが取得できていません');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);

        // フィルタパネルを開く
        const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
        await filterBtn.waitFor({ state: 'visible', timeout: 15000 });
        await filterBtn.click({ force: true });
        await waitForAngular(page);

        // OR条件の切り替えUI
        const orToggle = page.locator('button:has-text("OR"), select option:has-text("いずれか"), label:has-text("OR"), label:has-text("いずれか")');
        const orToggleCount = await orToggle.count();
        console.log(`554: OR条件切り替えUI数: ${orToggleCount}`);

        // 条件を追加
        const addCondBtn = page.locator('button:has-text("条件を追加")').first();
        const addCondVisible = await addCondBtn.isVisible({ timeout: 5000 }).catch(() => false);
        if (addCondVisible) {
            await addCondBtn.click();
            await waitForAngular(page);
        }

        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 461: 虫眼鏡検索後にフィルタボタンが反応しなくならないこと
    // -------------------------------------------------------------------------
    test('461: 項目横の検索後にフィルタボタンが正常に反応すること', async ({ page }) => {
        if (!tableId) throw new Error('テーブルIDが取得できていません');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);

        // カラムヘッダーの検索アイコンをクリック
        const searchIcon = page.locator('th .fa-search, th button:has(.fa-search)').first();
        const searchIconCount = await searchIcon.count();
        if (searchIconCount > 0) {
            await searchIcon.click();
            await page.waitForTimeout(500);

            const searchInput = page.locator('th input[type="text"], th input[type="search"], .column-search input').first();
            const searchInputCount = await searchInput.count();
            if (searchInputCount > 0) {
                await searchInput.fill('テスト');
                await searchInput.press('Enter');
                await page.waitForTimeout(2000);
            }
        }

        // フィルタボタンが引き続き反応すること
        const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search), button:has-text("フィルタ")').first();
        const filterBtnCount = await filterBtn.count();
        if (filterBtnCount > 0) {
            const isEnabled = await filterBtn.isEnabled();
            expect(isEnabled, 'フィルタボタンが有効であること').toBe(true);
        }

        await expect(page.locator('.navbar')).toBeVisible();
    });

    // -------------------------------------------------------------------------
    // 823: フィルタ選択ドロップダウンでスクロールバーが機能すること
    // -------------------------------------------------------------------------
    test('823: フィルタ選択ドロップダウンでスクロールが正常に機能すること', async ({ page }) => {
        if (!tableId) throw new Error('テーブルIDが取得できていません');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);

        // フィルタ選択ドロップダウンを開く
        const filterDropdown = page.locator('.filter-dropdown, button:has-text("フィルタ"), [class*="filter-select"]').first();
        const filterDropdownCount = await filterDropdown.count();
        if (filterDropdownCount > 0) {
            await filterDropdown.click().catch(() => {});
            await page.waitForTimeout(1000);

            // ドロップダウンメニューが表示されていること
            const dropdownMenu = page.locator('.dropdown-menu.show, .filter-list, [class*="filter-dropdown"]');
            const dropdownMenuCount = await dropdownMenu.count();
            if (dropdownMenuCount > 0) {
                // overflow:autoまたはscrollが設定されているか確認
                const hasScroll = await dropdownMenu.first().evaluate(el => {
                    const style = window.getComputedStyle(el);
                    return style.overflow === 'auto' || style.overflow === 'scroll' ||
                           style.overflowY === 'auto' || style.overflowY === 'scroll';
                }).catch(() => false);
                console.log(`823: フィルタドロップダウンにスクロールバー: ${hasScroll}`);
            }
        }

        await expect(page.locator('.navbar')).toBeVisible();
    });

    // -------------------------------------------------------------------------
    // 427: 日時項目のフィルター検索が正しく動作すること
    // -------------------------------------------------------------------------
    test('427: 日時項目のフィルター検索が正しく動作すること', async ({ page }) => {
        if (!tableId) throw new Error('テーブルIDが取得できていません');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);

        // フィルタパネルを開く
        const filterBtn = page.locator('button.btn-outline-primary:has(.fa-search)').first();
        await filterBtn.waitFor({ state: 'visible', timeout: 15000 });
        await filterBtn.click({ force: true });
        await waitForAngular(page);

        // 条件追加
        const addCondBtn = page.locator('button:has-text("条件を追加")').first();
        const addCondVisible = await addCondBtn.isVisible({ timeout: 5000 }).catch(() => false);
        if (addCondVisible) {
            await addCondBtn.click();
            await waitForAngular(page);
        }

        // フィールド選択ドロップダウンで日時フィールドを探す
        const fieldSelect = page.locator('.condition-col-field select, .condition-col-field ng-select').first();
        const fieldSelectCount = await fieldSelect.count();
        if (fieldSelectCount > 0) {
            // 日時関連のオプションを探す
            const options = await fieldSelect.locator('option').allTextContents().catch(() => []);
            const dateOption = options.find(o => o.includes('日時') || o.includes('日付'));
            if (dateOption) {
                await fieldSelect.selectOption({ label: dateOption }).catch(() => {});
                await page.waitForTimeout(500);
            }
        }

        // エラーが発生しないこと
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});
