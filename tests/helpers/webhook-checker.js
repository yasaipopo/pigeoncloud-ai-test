// @ts-check
/**
 * Webhookテスト受信チェックヘルパー
 *
 * webhook.php に届いたデータを display.php でポーリングして確認する。
 *
 * 使い方:
 *   const { waitForWebhook, resetWebhook, webhookUrl } = require('./helpers/webhook-checker');
 *
 *   const key = 'test-105-01';
 *   await resetWebhook(key);                           // テスト前にクリア
 *   // PigeonCloud にWebhookURL（webhookUrl(key)）を設定
 *   // ... アクションを実行 ...
 *   const data = await waitForWebhook(key);            // 届くまで待機
 *   expect(data).toBeTruthy();
 *
 * Webhookサーバー: http://test.yaspp.net/pigeon/
 */

const WEBHOOK_BASE = process.env.WEBHOOK_BASE_URL || 'http://test.yaspp.net/pigeon';

/**
 * PigeonCloudのWebhook設定に入力するURL（テストケースごとにkeyを変える）
 * @param {string} key - テストケースを識別するキー（例: 'test-105-01'）
 * @returns {string}
 */
function webhookUrl(key) {
    return `${WEBHOOK_BASE}/webhook.php?key=${encodeURIComponent(key)}`;
}

/**
 * 受信済みWebhookデータを参照するURL
 * @param {string} key
 * @returns {string}
 */
function displayUrl(key) {
    return `${WEBHOOK_BASE}/display.php?key=${encodeURIComponent(key)}`;
}

/**
 * テスト前にWebhookデータをリセットする
 * @param {string} key
 */
async function resetWebhook(key) {
    const url = `${WEBHOOK_BASE}/webhook.php?key=${encodeURIComponent(key)}&reset`;
    try {
        await fetch(url);
    } catch (e) {
        // ファイルが存在しない場合はエラーが出ることがあるが無視
    }
}

/**
 * Webhookが届くまで待機する
 *
 * @param {string} key - webhookUrl(key) に設定したキー
 * @param {Object} [options]
 * @param {number} [options.timeout]       - タイムアウトms（デフォルト: 30000）
 * @param {number} [options.pollInterval]  - ポーリング間隔ms（デフォルト: 2000）
 * @returns {Promise<Object>} - webhookで受信したJSONデータ
 */
async function waitForWebhook(key, options = {}) {
    const { timeout = 30000, pollInterval = 2000 } = options;
    const deadline = Date.now() + timeout;
    const url = displayUrl(key);

    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            const text = await res.text();

            if (text && text !== 'NO RESULT' && text.trim() !== '') {
                try {
                    const data = JSON.parse(text);
                    return data;
                } catch (e) {
                    // JSONパース失敗でもデータは届いている
                    return { raw: text };
                }
            }
        } catch (e) {
            // ネットワークエラーは無視してリトライ
        }

        if (Date.now() + pollInterval < deadline) {
            await new Promise(r => setTimeout(r, pollInterval));
        } else {
            break;
        }
    }

    throw new Error(`Webhookタイムアウト: ${timeout}ms 以内にkey="${key}"のデータが届きませんでした`);
}

module.exports = { webhookUrl, displayUrl, resetWebhook, waitForWebhook };
