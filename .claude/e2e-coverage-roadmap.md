# E2E カバレッジ拡充ロードマップ

作成日: 2026-04-18
背景: Slack #テスト-staging で報告される実ユーザーバグを E2E で先に検知できていない（直近16件のバグのうち E2E で具体検知できていたのは 1件/6%）。カバレッジを段階的に拡充する計画。

参考ファイル:
- `/tmp/bug-catalog.json` — Slack報告バグ16件の構造化
- `/tmp/coverage-all.json` — 各バグに対する既存 E2E カバレッジ判定
- `/tmp/gap-patterns.md` — ギャップの 5パターン分類

---

## 🔴 短期 (今週〜今月)

### S1. not_covered 6件の即 spec 追加
対象バグ: B001 (Excel列はみ出し), B002 (IP制限), B005 (子テーブル計算), B007 (kintone移行), B012 (kintoneログ), B013 (ジョブログ)
- yaml → spec.js まで gemcli 並列で一気に作成
- プロダクト側が未修正のバグはテストを fail のまま残し `.claude/product-bugs.md` に記録

### S2. partial 9件の assertion 強化
対象: B003, B004, B006, B008, B010, B011, B014, B015, B016
- UI存在確認 → **業務ロジック検証** への書き換え
- 例: B008 帳票DL → ボタン存在ではなく「PDF/Excelが実ダウンロード」を検証

### S3. "Shallow UI Check" 自動検出
- 既存 spec.js を静的解析して以下を flag:
  - `test.step` 内が `toBeVisible()` だけで終わっている
  - `navbar` / `Internal Server Error` チェックしかない
  - assertion が 1個未満
- CI で lint エラーとして落とす

### S4. product-bugs.md を Slack と同期
- Slack報告 → 自動で product-bugs.md に追記
- 修正 PR マージ時に自動クローズ

---

## 🟡 中期 (今月〜3ヶ月)

### M1. カバレッジダッシュボード
sheet.html に「Slack報告バグ vs E2E検知率」メトリクス追加。「カバレッジ80%以上」を SLA化。

### M2. シナリオベース spec の導入
機能単位 → 業務シナリオ単位の spec 追加:
- `scenario-sales-flow.spec.js` (商談登録→承認→帳票出力→メール送信)
- `scenario-user-onboarding.spec.js` (テーブル作成→ユーザー追加→権限設定→ログイン確認)

detailedFlow に「観点セクション」義務化（Shallow 防止）

### M3. Slack バグ報告 → yaml 自動提案 bot
- #テスト-staging 新規投稿を watch
- gemcli で yaml を自動生成 → PR Draft 提出
- **SLA**: バグ報告 → テスト追加を 48h 以内

### M4. テスター操作の自動記録基盤
- ブラウザ拡張で QA の操作ログ自動記録
- 週次で gemcli 変換 → spec 案

### M5. 定期 E2E batch の日次実行 + 新規 fail を Slack 通知
- GitHub Actions で毎朝 6:00 に 30 spec 実行
- 新規 fail のみ Slack 通知

---

## 🟢 長期 (3-12ヶ月)

### L1. "テスター行動 → テストコード" 自動化パイプライン
手動テストを Playwright が常時監視、AI が新規判定 → spec.js 提案

### L2. バグ発見前予測 (Shift-left QA)
PR の影響範囲 AI 解析。関連 spec 不足なら CI ブロック。

### L3. ビジュアルリグレッション導入
Percy/Chromatic 等でスクショ diff 自動検知。

### L4. プロダクト側の型安全化・Feature Flag 化
バグ多発領域を型システム再設計。Feature Flag で段階 rollout。

### L5. QA フィードバックループの KPI 化
「Slack報告 → E2E追加」時間、「バグ再発率」、「検知率」を月次可視化。

---

## 優先度・推奨スタート

- **Week 1**: S3 (Shallow検出) → CI で封じる
- **Week 2**: S1+S2 (16件を100%カバー)
- **Week 3-4**: M5 (日次batch) + M3 (Slack→yaml bot PoC)
- **月次**: 進捗レビュー → L1 着手

---

## 注意事項

- **プロダクトバグを見つけたらテストは fail のまま残す**。assertion を緩めない。`.claude/product-bugs.md` に記録する
- **gemcli を積極的に使う**（並列5件程度までOK）。主役は Claude（レビュー・統合）、下請けは Gemini（grep・read・修正）
- **テスト新規追加時の品質チェック**: `.claude/knowledge-spec-quality-checklist.md` の全項目を守る
