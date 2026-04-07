/**
 * 自動スクリーンショット撮影ヘルパー
 *
 * yamlのdetailedFlowの✅行番号に基づいて、sheet.htmlが期待する
 * 正しいファイル名でスクショを保存する。
 *
 * ファイル名規則:
 *   steps/{spec}/{movie}/{firstCase}-s{lineNum}.jpg
 *
 * 使い方:
 *   const { createAutoScreenshot } = require('./helpers/auto-screenshot');
 *   const autoScreenshot = createAutoScreenshot('comments-logs');
 *
 *   // テスト内で:
 *   await autoScreenshot(page, 'CL01', 'cl-010', 0, _testStart);
 *   // → steps/comments-logs/CL01/cl-010-s2.jpg（cl-010の1番目の✅ = 行番号2）
 *
 *   await autoScreenshot(page, 'CL01', 'cl-010', 1, _testStart);
 *   // → steps/comments-logs/CL01/cl-010-s3.jpg（cl-010の2番目の✅ = 行番号3）
 *
 *   await autoScreenshot(page, 'CL01', 'cl-020', 0, _testStart);
 *   // → steps/comments-logs/CL01/cl-010-s5.jpg（cl-020の1番目の✅ = 行番号5、firstCase=cl-010）
 */

const fs = require('fs');
const path = require('path');

// screenshot-map.json をキャッシュ
let _map = null;

function loadMap() {
    if (_map) return _map;
    const mapPath = path.join(__dirname, 'screenshot-map.json');
    if (!fs.existsSync(mapPath)) {
        console.warn('[auto-screenshot] screenshot-map.json が見つかりません。python3 scripts/generate-screenshot-map.py を実行してください。');
        _map = {};
        return _map;
    }
    _map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    return _map;
}

/**
 * spec名を指定して autoScreenshot 関数を生成する
 * @param {string} specName - spec名（例: 'comments-logs'）
 * @returns {Function} autoScreenshot(page, movie, caseNo, checkIndex, testStartTime)
 */
function createAutoScreenshot(specName) {
    const reportsDir = process.env.REPORTS_DIR || `reports/agent-${process.env.AGENT_NUM || '1'}`;

    /**
     * @param {import('@playwright/test').Page} page
     * @param {string} movie - movie ID（例: 'CL01'）
     * @param {string} caseNo - ケース番号（例: 'cl-010'）
     * @param {number} checkIndex - このケース内の何番目の✅か（0始まり）
     * @param {number} testStartTime - テスト開始時刻（Date.now()）
     */
    return async function autoScreenshot(page, movie, caseNo, checkIndex, testStartTime) {
        const sec = Math.round((Date.now() - testStartTime) / 1000);
        const map = loadMap();

        // マッピングからファイル名を算出
        const movieData = map[specName]?.[movie];
        let stepId;

        if (movieData) {
            const firstCase = movieData.firstCase;
            const checks = movieData.checks?.[caseNo] || [];
            if (checkIndex < checks.length) {
                stepId = `${firstCase}-s${checks[checkIndex]}`;
            } else {
                // フォールバック: マッピングにないcheckIndex
                stepId = `${firstCase}-s${caseNo}-${checkIndex}`;
                console.warn(`[auto-screenshot] ⚠️ ${specName}/${movie}/${caseNo} checkIndex=${checkIndex} がマッピングにありません（✅は${checks.length}個）`);
            }
        } else {
            // フォールバック: マッピングにないmovie
            stepId = `${caseNo}-s${checkIndex}`;
            console.warn(`[auto-screenshot] ⚠️ ${specName}/${movie} がscreenshot-map.jsonにありません`);
        }

        const dir = `${reportsDir}/steps/${specName}/${movie}`;
        fs.mkdirSync(dir, { recursive: true });
        const filePath = `${dir}/${stepId}.jpg`;
        await page.screenshot({ path: filePath, type: 'jpeg', quality: 30, fullPage: false }).catch(() => {});
        console.log(`[STEP_TIME] ${sec}s ${stepId} screenshot:${filePath}`);
        return sec;
    };
}

module.exports = { createAutoScreenshot };
