'use strict';

/**
 * spec自己完結型テスト環境作成ヘルパー
 *
 * create-trial API（with_all_type_table: true）で環境+ALLテストテーブル+VIEWを一括作成。
 * domain省略でPHP側自動生成。リトライ付き。
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

    // 2. create-trial（リトライ2回）
    // domain省略 → PHP側で短いランダム名を自動生成（504リスク低減）
    // with_all_type_table=true → ALLテストテーブル+VIEW同時作成+table_id返却
    let baseUrl, password, tableId = null;
    const body = { email: 'admin' };
    if (withAllTypeTable) body.with_all_type_table = true;

    for (let attempt = 1; attempt <= 2; attempt++) {
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
        console.log(`[createTestEnv] create-trial attempt ${attempt} 失敗:`, JSON.stringify(result).substring(0, 100));
        if (attempt < 2) await adminPage.waitForTimeout(3000);
    }

    await adminContext.close();

    if (!baseUrl || !password) {
        throw new Error('create-trial が2回とも失敗');
    }

    console.log(`[createTestEnv] 環境作成完了: ${baseUrl}${tableId ? ', tableId: ' + tableId : ''}`);

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

    return { baseUrl, email, password, tableId, context, page };
}

module.exports = { createTestEnv };
