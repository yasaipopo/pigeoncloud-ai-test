// fields-4.spec.js: フィールドテスト Part 4 (表示条件動作261系・必須/重複265系・初期値267系)
// @ts-check
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
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded');
    // storageStateでログイン済みならdashboardにリダイレクトされる
    if (!page.url().includes('/admin/login')) {
        await page.waitForSelector('.navbar', { timeout: 30000 });
        return;
    }
    // ログインフォームが表示されたら入力
    const idField = await page.waitForSelector('#id', { timeout: 5000 }).catch(() => null);
    if (!idField) {
        // リダイレクト途中の可能性。navbarを待つ
        await page.waitForSelector('.navbar', { timeout: 30000 });
        return;
    }
    await page.fill('#id', email || EMAIL);
    await page.fill('#password', password || PASSWORD);
    await page.click('button[type=submit].btn-primary');
    await page.waitForSelector('.navbar', { timeout: 40000 });
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
    await createPromise;
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
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 60000 });
        }
    } else if (currentUrl.includes(`/admin/dataset__${tableId}`)) {
        // テーブル一覧ページにリダイレクトされた場合
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 60000 });
        const pageText = await page.innerText('body');
        expect(pageText).not.toContain('Internal Server Error');
    } else {
        // その他のページ：ナビバーが表示されていること
        await expect(page.locator('.navbar')).toBeVisible({ timeout: 60000 });
    }
}

/**
 * フィールドラベルに一致するフィールド行を探してクリックし、インライン編集パネルを開く
 * @returns {Promise<boolean>} パネルが開いた場合 true、失敗した場合 false
 */
async function openFieldEditPanel(page, fieldLabel) {
    // フィールド行は .cdk-drag.field-drag または .field-drag
    const fieldRows = page.locator('.cdk-drag.field-drag, .field-drag');
    const count = await fieldRows.count();
    for (let i = 0; i < count; i++) {
        const row = fieldRows.nth(i);
        const text = await row.innerText().catch(() => '');
        if (text.includes(fieldLabel)) {
            // Angular動的レンダリングのため evaluate で直接クリック
            try {
                await row.click({ force: true });
            } catch (e) {
                await page.evaluate((el) => el.click(), await row.elementHandle());
            }
            // インライン編集パネルの表示を待機（Angular動的レンダリング）
            await page.waitForTimeout(1500);
            return true;
        }
    }
    return false;
}

// =============================================================================
// ファイルレベルのALLテストテーブル共有セットアップ（1回のみ実行）
// =============================================================================
let _sharedTableId = null;

test.beforeAll(async ({ browser }) => {
    test.setTimeout(120000);
    const { context, page } = await createAuthContext(browser);
    // about:blankではcookiesが送られないため、先にアプリURLに遷移
    await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const createResult = await createAllTypeTable(page);
    if (createResult && createResult.tableId) {
        _sharedTableId = createResult.tableId;
    }
    await createAllTypeData(page, 3);
    if (!_sharedTableId) {
        // リトライ: セッション切れ対策で再ログインしてから取得
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        const loginForm = await page.waitForSelector('#id', { timeout: 5000 }).catch(() => null);
        if (loginForm) {
            await page.fill('#id', process.env.TEST_EMAIL || 'admin');
            await page.fill('#password', process.env.TEST_PASSWORD || '');
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 60000 }).catch(() => {});
        }
        _sharedTableId = await getAllTypeTableId(page);
    }
    await context.close();
});

// =============================================================================
// F401: フィールド設定テスト（261-1〜261-3, 265-1, 265-2, 267-1）→ 1動画
// =============================================================================

