# PigeonCloud E2Eテスト自動化の取り組み

> 作成日: 2026-03-12
> 更新日: 2026-03-12
> 対象: 社内エンジニア・QAチーム向け

## 概要

PigeonCloud（社内SaaS）の品質担保を目的に、Playwrightを使ったE2Eテスト（エンドツーエンドテスト）の完全自動化を実施しました。特徴は「**AI（Claude Code）がDockerコンテナの中でテストを自律的に実行・修正する**」という仕組みです。従来のように人がひとつひとつテストを手動実行・修正するのではなく、AIエージェントが失敗を検知して自分でコードを直し、再実行するというサイクルを回します。約500件のテストケースを並列4台で6時間以内に完走しました。

さらに、**コミットを監視して自動でテストを追加・修正する仕組み**も構築しました。新機能のコミットが来れば対応するspecにテストを追加し、UI変更のコミットがあればセレクターを自動修正します。`/e2e` スキル一発でパイプライン全体を実行でき、完了後はSlack通知と Google Sheets の自動更新まで行います。

---

## 1. 全体アーキテクチャ

```mermaid
flowchart TD
    GIT[🔀 git commit\nfeat/fix/refactor...] -->|/e2e-watch が検知| WATCH{差分あり？}
    WATCH -->|なし| SKIP[スキップ\n前回と同じ]
    WATCH -->|あり| PIPELINE

    PIPELINE[/e2e パイプライン起動]

    PIPELINE --> S1[Step 1\n最新コミット分析\nテスト追加/修正要否判断]
    S1 --> S2[Step 2\nspec追加・修正\n必要な場合のみ]
    S2 --> S3[Step 3\nDockerエージェント起動\n並列4台]

    S3 -->|agent-A| E1[🤖 Claude Code\nエージェントA\nlayout-ui/system-settings\ntable-definition/reports/records]
    S3 -->|agent-B| E2[🤖 Claude Code\nエージェントB\nnotifications/users-permissions/auth]
    S3 -->|agent-C| E3[🤖 Claude Code\nエージェントC\nworkflow/uncategorized]
    S3 -->|agent-D| E4[🤖 Claude Code\nエージェントD\nchart-calendar/fields/filters\ncomments-logs/csv-export/public-form]

    E1 & E2 & E3 & E4 -->|自律修正ループ| LOOP[失敗ログ確認\n→ specを自動修正\n→ 再実行]
    LOOP --> DONE[全件完了]

    E1 -->|自動生成テナント| F1[🌐 tmp-testai-AAAA\n.pigeon-demo.com]
    E2 -->|自動生成テナント| F2[🌐 tmp-testai-BBBB\n.pigeon-demo.com]
    E3 -->|自動生成テナント| F3[🌐 tmp-testai-CCCC\n.pigeon-demo.com]
    E4 -->|自動生成テナント| F4[🌐 tmp-testai-DDDD\n.pigeon-demo.com]

    DONE --> S5[Step 5\n動画整理・Drive upload\nfailed/passedのみ]
    DONE --> S6[Step 6\n結果集計\nresults.json]
    S5 & S6 --> S7[Step 7\nSlack通知\nGoogle Sheets更新]

    style GIT fill:#f9f,stroke:#333
    style S7 fill:#9f9,stroke:#333
    style S3 fill:#99f,stroke:#333
    style LOOP fill:#ff9,stroke:#333
```

---

## 2. テストスペック生成フロー（スライド → YAML → spec）

QA仕様書（スライド）を起点に、テストコードを自動生成します。

### ステップ1: YAMLシナリオ化

QA仕様書に記載されたテストシナリオを YAML ファイルに整理します。スライド上の「操作手順」と「期待結果」を構造化データとして書き起こし、Google SheetsのどのセルのQA項目に対応するかも記録します。

```yaml
# scenarios/workflow.yaml の例
- id: WF-001
  title: ワークフロー申請の送信
  steps:
    - action: navigate
      url: /workflow/apply
    - action: fill
      selector: "#title"
      value: "テスト申請"
    - action: click
      selector: "button[type=submit]"
  expected: "申請完了メッセージが表示される"
  _sheet_gid: 12345
  _sheet_row: 42
```

### ステップ2: Playwrightスペックへの変換

