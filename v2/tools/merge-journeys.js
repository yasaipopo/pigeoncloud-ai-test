'use strict';
// journeys.yaml に security/workflow 追加分を統合。J8x→J8 / J13x→J13 はフェーズ合流、J14/J15/J9b は新規追加。
// 使い方: node v2/tools/merge-journeys.js <base.yaml> <add.yaml> <out.yaml>
const fs = require('fs');
const yaml = require('js-yaml');

const [base, add, out] = process.argv.slice(2);
const baseJ = yaml.load(fs.readFileSync(base, 'utf8'));
const addJ = yaml.load(fs.readFileSync(add, 'utf8'));

function findById(arr, id) { return arr.find(j => j.id === id); }

for (const j of addJ) {
  if (j.id === 'J8x' || j.id === 'J13x') {
    const targetId = j.id.replace('x', '');
    const target = findById(baseJ, targetId);
    if (!target) { console.error('合流先が無い:', targetId); process.exit(1); }
    target.phases = (target.phases || []).concat(j.phases || []);
    // ロール/notes も補完
    for (const r of (j.roles || [])) if (!(target.roles || []).includes(r)) (target.roles = target.roles || []).push(r);
    console.log(`${j.id} → ${targetId} に ${(j.phases || []).length} フェーズ合流`);
  } else {
    baseJ.push(j);
    console.log(`${j.id} 新規追加`);
  }
}

// J番号で並べ替え（J1..J15, J9bはJ9直後）
function jkey(id) { const m = id.match(/^J(\d+)([a-z]?)$/); return m ? [parseInt(m[1], 10), m[2] || ''] : [999, id]; }
baseJ.sort((a, b) => { const ka = jkey(a.id), kb = jkey(b.id); return ka[0] - kb[0] || ka[1].localeCompare(kb[1]); });

fs.writeFileSync(out, yaml.dump(baseJ, { lineWidth: -1, noRefs: true }));
const obs = baseJ.reduce((a, j) => a + (j.phases || []).reduce((b, p) => b + (p.checkpoints || []).length, 0), 0);
console.log(`統合完了: ${out} / ジャーニー ${baseJ.length} / 観点 ${obs}`);