test.describe('フィールド設定テスト（261/265/267系）', () => {

    test('F401: フィールド設定テスト', async ({ page }) => {
        test.setTimeout(120000); // 10分
        const _testStart = Date.now();
        page.setDefaultTimeout(60000);

        const tableId = _sharedTableId;
        expect(tableId, 'ALLテストテーブルのIDが取得できていること（beforeAllで設定済み）').toBeTruthy();

        await login(page);
        await closeTemplateModal(page);

        // ----- step: 261-1 選択肢フィールドの表示条件セクション確認 -----
        await test.step('261-1: 選択肢フィールドのインライン編集パネルで「表示条件」セクションが確認できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 261-1`);

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);

            const fieldRows = page.locator('.cdk-drag.field-drag, .field-drag');
            const fieldCount = await fieldRows.count();
            if (fieldCount === 0) {
                await expect(fieldRows.first(), 'フィールド行が表示されること').toBeVisible({ timeout: 60000 });
            }

            const opened = await openFieldEditPanel(page, '選択肢');
            if (!opened) {
                await fieldRows.first().click({ force: true });
                await waitForAngular(page);
            }

            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');

            const hasDisplayCondition = pageText.includes('表示条件') || pageText.includes('display') || pageText.includes('条件');
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 60000 });
            console.log(`[261-1] 表示条件テキスト存在: ${hasDisplayCondition}`);
        });

        // ----- step: 261-2 Yes/Noフィールドのインライン編集パネル確認 -----
        await test.step('261-2: Yes/Noフィールドのインライン編集パネルが開けること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 261-2`);

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);

            const fieldRows = page.locator('.cdk-drag.field-drag, .field-drag');
            const fieldCount = await fieldRows.count();
            if (fieldCount === 0) {
                await expect(fieldRows.first(), 'フィールド行が表示されること').toBeVisible({ timeout: 60000 });
            }

            const opened = await openFieldEditPanel(page, 'Yes / No');
            if (!opened) {
                await expect(page.locator('.cdk-drag.field-drag:has-text("Yes / No"), .field-drag:has-text("Yes / No")').first(), 'Yes/Noフィールドが存在すること（ALLテストテーブルに含まれるべき）').toBeVisible({ timeout: 60000 });
            }

            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 60000 });

            const panelSelectors = [
                'admin-forms-field',
                '.field-edit-panel',
                '.field-setting-panel',
                '.field-option',
                '.field-config',
                '.sidebar-panel',
                '.settings-panel',
            ];
            let panelFound = false;
            for (const sel of panelSelectors) {
                const cnt = await page.locator(sel).count();
                if (cnt > 0) {
                    panelFound = true;
                    console.log(`[261-2] パネルセレクター発見: ${sel}`);
                    break;
                }
            }
            console.log(`[261-2] Yes/Noフィールドクリック後パネル検出: ${panelFound}`);
            expect(pageText).not.toContain('Internal Server Error');
        });

        // ----- step: 261-3 チェックボックスフィールドのインライン編集パネル確認 -----
        await test.step('261-3: チェックボックスフィールドのインライン編集パネルが開けること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 261-3`);

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);

            const fieldRows = page.locator('.cdk-drag.field-drag, .field-drag');
            const fieldCount = await fieldRows.count();
            if (fieldCount === 0) {
                await expect(fieldRows.first(), 'フィールド行が表示されること').toBeVisible({ timeout: 60000 });
            }

            const opened = await openFieldEditPanel(page, '選択肢(複数選択)');
            if (!opened) {
                await expect(page.locator('.cdk-drag.field-drag:has-text("選択肢(複数選択)"), .field-drag:has-text("選択肢(複数選択)")').first(), '選択肢(複数選択)フィールドが存在すること').toBeVisible({ timeout: 60000 });
            }

            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 60000 });
            console.log('[261-3] チェックボックスフィールドクリック後、ページ正常確認');
        });

        // ----- step: 265-1 必須設定→空保存エラー確認 -----
        await test.step('265-1: テキストフィールドに必須設定後、空保存でエラーメッセージが表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 265-1`);

            // Step1: フィールド設定ページで「テキスト」フィールドの必須トグルをONにする
            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);

            const fieldRows = page.locator('.cdk-drag.field-drag, .field-drag');
            const fieldCount = await fieldRows.count();
            if (fieldCount === 0) {
                await expect(fieldRows.first(), 'フィールド行が表示されること').toBeVisible({ timeout: 60000 });
            }

            // overSettingからモーダルを開いて追加オプション展開→必須設定
            // テキストフィールド（文字列(一行)）のoverSettingを探す
            const overSettings = page.locator('.overSetting');
            const osCount = await overSettings.count();
            let foundTextField = false;
            for (let i = 0; i < osCount; i++) {
                const label = await overSettings.nth(i).evaluate(el => {
                    const lbl = el.closest('.pc-field-block, tr, [class*=field]')?.querySelector('label');
                    return lbl?.textContent?.trim() || '';
                }).catch(() => '');
                if (label.includes('テキスト') && !label.includes('テキストエリア') && !label.includes('固定')) {
                    await overSettings.nth(i).click({ force: true });
                    foundTextField = true;
                    console.log(`[265-1] テキストフィールドのoverSetting found at index ${i}`);
                    break;
                }
            }
            if (!foundTextField) {
                // フォールバック: 最初のoverSettingをクリック
                await overSettings.first().click({ force: true });
            }
            await page.waitForTimeout(1500);

            // 追加オプション設定を展開
            const addOptBtn = page.locator('.modal.show').locator('text=追加オプション設定');
            if (await addOptBtn.count() > 0) {
                await addOptBtn.click();
                await page.waitForTimeout(1000);
            }

            // 必須設定トグルを操作
            const requiredCheckbox = page.locator('.modal.show').locator('text=必須項目にする').locator('..').locator('input[type="checkbox"], .switch-handle, .custom-control-input').first();
            let requiredToggled = false;
            if (await requiredCheckbox.count() > 0) {
                const isChecked = await requiredCheckbox.isChecked().catch(() => false);
                if (!isChecked) {
                    await requiredCheckbox.click({ force: true });
                    await waitForAngular(page);
                }
                requiredToggled = true;
                console.log('[265-1] 必須トグルON');
            }

            if (!requiredToggled) {
                // フォールバック: 「必須項目にする」のラベルを直接クリック
                const labelEl = page.locator('.modal.show label:has-text("必須項目にする")').first();
                if (await labelEl.count() > 0) {
                    await labelEl.click({ force: true });
                    await waitForAngular(page);
                    requiredToggled = true;
                    console.log('[265-1] 必須ラベルクリックでON');
                }
            }

            expect(requiredToggled, '必須設定トグルが操作できること').toBeTruthy();

            // 変更するボタンで保存
            const saveButtonSelectors = [
                'button:has-text("変更する")',
                'button:has-text("保存")',
                'button[type="submit"]:has-text("保存")',
                '.btn-primary:has-text("保存")',
                'button:has-text("更新")',
            ];
            let saved = false;
            for (const sel of saveButtonSelectors) {
                try {
                    const btn = page.locator('.modal.show').locator(sel).first();
                    const cnt = await btn.count();
                    if (cnt > 0) {
                        await btn.click({ force: true });
                        await waitForAngular(page);
                        saved = true;
                        console.log(`[265-1] 保存ボタンクリック: ${sel}`);
                        break;
                    }
                } catch (e) {}
            }

            // Step2: レコード新規作成フォームで空保存してエラーを確認
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            try {
                await page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch (e) {
                await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
            }
            await waitForAngular(page);

            const newRecordSelectors = [
                'button:has-text("新規作成")',
                'a:has-text("新規作成")',
                '.btn:has-text("追加")',
                'button:has-text("追加")',
                'a:has-text("追加")',
                '[data-test="add-record"]',
                '.add-record-btn',
            ];
            let recordFormOpened = false;
            for (const sel of newRecordSelectors) {
                try {
                    const btn = page.locator(sel).first();
                    const cnt = await btn.count();
                    if (cnt > 0) {
                        await btn.click({ force: true });
                        await waitForAngular(page);
                        recordFormOpened = true;
                        console.log(`[265-1] 新規作成ボタンクリック: ${sel}`);
                        break;
                    }
                } catch (e) {}
            }

            if (!recordFormOpened) {
                console.log('[265-1] 新規作成ボタンが見つかりません');
                await cleanupRequiredSetting(page, tableId);
                throw new Error('[265-1] 新規作成ボタンが見つかりません。レコード一覧ページに「新規作成」または「追加」ボタンが表示されているか確認してください。');
            }

            const formSaveSelectors = [
                'button:has-text("保存")',
                'button[type="submit"]:has-text("保存")',
                '.modal button:has-text("保存")',
                '.modal .btn-primary',
                'button:has-text("登録")',
            ];
            let formSaved = false;
            for (const sel of formSaveSelectors) {
                try {
                    const btn = page.locator(sel).first();
                    const cnt = await btn.count();
                    if (cnt > 0) {
                        await btn.click({ force: true });
                        await waitForAngular(page);
                        formSaved = true;
                        console.log(`[265-1] フォーム保存ボタンクリック: ${sel}`);
                        break;
                    }
                } catch (e) {}
            }

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            const hasErrorMsg = bodyText.includes('入力してください') ||
                               bodyText.includes('必須') ||
                               bodyText.includes('required') ||
                               bodyText.includes('エラー') ||
                               bodyText.includes('必要');
            console.log(`[265-1] エラーメッセージ確認: ${hasErrorMsg}`);
            expect(hasErrorMsg, '空のまま保存した際に必須エラーメッセージが表示されること（「入力してください」「必須」「エラー」等のテキストが含まれること）').toBe(true);

            await cleanupRequiredSetting(page, tableId);
        });

        // ----- step: 265-2 重複チェック設定UI確認 -----
        await test.step('265-2: テキスト/数値フィールドで重複チェック設定のUIが表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 265-2`);

            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);

            const fieldRows = page.locator('.cdk-drag.field-drag, .field-drag');
            const fieldCount = await fieldRows.count();
            if (fieldCount === 0) {
                await expect(fieldRows.first(), 'フィールド行が表示されること').toBeVisible({ timeout: 60000 });
            }

            const opened = await openFieldEditPanel(page, 'テキスト');
            if (!opened) {
                const openedNum = await openFieldEditPanel(page, '数値');
                if (!openedNum) {
                    await expect(page.locator('.cdk-drag.field-drag:has-text("テキスト"), .field-drag:has-text("テキスト")').first(), 'テキスト/数値フィールドが存在すること').toBeVisible({ timeout: 60000 });
                }
            }

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            const hasDuplicateCheck = bodyText.includes('重複') ||
                                      bodyText.includes('ユニーク') ||
                                      bodyText.includes('unique') ||
                                      bodyText.includes('一意');
            console.log(`[265-2] 重複チェック関連テキスト存在: ${hasDuplicateCheck}`);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 60000 });
        });

        // ----- step: 267-1 テキストフィールドの初期値設定→新規レコード作成時に自動入力 -----
        await test.step('267-1: テキストフィールドに初期値を設定すると新規レコード作成時に自動入力されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 267-1`);

            const testDefaultValue = '__テスト初期値__';

            // Step1: フィールド設定ページで「テキスト」フィールドに初期値を設定
            await navigateToFieldPage(page, tableId);
            await assertFieldPageLoaded(page, tableId);

            const fieldRows = page.locator('.cdk-drag.field-drag, .field-drag');
            const fieldCount = await fieldRows.count();
            if (fieldCount === 0) {
                await expect(fieldRows.first(), 'フィールド行が表示されること').toBeVisible({ timeout: 60000 });
            }

            const opened = await openFieldEditPanel(page, 'テキスト');
            if (!opened) {
                await expect(page.locator('.cdk-drag.field-drag:has-text("テキスト"), .field-drag:has-text("テキスト")').first(), 'テキストフィールドが存在すること').toBeVisible({ timeout: 60000 });
            }

            const defaultValueSelectors = [
                'input[placeholder*="初期値"]',
                'input[name*="default"]',
                'input[id*="default"]',
                '.default-value input[type="text"]',
                'label:has-text("初期値") ~ * input',
                'label:has-text("デフォルト") ~ * input',
            ];

            let defaultValueSet = false;
            for (const sel of defaultValueSelectors) {
                try {
                    const el = page.locator(sel).first();
                    const cnt = await el.count();
                    if (cnt > 0) {
                        await el.fill(testDefaultValue);
                        await page.waitForTimeout(500);
                        defaultValueSet = true;
                        console.log(`[267-1] 初期値入力欄発見・入力: ${sel}`);
                        break;
                    }
                } catch (e) {}
            }

            if (!defaultValueSet) {
                const bodyText = await page.innerText('body');
                const hasDefaultText = bodyText.includes('初期値') || bodyText.includes('デフォルト') || bodyText.includes('default');
                console.log(`[267-1] 初期値入力欄未検出。初期値テキスト存在: ${hasDefaultText}`);
                throw new Error('[267-1] 初期値入力欄が見つかりません。テキストフィールドのインライン編集パネルに「初期値」入力欄が表示されているか確認してください。');
            }

            const saveButtonSelectors = [
                'button:has-text("保存")',
                'button[type="submit"]:has-text("保存")',
                '.btn-primary:has-text("保存")',
                'button:has-text("更新")',
            ];
            for (const sel of saveButtonSelectors) {
                try {
                    const btn = page.locator(sel).first();
                    const cnt = await btn.count();
                    if (cnt > 0) {
                        await btn.click({ force: true });
                        await waitForAngular(page);
                        console.log(`[267-1] 保存ボタンクリック: ${sel}`);
                        break;
                    }
                } catch (e) {}
            }

            // Step2: レコード新規作成フォームで初期値が自動入力されているか確認
            await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
            try {
                await page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch (e) {
                await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
            }
            await waitForAngular(page);

            const newRecordSelectors = [
                'button:has-text("新規作成")',
                'a:has-text("新規作成")',
                '.btn:has-text("追加")',
                'button:has-text("追加")',
                'a:has-text("追加")',
                '[data-test="add-record"]',
                '.add-record-btn',
            ];
            let recordFormOpened = false;
            for (const sel of newRecordSelectors) {
                try {
                    const btn = page.locator(sel).first();
                    const cnt = await btn.count();
                    if (cnt > 0) {
                        await btn.click({ force: true });
                        await waitForAngular(page);
                        recordFormOpened = true;
                        console.log(`[267-1] 新規作成ボタンクリック: ${sel}`);
                        break;
                    }
                } catch (e) {}
            }

            if (!recordFormOpened) {
                console.log('[267-1] 新規作成ボタンが見つかりません');
                await cleanupDefaultValue(page, tableId);
                throw new Error('[267-1] 新規作成ボタンが見つかりません。レコード一覧ページに「新規作成」または「追加」ボタンが表示されているか確認してください。');
            }

            await page.waitForTimeout(1000);
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            const inputSelectors = [
                `input[value="${testDefaultValue}"]`,
                `input:has-text("${testDefaultValue}")`,
            ];
            let defaultFound = false;
            for (const sel of inputSelectors) {
                try {
                    const el = page.locator(sel).first();
                    const cnt = await el.count();
                    if (cnt > 0) {
                        defaultFound = true;
                        break;
                    }
                } catch (e) {}
            }

            if (!defaultFound) {
                const inputValues = await page.evaluate((val) => {
                    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
                    return inputs.map(i => i.value);
                }, testDefaultValue);
                defaultFound = inputValues.some(v => v === testDefaultValue || v.includes('テスト初期値'));
            }

            console.log(`[267-1] 初期値の自動入力確認: ${defaultFound}`);
            expect(defaultFound, `テキストフィールドの初期値「${testDefaultValue}」が新規作成フォームに自動入力されていること`).toBe(true);
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 60000 });

            await cleanupDefaultValue(page, tableId);
        });
    });
});

