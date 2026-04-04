'use strict';

/**
 * spec自己完結型テスト環境作成ヘルパー
 *
 * create-trial API（with_all_type_table: true）で環境作成+テーブル作成をバックグラウンド開始。
 * テーブル作成完了はテスト側でポーリング（ALBタイムアウトに依存しない）。
 */

const path = require('path');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://ai-test.pigeon-demo.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.TEST_PASSWORD || '';

async function createTestEnv(browser, options = {}) {
    const { withAllTypeTable = true } = options;

    // 1. 管理画面にログイン
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();

    // ログインリトライ（並列実行時のセッション競合対策）
    let loginOk = false;
    for (let loginAttempt = 1; loginAttempt <= 3; loginAttempt++) {
        try {
            await adminPage.goto(ADMIN_BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await adminPage.waitForSelector('#id', { timeout: 15000 });
            await adminPage.fill('#id', ADMIN_EMAIL);
            await adminPage.fill('#password', ADMIN_PASSWORD);
            await adminPage.locator('button[type=submit].btn-primary').first().click();
            await adminPage.waitForSelector('.navbar', { timeout: 30000 });
            loginOk = true;
            break;
        } catch (e) {
            console.log(`[createTestEnv] ログイン attempt ${loginAttempt}/3 失敗: ${e.message.substring(0, 50)}`);
            if (loginAttempt < 3) await adminPage.waitForTimeout(3000 + Math.random() * 2000);
        }
    }
    if (!loginOk) {
        await adminContext.close();
        throw new Error('管理画面ログインが3回とも失敗');
    }

    // 2. create-trial（リトライ3回）
    let baseUrl, password, tableId = null;
    const body = { email: 'admin' };
    if (withAllTypeTable) body.with_all_type_table = true;

    for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await adminPage.evaluate(async (b) => {
            try {
                const r = await fetch('/api/admin/create-trial', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify(b),
                    credentials: 'include',
                });
                if (!r.ok) return { error: true, status: r.status };
                return await r.json();
            } catch (e) {
                return { error: true, message: e.message };
            }
        }, body);

        if (result.url && result.pw) {
            baseUrl = result.url;
            password = result.pw;
            tableId = result.table_id || null;
            break;
        }
        console.log(`[createTestEnv] create-trial attempt ${attempt}/3 失敗:`, JSON.stringify(result).substring(0, 100));
        if (attempt < 3) await adminPage.waitForTimeout(5000);
    }

    await adminContext.close();

    if (!baseUrl || !password) {
        throw new Error('create-trial が3回とも失敗');
    }

    console.log(`[createTestEnv] 環境作成完了: ${baseUrl}${tableId ? ', tableId: ' + tableId : ', テーブル作成中...'}`);

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

    // 4. テーブルIDが未取得の場合、テスト側でポーリング（最大120秒）
    // PHP側はバックグラウンドでテーブル作成中 → ALBタイムアウトに依存しない
    if (withAllTypeTable && !tableId) {
        console.log('[createTestEnv] テーブル作成完了をポーリング中...');
        for (let i = 0; i < 48; i++) {
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
                console.log(`[createTestEnv] テーブル作成完了: tableId=${tableId} (${(i + 1) * 5}秒)`);
                break;
            }
        }
        if (!tableId) {
            console.warn('[createTestEnv] テーブル作成が240秒以内に完了しませんでした');
        }
    }

    return { baseUrl, email, password, tableId, context, page };
}

module.exports = { createTestEnv };
