# エージェント実行型 E2E v2 パイロット 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 厳選20シナリオ（auth 8 + records 12）をエージェント実行＋証拠物＋三値判定で完走させるパイロット一式（カタログ・ライブラリ・プロンプト・ランブック）を実装し、実走して GO/NO-GO 計測値を得る。

**Architecture:** シナリオカタログ（yaml, SSoT）→ オーケストレーター（Claude メインセッション）が環境を直列プロビジョニング → Sonnet 実行エージェントが使い捨て Playwright スクリプトで完遂し evidence（実行IDスタンプ付きスクショ+観測値JSON）を出力 → 別の判定エージェントが PASS/FAIL/EVIDENCE_NG 三値判定 → checkpoint.json に逐次記録（再開可能）。

**Tech Stack:** Node.js (`@playwright/test` 既存, `js-yaml` 既存, `node:test` でユニットテスト), 既存 `tests/helpers/create-test-env.js` 流用。

**設計書:** `.claude/design-docs/2026-06-11-agentic-e2e-v2-design.md`
**カタログ原案:** `.claude/design-docs/2026-06-11-pilot-catalog-proposal.md`（迷い点6件の解決を適用: auth-190除外 / auth-008は兄弟環境流用 / 編集ロックは単一ユーザー / rec-012ソート新規追加 / auth-005はテストユーザー対象 / 旧322対象外）

**ブランチ:** `feature/agentic-e2e-v2-pilot` で作業。タスクごとにコミット。最後に PR（このリポジトリは自律マージ可）。

## ファイル構成

```
catalog/
├── auth.yaml          # 8シナリオ（SSoT）
└── records.yaml       # 12シナリオ（rec-012ソート含む）
v2/
├── lib/
│   ├── validate-catalog.js   # カタログスキーマ+曖昧語バリデータ
│   ├── evidence.js           # 実行IDスタンプ+スクショ+観測値JSON
│   └── run-state.js          # checkpoint管理（再開可能）
├── tests/
│   ├── validate-catalog.test.js
│   ├── evidence.test.js
│   └── run-state.test.js
├── prompts/
│   ├── executor-prompt.md    # 実行エージェント指示テンプレート
│   └── judge-prompt.md       # 判定エージェント指示テンプレート
├── provision-envs.js         # 環境N個直列作成 → envs.json
└── RUNBOOK.md                # オーケストレーション手順
runs/                          # 実行成果物（gitignore）
└── {runId}/
    ├── envs.json
    ├── checkpoint.json
    ├── work/{scenarioId}/    # 使い捨てスクリプト置き場
    └── evidence/{scenarioId}/
```

---

### Task 0: ブランチ作成 + runs/ gitignore

- [ ] **Step 1: ブランチ作成**

```bash
cd /Users/yasaipopo/PycharmProjects/pigeon-test
git checkout -b feature/agentic-e2e-v2-pilot
```

- [ ] **Step 2: .gitignore に runs/ を追加**

`.gitignore` 末尾に追記:

```
# v2 エージェント実行成果物
runs/
```

- [ ] **Step 3: コミット**

```bash
git add .gitignore
git commit -m "chore(v2): runs/ を gitignore に追加"
```

---

### Task 1: カタログ実体化（catalog/auth.yaml + catalog/records.yaml）

**Files:**
- Create: `catalog/auth.yaml`
- Create: `catalog/records.yaml`

- [ ] **Step 1: 原案からカタログを作成**

`.claude/design-docs/2026-06-11-pilot-catalog-proposal.md` の §1 採用シナリオ（auth-001〜008, rec-001〜011）を catalog/ に転記する。各シナリオは以下のスキーマに正規化（原案に無いキーは補う）:

```yaml
- id: auth-001
  title: マスターユーザーでログイン・ダッシュボード遷移・ログアウトできる
  priority: P1
  destructive: false
  scope: local          # local | global（/admin/setting/** 等の全体設定に触れるなら global）
  source: [auth-010, auth-020, auth-030]
  precondition: なし（環境のadminユーザーをそのまま使用）
  steps:
    - /admin/login でIDとパスワードを入力してログインする
    - 右上ユーザーメニューからログアウトする
  observations:
    - ログイン後のURLが /admin/dashboard でありナビゲーションバーが表示されている [スクショ]
    - ログアウト後 /admin/login に戻る。/admin/dashboard へ直接アクセスするとログイン画面へリダイレクトされる [スクショ]
```

