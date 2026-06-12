export const meta = {
  name: 'e2e-v2-spot-run',
  description: 'E2E v2 スポット実行: カタログのシナリオを実行→判定→トリアージ→レポートまで全自動',
  whenToUse: 'リリース前のE2Eスポット実行。args: { runId, runDir, projectRoot, chains: [{envIndex, file, ids}] }（環境は事前に provision-envs.js / レジストリで準備しておく）',
  phases: [
    { title: 'Execute', detail: '実行エージェント（環境チェーン並列・チェーン内直列）' },
    { title: 'Judge', detail: '判定エージェント（証拠物ベース三値判定）' },
    { title: 'Triage', detail: 'FAIL/STUCKの切り分け（プロダクトバグ/カタログ不備/タイミング/環境/テスト不備）' },
    { title: 'Report', detail: 'checkpoint更新 + レポートmd生成 + カタログ更新提案' },
  ],
}

const cfg = (typeof args === 'string') ? JSON.parse(args) : (args || {})
const { runId, runDir, projectRoot, chains } = cfg
if (!Array.isArray(chains)) throw new Error('args.chains が配列ではありません: ' + JSON.stringify(cfg).slice(0, 200))

const EXEC_SCHEMA = {
  type: 'object',
  properties: {
    scenarioId: { type: 'string' },
    status: { type: 'string', enum: ['executed', 'STUCK'] },
    attempts: { type: 'number' },
    observationsRecorded: { type: 'number' },
    scriptPath: { type: 'string' },
    stuckReason: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['scenarioId', 'status', 'attempts'],
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    scenarioId: { type: 'string' },
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'EVIDENCE_NG'] },
    perObservation: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          ok: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['index', 'ok', 'reason'],
      },
    },
    badgeOk: { type: 'boolean' },
    failDetail: { type: 'string' },
    catalogImprovement: { type: 'string' },
  },
  required: ['scenarioId', 'verdict', 'badgeOk', 'perObservation'],
}

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    scenarioId: { type: 'string' },
    classification: { type: 'string', enum: ['PRODUCT_BUG', 'CATALOG_ISSUE', 'TIMING_FLAKE', 'ENV_ISSUE', 'TEST_ISSUE'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'string' },
    productBugDraft: { type: 'string' },
    catalogFix: { type: 'string' },
    envNote: { type: 'string' },
  },
  required: ['scenarioId', 'classification', 'confidence', 'evidence'],
}

function vars(chain, id) {
  return [
    `   - SCENARIO_ID: ${id}`,
    `   - SCENARIO_YAML: ${projectRoot}/${chain.file} 内の「id: ${id}」のエントリ（ファイルを自分で読むこと）`,
    `   - ENV_INDEX: ${chain.envIndex}（認証情報は ${runDir}/envs.json の index ${chain.envIndex}）`,
    `   - RUN_ID: ${runId}`,
    `   - RUN_DIR: ${runDir}`,
    `   - WORK_DIR: ${runDir}/work/${id}（mkdir -p して使う）`,
    `   - EVIDENCE_DIR: ${runDir}/evidence/${id}`,
    `   - PROJECT_ROOT: ${projectRoot}`,
  ].join('\n')
}

function executorPrompt(chain, id, extraNote) {
  return [
    'あなたは PigeonCloud の E2E 実行エージェントです。',
    `1. まず ${projectRoot}/v2/prompts/executor-prompt.md を読み、その指示書に厳密に従ってください。`,
    '2. 指示書内のテンプレート変数は以下の値で読み替えること:',
    vars(chain, id),
    extraNote ? `3. 【再実行】${extraNote}` : '',
    '最終報告は指示書の JSON 形式で StructuredOutput として返すこと。',
  ].filter(Boolean).join('\n')
}

function judgePrompt(chain, id) {
  return [
    'あなたは PigeonCloud の E2E 判定エージェントです。',
    `1. まず ${projectRoot}/v2/prompts/judge-prompt.md を読み、その指示書に厳密に従ってください。`,
    '2. 指示書内のテンプレート変数は以下の値で読み替えること:',
    vars(chain, id),
    '最終報告は指示書の JSON 形式で StructuredOutput として返すこと。',
  ].join('\n')
}

function triagePrompt(chain, id, exec, judge) {
  return [
    'あなたは PigeonCloud の E2E トリアージエージェントです。',
    `1. まず ${projectRoot}/v2/prompts/triage-prompt.md を読み、その指示書に厳密に従ってください。`,
    '2. 指示書内のテンプレート変数は以下の値で読み替えること:',
    vars(chain, id),
    `   - EXEC_JSON: ${JSON.stringify(exec || {}).slice(0, 2000)}`,
    `   - JUDGE_JSON: ${JSON.stringify(judge || {}).slice(0, 2000)}`,
    '最終報告は指示書の JSON 形式で StructuredOutput として返すこと。',
  ].join('\n')
}

