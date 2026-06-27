'use strict';
// ジャーニー1本を抽出してYAML文字列をstdout/ファイルに。使い方: node v2/tools/extract-journey.js <journeys.yaml> <id> [outFile]
const fs=require('fs'), yaml=require('js-yaml');
const all=yaml.load(fs.readFileSync(process.argv[2],'utf8'));
const j=all.find(x=>x.id===process.argv[3]);
if(!j){console.error('not found:',process.argv[3]);process.exit(1);}
const out=yaml.dump(j,{lineWidth:-1,noRefs:true});
if(process.argv[4]) fs.writeFileSync(process.argv[4],out);
const obs=(j.phases||[]).reduce((a,p)=>a+(p.checkpoints||[]).length,0);
console.error(`抽出: ${j.id} ${j.name} / phases=${(j.phases||[]).length} / checkpoints=${obs} / roles=${(j.roles||[]).join('/')}`);
process.stdout.write(out);
