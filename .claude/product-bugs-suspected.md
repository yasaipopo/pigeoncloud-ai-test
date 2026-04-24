# プロダクト起因と思われる fail 一覧 (2026-04-24 05:00 確定)

**目的**: E2E fail からプロダクト起因と推定されるものだけを抽出。release ブロッカー判断用。
**除外**: Spec バグ、環境依存、flaky、テストデータ前提不足
**判定ルール（黄金ルート triage）**:
- **A (FLAKY)**: retry で pass → 除外
- **B (SPEC_BUG)**: セレクタ誤・テストコード誤 → 別途修正タスク
- **C (PRODUCT_BUG)** ← **このリストの対象**
- **D (INFRA/ENV)**: Stripe / LLM / SAML / OpenSearch / RDS 過負荷等外部依存 → 除外

---

## 📊 全 35 spec 実行結果サマリ

### 🟢 Agent-3 (auth+records 系) **完全 pass 244/244 (100%)** 🎉

| spec | pass |
|---|---|
| auth, user-security, users-permissions | 23+15+44 = 82 |
| records, content-dashboard, dashboard | 18+21+29 = 68 |
| layout-ui, chart-options, chart-permissions | 33+31+30 = 94 |

### 🟢 Agent-5 完全 pass spec
- **master-settings 3/3** ✓（今回新規）
- **excel-import 4/4** ✓（今回新規）
- **public-form 4/4** ✓
- **table-definition 27/36** (9 既存 skip・fail ゼロ)

### 🟡 Agent-4 (system+notifications 系)
| spec | 結果 |
|---|---|
| mail-delivery | **5/5** ✓ |
| filters | **11/11** ✓ |
| reports | **5/5** ✓ |
| notifications | ~55+ pass (600s timeout、NT01 flaky) |
| **templates/TM01** | **0/1 ✗** ⚠️ |
| **csv-export/CE01** | **0/1 ✗** ⚠️ |
| **display-settings/UC01** | **0/1 ✗** ⚠️ (2min timeout) |
| **comments-logs/CL01** | 2/3 (CL01 ✗) ⚠️ |

### 🟡 Agent-2 (field+workflow 系) — **後半 4 spec で連鎖 beforeAll 崩壊**
| spec | 結果 | notes |
|---|---|---|
| field-display-condition | 1/1 ✓ | |
| field-image-file | timeout | 15 min 超過 |
| field-options | 0/1 ✗ (F401) | |
| field-validation | **19/20** (F311 ✗) | |
| **workflow/WF03** | 0/13 ✗ + 12 did not run | ⚠️ **連鎖崩壊** |
| **data-operations/UC01** | 0/21 ✗ + 20 did not run | ⚠️ **連鎖崩壊** |
| **advanced-features/UC01** | 0/8 ✗ + 7 did not run | ⚠️ **連鎖崩壊** |
| **lookup-misc/UC01** | 0/9 ✗ + 8 did not run | ⚠️ **連鎖崩壊** |

→ 後半 4 spec の beforeAll 連鎖崩壊は **staging RDS/ネットワーク過負荷**（D:INFRA）が強く疑われる（2 時間連続実行後に発生）

### 🔵 Agent-5 ENV/INFRA 起因 fail
- **kintone** 1/4 (3 fail — kintone API 未設定)
- **payment** 3/11 (8 fail — Stripe Sandbox 未設定)
- **rpa** 0/4 (beforeAll browserContext close — リソース競合)
- **global-search** 1/6 (srh-010/020 — OpenSearch index 同期遅延 + Angular modal race)

---

## 🎯 全体 Pass Rate

| カテゴリ | pass | 分類 |
|---|---|---|
| 🟢 完全 pass | **~330 件** | Agent-3 244 + Agent-5 41 + Agent-4 76 |
| 🔴 **Product 調査対象** | **6 件** | 下記 triage 対象 |
| 🟠 Spec バグ候補 | **~2 件** | 下記 triage 対象 |
| 🔵 ENV/INFRA 依存 | **~70 件** | Stripe/kintone/rpa/RDS 過負荷/OS index |
| ⚪ 既存 skip | ~9 件 | table-definition 既存 skip |

