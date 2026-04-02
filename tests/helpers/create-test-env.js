'use strict';

/**
 * spec自己完結型テスト環境作成ヘルパー
 *
 * 各specのbeforeAllで呼び出し、自分専用のテナント環境を作成する。
 * create-trial API（with_all_type_table: true）で環境+ALLテストテーブルを同時作成。
 *
 * 使い方:
 *   const { createTestEnv } = require('./helpers/create-test-env');
 *   let env;
 *   test.beforeAll(async ({ browser }) => {
 *       env = await createTestEnv(browser);
 *   });
 *   // env.baseUrl, env.email, env.password, env.tableId, env.context, env.page
 */

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://ai-test.pigeon-demo.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.TEST_PASSWORD || '';

/**
 * テスト環境を作成し、ログイン済みのcontext/pageを返す
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {Object} [options]
 * @param {boolean} [options.withAllTypeTable=true] - ALLテストテーブルを作成するか
 * @param {number} [options.dataCount=5] - テストデータ件数（未使用: create-trialが33件自動投入）
 * @returns {Promise<{baseUrl: string, email: string, password: string, tableId: number|null, context: any, page: any}>}
 */
async function createTestEnv(browser, options = {}) {
    const { withAllTypeTable = true } = options;

    // 1. 管理画面にログインしてcreate-trial
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();

    try {
        await adminPage.goto(ADMIN_BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await adminPage.waitForSelector('#id', { timeout: 15000 });
        await adminPage.fill('#id', ADMIN_EMAIL);
        await adminPage.fill('#password', ADMIN_PASSWORD);
        await adminPage.locator('button[type=submit].btn-primary').first().click();
        // Angular SPAではwaitForURLが遅い場合があるため、.navbar表示で判定
        await adminPage.waitForSelector('.navbar', { timeout: 30000 });
    } catch (e) {
        await adminContext.close();
        throw new Error(`管理画面ログイン失敗: ${e.message}`);
    }

    // ドメイン名生成（ユニーク）
    const domain = `t${Date.now()}${Math.floor(Math.random() * 100)}`;

    // create-trial API呼び出し（with_all_type_table: trueでALLテストテーブルも同時作成）
    let baseUrl, password;
    try {
        const body = { domain, email: 'admin' };
        if (withAllTypeTable) {
            body.with_all_type_table = true;
        }
        const result = await adminPage.evaluate(async (b) => {
            const r = await fetch('/api/admin/create-trial', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify(b),
                credentials: 'include',
            });
            return r.json();
        }, body);

        if (!result.url || !result.pw) {
            throw new Error(`create-trial失敗: ${JSON.stringify(result)}`);
        }
        baseUrl = result.url;
        password = result.pw;
    } finally {
        await adminContext.close();
    }

    const email = 'admin';
    console.log(`[createTestEnv] 環境作成完了: ${baseUrl}`);

    // 2. 新環境にログインしてcontext/page作成
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(baseUrl + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#id', { timeout: 15000 });
    await page.fill('#id', email);
    await page.fill('#password', password);
    await page.locator('button[type=submit].btn-primary').first().click();
    await page.waitForSelector('.navbar', { timeout: 30000 });

    // storageStateファイルを新環境用に上書き
    const agentNum = process.env.AGENT_NUM || '1';
    const storageStatePath = path.join(process.cwd(), `.auth-state.${agentNum}.json`);
    await context.storageState({ path: storageStatePath });
    console.log(`[createTestEnv] storageState更新: ${storageStatePath}`);

    // 3. ALLテストテーブルのIDを取得（create-trialで同時作成済み）
    let tableId = null;
    if (withAllTypeTable) {
        // debug/statusでテーブルID取得
        const status = await page.evaluate(async () => {
            try {
                const res = await fetch('/api/admin/debug/status', { credentials: 'include' });
                return res.json();
            } catch { return { all_type_tables: [] }; }
        });
        const table = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
        if (table) {
            tableId = table.table_id || table.id;
            console.log(`[createTestEnv] ALLテストテーブル ID: ${tableId}`);
        } else {
            console.warn('[createTestEnv] ALLテストテーブルが見つかりません（create-trialで作成されなかった可能性）');
        }
    }

    return { baseUrl, email, password, tableId, context, page };
}

module.exports = { createTestEnv };
