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

/**
 * ログイン済みのstorageState（クッキー）をキャッシュする
 * 既に存在する場合はスキップ（テスト毎のログインを不要にする）
 */
async function saveStorageStateIfNeeded(agentNum) {
    const storageStatePath = path.join(process.cwd(), `.auth-state.${agentNum}.json`);
    if (fs.existsSync(storageStatePath)) {
        console.log(`[global-setup] storageState既存: ${storageStatePath}`);
        return;
    }
    const baseUrl = process.env.TEST_BASE_URL || '';
    const email = process.env.TEST_EMAIL || 'admin';
    const password = process.env.TEST_PASSWORD || '';
    if (!baseUrl || !password) return;

    console.log(`[global-setup] storageState作成中 (${baseUrl})...`);
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(baseUrl + '/admin/login', { timeout: 30000 });
        await page.fill('#id', email);
        await page.fill('#password', password);
        await page.click('button[type=submit].btn-primary');
        await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
        // 利用規約同意画面への対処
        const termsCheckbox = page.locator('input[type=checkbox]').first();
        if (await termsCheckbox.count() > 0) {
            await termsCheckbox.check();
            const continueBtn = page.locator('button').filter({ hasText: '続ける' }).first();
            if (await continueBtn.count() > 0) {
                await continueBtn.click();
                await page.waitForURL('**/admin/dashboard', { timeout: 30000 }).catch(() => {});
            }
        }
        await context.storageState({ path: storageStatePath });
        console.log(`[global-setup] storageState保存完了: ${storageStatePath}`);
    } catch (e) {
        console.log(`[global-setup] storageState保存失敗 (無視): ${e.message}`);
    } finally {
        await browser.close();
    }
}

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
        // storageStateが未作成なら認証してキャッシュ保存
        await saveStorageStateIfNeeded(agentNum);
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
    // ADMIN_BASE_URL から base ドメインを抽出（pigeon-demo.com or pigeon-cloud.com）
    const adminHost = adminBaseUrl.replace(/^https?:\/\/[^.]+\./, '');
    const newUrl    = `https://${domain}.${adminHost}`;

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
        let actualUrl, newPassword;
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
            // APIが権限エラーの場合はUIフォームでフォールバック
            console.log(`[global-setup] API失敗 → /admin/internal/create-client UI経由で作成`);
            await page.goto(adminBaseUrl + '/admin/internal/create-client');
            // Angular SPAのレンダリング待ち（networkidle + 追加待機）
            await page.waitForLoadState('networkidle', { timeout: 30000 });
            await page.waitForTimeout(2000);
            // フォームのinputは form-control クラスなし（ナビゲーション用は form-control あり）
            // inputs[3]=ドメイン, inputs[4]=ログインID なので :not(.form-control) で絞り込み
            const formInputDomain = page.locator('input[type="text"]:not(.form-control):not(.shortcut-input)').first();
            const formInputLogin  = page.locator('input[type="text"]:not(.form-control):not(.shortcut-input)').nth(1);
            await formInputDomain.waitFor({ state: 'visible', timeout: 30000 });
            await formInputDomain.fill(domain);
            await formInputLogin.fill('admin');
            // 作成ボタン（btn-success ladda-button, type=submit）をクリック
            await page.waitForTimeout(500);
            await page.locator('button.btn-success:has-text("作成")').click();
            await page.waitForLoadState('networkidle', { timeout: 60000 });
            const bodyText = await page.innerText('body');
            console.log(`[global-setup] UI作成応答 (先頭300文字): ${bodyText.slice(0, 300)}`);
            // レスポンスからURL/パスワードを抽出
            const urlMatch = bodyText.match(/https?:\/\/[\w.-]+\.pigeon-(?:demo|cloud)\.com/);
            const pwMatch = bodyText.match(/パスワード[：:]\s*(\S+)/i)
                || bodyText.match(/password[：:]\s*(\S+)/i)
                || bodyText.match(/pw[：:]\s*([A-Za-z0-9]{8,})/i);
            if (!urlMatch) {
                throw new Error(`create-client UI失敗: URLが取得できない。body: ${bodyText.slice(0, 300)}`);
            }
            actualUrl = urlMatch[0];
            newPassword = pwMatch ? pwMatch[1] : 'admin';
            console.log(`[global-setup] UI作成完了: ${actualUrl} / ${newPassword}`);
        } else {
            actualUrl = result.url;
            newPassword = result.pw;
        }

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

        // 新規環境のstorageState（認証クッキー）を作成してキャッシュ
        await browser.close();
        await saveStorageStateIfNeeded(agentNum);
        return;
    } catch (err) {
        console.error('[global-setup] 環境作成失敗:', err.message);
        // 失敗してもテストは続行（既存環境で動かす）
    } finally {
        // browser が既に閉じられている場合もあるため try-catch で囲む
        try { await browser.close(); } catch(e) {}
    }
};
