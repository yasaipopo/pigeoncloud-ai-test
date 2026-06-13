# PigeonCloud E2E テストエージェント 指示書（v2 / 2026-06-11 改訂）

このリポジトリは PigeonCloud の E2E テストを「エージェント実行型 v2」方式で行う。
**旧方式（spec.js 黄金ループ・check-yaml/spec-create/check-run パイプライン・E2E全パターン網羅）は 2026-06-11 に廃止**。
旧指示書 → `.claude/archive/CLAUDE-v1-20260611.md`（参照のみ。従わない）

- 設計書 → `.claude/design-docs/2026-06-11-agentic-e2e-v2-design.md`
- フロー詳細・実行手順 → `v2/RUNBOOK.md`
- パイロット結果（本方式の根拠） → `.claude/design-docs/2026-06-11-pilot-report.md`

---

## 0. テスト責務の大原則

- **ロジック網羅は PHPUnit/Integration（pigeon_cloud 側）の責務**。E2E は「フロントから主要動線をかいつまんで通す」役割
- E2E の唯一の正は **シナリオカタログ `catalog/*.yaml`**（spec.js は廃止。テストコードはエージェントが生成する使い捨て/キャッシュ）
- ゴールは「厳選シナリオが 100% **本物の検証**で完走する」こと。pass数を稼ぐためのテスト緩和は最悪の違反

## 1. カタログ規約（SSoT）

```yaml
- id: rec-001
  title: （1文・ユーザー視点の動線）
  priority: P1            # P1=コア動線 / P2=主要機能 / P3=余裕があれば
  destructive: false      # 環境を後続が使えなくする系のみ true（各チェーン最後尾で実行）
  scope: local            # /admin/setting/** 等の環境全体設定に触れるなら global（最後尾）
  source: [rec-160, pigeon_cloud#3593]   # 元case_no・バグ由来ならPR番号/障害ID
  precondition: |
    {id}- プレフィックスの軽量テーブルを debug API で作成（ALLテストテーブルは使わない）。
    マスターadminの認証情報は変更しない。
  steps:
    - 自然言語の操作手順（CSSセレクタ・技術用語は書かない）
  observations:
    - 観測可能な具体値（URL・表示文字列・並び順・件数）+ [スクショ]
```

- **曖昧語禁止**（「正常に」「適切に」等）— `node v2/lib/validate-catalog.js catalog` で機械検出
- **グローバル状態依存禁止**（「テーブル数がN件」不可。自分で作ったリソース基準で書く）
- 🔴 **非同期反映の待ちを明記**（パイロット教訓）: 削除・更新・検索クリア等の後の観測は「反映されるまで待ってから」を steps/observations に書く。反映ラグ中のスクショは偽FAILになる
- API系の観測は **HTTPステータスだけで書かない**（200=SPAシェルHTMLの場合がある）。「レスポンスにユーザーデータ(JSON)が含まれない」のように中身で書く
- カタログの追加・削除は**ユーザー承認制**（§5 のトリアージで提案 → 採否）

## 2. 実行方式（スポット実行）

```
カタログ更新トリアージ → validate-catalog + unit tests → 環境準備 →
実行 → 判定 → FAIL/STUCKは自動トリアージ（環境ごと並列・チェーン内直列）
→ レポート自動生成（checkpoint更新 + カタログ更新提案 + バグ報告ドラフト）
```

- 実行〜レポートは保存版ワークフロー **`e2e-v2-spot-run`**（`.claude/workflows/e2e-v2-spot-run.js`）で全自動実行する。オーケストレーターの仕事は「環境準備 → ワークフロー起動 → 完成したレポートのユーザー提示」のみ
- 🔴 **全シナリオ動画録画**（2026-06-13 ユーザー指示）。実行エージェントは録画付き context で操作（evidence.js の newRecordingContext / finalizeVideo）
- 🔴 **成果物は月ごとのローカルアーカイブに保管**: `run-dir` は `~/pigeon-e2e-archive/YYYY-MM/{runId}/`（`node v2/lib/paths.js <runId>` で算出）。配下に report.md / evidence/{id}/（png+json）/ video/{id}/（webm+mp4）を集約。`E2E_ARCHIVE_ROOT` 環境変数で保管先変更可

