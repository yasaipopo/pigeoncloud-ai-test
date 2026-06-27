'use strict';
// ジャーニー版テストシート生成（2026-06-28）— 大=ジャーニー / 中=フェーズ / 小=観点(checkpoint)。
// 1認証セッションで多観点を確認する「一連の流れ」を読みやすいシートに。
// 使い方: node v2/lib/build-journey-sheet.js <journeys.yaml> [outHtml]
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function srcList(s) { return Array.isArray(s) ? s.join(', ') : (s || ''); }
function badge(t, cls) { return `<span class="tag ${cls}">${esc(t)}</span>`; }

function render(journeys) {
  const totObs = journeys.reduce((a, j) => a + (j.phases || []).reduce((b, p) => b + (p.checkpoints || []).length, 0), 0);
  const totPri = journeys.reduce((m, j) => { m[j.priority] = (m[j.priority] || 0) + 1; return m; }, {});

  let body = '';
  for (const j of journeys) {
    const obsCount = (j.phases || []).reduce((a, p) => a + (p.checkpoints || []).length, 0);
    const roleTags = (j.roles || []).map(r => badge(r, r === 'master' ? 't-mut' : 't-warn')).join(' ');
    const flags = (j.destructive ? badge('destructive', 't-bad') : '') + (j.scope === 'global' ? badge('global', 't-warn') : '');
    body += `<div class="journey">
      <div class="jhead">
        <span class="jid">${esc(j.id)}</span>
        <span class="jname">${esc(j.name)}</span>
        <span class="jmeta">${badge(j.priority || 'P?', 'p-' + (j.priority || 'P3'))} 観点 ${obsCount} ・ フェーズ ${(j.phases || []).length} ・ ロール: ${roleTags || '—'} ${flags} ${(j.fixtures || []).length ? '・ fixture: ' + esc(j.fixtures.join('/')) : ''}</span>
      </div>
      <table><thead><tr><th>中: フェーズ</th><th>準備</th><th>操作</th><th>小: 観点（checkpoint・期待値）</th><th>元ケース/根拠</th></tr></thead><tbody>`;
    for (const p of (j.phases || [])) {
      const cps = p.checkpoints || [];
      const setup = p.setup ? badge(p.setup, p.setup === 'mcp' ? 't-ok' : (p.setup === 'debug' ? 't-warn' : 't-mut')) : '—';
      const action = p.action ? badge(p.action, 't-okb') : '—';
      cps.forEach((c, i) => {
        body += `<tr>${i === 0 ? `<td class="ph" rowspan="${cps.length}">${esc(p.phase)}</td><td class="su" rowspan="${cps.length}">${setup}</td><td class="ac" rowspan="${cps.length}">${action}</td>` : ''}
          <td class="obs">${esc(c.obs)}</td><td class="src">${esc(srcList(c.source))}</td></tr>`;
      });
      if (cps.length === 0) body += `<tr><td class="ph">${esc(p.phase)}</td><td>${setup}</td><td>${action}</td><td class="obs mut">（観点未記載）</td><td></td></tr>`;
    }
    body += `</tbody></table></div>`;
  }

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PigeonCloud E2E ジャーニー型テストシート</title><style>
  :root{--bg:#fff;--ink:#1d2733;--mut:#5b6b7c;--acc:#1565c0;--line:#d7dee7;--okbg:#e3f6ec;--warnbg:#fff4d6;--badbg:#fde7e7}
  *{box-sizing:border-box} body{margin:0;background:#f4f6f9;color:var(--ink);font:14px/1.7 -apple-system,"Hiragino Kaku Gothic ProN",Meiryo,sans-serif}
  .wrap{max-width:1320px;margin:0 auto;padding:24px 18px 80px}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--mut);margin:0 0 18px;font-size:13px}
  .journey{background:#fff;border:1px solid var(--line);border-radius:10px;margin:16px 0;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  .jhead{background:#1565c0;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .jid{font-weight:800;font-family:"SF Mono",Menlo,monospace;font-size:15px;background:rgba(255,255,255,.2);border-radius:6px;padding:1px 9px}
  .jname{font-weight:700;font-size:16px} .jmeta{font-size:12px;opacity:.95;margin-left:auto}
  table{border-collapse:collapse;width:100%;font-size:12.8px}
  th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
  th{background:#eaf1fb}
  td.ph{font-weight:700;background:#f3f7fc;white-space:nowrap;min-width:110px}
  td.su,td.ac{white-space:nowrap;text-align:center}
  td.obs{min-width:420px} td.src{font-size:11px;color:var(--mut);white-space:nowrap}
  .tag{display:inline-block;border-radius:10px;padding:0 8px;font-size:11px;font-weight:700}
  .t-ok{background:var(--okbg);color:#1b7f4b} .t-okb{background:#dbeafe;color:#1565c0}
  .t-warn{background:var(--warnbg);color:#9a6b00} .t-bad{background:var(--badbg);color:#b4232a} .t-mut{background:#eceff3;color:#5b6b7c}
  .p-P1{background:var(--badbg);color:#b4232a} .p-P2{background:var(--warnbg);color:#9a6b00} .p-P3{background:#eceff3;color:#5b6b7c}
  .mut{color:var(--mut)}
  .summary{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;font-size:13px}
</style></head><body><div class="wrap">
<h1>🐦 PigeonCloud E2E ジャーニー型テストシート</h1>
<p class="sub">1認証セッション=多観点 / 大=ジャーニー・中=フェーズ・小=観点(checkpoint) / 現行 約1,671ケース → ${journeys.length}ジャーニー・${totObs}観点 に集約</p>
<div class="summary">ジャーニー <b>${journeys.length}</b> ・ 観点合計 <b>${totObs}</b> ・ 優先度 P1:${totPri.P1 || 0} / P2:${totPri.P2 || 0} / P3:${totPri.P3 || 0}
<span class="mut">準備: ${badge('mcp', 't-ok')}=MCP前倒し ${badge('debug', 't-warn')}=debug API ${badge('ui', 't-mut')}=UI / 操作: ${badge('ui', 't-okb')}=ブラウザ通常動線（検証の主役）</span></div>
${body}
</div></body></html>`;
}

function build(journeysPath, outPath) {
  const journeys = yaml.load(fs.readFileSync(journeysPath, 'utf8'));
  const html = render(journeys);
  fs.writeFileSync(outPath, html);
  return { outPath, journeys: journeys.length };
}

module.exports = { render, build };

if (require.main === module) {
  const src = process.argv[2] || '/tmp/journeys.yaml';
  const out = process.argv[3] || path.join(__dirname, '..', 'docs', 'journey-sheet.html');
  const { outPath, journeys } = build(src, out);
  console.log(`ジャーニーシート生成: ${outPath}（${journeys} ジャーニー）`);
}