Claude Code が YAML をもとに Playwright の `spec.js` ファイルを生成します。YAMLの操作ステップを Playwright API（`page.fill()`, `page.click()`, `expect()` など）に変換します。

### カバーしているスペックの種類（16種）

| カテゴリ | 内容 |
|----------|------|
| auth | ログイン・ログアウト・認証 |
| fields | フィールド定義・入力バリデーション |
| records | レコードのCRUD操作 |
| workflow | ワークフロー申請・承認 |
| notifications | 通知・リマインダー |
| users-permissions | ユーザー管理・権限設定 |
| chart-calendar | グラフ・カレンダー表示 |
| filters | 絞り込み・ソート |
| layout-ui | 画面レイアウト・UI確認 |
| system-settings | システム設定 |
| table-definition | テーブル・DB定義 |
| reports | レポート出力 |
| comments-logs | コメント・操作ログ |
| csv-export | CSV出力 |
| public-form | 公開フォーム |
| uncategorized | その他 |

---

## 3. Claude Code × Docker の仕組み

### なぜDockerに閉じ込めるのか

Claude Code（AIエージェント）に「テストを直してください」と指示すると、ファイルを読み書きしたりターミナルコマンドを実行したりします。これを直接ローカルで動かすと環境が汚染されたり、複数エージェントが干渉したりします。**Dockerコンテナ1つ = AIエージェント1台**として独立させることで、並列実行と再現性を両立しています。

### エージェントの自律実行サイクル

```
[テスト実行]
    ↓ 失敗が出た場合
[失敗ログ・スタックトレースを読む]
    ↓
[specファイルを修正]（セレクター変更、タイムアウト調整など）
    ↓
[再実行]
    ↓ 全件通過まで繰り返す
[結果をGoogle Sheetsに書き込み]
```

人が介入しなくても、AI が「なぜ失敗したか」を自分で判断してコードを修正します。

### docker-compose.yml の構成

```yaml
# 並列4台の例
services:
  agent-20:
    image: pigeon-test-agent
    environment:
      - AGENT_ID=20
      - TEST_SPECS=auth,fields,records,workflow
  agent-21:
    image: pigeon-test-agent
    environment:
      - AGENT_ID=21
      - TEST_SPECS=notifications,users-permissions,chart-calendar,filters
  # ... 以下同様
```

各エージェントは起動時に専用テスト用テナント（`tmp-testai-XXXXXX.pigeon-demo.com`）を自動生成し、テスト完了後に破棄します。

---

## 4. `/e2e` スキルによる全自動パイプライン

Claude Code に `/e2e` と入力するだけで、以下の7ステップが全自動で実行されます。

### サブコマンド一覧

| コマンド | 動作 |
|---------|------|
| `/e2e` | フルパイプライン（Step 1〜7） |
| `/e2e run [spec]` | 指定specのみ実行（Step 3〜7） |
| `/e2e fix [spec]` | 指定specをrepair_specsモードで修正 |
| `/e2e todo [spec]` | `test.skip(true, 'todo')` を実装 |
| `/e2e status` | 実行中エージェントの状況確認 |
| `/e2e results` | 結果集計のみ（Step 6〜7） |
| `/e2e results --push` | 結果集計 + Google Sheets更新 |

### Step 1: 最新コミット分析

```bash
git -C src/pigeon_cloud log --oneline -10
git -C src/pigeon_cloud diff HEAD~5..HEAD --name-only
```

コミットメッセージと変更ファイルから「テスト追加が必要か」「spec修正が必要か」「何もしなくてよいか」を判断します。

| コミットタイプ | 対応 |
|-------------|------|
| `feat:` / `add:` 新機能 | 対応するspecにテストを追加 |
| `fix:` / `refactor:` UI変更 | セレクター・期待値を確認・修正 |
| `docs:` / `style:` | テスト変更不要 |

### Step 2: spec追加・修正（必要な場合のみ）

- `Application/Class/Workflow*.php` の変更 → `workflow.spec.js` を修正
- `html_angular4/src/app/notification/` の変更 → `notifications.spec.js` を修正
- `test.skip(true, 'todo')` は使わず、必ず実装する

### Step 3〜7: Docker並列実行 → 監視 → 動画 → 集計 → 通知

