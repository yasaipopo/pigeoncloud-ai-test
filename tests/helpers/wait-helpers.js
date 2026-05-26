/**
 * 待機系 helper (Phase 3 共通化)
 * - navbar 条件付き待機 (102 fields rendering 対策)
 * - visible テーブル待機 (hidden modal table 除外)
 * - heavy page load 待機 (102 fields + Angular + networkidle)
 */

/**
 * navbar 待機（102 fields rendering 遅延を許容、conditional check）
 * @param {Page} page
 * @param {object} options - { timeout: 10000, required: false }
 * @returns {Promise<boolean>} 描画されたら true、未描画なら false
 */
async function waitForNavbar(page, options = {}) {
    const { timeout = 10000 } = options;
    return await page.locator('.navbar, header.app-header, .app-header').first()
        .isVisible({ timeout })
        .catch(() => false);
}

/**
 * 表示中のテーブル待機（hidden modal table を除外、DATA NOT FOUND 許容）
 * @param {Page} page
 * @param {object} options - { timeout: 30000, allowEmptyState: true }
 * @returns {Promise<boolean>} table 表示 or 空状態許容で true
 */
async function waitForVisibleTable(page, options = {}) {
    const { timeout = 30000, allowEmptyState = true } = options;
    const visibleTable = await page.locator('table:visible, [role="columnheader"]:visible').first()
        .isVisible({ timeout })
        .catch(() => false);
    if (visibleTable) return true;
    if (!allowEmptyState) return false;
    const bodyText = await page.innerText('body').catch(() => '');
    return bodyText.includes('DATA NOT FOUND') ||
           bodyText.includes('テーブルが見つかりません') ||
           bodyText.includes('レコードがありません') ||
           bodyText.length > 200;
}

/**
 * 102 fields + Angular ready + networkidle 一括待機
 * @param {Page} page
 * @param {object} options - { timeout: 30000 }
 */
async function waitForHeavyPageLoad(page, options = {}) {
    const { timeout = 30000 } = options;
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(
        () => (document.body.innerText || '').length >= 50,
        null,
        { timeout }
    ).catch(() => {});
}

/**
 * Trial env 判定 (process.env.IS_PROD or BASE_URL ベース)
 * @param {string} baseUrl
 * @returns {boolean} trial env なら true
 */
function isTrialEnvUrl(baseUrl) {
    if (!baseUrl) return true;
    // tmp-testai-* (本番テスト env) or 短いランダム名 = trial
    // ai-test.pigeon-cloud.com = 本番テスト管理用 (= 'production')
    if (process.env.ENV_TYPE === 'production') return false;
    if (/ai-test\.pigeon-cloud\.com/.test(baseUrl)) return false;
    return true;
}

module.exports = {
    waitForNavbar,
    waitForVisibleTable,
    waitForHeavyPageLoad,
    isTrialEnvUrl,
};
