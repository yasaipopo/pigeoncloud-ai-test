// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const { execSync } = require('child_process');
const fs = require('fs');
// エージェント番号ごとに出力先を分ける（並列実行対応）
const agentNum = process.env.AGENT_NUM || '1';
// storageState（ログイン済みクッキー）のパス: global-setupが作成する
const authStatePath = `.auth-state.${agentNum}.json`;
const reportsDir = process.env.REPORTS_DIR || `reports/agent-${agentNum}`;
// CLIで--reporter=jsonが指定された場合でも出力先が固定されるように環境変数をセット
process.env.PLAYWRIGHT_JSON_OUTPUT_NAME = `${reportsDir}/playwright-results.json`;

// 動画保存ディレクトリ: videos/YYYYMMDD_HHmmss_<commitHash>/
const now = new Date();
const dateStr = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
].join('') + '_' + [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
].join('');

let commitHash = 'unknown';
try {
    // Dockerなら src/pigeon_cloud のコミット、ホストなら pigeon-test 自体のコミット
    commitHash = execSync(
        'git -C /app/src/pigeon_cloud rev-parse --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();
} catch (e) {}

const videoDir = `${reportsDir}/videos/${dateStr}_${commitHash}`;

module.exports = defineConfig({
    testDir: './tests',
    globalSetup: './tests/global-setup.js',
    globalTeardown: './tests/global-teardown.js',
    timeout: 600000, // テスト関数全体: 600秒。beforeAll内のポーリング(最大120s)+ログインリトライ対応のため延長
    expect: { timeout: 5000 },
    fullyParallel: false,
    retries: 1,
    workers: process.env.PLAYWRIGHT_WORKERS ? parseInt(process.env.PLAYWRIGHT_WORKERS) : 1,
    reporter: [
        ['list'],
        ['json', { outputFile: `${reportsDir}/playwright-results.json` }],
        // E2E_API_URL が設定されているときだけリアルタイム登録レポーターを有効化
        ...(process.env.E2E_API_URL ? [['./e2e-viewer/reporter.js']] : []),
    ],
    outputDir: videoDir,
    use: {
        baseURL: process.env.TEST_BASE_URL || 'https://ai-test.pigeon-demo.com',
        headless: true,
        viewport: { width: 1280, height: 800 },
        screenshot: 'on',
        video: 'on',
        // storageStateがあればログイン済みクッキーを再利用（login()呼び出し頻度を大幅削減）
        ...(fs.existsSync(authStatePath) ? { storageState: authStatePath } : {}),
        launchOptions: {
            args: ['--no-sandbox', '--disable-dev-shm-usage', `--test-agent=${agentNum}`],
            // Docker(Linux)はシステムパス、ホストmacOSはデフォルトパス（Playwrightが自動解決）
            ...(process.platform === 'linux' ? {
                executablePath: process.env.PLAYWRIGHT_BROWSERS_PATH
                    ? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium-1208/chrome-linux/chrome`
                    : '/ms-playwright/chromium-1208/chrome-linux/chrome',
            } : {}),
        },
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
});
