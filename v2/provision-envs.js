// 使い方: node v2/provision-envs.js --count 2 --run-dir runs/20260611-pilot
// 環境レジストリ方式 (CLAUDE.md §3):
//   1. v2/envs-registry.json の既存環境をヘルスチェック（ログイン可）→ OK なら再利用
//   2. 足りない分だけ create-trial で新規作成しレジストリへ追記
//   3. 今回実行で使う環境を runs/{runId}/envs.json に書き出す
'use strict';
const fs = require('fs');
const path = require('path');

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? process.argv[i + 1] : def;
}

// ローカル実行時は .env.staging から ADMIN_* を読む（Docker 外では shell に未設定のため）。
// create-test-env.js はモジュールロード時に process.env を読むため、require より前に dotenv を実行する
require('dotenv').config({ path: arg('env-file', '.env.staging') });

const { chromium } = require('@playwright/test');
const { createTestEnv } = require('../tests/helpers/create-test-env');

const REGISTRY_FILE = path.join(__dirname, 'envs-registry.json');

function loadRegistry() {
    return fs.existsSync(REGISTRY_FILE) ? JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) : [];
}

function saveRegistry(registry) {
    const tmp = REGISTRY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
    fs.renameSync(tmp, REGISTRY_FILE);
}

/** ログインできるか（環境が生きているか）を確認 */
async function healthCheck(browser, entry) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(entry.baseUrl + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForSelector('#id', { timeout: 15000 });
        await page.fill('#id', entry.email);
        await page.fill('#password', entry.password);
        await page.locator('button[type=submit].btn-primary').first().click();
        await page.waitForSelector('.navbar', { timeout: 20000 });
        return true;
    } catch (e) {
        console.log(`[health] NG: ${entry.baseUrl} (${e.message.substring(0, 80)})`);
        return false;
    } finally {
        await context.close();
    }
}

(async () => {
    const count = parseInt(arg('count', '2'), 10);
    const runDirArg = arg('run-dir', '');
    const fresh = process.argv.includes('--fresh'); // レジストリを無視して全新規作成
    if (!runDirArg) { console.error('--run-dir 必須'); process.exit(1); }
    const runDir = path.resolve(runDirArg);
    fs.mkdirSync(runDir, { recursive: true });

    const envsFile = path.join(runDir, 'envs.json');
    // 同一 run-dir での再実行（再開）は既存 envs.json をそのまま使う
    const envs = fs.existsSync(envsFile) ? JSON.parse(fs.readFileSync(envsFile, 'utf8')) : [];
    const registry = loadRegistry();
    const usedUrls = new Set(envs.map(e => e.baseUrl));

    const browser = await chromium.launch({ headless: true });
    try {
        // 1. レジストリの既存環境をヘルスチェックして再利用（古い順に消化）
        if (!fresh) {
            for (const entry of registry) {
                if (envs.length >= count) break;
                if (usedUrls.has(entry.baseUrl) || entry.dead) continue;
                process.stdout.write(`[health] チェック中: ${entry.baseUrl} ... `);
                const ok = await healthCheck(browser, entry);
                entry.lastHealthCheck = new Date().toISOString();
                entry.dead = !ok;
                if (ok) {
                    console.log('OK → 再利用');
                    envs.push({ index: envs.length, baseUrl: entry.baseUrl, email: entry.email, password: entry.password, reused: true });
                    usedUrls.add(entry.baseUrl);
                }
            }
            saveRegistry(registry);
        }

        // 2. 足りない分だけ新規作成してレジストリへ追記
        while (envs.length < count) {
            console.log(`環境 ${envs.length + 1}/${count} を新規作成中...`);
            // シナリオは自リソースを debug API で作るため ALLテストテーブル不要
            const env = await createTestEnv(browser, { withAllTypeTable: false });
            await env.context.close();
            envs.push({ index: envs.length, baseUrl: env.baseUrl, email: env.email, password: env.password, reused: false });
            registry.push({ baseUrl: env.baseUrl, email: env.email, password: env.password, createdAt: new Date().toISOString(), lastHealthCheck: new Date().toISOString(), dead: false });
            saveRegistry(registry);
            const tmp = envsFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(envs, null, 2));
            fs.renameSync(tmp, envsFile);
            console.log(`環境 ${envs.length} 作成完了: ${env.baseUrl}`);
        }

        // 3. envs.json 確定（index を振り直して atomic write）
        envs.forEach((e, i) => { e.index = i; });
        const tmp = envsFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(envs, null, 2));
        fs.renameSync(tmp, envsFile);
    } finally {
        await browser.close();
    }
    const reusedCount = envs.filter(e => e.reused).length;
    console.log(`envs.json 確定: ${envsFile} (${envs.length} 環境 / 再利用 ${reusedCount} / 新規 ${envs.length - reusedCount})`);
})().catch(e => { console.error(e); process.exit(1); });
