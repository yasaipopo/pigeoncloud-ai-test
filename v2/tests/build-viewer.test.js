'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildRunModel, scanArchive, renderHtml } = require('../lib/build-viewer');

function mkRun(root, month, runId, scenarios) {
  const rd = path.join(root, month, runId);
  fs.mkdirSync(rd, { recursive: true });
  const cp = { runId, scenarios: {} };
  for (const s of scenarios) {
    cp.scenarios[s.id] = { status: s.status, triage: s.triage, attempts: s.attempts, attemptOverrun: s.attemptOverrun };
    const ev = path.join(rd, 'evidence', s.id);
    fs.mkdirSync(ev, { recursive: true });
    if (s.obs) fs.writeFileSync(path.join(ev, 'observations.json'), JSON.stringify(s.obs));
    for (const png of (s.pngs || [])) fs.writeFileSync(path.join(ev, png), 'x');
    if (s.video) { const vd = path.join(rd, 'video', s.id); fs.mkdirSync(vd, { recursive: true }); fs.writeFileSync(path.join(vd, s.video), 'x'); }
  }
  if (scenarios.report) fs.writeFileSync(path.join(rd, 'report.md'), '# r');
  fs.writeFileSync(path.join(rd, 'checkpoint.json'), JSON.stringify(cp));
  return rd;
}

test('buildRunModel が status集計・観測・スクショ・動画を拾う', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  const rd = mkRun(root, '2026-06', '20260622-1500-x', [
    { id: 'wf-001', status: 'PASS', obs: [{ index: 1, note: 'n', observed: 'v', screenshot: 'obs-01.png' }], pngs: ['obs-01.png'], video: 'wf-001.mp4' },
    { id: 'rec-002', status: 'FAIL', triage: 'TEST_ISSUE' },
  ]);
  const m = buildRunModel(rd);
  assert.strictEqual(m.total, 2);
  assert.strictEqual(m.counts.PASS, 1);
  assert.strictEqual(m.counts.FAIL, 1);
  const wf = m.scenarios.find(s => s.id === 'wf-001');
  assert.strictEqual(wf.observations.length, 1);
  assert.strictEqual(wf.screenshots[0], '2026-06/20260622-1500-x/evidence/wf-001/obs-01.png');
  assert.strictEqual(wf.video, '2026-06/20260622-1500-x/video/wf-001/wf-001.mp4');
});

test('observations は index で後勝ちユニーク化（再試行の重複を畳む）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  const rd = mkRun(root, '2026-06', '20260622-1600-y', [
    { id: 'a-1', status: 'PASS', obs: [
      { index: 1, note: 'old', observed: 'o1', screenshot: 'obs-01.png' },
      { index: 1, note: 'new', observed: 'n1', screenshot: 'obs-01.png' },
    ] },
  ]);
  const m = buildRunModel(rd);
  const obs = m.scenarios[0].observations;
  assert.strictEqual(obs.length, 1);
  assert.strictEqual(obs[0].observed, 'n1', '同 index は後勝ち');
});

test('scanArchive は月降順・runId降順で返す', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  mkRun(root, '2026-05', '20260501-0900-a', [{ id: 'x', status: 'PASS' }]);
  mkRun(root, '2026-06', '20260601-0900-b', [{ id: 'y', status: 'PASS' }]);
  mkRun(root, '2026-06', '20260602-0900-c', [{ id: 'z', status: 'PASS' }]);
  const runs = scanArchive(root);
  assert.deepStrictEqual(runs.map(r => r.runId), ['20260602-0900-c', '20260601-0900-b', '20260501-0900-a']);
});

test('renderHtml は自己完結HTML（埋め込みデータ・閉じタグ）', () => {
  const html = renderHtml([{ runId: '20260622-1500-x', month: '2026-06', hasReport: false, total: 0, counts: {}, scenarios: [] }]);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('const RUNS = '));
  assert.ok(html.includes('20260622-1500-x'));
});