迷い点の解決を反映:
- auth-004 / auth-005（PW変更系）: 対象は**シナリオ内で作成したテストユーザー**（debug API `/admin/debug/create-user` で作成可）。マスター admin のPWは変更しない旨を precondition に明記。`destructive: false` に変更できる（自リソース完結のため）
- auth-005 の destructive 判定: パスワード**ポリシー**設定を変更する場合のみ `destructive: true` + `scope: global`。テストユーザー個人のPWバリデーション確認に留めるなら local
- auth-008（マルチテナント分離）: precondition に「他エージェントの環境URLを `envs.json` から借用（新規 create-trial しない）」と明記
- rec-* の各シナリオ: precondition に「`{scenarioId}-` プレフィックスの軽量テーブルを debug API `POST /api/admin/debug/create-light-table` で作成して使う（ALLテストテーブル不使用）」を明記

- [ ] **Step 2: rec-012（ソート・新規起案）を records.yaml 末尾に追加**

```yaml
- id: rec-012
  title: 一覧のカラムヘッダクリックで昇順・降順ソートできる
  priority: P1
  destructive: false
  scope: local
  source: [新規起案 2026-06-11]
  precondition: rec-012- プレフィックスの軽量テーブル（テキスト+数値）を debug API で作成し、数値 10/2/35 の3レコードを投入
  steps:
    - 作成したテーブルの一覧を表示する
    - 数値カラムのヘッダをクリックして昇順ソートする
    - もう一度クリックして降順ソートする
  observations:
    - 昇順クリック後、自分が投入した3レコードの数値カラムが上から 2, 10, 35 の順に並ぶ [スクショ]
    - 降順クリック後、上から 35, 10, 2 の順に並ぶ [スクショ]
```

- [ ] **Step 3: 全観測値の曖昧語セルフチェック**

