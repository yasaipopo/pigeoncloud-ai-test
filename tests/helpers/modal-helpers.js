/**
 * Angular モーダル操作系 helper (Phase 3 共通化)
 * - Angular モーダル強閉じ (force + Escape + reload fallback)
 * - フィールド設定モーダル open (.pc-field-block hover → 歯車 click)
 * - 項目追加ボタン click + modal 待ち
 */

/**
 * Angular モーダル強閉じ (multi-level fallback)
 * @param {Page} page
 * @param {object} options - { useEscape: true, useReload: true, timeout: 5000 }
 * @returns {Promise<boolean>} 閉じれたら true
 */
async function closeAngularModal(page, options = {}) {
    const { useEscape = true, useReload = true, timeout = 5000 } = options;

    const modal = page.locator('.modal.show').first();
    if (await modal.count() === 0) return true;

    // Level 1: キャンセル/閉じる button (force: true で Ladda spinner 干渉回避)
    const closeBtn = modal.locator(
        'button:has-text("キャンセル"), button:has-text("閉じる"), button.btn-secondary, button.close, button.btn-close, button[aria-label="Close"]'
    ).first();

    if (await closeBtn.count() > 0) {
        await closeBtn.click({ force: true, timeout }).catch(() => {});
        await page.waitForTimeout(300);
        if (await page.locator('.modal.show').count() === 0) return true;
    }

    // Level 2: Escape key
    if (useEscape) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
        if (await page.locator('.modal.show').count() === 0) return true;
    }

    // Level 3: page.reload fallback
    if (useReload && await page.locator('.modal.show').count() > 0) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => {});
        return true;
    }

    return await page.locator('.modal.show').count() === 0;
}

/**
 * フィールド設定モーダル open (歯車 click)
 * @param {Page} page
 * @param {string} fieldName - .pc-field-block の hasText で識別 (例: 'ファイル', '画像')
 * @returns {Promise<Locator>} 開いたモーダル content の Locator
 */
async function openFieldSettingModal(page, fieldName) {
    const fieldBlock = page.locator('.pc-field-block').filter({ hasText: fieldName }).first();
    await fieldBlock.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await fieldBlock.hover().catch(() => {});
    await fieldBlock.locator('.overSetting .fa-gear').click({ force: true });
    const modal = page.locator('.settingModal:visible .modal-content').first();
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    return modal;
}

/**
 * 「項目を追加する」ボタン click + モーダル open 待ち (force: true)
 * @param {Page} page
 * @returns {Promise<boolean>} モーダル open 成功なら true
 */
async function clickAddFieldButton(page) {
    const btn = page.locator('button:has-text("項目を追加する")').first();
    await btn.click({ force: true, timeout: 10000 }).catch(() => {});
    const modal = page.locator('.modal.settingModal.show, .modal.show').first();
    return await modal.isVisible({ timeout: 10000 }).catch(() => false);
}

module.exports = {
    closeAngularModal,
    openFieldSettingModal,
    clickAddFieldButton,
};
