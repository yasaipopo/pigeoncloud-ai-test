'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

test('archiveRunDir が runId から YYYY-MM の月フォルダを切る', () => {
    delete process.env.E2E_ARCHIVE_ROOT;
    delete require.cache[require.resolve('../lib/paths')];
    const { archiveRunDir } = require('../lib/paths');
    const d = archiveRunDir('20260613-1400-run');
    assert.strictEqual(d, path.join(os.homedir(), 'pigeon-e2e-archive', '2026-06', '20260613-1400-run'));
});

test('E2E_ARCHIVE_ROOT 環境変数で保管先を変更できる', () => {
    process.env.E2E_ARCHIVE_ROOT = '/tmp/e2e-arch';
    delete require.cache[require.resolve('../lib/paths')];
    const { archiveRunDir } = require('../lib/paths');
    const d = archiveRunDir('20261201-0900-x');
    assert.strictEqual(d, path.join('/tmp/e2e-arch', '2026-12', '20261201-0900-x'));
    delete process.env.E2E_ARCHIVE_ROOT;
});

test('runId が想定形式でないと unknown-month に落ちる', () => {
    delete process.env.E2E_ARCHIVE_ROOT;
    delete require.cache[require.resolve('../lib/paths')];
    const { archiveRunDir } = require('../lib/paths');
    const d = archiveRunDir('weird-id');
    assert.ok(d.includes('unknown-month'));
});
