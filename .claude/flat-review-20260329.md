# PigeonCloud E2Eテスト フラットレビュー結果 (第2回)

**レビュー日**: 2026-03-29
**前回レビュー**: 2026-03-28

---

## 前回からの改善サマリー

| 指摘項目 | 前回 | 今回 | 改善度 |
|---------|------|------|--------|
| URL残り | 279件 | 8件 | 97%改善 |
| 「想定通り」 | 374件 | 98件 | 74%改善 |
| feature空 | 538件 | 247件 | 54%改善 |
| spec.js実装数 | 1,279件 | ~1,527件 | +248件 |
| uncategorized割合 | 37.3% (793/2123) | 26.9% (529/1967) | 改善 |

---

## 1. テスト一覧（YAML）の品質

### 1-1. [致命的] case_noの大量重複（550件、余分602件）

前回から**未解消**。1,967件中、ユニークcase_noは1,365件しかない。

特に深刻な構造的重複:

| 重複パターン | 重複件数 | 性質 |
|-------------|---------|------|
| fields-2 ⊂ fields | 41件(全件) | fields-2の全case_noがfieldsに含まれる |
| fields-3 ≈ fields | 143/144件 | ほぼ完全重複 |
| notifications-2 ⊂ notifications | 42件(全件) | notifications-2の全case_noがnotificationsに含まれる |
| chart-calendar-2 ⊂ chart-calendar | 36件(全件) | 完全サブセット |
| uncategorized-2 ∩ uncategorized | 59件 | 部分重複 |
| uncategorized-3 ∩ uncategorized | 85件 | 部分重複 |
| uncategorized-2 ∩ uncategorized-3経由uncategorized | 多数 | 3ファイルに重複するケースが51件 |

**問題**: fields-2/3、notifications-2、chart-calendar-2は、元ファイル(fields/notifications/chart-calendar)から分割して作成されたが、元ファイル側のcase_noが削除されていない。これにより:
- sheet.htmlに同一テストが2-3行表示される
- パイプラインの進捗集計が水増しされる
- 結果の紐付けが不正確になる

**対策**: 分割先に移したcase_noは元ファイルから削除する。または、分割ファイル自体を廃止して元ファイルに統合する。

### 1-2. [高] URL残り 8件（前回279件 → 97%改善）

大幅改善。残り8件:
- chart-calendar.yaml: case 260
- csv-export.yaml: case 255
- filters.yaml: case 244
- notifications.yaml: case 298
- reports.yaml: case 253
- table-definition.yaml: case 258, 259
- workflow.yaml: case 296

**対策**: 残り8件をraw_queryで内容取得してテストフローに変換する。

### 1-3. [高] 「想定通り」残り 98件（前回374件 → 74%改善）

改善したが、まだ98件残存。内訳:
- fields.yaml: 27件
- chart-calendar.yaml: 17件
- layout-ui.yaml: 11件
- table-definition.yaml: 9件
- workflow.yaml: 9件
- chart-calendar-2.yaml: 4件
- その他: 21件

**対策**: 残り98件のexpectedを具体的な検証条件に書き換える。

### 1-4. [高] description = expected 同一文言 115件

description（手順）とexpected（期待結果）が完全に同一のケースが115件。
主に分割先ファイルに集中:
- chart-calendar-2.yaml: 35件
- notifications-2.yaml: 32件
- fields-5.yaml: 13件
- fields-3.yaml: 7件
- dashboard.yaml: 5件
- payment.yaml: 6件
- rpa.yaml: 5件
- templates.yaml: 5件

これらは「何が起きるべきか」の記述のみで、「どう操作するか」の手順がない。

**対策**: descriptionに操作手順を記述し、expectedは検証条件に特化させる。

### 1-5. [中] feature空 247件（前回538件 → 54%改善）

改善したが、まだ247件が機能名なし。内訳:
- fields.yaml: 40件
- users-permissions.yaml: 36件
- workflow.yaml: 30件
- chart-calendar.yaml: 27件
- table-definition.yaml: 23件
- csv-export.yaml: 19件
- filters.yaml: 19件
- その他: 53件

**対策**: descriptionの内容から機能名を推定して埋める。

### 1-6. [中] expected空 17件

expected（期待結果）が空のケースが17件。

- workflow.yaml: 6件
- fields.yaml: 4件
- notifications.yaml: 2件
- table-definition.yaml: 2件
- csv-export.yaml: 1件
- filters.yaml: 1件
- public-form.yaml: 1件

**対策**: 全17件のexpectedを記述する。

### 1-7. [中] 短すぎる / 不明な expected

- fields.yaml: case 63-8, 63-9 → expected が「？？？」
- system-settings.yaml: case 9-7/8/9 → description が10文字未満

