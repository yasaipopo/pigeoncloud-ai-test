'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initRun, loadCheckpoint, recordResult, pendingScenarios } = require('../lib/run-state');

function tmpRun() { return fs.mkdtempSync(path.join(os.tmpdir(), 'run-')); }

test('initRun が全シナリオ pending の checkpoint を作る', () => {
    const dir = tmpRun();
    initRun(dir, 'r1', ['auth-001', 'rec-001']);
    const cp = loadCheckpoint(dir);
    assert.strictEqual(cp.runId, 'r1');
    assert.strictEqual(cp.scenarios['auth-001'].status, 'pending');
    assert.deepStrictEqual(pendingScenarios(dir), ['auth-001', 'rec-001']);
});

test('recordResult で状態更新され pending から消える', () => {
    const dir = tmpRun();
    initRun(dir, 'r1', ['auth-001', 'rec-001']);
    recordResult(dir, 'auth-001', { status: 'executed', attempts: 1 });
    recordResult(dir, 'auth-001', { status: 'PASS', verdict: 'PASS' });
    const cp = loadCheckpoint(dir);
    assert.strictEqual(cp.scenarios['auth-001'].status, 'PASS');
    assert.strictEqual(cp.scenarios['auth-001'].attempts, 1, '既存フィールドはマージ保持');
    assert.deepStrictEqual(pendingScenarios(dir), ['rec-001']);
});

test('initRun は既存 checkpoint があれば上書きしない（再開）', () => {
    const dir = tmpRun();
    initRun(dir, 'r1', ['auth-001']);
    recordResult(dir, 'auth-001', { status: 'PASS' });
    initRun(dir, 'r1', ['auth-001']);
    assert.strictEqual(loadCheckpoint(dir).scenarios['auth-001'].status, 'PASS');
});
