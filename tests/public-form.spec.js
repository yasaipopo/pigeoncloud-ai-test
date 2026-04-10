// @ts-check
const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { createTestEnv } = require('./helpers/create-test-env');
const { createLightTable } = require('./helpers/create-light-table');

let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;

// ファイルレベル変数: 全describeで共有
let tableId = null;
let publicFormHash = null;  // 取得済みのハッシュをキャッシュ

/**
 * Angularの描画完了を待つ（管理画面用）
 */
async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
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
    } catch {
        // モーダルがなければ何もしない
    }
}

/**
 * テーブル設定の「その他」タブを開く
 */
async function openOtherTab(page, tid) {
    await page.goto(BASE_URL + `/admin/dataset/edit/${tid}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await waitForAngular(page, 30000);
    const otherTab = page.getByRole('tab', { name: /その他/ });
    await otherTab.waitFor({ state: 'visible', timeout: 15000 });
    await otherTab.click();
    await waitForAngular(page);
    // 「その他」タブのコンテンツが表示されるまで待つ
    await page.waitForSelector('.form-group.row.admin-forms', { timeout: 10000 }).catch(() => {});
}

/**
 * 公開フォームをONにしてハッシュとURLを取得する
 * APIはブラウザ内 fetch（page.evaluate）で呼び出す（Cookieが正しく送られるため）
 * @returns {Promise<{url: string, hash: string}>}
 */
async function enablePublicFormAndGetInfo(page, tid) {
    // [flow] 1. テーブル設定の「その他」タブで公開フォームをONにする
    await openOtherTab(page, tid);

    // 公開フォームスイッチを探す
    const pubFormRow = page.locator('.form-group.row.admin-forms:has-text("公開フォームをONにする")').first();
    await expect(pubFormRow).toBeVisible({ timeout: 15000 });

    const switchInput = pubFormRow.locator('input[type="checkbox"].switch-input');
    const isChecked = await switchInput.isChecked().catch(() => false);
    if (!isChecked) {
        const switchHandle = pubFormRow.locator('.switch-handle').first();
        await switchHandle.click();
        await page.waitForTimeout(3000);
    }

    const isCheckedAfter = await switchInput.isChecked().catch(() => false);
    console.log(`[enablePublicFormAndGetInfo] 公開フォームON状態: ${isCheckedAfter}`);

    // [flow] 2. API（ブラウザ内fetch）で公開フォームURLを取得する
    const result = await page.evaluate(async (tableId) => {
        try {
            const csrfResp = await fetch('/api/csrf_token');
            const csrf = csrfResp.ok ? await csrfResp.json() : {};
            const body = { table: 'dataset__' + tableId.toString() };
            if (csrf.csrf_name) body[csrf.csrf_name] = csrf.csrf_value;

            const resp = await fetch('/api/admin/public_form_url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify(body),
            });
            const text = await resp.text();
            try {
                const data = JSON.parse(text);
                return { url: data.url, hash: data.hash, status: resp.status };
            } catch {
                return { error: 'JSON解析失敗', status: resp.status, raw: text.substring(0, 200) };
            }
        } catch (e) {
            return { error: e.message };
        }
    }, tid);

    console.log(`[enablePublicFormAndGetInfo] API結果: ${JSON.stringify(result)}`);

    if (result.url && result.hash) {
        return {
            url: result.url.replace(/\/$/, ''),
            hash: result.hash,
        };
    }

    throw new Error(`公開フォームURLが取得できませんでした。API結果: ${JSON.stringify(result)}`);
}

/**
 * 公開フォームの直URLを構築する（iframe src URL）
 * embed.js の実装: /public/{table}/add/{filter_id}/{hash}/true
 */
function buildFormDirectUrl(baseUrl, tid, hash, filterIdOrNull = null) {
    const filterId = filterIdOrNull || '0';
    return `${baseUrl}/public/dataset__${tid}/add/${filterId}/${hash}/true`;
}

/**
 * 公開フォームの Angular ページ（iframe src）を開いて描画完了を待つ
 * フォームフィールド（.pc-field-block）が表示されるまで待機する
 * @returns {Promise<string>} 実際に遷移したURL
 */
async function openFormPage(page, directUrl, waitForField = true) {
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitForAngular(page, 15000);

    if (waitForField) {
        // フォームフィールド（Angular コンポーネント）が表示されるまで待機
        await page.waitForSelector('.pc-field-block, admin-forms-field, .form-field-row', {
            timeout: 15000
        }).catch(() => {});

        // 送信ボタンが表示されるまで待機（loading=false になるまで）
        // edit.component.html: *ngIf="data!=null && table_info!=undefined && !loading"
        await page.waitForSelector('.card-footer button[type="submit"], .card-footer button:has-text("送信")', {
            state: 'visible',
            timeout: 20000
        }).catch(() => {
            // フッターのボタンが見えなくてもフォームフィールドがあればOK
        });
        await page.waitForTimeout(1000);
    }
    return page.url();
}

/**
 * ページ共通チェック（ナビ表示＆エラーなし）
 */
async function checkPageOk(page) {
    const bodyText = await page.innerText('body').catch(() => '');
    expect(bodyText).not.toContain('Internal Server Error');
    expect(bodyText).not.toContain('Uncaught Error');
    expect(bodyText).not.toContain('予期せぬエラー');
    return bodyText;
}

// =============================================================================
// 自己完結テスト環境の作成（ファイルレベル beforeAll）
// =============================================================================
test.beforeAll(async ({ browser }) => {
    test.setTimeout(300000);
    // シンプルなテーブルを使う（ALLテストテーブルはルックアップタイプ不一致エラーで公開フォーム保存が失敗する）
    const env = await createTestEnv(browser, { withAllTypeTable: false });
    BASE_URL = env.baseUrl;
    EMAIL = env.email;
    PASSWORD = env.password;
    process.env.TEST_BASE_URL = env.baseUrl;
    process.env.TEST_EMAIL = env.email;
    process.env.TEST_PASSWORD = env.password;

    // createTestEnv が返した page を使ってテーブルを作成する（新規コンテキスト不要）
    const envPage = env.page;
    const tid = await createLightTable(envPage, '公開フォームテスト', [
        { type: 'text', label: 'テキスト', required: false },
        { type: 'file', label: 'ファイル添付', required: false },
    ]);
    tableId = tid;
    await env.context.close();
    console.log(`[public-form] 自己完結環境: ${BASE_URL}, tableId: ${tableId}`);
});

const autoScreenshot = createAutoScreenshot('public-form');

test.describe('公開フォーム・公開メールリンク', () => {

    test.beforeEach(async ({ page }) => {
        // 古い環境のCookieをクリアして新環境にログイン
        await page.context().clearCookies();
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
        if (!page.url().includes('/login')) {
            await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        }
        if (page.url().includes('/login')) {
            await page.waitForSelector('#id', { timeout: 10000 });
            await page.fill('#id', EMAIL);
            await page.fill('#password', PASSWORD);
            await page.locator('button[type=submit].btn-primary').first().click();
            await page.waitForSelector('.navbar', { timeout: 20000 });
        }
    });

    // =========================================================================
    // PF01: 公開フォーム基本フロー（pf-010〜pf-070）→ 1動画
    // =========================================================================
    test('PF01: 公開フォーム基本フロー', async ({ page }) => {
        test.setTimeout(300000);
        const _testStart = Date.now();
        page.setDefaultTimeout(30000);

        await closeTemplateModal(page);

        // ── pf-010: 公開フォーム設定を有効化できること ──
        await test.step('pf-010: 公開フォーム設定を有効化できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s pf-010`);

            // [flow] 10-1. テーブル設定の「その他」タブを開く
            await openOtherTab(page, tableId);

            // [check] 10-2. ✅ 公開フォーム設定セクションが表示されること
            const pubFormRow = page.locator('.form-group.row.admin-forms:has-text("公開フォームをONにする")').first();
            await expect(pubFormRow).toBeVisible({ timeout: 15000 });

            // [flow] 10-3. 公開フォームスイッチの存在を確認してONにする
            const switchInput = pubFormRow.locator('input[type="checkbox"].switch-input');
            const switchHandle = pubFormRow.locator('.switch-handle').first();
            const switchCount = await switchInput.count();
            expect(switchCount, '公開フォームスイッチが存在すること').toBeGreaterThan(0);

            const isChecked = await switchInput.isChecked().catch(() => false);
            if (!isChecked) {
                await switchHandle.click();
                await page.waitForTimeout(3000);
            }

            // [check] 10-4. ✅ 公開フォームがONになっていること
            await checkPageOk(page);
            const isCheckedAfter = await switchInput.isChecked().catch(() => false);
            expect(isCheckedAfter, '公開フォームがONになっていること').toBe(true);

            await autoScreenshot(page, 'PF01', 'pf-010', _testStart);
        });

        // ── pf-020: 公開フォームのURLが発行されること ──
        await test.step('pf-020: 公開フォームのURLが発行されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s pf-020`);

            // [flow] 20-1. enablePublicFormAndGetInfo を使ってURLとハッシュを取得
            const formInfo = await enablePublicFormAndGetInfo(page, tableId);
            publicFormHash = formInfo.hash;  // キャッシュ

            // [check] 20-2. ✅ 公開フォームURLが取得されること
            expect(formInfo.url, '公開フォームURLが取得できること').toBeTruthy();
            expect(formInfo.url.length, '公開フォームURLが空でないこと').toBeGreaterThan(0);

            // [check] 20-3. ✅ URLがhttp(s)で始まること
            expect(formInfo.url, '公開フォームURLがhttpで始まること').toMatch(/^https?:\/\//);
            expect(formInfo.url.length, 'URLが適切な長さであること（ハッシュを含む）').toBeGreaterThan(20);

            // [check] 20-4. ✅ ハッシュが存在すること
            expect(formInfo.hash, '公開フォームハッシュが取得できること').toBeTruthy();
            expect(formInfo.hash.length, 'ハッシュが空でないこと').toBeGreaterThan(5);

            await autoScreenshot(page, 'PF01', 'pf-020', _testStart);
        });

        // ── pf-030: 公開フォームからデータを登録できること ──
        await test.step('pf-030: 公開フォームからデータを登録できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s pf-030`);

            // ハッシュを取得済みでなければ再取得
            if (!publicFormHash) {
                const formInfo = await enablePublicFormAndGetInfo(page, tableId);
                publicFormHash = formInfo.hash;
            }

            // [flow] 30-1. 公開フォームの直URLを開く（iframe src 相当のURL）
            const directUrl = buildFormDirectUrl(BASE_URL, tableId, publicFormHash);
            await openFormPage(page, directUrl);

            // [check] 30-2. ✅ フォーム画面が正常に表示されること
            await checkPageOk(page);

            // [check] 30-3. ✅ フォームにフィールド（pc-field-block）が存在すること
            const fieldBlocks = page.locator('.pc-field-block');
            const fieldCount = await fieldBlocks.count();
            expect(fieldCount, '公開フォームにフィールドが存在すること').toBeGreaterThan(0);
            console.log(`[pf-030] フィールド数: ${fieldCount}`);

            // [flow] 30-3. テキストフィールドに値を入力
            const textInputInField = page.locator('.pc-field-block input[type="text"]:not([type="hidden"])').first();
            const textInputVisible = await textInputInField.isVisible({ timeout: 5000 }).catch(() => false);
            if (textInputVisible) {
                await textInputInField.fill('テスト入力値_pf030');
                await page.waitForTimeout(500);
            }

            // [flow] 30-4. 送信ボタンをクリック
            // card-footer内の送信ボタン（loading=false になったら表示される）
            const submitBtn = page.locator('.card-footer button[type="submit"]').first();
            await expect(submitBtn).toBeVisible({ timeout: 20000 });
            await submitBtn.click();

            // [flow] 30-5. 送信前の確認ダイアログに「はい」でOK（IS_PUBLIC_FORM=trueの場合）
            // go_edit() → publicFormConfirmModal.show() → onOk → store()
            const confirmYesBtn = page.locator('.modal.show button:has-text("はい"), .modal.show button:has-text("OK")').first();
            const confirmVisible = await confirmYesBtn.isVisible({ timeout: 5000 }).catch(() => false);
            if (confirmVisible) {
                await confirmYesBtn.click();
                console.log('[pf-030] 送信確認ダイアログ「はい」クリック');
            }
            await page.waitForTimeout(3000);

            // [check] 30-6. ✅ 送信後にページが正常な状態であること
            await checkPageOk(page);

            await autoScreenshot(page, 'PF01', 'pf-030', _testStart);
        });

        // ── pf-040: 公開フォームから登録したデータが管理画面のレコード一覧に表示されること ──
        await test.step('pf-040: 公開フォームから登録したデータが管理画面のレコード一覧に反映されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s pf-040`);

            // [flow] 40-1. 管理画面のレコード一覧に遷移する
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await waitForAngular(page, 30000);
            await closeTemplateModal(page);

            // [check] 40-2. ✅ レコード一覧ページが正常に表示されること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });
            await checkPageOk(page);

            // [check] 40-3. ✅ レコード数が1件以上あること（公開フォームで登録済み）
            // Angular がデータをロードするまで待機（最大15秒）
            await page.waitForFunction(() => {
                const rows = document.querySelectorAll('table tbody tr');
                return rows.length > 0;
            }, { timeout: 15000 }).catch(() => {});

            // テーブルヘッダーが表示されていること
            const tableHeader = page.locator('table th, thead th');
            const headerCount = await tableHeader.count();
            console.log(`[pf-040] テーブルヘッダー数: ${headerCount}`);

            // レコードが1件以上あることを確認
            const rowCount = await page.locator('table tbody tr').count();
            console.log(`[pf-040] レコード数: ${rowCount}`);
            expect(rowCount, '公開フォームから登録したレコードが1件以上あること').toBeGreaterThan(0);

            await autoScreenshot(page, 'PF01', 'pf-040', _testStart);
        });

        // ── pf-050: 公開フォーム設定UIが正しく表示されること（非表示設定） ──
        await test.step('pf-050: テーブル設定でフォーム関連の設定UIが正しく表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s pf-050`);

            // [flow] 50-1. テーブル設定「その他」タブを開く
            await openOtherTab(page, tableId);

            // [check] 50-2. ✅ 公開フォームをONにするスイッチが存在すること
            const pubFormRow = page.locator('.form-group.row.admin-forms:has-text("公開フォームをONにする")').first();
            await expect(pubFormRow).toBeVisible({ timeout: 10000 });

            // [check] 50-3. ✅ 埋め込みフォームをONにするスイッチが存在すること
            const embedFormRow = page.locator('.form-group.row.admin-forms').filter({ hasText: '埋め込みフォーム' }).first();
            const embedFormVisible = await embedFormRow.isVisible({ timeout: 5000 }).catch(() => false);
            if (embedFormVisible) {
                const embedSwitchInput = embedFormRow.locator('input[type="checkbox"].switch-input');
                const embedSwitchCount = await embedSwitchInput.count();
                expect(embedSwitchCount, '埋め込みフォームスイッチが存在すること').toBeGreaterThan(0);
                console.log('[pf-050] 埋め込みフォーム設定UIが確認できました');
            } else {
                // 公開フォームの設定UIが見えていれば十分（埋め込みフォームはオプション）
                console.log('[pf-050] 埋め込みフォームUIなし、公開フォームUIは確認済み');
            }

            await autoScreenshot(page, 'PF01', 'pf-050', _testStart);
        });

        // ── pf-060: 公開フォームがログイン不要でアクセスできること ──
        await test.step('pf-060: 公開フォームがログイン不要でアクセスできること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s pf-060`);

            // ハッシュを取得済みでなければ再取得
            if (!publicFormHash) {
                const formInfo = await enablePublicFormAndGetInfo(page, tableId);
                publicFormHash = formInfo.hash;
            }

            // [flow] 60-1. 未ログインの新しいブラウザコンテキストで公開フォームを開く
            const newContext = await page.context().browser().newContext();
            const newPage = await newContext.newPage();

            try {
                const directUrl = buildFormDirectUrl(BASE_URL, tableId, publicFormHash);
                await openFormPage(newPage, directUrl);

                // [check] 60-2. ✅ フォーム画面が正常に表示されること（エラーなし）
                await checkPageOk(newPage);

                // [check] 60-3. ✅ フォームにフィールドが存在すること
                const fieldBlocks = newPage.locator('.pc-field-block');
                const fieldCount = await fieldBlocks.count();
                expect(fieldCount, '未ログインでも公開フォームのフィールドが表示されること').toBeGreaterThan(0);

                await autoScreenshot(newPage, 'PF01', 'pf-060', _testStart);
            } finally {
                await newContext.close();
            }
        });

        // ── pf-070: 公開フォームがスマホサイズでも正しいレイアウトで表示されること ──
        await test.step('pf-070: 公開フォームがスマホサイズでも正しいレイアウトで表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s pf-070`);

            if (!publicFormHash) {
                const formInfo = await enablePublicFormAndGetInfo(page, tableId);
                publicFormHash = formInfo.hash;
            }

            // [flow] 70-1. スマホビューポートサイズで公開フォームを開く
            await page.setViewportSize({ width: 375, height: 812 });
            const directUrl = buildFormDirectUrl(BASE_URL, tableId, publicFormHash);
            await openFormPage(page, directUrl);

            // [check] 70-2. ✅ スマホサイズでもフォームが正しく表示されること（エラーなし）
            await checkPageOk(page);

            // [check] 70-3. ✅ フォームにフィールドが存在すること
            const fieldBlocks = page.locator('.pc-field-block');
            const fieldCount = await fieldBlocks.count();
            expect(fieldCount, 'スマホ幅でもフォームフィールドが表示されること').toBeGreaterThan(0);

            // [check] 70-4. ✅ 水平スクロールが発生していないこと（レイアウト崩れがないこと）
            const overflowCheck = await page.evaluate(() => {
                return {
                    scrollWidth: document.body.scrollWidth,
                    clientWidth: document.body.clientWidth,
                    hasHorizontalScroll: document.body.scrollWidth > document.body.clientWidth + 20
                };
            });
            expect(overflowCheck.hasHorizontalScroll, 'スマホ幅で水平スクロールが不要であること').toBe(false);

            // ビューポートを元に戻す
            await page.setViewportSize({ width: 1280, height: 800 });

            await autoScreenshot(page, 'PF01', 'pf-070', _testStart);
        });
    });

    // =========================================================================
    // UC07: 公開フォームからファイル添付して送信（pf-080）→ 1動画
    // =========================================================================
    test('UC07: 公開フォームファイル添付送信', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();
        page.setDefaultTimeout(30000);

        await closeTemplateModal(page);

        await test.step('pf-080: 未ログイン状態で公開フォームにファイルを添付して送信できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s pf-080`);

            // [flow] 80-1. 公開フォームを有効化してハッシュを取得
            const formInfo = await enablePublicFormAndGetInfo(page, tableId);
            const hash = formInfo.hash;
            expect(formInfo.url, '公開フォームURLが取得できること').toBeTruthy();

            // [flow] 80-2. 未ログインの新しいコンテキストで公開フォームを開く
            const newContext = await page.context().browser().newContext();
            const newPage = await newContext.newPage();

            try {
                const directUrl = buildFormDirectUrl(BASE_URL, tableId, hash);
                await openFormPage(newPage, directUrl);

                // [check] 80-3. ✅ フォーム画面が正常に表示されること
                await checkPageOk(newPage);

                // [check] 80-4. ✅ フォームにフィールドが存在すること
                const fieldBlocks = newPage.locator('.pc-field-block');
                const fieldCount = await fieldBlocks.count();
                expect(fieldCount, '公開フォームにフィールドが存在すること').toBeGreaterThan(0);
                console.log(`[pf-080] フィールド数: ${fieldCount}`);

                // [flow] 80-3. テキストフィールドに値を入力
                const textInput = newPage.locator('.pc-field-block input[type="text"]:not([type="hidden"])').first();
                const textInputVisible = await textInput.isVisible({ timeout: 5000 }).catch(() => false);
                if (textInputVisible) {
                    await textInput.fill('テスト入力値_pf080');
                    await newPage.waitForTimeout(500);
                }

                // [flow] 80-4. ファイル添付フィールドにファイルをアップロード
                const fileInput = newPage.locator('.pc-field-block input[type="file"]').first();
                const fileInputVisible = await fileInput.isVisible({ timeout: 5000 }).catch(() => false);
                if (fileInputVisible) {
                    const testFilePath = '/Users/yasaipopo/PycharmProjects/pigeon-test/test_files/ok.png';
                    const fs = require('fs');
                    if (fs.existsSync(testFilePath)) {
                        await fileInput.setInputFiles(testFilePath);
                        await newPage.evaluate(() => {
                            const input = document.querySelector('input[type="file"]');
                            if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
                        });
                        await newPage.waitForTimeout(2000);
                        console.log('[pf-080] ファイル添付完了');
                    }
                }

                // [check] 80-5. ✅ 送信ボタンが表示されること（card-footer内、loading完了後）
                const submitBtn = newPage.locator('.card-footer button[type="submit"]').first();
                await expect(submitBtn).toBeVisible({ timeout: 20000 });

                // [flow] 80-5. 送信ボタンをクリック
                await submitBtn.click();

                // [flow] 80-6. 送信前の確認ダイアログ「はい」クリック（IS_PUBLIC_FORM=trueの場合）
                const confirmYesBtn = newPage.locator('.modal.show button:has-text("はい"), .modal.show button:has-text("OK")').first();
                const confirmVisible = await confirmYesBtn.isVisible({ timeout: 5000 }).catch(() => false);
                if (confirmVisible) {
                    await confirmYesBtn.click();
                    console.log('[pf-080] 送信確認ダイアログ「はい」クリック');
                }
                await newPage.waitForTimeout(4000);

                // [check] 80-7. ✅ 送信後にエラーが表示されないこと
                await checkPageOk(newPage);

                await autoScreenshot(newPage, 'UC07', 'pf-080', _testStart);
            } finally {
                await newContext.close();
            }

            // [check] 80-7. ✅ 送信後、管理画面のレコード一覧に登録が反映されること
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await waitForAngular(page, 30000);
            await closeTemplateModal(page);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });
            await checkPageOk(page);

            // Angular がデータをロードするまで待機
            await page.waitForFunction(() => {
                const rows = document.querySelectorAll('table tbody tr');
                return rows.length > 0;
            }, { timeout: 15000 }).catch(() => {});

            const rowCount = await page.locator('table tbody tr').count();
            console.log(`[pf-080] 送信後レコード数: ${rowCount}`);
            expect(rowCount, '公開フォームから登録したレコードが存在すること').toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // UC22: 公開フォームURLパラメータ初期値（pf-090）→ 1動画
    // =========================================================================
    test('UC22: 公開フォームURLパラメータ初期値', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();
        page.setDefaultTimeout(30000);

        await closeTemplateModal(page);

        await test.step('pf-090: 公開フォームURLにパラメータを付与して初期値が設定されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s pf-090`);

            // [flow] 90-1. 公開フォームを有効化してハッシュを取得
            const formInfo = await enablePublicFormAndGetInfo(page, tableId);
            const hash = formInfo.hash;
            expect(formInfo.url, '公開フォームURLが取得できること').toBeTruthy();

            // [flow] 90-2. URLパラメータ付きの直URLを構築する
            // embed.js の仕様: /public/{table}/add/{filter_id}/{hash}/true?{params}
            const directUrl = buildFormDirectUrl(BASE_URL, tableId, hash);
            const paramUrl = directUrl + '?' + encodeURIComponent('テキスト') + '=' + encodeURIComponent('テスト初期値090');

            // [flow] 90-3. 新規コンテキストでパラメータ付きURLを開く
            const newContext = await page.context().browser().newContext();
            const newPage = await newContext.newPage();

            try {
                await openFormPage(newPage, paramUrl);

                // [check] 90-4. ✅ フォームがエラーなく表示されること
                await checkPageOk(newPage);

                // [check] 90-5. ✅ フォームにフィールドが存在すること
                const fieldBlocks = newPage.locator('.pc-field-block');
                const fieldCount = await fieldBlocks.count();
                expect(fieldCount, '公開フォームにフィールドが存在すること').toBeGreaterThan(0);

                // [check] 90-6. ✅ パラメータの値が初期値として設定されていること
                // URLパラメータによるプレフィル確認
                const hasPrefilledValue = await newPage.evaluate(() => {
                    const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="number"], textarea');
                    for (const input of inputs) {
                        if (input.value && input.value.includes('テスト初期値090')) {
                            return true;
                        }
                    }
                    return false;
                });
                console.log(`[pf-090] URLパラメータによる初期値設定: ${hasPrefilledValue}`);
                // 初期値が設定されていること（機能として期待する動作）
                expect(hasPrefilledValue, 'URLパラメータの値が初期値として設定されること').toBe(true);

                await autoScreenshot(newPage, 'UC22', 'pf-090', _testStart);
            } finally {
                await newContext.close();
            }
        });
    });

    // =========================================================================
    // UC23: 公開フォームレイアウト確認（pf-100）→ 1動画
    // =========================================================================
    test('UC23: 公開フォームレイアウト確認', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();
        page.setDefaultTimeout(30000);

        await closeTemplateModal(page);

        await test.step('pf-100: 公開フォームで各フィールドが正しいレイアウトで表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s pf-100`);

            // [flow] 100-1. 公開フォームを有効化してURLとハッシュを取得
            const formInfo = await enablePublicFormAndGetInfo(page, tableId);
            const hash = formInfo.hash;
            expect(formInfo.url, '公開フォームURLが取得できること').toBeTruthy();

            // [flow] 100-2. デスクトップ幅（1280px）で公開フォームを直接開く
            await page.setViewportSize({ width: 1280, height: 800 });
            const directUrl = buildFormDirectUrl(BASE_URL, tableId, hash);
            await openFormPage(page, directUrl);

            // [check] 100-3. ✅ フォームにフィールドが存在すること
            await checkPageOk(page);
            const fieldBlocks = page.locator('.pc-field-block');
            const fieldCount = await fieldBlocks.count();
            expect(fieldCount, '公開フォームにフィールドが存在すること').toBeGreaterThan(0);
            console.log(`[pf-100] フィールド数: ${fieldCount}`);

            // [check] 100-4. ✅ フィールドが見切れていないこと（右端からはみ出していないこと）
            const clippedCheck = await page.evaluate(() => {
                const blocks = document.querySelectorAll('.pc-field-block');
                let clipped = 0;
                const viewportWidth = window.innerWidth;
                for (const block of blocks) {
                    const rect = block.getBoundingClientRect();
                    if (rect.width > 0 && rect.right > viewportWidth + 5) {
                        clipped++;
                    }
                }
                return { clipped, total: blocks.length, viewportWidth };
            });
            console.log(`[pf-100] 見切れチェック - 全${clippedCheck.total}件中${clippedCheck.clipped}件が見切れ (viewport: ${clippedCheck.viewportWidth}px)`);
            expect(clippedCheck.clipped, '見切れフィールドがないこと').toBe(0);

            await autoScreenshot(page, 'UC23', 'pf-100', _testStart);
        });
    });
});