**対策**: 内容を具体化する。

### 1-8. [低] 認証情報直書き 30件（前回199件から改善）

本番/テスト環境のURL・パスワードがyaml内に残っているケースが30件。

---

## 2. spec.js の品質

### 2-1. [致命的] uncategorized系のcheckPage主体テスト（72%が実質スモークテスト）

新規実装の品質に**深刻な問題**がある。

| specファイル | テスト数 | checkPage主体 | 割合 |
|-------------|---------|-------------|------|
| uncategorized.spec.js | 238 | 158 | 66% |
| uncategorized-2.spec.js | 132 | 84 | 63% |
| uncategorized-3.spec.js | 119 | 111 | **93%** |
| **合計** | **489** | **353** | **72%** |

`checkPage()` は「ページにアクセスして500エラーが出ないことを確認する」だけの関数。例:

```javascript
// テスト名: 「ユーザーテーブルから他テーブル参照のルックアップが正常に機能すること」
// 実際の実装:
await checkPage(page, '/admin/user');
const errors = await page.locator('.alert-danger').count();
expect(errors).toBe(0);
// → ルックアップの動作を一切確認していない
```

テスト名が「XXXが正常に機能すること」と具体的な検証を示唆しているにもかかわらず、実際には「ページが開くこと」しか確認していない。これは CLAUDE.md の「テスト品質チェックリスト」の項目1「タイトルとテスト内容が合致している」に完全に違反している。

**影響**: 353件が「PASS」になっても、実際にはページが開くことしか確認できておらず、テストカバレッジとして機能していない。

**対策**: 以下の優先度で修正:
1. テスト名を「XXXページが正常に表示されること」に改名して実態に合わせる（応急措置）
2. yamlのdescriptionに具体的な操作手順がある場合は、それに沿ったテスト実装に書き換える（本質的修正）
3. 具体的な操作手順がないケースは、yaml側を先に整備する

### 2-2. [高] yaml-spec件数乖離 440件

yamlに定義があるがspec.jsに未実装のケースが440件。
重複を除くと実質的なギャップは小さい可能性があるが、管理上把握が困難。

主な乖離:
| spec | yaml件数 | spec件数 | 差分 | 備考 |
|------|---------|---------|------|------|
| fields | 297 | 83 | -214 | fields-2/3/4/5で分割実装済み（重複含む） |
| uncategorized | 278 | 238 | -40 | |
| chart-calendar | 89 | 53 | -36 | chart-calendar-2で分割実装済み（重複含む） |
| workflow | 113 | 76 | -37 | |
| notifications | 118 | 88 | -30 | notifications-2で分割実装済み（重複含む） |
| users-permissions | 111 | 84 | -27 | |

重複を考慮した実質乖離は推定150-200件程度。

### 2-3. [高] workflow.spec.js のアサーション不足

workflow.spec.jsは76テスト中26件（34%）がexpect 0-1件。
特に111系（一括承認/否認/削除/取り下げ）の16テストは、操作は行っているがアサーションが弱い。

### 2-4. [中] test.skip 37件の妥当性

| specファイル | skip数 | 主な理由 |
|-------------|--------|---------|
| table-definition | 23 | 複数ユーザー操作/時間待機/複雑な前提条件 |
| system-settings | 5 | SMTP未設定/PayPal廃止/Stripe/freee |
| payment | 4 | Stripe設定なし |
| layout-ui | 2 | 専用環境/未実装機能 |
| notifications-2 | 1 | 不明 |
| notifications | 1 | 不明 |
| auth | 1 | 不明 |

table-definitionの23件skipは妥当な理由（複数ユーザー同時操作、5分間待機等）。payment/system-settingsも外部サービス依存で妥当。

### 2-5. [中] expect密度の格差

| 区分 | expect/test比 |
|------|-------------|
| 高品質(4.0以上) | auth(6.2), public-form(12.0), fields-4(6.0), comments-logs(5.1), records(4.8), payment(4.5), reports(4.5), dashboard(4.0), users-permissions(4.0) |
| 中品質(3.0-3.9) | chart-calendar(3.0), csv-export(3.8), filters(3.8), rpa(3.8), templates(3.8), layout-ui(3.5), table-definition(3.5), system-settings(3.2) |
| 低品質(2.0-2.9) | fields(2.9), uncategorized(2.6), uncategorized-2(2.6), uncategorized-3(2.5), fields-3(2.1), fields-2(2.1), notifications-2(2.1), workflow(2.0) |
| 要注意(1.x) | chart-calendar-2(1.7) |

chart-calendar-2のexpect/test比1.7は最低レベル。

### 2-6. [低] fields-5.spec.js の動的テスト生成