catalog/*.yaml の observations に「正常に」「適切に」「問題なく」「エラーなく」が無いこと、全てが観測可能な具体値（URL・文字列・並び順・件数）であることを目視確認。

- [ ] **Step 4: コミット**

```bash
git add catalog/
git commit -m "feat(v2): パイロット用シナリオカタログ20件 (auth 8 + records 12)"
```

---

### Task 2: カタログバリデータ（TDD）

**Files:**
- Create: `v2/lib/validate-catalog.js`
- Test: `v2/tests/validate-catalog.test.js`

- [ ] **Step 1: 失敗するテストを書く**

```javascript
// v2/tests/validate-catalog.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateScenarios } = require('../lib/validate-catalog');

const valid = {
    id: 'auth-001', title: 'ログインできる', priority: 'P1',
    destructive: false, scope: 'local',
    steps: ['ログインする'],
    observations: ['URLが /admin/dashboard である [スクショ]'],
};

test('正しいシナリオはエラー0件', () => {
    assert.deepStrictEqual(validateScenarios([valid]), []);
});

test('必須キー欠落を検出する', () => {
    const { id, ...noId } = valid;
    const errors = validateScenarios([noId]);
    assert.ok(errors.some(e => e.includes('id')));
});

test('priority は P1/P2/P3 のみ', () => {
    const errors = validateScenarios([{ ...valid, priority: 'HIGH' }]);
    assert.ok(errors.some(e => e.includes('priority')));
});

test('scope は local/global のみ', () => {
    const errors = validateScenarios([{ ...valid, scope: 'world' }]);
    assert.ok(errors.some(e => e.includes('scope')));
});

test('observations の曖昧語（正常に等）を検出する', () => {
    const errors = validateScenarios([{ ...valid, observations: ['正常にログインできる'] }]);
    assert.ok(errors.some(e => e.includes('曖昧')));
});

test('id 重複を検出する', () => {
    const errors = validateScenarios([valid, { ...valid }]);
    assert.ok(errors.some(e => e.includes('重複')));
});

test('steps 空配列を検出する', () => {
    const errors = validateScenarios([{ ...valid, steps: [] }]);
    assert.ok(errors.some(e => e.includes('steps')));
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test v2/tests/validate-catalog.test.js`
Expected: FAIL（`Cannot find module '../lib/validate-catalog'`）

- [ ] **Step 3: 実装**

```javascript
// v2/lib/validate-catalog.js
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
```

- [ ] **Step 4: テスト pass 確認 + 実カタログ検証**

Run: `node --test v2/tests/validate-catalog.test.js`
Expected: 7 tests PASS

Run: `node v2/lib/validate-catalog.js catalog`
Expected: `シナリオ 20 件` + `バリデーション OK`（NG が出たら catalog/ を修正）

- [ ] **Step 5: コミット**

```bash
git add v2/lib/validate-catalog.js v2/tests/validate-catalog.test.js
git commit -m "feat(v2): カタログバリデータ (必須キー/曖昧語/重複検出) + tests"
```

---

### Task 3: evidence ヘルパー（TDD）

**Files:**
- Create: `v2/lib/evidence.js`
- Test: `v2/tests/evidence.test.js`

- [ ] **Step 1: 失敗するテストを書く**（純粋関数部分: パス生成と観測値追記）

```javascript
// v2/tests/evidence.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evidencePaths, appendObservation } = require('../lib/evidence');

test('evidencePaths がシナリオ別ディレクトリを返す', () => {
    const p = evidencePaths('/tmp/run1', 'auth-001');
    assert.strictEqual(p.dir, '/tmp/run1/evidence/auth-001');
    assert.strictEqual(p.observationsJson, '/tmp/run1/evidence/auth-001/observations.json');
    assert.strictEqual(p.screenshot(3), '/tmp/run1/evidence/auth-001/obs-03.png');
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
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test v2/tests/evidence.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 実装**

```javascript
// v2/lib/evidence.js
'use strict';
const fs = require('fs');
const path = require('path');

/** runDir/evidence/{scenarioId}/ 配下のパス群 */
function evidencePaths(runDir, scenarioId) {
    const dir = path.join(runDir, 'evidence', scenarioId);
    return {
        dir,
        observationsJson: path.join(dir, 'observations.json'),
        screenshot: (i) => path.join(dir, `obs-${String(i).padStart(2, '0')}.png`),
    };
}

/** observations.json（配列）に1件追記。ts 自動付与・ディレクトリ自動作成 */
function appendObservation(file, entry) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const arr = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    arr.push({ ts: new Date().toISOString(), ...entry });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, file);
}

/** 画面右下に実行IDバッジを DOM 注入（スクショに写り込ませて証拠の真正性を担保） */
async function stampRunBadge(page, runId, scenarioId) {
    await page.evaluate(({ text }) => {
        let el = document.getElementById('__e2e_run_badge');
        if (!el) {
            el = document.createElement('div');
            el.id = '__e2e_run_badge';
            el.style.cssText = 'position:fixed;bottom:2px;right:4px;z-index:2147483647;' +
                'background:rgba(0,0,0,.75);color:#0f0;font:11px monospace;padding:1px 5px;pointer-events:none;';
            document.body.appendChild(el);
        }
        el.textContent = text;
    }, { text: `${runId} ${scenarioId}` });
}

/** バッジ付きスクショ + 観測値1件を記録（実行エージェントが observation ごとに呼ぶ） */
async function captureObservation(page, { runDir, runId, scenarioId, index, note, observed }) {
    const p = evidencePaths(runDir, scenarioId);
    fs.mkdirSync(p.dir, { recursive: true });
    await stampRunBadge(page, runId, scenarioId);
    const shot = p.screenshot(index);
    await page.screenshot({ path: shot, fullPage: false });
    appendObservation(p.observationsJson, { index, note, observed, screenshot: path.basename(shot) });
    return shot;
}

