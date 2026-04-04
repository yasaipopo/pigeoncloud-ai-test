# レコード一覧ページ知見

## URL
- レコード一覧: `/admin/dataset__{tableId}`
- レコード新規作成: 一覧ページから+ボタンクリック（`/edit/new`への直接gotoは白画面）

## 新規レコード作成フロー
1. 一覧ページに遷移 → `.navbar` 待ち → `waitForAngular`
2. `button:has(.fa-plus)` クリック
3. `admin-forms-field` セレクター待ち（102フィールドは30秒必要）
4. `waitForTimeout(2000-5000)` でAngular描画完了待ち

## アクションメニュー（dropdown-toggle）
- `button.dropdown-toggle` が2つ（帳票用とアクション用）
- 帳票以外のdropdown-toggleをクリック → CSVダウンロード、CSVアップロード、集計、チャート、帳票登録、一括編集、計算結果更新、ファイルのzipアップロード
- レコードがない（空テーブル）場合はdropdown-toggleが表示されない

## フィルタ/集計チャートモーダル
- 「チャート」メニュークリック → `.modal.show` でモーダル
- タブ: 絞り込み、並び順、チャート設定、デフォルト設定、設定
- 設定タブの権限: `input[name="grant"]`（public/private/custom）
- 「保存して表示」ボタンで保存

## /edit/new は使わない
- Angular SPAの内部ルートのため直接URLアクセスで白画面になる
- 一覧画面の+ボタンからの遷移のみ
