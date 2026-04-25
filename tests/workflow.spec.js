// @ts-check
/**
 * ワークフロー E2Eテスト
 *
 * 新UIに対応した全面書き直し版。
 * createTestEnvパターンで自己完結型テスト環境を使用する。
 * 全テストを1つのdescribe内にまとめてbeforeAllを1回だけ実行する。
 */
const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { createTestEnv } = require('./helpers/create-test-env');

let BASE_URL = process.env.TEST_BASE_URL || '';
let EMAIL = process.env.TEST_EMAIL || 'admin';
let PASSWORD = process.env.TEST_PASSWORD || '';

// テスト用テーブルID（beforeAllで作成）
let tableId = null;

// ============================================================
// ヘルパー関数
// ============================================================

/**
 * ステップスクリーンショット撮影
 */
/** Angular SPAの描画待機 */
async function waitForAngular(page, timeout = 10000) {
    try {
        await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 8000) });
    } catch { /* networkidle タイムアウトは無視 */ }
}

/** テンプレートモーダルを閉じる */
async function closeTemplateModal(page) {
    const modal = page.locator('div.modal.show');
    if (await modal.count() > 0) {
        await modal.locator('button.close, button[aria-label="Close"], button:has-text("スキップ")').first()
            .click({ force: true }).catch(() => {});
        await page.waitForSelector('div.modal.show', { state: 'hidden', timeout: 5000 }).catch(() => {});
    }
}

