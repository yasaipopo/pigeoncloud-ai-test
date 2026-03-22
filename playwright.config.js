// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const { execSync } = require('child_process');
// エージェント番号ごとに出力先を分ける（並列実行対応）
const agentNum = process.env.AGENT_NUM || '1';
const reportsDir = process.env.REPORTS_DIR || `reports/agent-${agentNum}`;

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
    timeout: 60000,
    expect: { timeout: 10000 },
    fullyParallel: false,
    retries: 1,
    workers: 1,
    reporter: [
        ['list'],
        ['json', { outputFile: `${reportsDir}/playwright-results.json` }],
    ],
    outputDir: videoDir,
    use: {
        baseURL: process.env.TEST_BASE_URL || 'https://ai-test.pigeon-demo.com',
        headless: true,
        viewport: { width: 1280, height: 800 },
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        launchOptions: {
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
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