エージェント4台を並列起動し、全完了後にGoogle Driveへ動画アップロード、Slack通知（失敗テストのサマリー付き）を送信します。

```
<@U869KKT8C> 【PigeonCloud E2E】自動テスト完了

📊 結果サマリー
✅ passed: 299件
❌ failed: 0件
⏭ skipped: 193件（環境依存・todo）

🔗 Google Sheets: https://docs.google.com/spreadsheets/d/...
🎬 エラー動画: https://drive.google.com/drive/folders/...
📅 実行日時: 2026-03-12 15:00 JST
🌿 コミット: abc1234 feat: ワークフロー高度設定追加
```

---

## 5. `/e2e-watch` によるコミット差分監視

`/e2e-watch` は前回テストしたコミットと現在のコミットを比較し、差分がある場合のみ `/e2e` を実行します。

```bash
LAST=$(cat reports/.last_tested_commit 2>/dev/null || echo "")
CURRENT=$(git -C src/pigeon_cloud rev-parse HEAD)

if [ "$LAST" = "$CURRENT" ]; then
  echo "変更なし（$CURRENT）- テストスキップ"
  exit 0
fi

# → /e2e フルパイプラインを実行
echo "$CURRENT" > reports/.last_tested_commit
```

`--force` オプションで差分チェックをスキップして強制実行できます。将来的にはCI/CDのフックとして組み込み、PR マージ時に自動で起動する想定です。

---

## 6. DB dump/import による複雑な前提条件の再利用

複数ユーザー・特定の承認フロー・SMTP設定など、セットアップに時間がかかる前提条件は、DBダンプを保存して再利用します。

```javascript
// DBダンプ保存
const dumpResp = await page.request.get(BASE_URL + '/admin/debug-tools/dump');
const sql = await dumpResp.text();
const fs = require('fs');
fs.writeFileSync('/tmp/snapshot.sql', sql);

// DBリストア（各テスト前に呼ぶ）
const sqlContent = fs.readFileSync('/tmp/snapshot.sql');
await page.request.post(BASE_URL + '/admin/debug-tools/import', {
    multipart: { file: { name: 'restore.sql', mimeType: 'text/plain', buffer: sqlContent } }
});
```

**使い分けの原則**:
- UIで1回だけ複雑なセットアップを行い、ダンプを保存 → 以降は各テスト前にリストア
- 単純なページアクセス確認で通るテストにはダンプを使わない（無駄なオーバーヘッドを避ける）

---

## 7. テスト動画の録画・管理

### 録画方針

`playwright.config.js` の `video: 'retain-on-failure'` 設定により、**失敗したテストのみ動画を保存**します。成功動画は保存しません（ストレージ節約）。

### Google Drive へのアップロード

```
Google Drive フォルダ構造:
E2Eテスト/
  └── 2026-03-12/
        ├── workflow/
        │     └── 106-02.webm
        └── notifications/
              └── 6-1.webm
```

動画が50件を超える場合は failed のみアップロード（passed は省略）。

---

## 8. 実績数値

| 項目 | 数値 |
|------|------|
| 対象スペック数 | 16種類 |
| テストケース総数 | 約500件 |
| passed（通過） | **299件** |
| failed（失敗） | **0件** |
| skipped（スキップ） | 約193件 |
| 並列実行台数 | 4台 |
| 総実行時間 | 約6時間 |

最終的に **failed = 0** を達成。スキップは「技術的に自動化が困難なもの」で、意図的に除外しています（後述）。

---

## 9. 良かった点・注目ポイント

### Claude Codeによる自律修正が想像以上に強力

テスト実行中に Playwright のセレクターが変わっていたり、バイナリのバージョンが一致していなかったりと、さまざまなエラーが発生しました。従来であれば人が1件1件原因を調べて直す作業が必要でしたが、**Claude Codeはエラーログを読んで自分で原因を特定し、specファイルを修正して再実行**します。

実際に自律修正した代表例：
- Chromiumバイナリバージョン不一致 → 自動でバージョン合わせて再インストール
- 動的に変わるセレクター（クラス名変更など）→ より安定した属性に切り替え
- タイムアウト → 適切な待機処理に修正
- ユーザー数上限に達した場合 → graceful skip（エラー扱いにせずスキップ）に変更

### コミット差分からテスト追加を自動判断

