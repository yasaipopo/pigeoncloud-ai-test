'use strict';
const fs = require('fs');
const path = require('path');

// 終端状態（これ以外は未完了として再開対象になる）
const TERMINAL = ['PASS', 'FAIL', 'EVIDENCE_NG', 'STUCK_RETRY_EXCEEDED', 'SKIP'];

function cpPath(runDir) { return path.join(runDir, 'checkpoint.json'); }

function writeAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}

/** 初期化（既存 checkpoint があれば触らない＝再開可能） */
function initRun(runDir, runId, scenarioIds) {
    if (fs.existsSync(cpPath(runDir))) return loadCheckpoint(runDir);
    const cp = { runId, createdAt: new Date().toISOString(), scenarios: {} };
    for (const id of scenarioIds) cp.scenarios[id] = { status: 'pending' };
    writeAtomic(cpPath(runDir), cp);
    return cp;
}

function loadCheckpoint(runDir) {
    return JSON.parse(fs.readFileSync(cpPath(runDir), 'utf8'));
}

/** 1シナリオの状態をマージ更新（atomic write） */
function recordResult(runDir, scenarioId, patch) {
    const cp = loadCheckpoint(runDir);
    cp.scenarios[scenarioId] = {
        ...(cp.scenarios[scenarioId] || {}),
        ...patch,
        updatedAt: new Date().toISOString(),
    };
    writeAtomic(cpPath(runDir), cp);
    return cp;
}

/** 未完了（終端状態でない）シナリオID一覧 */
function pendingScenarios(runDir) {
    const cp = loadCheckpoint(runDir);
    return Object.entries(cp.scenarios)
        .filter(([, s]) => !TERMINAL.includes(s.status))
        .map(([id]) => id);
}

module.exports = { initRun, loadCheckpoint, recordResult, pendingScenarios, TERMINAL };
