# E2Eテスト パイプライン

## フロー（3ステップ）

```
① テスト内容チェック (/check-yaml)
   yaml品質・網羅性をpigeon repo + Playwright MCPで確認
   → OK → DBに ①✅

② テスト修正くん (/spec-create)
   yaml通りにspec.jsを実装・修正（MCP Playwright必須）
   → OK → DBに ②✅
   → yamlが間違っていたら①に差し戻し

③ チェックくん (/check-run)
   Playwright実行 + 問題あれば差し戻し
   → PASS → DBに ③✅
   → FAIL(specバグ) → ②に差し戻し
   → FAIL(プロダクトバグ) → product-bugs.mdに記録
   → FAIL(環境依存/一時的な遅さ) → 再実行（差し戻しにしない）
```

## 前工程変更時のルール

**前工程を変更したら、後工程は全てリセット。**

| 変更対象 | リセットされる工程 |
|---------|-----------------|
| yaml変更 | ② spec実装 → ③ 実行確認 を全てリセット |
| spec.js変更 | ③ 実行確認 をリセット |

## チェックDB（Single Source of Truth）

E2Eビューアーと同じ方式（DynamoDB + API）でチェック状況を管理する。
mdファイルではなくDBが正。各agentはAPIでステータスを読み書きする。

### テーブル構造

```
pipeline-checks テーブル
- PK: spec#case_no (例: "auth#1-1")
- yaml_check: "ok" | "ng" | null
- yaml_check_note: string (備考)
- spec_check: "ok" | "ng" | null
- spec_check_note: string
- run_check: "pass" | "fail_spec" | "fail_product" | "fail_env" | null
- run_check_note: string
- updated_at: timestamp
- updated_by: string (agent名)
```

### API

```
GET  /pipeline?spec=auth          → そのspecの全ケースのチェック状況
POST /pipeline                    → ステータス更新
GET  /pipeline/summary            → 全体サマリー（①②③のOK/NG/未チェック件数）
```

→ **チェックDB作成は別途実施**。それまでは `.claude/pipeline-status.md` をフォールバックとして使用。

## 既存PASSの扱い

直近のテスト実行でPASSしているケースは ①②③ を一括✅にする。
failed/skipのケースのみ①からチェックし直す。

## エージェント体制

| キャラ | スキル | 役割 |
|---|---|---|
| **リーダー** | `/e2e` | パイプライン管理、テスト実行（npx playwright直接）、集計、通知 |
| **テスト内容チェック** | `/check-yaml` | yaml品質・網羅性チェック（pigeon repo + Playwright MCP参照） |
| **テスト修正くん** | `/spec-create` | yaml通りにspec.jsを実装・修正（MCP Playwright必須） |
| **チェックくん** | `/check-run` | Playwright実行 + failed振り分け + 差し戻し |
| **不具合調査くん** | — | 障害・PRからyaml追加→DB更新→知見md |
| **詳細調査くん** | — | インフラ根本原因調査（CloudWatch/ECS/RDS） |

## テスト環境

- `create-trial` API に `with_all_type_table: true` を渡す（stagingデプロイ済み）
- global-setup.js でテナント作成 + ALLテストテーブル作成を1回で完了
- 各specは `getAllTypeTableId(page)` でID取得のみ（テーブル作成しない）
- `deleteAllTypeTables` は呼ばない（共有テーブルを壊さない）

## 完了条件

全ケースの①②③が ✅ or ⚠️SKIP（外部依存）になること。
❌と空欄が0になること。
