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

/**
 * storageState を適用した BrowserContext + Page を作成する
 *
 * @param {import('@playwright/test').Browser} browser
 * @returns {Promise<{context: import('@playwright/test').BrowserContext, page: import('@playwright/test').Page}>}
 */
async function createAuthContext(browser) {
    const agentNum = process.env.AGENT_NUM || '1';
    const authStatePath = `.auth-state.${agentNum}.json`;
    const context = await browser.newContext(
        fs.existsSync(authStatePath) ? { storageState: authStatePath } : {}
    );
    const page = await context.newPage();
    return { context, page };
}

module.exports = { createAuthContext };
