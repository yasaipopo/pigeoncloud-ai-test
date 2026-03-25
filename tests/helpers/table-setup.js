/**
 * ALLテストテーブル作成ヘルパー
 *
 * 【設計方針】
 * - create-all-type-table APIは504タイムアウトを返すことがあるが、
 *   バックエンドは処理を継続している場合が多い
 * - 504を「失敗」と判定してdeleteを再実行してはいけない
 * - APIを呼んだ後、ポーリングでテーブル存在を確認する
 * - login_max_devices等でセッション切れが起きた場合は自動再ログインして継続する
 */

'use strict';

const BASE_URL = process.env.TEST_BASE_URL;

// login_error検出時の特別値
const LOGIN_ERROR_SENTINEL = '__LOGIN_ERROR__';

/**
 * login_max_devices等でセッション切れた場合に再ログインする
 * @param {import('@playwright/test').Page} page
 */
async function reloginIfNeeded(page) {
    const baseUrl = process.env.TEST_BASE_URL || BASE_URL;
    const email = process.env.TEST_EMAIL || 'admin';
    const password = process.env.TEST_PASSWORD || '';
    try {
        await page.goto(baseUrl + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('#id', { timeout: 15000 });
        await page.fill('#id', email);
        await page.fill('#password', password);
        await page.click('button[type=submit].btn-primary');
        await page.waitForURL('**/admin/dashboard', { timeout: 40000 }).catch(() => {});
        await page.waitForTimeout(1500);
    } catch (e) {
        // 再ログイン失敗は無視して継続
    }
}

/**
 * ALLテストテーブルを作成する（ポーリング方式）
 *
 * @param {import('@playwright/test').Page} page - ログイン済みのページ
 * @param {Object} options
 * @param {number} [options.pollIntervalMs=10000] - ポーリング間隔（ms）
 * @param {number} [options.maxPolls=20] - 最大ポーリング回数（20×10秒=200秒）
 * @returns {Promise<{result: string, tableId: string|null}>} 成功時 {result: 'success', tableId: string}、失敗時 {result: 'failure', tableId: null}
 */
async function setupAllTypeTable(page, { pollIntervalMs = 10000, maxPolls = 20 } = {}) {
    // 1. まず既存テーブルを確認（deleteしない）
    const existingId = await getAllTypeTableId(page);
    if (existingId === LOGIN_ERROR_SENTINEL) {
        await reloginIfNeeded(page);
    } else if (existingId) {
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
    }, process.env.TEST_BASE_URL || BASE_URL).catch(() => {});

    // 3. ポーリングでテーブル作成完了を確認
    for (let i = 0; i < maxPolls; i++) {
        await page.waitForTimeout(pollIntervalMs);
        const tableId = await getAllTypeTableId(page);
        if (tableId === LOGIN_ERROR_SENTINEL) {
            // login_max_devices等でセッション切れ → 再ログインして作成API再発行
            await reloginIfNeeded(page);
            page.evaluate(async (baseUrl) => {
                fetch(baseUrl + '/api/admin/debug/create-all-type-table', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({}),
                    credentials: 'include',
                }).catch(() => {});
            }, process.env.TEST_BASE_URL || BASE_URL).catch(() => {});
            continue;
        }
        if (tableId) {
            return { result: 'success', tableId: String(tableId) };
        }
    }

    // 4. タイムアウト → fallback: ダッシュボードから既存テーブルを探す
    try {
        const baseUrl = process.env.TEST_BASE_URL || BASE_URL;
        await page.goto(baseUrl + '/admin/dashboard');
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
 * @returns {Promise<string|null|'__LOGIN_ERROR__'>}
 *   テーブルID or null（未作成）or '__LOGIN_ERROR__'（セッション切れ）
 */
async function getAllTypeTableId(page) {
    try {
        const baseUrl = process.env.TEST_BASE_URL || BASE_URL;
        const status = await page.evaluate(async (baseUrl) => {
            const res = await fetch(baseUrl + '/api/admin/debug/status', {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            return res.json();
        }, baseUrl);
        // セッション切れ（login_max_devices等）を検出
        if (status?.result === 'error' && status?.error_type === 'login_error') {
            return '__LOGIN_ERROR__';
        }
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
        // fire-and-forgetで削除（タイムアウト対策。削除の完了を待たない）
        await page.evaluate(async (baseUrl) => {
            fetch(baseUrl + '/api/admin/debug/delete-all-type-tables', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({}),
                credentials: 'include',
            }).catch(() => {});
        }, BASE_URL).catch(() => {});
        // 少し待ってから返る（削除処理が開始されたことを確認）
        await page.waitForTimeout(3000).catch(() => {});
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