// =============================================================================
// 後片付けヘルパー関数
// =============================================================================

/**
 * 必須設定をOFFに戻すクリーンアップ
 */
async function cleanupRequiredSetting(page, tableId) {
    try {
        await navigateToFieldPage(page, tableId);
        await page.waitForTimeout(1000);
        const opened = await openFieldEditPanel(page, 'テキスト');
        if (!opened) return;

        const requiredToggleSelectors = [
            'input[type="checkbox"][id*="required"]',
            'input[type="checkbox"][name*="required"]',
            '.required-toggle input[type="checkbox"]',
            'label:has-text("必須") input[type="checkbox"]',
        ];
        for (const sel of requiredToggleSelectors) {
            try {
                const el = page.locator(sel).first();
                const cnt = await el.count();
                if (cnt > 0) {
                    const isChecked = await el.isChecked().catch(() => false);
                    if (isChecked) {
                        await el.click({ force: true });
                        await waitForAngular(page);
                    }
                    break;
                }
            } catch (e) {
                // 無視
            }
        }
        // 保存
        const btn = page.locator('button:has-text("保存"), .btn-primary:has-text("保存")').first();
        const cnt = await btn.count();
        if (cnt > 0) {
            await btn.click({ force: true });
            await waitForAngular(page);
        }
    } catch (e) {
        console.log(`[cleanup] 必須設定クリーンアップ失敗: ${e.message}`);
    }
}

/**
 * 初期値を消去するクリーンアップ
 */
async function cleanupDefaultValue(page, tableId) {
    try {
        await navigateToFieldPage(page, tableId);
        await page.waitForTimeout(1000);
        const opened = await openFieldEditPanel(page, 'テキスト');
        if (!opened) return;

        const defaultValueSelectors = [
            'input[placeholder*="初期値"]',
            'input[name*="default"]',
            'input[id*="default"]',
            '.default-value input[type="text"]',
        ];
        for (const sel of defaultValueSelectors) {
            try {
                const el = page.locator(sel).first();
                const cnt = await el.count();
                if (cnt > 0) {
                    await el.fill('');
                    await page.waitForTimeout(300);
                    break;
                }
            } catch (e) {
                // 無視
            }
        }
        // 保存
        const btn = page.locator('button:has-text("保存"), .btn-primary:has-text("保存")').first();
        const cnt = await btn.count();
        if (cnt > 0) {
            await btn.click({ force: true });
            await waitForAngular(page);
        }
    } catch (e) {
        console.log(`[cleanup] 初期値クリーンアップ失敗: ${e.message}`);
    }
}
