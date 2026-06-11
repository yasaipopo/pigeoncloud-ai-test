'use strict';
const fs = require('fs');
const path = require('path');

/** runDir/evidence/{scenarioId}/ 配下のパス群 */
function evidencePaths(runDir, scenarioId) {
    const dir = path.join(runDir, 'evidence', scenarioId);
    return {
        dir,
        observationsJson: path.join(dir, 'observations.json'),
        screenshot: (i) => path.join(dir, `obs-${String(i).padStart(2, '0')}.png`),
    };
}

/** observations.json（配列）に1件追記。ts 自動付与・ディレクトリ自動作成・atomic write */
function appendObservation(file, entry) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const arr = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    arr.push({ ts: new Date().toISOString(), ...entry });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, file);
}

/** 画面右下に実行IDバッジを DOM 注入（スクショに写り込ませて証拠の真正性を担保） */
async function stampRunBadge(page, runId, scenarioId) {
    await page.evaluate(({ text }) => {
        let el = document.getElementById('__e2e_run_badge');
        if (!el) {
            el = document.createElement('div');
            el.id = '__e2e_run_badge';
            el.style.cssText = 'position:fixed;bottom:2px;right:4px;z-index:2147483647;' +
                'background:rgba(0,0,0,.75);color:#0f0;font:11px monospace;padding:1px 5px;pointer-events:none;';
            document.body.appendChild(el);
        }
        el.textContent = text;
    }, { text: `${runId} ${scenarioId}` });
}

/** バッジ付きスクショ + 観測値1件を記録（実行エージェントが observation ごとに呼ぶ） */
async function captureObservation(page, { runDir, runId, scenarioId, index, note, observed }) {
    const p = evidencePaths(runDir, scenarioId);
    fs.mkdirSync(p.dir, { recursive: true });
    await stampRunBadge(page, runId, scenarioId);
    const shot = p.screenshot(index);
    await page.screenshot({ path: shot, fullPage: false });
    appendObservation(p.observationsJson, { index, note, observed, screenshot: path.basename(shot) });
    return shot;
}

module.exports = { evidencePaths, appendObservation, stampRunBadge, captureObservation };
