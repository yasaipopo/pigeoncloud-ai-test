'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const VAGUE_WORDS = ['正常に', '適切に', '問題なく', 'エラーなく'];
const REQUIRED_KEYS = ['id', 'title', 'priority', 'destructive', 'scope', 'steps', 'observations'];

/** シナリオ配列を検証してエラーメッセージ配列を返す（空=合格） */
function validateScenarios(scenarios) {
    const errors = [];
    const seen = new Set();
    for (const [i, s] of scenarios.entries()) {
        const label = s.id || `index ${i}`;
        for (const k of REQUIRED_KEYS) {
            if (s[k] === undefined || s[k] === null) errors.push(`${label}: 必須キー ${k} がない`);
        }
        if (s.id) {
            if (seen.has(s.id)) errors.push(`${label}: id が重複している`);
            seen.add(s.id);
        }
        if (s.priority && !['P1', 'P2', 'P3'].includes(s.priority)) errors.push(`${label}: priority は P1/P2/P3 のみ`);
        if (s.scope && !['local', 'global'].includes(s.scope)) errors.push(`${label}: scope は local/global のみ`);
        if (Array.isArray(s.steps) && s.steps.length === 0) errors.push(`${label}: steps が空`);
        if (Array.isArray(s.observations)) {
            if (s.observations.length === 0) errors.push(`${label}: observations が空`);
            for (const obs of s.observations) {
                const hit = VAGUE_WORDS.find(w => String(obs).includes(w));
                if (hit) errors.push(`${label}: observations に曖昧語「${hit}」— 観測可能な具体値で書くこと`);
            }
        }
    }
    return errors;
}

/** catalog ディレクトリ全体をロード+検証 */
function loadCatalog(dir) {
    const scenarios = [];
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).sort()) {
        const docs = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (Array.isArray(docs)) scenarios.push(...docs.map(s => ({ ...s, _file: f })));
    }
    return { scenarios, errors: validateScenarios(scenarios) };
}

module.exports = { validateScenarios, loadCatalog, VAGUE_WORDS };

// CLI: node v2/lib/validate-catalog.js [catalogDir]
if (require.main === module) {
    const dir = process.argv[2] || path.join(__dirname, '..', '..', 'catalog');
    const { scenarios, errors } = loadCatalog(dir);
    console.log(`シナリオ ${scenarios.length} 件`);
    if (errors.length) { errors.forEach(e => console.error('NG:', e)); process.exit(1); }
    console.log('バリデーション OK');
}
