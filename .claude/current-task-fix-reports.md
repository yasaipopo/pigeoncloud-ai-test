# current-task: reports.spec.js修正

## エージェント名: fix-reports

## タスク概要
reports.spec.jsのfailテスト修正（1 pass / 8 fail）

## 特定した問題
1. RP01 (144-01 step): 帳票名入力が Angular Reactive Forms で fill() が効かない
   - 修正: Native Input Value Setter + input/change イベントディスパッチ
   - ファイル入力: #file_info_id_single を使う
   - 保存ボタン: button[type="submit"].btn-primary

2. RP02: RP01が途中で失敗しているため後続も navigateToTablePage でセッション問題

3. UC22 (817 step): /admin/dataset__${tableId}/report が存在しない（ルートにリダイレクト）
   - 修正: 帳票ドロップダウン → 「編集」→ モーダル内の削除ボタン をクリックする

## 状態
- 調査完了、修正中