async function runScenario(chain, id) {
  const r = { id }
  let exec = await agent(executorPrompt(chain, id), {
    label: `exec:${id}`, phase: 'Execute', model: 'sonnet', schema: EXEC_SCHEMA,
  })
  r.exec = exec
  if (exec && exec.attempts > 3) {
    r.attemptOverrun = true
    log(`${id}: ⚠ 修正試行 ${exec.attempts} 回（上限3超過）— レポートに記録`)
  }

  if (!exec || exec.status === 'STUCK') {
    r.final = 'STUCK_RETRY_EXCEEDED'
  } else {
    let judge = await agent(judgePrompt(chain, id), {
      label: `judge:${id}`, phase: 'Judge', model: 'sonnet', schema: JUDGE_SCHEMA,
    })
    if (judge && judge.verdict === 'EVIDENCE_NG') {
      log(`${id}: EVIDENCE_NG → 追加証拠指示付きで1回だけ再実行`)
      const ngReasons = (judge.perObservation || []).filter(o => !o.ok).map(o => `obs${o.index}: ${o.reason}`).join(' / ')
      const extra = `前回実行は判定エージェントに EVIDENCE_NG と判定されました。不足していた証拠: ${ngReasons}。` +
        `${judge.catalogImprovement ? '判定側の改善提案: ' + judge.catalogImprovement : ''}` +
        '指摘された観測を確実に画面に表示させた状態で captureObservation を撮り直してください。'
      const exec2 = await agent(executorPrompt(chain, id, extra), {
        label: `exec-retry:${id}`, phase: 'Execute', model: 'sonnet', schema: EXEC_SCHEMA,
      })
      if (exec2 && exec2.status === 'executed') {
        const judge2 = await agent(judgePrompt(chain, id), {
          label: `judge-retry:${id}`, phase: 'Judge', model: 'sonnet', schema: JUDGE_SCHEMA,
        })
        if (judge2) { r.exec = exec2; judge = judge2; r.retried = true }
      }
    }
    r.judge = judge
    r.final = judge ? judge.verdict : 'EVIDENCE_NG'
  }

  // FAIL / STUCK は自動トリアージ（人手で切り分けない — 2026-06-12 ユーザー指示）
  if (r.final === 'FAIL' || r.final === 'STUCK_RETRY_EXCEEDED') {
    log(`${id}: ${r.final} → トリアージ開始`)
    r.triage = await agent(triagePrompt(chain, id, r.exec, r.judge), {
      label: `triage:${id}`, phase: 'Triage', model: 'sonnet', schema: TRIAGE_SCHEMA,
    })
  }
  return r
}

const chainResults = await parallel(chains.map(chain => async () => {
  const results = []
  for (const id of chain.ids) {
    log(`env${chain.envIndex}: ${id} 開始 (${results.length + 1}/${chain.ids.length})`)
    try {
      const r = await runScenario(chain, id)
      results.push(r)
      log(`env${chain.envIndex}: ${id} → ${r.final}${r.triage ? ' [' + r.triage.classification + ']' : ''}`)
    } catch (e) {
      results.push({ id, final: 'STUCK_RETRY_EXCEEDED', note: 'orchestration error: ' + (e && e.message) })
      log(`env${chain.envIndex}: ${id} → orchestration error (${e && e.message})`)
    }
  }
  return results
}))

const all = chainResults.filter(Boolean).flat()
const tally = {}
for (const r of all) tally[r.final] = (tally[r.final] || 0) + 1

// Report: checkpoint更新 + report.md 生成（レポーターエージェントが実施）
const slim = all.map(r => ({
  id: r.id, final: r.final, retried: !!r.retried, attemptOverrun: !!r.attemptOverrun,
  attempts: r.exec ? r.exec.attempts : null,
  failDetail: r.judge && r.judge.failDetail ? String(r.judge.failDetail).slice(0, 500) : undefined,
  stuckReason: r.exec && r.exec.stuckReason ? String(r.exec.stuckReason).slice(0, 300) : (r.note || undefined),
  execNotes: r.exec && r.exec.notes ? String(r.exec.notes).slice(0, 300) : undefined,
  triage: r.triage || undefined,
}))

const reportResult = await agent([
  'あなたは E2E スポット実行のレポーターエージェントです。以下を実施してください。',
  '',
  `1. checkpoint 更新: 各シナリオについて次の node ワンライナーを実行（${projectRoot} で実行）:`,
  `   node -e "require('${projectRoot}/v2/lib/run-state').recordResult('${runDir}', '<id>', {status:'<final>', verdict:'<final>', triage:'<classification>'})"`,
  '   （20件程度なら1つの node スクリプトにまとめて一括実行してよい）',
  `2. レポート生成: ${runDir}/report.md に以下の構成で書く:`,
  '   - サマリー表（PASS/FAIL/STUCK 件数・実行ID・日時）',
  '   - 全シナリオの結果表（id / 結果 / トリアージ分類 / 要点1行）',
  '   - FAIL/STUCK 詳細（トリアージの evidence・分類根拠）',
  '   - 「カタログ更新提案」セクション: triage の catalogFix を列挙（ユーザー採否用）',
  '   - 「プロダクトバグ報告ドラフト」セクション: triage の productBugDraft を列挙',
  '   - 「運用上の注意」: attemptOverrun のあったシナリオ・ENV_ISSUE の envNote',
  '3. レポートは日本語・読み手はプロジェクトオーナー。事実のみ書き推測は「疑い」と明記。',
  '',
  '入力データ(JSON):',
  JSON.stringify({ runId, tally, results: slim }),
  '',
  `最終メッセージは「report.md のフルパス」と「カタログ更新提案の件数」「プロダクトバグドラフトの件数」のみ返すこと。`,
].join('\n'), { label: 'reporter', phase: 'Report', model: 'sonnet' })

log(`完了: ${JSON.stringify(tally)} / レポート: ${String(reportResult).slice(0, 200)}`)
return { tally, results: slim, report: reportResult }
