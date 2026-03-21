// @ts-check
/**
 * Playwright グローバルセットアップ
 *
 * 各テスト実行の前に、専用のテスト環境（テナント）を作成する。
 * - TEST_BASE_URL が既に tmp-testai-... を指している場合はスキップ
 * - それ以外（ai-test.pigeon-demo.com など）の場合は新環境を作成し
 *   process.env.TEST_BASE_URL / TEST_PASSWORD を更新する
 */

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

module.exports = async function globalSetup() {
    const currentUrl = process.env.TEST_BASE_URL || '';

    // .test_env_runtime ファイルが存在する場合は環境変数を読み込んでスキップ
    // エージェント番号ごとに別ファイルを使用（並列実行での競合を防ぐ）
    const agentNum = process.env.AGENT_NUM || '1';
    const envRuntimePath = path.join(process.cwd(), `.test_env_runtime.${agentNum}`);
    if (fs.existsSync(envRuntimePath)) {
        const envContent = fs.readFileSync(envRuntimePath, 'utf8');
        for (const line of envContent.split('\n')) {
            const match = line.match(/^([A-Z_]+)=(.+)$/);
            if (match) {
                process.env[match[1]] = match[2];
            }
        }
        console.log(`[global-setup] .test_env_runtimeから環境を読み込み: ${process.env.TEST_BASE_URL}`);
        return;
    }

    // 既に tmp-testai- 環境ならスキップ
    if (currentUrl.includes('tmp-testai-')) {
        console.log(`[global-setup] 既存テスト環境を使用: ${currentUrl}`);
        return;
    }

    const adminBaseUrl = process.env.ADMIN_BASE_URL || 'https://ai-test.pigeon-demo.com';
    const adminEmail   = process.env.ADMIN_EMAIL   || process.env.TEST_EMAIL   || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || process.env.TEST_PASSWORD || '';

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = [
        now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()),
        pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds()),
    ].join('');

    const domain   = `tmp-testai-${dateStr}-${agentNum}`;
    const newUrl   = `https://${domain}.pigeon-demo.com`;

    console.log(`[global-setup] テスト環境を作成中: ${newUrl}`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    try {
        // 管理画面にログイン
        await page.goto(adminBaseUrl + '/admin/login');
        await page.waitForLoadState('networkidle');
        await page.fill('#id', adminEmail);
        await page.fill('#password', adminPassword);
        await page.click('button[type=submit].btn-primary');
        await page.waitForURL('**/admin/dashboard', { timeout: 30000 });

        // create-trial API を直接呼び出し（Angular UIフォームは不安定なためAPI経由）
        const resp = await page.request.post(adminBaseUrl + '/api/admin/create-trial', {
            headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
            },
            data: { domain: domain, email: 'admin' },
            timeout: 60000,
        });
        const result = await resp.json();
        console.log(`[global-setup] create-trial API 応答:`, JSON.stringify(result));

        if (!result.url || !result.pw) {
            throw new Error(`create-trial 応答が不正: ${JSON.stringify(result)}`);
        }

        const actualUrl = result.url;
        const newPassword = result.pw;

        // 環境変数を更新（このプロセスとspec.jsで参照される）
        process.env.TEST_BASE_URL = actualUrl;
        process.env.TEST_EMAIL    = 'admin';
        process.env.TEST_PASSWORD = newPassword;

        // 再起動なしで spec.js に伝える用のファイルにも保存（エージェント番号ごとに別ファイル）
        const envFile = path.join(process.cwd(), `.test_env_runtime.${agentNum}`);
        fs.writeFileSync(envFile, [
            `TEST_BASE_URL=${actualUrl}`,
            `TEST_EMAIL=admin`,
            `TEST_PASSWORD=${newPassword}`,
        ].join('\n') + '\n');

        console.log(`[global-setup] 環境作成完了: ${actualUrl} / admin / ${newPassword}`);
    } catch (err) {
        console.error('[global-setup] 環境作成失敗:', err.message);
        // 失敗してもテストは続行（既存環境で動かす）
    } finally {
        await browser.close();
    }
};
