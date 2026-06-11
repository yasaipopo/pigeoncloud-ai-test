# v2 パイロット実行ランブック（オーケストレーター用）

オーケストレーター = Claude メインセッション。以下を順に行う。

## 0. 事前

```bash
node v2/lib/validate-catalog.js catalog   # バリデーション OK を確認
node --test v2/tests/*.test.js            # ユニットテスト全 PASS を確認（ディレクトリ指定は不可）
RUN_ID=$(date +%Y%m%d-%H%M)-pilot
node v2/provision-envs.js --count 2 --run-dir runs/$RUN_ID
```

## 1. 初期化

- `initRun(runDir, runId, 全シナリオID)` で checkpoint 作成（node -e で実行）
- 割当: env0 → auth 8件 / env1 → records 12件
- 各環境内の実行順: scope: local → destructive / global は最後
- auth-008（マルチテナント分離）は env1 の URL を借用するため、**全環境のプロビジョニング完了後（envs.json に2件揃ってから）**にのみ実行する。provision-envs.js は実行ループ開始前に全件完了させる運用のため通常は自動的に満たされるが、再開時に envs.json が1件しかない場合は auth-008 を後回しにする（read-only 借用なので env1 の records 消化との並走は可）

## 2. 実行ループ（環境ごとに並列、環境内は直列）

各シナリオについて:
1. `v2/prompts/executor-prompt.md` の {{変数}} を埋めて Sonnet サブエージェントを起動（Agent tool, model: sonnet）
   - 変数: SCENARIO_YAML / SCENARIO_ID / ENV_URL / ENV_EMAIL / ENV_PASSWORD / RUN_ID / RUN_DIR / WORK_DIR / PROJECT_ROOT
   - シナリオ単位タイムアウト目安 10分
2. 報告 JSON を checkpoint に recordResult（status: executed / STUCK）
3. STUCK → status: STUCK_RETRY_EXCEEDED で記録し次へ（止まらない）

## 3. 判定ループ（実行完了したものから随時）

1. `v2/prompts/judge-prompt.md` を埋めて**別の** Sonnet サブエージェントを起動（実行エージェントと文脈を共有しない）
2. verdict を recordResult
3. EVIDENCE_NG → 1回だけ「不足していた証拠の追加撮影指示」を付けて executor を再起動 → 再判定。それでも NG なら確定

## 4. 集計・レポート

- checkpoint.json から PASS / FAIL / EVIDENCE_NG / STUCK_RETRY_EXCEEDED を集計
- FAIL は evidence + 再現スクリプトを添えて `.claude/product-bugs.md` 起案（記録はユーザー報告後）
- パイロット計測値:
  - シナリオ平均時間・トークン量（サブエージェント usage 集計）
  - EVIDENCE_NG 件数（判定分離が機能した証拠）
  - FAIL 振り分け: 本物バグ vs テスト側不備の比率
  - 環境使い回し起因の汚染 FAIL の有無
- 200件換算の見積もりを算出して GO/NO-GO 材料としてユーザーに提示

## 再開

途中で落ちた場合: 同じ run-dir で provision（既存スキップ）→ `pendingScenarios()` で未完了のみ再実行。
checkpoint.json は recordResult が atomic write するため、途中クラッシュでも壊れない。
