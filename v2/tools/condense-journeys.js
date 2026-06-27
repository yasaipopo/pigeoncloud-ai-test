const fs=require('fs'), yaml=require('js-yaml');
const J=yaml.load(fs.readFileSync(process.argv[2],'utf8'));
let o='';
for(const j of J){
  const obsN=(j.phases||[]).reduce((b,p)=>b+(p.checkpoints||[]).length,0);
  o+=`\n[${j.id}] ${j.name} (pri=${j.priority||'?'}, roles=${(j.roles||[]).join('/')||'-'}, fixtures=${(j.fixtures||[]).join('/')||'-'}${j.destructive?', destructive':''}${j.scope==='global'?', global':''}) — ${obsN}観点\n`;
  o+='  phases: '+(j.phases||[]).map(p=>`${p.phase}(${(p.checkpoints||[]).length}/${p.setup||'-'}→${p.action||'-'})`).join(' | ')+'\n';
  // 代表観点を最大2件
  const samples=[]; for(const p of (j.phases||[])){ for(const c of (p.checkpoints||[])){ samples.push(String(c.obs).replace(/\s+/g,' ').slice(0,120)); } }
  o+='  例: '+samples.slice(0,2).map(s=>'「'+s+'」').join(' / ')+'\n';
}
const obs=J.reduce((a,j)=>a+(j.phases||[]).reduce((b,p)=>b+(p.checkpoints||[]).length,0),0);
fs.writeFileSync(process.argv[3], `# PigeonCloud E2E ジャーニー設計 凝縮版（${J.length}ジャーニー/${obs}観点）\n# 各行: phases= フェーズ名(観点数/準備→操作)。例= 代表観点。\n`+o);
console.log('凝縮:',process.argv[3],'/ bytes:',fs.statSync(process.argv[3]).size);
