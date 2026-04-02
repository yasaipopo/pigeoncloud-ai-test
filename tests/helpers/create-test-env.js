'use strict';

/**
 * spec自己完結型テスト環境作成ヘルパー
 *
 * 各specのbeforeAllで呼び出し、自分専用のテナント環境を作成する。
 * create-trial APIで環境作成。with_all_type_table=trueが使えればテーブル同時作成。
 * 504/失敗時はフォールバックでdebug/create-all-type-tableを使用。
 */

const path = require('path');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://ai-test.pigeon-demo.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.TEST_PASSWORD || '';

/**
 * create-trial APIを呼ぶ（504対策付き）
 */
async function callCreateTrial(adminPage, body) {
    return await adminPage.evaluate(async (b) => {
        try {
            const r = await fetch('/api/admin/create-trial', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify(b),
                credentials: 'include',
            });
            if (!r.ok) {
                const text = await r.text().catch(() => '');
                return { error: true, status: r.status, message: text.substring(0, 200) };
            }
            return await r.json();
        } catch (e) {
            return { error: true, message: e.message };
        }
    }, body);
}

async function createTestEnv(browser, options = {}) {
    const { withAllTypeTable = true } = options;

    // 1. 管理画面にログイン
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();

    try {
        await adminPage.goto(ADMIN_BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await adminPage.waitForSelector('#id', { timeout: 15000 });
        await adminPage.fill('#id', ADMIN_EMAIL);
        await adminPage.fill('#password', ADMIN_PASSWORD);
        await adminPage.locator('button[type=submit].btn-primary').first().click();
        await adminPage.waitForSelector('.navbar', { timeout: 30000 });
    } catch (e) {
        await adminContext.close();
        throw new Error(`管理画面ログイン失敗: ${e.message}`);
    }

    // 2. create-trial API（domain省略でPHP側自動生成 — DB名衝突回避）
    let baseUrl, password, tableId = null;
    try {
        // まず with_all_type_table=true で試行（テーブル+VIEW同時作成）
        let result = withAllTypeTable
            ? await callCreateTrial(adminPage, { email: 'admin', with_all_type_table: true })
            : await callCreateTrial(adminPage, { email: 'admin' });

        // 失敗（504/500/エラー）時はwith_all_type_tableなしでリトライ
        if (!result.url || !result.pw) {
            if (withAllTypeTable) {
                console.log('[createTestEnv] with_all_type_table付きで失敗、なしでリトライ');
            }
            result = await callCreateTrial(adminPage, { email: 'admin' });
        }

        if (!result.url || !result.pw) {
            throw new Error(`create-trial失敗: ${JSON.stringify(result).substring(0, 200)}`);
        }
        baseUrl = result.url;
        password = result.pw;
        if (result.table_id) {
            tableId = result.table_id;
            console.log(`[createTestEnv] 環境+テーブル同時作成完了: ${baseUrl}, tableId: ${tableId}`);
        } else {
            console.log(`[createTestEnv] 環境作成完了: ${baseUrl}`);
        }
    } finally {
        await adminContext.close();
    }

    // 3. 新環境にログイン
    const email = 'admin';
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(baseUrl + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#id', { timeout: 15000 });
    await page.fill('#id', email);
    await page.fill('#password', password);
    await page.locator('button[type=submit].btn-primary').first().click();
    await page.waitForSelector('.navbar', { timeout: 30000 });

    // storageState更新
    const agentNum = process.env.AGENT_NUM || '1';
    const storageStatePath = path.join(process.cwd(), `.auth-state.${agentNum}.json`);
    await context.storageState({ path: storageStatePath });
    console.log(`[createTestEnv] storageState更新: ${storageStatePath}`);

    // 4. tableIdが未取得の場合フォールバック（debug/create-all-type-table + ポーリング）
    if (withAllTypeTable && !tableId) {
        console.log('[createTestEnv] tableId未取得、debug APIでフォールバック');
        page.evaluate(async () => {
            fetch('/api/admin/debug/create-all-type-table', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: '{}', credentials: 'include',
            }).catch(() => {});
        }).catch(() => {});
        for (let i = 0; i < 12; i++) {
            await page.waitForTimeout(5000);
            const status = await page.evaluate(async () => {
                try {
                    const res = await fetch('/api/admin/debug/status', { credentials: 'include' });
                    return res.json();
                } catch { return { all_type_tables: [] }; }
            });
            const table = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
            if (table) {
                tableId = table.table_id || table.id;
                console.log(`[createTestEnv] フォールバック完了: tableId=${tableId}`);
                break;
            }
        }
    }

    return { baseUrl, email, password, tableId, context, page };
}

module.exports = { createTestEnv };
