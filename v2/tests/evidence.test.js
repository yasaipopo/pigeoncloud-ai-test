'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evidencePaths, appendObservation } = require('../lib/evidence');

test('evidencePaths がシナリオ別ディレクトリを返す', () => {
    const p = evidencePaths('/tmp/run1', 'auth-001');
    assert.strictEqual(p.dir, path.join('/tmp/run1', 'evidence', 'auth-001'));
    assert.strictEqual(p.observationsJson, path.join('/tmp/run1', 'evidence', 'auth-001', 'observations.json'));
    assert.strictEqual(p.screenshot(3), path.join('/tmp/run1', 'evidence', 'auth-001', 'obs-03.png'));
});

test('appendObservation が JSON 配列に追記する（ディレクトリ自動作成）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
    const file = path.join(dir, 'sub', 'observations.json');
    appendObservation(file, { index: 1, note: 'URL確認', observed: '/admin/dashboard' });
    appendObservation(file, { index: 2, note: 'ログアウト', observed: '/admin/login' });
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(arr.length, 2);
    assert.strictEqual(arr[1].observed, '/admin/login');
    assert.ok(arr[0].ts, 'タイムスタンプが自動付与される');
});
