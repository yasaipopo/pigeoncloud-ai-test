# v2 パイロット実行ランブック + フロー設計（オーケストレーター用）

オーケストレーター = Claude メインセッション。設計書 → `.claude/design-docs/2026-06-11-agentic-e2e-v2-design.md`

## フロー設計: スポット実行1回の全体像

```
【前段】カタログ更新トリアージ（設計書 §7）
  前回実行以降の merged PR / Slack #テスト-staging 報告をスキャン
    ├─ (a) ロジックバグ（プロダクト側 Unit/Integration で再発防止済み）→ 反映しない
    ├─ (b) UI動線の断絶 → 症状の動線シナリオを新設提案（source: にPR番号/障害ID）
    └─ (c) 既存動線上のバグ → 既存シナリオの observations に観測点を1行追加提案
  → 更新提案リストをユーザーに提示 → 採否反映 → validate-catalog で機械チェック
        │
        ▼
【0】事前チェック
  validate-catalog OK + unit tests PASS を確認
        │
        ▼
【1】環境プロビジョニング（直列・再開可能）
  provision-envs.js が create-trial を N 回直列実行 → runs/{runId}/envs.json
  ※ 1エージェント1環境。シナリオごとには作らない（環境使い回し方式）
        │
        ▼
【2】実行・判定オーケストレーション（環境チェーン並列 × チェーン内直列）
  ┌─ チェーン0 (env0): auth 8件 ──────────────────────────┐
  │  シナリオごとに:                                        │
  │   実行エージェント(Sonnet・新規コンテキスト)            │
  │     カタログ読込 → 使い捨てPlaywrightスクリプト作成     │
  │     → 実行 → 失敗なら修正(最大3回) → evidence 出力      │
  │         │ status: executed ─────────┐   │ STUCK        │
  │         ▼                           ▼   ▼              │
  │   判定エージェント(Sonnet・別コンテキスト)  checkpoint   │
  │     スクショを実際に開いて観測値と突き合わせ            │
  │     バッジID一致確認 → PASS / FAIL / EVIDENCE_NG        │
  │         │ EVIDENCE_NG のとき1回だけ:                    │
  │         └→ 不足証拠の追加撮影指示付きで実行を再起動      │
  │            → 再判定 → それでもNGなら確定                │
  │         │ FAIL / STUCK のとき:                          │
  │         └→ トリアージエージェント（自動・人手でやらない）│
  │            証拠再精査→環境の現状確認→再現性確認→コード照合│
  │            → PRODUCT_BUG/CATALOG_ISSUE/TIMING_FLAKE/    │
  │               ENV_ISSUE/TEST_ISSUE に分類               │
  │   → checkpoint.json に逐次記録 → 次のシナリオへ          │
  │   実行順: scope:local → destructive/global は最後尾      │
  └──────────────────────────────────────────────────────┘
  ┌─ チェーン1 (env1): records 12件（同上）─────────────────┐
  └──────────────────────────────────────────────────────┘
        │ 全チェーン完了（STUCKでも止まらず次へ進む）
        ▼
【3】レポート自動生成（レポーターエージェント）
  checkpoint 更新 + runs/{runId}/report.md 生成
  （サマリー表 / トリアージ分類済み結果 / カタログ更新提案 / プロダクトバグ報告ドラフト / 運用上の注意）
  成功スクリプト → cache/scripts/{id}.js 保存（次回の安価再生・全面展開時）
  → オーケストレーターは完成したレポートをユーザーに提示するだけ
```

### 実行コマンド（【2】【3】は保存版ワークフローで全自動）

実行〜レポートまでは Workflow `e2e-v2-spot-run`（`.claude/workflows/e2e-v2-spot-run.js`）を
`args: { runId, runDir, projectRoot, chains: [{envIndex, file, ids}] }` で起動する。
オーケストレーター（メインセッション）が手作業で行うのは環境準備・ワークフロー起動・レポート提示のみ。
FAIL の切り分け・checkpoint 更新・レポート作成を**メインセッションが手でやるのはルール違反**（2026-06-12 ユーザー指示）。

### 役割分担（だれが何をするか）

| 役割 | 担当 | やること / やらないこと |
|---|---|---|
| オーケストレーター | Claude メインセッション | 環境作成・エージェント起動・checkpoint管理・集計。**ブラウザ操作はしない** |
| 実行エージェント | Sonnet サブエージェント（シナリオごとに新規） | シナリオ完遂と証拠出力のみ。**判定はしない**。認証情報は envs.json 参照（プロンプト直埋め禁止） |
| 判定エージェント | Sonnet サブエージェント（実行と別コンテキスト） | 証拠物だけを根拠に三値判定。**実行エージェントの主張を信用しない** |
| ユーザー | 石川さん | カタログ更新の採否・FAIL のバグ報告判断・GO/NO-GO |

### 止まらない・再開できる仕組み

- **実行エージェントの修正試行は最大3回** → 超過は STUCK_RETRY_EXCEEDED で記録し次へ（コスト暴走防止）
- **checkpoint.json は atomic write**（tmp+rename）。クラッシュしても壊れない
- **再開** = 同じ run-dir で再起動: provision は既存スキップ、`pendingScenarios()` が未完了のみ返す
- 環境作成失敗はリトライ最大2回 → 不能ならその環境の担当分を他チェーンに再配分
- 朝のレポートは必ず「完走 or 残件と理由」を含める

### 偽装PASS を防ぐ4つの構造

1. **実行と判定の分離**（同一エージェントが自己採点しない）
2. **証拠物必須**（observation ごとにスクショ + DOM から取得した実値）
3. **実行IDバッジ**（スクショ右下に DOM 注入。古い/他テストの証拠流用を判定側が検出）
4. **三値判定**（テストの甘さを FAIL と区別して EVIDENCE_NG として可視化）

---

## 実行手順

## 0. 事前

```bash
node v2/lib/validate-catalog.js catalog   # バリデーション OK を確認
node --test v2/tests/*.test.js            # ユニットテスト全 PASS を確認（ディレクトリ指定は不可）
RUN_ID=$(date +%Y%m%d-%H%M)-pilot
node v2/provision-envs.js --count 2 --run-dir runs/$RUN_ID
# ローカル実行時は .env.staging を自動ロード（--env-file で変更可）
```

## 1. 初期化

- `initRun(runDir, runId, 全シナリオID)` で checkpoint 作成（node -e で実行）
- 割当: env0 → auth 8件 / env1 → records 12件
- 各環境内の実行順: scope: local → destructive / global は最後
- auth-008（マルチテナント分離）は env1 の URL を借用するため、**全環境のプロビジョニング完了後（envs.json に2件揃ってから）**にのみ実行する。provision-envs.js は実行ループ開始前に全件完了させる運用のため通常は自動的に満たされるが、再開時に envs.json が1件しかない場合は auth-008 を後回しにする（read-only 借用なので env1 の records 消化との並走は可）

## 2. 実行ループ（環境ごとに並列、環境内は直列）

各シナリオについて:
1. `v2/prompts/executor-prompt.md` の {{変数}} を埋めて Sonnet サブエージェントを起動（Agent tool, model: sonnet）
   - 変数: SCENARIO_YAML / SCENARIO_ID / ENV_INDEX / RUN_ID / RUN_DIR / WORK_DIR / PROJECT_ROOT
   - 認証情報は渡さない（エージェントが envs.json から読む）
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
