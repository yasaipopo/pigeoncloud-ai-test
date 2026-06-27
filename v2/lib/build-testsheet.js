'use strict';
// テストシート生成（2026-06-28 ユーザー指示）— カタログ(SSoT)から読みやすいテスト仕様シートを生成。
// 観点(title) / やり方(steps) / 確認観点(observations) / 優先度 / source / 準備プロファイル を一覧化。
// 手動維持せずカタログから毎回生成＝ドリフトしない。
// 使い方: node v2/lib/build-testsheet.js [catalogDir] [outPath]
const fs = require('fs');
const path = require('path');
const { loadCatalog } = require('./validate-catalog');

const AREA_LABEL = { auth: '認証', records: 'レコード操作', workflow: 'ワークフロー', fields: '項目・バリデーション', tables: 'テーブル定義' };
function areaOf(file) { const k = path.basename(file, '.yaml'); return AREA_LABEL[k] || k; }

function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function list(arr) { return Array.isArray(arr) ? '<ol>' + arr.map(x => `<li>${esc(x)}</li>`).join('') + '</ol>' : esc(arr); }

function render(scenarios) {
  const byArea = {};
  for (const s of scenarios) { const a = areaOf(s._file); (byArea[a] = byArea[a] || []).push(s); }
  const areas = Object.keys(byArea);
  const total = scenarios.length;
  const counts = scenarios.reduce((m, s) => { m[s.priority] = (m[s.priority] || 0) + 1; return m; }, {});

  let rows = '';
  for (const a of areas) {
    rows += `<tr class="area"><td colspan="7">▼ ${esc(a)}（${byArea[a].length}件）</td></tr>`;
    for (const s of byArea[a]) {
      const prof = [
        s.fixture ? `fixture: ${esc(s.fixture)}` : null,
        s.setup ? `setup: ${esc(Array.isArray(s.setup) ? s.setup.join('/') : s.setup)}` : null,
        s.action ? `action: ${esc(s.action)}` : null,
        s.verify ? `verify: ${esc(s.verify)}` : null,
      ].filter(Boolean).join(' · ') || '<span class="mut">（準備プロファイル未設定＝移行対象）</span>';
      rows += `<tr>
        <td class="id">${esc(s.id)}<div class="pri p-${esc(s.priority)}">${esc(s.priority)}</div></td>
        <td class="title">${esc(s.title)}</td>
        <td>${list(s.steps)}</td>
        <td>${list(s.observations)}</td>
        <td class="prof">${prof}</td>
        <td class="src">${esc(Array.isArray(s.source) ? s.source.join(', ') : (s.source || ''))}</td>
        <td class="flags">${s.destructive ? '<span class="tag t-bad">destructive</span>' : ''}${s.scope === 'global' ? '<span class="tag t-warn">global</span>' : ''}</td>
      </tr>`;
    }
  }

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PigeonCloud E2E テストシート</title><style>
  :root{--bg:#fff;--ink:#1d2733;--mut:#5b6b7c;--acc:#1565c0;--line:#d7dee7;--okbg:#e3f6ec;--warnbg:#fff4d6;--badbg:#fde7e7}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.7 -apple-system,"Hiragino Kaku Gothic ProN",Meiryo,sans-serif}
  .wrap{max-width:1400px;margin:0 auto;padding:24px 18px 80px}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--mut);margin:0 0 16px;font-size:13px}
  table{border-collapse:collapse;width:100%;font-size:12.8px}
  th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
  th{background:#eaf1fb;position:sticky;top:0;z-index:2}
  tr.area td{background:#1565c0;color:#fff;font-weight:700;font-size:13.5px}
  td.id{white-space:nowrap;font-weight:700;font-family:"SF Mono",Menlo,monospace}
  td.title{font-weight:600;min-width:170px}
  ol{margin:0;padding-left:18px} li{margin:2px 0}
  .pri{display:inline-block;margin-top:4px;font-size:11px;font-weight:700;border-radius:10px;padding:0 7px}
  .p-P1{background:var(--badbg);color:#b4232a} .p-P2{background:var(--warnbg);color:#9a6b00} .p-P3{background:#eceff3;color:#5b6b7c}
  td.prof{font-size:11.5px;color:#0b3d6b;background:#f3f7fc;min-width:140px} td.src{font-size:11px;color:var(--mut);min-width:90px}
  td.flags .tag{display:inline-block;border-radius:10px;padding:0 7px;font-size:10.5px;font-weight:700;margin:1px}
  .tag.t-bad{background:var(--badbg);color:#b4232a} .tag.t-warn{background:var(--warnbg);color:#9a6b00}
  .mut{color:var(--mut)} .summary{margin:0 0 14px;font-size:13px}
  .legend{color:var(--mut);font-size:12px;margin-top:14px}
</style></head><body><div class="wrap">
<h1>🐦 PigeonCloud E2E テストシート</h1>
<p class="sub">カタログ(catalog/*.yaml)から自動生成 — 手動維持なし・ドリフトしない / エリア ${areas.length} ・ シナリオ ${total} 件</p>
<p class="summary">優先度: <b>P1</b> ${counts.P1 || 0} ・ <b>P2</b> ${counts.P2 || 0} ・ <b>P3</b> ${counts.P3 || 0}</p>
<table>
<thead><tr><th>ID / 優先度</th><th>観点（タイトル）</th><th>やり方（手順 steps）</th><th>確認観点（observations）</th><th>準備プロファイル</th><th>source</th><th>属性</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p class="legend">観点=何を確認するか / やり方=ブラウザ操作手順 / 確認観点=期待結果（マニュアル根拠）。準備プロファイル: fixture(使うﾌｨｸｽﾁｬ)/setup(mcp|debug|ui)/action(ui)/verify。source にヘルプ記事ID・PR番号。</p>
</div></body></html>`;
}

function build(catalogDir, outPath) {
  const { scenarios } = loadCatalog(catalogDir);
  const html = render(scenarios);
  fs.writeFileSync(outPath, html);
  return { outPath, count: scenarios.length };
}

module.exports = { render, build };

if (require.main === module) {
  const catalogDir = process.argv[2] || path.join(__dirname, '..', '..', 'catalog');
  const out = process.argv[3] || path.join(__dirname, '..', 'docs', 'testsheet.html');
  const { outPath, count } = build(catalogDir, out);
  console.log(`テストシート生成: ${outPath}（${count} シナリオ）`);
}