module.exports = { evidencePaths, appendObservation, stampRunBadge, captureObservation };
```

- [ ] **Step 4: テスト pass 確認**

Run: `node --test v2/tests/evidence.test.js`
Expected: 2 tests PASS

- [ ] **Step 5: コミット**

```bash
git add v2/lib/evidence.js v2/tests/evidence.test.js
git commit -m "feat(v2): evidence ヘルパー (実行IDバッジ注入スクショ + 観測値JSON) + tests"
```

---

### Task 4: run-state（checkpoint・再開）（TDD）

**Files:**
- Create: `v2/lib/run-state.js`
- Test: `v2/tests/run-state.test.js`

- [ ] **Step 1: 失敗するテストを書く**

```javascript
// v2/tests/run-state.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initRun, loadCheckpoint, recordResult, pendingScenarios } = require('../lib/run-state');

function tmpRun() { return fs.mkdtempSync(path.join(os.tmpdir(), 'run-')); }

test('initRun が全シナリオ pending の checkpoint を作る', () => {
    const dir = tmpRun();
    initRun(dir, 'r1', ['auth-001', 'rec-001']);
    const cp = loadCheckpoint(dir);
    assert.strictEqual(cp.runId, 'r1');
    assert.strictEqual(cp.scenarios['auth-001'].status, 'pending');
    assert.deepStrictEqual(pendingScenarios(dir), ['auth-001', 'rec-001']);
});

test('recordResult で状態更新され pending から消える', () => {
    const dir = tmpRun();
    initRun(dir, 'r1', ['auth-001', 'rec-001']);
    recordResult(dir, 'auth-001', { status: 'executed', attempts: 1 });
    recordResult(dir, 'auth-001', { status: 'PASS', verdict: 'PASS' });
    const cp = loadCheckpoint(dir);
    assert.strictEqual(cp.scenarios['auth-001'].status, 'PASS');
    assert.strictEqual(cp.scenarios['auth-001'].attempts, 1, '既存フィールドはマージ保持');
    assert.deepStrictEqual(pendingScenarios(dir), ['rec-001']);
});

test('initRun は既存 checkpoint があれば上書きしない（再開）', () => {
    const dir = tmpRun();
    initRun(dir, 'r1', ['auth-001']);
    recordResult(dir, 'auth-001', { status: 'PASS' });
    initRun(dir, 'r1', ['auth-001']);
    assert.strictEqual(loadCheckpoint(dir).scenarios['auth-001'].status, 'PASS');
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test v2/tests/run-state.test.js`
Expected: FAIL（module not found）

- [ ] **Step 3: 実装**

```javascript
// v2/lib/run-state.js
'use strict';
const fs = require('fs');
const path = require('path');

const TERMINAL = ['PASS', 'FAIL', 'EVIDENCE_NG', 'STUCK_RETRY_EXCEEDED', 'SKIP'];

function cpPath(runDir) { return path.join(runDir, 'checkpoint.json'); }

function writeAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}

/** 初期化（既存 checkpoint があれば触らない＝再開可能） */
function initRun(runDir, runId, scenarioIds) {
    if (fs.existsSync(cpPath(runDir))) return loadCheckpoint(runDir);
    const cp = { runId, createdAt: new Date().toISOString(), scenarios: {} };
    for (const id of scenarioIds) cp.scenarios[id] = { status: 'pending' };
    writeAtomic(cpPath(runDir), cp);
    return cp;
}

function loadCheckpoint(runDir) {
    return JSON.parse(fs.readFileSync(cpPath(runDir), 'utf8'));
}

/** 1シナリオの状態をマージ更新（atomic write） */
function recordResult(runDir, scenarioId, patch) {
    const cp = loadCheckpoint(runDir);
    cp.scenarios[scenarioId] = {
        ...(cp.scenarios[scenarioId] || {}),
        ...patch,
        updatedAt: new Date().toISOString(),
    };
    writeAtomic(cpPath(runDir), cp);
    return cp;
}

/** 未完了（終端状態でない）シナリオID一覧 */
function pendingScenarios(runDir) {
    const cp = loadCheckpoint(runDir);
    return Object.entries(cp.scenarios)
        .filter(([, s]) => !TERMINAL.includes(s.status))
        .map(([id]) => id);
}

module.exports = { initRun, loadCheckpoint, recordResult, pendingScenarios, TERMINAL };
```

- [ ] **Step 4: テスト pass 確認**

Run: `node --test v2/tests/run-state.test.js`
Expected: 3 tests PASS

- [ ] **Step 5: コミット**

```bash
git add v2/lib/run-state.js v2/tests/run-state.test.js
git commit -m "feat(v2): run-state checkpoint (atomic write・マージ更新・再開) + tests"
```

---

### Task 5: 環境プロビジョニング runner

**Files:**
- Create: `v2/provision-envs.js`

外部依存（create-trial 実API）のためユニットテスト対象外。実走（Task 7）で検証する。

- [ ] **Step 1: 実装**

```javascript
// v2/provision-envs.js
// 使い方: node v2/provision-envs.js --count 2 --run-dir runs/20260611-pilot
// テスト環境を直列で N 個作成し runs/{runId}/envs.json に書き出す（既存分はスキップ＝再開可能）
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { createTestEnv } = require('../tests/helpers/create-test-env');

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? process.argv[i + 1] : def;
}

