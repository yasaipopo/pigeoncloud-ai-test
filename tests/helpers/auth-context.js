/**
 * beforeAll用 認証済みコンテキスト作成ヘルパー
 *
 * browser.newPage() は storageState が適用されないため、
 * beforeAll 内で API 呼び出し（debug/status 等）が認証エラーになる。
 * このヘルパーで storageState 付きの context + page を作成する。
 *
 * @see .claude/knowledge-e2e-angular.md 知見1
 */

'use strict';

const fs = require('fs');
const { getAuthStatePath } = require('./env-guard');

/**
 * storageState を適用した BrowserContext + Page を作成する
 *
 * @param {import('@playwright/test').Browser} browser
 * @returns {Promise<{context: import('@playwright/test').BrowserContext, page: import('@playwright/test').Page}>}
 */
async function createAuthContext(browser) {
    const agentNum = process.env.AGENT_NUM || '1';
    const authStatePath = getAuthStatePath(agentNum);
    const context = await browser.newContext(
        fs.existsSync(authStatePath) ? { storageState: authStatePath } : {}
    );
    const page = await context.newPage();

    // storageStateセッション切れ対策: dashboardに遷移してログイン状態を確認
    const BASE_URL = process.env.TEST_BASE_URL;
    if (BASE_URL) {
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        // ログイン画面にリダイレクトされた場合は再ログイン
        if (page.url().includes('/admin/login')) {
            const EMAIL = process.env.TEST_EMAIL || 'admin';
            const PASSWORD = process.env.TEST_PASSWORD || '';
            await page.fill('#id', EMAIL).catch(() => {});
            await page.fill('#password', PASSWORD).catch(() => {});
            await page.click('button[type=submit].btn-primary').catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 30000 }).catch(() => {});
        }
    }

    return { context, page };
}

module.exports = { createAuthContext };