fields-5.spec.jsは `for...of` ループでFIELD_TYPES配列（13件）からテストを動的生成している。
grep集計では「0件」に見えるが、実行時は13件のテストが生成される。
**問題ではないが、集計ツール（upload_specs.py等）が正しくカウントしているか確認が必要。**

---

## 3. チェックシート（sheet.html）

### 3-1. [中] データ0件表示

WebFetchで確認した時点では「0件表示」。認証（localStorage）が必要なため、未ログイン状態ではデータが表示されない。これ自体は正常動作。

**前回指摘の「パイプライン進捗が初回表示時に全て0表示」は解消確認できず（認証壁のため）。**

### 3-2. [中] case_no重複によるデータ整合性の問題

sheet.htmlがyamlから初期化される場合、重複case_noにより:
- 同一テストが複数行に表示される
- 進捗集計が水増しされる（実質1,365件なのに1,967件でカウント）
- ステータス編集時にどの行を編集すべきか混乱する

**対策**: yaml側の重複解消が先決。sheet.html側ではcase_noとspec名の複合キーで管理する。

### 3-3. [中] 編集データ未保存時のロスト

noteModal（備考編集）で入力中にモーダルを閉じるとデータがロストする可能性。
保存失敗時のロールバック処理もない。

### 3-4. [低] UI改善点

- 未チェック状態の色が薄く視認困難 → カラー強化推奨
- テキスト切れのtooltip → 前回と同じ指摘
- サーバー保存失敗時のリトライ機構がない

---

## 4. テスト構成

### 4-1. [致命的] yaml重複がspec分割と連動していない

現状の分割構造:

```
fields.yaml (297件) ← fields-2/3/4/5の全case_noを含んだまま
  ├── fields-2.yaml (41件) ← fieldsの完全サブセット
  ├── fields-3.yaml (144件) ← fieldsのほぼ完全サブセット
  ├── fields-4.yaml (6件) ← fieldsと重複なし
  └── fields-5.yaml (13件) ← fieldsと重複なし

notifications.yaml (118件) ← notifications-2の全case_noを含んだまま
  └── notifications-2.yaml (42件) ← notificationsの完全サブセット

chart-calendar.yaml (89件) ← chart-calendar-2の全case_noを含んだまま
  └── chart-calendar-2.yaml (36件) ← chart-calendarの完全サブセット
```

**問題**: specファイルは分割されてそれぞれ独立して動作するが、yamlは分割元が整理されていないため、パイプライン管理上の重複が発生。

**対策（推奨）**:
1. **案A: yamlの分割元から分割先case_noを削除**
   - fields.yamlから fields-2/3 に移した case_no を削除 → fieldsは約113件に
   - notifications.yamlから notifications-2 に移した case_no を削除 → notificationsは76件に
   - chart-calendar.yamlから chart-calendar-2 に移した case_no を削除 → chart-calendarは53件に
2. **案B: 分割ファイルを廃止して元ファイルに統合**（specの巨大化が問題になる可能性）

### 4-2. [高] uncategorized系がまだ529件（26.9%）

前回793件から529件に減少したが、まだ全体の27%を占める。

uncategorized系のfeature分布を見ると、既存カテゴリに振り分け可能:

| feature（uncategorized内） | 件数 | 振り分け先 |
|---------------------------|------|-----------|
| テーブル設定/テーブル一覧 | 56 | table-definition |
| フィールド設定 | 19 | fields |
| ワークフロー/ワークフロー設定 | 24 | workflow |
| 通知設定 | 18 | notifications |
| CSV/CSV操作 | 30 | csv-export |
| ユーザー管理 | 17 | users-permissions |
| カレンダー | 12 | chart-calendar |
| 計算項目 | 15 | fields |
| 他テーブル参照 | 12 | fields |
| 集計 | 12 | chart-calendar |
| フィルタ | 12 | filters |
| レコード操作 | 9 | records |
| 帳票/帳票設定 | 8 | reports |
| 公開フォーム | 5 | public-form |
| 関連レコード一覧 | 8 | records |
| ダッシュボード | 7 | dashboard |
| ルックアップ | 3 | fields |
| 権限設定 | 4 | users-permissions |
| レイアウト | 2 | layout-ui |
| (空)/その他 | ~256 | 要分類 |

### 4-3. [中] spec.jsの巨大ファイル

| specファイル | 行数 | テスト数 |
|-------------|------|---------|
| table-definition.spec.js | 5,115 | 139+23skip |
| uncategorized.spec.js | 3,858 | 238 |
| chart-calendar.spec.js | 3,214 | 53 |
| users-permissions.spec.js | 3,168 | 84 |
| workflow.spec.js | 3,055 | 76 |
| notifications.spec.js | 2,871 | 87 |

5,000行超のspec.jsは保守が困難。table-definitionは特に巨大。

