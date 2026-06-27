export const meta = {
  name: 'e2e-journey-run',
  description: 'E2E ジャーニー1本を実行→判定→第三者チェック→トリアージ→レポート',
  phases: [
    { title: 'Execute', detail: 'journey-executor（1認証で全フェーズ・checkpoint毎に観測）' },
    { title: 'Judge', detail: '判定エージェント（証拠物ベース・checkpoint毎に三値）' },
    { title: 'Check', detail: 'PASS後の第三者チェック（要件すり替え検出）' },
    { title: 'Triage', detail: 'FAIL/STUCKの自動切り分け' },
    { title: 'Report', detail: 'checkpoint更新+レポート+ビューアー再生成' },
  ],
}
const cfg = (typeof args === 'string') ? JSON.parse(args) : (args || {})
const { runId, runDir, projectRoot, journeyId, journeyFile, envIndex } = cfg

const EXEC_SCHEMA = { type: 'object', properties: {
  journeyId: { type: 'string' }, status: { type: 'string', enum: ['executed', 'STUCK'] },
  attempts: { type: 'number' }, checkpointsRecorded: { type: 'number' },
  scriptPath: { type: 'string' }, stuckReason: { type: 'string' }, notes: { type: 'string' },
}, required: ['journeyId', 'status', 'attempts'] }

const JUDGE_SCHEMA = { type: 'object', properties: {
  scenarioId: { type: 'string' }, verdict: { type: 'string', enum: ['PASS', 'FAIL', 'EVIDENCE_NG'] },
  perObservation: { type: 'array', items: { type: 'object', properties: {
    index: { type: 'number' }, ok: { type: 'boolean' }, reason: { type: 'string' } }, required: ['index', 'ok', 'reason'] } },
  badgeOk: { type: 'boolean' }, failDetail: { type: 'string' }, catalogImprovement: { type: 'string' },
}, required: ['scenarioId', 'verdict', 'badgeOk', 'perObservation'] }

const CHECK_SCHEMA = { type: 'object', properties: {
  scenarioId: { type: 'string' }, ok: { type: 'boolean' }, issue: { type: 'string' } }, required: ['scenarioId', 'ok'] }

const TRIAGE_SCHEMA = { type: 'object', properties: {
  scenarioId: { type: 'string' }, classification: { type: 'string', enum: ['PRODUCT_BUG','CATALOG_ISSUE','TIMING_FLAKE','ENV_ISSUE','TEST_ISSUE'] },
  confidence: { type: 'string', enum: ['high','medium','low'] }, evidence: { type: 'string' },
  productBugDraft: { type: 'string' }, catalogFix: { type: 'string' }, envNote: { type: 'string' } }, required: ['scenarioId','classification','confidence','evidence'] }

const vars = [
  `   - JOURNEY_ID: ${journeyId}`,
  `   - JOURNEY_YAML: ${journeyFile} を読むこと（このファイルにジャーニー定義あり）`,
  `   - ENV_INDEX: ${envIndex}（認証情報は ${runDir}/envs.json の index ${envIndex}）`,
  `   - RUN_ID: ${runId} / RUN_DIR: ${runDir} / WORK_DIR: ${runDir}/work/${journeyId} / PROJECT_ROOT: ${projectRoot}`,
  `   - EVIDENCE_DIR: ${runDir}/evidence/${journeyId}`,
].join('\n')

function execPrompt(extra) {
  return [
    'あなたは PigeonCloud の E2E ジャーニー実行エージェントです。',
    `1. まず ${projectRoot}/v2/prompts/journey-executor-prompt.md を読み、厳密に従う。`,
    '2. テンプレート変数:', vars,
    `   - JOURNEY_YAML は {{JOURNEY_YAML}} の代わりに ${journeyFile} の中身を使う（自分で読む）`,
    extra ? `3. 【再実行】${extra}` : '',
    '最終報告は指示書の JSON 形式で StructuredOutput として返す。',
  ].filter(Boolean).join('\n')
}
function judgePrompt() {
  return [
    'あなたは PigeonCloud の E2E 判定エージェントです。',
    `1. まず ${projectRoot}/v2/prompts/judge-prompt.md を読み、厳密に従う。`,
    `2. 対象は「ジャーニー」: ${journeyFile} を読み、phases 横断の checkpoints を観測リスト(index順)として、各 obs を ${runDir}/evidence/${journeyId}/obs-NN.png と突き合わせ三値判定する。`,
    '3. 変数:', vars,
    '最終報告は judge-prompt.md の JSON 形式で StructuredOutput として返す（scenarioId=ジャーニーID）。',
  ].join('\n')
}
function checkPrompt() {
  return [
    'あなたは E2E の第三者チェック担当（実行/判定と独立）。',
    `1. まず ${projectRoot}/v2/prompts/triage-prompt.md は使わず、要件すり替え・簡略化の検出に専念する。`,
    `2. ${journeyFile} のジャーニー要件 vs ${runDir}/work/${journeyId}/ の実行スクリプト・${runDir}/evidence/${journeyId}/ の証拠を突合。`,
    '   検出: 別人性の同一ユーザー代替・観測対象のすり替え・検証主操作のAPI代替・前提未充足・checkpoint の省略。',
    'ok=true は要件どおり実行され PASS が妥当なときのみ。少しでもすり替え/簡略化があれば ok=false、issue に具体箇所。',
    'JSON {scenarioId, ok, issue} を StructuredOutput で返す。',
  ].join('\n')
}
function triagePrompt(exec, judge) {
  return [
    'あなたは E2E トリアージエージェント。',
    `1. まず ${projectRoot}/v2/prompts/triage-prompt.md を読み従う。対象はジャーニー ${journeyId}（${journeyFile}）。`,
    '2. 変数:', vars,
    `   - EXEC_JSON: ${JSON.stringify(exec || {}).slice(0, 1500)}`,
    `   - JUDGE_JSON: ${JSON.stringify(judge || {}).slice(0, 1500)}`,
    '最終報告は triage-prompt.md の JSON で StructuredOutput（scenarioId=ジャーニーID）。',
  ].join('\n')
}

