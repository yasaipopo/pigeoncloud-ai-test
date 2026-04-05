'use strict';

/**
 * テーブル画面に確実に遷移するヘルパー
 *
 * 問題: Angular SPA の dataset__N ルートは、直接 goto すると
 * ルートガードの非同期 API 呼び出しが間に合わずダッシュボードにリダイレクトされることがある。
 *
 * 解決策:
 * 1. まずダッシュボードに goto してAngularメニューを完全ロード（サイドバーリンクが表示されるまで待機）
 * 2. サイドバーリンクをクリック（SPA ナビゲーション = ルートガード問題を回避）
 * 3. SPA nav 失敗時は direct goto でフォールバック
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
    const targetPath = `/admin/dataset__${tableId}`;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // ダッシュボードへ遷移してAngularメニューを完全ロード
        await page.goto(baseUrl + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await waitForAngular(page);

        // サイドバーリンクが非同期APIでロードされるまで待つ（最大10秒）
        const tableLink = page.locator(`a[href*="${targetPath}"]`).first();
        await tableLink.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

        if (await tableLink.isVisible().catch(() => false)) {
            // 優先: サイドバーリンクをクリック（SPA ナビゲーション）
            // ルートガードの非同期API呼び出しタイミング問題を回避できる
            await tableLink.click();
            await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
            await waitForAngular(page);
            await page.waitForTimeout(2000);
            if (page.url().includes(targetPath)) {
                return; // サイドバークリックで成功
            }
            console.log(`[navigateToTable] SPA nav 後 URL 不一致: ${page.url()}`);
        } else {
            console.log(`[navigateToTable] サイドバーリンクが10秒以内に表示されなかった (attempt ${attempt + 1})`);
        }

        // フォールバック: direct goto で遷移試行
        await page.goto(baseUrl + targetPath, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await page.waitForTimeout(2000);
        if (page.url().includes(targetPath)) {
            return; // direct goto で成功
        }

        console.log(`[navigateToTable] テーブル画面未表示 (attempt ${attempt + 1}/${maxRetries}), URL: ${page.url()}, ${retryWait / 1000}秒後にリトライ`);
        if (attempt < maxRetries - 1) await page.waitForTimeout(retryWait);
    }
    console.warn(`[navigateToTable] ${maxRetries}回リトライ後もテーブル画面が表示されませんでした (tableId: ${tableId})`);
}

module.exports = { navigateToTable };
