'use strict';

/**
 * テーブル画面に確実に遷移するヘルパー
 *
 * テーブル作成直後はAngularのメニューデータにテーブルが登録されていないため、
 * dataset__Nへのgotoがダッシュボードにフォールバックする。
 * ダッシュボードリロード→リトライで解決する。
 *
 * 使い方:
 *   const { navigateToTable } = require('./helpers/navigate-to-table');
 *   await navigateToTable(page, BASE_URL, tableId);
 */

async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

/**
 * テーブル一覧画面（/admin/dataset__N）に確実に遷移する
 * @param {import('@playwright/test').Page} page
 * @param {string} baseUrl
 * @param {string|number} tableId
 * @param {Object} [options]
 * @param {number} [options.maxRetries=3] リトライ回数
 * @param {number} [options.retryWait=10000] リトライ間隔（ms）
 */
async function navigateToTable(page, baseUrl, tableId, options = {}) {
    const { maxRetries = 3, retryWait = 10000 } = options;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // ダッシュボードでAngularメニューをリロード
        await page.goto(baseUrl + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await waitForAngular(page);

        // テーブル画面に遷移
        await page.goto(baseUrl + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await page.waitForTimeout(2000);

        // レコード一覧が表示されたか確認
        const hasPlusBtn = await page.locator('button:has(.fa-plus)').count() > 0;
        if (hasPlusBtn) return;

        console.log(`[navigateToTable] テーブル画面未表示 (attempt ${attempt + 1}/${maxRetries}), ${retryWait / 1000}秒後にリトライ`);
        await page.waitForTimeout(retryWait);
    }
    // 最終リトライ後も表示されなかった場合は続行（呼び出し側で判定）
    console.warn(`[navigateToTable] ${maxRetries}回リトライ後もテーブル画面が表示されませんでした`);
}

module.exports = { navigateToTable };
