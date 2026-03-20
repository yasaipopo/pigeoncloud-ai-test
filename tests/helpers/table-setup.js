/**
 * ALLテストテーブル作成ヘルパー
 *
 * 【設計方針】
 * - create-all-type-table APIは504タイムアウトを返すことがあるが、
 *   バックエンドは処理を継続している場合が多い
 * - 504を「失敗」と判定してdeleteを再実行してはいけない
 * - APIを呼んだ後、ポーリングでテーブル存在を確認する
 */

'use strict';

const BASE_URL = process.env.TEST_BASE_URL;

/**
 * ALLテストテーブルを作成する（ポーリング方式）
 *
 * @param {import('@playwright/test').Page} page - ログイン済みのページ
 * @param {Object} options
 * @param {number} [options.pollIntervalMs=10000] - ポーリング間隔（ms）
 * @param {number} [options.maxPolls=30] - 最大ポーリング回数（30×10秒=300秒）
 * @returns {Promise<{result: string, tableId: string|null}>} 成功時 {result: 'success', tableId: string}、失敗時 {result: 'failure', tableId: null}
 */
async function setupAllTypeTable(page, { pollIntervalMs = 10000, maxPolls = 30 } = {}) {
    // 1. まず既存テーブルを確認（deleteしない）
    const existingId = await getAllTypeTableId(page);
    if (existingId) {
        return { result: 'success', tableId: String(existingId) };
    }

    // 2. 作成APIを呼ぶ（504が来てもOK、fire-and-forget）
    page.evaluate(async (baseUrl) => {
        fetch(baseUrl + '/api/admin/debug/create-all-type-table', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({}),
            credentials: 'include',
        }).catch(() => {});
    }, BASE_URL).catch(() => {});

    // 3. ポーリングでテーブル作成完了を確認
    for (let i = 0; i < maxPolls; i++) {
        await page.waitForTimeout(pollIntervalMs);
        const tableId = await getAllTypeTableId(page);
        if (tableId) {
            return { result: 'success', tableId: String(tableId) };
        }
    }

    // 4. タイムアウト → fallback: ダッシュボードから既存テーブルを探す
    try {
        await page.goto(BASE_URL + '/admin/dashboard');
        await page.waitForLoadState('domcontentloaded');
        const href = await page.locator('a[href*="/admin/dataset__"]').first()
            .getAttribute('href', { timeout: 10000 }).catch(() => null);
        if (href) {
            const match = href.match(/dataset__(\d+)/);
            if (match) return { result: 'success', tableId: match[1] };
        }
    } catch (e) {}

    return { result: 'failure', tableId: null };
}

/**
 * ALLテストテーブルのIDをdebug status APIから取得する
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string|null>}
 */
async function getAllTypeTableId(page) {
    try {
        const status = await page.evaluate(async (baseUrl) => {
            const res = await fetch(baseUrl + '/api/admin/debug/status', {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            return res.json();
        }, BASE_URL);
        const table = (status?.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
        if (table) return String(table.table_id || table.id);
    } catch (e) {}
    return null;
}

/**
 * ALLテストテーブルを全削除する（afterAll用）
 *
 * @param {import('@playwright/test').Page} page
 */
async function deleteAllTypeTables(page) {
    try {
        await page.evaluate(async (baseUrl) => {
            await fetch(baseUrl + '/api/admin/debug/delete-all-type-tables', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({}),
                credentials: 'include',
            });
        }, BASE_URL);
    } catch (e) {
        // クリーンアップ失敗は無視
    }
}

/**
 * テストデータを投入する
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} count - レコード件数
 * @param {string} pattern - 'fixed' | 'random' | 'max' | 'min'
 */
async function createAllTypeData(page, count = 5, pattern = 'fixed') {
    // 既にデータがあればスキップ
    try {
        const status = await page.evaluate(async (baseUrl) => {
            const res = await fetch(baseUrl + '/api/admin/debug/status', { credentials: 'include' });
            return res.json();
        }, BASE_URL);
        const table = (status?.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
        if (table && table.count >= count) return;
    } catch (e) {}

    await page.evaluate(async ({ baseUrl, count, pattern }) => {
        await fetch(baseUrl + '/api/admin/debug/create-all-type-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ count, pattern }),
            credentials: 'include',
        });
    }, { baseUrl: BASE_URL, count, pattern });
}

module.exports = { setupAllTypeTable, getAllTypeTableId, deleteAllTypeTables, createAllTypeData };