phase('Execute')
let exec = await agent(execPrompt(), { label: `exec:${journeyId}`, phase: 'Execute', model: 'sonnet', schema: EXEC_SCHEMA })
const r = { id: journeyId, exec }
if (exec && exec.attempts > 3) { r.attemptOverrun = true; log(`${journeyId}: ⚠ 試行 ${exec.attempts} 回（上限3超過）`) }

if (!exec || exec.status === 'STUCK') {
  r.final = 'STUCK_RETRY_EXCEEDED'
} else {
  phase('Judge')
  let judge = await agent(judgePrompt(), { label: `judge:${journeyId}`, phase: 'Judge', model: 'sonnet', schema: JUDGE_SCHEMA })
  if (judge && judge.verdict === 'EVIDENCE_NG') {
    const ng = (judge.perObservation || []).filter(o => !o.ok).map(o => `obs${o.index}: ${o.reason}`).join(' / ')
    log(`${journeyId}: EVIDENCE_NG → 追加証拠で1回再実行`)
    const exec2 = await agent(execPrompt(`判定がEVIDENCE_NG。不足証拠: ${ng}。該当checkpointを確実に画面表示してcaptureObservationを撮り直す。`), { label: `exec-retry:${journeyId}`, phase: 'Execute', model: 'sonnet', schema: EXEC_SCHEMA })
    if (exec2 && exec2.status === 'executed') {
      const judge2 = await agent(judgePrompt(), { label: `judge-retry:${journeyId}`, phase: 'Judge', model: 'sonnet', schema: JUDGE_SCHEMA })
      if (judge2) { r.exec = exec2; judge = judge2; r.retried = true }
    }
  }
  r.judge = judge
  r.final = judge ? judge.verdict : 'EVIDENCE_NG'
  if (r.final === 'PASS') {
    phase('Check')
    const check = await agent(checkPrompt(), { label: `check:${journeyId}`, phase: 'Check', model: 'sonnet', schema: CHECK_SCHEMA })
    r.check = check
    if (check && check.ok === false) { log(`${journeyId}: 第三者チェックで簡略化検出→FAIL降格 (${check.issue || ''})`); r.final = 'FAIL'; r.checkDowngraded = true }
  }
}

if (r.final === 'FAIL' || r.final === 'STUCK_RETRY_EXCEEDED') {
  phase('Triage')
  r.triage = await agent(triagePrompt(r.exec, r.checkDowngraded ? { ...(r.judge||{}), checkIssue: r.check && r.check.issue } : r.judge), { label: `triage:${journeyId}`, phase: 'Triage', model: 'sonnet', schema: TRIAGE_SCHEMA })
}

phase('Report')
const reporterMsg = await agent([
  'E2Eジャーニー実行のレポーター。',
  `1. checkpoint更新: node -e で ${projectRoot}/v2/lib/run-state の recordResult('${runDir}','${journeyId}',{status:'${r.final}',verdict:'${r.final}',triage:'${r.triage?r.triage.classification:'-'}'}) を実行（runDirにcheckpoint無ければinitRunで作る）。`,
  `2. ${runDir}/report.md に: サマリー(ジャーニー${journeyId}・結果${r.final}・観点数)・checkpoint毎の判定・FAIL/STUCK詳細(triage)・カタログ更新提案・運用注意(attemptOverrun=${!!r.attemptOverrun})。`,
  `3. ${projectRoot}/v2/lib/build-viewer.js でビューアー再生成。`,
  '入力:', JSON.stringify({ runId, journeyId, final: r.final, judge: r.judge, triage: r.triage, exec: r.exec && { attempts: r.exec.attempts, checkpointsRecorded: r.exec.checkpointsRecorded, notes: String(r.exec.notes||'').slice(0,400) } }),
  '最終メッセージは report.md パスと結果サマリーのみ。',
].join('\n'), { label: 'reporter', phase: 'Report', model: 'sonnet' })

log(`完了: ${journeyId} → ${r.final}`)
return { journeyId, final: r.final, judge: r.judge, triage: r.triage, report: String(reporterMsg).slice(0, 300), attemptOverrun: !!r.attemptOverrun }