- **役割分離（厳守）**: オーケストレーター（メイン）は環境準備・エージェント起動・集計のみ。**実行エージェント（Sonnet）**がブラウザ操作と証拠出力、**判定エージェント（Sonnet・別コンテキスト）**が証拠だけを根拠に判定。同一エージェントが実行と判定を兼ねない
- 実行エージェント指示書 → `v2/prompts/executor-prompt.md` / 判定 → `v2/prompts/judge-prompt.md`
- 🔴 **修正試行はハード上限3回**（オーケストレーター側で強制。実行エージェントの自己判断で超過不可 — パイロットでプロンプト指示だけでは7回まで暴走した）。超過は STUCK_RETRY_EXCEEDED で記録して次へ。**止まらない**ことが最優先
- checkpoint（`v2/lib/run-state.js`・atomic write）に逐次記録。クラッシュ時は同 run-dir で再開（完了済みスキップ）
- 並列度はチェーン数（=環境数）。200件規模は5〜6面で一晩

## 3. テスト環境

- **1チェーン=1環境を使い回す**。シナリオごとに作らない・リセットしない（旧 reset-all/delete-all-type-tables は呼ばない）
- **環境レジストリ方式**: 作成済み環境を**スポット実行をまたいで**再利用する。レジストリの永続先は `v2/envs-registry.json`（git管理外・作成日時/ヘルス履歴付き）。実行開始時にヘルスチェック（ログイン可・trial上限余裕）→ NG の環境だけ create-trial で作り直してレジストリを更新
- データ干渉防止: 各シナリオは `{id}-` プレフィックスの自リソースのみ作成・検証。ALLテストテーブル不使用（重い・干渉源）
- destructive / scope:global はチェーン最後尾。ログイン不能級は専用環境
- trial 上限（max_user=5 等）対策: 実行末尾にプレフィックス付きリソースの掃除ステップ。上限緩和（debug settings API での max_user 引き上げ等）は **precondition に記載がある場合のみ可**。無断のシステム設定変更は禁止
- 環境作成からのテストは行わない（作成経路のエラーは影響範囲が小さく優先度低・2026-06-11 ユーザー判断）

## 4. 判定（偽装PASS の構造的防止）

- **三値判定**: PASS / FAIL / EVIDENCE_NG（証拠不十分）。EVIDENCE_NG は1回だけ追加証拠指示付きで自動再実行
- 証拠主義: observation ごとに実行IDバッジ入りスクショ + DOM から取得した実値（`v2/lib/evidence.js`）。判定はスクショを**実際に開いて**位置と内容を確認
- 🔴 判定の過剰解釈禁止（パイロット教訓）: HTTP 200 + HTMLシェル ≠ データ漏洩。期待値の妥当性に疑問があれば FAIL ではなく「カタログ改善提案」を出す
- 🔴 **FAIL/STUCK の切り分けはトリアージエージェントが自動実施**（2026-06-12 ユーザー指示: 人手・オーケストレーターの手作業でやらない）。指示書 → `v2/prompts/triage-prompt.md`。分類は PRODUCT_BUG / CATALOG_ISSUE / TIMING_FLAKE / ENV_ISSUE / TEST_ISSUE の5種で、証拠の再精査→環境の現状直接確認→再現性確認（1回）→プロダクトコード照合の順に実証してから確定する
- レポートには分類済みの結果＋カタログ更新提案＋プロダクトバグ報告ドラフトが自動で載る。PRODUCT_BUG はユーザー報告後に `.claude/product-bugs.md` に記録。カタログは緩めない

## 5. カタログの整備・更新（トリアージ）

バグ修正PR・本番障害・Slack #テスト-staging 報告が出たら3分類:

