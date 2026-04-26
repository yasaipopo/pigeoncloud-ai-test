'use strict';

/**
 * 環境ガード + パス解決ヘルパー
 *
 * staging / production の混入を仕組みで防ぐためのヘルパー。
 *
 * - assertProductionConfirmed: ADMIN_BASE_URL が pigeon-cloud.com を指すなら
 *   CONFIRM_PRODUCTION=1 が無い限り throw する
 * - getEnvType: 'staging' | 'production'
 * - getAuthStatePath: storageState ファイルを env 別ファイル名で返す
 * - getEnvRuntimePath: .test_env_runtime も env 別ファイル名で返す
 *
 * env を含めることで、同じ AGENT_NUM で staging と本番を切り替えても
 * cookie / 環境ファイルが物理的に分離される。
 */

const path = require('path');

const PRODUCTION_HOST_PATTERN = /pigeon-cloud\.com/i;

function getEnvType(adminBaseUrl) {
    const url = adminBaseUrl || process.env.ADMIN_BASE_URL || '';
    // URL がある場合は URL ホスト名を最優先する（ENV_TYPE と矛盾していても URL を信じる）。
    // 例: ADMIN_BASE_URL=staging だが ENV_TYPE=production と書かれているとき、
    //     ファイル名を 'production' にすると staging のクッキーを production 名で保存する逆転が起きるため。
    if (url) {
        return PRODUCTION_HOST_PATTERN.test(url) ? 'production' : 'staging';
    }
    return process.env.ENV_TYPE === 'production' ? 'production' : 'staging';
}

function isProductionTarget(adminBaseUrl) {
    return getEnvType(adminBaseUrl) === 'production';
}

function assertProductionConfirmed(adminBaseUrl) {
    const url = adminBaseUrl || process.env.ADMIN_BASE_URL || '';
    if (!PRODUCTION_HOST_PATTERN.test(url)) return;
    if (process.env.CONFIRM_PRODUCTION === '1') return;
    throw new Error(
        `[安全ガード] ADMIN_BASE_URL=${url} は本番環境 (pigeon-cloud.com) を指しています。\n` +
        `本番でテスト環境を作成するには CONFIRM_PRODUCTION=1 を明示的に設定してください。\n` +
        `staging で動かす意図であれば ADMIN_BASE_URL を ai-test.pigeon-demo.com に切り替えてください。`
    );
}

function getAuthStatePath(agentNum, adminBaseUrl) {
    const num = agentNum || process.env.AGENT_NUM || '1';
    const env = getEnvType(adminBaseUrl);
    return path.join(process.cwd(), `.auth-state.${env}.${num}.json`);
}

function getEnvRuntimePath(agentNum, adminBaseUrl) {
    const num = agentNum || process.env.AGENT_NUM || '1';
    const env = getEnvType(adminBaseUrl);
    return path.join(process.cwd(), `.test_env_runtime.${env}.${num}`);
}

module.exports = {
    assertProductionConfirmed,
    getEnvType,
    isProductionTarget,
    getAuthStatePath,
    getEnvRuntimePath,
};