`feat:` のコミットが来ると変更されたファイルを解析し、影響を受けるspecを特定してテストを自動追加します。人が「新機能が入ったからテストを書かないと」と気づかなくても、AIが自動で追随します。

### 独立テナントによる競合ゼロ

各エージェントが別々のテナント（サブドメイン）を使うため、エージェント間でデータが干渉しません。並列数を増やすだけでスケールできる設計です。

### スライドからspec生成という発想

「QAのテスト仕様書はスライドで管理している」という現実に合わせた設計です。スライド → YAML → spec という変換フローにより、**仕様書が更新されたらテストも追随できる**仕組みを作れました。

### QA管理シートと一体化

Google Sheetsのどの行がどのテストケースに対応するかを YAML に記録しておくことで、テスト結果が自動でシートに書き戻されます。QA担当者はシートを見るだけで最新の通過率が確認できます。

---

## 10. スキップ（テストできないもの）の種類と理由

約193件をスキップとしています。スキップには3種類あります。

### 種類1: 外部依存・環境制約

| カテゴリ | 理由 |
|----------|------|
| Google OAuth / SAML認証 | 外部IdP（Googleアカウント）との連携が必要で、専用の認証環境が別途必要 |
| 同時ログイン制御 | 契約プランの設定が必要な専用環境でないと再現できない |
| メール受信確認（時間経過系） | 「5分後にリマインダーが届く」のような時間経過を含むテストは実行コストが高い |
| Slack / Webhook通知の確認 | 外部サービス（Slack API等）への依存があり、テスト環境からの到達性が不安定 |
| ユーザー上限系 | テナントのプラン制約によりユーザー追加数に上限があり、上限に達するケースがある |

### 種類2: 未実装（`test.skip(true, 'todo')`）

`test.skip(true, 'todo')` はテストの実装が間に合っていない状態を示します。外部依存とは異なり、**実装すれば通過できる**テストです。agent-24（workflow）・agent-25（uncategorized）がこれらを順次実装中です。

### 種類3: 操作上の困難

ドラッグ＆ドロップ、ファイルアップロード、Ctrl+クリックなど、Playwright での自動化が技術的に困難な操作を伴うテストは、安定した実装方法が確立するまでスキップとしています。

---

## 11. 今後の展開

### 実装済み ✅

- **Claude Codeによる自律修正**: エラーを自分で直して再実行するサイクル
- **並列4台の Docker 実行**: 約6時間で500件完走
- **`/e2e` スキル**: 全自動パイプライン（コミット分析→spec更新→Docker→動画→Sheets→Slack）
- **`/e2e-watch` スキル**: コミット差分監視・差分がある場合のみ自動実行
- **Google Sheets連携**: テスト結果の自動書き戻し
- **動画記録 & Drive アップロード**: 失敗時の動画を自動でDriveに整理

### 今後の課題

1. **CI/CDパイプラインへの組み込み**: PR マージ時に `/e2e-watch` が自動で走る仕組みにすることで、デグレを即検知できる

2. **スキップケースの段階的解消**: メール受信系は時間管理を工夫することで自動化できる可能性がある。Google OAuthもモック環境の整備で対応できる可能性がある

3. **並列数のスケールアップ**: 現在は4台だが、スペック数が増えた場合は8台・16台と容易にスケール可能

4. **視覚的リグレッションテストの追加**: Playwrightのスクリーンショット比較機能を使い、UIの見た目の変化も自動検知する

5. **テスト生成の完全自動化**: 現在はYAML化に人手が一部入っているが、スライドからの変換もAIで自動化することで、仕様書更新 → テスト更新のサイクルをゼロタッチにできる可能性がある

---

## まとめ

「AIがDockerの中でテストを自律実行し、失敗したら自分で直す」という仕組みは、QA工数の大幅削減と品質の安定化を同時に実現しました。約500件のテストケースに対して **failed = 0** を達成できたのは、人の手による修正が限界になるケースでも、AIが24時間止まらずにトライし続けたからです。

さらに `/e2e` スキルと `/e2e-watch` によるコミット差分監視を組み合わせることで、**「コミットを積むだけで自動的にテストが追いついてくる」**という状態を目指しています。今後のCI/CD組み込みで、コードレビューと並行してE2Eテストが自動で走る体制が完成します。
