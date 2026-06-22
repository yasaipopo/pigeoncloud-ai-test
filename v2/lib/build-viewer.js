'use strict';
// v2 結果ビューアー生成（2026-06-22 ユーザー指示・旧 spec/sheet ベース viewer を置換）
// ~/pigeon-e2e-archive/ を走査して自己完結 index.html を生成（サーバ不要・開くだけ）。
// 使い方: node v2/lib/build-viewer.js [archiveRoot]
const fs = require('fs');
const path = require('path');
const { archiveRoot } = require('./paths');

const TERMINAL_OK = ['PASS'];
function readJsonSafe(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/** 1 run ディレクトリ → モデル（純粋・テスト可能） */
function buildRunModel(runDir) {
  const runId = path.basename(runDir);
  const month = runId.slice(0, 4) + '-' + runId.slice(4, 6);
  const rel = `${month}/${runId}`; // index.html はアーカイブ root に置くため month を含む相対パス
  const cp = readJsonSafe(path.join(runDir, 'checkpoint.json')) || { scenarios: {} };
  const hasReport = fs.existsSync(path.join(runDir, 'report.md'));
  const scenarios = Object.entries(cp.scenarios || {}).map(([id, s]) => {
    const evDir = path.join(runDir, 'evidence', id);
    const obs = readJsonSafe(path.join(evDir, 'observations.json')) || [];
    // 最終試行ぶんの観測（index でユニーク化・後勝ち）
    const byIndex = {};
    for (const o of obs) byIndex[o.index] = o;
    const observations = Object.values(byIndex).sort((a, b) => a.index - b.index);
    const shots = fs.existsSync(evDir)
      ? fs.readdirSync(evDir).filter(f => f.endsWith('.png')).sort()
      : [];
    const vidDir = path.join(runDir, 'video', id);
    const videos = fs.existsSync(vidDir)
      ? fs.readdirSync(vidDir).filter(f => f.endsWith('.mp4') || f.endsWith('.webm'))
      : [];
    const mp4 = videos.find(v => v.endsWith('.mp4'));
    const webm = videos.find(v => v.endsWith('.webm'));
    return {
      id,
      status: s.status || s.verdict || 'unknown',
      triage: (s.triage && s.triage !== 'N/A') ? s.triage : null,
      attempts: s.attempts ?? null,
      attemptOverrun: !!s.attemptOverrun,
      updatedAt: s.updatedAt || null,
      observations: observations.map(o => ({ index: o.index, note: o.note, observed: o.observed, screenshot: o.screenshot })),
      screenshots: shots.map(f => `${rel}/evidence/${id}/${f}`),
      video: mp4 ? `${rel}/video/${id}/${mp4}` : (webm ? `${rel}/video/${id}/${webm}` : null),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const counts = scenarios.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {});
  return { runId, month: runId.slice(0, 4) + '-' + runId.slice(4, 6), hasReport, scenarios, counts, total: scenarios.length };
}

/** アーカイブ全体 → runs[]（新しい順） */
function scanArchive(root) {
  const runs = [];
  if (!fs.existsSync(root)) return runs;
  for (const month of fs.readdirSync(root).filter(m => /^\d{4}-\d{2}$/.test(m)).sort().reverse()) {
    const mdir = path.join(root, month);
    for (const runId of fs.readdirSync(mdir).filter(r => /^\d{8}-/.test(r)).sort().reverse()) {
      const rd = path.join(mdir, runId);
      if (fs.statSync(rd).isDirectory()) runs.push(buildRunModel(rd));
    }
  }
  return runs;
}

const STATUS_COLOR = {
  PASS: '#2fb380', FAIL: '#d9534f', EVIDENCE_NG: '#e5a32c',
  STUCK_RETRY_EXCEEDED: '#8a6d3b', SKIP: '#888', pending: '#bbb', unknown: '#bbb',
};

function renderHtml(runs) {
  const data = JSON.stringify(runs).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PigeonCloud E2E v2 結果ビューアー</title>
<style>
  :root{--bg:#f4f6f9;--card:#fff;--bd:#dce3ea;--ink:#243;--mut:#6a7785;}
  *{box-sizing:border-box} body{margin:0;font-family:"Hiragino Sans","Noto Sans JP",sans-serif;background:var(--bg);color:var(--ink)}
  header{background:#1a5fb4;color:#fff;padding:14px 22px;font-size:18px;font-weight:700;position:sticky;top:0;z-index:10}
  .wrap{display:flex;min-height:calc(100vh - 50px)}
  .side{width:300px;border-right:1px solid var(--bd);background:#fff;overflow:auto;max-height:calc(100vh - 50px)}
  .main{flex:1;padding:20px;overflow:auto;max-height:calc(100vh - 50px)}
  .month{font-size:12px;color:var(--mut);padding:10px 16px 4px;font-weight:700}
  .runitem{padding:9px 16px;border-bottom:1px solid #eef2f6;cursor:pointer}
  .runitem:hover{background:#eef5ff} .runitem.active{background:#e3efff;border-left:3px solid #1a5fb4}
  .runitem .rid{font-size:13px;font-weight:600} .runitem .sum{font-size:11px;color:var(--mut);margin-top:3px}
  .pill{display:inline-block;border-radius:9px;padding:0 7px;font-size:11px;color:#fff;margin-right:4px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:10px;margin-bottom:16px;overflow:hidden}
  .card h3{margin:0;padding:12px 16px;font-size:15px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:10px}
  .card .body{padding:14px 16px}
  .obs{border-left:3px solid #cdd6e0;padding:6px 12px;margin:8px 0;font-size:13px}
  .obs .note{color:var(--mut)} .obs .val{margin-top:2px}
  .gallery{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
  .gallery img{width:230px;border:1px solid var(--bd);border-radius:5px;cursor:zoom-in}
  video{max-width:520px;border-radius:6px;margin-top:8px;display:block}
  .triage{background:#fff8ec;border:1px solid #e5cf9a;border-radius:6px;padding:8px 12px;font-size:12px;margin-top:8px}
  .empty{color:var(--mut);padding:40px;text-align:center}
  .meta{font-size:12px;color:var(--mut);margin-bottom:14px}
  #lb{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;z-index:99;cursor:zoom-out}
  #lb img{max-width:94vw;max-height:94vh}
</style></head><body>
<header>🐦 PigeonCloud E2E v2 結果ビューアー <span style="font-weight:400;font-size:13px;opacity:.8">— ローカル月次アーカイブ</span></header>
<div class="wrap">
  <div class="side" id="side"></div>
  <div class="main" id="main"><div class="empty">左の実行を選択してください</div></div>
</div>
<div id="lb"><img id="lbimg"></div>
<script>
const RUNS = ${data};
const COLOR = ${JSON.stringify(STATUS_COLOR)};
function pill(label,n){const c=COLOR[label]||'#999';return '<span class="pill" style="background:'+c+'">'+label+' '+n+'</span>';}
function renderSide(){
  const byMonth={};RUNS.forEach(r=>{(byMonth[r.month]=byMonth[r.month]||[]).push(r)});
  let h='';for(const m of Object.keys(byMonth)){h+='<div class="month">'+m+'</div>';
    byMonth[m].forEach(r=>{const sum=Object.entries(r.counts).map(([k,v])=>pill(k,v)).join('');
      h+='<div class="runitem" data-run="'+r.runId+'"><div class="rid">'+r.runId+'</div><div class="sum">'+(sum||'—')+'</div></div>';});}
  document.getElementById('side').innerHTML=h;
  document.querySelectorAll('.runitem').forEach(el=>el.onclick=()=>{
    document.querySelectorAll('.runitem').forEach(x=>x.classList.remove('active'));el.classList.add('active');
    renderRun(el.dataset.run);});
}
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function renderRun(runId){
  const r=RUNS.find(x=>x.runId===runId);if(!r)return;
  let h='<div class="meta">実行ID <b>'+r.runId+'</b> ・ シナリオ '+r.total+'件 ・ '+Object.entries(r.counts).map(([k,v])=>pill(k,v)).join('')+(r.hasReport?' ・ report.md あり':'')+'</div>';
  r.scenarios.forEach(s=>{
    const c=COLOR[s.status]||'#999';
    h+='<div class="card"><h3><span class="pill" style="background:'+c+'">'+s.status+'</span>'+esc(s.id)
      +(s.triage?' <span style="font-size:11px;color:#a8721a">['+esc(s.triage)+']</span>':'')
      +(s.attemptOverrun?' <span style="font-size:11px;color:#d9534f">⚠試行'+s.attempts+'回</span>':'')+'</h3><div class="body">';
    if(s.observations.length){s.observations.forEach(o=>{h+='<div class="obs"><div class="note">観測'+o.index+': '+esc(o.note)+'</div><div class="val">→ '+esc(o.observed)+'</div></div>';});}
    if(s.video){h+='<video controls preload="metadata" src="'+s.video+'"></video>';}
    if(s.screenshots.length){h+='<div class="gallery">'+s.screenshots.map(p=>'<img loading="lazy" src="'+p+'" data-full="'+p+'">').join('')+'</div>';}
    if(!s.observations.length&&!s.screenshots.length&&!s.video){h+='<div class="note" style="color:#6a7785">証拠なし</div>';}
    h+='</div></div>';
  });
  const m=document.getElementById('main');m.innerHTML=h;
  m.querySelectorAll('.gallery img').forEach(img=>img.onclick=()=>{document.getElementById('lbimg').src=img.dataset.full;document.getElementById('lb').style.display='flex';});
}
document.getElementById('lb').onclick=()=>document.getElementById('lb').style.display='none';
renderSide();
if(RUNS.length){document.querySelector('.runitem').click();}
</script></body></html>`;
}

function build(root) {
  const runs = scanArchive(root);
  const html = renderHtml(runs);
  const out = path.join(root, 'index.html');
  fs.writeFileSync(out, html);
  return { out, runCount: runs.length, scenarioCount: runs.reduce((a, r) => a + r.total, 0) };
}

module.exports = { buildRunModel, scanArchive, renderHtml, build };

if (require.main === module) {
  const root = process.argv[2] || archiveRoot();
  const { out, runCount, scenarioCount } = build(root);
  console.log(`ビューアー生成: ${out}（実行 ${runCount} / シナリオ ${scenarioCount}）`);
}