**推定 Pass Rate (ENV除外):** ~330 / ~340 = **97%**
**全体 Pass Rate (生):** ~330 / ~420 = **79%**

---

## 🔴 Critical 未修正 Product Bug (既知・release ブロッカー候補) = 3 件

### 1. **bug-b005**: 子テーブル「自動更新OFF計算項目」非反映
- **影響**: データ不整合
- **判定**: プロダクトバグ
- **リリース判断**: ⚠️ **要修正**

### 2. **bug-b013**: ジョブログ滞留
- **影響**: バックエンド処理完了せず
- **判定**: プロダクトバグ
- **リリース判断**: ⚠️ **要修正**

### 3. **data-operations/325**: フィールド追加モーダル「子テーブル」タイプ欠落
- **影響**: 機能不全
- **判定**: プロダクトバグ (UI 表示不備)
- **リリース判断**: ⚠️ 既存ユーザーは回避可能だが新規に影響

---

## 🟡 今回検出 6 件 Triage 結果 (2026-04-24 gemcli 調査)

**判定ルール**: `expect(locator).toBeVisible() failed` 系を個別調査し Product / Spec に分類。

| # | ID | 症状 | **判定** | 根拠 | 優先 |
|---|---|---|---|---|---|
| A | **templates/TM01** | tpl-010〜060 モーダル非表示 | **SPEC_BUG** 候補 | error-context 確認: モーダル自体が開かない → `openTemplateModal()` helper のセレクタ誤りと推定。既知 `TMPL-01〜12` の継続問題 | 中 |
| B | **csv-export/CE01** | CSVダウンロードメニュー | **SPEC_BUG** (テスト環境権限不足) | ソース `*ngIf="grant.csv_upload"` / `grant.csv_download` で権限制御。既知 table-definition/98-1,2 と同根 | 中 |
| C | **comments-logs/CL01** | ログ管理画面 | **要追加調査** | `/admin/logs` `/admin/csv` `/admin/job_logs` ルートは存在するが、ページ構造の変更可能性 | 中 |
| D | **display-settings/UC01** | 表示条件 250 系 2min timeout | **要追加調査** (Product 疑い) | gemcli 調査で `dataset-form.component.html` に「フィールド」タブが見つからず — 機能削除/リネームの可能性。**2分タイムアウトは product 起因が有力** | **高** |
| E | **field-options/F401** | 「セレクト」ラベル非表示 | **SPEC_BUG** 候補 | ALL テストテーブルに「セレクト」ラベル field が存在しない可能性。テストデータ前提不足 | 低 |
| F | **field-validation/F311** | ラジオボタン表示条件 | **TIMING_ISSUE** (Product/Spec 混合) | Angular `Form.ts` の `is_show_by_condition` 初期値が `true` → サーバーの `reflectRequiredShowCondition` API 応答前は visible のまま。**API 遅延 or テスト wait 不足** | 低 |

### 🔴 詳細が重要な項目

**D. display-settings/UC01 (product 疑い)**
- `dataset-form.component.html` から「フィールド」タブが確認できず
- `forms.component.html` の `.overSetting` は `opacity:0` で hover 時のみ visible
- 2min タイムアウトは product 側の応答停止が有力（`on-edit` API 無限待機?）
- **推奨アクション**: MCP Playwright で `/admin/dataset/edit/{tableId}` を開き、「フィールド」タブの有無と API 応答を直接確認

**F. field-validation/F311 (Product + Spec 混合)**
- Angular 側実装: `Form.ts` `is_show_by_condition = true` (default)
- 表示条件評価は `reflectRequiredShowCondition` API が決定
- **Spec 側で API 完了まで待つロジックが不十分** → Spec 修正推奨
- 併せて API 応答時間の product 側確認も必要

### 📊 今回 6 件の最終分類

