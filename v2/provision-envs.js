// 使い方: node v2/provision-envs.js --count 2 --run-dir runs/20260611-pilot
// テスト環境を直列で N 個作成し runs/{runId}/envs.json に書き出す（既存分はスキップ＝再開可能）
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { createTestEnv } = require('../tests/helpers/create-test-env');

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? process.argv[i + 1] : def;
}

(async () => {
    const count = parseInt(arg('count', '2'), 10);
    const runDirArg = arg('run-dir', '');
    if (!runDirArg) { console.error('--run-dir 必須'); process.exit(1); }
    const runDir = path.resolve(runDirArg);
    fs.mkdirSync(runDir, { recursive: true });

    const envsFile = path.join(runDir, 'envs.json');
    const envs = fs.existsSync(envsFile) ? JSON.parse(fs.readFileSync(envsFile, 'utf8')) : [];
    console.log(`既存 ${envs.length} / 目標 ${count}`);

    const browser = await chromium.launch({ headless: true });
    try {
        for (let i = envs.length; i < count; i++) {
            console.log(`環境 ${i + 1}/${count} を作成中...`);
            // シナリオは自リソースを debug API で作るため ALLテストテーブル不要
            const env = await createTestEnv(browser, { withAllTypeTable: false });
            await env.context.close();
            envs.push({ index: i, baseUrl: env.baseUrl, email: env.email, password: env.password });
            const tmp = envsFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(envs, null, 2));
            fs.renameSync(tmp, envsFile);
            console.log(`環境 ${i + 1} 完了: ${env.baseUrl}`);
        }
    } finally {
        await browser.close();
    }
    console.log(`envs.json 書き出し完了: ${envsFile} (${envs.length} 環境)`);
})().catch(e => { console.error(e); process.exit(1); });
