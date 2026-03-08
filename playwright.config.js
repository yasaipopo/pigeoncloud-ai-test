// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// エージェント番号ごとに出力先を分ける（並列実行対応）
const agentNum = process.env.AGENT_NUM || '1';
const reportsDir = process.env.REPORTS_DIR || `reports/agent-${agentNum}`;

module.exports = defineConfig({
    testDir: './tests',
    timeout: 60000,
    expect: { timeout: 10000 },
    fullyParallel: false,
    retries: 1,
    workers: 1,
    reporter: [
        ['list'],
        ['json', { outputFile: `${reportsDir}/playwright-results.json` }],
    ],
    use: {
        baseURL: process.env.TEST_BASE_URL || 'https://ai-test.pigeon-demo.com',
        headless: true,
        viewport: { width: 1280, height: 800 },
        screenshot: 'only-on-failure',
        video: 'off',
        launchOptions: {
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        },
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
});
