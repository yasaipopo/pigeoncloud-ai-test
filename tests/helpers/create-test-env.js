'use strict';

/**
 * spec自己完結型テスト環境作成ヘルパー
 *
 * create-trial API（with_all_type_table: true）で環境作成+テーブル作成をバックグラウンド開始。
 * テーブル作成完了はテスト側でポーリング（ALBタイムアウトに依存しない）。
 */

const path = require('path');
const fs = require('fs');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://ai-test.pigeon-demo.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.TEST_PASSWORD || '';

async function createTestEnv(browser, options = {}) {
    const { withAllTypeTable = true, enableOptions = null } = options;

    // 1. 管理画面にログイン
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();

    // ログインリトライ（並列実行時のセッション競合対策）
    const maxAttempts = parseInt(process.env.CREATE_TRIAL_MAX_ATTEMPTS || '6', 10);
    let loginOk = false;
    let lastLoginError = null;

    for (let loginAttempt = 1; loginAttempt <= maxAttempts; loginAttempt++) {
        try {
            await adminPage.goto(ADMIN_BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await adminPage.waitForSelector('#id', { timeout: 30000 });
            await adminPage.fill('#id', ADMIN_EMAIL);
            await adminPage.fill('#password', ADMIN_PASSWORD);
            await adminPage.locator('button[type=submit].btn-primary').first().click();
            await adminPage.waitForSelector('.navbar', { timeout: 30000 });
            loginOk = true;
            break;
        } catch (e) {
            lastLoginError = e;
            console.log(`[createTestEnv] ログイン attempt ${loginAttempt}/${maxAttempts} 失敗: ${e.message.substring(0, 100)}`);
            if (loginAttempt < maxAttempts) {
                // 指数バックオフ: 5s, 10s, 20s, 40s... (最大60s)
                const backoffMs = Math.min(Math.pow(2, loginAttempt - 1) * 5000, 60000);
                console.log(`[createTestEnv] ${backoffMs}ms 待機してリトライします...`);
                try { await adminPage.waitForTimeout(backoffMs); } catch {}
            }
        }
    }
    if (!loginOk) {
        await adminContext.close();
        throw new Error(`管理画面ログインが${maxAttempts}回とも失敗: ${lastLoginError?.message || 'Unknown error'}`);
    }

    // 2. create-trial（リトライ）
    let baseUrl, password, tableId = null;
    const body = { email: 'admin' };
    if (withAllTypeTable) body.with_all_type_table = true;

    let lastResult = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
        lastResult = result;

        if (result.url && result.pw) {
            baseUrl = result.url;
            password = result.pw;
            tableId = result.table_id || null;
            console.log(`[createTestEnv] create-trial response: table_id=${result.table_id}, table_creating=${result.table_creating}, keys=${Object.keys(result).join(',')}`);
            break;
        }
        console.log(`[createTestEnv] create-trial attempt ${attempt}/${maxAttempts} 失敗:`, JSON.stringify(result).substring(0, 100));
        if (attempt < maxAttempts) {
            // 指数バックオフ
            const backoffMs = Math.min(Math.pow(2, attempt - 1) * 5000, 60000);
            await adminPage.waitForTimeout(backoffMs);
        }
    }

    if (!baseUrl || !password) {
        await adminContext.close();
        throw new Error(`create-trial が${maxAttempts}回とも失敗: ${JSON.stringify(lastResult)}`);
    }

    console.log(`[createTestEnv] 環境作成完了: ${baseUrl}${tableId ? ', tableId: ' + tableId : ', テーブル作成中...'}`);

    // 2.5. テナントオプションを有効化（step_mail_option等）
    if (enableOptions && typeof enableOptions === 'object') {
        // baseUrl: https://tmp-xxx.pigeon-demo.com → clientName: tmp-xxx
        const clientName = (() => {
            try {
                const host = new URL(baseUrl).hostname;
                return host.split('.')[0];
            } catch { return null; }
        })();
        if (clientName) {
            const updateResult = await adminPage.evaluate(async ({ name, opts }) => {
                try {
                    const r = await fetch(`/api/admin/update-client-setting/${name}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                        body: JSON.stringify({ setting: opts }),
                        credentials: 'include',
                    });
                    if (!r.ok) return { error: true, status: r.status };
                    return { ok: true };
                } catch (e) {
                    return { error: true, message: e.message };
                }
            }, { name: clientName, opts: enableOptions });
            if (updateResult.ok) {
                console.log(`[createTestEnv] オプション有効化OK: ${JSON.stringify(enableOptions)}`);
            } else {
                console.warn(`[createTestEnv] オプション有効化失敗:`, JSON.stringify(updateResult));
            }
        }
    }

    await adminContext.close();

    // 3. 新環境にログイン
    const email = 'admin';
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(baseUrl + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#id', { timeout: 30000 });
    await page.fill('#id', email);
    await page.fill('#password', password);
    await page.locator('button[type=submit].btn-primary').first().click();
    await page.waitForSelector('.navbar', { timeout: 30000 });

    // storageState更新（蓄積防止のため上書き前にファイルを削除）
    const agentNum = process.env.AGENT_NUM || '1';
    const storageStatePath = path.join(process.cwd(), `.auth-state.${agentNum}.json`);
    try { if (fs.existsSync(storageStatePath)) fs.unlinkSync(storageStatePath); } catch {}
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
            // ALLテストテーブル本体を探す（フィールド数50以上 or ラベル完全一致）
            const tables = status.all_type_tables || [];
            const table = tables.find(t => t.label === 'ALLテストテーブル') ||
                          tables.find(t => (t.fields || []).length >= 50);
            if (table) {
                tableId = table.table_id || table.id;
                const fieldCount = (table.fields || []).length;
                console.log(`[createTestEnv] テーブル作成完了: tableId=${tableId}, fields=${fieldCount} (${(i + 1) * 5}秒)`);
                break;
            }
        }
        if (!tableId) {
            console.warn('[createTestEnv] テーブル作成が240秒以内に完了しませんでした');
        }
    }

    // 5. テーブル作成後、Angularルーティングにテーブルが登録されるまで待機
    // テーブル作成直後はgoto(/admin/dataset__N)→ダッシュボードにフォールバックする問題の対策
    if (withAllTypeTable && tableId) {
        for (let retry = 0; retry < 6; retry++) {
            await page.goto(baseUrl + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2000);
            // +ボタン（レコード追加）があればテーブル画面が表示されている
            const hasTable = await page.locator('button:has(.fa-plus)').count() > 0;
            if (hasTable) {
                console.log(`[createTestEnv] テーブル画面表示確認OK (${(retry + 1) * 5}秒)`);
                break;
            }
            if (retry < 5) {
                console.log(`[createTestEnv] テーブル画面未表示、リトライ ${retry + 1}/6`);
                await page.waitForTimeout(5000);
            }
        }
    }

    return { baseUrl, email, password, tableId, context, page };
}

module.exports = { createTestEnv };