(async () => {
    const count = parseInt(arg('count', '2'), 10);
    const runDir = path.resolve(arg('run-dir', ''));
    if (!runDir) { console.error('--run-dir 必須'); process.exit(1); }
    fs.mkdirSync(runDir, { recursive: true });

    const envsFile = path.join(runDir, 'envs.json');
    const envs = fs.existsSync(envsFile) ? JSON.parse(fs.readFileSync(envsFile, 'utf8')) : [];
    console.log(`既存 ${envs.length} / 目標 ${count}`);

    const browser = await chromium.launch({ headless: true });
    try {
        for (let i = envs.length; i < count; i++) {
            console.log(`環境 ${i + 1}/${count} を作成中...`);
            // シナリオは自リソースを debug API で作るため ALLテストテーブル不要
            const env = await createTestEnv(browser, { withAllTypeTable: false });
            await env.context.close();
            envs.push({ index: i, baseUrl: env.baseUrl, email: env.email, password: env.password });
            const tmp = envsFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(envs, null, 2));
            fs.renameSync(tmp, envsFile);
            console.log(`環境 ${i + 1} 完了: ${env.baseUrl}`);
        }
    } finally {
        await browser.close();
    }
    console.log(`envs.json 書き出し完了: ${envsFile} (${envs.length} 環境)`);
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 構文チェック**

Run: `node --check v2/provision-envs.js`
Expected: エラーなし

- [ ] **Step 3: コミット**

```bash
git add v2/provision-envs.js
git commit -m "feat(v2): テスト環境直列プロビジョニング runner (envs.json・再開可能)"
```

---

### Task 6: エージェントプロンプトテンプレート + RUNBOOK

**Files:**
- Create: `v2/prompts/executor-prompt.md`
- Create: `v2/prompts/judge-prompt.md`
- Create: `v2/RUNBOOK.md`

- [ ] **Step 1: executor-prompt.md を作成**

`{{...}}` はオーケストレーターが埋める変数。

````markdown
# E2E 実行エージェント指示書

あなたは PigeonCloud の E2E シナリオを1件実行する実行エージェントです。
判定は別のエージェントが行います。あなたの仕事は「シナリオを完遂し、証拠物を残す」ことだけです。

## 対象シナリオ

```yaml
{{SCENARIO_YAML}}
```

## 環境

- URL: {{ENV_URL}} / ID: {{ENV_EMAIL}} / PW: {{ENV_PASSWORD}}
- この環境は他シナリオと共用。**自分のリソースは必ず `{{SCENARIO_ID}}-` プレフィックスで作成**し、他の残骸データに依存・干渉しないこと
- 実行ID: {{RUN_ID}} / 作業dir: {{WORK_DIR}} / プロジェクトroot: {{PROJECT_ROOT}}

## 実行方法（厳守）

1. {{WORK_DIR}} に使い捨て Playwright スクリプト（CommonJS, `@playwright/test` の chromium を直接 launch）を書いて `node` で実行する。MCP Playwright は使わない
2. スクリプト内で観測ポイントごとに必ず evidence ヘルパーを呼ぶ:
   ```javascript
   const { captureObservation } = require('{{PROJECT_ROOT}}/v2/lib/evidence');
   await captureObservation(page, { runDir: '{{RUN_DIR}}', runId: '{{RUN_ID}}',
       scenarioId: '{{SCENARIO_ID}}', index: 1, note: '観測内容の説明',
       observed: '実際に観測した値（URL・テキスト・件数など具体値）' });
   ```
   observations 1項目につき index を 1, 2, ... と振り、**カタログの observations 全件分**を記録する
3. 失敗したらスクリプトを修正して再実行してよい。ただし**修正試行は最大3回まで**。3回で完遂できなければ打ち切り、status: STUCK で正直に報告する
4. データ準備は debug API を活用してよい: `POST /api/admin/debug/create-light-table`（軽量テーブル作成）、`POST /api/admin/debug/create-user`（テストユーザー作成）。ログイン済み page から `page.evaluate(fetch)` で呼ぶ
5. セレクタが見つからない場合はスクショや `page.content()` で実画面を確認して解決する。**観測を省略・緩和して「できたことにする」のは最悪の違反**

## 絶対禁止

- システム設定（/admin/setting/** 等の環境全体に影響する設定）の変更（このシナリオの scope が global の場合を除く）
- マスター admin のパスワード・メールアドレス変更
- 自分のプレフィックス以外のテーブル・レコード・ユーザーの削除/変更
- 観測せずに observed を推測・捏造して書くこと（判定エージェントがスクショと突き合わせて検出します）
- git 操作・{{WORK_DIR}} と {{RUN_DIR}} 以外への書き込み

## 最終報告（あなたの最終メッセージ＝この JSON のみ）

```json
{
  "scenarioId": "{{SCENARIO_ID}}",
  "status": "executed | STUCK",
  "attempts": 1,
  "observationsRecorded": 2,
  "scriptPath": "最終的に成功したスクリプトのパス（STUCK時は最後のスクリプト）",
  "stuckReason": "STUCK時のみ: どのステップで何が起きたか",
  "notes": "気付いたプロダクトの怪しい挙動などあれば"
}
```
````

- [ ] **Step 2: judge-prompt.md を作成**

````markdown
# E2E 判定エージェント指示書

あなたは E2E シナリオの判定エージェントです。実行エージェントとは独立に、証拠物**だけ**を根拠に判定します。
実行エージェントの主張（notes 等）は参考情報であり証拠ではありません。

## 対象シナリオ（期待される観測）

```yaml
{{SCENARIO_YAML}}
```

## 証拠物

- 観測値JSON: {{EVIDENCE_DIR}}/observations.json
- スクショ: {{EVIDENCE_DIR}}/obs-*.png （Read ツールで画像を実際に開いて目視確認すること）
- 期待される実行IDバッジ: 画面右下に `{{RUN_ID}} {{SCENARIO_ID}}`

## 判定手順

1. カタログの observations 1項目ずつ、対応する obs-NN.png を**実際に開き**、期待される観測が画像内に視認できるか確認する
2. observations.json の observed 値が画像と矛盾しないか確認する
3. 各スクショの右下バッジが `{{RUN_ID}} {{SCENARIO_ID}}` と一致するか確認する（不一致＝古い/他テストの証拠流用）
4. 判定:
   - **PASS**: 全 observation が証拠で確認できた
   - **FAIL**: 証拠から「期待と異なる動作」が確認できた（プロダクトバグ疑い）
   - **EVIDENCE_NG**: 証拠不足・バッジ不一致・スクショに観測対象が写っていない・observed が画像と矛盾（操作はできたかもしれないが証明されていない）

## 最終報告（あなたの最終メッセージ＝この JSON のみ）

```json
{
  "scenarioId": "{{SCENARIO_ID}}",
  "verdict": "PASS | FAIL | EVIDENCE_NG",
  "perObservation": [
    { "index": 1, "ok": true, "reason": "スクショで URL /admin/dashboard とナビバーを確認" }
  ],
  "badgeOk": true,
  "failDetail": "FAIL時のみ: 何がどう期待と違ったか（バグ報告に使える粒度で）",
  "catalogImprovement": "EVIDENCE_NG時のみ: カタログ observations の改善提案"
}
```
````

- [ ] **Step 3: RUNBOOK.md を作成**

````markdown
# v2 パイロット実行ランブック（オーケストレーター用）

オーケストレーター = Claude メインセッション。以下を順に行う。

## 0. 事前

```bash
node v2/lib/validate-catalog.js catalog   # バリデーション OK を確認
node --test v2/tests/                      # ユニットテスト全 PASS を確認
RUN_ID=$(date +%Y%m%d-%H%M)-pilot
node v2/provision-envs.js --count 2 --run-dir runs/$RUN_ID
```

## 1. 初期化

- `initRun(runDir, runId, 全シナリオID)` で checkpoint 作成（node -e で実行）
- 割当: env0 → auth 8件 / env1 → records 12件
- 各環境内の実行順: scope: local → destructive/global は最後

## 2. 実行ループ（環境ごとに並列、環境内は直列）

各シナリオについて:
1. executor-prompt.md の {{変数}} を埋めて Sonnet サブエージェントを起動（Agent tool, model: sonnet）
   - シナリオ単位タイムアウト目安 10分
2. 報告 JSON を checkpoint に recordResult（status: executed / STUCK）
3. STUCK → status: STUCK_RETRY_EXCEEDED で記録し次へ（止まらない）

## 3. 判定ループ（実行完了したものから随時）

1. judge-prompt.md を埋めて**別の** Sonnet サブエージェントを起動
2. verdict を recordResult
3. EVIDENCE_NG → 1回だけ追加証拠指示付きで executor を再起動 → 再判定。それでも NG なら確定

## 4. 集計・レポート

- checkpoint.json から PASS / FAIL / EVIDENCE_NG / STUCK を集計
- FAIL は evidence + 再現スクリプトを添えて `.claude/product-bugs.md` 起案（記録はユーザー報告後）
- パイロット計測値: シナリオ平均時間・トークン量（サブエージェント usage 集計）・EVIDENCE_NG 件数・FAIL振り分け（バグ vs テスト不備）・汚染FAIL有無
- 200件換算の見積もりを算出して GO/NO-GO 材料としてユーザーに提示

## 再開

途中で落ちた場合: 同じ run-dir で provision（既存スキップ）→ `pendingScenarios()` で未完了のみ再実行。
````

- [ ] **Step 4: コミット**

```bash
git add v2/prompts/ v2/RUNBOOK.md
git commit -m "feat(v2): 実行/判定エージェントプロンプト + オーケストレーション RUNBOOK"
```

---

### Task 7: PR 作成 + パイロット実走

- [ ] **Step 1: 全ユニットテスト + バリデータ最終確認**

```bash
node --test v2/tests/
node v2/lib/validate-catalog.js catalog
```

Expected: 全 PASS / バリデーション OK

- [ ] **Step 2: push + PR 作成（このリポジトリは自律マージ可）**

```bash
git push -u origin feature/agentic-e2e-v2-pilot
gh pr create --title "feat(v2): エージェント実行型E2E パイロット基盤 (カタログ20件 + 実行/判定/checkpoint)" --body "設計書: .claude/design-docs/2026-06-11-agentic-e2e-v2-design.md"
```

Gemini CLI レビュー実施 → 指摘対応 → bot レビュー確認（quota切れ等は skip）→ merge（リポジトリルールにより承認不要）。

- [ ] **Step 3: パイロット実走**

RUNBOOK.md §0〜4 をオーケストレーター（メインセッション）が実施。auth 8 + records 12 を 2環境×2エージェント並列で完走させる。

- [ ] **Step 4: 計測レポート作成 → ユーザーに GO/NO-GO 提示**

計測値（時間・コスト・EVIDENCE_NG有効性・FAIL振り分け精度・汚染FAIL）+ 200件換算見積もり + sheet.html 連携の要否を報告し、全面展開の判断を仰ぐ。

---

## Self-Review 済み事項

- 設計書の全要素（カタログ規約・3リトライ上限・実行IDバッジ・三値判定・EVIDENCE_NG再実行・checkpoint再開・破壊的隔離・グローバル設定保護・パイロット計測5項目）にタスクが対応していること確認
- 型整合: `evidencePaths`/`captureObservation`/`recordResult` の署名は Task 3/4 の定義と RUNBOOK・プロンプトの参照で一致
- sheet.html 同期はパイロットでは**対象外**（レポートはmd直出し。全面展開時に upload_results.py 互換を検討）— YAGNI
