/**
 * 自動スクリーンショット撮影ヘルパー v3
 *
 * sheet.htmlの実装に完全準拠:
 *
 * 1. ケースヘッダー📷: steps/{spec}/{movie}/{caseNo}.jpg
 *    → "dash-040 📷 ──" クリックで表示
 *
 * 2. ✅行の📷: steps/{spec}/{movie}/{caseNo}-s{lineNum}.jpg
 *    → "14. ✅ 📷 ..." クリックで表示
 *    → caseNoはdetailedFlow内で直前に検出された `(\w+-\d{3})\s` のID
 *    → lineNumは行頭の `(\d+)\.` の数字
 *
 * sheet.htmlのロジック（1328-1344行目）:
 *   let currentStepId = '';
 *   // (\w+-\d{3})\s にマッチする行でcurrentStepIdを更新
 *   // ✅行の行頭番号Nで {currentStepId}-s{N} を生成
 *
 * つまり:
 *   dash-040 ── タイトル        ← currentStepId = 'dash-040'
 *   12. メニューを開く          ← ✅なし、スキップ
 *   13. 掲示板を追加            ← ✅なし、スキップ
 *   14. ✅ エラーなし           ← dash-040-s14.jpg
 *
 * 使い方:
 *   const { createAutoScreenshot } = require('./helpers/auto-screenshot');
 *   const autoScreenshot = createAutoScreenshot('dashboard');
 *
 *   // 1回呼ぶだけ → そのケースのヘッダー📷 + 全✅行📷を一括生成
 *   await autoScreenshot(page, 'DB01', 'dash-040', _testStart);
 */

const fs = require('fs');
const path = require('path');

let _map = null;

function loadMap() {
    if (_map) return _map;
    const mapPath = path.join(__dirname, 'screenshot-map.json');
    if (!fs.existsSync(mapPath)) {
        console.warn('[auto-screenshot] screenshot-map.json が見つかりません');
        _map = {};
        return _map;
    }
    _map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    return _map;
}

/**
 * @param {string} specName - spec名（例: 'dashboard'）
 */
function createAutoScreenshot(specName) {
    const reportsDir = process.env.REPORTS_DIR || `reports/agent-${process.env.AGENT_NUM || '1'}`;

    /**
     * そのケースのヘッダー📷 + 全✅行📷を一括撮影。
     * 1回の呼び出しで必要な全ファイルを生成。
     *
     * @param {import('@playwright/test').Page} page
     * @param {string} movie - movie ID（例: 'DB01'）
     * @param {string} caseNo - ケース番号（例: 'dash-040'）
     * @param {number} testStartTime - テスト開始時刻
     */
    return async function autoScreenshot(page, movie, caseNo, testStartTime) {
        const sec = Math.round((Date.now() - testStartTime) / 1000);
        const map = loadMap();
        const movieData = map[specName]?.[movie];
        const dir = `${reportsDir}/steps/${specName}/${movie}`;
        fs.mkdirSync(dir, { recursive: true });

        // 1枚撮影（ベース画像）
        const basePath = `${dir}/${caseNo}.jpg`;
        await page.screenshot({ path: basePath, type: 'jpeg', quality: 30, fullPage: false }).catch(() => {});
        console.log(`[STEP_TIME] ${sec}s ${caseNo} screenshot:${basePath}`);

        // ✅行分のファイルをコピー生成
        if (movieData) {
            const checkLines = movieData.checks?.[caseNo] || [];
            for (const lineNum of checkLines) {
                const subPath = `${dir}/${caseNo}-s${lineNum}.jpg`;
                try {
                    fs.copyFileSync(basePath, subPath);
                } catch {
                    await page.screenshot({ path: subPath, type: 'jpeg', quality: 30, fullPage: false }).catch(() => {});
                }
                console.log(`[STEP_TIME] ${sec}s ${caseNo}-s${lineNum} screenshot:${subPath}`);
            }
        }

        return sec;
    };
}

module.exports = { createAutoScreenshot };
