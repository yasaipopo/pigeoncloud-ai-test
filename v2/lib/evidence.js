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

/** バッジ付きスクショ + 観測値1件を記録（実行エージェントが observation ごとに呼ぶ）
 *  観測対象がビューポート外だと EVIDENCE_NG になるため、縦長画面では fullPage: true を指定する */
async function captureObservation(page, { runDir, runId, scenarioId, index, note, observed, fullPage = false }) {
    const p = evidencePaths(runDir, scenarioId);
    fs.mkdirSync(p.dir, { recursive: true });
    await stampRunBadge(page, runId, scenarioId);
    const shot = p.screenshot(index);
    await page.screenshot({ path: shot, fullPage });
    appendObservation(p.observationsJson, { index, note, observed, screenshot: path.basename(shot) });
    return shot;
}

/** runDir/video/{scenarioId}/ */
function videoDir(runDir, scenarioId) {
    return path.join(runDir, 'video', scenarioId);
}

/** 動画録画を有効にした context を作る（実行エージェントは page をこの context から作る）
 *  全シナリオ録画（2026-06-13 ユーザー指示）。1280x800 固定 */
async function newRecordingContext(browser, { runDir, scenarioId, width = 1280, height = 800, extra = {} }) {
    const dir = videoDir(runDir, scenarioId);
    fs.mkdirSync(dir, { recursive: true });
    return browser.newContext({
        viewport: { width, height },
        recordVideo: { dir, size: { width, height } },
        ...extra,
    });
}

/** context を閉じて録画を確定し、{scenarioId}.webm にリネームしてパスを返す
 *  （必ず finally で呼ぶ。close しないと webm が flush されない） */
async function finalizeVideo(context, runDir, scenarioId) {
    try { await context.close(); } catch {}
    const dir = videoDir(runDir, scenarioId);
    if (!fs.existsSync(dir)) return null;
    const webm = fs.readdirSync(dir).find(f => f.endsWith('.webm') && f !== `${scenarioId}.webm`);
    if (!webm) return null;
    const dest = path.join(dir, `${scenarioId}.webm`);
    fs.renameSync(path.join(dir, webm), dest);
    return dest;
}

module.exports = { evidencePaths, appendObservation, stampRunBadge, captureObservation, videoDir, newRecordingContext, finalizeVideo };