### 4-4. [低] 28ファイルの構成

ファイル数自体は前回と同じ28個で概ね妥当。ただし前述の重複問題を解消すれば、20-22個に整理可能。

---

## 5. 前回指摘の解消状況

| # | 前回指摘 | 優先度 | 状況 | 備考 |
|---|---------|--------|------|------|
| 1-3 | case_no重複 720グループ | 高 | **未解消** | 550件に減少したが構造的問題は同じ |
| 1-4 | URLだけのテスト 279件 | 高 | **ほぼ解消** | 8件に減少(97%改善) |
| 1-5 | 「想定通り」374件 | 高 | **改善中** | 98件に減少(74%改善) |
| 2-1 | uncategorized 793件 | 高 | **改善中** | 529件に減少(33%改善) |
| 2-2 | desc=expected同一 | 高 | **一部解消** | 115件残存 |
| 1-2 | Staging/Main結果未実施 | 高 | **確認不能** | 認証壁のため |
| 1-6 | 内容空の行 222件 | 中 | **確認不能** | yaml上はempty_desc=0 |
| 1-7 | 認証情報直書き | 中 | **改善** | 199件→30件 |
| 2-4 | case_no命名不統一 | 中 | **未解消** | 対応なし |
| 2-6 | yaml-spec乖離 844件 | 中 | **改善** | 440件に縮小 |
| 4-2 | fields系分割の不明確さ | 中 | **未解消** | 重複が追加で判明 |

---

## 優先度サマリー

### 致命的（即時対応必須）

| # | 項目 | 影響 |
|---|------|------|
| 1-1 | yaml case_no重複 550件(余分602件) | パイプライン集計が不正確。テスト管理の信頼性が崩壊 |
| 2-1 | checkPage主体テスト 353件(72%) | PASS表示されるが実質テストしていない。偽のカバレッジ |
| 4-1 | yaml重複がspec分割と未連動 | 重複の根本原因。分割元yamlの整理が未完了 |

### 高（1-2週間以内に対応）

| # | 項目 | 影響 |
|---|------|------|
| 1-2 | URL残り 8件 | 小規模だが完了させるべき |
| 1-3 | 「想定通り」残り 98件 | assertionが書けない |
| 1-4 | desc=expected同一 115件 | テスト手順不在 |
| 2-2 | yaml-spec乖離 440件 | 実装漏れ把握困難 |
| 2-3 | workflow アサーション不足 | 操作はしているが検証が弱い |
| 4-2 | uncategorized 529件 | テスト管理の可読性低下 |

### 中（計画的に対応）

| # | 項目 | 影響 |
|---|------|------|
| 1-5 | feature空 247件 | 機能別集計が不正確 |
| 1-6 | expected空 17件 | テスト定義不完全 |
| 2-4 | skip 37件 | 大半は妥当だが定期レビュー推奨 |
| 2-5 | expect密度格差 | chart-calendar-2等の品質向上 |
| 3-2 | sheet case_no重複 | yaml解消に連動 |
| 3-3 | 編集データロスト | UX改善 |
| 4-3 | 巨大spec.js | 保守性 |

### 低

| # | 項目 | 影響 |
|---|------|------|
| 1-7 | 短すぎるdesc/expected | 数件のみ |
| 1-8 | 認証情報直書き 30件 | セキュリティ（テスト環境のみ） |
| 2-6 | fields-5動的生成の集計 | ツール側対応 |
| 3-4 | sheet UI改善 | UX |

---

## 総括

前回レビューから大幅な改善が見られる。特にURL残り(279→8件)、「想定通り」(374→98件)、feature空(538→247件)、spec実装数(1279→1527件)は顕著な進歩。

しかし、**3つの致命的問題**が浮き彫りになった:

1. **yaml case_no重複**: spec分割時に元ファイルのcase_noが削除されておらず、1,967件中602件が重複による水増し。実質1,365件。パイプライン管理の信頼性を根本的に損なう。

2. **checkPage主体テスト**: 新規実装221件の大部分を含むuncategorized系489テスト中353件(72%)が「ページが開くこと」しか確認しない実質スモークテスト。テスト名が示す検証内容と実装が乖離しており、偽のテストカバレッジになっている。

3. **yaml-spec分割の不整合**: fields/notifications/chart-calendarの分割ファイルがyaml側で未整理のまま。

**推奨対応順序**:
1. yaml重複の解消（分割元からcase_noを削除）→ これだけで602件の水増しが解消
2. checkPage主体テスト353件のテスト名を実態に合わせて修正（応急措置）
3. 「想定通り」98件 + desc=expected 115件の具体化
4. uncategorized 529件の機能別再分類
5. checkPage主体テストの本格実装（yaml手順の具体化と連動）