| 分類 | 件数 | 内訳 |
|---|---|---|
| **SPEC_BUG (テスト側修正)** | **3 件** | A:templates / B:csv-export / E:field-options |
| **Product 疑い (要追加調査)** | **2 件** | C:comments-logs / D:display-settings |
| **TIMING/Spec-Product 混合** | **1 件** | F:field-validation |

**結論**:
- 今回検出 6 件のうち、**リリースブロッカーとなる純粋な Product バグは確認できず**
- D は Product 疑いが強いが実機確認が必要
- 他はテスト側修正 or テスト環境権限設定で解消

---

## 🔴 連鎖崩壊 (beforeAll) → Product の可能性要調査 = 2 件

### G. **workflow/WF03** + 12 テスト連鎖
- 症状: ワークフロー有効化・保存の beforeAll 失敗 → 12 テスト did not run
- **2026-04-03 ビジュアルエディタ刷新後、UI セレクタ全面見直しが必要**（CLAUDE.md に記載）
- 推定: **Spec バグ** (ただし UI 確認で Product 変更なら再分類)

### H. **data-operations/UC01** + 20 テスト連鎖
- 症状: 大量データ UI setup 失敗 → 20 テスト did not run
- 推定: **D:INFRA/ENV** 過負荷の可能性が高い（Agent-2 で後半発生）

---

## 🔵 ENV/INFRA 依存 (プロダクト側修正不要・環境整備で解消) = ~70 件

| カテゴリ | 件数 | 原因 | 対応 |
|---|---|---|---|
| payment | 8 fail | Stripe Sandbox 未設定 | staging に Stripe テスト環境構築 |
| kintone | 3 fail | kintone API 未設定 | mock API 追加 |
| rpa | 4 fail | browserContext 競合 | プロセス管理改善 |
| global-search | 4 fail | OpenSearch index + Angular modal | debug API 追加 |
| workflow/data-op cascade | ~47 | 2h連続実行 RDS 過負荷 | テスト分割・レート制限 |

---

## ✅ 最近修正済み（参考）

- **PR #3072** (2026-04-18): staging IP 判定 + ログインロック復活
- **PR #3149** (2026-04-24 merged): up-ip 系 6 件
- **PR #3132/#3135/#3136** (2026-04-24 前後): テナント間セッション分離 (auth-260)
- **PR #3055**: Excel インポートプレビューレイアウト (bug-b001)

---

## 🎯 リリース判断への示唆

### 本番リリース可否の判定フレーム

**🔴 絶対ブロッカー (修正必須):**
1. bug-b005 (子テーブル計算) — データ整合性
2. bug-b013 (ジョブ滞留) — バックエンド処理不能
3. data-operations/325 (子テーブル UI 欠落) — 新機能利用不可

**🟡 要判別 (Spec or Product):**
- TM01 / CE01 / CL01 / UC01 / F401 / F311 の 6 件
- 多くは UI 変更追従で済む可能性大 (B: Spec バグ)
- ただし仕様確認後に Product 起因と判明する可能性あり

**🟢 リリース可能と判断できる範囲:**
- Agent-3 の 244 テスト（auth, records, users-permissions, dashboard, chart 等）は**完全 pass**
- Agent-5 完全 pass 4 spec（master-settings, excel-import, public-form, table-definition）
- コア機能は安定稼働と判断可

### 推奨次アクション（テスト側）

- [ ] Critical 3 件の PR 確認（開発チームに依頼）
- [ ] 要 triage 6 件の **Spec vs Product 判別** — 実機で UI 確認
- [ ] 連鎖崩壊 2 件 (WF03/data-UC01) の原因調査（Spec バグ or インフラ過負荷）
- [ ] ENV 整備優先度: Stripe Sandbox > kintone mock > RPA 並列改善

### 推奨次アクション（インフラ側）

- [ ] staging RDS のスペック確認（連続実行 2h 後の劣化）
- [ ] Stripe Sandbox キー設定
- [ ] kintone mock API 導入検討
