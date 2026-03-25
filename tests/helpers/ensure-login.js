'use strict';

/**
 * セッション確認・軽量ログインヘルパー
 *
 * storageStateで既にログイン済みのCookieを持つ前提で、
 * ナビゲーション時にセッション切れが起きた場合のみ再ログインする。
 * beforeEachで使用することで、毎回フルログイン（40〜180秒）するコストを削減。
 */

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL || 'admin';
const PASSWORD = process.env.TEST_PASSWORD || '';

/**
 * セッションが有効か確認し、切れていれば再ログインする
 * storageState利用時は通常1〜5秒で完了する
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [email] - 省略時はTEST_EMAILを使用
 * @param {string} [password] - 省略時はTEST_PASSWORDを使用
 */
async function ensureLoggedIn(page, email, password) {
    const baseUrl = process.env.TEST_BASE_URL || BASE_URL;
    const _email = email || EMAIL;
    const _password = password || PASSWORD;

    // ダッシュボードへアクセスしてセッション確認
    const currentUrl = page.url();
    if (!currentUrl || currentUrl === 'about:blank') {
        await page.goto(baseUrl + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    // navbarが表示されていれば既にログイン済み
    const navbar = await page.waitForSelector('.navbar', { timeout: 5000 }).catch(() => null);
    if (navbar && !page.url().includes('/admin/login')) {
        return; // セッション有効
    }

    // セッション切れ → フルログインを実行
    await fullLogin(page, _email, _password);
}

/**
 * フルログイン（セッション切れ時のフォールバック）
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} email
 * @param {string} password
 */
async function fullLogin(page, email, password) {
    const baseUrl = process.env.TEST_BASE_URL || BASE_URL;
    const _email = email || EMAIL;
    const _password = password || PASSWORD;

    await page.goto(baseUrl + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // すでにダッシュボードにいる場合はOK
    if (!page.url().includes('/admin/login')) {
        await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
        return;
    }

    await page.waitForSelector('#id', { timeout: 30000 });
    await page.fill('#id', _email);
    await page.fill('#password', _password);
    // ログインページのボタンは最初の1つだけクリック（複数マッチ対策）
    await page.locator('button[type=submit].btn-primary').first().click({ timeout: 30000 });

    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 180000, waitUntil: 'domcontentloaded' });
    } catch (e) {
        const currentUrl = page.url();
        if (!currentUrl.includes('/admin/login')) {
            await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
            return;
        }
        // Laddaボタンが無効化されている場合は有効になるまで待機してリトライ
        await page.waitForSelector('button[type=submit].btn-primary:not([disabled])', { timeout: 30000 }).catch(() => {});
        await page.fill('#id', _email);
        await page.fill('#password', _password);
        await page.locator('button[type=submit].btn-primary').first().click({ timeout: 30000 });
        await page.waitForURL('**/admin/dashboard', { timeout: 180000, waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
}

module.exports = { ensureLoggedIn, fullLogin };
