'use strict';

/**
 * spec自己完結型テスト環境作成ヘルパー
 *
 * 各specのbeforeAllで呼び出し、自分専用のテナント環境を作成する。
 * create-trial APIで環境作成 → ALLテストテーブル作成 → storageState保存
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
 * @param {number} [options.dataCount=5] - テストデータ件数
 * @returns {Promise<{baseUrl: string, email: string, password: string, tableId: number|null, context: any, page: any}>}
 */
async function createTestEnv(browser, options = {}) {
    const { withAllTypeTable = true, dataCount = 5 } = options;

    // 1. 管理画面にログインしてcreate-trial
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();

    try {
        await adminPage.goto(ADMIN_BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await adminPage.waitForSelector('#id', { timeout: 10000 });
        await adminPage.fill('#id', ADMIN_EMAIL);
        await adminPage.fill('#password', ADMIN_PASSWORD);
        await adminPage.locator('button[type=submit].btn-primary').first().click();
        await adminPage.waitForURL('**/admin/dashboard', { timeout: 15000 });
    } catch (e) {
        await adminContext.close();
        throw new Error(`管理画面ログイン失敗: ${e.message}`);
    }

    // ドメイン名生成（ユニーク）
    const domain = `t${Date.now()}${Math.floor(Math.random() * 100)}`;
    const adminHost = ADMIN_BASE_URL.replace(/^https?:\/\/[^.]+\./, '');

    // create-trial API呼び出し
    let baseUrl, password;
    try {
        const result = await adminPage.evaluate(async (dom) => {
            const r = await fetch('/api/admin/create-trial', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ domain: dom, email: 'admin' }),
                credentials: 'include',
            });
            return r.json();
        }, domain);

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

    await page.goto(baseUrl + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#id', { timeout: 10000 });
    await page.fill('#id', email);
    await page.fill('#password', password);
    await page.locator('button[type=submit].btn-primary').first().click();
    await page.waitForURL('**/admin/dashboard', { timeout: 15000 });
    await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});

    // 3. ALLテストテーブル作成（オプション）
    let tableId = null;
    if (withAllTypeTable) {
        // create-all-type-table APIは504が返る場合があるため、fire-and-forget + ポーリング
        page.evaluate(async (url) => {
            fetch(url + '/api/admin/debug/create-all-type-table', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: '{}',
                credentials: 'include',
            }).catch(() => {});
        }, baseUrl).catch(() => {});

        // ポーリングでテーブル作成完了を確認（最大60秒）
        for (let i = 0; i < 12; i++) {
            await page.waitForTimeout(5000);
            const status = await page.evaluate(async (url) => {
                try {
                    const res = await fetch(url + '/api/admin/debug/status', { credentials: 'include' });
                    return res.json();
                } catch { return { all_type_tables: [] }; }
            }, baseUrl);
            const table = (status.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
            if (table) {
                tableId = table.id || table.table_id;
                console.log(`[createTestEnv] ALLテストテーブル作成完了 (ID: ${tableId})`);
                break;
            }
        }

        // テストデータ投入
        if (tableId && dataCount > 0) {
            await page.evaluate(async ({ url, count }) => {
                try {
                    await fetch(url + '/api/admin/debug/create-all-type-data', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                        body: JSON.stringify({ count, pattern: 'fixed' }),
                        credentials: 'include',
                    });
                } catch {}
            }, { url: baseUrl, count: dataCount });
        }
    }

    return { baseUrl, email, password, tableId, context, page };
}

module.exports = { createTestEnv };