| 分類 | 判定 | 反映 |
|---|---|---|
| (a) ロジックバグ | プロダクト側 Unit/Integration で再発防止済み | 反映しない（E2E責務外） |
| (b) UI動線の断絶 | ユーザーに見えた症状が動線の断絶 | **症状の動線**を新設提案（内部原因ではなく経路を書く） |
| (c) 既存動線上 | カバーするシナリオが既にある | observations に観測点1行追加 |

- スポット実行の前段で「更新提案リスト」を作りユーザー採否（提案はスポット実行レポート内の「カタログ更新提案」セクションとして提示）→ カタログは少数精鋭を維持（旧体制の数千件膨張が死因）
- 追加時は `source:` に PR番号/障害ID を記録

## 6. 恒久ルール（v1 から継続）

### 🟢 自律マージ承認（2026-04-26 ユーザー指示）
このリポジトリ（E2Eテストコード専用）の PR は main マージまでユーザー承認なしで実行してよい。
branch → commit → push → PR → テスト pass 確認 → （bot レビューがあれば対応）→ merge --squash --delete-branch。
例外: 機密を含む PR・プロダクトリポジトリ（Loftal/pigeon_cloud）への変更は対象外。

### 🟢 gemcli 方向性レビュー（2026-04-26 ユーザー指示）
大きな方針転換時・PR 3件マージごと・判断に迷う時は gemcli に方向性レビューさせる（妥当/再考/改善案）。
設計書・カタログの大規模変更もユーザー提示前に gemcli レビューを通す。

### 🔴 プロダクト修正は tmprepo 経由
pigeon_cloud の修正は必ず `tmprepo staging` で /tmp にクローンして作業（ローカル作業コピー直接編集禁止）。

### 🔴 テストが通らない＝プロダクトが間違っているかもしれない
期待値が仕様通りなら疑うのはプロダクト側。テストを通すための緩和・skip・期待値の現実合わせは禁止。

## 7. 環境情報・リソース

| 項目 | 値 |
|---|---|
| 管理（環境作成元） | https://ai-test.pigeon-demo.com（staging）/ https://ai-test.pigeon-cloud.com（本番） |
| 🔴 本番実行ガード | 本番（pigeon-cloud.com）に対する実行は `CONFIRM_PRODUCTION=1` 必須（env-guard.js が拒否）。詳細 → `.claude/knowledge-production-testing.md` |
| ローカル実行の認証 | `.env.staging` を dotenv で自動ロード（provision-envs.js） |
| 環境作成 | `node v2/provision-envs.js --count N --run-dir runs/{runId}`（create-trial・直列・再開可能） |
| debug API | `POST /api/admin/debug/create-light-table` / `create-user` / `status` 等（データ準備に積極活用） |
| Webhookテスト | `http://test.yaspp.net/pigeon/webhook.php?key={KEY}`（helpers/webhook-checker.js） |
| メール | SMTP/IMAP は `.env.staging`（mail-checker.js） |
| テストファイル | `test_files/`（画像・PDF・CSV・Excel） |
| 既知のdebug APIバグ | create-light-table の checkbox オプションが `option_a` キー保存で Form.php の `items` 検証と不一致（2026-06-11 発見・修正待ち） |

## 8. 知見ファイル（作業前に必読）

| ファイル | 内容 |
|---|---|
| `v2/RUNBOOK.md` | フロー設計・実行手順・再開方法 |
| `.claude/knowledge-e2e-angular.md` | Angular UI の癖（モーダル pre-render・Ladda・dropdown 等）— v2 でも有効 |
| `.claude/knowledge-e2e-performance.md` | 待ち方（auto-wait・固定sleep回避）— v2 でも有効 |
| `.claude/knowledge-page-*.md` | 画面別の操作知見 — 実行エージェントへの参考資料として有効 |
| `.claude/product-bugs.md` | プロダクトバグ記録 |
| `.claude/test-env-limitations.md` | 環境起因でテスト不能なものの記録 |

新しい知見（UIの癖・debug API挙動・判定の落とし穴）を得たら該当ファイルに追記してから作業を終える。