/** ワークフロータブに移動 */
async function navigateToWorkflowTab(page, tid) {
    await page.goto(BASE_URL + '/admin/dataset/edit/' + tid, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('[role=tab]', { timeout: 10000 });
    await page.evaluate(() => {
        const tabs = document.querySelectorAll('[role=tab]');
        for (const t of tabs) {
            if (t.textContent.includes('ワークフロー')) { t.click(); break; }
        }
    });
    await page.waitForFunction(
        () => !!document.querySelector('dataset-workflow-options'),
        { timeout: 10000 }
    ).catch(() => {});
    await page.waitForTimeout(500);
}

/** ワークフロートグルの状態を取得 */
async function isWorkflowEnabled(page) {
    return page.evaluate(() => {
        const cb = document.querySelector('#wf-toggle-workflow-input');
        return cb ? /** @type {HTMLInputElement} */ (cb).checked : false;
    });
}

/** ワークフロートグルをON/OFFにする */
async function setWorkflowToggle(page, enable) {
    const current = await isWorkflowEnabled(page);
    if (current === enable) return;
    await page.locator('[data-testid="wf-toggle-workflow"]').click();
    await page.waitForTimeout(1500);
}

/** 特定オプションのON/OFFを切り替え */
async function setWorkflowOption(page, labelText, enable) {
    const state = await page.evaluate(({ labelText, enable }) => {
        const wfEl = document.querySelector('dataset-workflow-options');
        if (!wfEl) return { found: false, needsToggle: false };
        const rows = wfEl.querySelectorAll('.form-group.row');
        for (const r of rows) {
            if (r.textContent?.includes(labelText)) {
                const cb = /** @type {HTMLInputElement} */ (r.querySelector('input[type="checkbox"]'));
                if (!cb) return { found: false, needsToggle: false };
                return { found: true, needsToggle: (enable && !cb.checked) || (!enable && cb.checked) };
            }
        }
        return { found: false, needsToggle: false };
    }, { labelText, enable });
    if (!state.found) return false;
    if (state.needsToggle) {
        const row = page.locator('dataset-workflow-options .form-group.row').filter({ hasText: labelText }).first();
        await row.locator('label.switch').click({ force: true });
        await page.waitForTimeout(500);
    }
    return true;
}

/** テーブル設定を保存 */
async function saveTableSettings(page, tid) {
    const submitBtn = page.locator('.card-footer button[type=submit].btn-primary').last();
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    await submitBtn.click({ timeout: 10000 });
    await page.waitForSelector('.modal.show', { timeout: 10000 }).catch(() => {});
    const confirmBtn = page.locator('.modal.show button').filter({ hasText: /変更する|更新する/ }).first();
    if (await confirmBtn.count() > 0) {
        await confirmBtn.click({ timeout: 10000 });
    }
    await page.waitForURL(new RegExp('dataset__' + tid), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
}

/** テスト専用テーブル作成 */
async function createSimpleTable(page) {
    const tableName = 'WFTest_' + Date.now();
    await page.goto(BASE_URL + '/admin/dataset/edit/new', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('[role=tab]', { timeout: 10000 }).catch(() => {});
    const nameInput = page.locator('#table_name').first();
    await nameInput.waitFor({ timeout: 10000 });
    await nameInput.fill(tableName);
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /項目を追加する/ }).click();
    await page.waitForTimeout(1000);
    await page.getByRole('dialog').getByRole('button', { name: /文字列\(一行\)/ }).click();
    const labelInput = page.locator('input[name="label"]');
    await labelInput.waitFor({ timeout: 10000 });
    await labelInput.fill('テスト項目');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '追加する', exact: true }).click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: '登録', exact: true }).click();
    await page.waitForTimeout(1000);
    await page.locator('.modal.show').getByRole('button', { name: '追加する', exact: true }).click({ timeout: 10000 });
    await page.waitForURL(/\/dataset__\d+/, { timeout: 20000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const url = page.url();
    const match = url.match(/\/dataset__(\d+)/);
    if (!match) throw new Error('テーブル作成失敗: URL=' + url);
    return match[1];
}

/**
 * 新規レコードを作成して申請する
 *
 * 新UIの申請ダイアログ:
 * - フロー固定ON: テンプレート選択済み→「申請」ボタンクリックだけでOK
 * - フロー固定OFF（テンプレートあり）: テンプレートが事前選択される場合がある
 * - フロー固定OFF（テンプレートなし）: 「承認フロー追加」→ユーザー選択→「申請する」
 */
async function createRecordAndApply(page, tid) {
    // レコード一覧 → +ボタンで新規作成（/edit/newは Angular SPA内部ルートで白画面になる）
    await page.goto(BASE_URL + '/admin/dataset__' + tid, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
    await waitForAngular(page);
    const addBtn = page.locator('button:has(.fa-plus)').first();
    await addBtn.waitFor({ state: 'visible', timeout: 10000 });
    await addBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // card-footer内の「申請」ボタン
    const applyBtn = page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first();
    await applyBtn.waitFor({ state: 'visible', timeout: 10000 });
    await applyBtn.click();
    await page.waitForTimeout(2000);

    // 新UIモーダル(.workflow-modal-container.show)が開く
    const modal = page.locator('.workflow-modal-container.show');
    await modal.waitFor({ state: 'visible', timeout: 10000 });

    // 承認ステップがない場合は+ボタンで追加
    const hasStepCard = await modal.locator('.wf-step-card').count() > 0;
    if (!hasStepCard) {
        const addStepBtn = modal.locator('.wf-add-btn').first();
        if (await addStepBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await addStepBtn.click();
            await page.waitForTimeout(2000);
        }
    }

    // モーダル内の「申請」ボタンをクリック（force:trueでoverlay問題を回避）
    const modalApplyBtn = modal.locator('button.btn-primary').filter({ hasText: /申請/ }).first();
    await modalApplyBtn.click({ force: true, timeout: 10000 });

    await page.waitForURL(url => !url.includes('/edit/new'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const currentUrl = page.url();
    const viewMatch = currentUrl.match(/\/view\/(\d+)/);
    if (viewMatch) return viewMatch[1];
    if (currentUrl.includes('/dataset__')) {
        await page.waitForTimeout(2000);
        return page.evaluate(() => {
            const rows = document.querySelectorAll('table tbody tr');
            if (!rows.length) return null;
            for (const cell of rows[0].querySelectorAll('td')) {
                const text = cell.textContent.trim().replace(/["""]/g, '');
                if (/^\d+$/.test(text) && parseInt(text) > 0) return text;
            }
            return null;
        });
    }
    return null;
}

/** レコード詳細で承認操作 */
async function approveRecord(page, tid, recordId, comment = '') {
    await page.goto(BASE_URL + '/admin/dataset__' + tid + '/view/' + recordId, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await waitForAngular(page);
    await page.waitForTimeout(1000);
    await page.locator('button.btn-success.text-bold:has-text("承認")').first().click({ timeout: 10000 });
    await page.locator('button.btn-success.btn-ladda').waitFor({ state: 'attached', timeout: 8000 });
    await page.evaluate(() => {
        document.querySelectorAll('.modal.fade').forEach(el => {
            if (el.querySelector('button.btn-success.btn-ladda')) {
                /** @type {HTMLElement} */ (el).style.display = 'block';
                el.classList.add('show');
            }
        });
        document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
    });
    await page.waitForTimeout(300);
    if (comment) await page.locator('textarea.form-control').last().fill(comment);
    await page.locator('button.btn-success.btn-ladda').last().click({ timeout: 5000 });
    await waitForAngular(page);
}

/** レコード詳細で否認操作 */
async function rejectRecord(page, tid, recordId, comment = '') {
    await page.goto(BASE_URL + '/admin/dataset__' + tid + '/view/' + recordId, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await waitForAngular(page);
    await page.waitForTimeout(1000);
    await page.locator('button.btn-danger.text-bold:has-text("否認")').first().click({ timeout: 10000 });
    await page.locator('button.btn-danger.btn-ladda').waitFor({ state: 'attached', timeout: 8000 });
    await page.evaluate(() => {
        document.querySelectorAll('.modal.fade').forEach(el => {
            if (el.querySelector('button.btn-danger.btn-ladda')) {
                /** @type {HTMLElement} */ (el).style.display = 'block';
                el.classList.add('show');
            }
        });
        document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
    });
    await page.waitForTimeout(300);
    if (comment) await page.locator('textarea.form-control').last().fill(comment);
    await page.locator('button.btn-danger.btn-ladda').last().click({ timeout: 5000 });
    await waitForAngular(page);
}

/** レコード詳細で申請取り下げ（新UI対応） */
async function withdrawRecord(page, tid, recordId) {
    await page.goto(BASE_URL + '/admin/dataset__' + tid + '/view/' + recordId, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await waitForAngular(page);
    await page.waitForTimeout(1000);
    // 下部バーの「申請取り下げ」ボタン
    await page.locator('button:has-text("申請取り下げ")').first().click({ timeout: 10000 });
    await page.waitForTimeout(1000);
    // 新UI: 確認ダイアログ（赤ヘッダー「申請を取り下げ」）内の「取り下げ」ボタン
    const withdrawConfirmBtn = page.locator('button:has-text("取り下げ")').filter({ hasNotText: '申請' }).last();
    await withdrawConfirmBtn.waitFor({ state: 'visible', timeout: 8000 });
    await withdrawConfirmBtn.click({ timeout: 5000 });
    await waitForAngular(page);
}

// ============================================================
// テストスイート（全テスト1つのdescribe、serial実行）
// ============================================================
const autoScreenshot = createAutoScreenshot('workflow');

test.describe('ワークフロー', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        const env = await createTestEnv(browser, { withAllTypeTable: false });
        BASE_URL = env.baseUrl;
        EMAIL = env.email;
        PASSWORD = env.password;
        process.env.TEST_BASE_URL = env.baseUrl;
        process.env.TEST_EMAIL = env.email;
        process.env.TEST_PASSWORD = env.password;

        const page = env.page;
        await closeTemplateModal(page);
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                tableId = await createSimpleTable(page);
                if (tableId) break;
            } catch (e) {
                console.log('[beforeAll] createSimpleTable attempt ' + attempt + '/3: ' + e.message);
                if (attempt === 3) throw e;
                await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                await page.waitForTimeout(3000);
            }
        }
        console.log('[beforeAll] テーブル作成完了: tableId=' + tableId + ', BASE_URL=' + BASE_URL);
        await env.context.close();
    });

    test.beforeEach(async ({ page }) => {
        // 古い環境のcookieをクリアして新環境にログイン
        await page.context().clearCookies();
        // 新環境のログインページに明示的に遷移してログイン
        // ※configのstorageStateは古い環境のcookieのため、必ずフルログインが必要
        try {
            await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch {
            // gotoタイムアウトでもページ遷移は開始されているのでそのまま続行
        }
        // ログイン画面が表示された場合のみフォーム入力
        const currentUrl = page.url();
        if (currentUrl.includes('/login')) {
            const loginField = await page.waitForSelector('#id', { timeout: 10000 }).catch(() => null);
            if (loginField) {
                await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
                await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
                await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
                await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
            }
        } else {
            // 既にダッシュボードなどにリダイレクト済み
            await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
        }
    });

    // -------------------------------------------------------
    // ワークフロー設定テスト
    // -------------------------------------------------------

    test('WF03: 11-1: ワークフロー有効化と保存', async ({ page }) => {
        test.setTimeout(90000);
        const _testStart = Date.now();
        await navigateToWorkflowTab(page, tableId);
        const toggleExists = await page.evaluate(() => !!document.querySelector('#wf-toggle-workflow-input'));
        expect(toggleExists).toBeTruthy();
        await setWorkflowToggle(page, true);
        expect(await isWorkflowEnabled(page)).toBeTruthy();
        await expect(page.locator('dataset-workflow-options .child-container')).toBeVisible({ timeout: 5000 });
        await autoScreenshot(page, 'WF03', 'wf-320', 0, _testStart);
        await saveTableSettings(page, tableId);
        await navigateToWorkflowTab(page, tableId);
        expect(await isWorkflowEnabled(page)).toBeTruthy();
        await autoScreenshot(page, 'WF03', 'wf-320', 1, _testStart);
    });

    test('WF03: 21-1: 承認者はデータ編集可能設定の保存', async ({ page }) => {
        test.setTimeout(90000);
        await navigateToWorkflowTab(page, tableId);
        await setWorkflowToggle(page, true);
        const found = await setWorkflowOption(page, '承認者はデータ編集可能', true);
        expect(found).toBeTruthy();
        await saveTableSettings(page, tableId);
        await navigateToWorkflowTab(page, tableId);
        const isSaved = await page.evaluate(() => {
            const wfEl = document.querySelector('dataset-workflow-options');
            if (!wfEl) return false;
            for (const r of wfEl.querySelectorAll('.form-group.row')) {
                if (r.textContent?.includes('承認者はデータ編集可能')) {
                    const cb = /** @type {HTMLInputElement} */ (r.querySelector('input[type="checkbox"]'));
                    return cb ? cb.checked : false;
                }
            }
            return false;
        });
        expect(isSaved).toBeTruthy();
    });

    test('WF03: 21-2: 再申請可能設定の保存', async ({ page }) => {
        test.setTimeout(90000);
        await navigateToWorkflowTab(page, tableId);
        await setWorkflowToggle(page, true);
        const found = await setWorkflowOption(page, '再申請可能', true);
        expect(found).toBeTruthy();
        await saveTableSettings(page, tableId);
        await navigateToWorkflowTab(page, tableId);
        const isSaved = await page.evaluate(() => {
            const wfEl = document.querySelector('dataset-workflow-options');
            if (!wfEl) return false;
            for (const r of wfEl.querySelectorAll('.form-group.row')) {
                if (r.textContent?.includes('再申請可能')) {
                    const cb = /** @type {HTMLInputElement} */ (r.querySelector('input[type="checkbox"]'));
                    return cb ? cb.checked : false;
                }
            }
            return false;
        });
        expect(isSaved).toBeTruthy();
    });

    // -------------------------------------------------------
    // ワークフロー基本操作テスト（フロー設計より先に実行）
    // -------------------------------------------------------

    test('WF03: 11-2: 申請→承認フロー', async ({ page }) => {
        test.setTimeout(120000);
        // ワークフロー有効 & フロー固定OFF を確認
        await navigateToWorkflowTab(page, tableId);
        await setWorkflowToggle(page, true);
        await setWorkflowOption(page, 'フローを固定する', false);
        await saveTableSettings(page, tableId);

        const recordId = await createRecordAndApply(page, tableId);
        expect(recordId).toBeTruthy();

        await page.goto(BASE_URL + '/admin/dataset__' + tableId + '/view/' + recordId, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await page.waitForTimeout(1000);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        const approveBtn = page.locator('button.btn-success.text-bold:has-text("承認")').first();
        await expect(approveBtn).toBeVisible({ timeout: 10000 });

        await approveRecord(page, tableId, recordId, '承認テスト');
        await page.goto(BASE_URL + '/admin/dataset__' + tableId + '/view/' + recordId, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        const afterText = await page.innerText('body');
        expect(afterText).not.toContain('Internal Server Error');
        expect(afterText).toContain('承認テスト');
    });

    test('WF03: 11-4: 否認→再申請フロー', async ({ page }) => {
        test.setTimeout(120000);
        const recordId = await createRecordAndApply(page, tableId);
        expect(recordId).toBeTruthy();

        await rejectRecord(page, tableId, recordId, '否認テストコメント');

        await page.goto(BASE_URL + '/admin/dataset__' + tableId + '/view/' + recordId, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('否認テストコメント');

        await page.goto(BASE_URL + '/admin/dataset__' + tableId + '/edit/' + recordId, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await page.waitForTimeout(1000);
        const reapplyBtn = page.locator('button').filter({ hasText: /^申請$/ }).first();
        await expect(reapplyBtn).toBeVisible({ timeout: 10000 });
    });

    test('WF03: 21-4: 申請取り下げ', async ({ page }) => {
        test.setTimeout(120000);
        const recordId = await createRecordAndApply(page, tableId);
        expect(recordId).toBeTruthy();

        await page.goto(BASE_URL + '/admin/dataset__' + tableId + '/view/' + recordId, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await page.waitForTimeout(1000);
        await expect(page.locator('button:has-text("申請取り下げ")')).toBeVisible({ timeout: 10000 });

        await withdrawRecord(page, tableId, recordId);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    test('WF03: 11-9: 否認→再編集→再申請→承認の完全フロー', async ({ page }) => {
        test.setTimeout(150000);
        const recordId = await createRecordAndApply(page, tableId);
        expect(recordId).toBeTruthy();

        // 否認
        await rejectRecord(page, tableId, recordId, '修正してください');

        // 再編集→再申請（createRecordAndApplyの申請フロー部分を再利用）
        await page.goto(BASE_URL + '/admin/dataset__' + tableId + '/edit/' + recordId, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await page.waitForTimeout(1000);
        const reapplyBtn = page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first();
        await reapplyBtn.waitFor({ state: 'visible', timeout: 10000 });
        await reapplyBtn.click();
        await page.waitForTimeout(2000);
        // 新UIモーダルの「申請」ボタンをクリック
        const reModal = page.locator('.workflow-modal-container.show');
        await reModal.waitFor({ state: 'visible', timeout: 10000 });
        // ステップがなければ追加
        if (await reModal.locator('.wf-step-card').count() === 0) {
            const addBtn = reModal.locator('.wf-add-btn').first();
            if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                await addBtn.click();
                await page.waitForTimeout(2000);
            }
        }
        const reModalApplyBtn = reModal.locator('button.btn-primary').filter({ hasText: /申請/ }).first();
        await reModalApplyBtn.click({ force: true, timeout: 10000 });
        await page.waitForURL(url => !url.includes('/edit/'), { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1000);

        // 再申請後に承認
        await approveRecord(page, tableId, recordId, '再申請を承認');
        await page.goto(BASE_URL + '/admin/dataset__' + tableId + '/view/' + recordId, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('再申請を承認');
    });

    // -------------------------------------------------------
    // フロー設計テスト（テンプレート作成後は申請UIが変わるため最後に実行）
    // -------------------------------------------------------

    test('WF03: 21-3: フロー固定ON→フロー設計ボタン表示', async ({ page }) => {
        test.setTimeout(90000);
        await navigateToWorkflowTab(page, tableId);
        await setWorkflowToggle(page, true);
        await setWorkflowOption(page, 'フローを固定する', true);
        await page.waitForTimeout(1500);
        await expect(page.locator('button.wf-flow-fixed-btn')).toBeVisible({ timeout: 5000 });
        await page.locator('button.wf-flow-fixed-btn').click();
        await page.waitForTimeout(2000);
        await expect(page.locator('.wf-modal-title').first()).toContainText('承認フローの設計');
        await expect(page.locator('.wf-master-panel').first()).toBeVisible();
        await expect(page.locator('[data-testid="wf-btn-add-template"]')).toBeVisible();
        await page.locator('[data-testid="wf-btn-modal-done"]').click();
        await page.waitForTimeout(1000);
        await setWorkflowOption(page, 'フローを固定する', false);
        await saveTableSettings(page, tableId);
    });

    test('WF03: 11-8: フロー設計でテンプレート追加・ステップ追加・保存', async ({ page }) => {
        test.setTimeout(120000);
        await navigateToWorkflowTab(page, tableId);
        await setWorkflowToggle(page, true);
        await setWorkflowOption(page, 'フローを固定する', true);
        await page.waitForTimeout(1500);
        await page.locator('button.wf-flow-fixed-btn').click();
        await page.waitForTimeout(2000);
        await page.locator('[data-testid="wf-btn-add-template"]').click();
        await page.waitForTimeout(2000);
        await page.locator('[data-testid="wf-input-flow-name"]').fill('基本承認フロー');
        await page.locator('.wf-add-btn').first().click();
        await page.waitForTimeout(2000);
        const stepCount = await page.locator('.wf-step-card').count();
        expect(stepCount).toBeGreaterThanOrEqual(1);
        await expect(page.locator('.wf-step-type').first()).toContainText('ユーザー');
        await expect(page.locator('.wf-master-item').first()).toBeVisible();
        await page.locator('[data-testid="wf-btn-modal-done"]').click();
        await page.waitForTimeout(1000);
        await saveTableSettings(page, tableId);
        await navigateToWorkflowTab(page, tableId);
        const isFixed = await page.evaluate(() => {
            const wfEl = document.querySelector('dataset-workflow-options');
            if (!wfEl) return false;
            for (const r of wfEl.querySelectorAll('.form-group.row')) {
                if (r.textContent?.includes('フローを固定する')) {
                    const cb = /** @type {HTMLInputElement} */ (r.querySelector('input[type="checkbox"]'));
                    return cb ? cb.checked : false;
                }
            }
            return false;
        });
        expect(isFixed).toBeTruthy();
    });

    // -------------------------------------------------------
    // オプション設定テスト
    // -------------------------------------------------------

    test('WF03: 引き上げ承認機能のON/OFF設定の保存', async ({ page }) => {
        test.setTimeout(90000);
        await navigateToWorkflowTab(page, tableId);
        await setWorkflowToggle(page, true);
        const found = await setWorkflowOption(page, '引き上げ承認機能', true);
        expect(found).toBeTruthy();
        await saveTableSettings(page, tableId);
        await navigateToWorkflowTab(page, tableId);
        const isSaved = await page.evaluate(() => {
            const wfEl = document.querySelector('dataset-workflow-options');
            if (!wfEl) return false;
            for (const r of wfEl.querySelectorAll('.form-group.row')) {
                if (r.textContent?.includes('引き上げ承認機能')) {
                    const cb = /** @type {HTMLInputElement} */ (r.querySelector('input[type="checkbox"]'));
                    return cb ? cb.checked : false;
                }
            }
            return false;
        });
        expect(isSaved).toBeTruthy();
    });

    test('WF03: フローを一つ戻す機能のON/OFF設定の保存', async ({ page }) => {
        test.setTimeout(90000);
        await navigateToWorkflowTab(page, tableId);
        await setWorkflowToggle(page, true);
        const found = await setWorkflowOption(page, 'フローを一つ戻す機能', true);
        expect(found).toBeTruthy();
        await saveTableSettings(page, tableId);
        await navigateToWorkflowTab(page, tableId);
        const isSaved = await page.evaluate(() => {
            const wfEl = document.querySelector('dataset-workflow-options');
            if (!wfEl) return false;
            for (const r of wfEl.querySelectorAll('.form-group.row')) {
                if (r.textContent?.includes('フローを一つ戻す機能')) {
                    const cb = /** @type {HTMLInputElement} */ (r.querySelector('input[type="checkbox"]'));
                    return cb ? cb.checked : false;
                }
            }
            return false;
        });
        expect(isSaved).toBeTruthy();
    });

    test('WF03: 同一承認者スキップ機能のON/OFF設定の保存', async ({ page }) => {
        test.setTimeout(90000);
        await navigateToWorkflowTab(page, tableId);
        await setWorkflowToggle(page, true);
        const found = await setWorkflowOption(page, '同一承認者の承認スキップ', true);
        expect(found).toBeTruthy();
        await saveTableSettings(page, tableId);
        await navigateToWorkflowTab(page, tableId);
        const isSaved = await page.evaluate(() => {
            const wfEl = document.querySelector('dataset-workflow-options');
            if (!wfEl) return false;
            for (const r of wfEl.querySelectorAll('.form-group.row')) {
                if (r.textContent?.includes('同一承認者の承認スキップ')) {
                    const cb = /** @type {HTMLInputElement} */ (r.querySelector('input[type="checkbox"]'));
                    return cb ? cb.checked : false;
                }
            }
            return false;
        });
        expect(isSaved).toBeTruthy();
    });

    test('WF03: 166: 自分自身を承認者にしてもエラーなし', async ({ page }) => {
        test.setTimeout(120000);
        // ワークフロー有効 & フロー固定OFF
        await navigateToWorkflowTab(page, tableId);
        await setWorkflowToggle(page, true);
        await setWorkflowOption(page, 'フローを固定する', false);
        await saveTableSettings(page, tableId);

        const recordId = await createRecordAndApply(page, tableId);
        expect(recordId).toBeTruthy();
        await approveRecord(page, tableId, recordId, '自己承認テスト');
        await page.goto(BASE_URL + '/admin/dataset__' + tableId + '/view/' + recordId, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('自己承認テスト');
    });

    // -------------------------------------------------------
    // ビジュアルエディタ（workflow-visual-editor）テスト
    // workflow-setting (旧フォーム UI) はコメントアウト済みで廃止済みのため、
    // 新しいビジュアルエディタでのステップ構築・承認者種別切替・
    // ラジオボタン独立性 (PR #2924 regression guard) を検証する。
    // -------------------------------------------------------

    /**
     * フロー設計モーダルを開いてテンプレートとステップ 1 件を追加した状態にする共通セットアップ。
     * 戻り値: 成功したら true、開けなかった場合は false
     * @requirements.txt(R-301)
     */
    async function openFlowDesignWithStep(page, tid) {
        await navigateToWorkflowTab(page, tid);
        await setWorkflowToggle(page, true);
        await setWorkflowOption(page, 'フローを固定する', true);
        // 「フロー設計」ボタンが attach されるまで待つ (count() は auto-wait しないため)
        const fixedBtn = page.locator('button.wf-flow-fixed-btn');
        await fixedBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        if (await fixedBtn.count() === 0) return false;
        await fixedBtn.click();
        // モーダルが開くまで待つ
        const addTemplateBtn = page.locator('[data-testid="wf-btn-add-template"]');
        await addTemplateBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        if (await addTemplateBtn.count() === 0) return false;
        await addTemplateBtn.click();
        // テンプレート名 input が出現するまで待つ
        const flowNameInput = page.locator('[data-testid="wf-input-flow-name"]');
        await flowNameInput.waitFor({ state: 'visible', timeout: 5000 });
        await flowNameInput.fill('wf-visual-テンプレ' + Date.now());
        // 初回ステップ追加ボタン (.wf-add-btn-wrapper 内) を押す
        const initialAddBtn = page.locator('.wf-add-btn').first();
        await initialAddBtn.waitFor({ state: 'visible', timeout: 5000 });
        await initialAddBtn.click();
        // ステップカードが少なくとも 1 件出現するまで待つ
        await page.locator('.wf-step-card').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        const stepCount = await page.locator('.wf-step-card').count();
        if (stepCount === 0) return false;
        return true;
    }

    /**
     * フロー設計モーダルを確実に閉じる後片付けヘルパー。
     * done ボタンが効かない場合はページリロードでクリーンアップ。
     */
    async function closeFlowDesignModal(page) {
        const doneBtn = page.locator('[data-testid="wf-btn-modal-done"]');
        await doneBtn.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        // モーダルが残っていればリロードで強制クリーンアップ
        const stuck = await page.locator('.wf-modal, .modal.show').count().catch(() => 0);
        if (stuck > 0) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
        }
    }

    /**
     * wf-040: visual editor でステップを選択し承認者種別ラジオ (admin/division/field) を切替
     *         UI に反映され、パネル閉→再選択後も状態が維持される
     * @requirements.txt(R-301)
     */
    test('wf-040: ビジュアルエディタで承認者種別ラジオ切替が反映されること', async ({ page }) => {
        test.setTimeout(150000);
        const _testStart = Date.now();

        // [flow] 40-1. ワークフロー有効化 + フロー固定 ON でフロー設計モーダル起動 + ステップ追加
        //         addStep() は selectedStepIndex を自動で設定するため編集パネルは既に開いている
        const opened = await openFlowDesignWithStep(page, tableId);
        expect(opened, 'フロー設計モーダルとステップが準備できていること').toBeTruthy();

        // [check] 40-2. ✅ ステップ追加直後で編集パネル (.wf-edit-panel) が既に表示されている
        //         (selectStep は toggle 動作なので、既に open のカードをクリックすると閉じる)
        await expect(page.locator('.wf-edit-panel')).toBeVisible({ timeout: 5000 });

        // 編集パネル内の「承認者種別」セクションの radio 3 つと、division 条件 radio を
        // label テキスト経由で取得 (Angular [name] binding はタイミング依存のため value + type 指定にする)
        const stepTypeSection = page.locator('.wf-edit-section').filter({ hasText: '承認者種別' }).first();

        // [check] 40-4. ✅ 承認者種別 radio 3 つ (admin/division/field) 存在
        await expect(stepTypeSection.locator('input[type="radio"][value="admin"]')).toHaveCount(1, { timeout: 5000 });
        await expect(stepTypeSection.locator('input[type="radio"][value="division"]')).toHaveCount(1);
        await expect(stepTypeSection.locator('input[type="radio"][value="field"]')).toHaveCount(1);

        // [flow] 40-5. 「組織(役職)」(value=division) を選択
        await stepTypeSection.locator('input[type="radio"][value="division"]').click({ force: true });
        await page.waitForTimeout(500);

        // [check] 40-6. ✅ division ラジオが checked 状態、かつ「組織に対する条件」(grant_type) セクションが出現
        const divisionChecked = await stepTypeSection.locator('input[type="radio"][value="division"]').isChecked();
        expect(divisionChecked, 'division ラジオが選択されていること').toBe(true);
        const grantSection = page.locator('.wf-edit-section').filter({ hasText: '組織に対する条件' }).first();
        await expect(grantSection).toBeVisible({ timeout: 5000 });
        await expect(grantSection.locator('input[type="radio"][value="all"]')).toHaveCount(1);
        await expect(grantSection.locator('input[type="radio"][value="one"]')).toHaveCount(1);

        // [flow] 40-7. 「一人の承認が必要」(value=one) を選択
        await grantSection.locator('input[type="radio"][value="one"]').click({ force: true });
        await page.waitForTimeout(300);

        // [check] 40-8. ✅ one ラジオ選択状態、all ラジオは未選択
        const grantOne = await grantSection.locator('input[type="radio"][value="one"]').isChecked();
        expect(grantOne).toBe(true);
        const grantAll = await grantSection.locator('input[type="radio"][value="all"]').isChecked();
        expect(grantAll).toBe(false);

        // [flow] 40-9. 編集パネルを×で閉じる → ステップカードをクリックして再選択
        await page.locator('.wf-edit-panel-close').click();
        await page.waitForTimeout(800);
        // パネルが閉じたことを確認してから再選択
        await expect(page.locator('.wf-edit-panel')).toHaveCount(0, { timeout: 3000 });
        await page.locator('.wf-step-card').first().click();
        await page.waitForTimeout(800);
        await expect(page.locator('.wf-edit-panel')).toBeVisible({ timeout: 5000 });

        // [check] 40-10. ✅ 再選択しても division + one が維持されている
        const stepTypeSectionAgain = page.locator('.wf-edit-section').filter({ hasText: '承認者種別' }).first();
        const grantSectionAgain = page.locator('.wf-edit-section').filter({ hasText: '組織に対する条件' }).first();
        const typeStill = await stepTypeSectionAgain.locator('input[type="radio"][value="division"]').isChecked();
        const grantStill = await grantSectionAgain.locator('input[type="radio"][value="one"]').isChecked();
        expect(typeStill, '再選択後も division 維持').toBe(true);
        expect(grantStill, '再選択後も one 維持').toBe(true);

        await autoScreenshot(page, 'WF04', 'wf-040', 0, _testStart);

        // 後片付け: モーダルを確実に閉じる (リロード fallback 付き)
        await closeFlowDesignModal(page);
    });

    /**
     * wf-050: visual editor で 2 ステップそれぞれの承認者種別ラジオを独立に設定でき、
     *         片方の変更がもう片方に波及しないこと (PR #2924 regression guard for new UI)
     * @requirements.txt(R-301)
     */
    test('wf-050: ビジュアルエディタで 2 ステップ独立にラジオ設定できること', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();

        // [flow] 50-1. フロー設計モーダル + ステップ 1 追加まで
        //         addStep 後 selectedStepIndex=0 で編集パネルが開いている
        const opened = await openFlowDesignWithStep(page, tableId);
        expect(opened, 'フロー設計モーダルとステップ 1 が準備できていること').toBeTruthy();

        // [flow] 50-2. ステップ 1 の承認者種別を「組織(役職)」に設定
        //         (ステップ 1 の edit panel は既に selectedStepIndex=0 で開いている)
        await expect(page.locator('.wf-edit-panel')).toBeVisible({ timeout: 5000 });
        const stepTypeSection1 = page.locator('.wf-edit-section').filter({ hasText: '承認者種別' }).first();
        await stepTypeSection1.locator('input[type="radio"][value="division"]').click({ force: true });
        await page.waitForTimeout(500);
        const grantSection1 = page.locator('.wf-edit-section').filter({ hasText: '組織に対する条件' }).first();
        await expect(grantSection1).toBeVisible({ timeout: 5000 });
        await grantSection1.locator('input[type="radio"][value="all"]').click({ force: true });
        await page.waitForTimeout(300);

        // [flow] 50-3. ステップ間の + ボタン (.wf-add-btn-between) でステップ 2 追加
        //         addStepAfter は selectedStepIndex=1 に切替わり、ステップ 2 の edit panel が開く
        const addBetween = page.locator('.wf-add-btn-between').first();
        await expect(addBetween).toBeVisible({ timeout: 5000 });
        await addBetween.click();
        await page.waitForTimeout(1500);

        // [check] 50-4. ✅ ステップが 2 件ある
        const step2Count = await page.locator('.wf-step-card').count();
        expect(step2Count, 'ステップ 2 件以上').toBeGreaterThanOrEqual(2);

        // ステップ 2 の編集パネルが開いている (selectedStepIndex=1)
        //   Panel 内の「承認者種別」セクションは常に 1 つだけ表示される
        await expect(page.locator('.wf-edit-panel')).toBeVisible({ timeout: 5000 });
        const stepTypeSection2 = page.locator('.wf-edit-section').filter({ hasText: '承認者種別' }).first();
        // ステップ 2 はまだ admin (デフォルト) のはず
        const s2DefaultAdmin = await stepTypeSection2.locator('input[type="radio"][value="admin"]').isChecked();
        expect(s2DefaultAdmin, 'ステップ 2 のデフォルトは admin').toBe(true);

        // [flow] 50-5. ステップ 2 を「項目」に設定
        await stepTypeSection2.locator('input[type="radio"][value="field"]').click({ force: true });
        await page.waitForTimeout(500);

        // [check] 50-6. ✅ ステップ 2 の field ラジオが checked 状態
        const step2FieldChecked = await stepTypeSection2.locator('input[type="radio"][value="field"]').isChecked();
        expect(step2FieldChecked, 'ステップ 2 field ラジオ選択').toBe(true);

        // [flow] 50-7. ステップ 1 に戻る (selectStep は toggle 動作のためパネル状態で挙動が変わる)
        //   ステップ 2 が現在開いているので、ステップ 1 クリックで selectedStepIndex=0 に切替わる。
        //   万一切替わらず閉じた場合はもう一度クリックして開く。
        //   isVisible() は引数を取らない (timeout 指定不可) ため waitFor で明示待機する。
        const editPanel = page.locator('.wf-edit-panel');
        const firstStepCard = page.locator('.wf-step-card').first();
        await firstStepCard.click();
        let panelVisible = await editPanel.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
        if (!panelVisible) {
            await firstStepCard.click();
            panelVisible = await editPanel.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
        }
        expect(panelVisible, 'ステップ 1 の edit panel が開いていること').toBe(true);

        // [check] 50-8. ✅ ステップ 1 が独立に保持されている (division + all のまま、ステップ 2 の field 変更に引きずられない)
        const stepTypeSectionBack = page.locator('.wf-edit-section').filter({ hasText: '承認者種別' }).first();
        const step1StillDivision = await stepTypeSectionBack.locator('input[type="radio"][value="division"]').isChecked();
        expect(step1StillDivision, 'ステップ 1 は division のまま').toBe(true);
        const grantSectionBack = page.locator('.wf-edit-section').filter({ hasText: '組織に対する条件' }).first();
        const step1StillAll = await grantSectionBack.locator('input[type="radio"][value="all"]').isChecked();
        expect(step1StillAll, 'ステップ 1 は全員の承認のまま').toBe(true);

        await autoScreenshot(page, 'WF04', 'wf-050', 0, _testStart);

        // 後片付け: モーダルを確実に閉じる (リロード fallback 付き)
        await closeFlowDesignModal(page);
    });
});
