// @ts-check
// globalSetupはPlaywrightの.env自動読み込みが適用されないため明示的にdotenvをロード
require('dotenv').config();
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
const { setupAllTypeTable } = require('./helpers/table-setup');
const {
    assertProductionConfirmed,
    getAuthStatePath,
    getEnvRuntimePath,
} = require('./helpers/env-guard');

/**
 * ログイン済みのstorageState（クッキー）をキャッシュする
 * 既に存在する場合はスキップ（テスト毎のログインを不要にする）
 */
async function saveStorageStateIfNeeded(agentNum) {
    const storageStatePath = getAuthStatePath(agentNum);
    // 既存ファイルは削除して必ず再作成する（テスト環境が毎回変わるため古いクッキーは無効）
    if (fs.existsSync(storageStatePath)) {
        fs.unlinkSync(storageStatePath);
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

/**
 * ALLテストテーブルが存在することを保証する
 * storageStateを使ってログイン済みブラウザでsetupAllTypeTableを呼ぶ
 */
async function ensureAllTypeTable(agentNum) {
    const baseUrl = process.env.TEST_BASE_URL || '';
    const storageStatePath = getAuthStatePath(agentNum);
    if (!baseUrl || !fs.existsSync(storageStatePath)) {
        console.log(`[global-setup] ALLテストテーブル作成スキップ (baseUrl=${baseUrl}, storageState=${fs.existsSync(storageStatePath)})`);
        return;
    }

    console.log(`[global-setup] ALLテストテーブル作成/確認中...`);
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
        const context = await browser.newContext({ storageState: storageStatePath });
        const page = await context.newPage();
        // ダッシュボードに遷移してセッション確認
        await page.goto(baseUrl + '/admin/dashboard', { timeout: 30000 });
        await page.waitForURL('**/admin/dashboard', { timeout: 40000 }).catch(() => {});

        const result = await setupAllTypeTable(page);
        if (result.tableId) {
            console.log(`[global-setup] ALLテストテーブル確認完了 (ID: ${result.tableId})`);
        } else {
            console.log(`[global-setup] ALLテストテーブル作成失敗 (テスト中にリトライされる可能性あり)`);
        }
        await context.close();
    } catch (e) {
        console.log(`[global-setup] ALLテストテーブル作成エラー (無視): ${e.message}`);
    } finally {
        await browser.close();
    }
}

module.exports = async function globalSetup() {
    // createTestEnv移行済みspecのみ実行する場合、global-setupをスキップ
    // 各specがbeforeAllで自分専用の環境を作成するため、ここでの環境作成は不要
    if (process.env.SKIP_GLOBAL_SETUP === '1') {
        console.log('[global-setup] SKIP_GLOBAL_SETUP=1: スキップ');
        return;
    }

    // 本番環境ガード: pigeon-cloud.com を指していて CONFIRM_PRODUCTION=1 が無ければ throw
    assertProductionConfirmed(process.env.ADMIN_BASE_URL);

    const currentUrl = process.env.TEST_BASE_URL || '';

    // .test_env_runtime ファイルが存在する場合は環境変数を読み込んでスキップ
    // エージェント番号 + env ごとに別ファイルを使用（並列実行 + staging/本番混入防止）
    const agentNum = process.env.AGENT_NUM || '1';
    const envRuntimePath = getEnvRuntimePath(agentNum);

    // REUSE_ENV=1 の場合のみ既存環境を使い回す（デフォルトは毎回新規作成）
    if (process.env.REUSE_ENV === '1' && fs.existsSync(envRuntimePath)) {
        const envContent = fs.readFileSync(envRuntimePath, 'utf8');
        for (const line of envContent.split('\n')) {
            const match = line.match(/^([A-Z_]+)=(.+)$/);
            if (match) {
                process.env[match[1]] = match[2];
            }
        }
        console.log(`[global-setup] REUSE_ENV=1: 既存環境を再利用: ${process.env.TEST_BASE_URL}`);
        await saveStorageStateIfNeeded(agentNum);
        await ensureAllTypeTable(agentNum);
        return;
    }

    // 古い環境ファイルを削除（常に新規作成）
    if (fs.existsSync(envRuntimePath)) {
        console.log(`[global-setup] 古い.test_env_runtimeを削除: ${envRuntimePath}`);
        fs.unlinkSync(envRuntimePath);
    }

    // REUSE_ENV=1 でない限り、tmp-testai- 環境でも新規作成
    if (process.env.REUSE_ENV === '1' && currentUrl.includes('tmp-testai-')) {
        console.log(`[global-setup] REUSE_ENV=1: 既存テスト環境を使用: ${currentUrl}`);
        await saveStorageStateIfNeeded(agentNum);
        await ensureAllTypeTable(agentNum);
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

    const domain   = `t${Date.now()}${agentNum}`;
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

        // create-trial API を page.evaluate(fetch) で呼び出し
        // page.request.post() はCSRFトークンが含まれず CLIENT ADD ERROR になるため
        let actualUrl, newPassword;
        const result = await page.evaluate(async (dom) => {
            const r = await fetch('/api/admin/create-trial', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ domain: dom, email: 'admin' }),
                credentials: 'include',
            });
            return r.json();
        }, domain);
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

        // with_all_type_table で作成リクエスト済みの場合、テーブル完成をポーリング待機
        if (result.all_type_table_requested) {
            console.log(`[global-setup] ALLテストテーブル作成待機中...`);
            const pollBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
            const pollPage = await pollBrowser.newPage();
            try {
                // 新テナントにログインしてstatus APIでテーブル完成を確認
                await pollPage.goto(actualUrl + '/admin/login', { timeout: 30000 });
                await pollPage.fill('#id', 'admin');
                await pollPage.fill('#password', newPassword);
                await pollPage.click('button[type=submit].btn-primary');
                await pollPage.waitForURL('**/admin/dashboard', { timeout: 40000 });

                for (let i = 0; i < 30; i++) { // 最大300秒
                    await pollPage.waitForTimeout(10000);
                    const status = await pollPage.evaluate(async (url) => {
                        const res = await fetch(url + '/api/admin/debug/status', {
                            credentials: 'include',
                            headers: { 'X-Requested-With': 'XMLHttpRequest' },
                        });
                        return res.json();
                    }, actualUrl);
                    const table = (status?.all_type_tables || []).find(t => t.label === 'ALLテストテーブル');
                    if (table) {
                        console.log(`[global-setup] ALLテストテーブル作成完了 (ID: ${table.id})`);
                        break;
                    }
                    if (i === 29) console.log(`[global-setup] ALLテストテーブル作成タイムアウト（テスト中に完了する可能性あり）`);
                }
            } catch (e) {
                console.log(`[global-setup] ALLテストテーブル待機エラー (無視): ${e.message}`);
            } finally {
                await pollBrowser.close();
            }
        }

        // 環境変数を更新（このプロセスとspec.jsで参照される）
        process.env.TEST_BASE_URL = actualUrl;
        process.env.TEST_EMAIL    = 'admin';
        process.env.TEST_PASSWORD = newPassword;

        // 再起動なしで spec.js に伝える用のファイルにも保存（エージェント番号 + env ごとに別ファイル）
        const envFile = getEnvRuntimePath(agentNum);
        fs.writeFileSync(envFile, [
            `TEST_BASE_URL=${actualUrl}`,
            `TEST_EMAIL=admin`,
            `TEST_PASSWORD=${newPassword}`,
        ].join('\n') + '\n');

        console.log(`[global-setup] 環境作成完了: ${actualUrl} / admin / ${newPassword}`);

        // 新規環境のstorageState（認証クッキー）を作成してキャッシュ
        await browser.close();
        await saveStorageStateIfNeeded(agentNum);
        // ALLテストテーブルを作成/確認（with_all_type_tableでリクエスト済みでもfallbackとして実行）
        await ensureAllTypeTable(agentNum);
        return;
    } catch (err) {
        console.error('[global-setup] 環境作成失敗:', err.message);
        // 失敗してもテストは続行（既存環境で動かす）
    } finally {
        // browser が既に閉じられている場合もあるため try-catch で囲む
        try { await browser.close(); } catch(e) {}
    }
};
