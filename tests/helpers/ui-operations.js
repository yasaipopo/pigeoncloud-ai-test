'use strict';

/**
 * PigeonCloud E2E 共通UI操作ヘルパー
 *
 * spec.js作成時に参照・利用する共通パターンをまとめたファイル。
 * 新しいspec.jsを書く際はここのヘルパーを使い、同じコードを複数のspecに重複させないこと。
 *
 * 使用例:
 *   const { waitForAngular, closeModal, openBulkEditModal, clickDialogButton } = require('./helpers/ui-operations');
 */

const BASE_URL = process.env.TEST_BASE_URL;

// =============================================================================
// Angular / ページ待機
// =============================================================================

/**
 * Angularのレンダリング完了を待つ（body[data-ng-ready="true"]）
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeout=15000]
 */
async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        // data-ng-readyが設定されないケースがある: networkidleで代替
        await page.waitForLoadState('networkidle').catch(() => {});
    }
}

/**
 * テーブル一覧ページの描画完了を待つ（tr[mat-row]が1件以上表示されるまで）
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeout=30000]
 */
async function waitForTableRows(page, timeout = 30000) {
    await page.waitForSelector('tr[mat-row]', { timeout });
    await waitForAngular(page);
}

// =============================================================================
// ナビゲーション
// =============================================================================

/**
 * 管理画面トップ（ダッシュボード）に移動
 * @param {import('@playwright/test').Page} page
 */
async function goDashboard(page) {
    await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitForAngular(page);
}

/**
 * レコード一覧ページに移動
 * @param {import('@playwright/test').Page} page
 * @param {string} tableId
 */
async function goRecordList(page, tableId) {
    await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitForAngular(page);
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
}

/**
 * レコード詳細ページに移動
 * @param {import('@playwright/test').Page} page
 * @param {string} tableId
 * @param {string} recordId
 */
async function goRecordView(page, tableId, recordId) {
    await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitForAngular(page);
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
}

/**
 * テーブル設定（フィールド編集）ページに移動
 * @param {import('@playwright/test').Page} page
 * @param {string} tableId
 */
async function goTableEdit(page, tableId) {
    await page.goto(BASE_URL + `/admin/dataset/edit/${tableId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitForAngular(page);
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
}

/**
 * テーブル定義一覧（/admin/dataset）に移動
 * @param {import('@playwright/test').Page} page
 */
async function goDatasetList(page) {
    await page.goto(BASE_URL + '/admin/dataset', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitForAngular(page);
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
}

// =============================================================================
// モーダル操作
// =============================================================================

/**
 * 表示中のモーダルを閉じる（キャンセル/閉じるボタンを優先）
 * @param {import('@playwright/test').Page} page
 * @param {boolean} [useEscape=false] - trueの場合Escapeキーで閉じる
 */
async function closeModal(page, useEscape = false) {
    try {
        if (useEscape) {
            await page.keyboard.press('Escape');
            await waitForAngular(page);
            return;
        }
        const modal = page.locator('.modal.show').first();
        const cnt = await modal.count();
        if (cnt === 0) return;
        const closeBtn = modal.locator(
            'button.btn-secondary, button.close, button.btn-close, button:has-text("キャンセル"), button:has-text("閉じる")'
        ).first();
        if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await closeBtn.click({ force: true });
            await waitForAngular(page);
        }
    } catch (e) {
        // モーダルがなければ何もしない
    }
}

/**
 * 起動時テンプレート選択モーダルを閉じる
 * @param {import('@playwright/test').Page} page
 */
async function closeTemplateModal(page) {
    try {
        const modal = page.locator('div.modal.show');
        if (await modal.count() > 0) {
            await modal.locator('button').first().click({ force: true });
            await waitForAngular(page);
        }
    } catch (e) {}
}

/**
 * ハンバーガーメニューを開く
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<import('@playwright/test').Locator>} 開いたドロップダウンメニューのlocator
 */
async function openHamburgerMenu(page) {
    const hamburgerBtn = page.locator('button:has(.fa-bars)').first();
    await hamburgerBtn.waitFor({ state: 'visible', timeout: 10000 });
    await hamburgerBtn.click();
    await waitForAngular(page);
    const dropdown = page.locator('.dropdown-menu.show');
    await dropdown.waitFor({ state: 'visible', timeout: 5000 });
    return dropdown;
}

/**
 * 一括編集モーダルを開く（ハンバーガーメニュー→「一括編集」）
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<import('@playwright/test').Locator>} 開いたモーダルのlocator
 */
async function openBulkEditModal(page) {
    const dropdown = await openHamburgerMenu(page);
    const bulkEditItem = dropdown.locator('.dropdown-item:has-text("一括編集")').first();
    await bulkEditItem.waitFor({ state: 'visible', timeout: 5000 });
    await bulkEditItem.click();
    await waitForAngular(page);
    const modal = page.locator('.modal.show').first();
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    return modal;
}

// =============================================================================
// フォーム・入力操作
// =============================================================================

/**
 * フィールド追加モーダルを開く（「項目を追加する」ボタンをクリック）
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>} モーダルが開いた場合true
 */
async function openAddFieldModal(page) {
    const addFieldBtn = page.locator('button').filter({ hasText: /項目を追加/ }).filter({ visible: true }).first();
    await addFieldBtn.waitFor({ state: 'visible', timeout: 10000 });
    await addFieldBtn.click({ force: true });
    await waitForAngular(page);
    const modal = page.locator('.modal.settingModal.show');
    return await modal.isVisible({ timeout: 10000 }).catch(() => false);
}

/**
 * settingModal内でフィールドタイプを選択する（evaluate経由でAngularイベントを確実に発火）
 * @param {import('@playwright/test').Page} page
 * @param {string} fieldTypeText - フィールドタイプのボタンテキスト（例: '関連レコード一覧', 'テキスト'）
 * @returns {Promise<boolean>} クリック成功した場合true
 */
async function selectFieldType(page, fieldTypeText) {
    return await page.evaluate((text) => {
        const modal = document.querySelector('.modal.settingModal.show');
        if (!modal) return false;
        const buttons = Array.from(modal.querySelectorAll('button'));
        const btn = buttons.find(b => b.textContent && b.textContent.trim().includes(text));
        if (btn) { btn.click(); return true; }
        return false;
    }, fieldTypeText);
}

/**
 * settingModal内の保存ボタンをクリックする（evaluate経由）
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>} クリック成功した場合true
 */
async function clickFieldSaveButton(page) {
    return await page.evaluate(() => {
        const modal = document.querySelector('.modal.settingModal.show');
        if (!modal) return false;
        const btn = modal.querySelector('[data-testid="field-save-btn"]') || modal.querySelector('button.btn-primary');
        if (btn) { btn.click(); return true; }
        return false;
    });
}

// =============================================================================
// ダイアログ（native alert/confirm）
// =============================================================================

/**
 * ネイティブダイアログ（alert/confirm）をキャプチャして受け入れる
 * クリック前にこの関数を呼ぶこと。
 *
 * @param {import('@playwright/test').Page} page
 * @returns {{ getMessage: () => string }} ダイアログメッセージを取得できるオブジェクト
 *
 * @example
 *   const dialog = captureDialog(page);
 *   await deleteBtn.click();
 *   await page.waitForTimeout(1000);
 *   expect(dialog.getMessage()).toContain('参照');
 */
function captureDialog(page) {
    let message = '';
    page.once('dialog', async (dialog) => {
        message = dialog.message();
        await dialog.accept();
    });
    return { getMessage: () => message };
}

// =============================================================================
// レコード操作
// =============================================================================

/**
 * 一覧の最初のレコードのIDを取得する（data-record-id属性 → checkbox値にフォールバック）
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string|null>}
 */
async function getFirstRecordId(page) {
    const firstRow = page.locator('tr[mat-row]').first();
    await firstRow.waitFor({ state: 'visible', timeout: 15000 });

    // PR #2846以降: data-record-id属性から取得
    const dataRecordId = await firstRow.getAttribute('data-record-id', { timeout: 3000 }).catch(() => null);
    if (dataRecordId) return dataRecordId;

    // フォールバック: checkbox value
    const checkbox = page.locator('tr[mat-row] input[type="checkbox"]').first();
    return await checkbox.getAttribute('value', { timeout: 5000 }).catch(() => null);
}

/**
 * 一覧の最初のレコードの詳細ページURLを取得する（data-record-url属性から）
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string|null>}
 */
async function getFirstRecordUrl(page) {
    const detailBtn = page.locator('button[data-record-url]').first();
    if (await detailBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        return await detailBtn.getAttribute('data-record-url').catch(() => null);
    }
    return null;
}

/**
 * 一覧の最初のレコードの詳細ページを開く
 * @param {import('@playwright/test').Page} page
 * @param {string} tableId
 */
async function openFirstRecord(page, tableId) {
    const recUrl = await getFirstRecordUrl(page);
    if (recUrl) {
        await page.goto(BASE_URL + recUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    } else {
        const recordId = await getFirstRecordId(page);
        if (recordId) {
            await goRecordView(page, tableId, recordId);
        }
    }
    await waitForAngular(page);
}

/**
 * レコードの編集モードを開始する（「編集」ボタンをクリック）
 * @param {import('@playwright/test').Page} page
 */
async function startRecordEdit(page) {
    const editBtn = page.locator(
        'button:has-text("編集"), a:has-text("編集")'
    ).filter({ visible: true }).first();
    await editBtn.waitFor({ state: 'visible', timeout: 8000 });
    await editBtn.click();
    await waitForAngular(page);
}

/**
 * レコード編集をキャンセルする（「キャンセル」ボタンをクリック）
 * @param {import('@playwright/test').Page} page
 */
async function cancelRecordEdit(page) {
    const cancelBtn = page.locator(
        'button:has-text("キャンセル"), a:has-text("キャンセル")'
    ).filter({ visible: true }).first();
    await cancelBtn.waitFor({ state: 'visible', timeout: 8000 });
    await cancelBtn.click();
    await waitForAngular(page);
}

/**
 * レコード編集を保存する（「保存」ボタンをクリック）
 * @param {import('@playwright/test').Page} page
 */
async function saveRecordEdit(page) {
    const saveBtn = page.locator(
        'button:has-text("保存"), button[type="submit"]:has-text("保存"), a:has-text("保存")'
    ).filter({ visible: true }).first();
    await saveBtn.waitFor({ state: 'visible', timeout: 8000 });
    await saveBtn.click();
    await waitForAngular(page);
}

// =============================================================================
// テーブル定義（/admin/dataset）
// =============================================================================

/**
 * テーブル定義一覧でテーブルの削除ボタンを取得する
 * NOTE: /admin/dataset の一覧は li.cdk-drag 形式（trではない）
 * @param {import('@playwright/test').Page} page
 * @param {string} tableName
 * @returns {Promise<import('@playwright/test').Locator|null>}
 */
async function getTableDeleteButton(page, tableName) {
    const btn = page.locator(
        `li:has-text("${tableName}") button.btn-danger, ` +
        `li.cdk-drag:has-text("${tableName}") button.btn-danger`
    ).filter({ visible: true }).first();
    const cnt = await btn.count();
    return cnt > 0 ? btn : null;
}

// =============================================================================
// エラー確認
// =============================================================================

/**
 * ページにエラーが表示されていないことを確認する
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<number>} エラー要素の件数
 */
async function getErrorCount(page) {
    const errorEl = page.locator('.alert-danger, .error-message, .toast-error').filter({ visible: true });
    return await errorEl.count();
}

/**
 * エラーメッセージが表示されることを確認する
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeout=5000]
 * @returns {Promise<import('@playwright/test').Locator>}
 */
async function waitForErrorMessage(page, timeout = 5000) {
    const errorMsg = page.locator(
        '.error, .alert-danger, [class*="error"], .invalid-feedback, .toast-error, .toast-message'
    ).filter({ visible: true }).first();
    await errorMsg.waitFor({ state: 'visible', timeout });
    return errorMsg;
}

// =============================================================================
// exports
// =============================================================================

module.exports = {
    // Angular/ページ待機
    waitForAngular,
    waitForTableRows,

    // ナビゲーション
    goDashboard,
    goRecordList,
    goRecordView,
    goTableEdit,
    goDatasetList,

    // モーダル操作
    closeModal,
    closeTemplateModal,
    openHamburgerMenu,
    openBulkEditModal,

    // フィールド追加モーダル
    openAddFieldModal,
    selectFieldType,
    clickFieldSaveButton,

    // ダイアログ
    captureDialog,

    // レコード操作
    getFirstRecordId,
    getFirstRecordUrl,
    openFirstRecord,
    startRecordEdit,
    cancelRecordEdit,
    saveRecordEdit,

    // テーブル定義
    getTableDeleteButton,

    // エラー確認
    getErrorCount,
    waitForErrorMessage,
};
