# ワークフローページ知見

## ワークフロー設定（テーブル設定のワークフロータブ）
1. テーブル設定ページ → ワークフロータブクリック
2. 「ワークフロー」トグルをON
3. 各設定オプション（ON/OFF）:
   - ワークフローのフローを固定する
   - フロー固定時に承認者を追加できる
   - ワークフロー承認者はデータ編集可能
   - 同一承認者の承認スキップ機能
   - 一度承認されたデータも再申請可能
   - 引き上げ承認機能
   - フローを一つ戻す機能
   - 組織の全員が承認時のみに通知

## ビジュアルフローエディタ
- 「フローを固定する」ON → 「フローを設計する」ボタン出現
- クリック → フルスクリーンモーダル「承認フローの設計」
- 左サイド: フロー一覧
- 左下: 「＋追加」ボタン（緑）
- メイン: フロー設計エリア
- 右下: 「完了」ボタン
- セレクター: `button:has-text("フローを設計する")`, `.wf-add-btn`

## ワークフロー申請（レコード画面）
- レコード詳細画面にワークフロー関連ボタン
- 申請、承認、否認、取り下げ
- ステータスバッジ表示

## テスト構成
- workflow.spec.js: 13テスト全PASS（2026-04-03時点）
- serialモード使用（beforeAllを1回だけ実行）
- `withAllTypeTable: false` で軽量環境

## v2 実行エージェントの知見（2026-06-22 wf-001 run より）

承認WFの申請→承認 動線を Playwright で通す際の落とし穴:

1. **申請モーダルの submit ボタン**: `button.btn.btn-primary.ladda-button` テキスト「申請する」。
   - Angular カスタム要素の「完了」グリーンノードは `<button>` ではないのでクリック対象にしない。
2. **承認ステップ追加後**に「ステップ1の編集」パネルが自動展開される → `button.wf-edit-panel-close` で閉じてから申請する。
3. **申請後の遷移**: テーブルリスト URL（`/admin/dataset__N`）へ遷移。観測は遷移完了を待ってから撮る。
4. **承認操作**: 承認者でログイン → レコード詳細の「承認」ボタン（テキスト「承認」）。承認後はワークフロー履歴セクションに「申請」行＋「承認」緑バッジ行が出る（状態列）。
5. **承認済みの確認点**: レコード詳細の「ワークフロー」セクションの履歴行に承認者と「承認」状態が表示される（これが done の可視的証拠）。
6. **試行が嵩む領域**: WF設定UIが多段で初見だと試行8回かかった。2回目以降はキャッシュスクリプト再生で短縮見込み。

## 🔴 承認モーダルの確定ボタン（2026-06-22 wf-001 詰まりの真因）

承認動線の最大の罠: **一覧/詳細の「承認」ボタンと、モーダル内の確定「承認」ボタンは別物**。

1. **詳細画面の「承認」ボタン** `button.btn-success:has-text("承認")`（view.component.html:130, click=workflow_ok）
   → これは **bsModal を開くだけ。setStatus は飛ばない**。ここを押して「承認した」と思い込むと承認待ちのまま詰む（実際に発生）。
2. **モーダル（ngx-bootstrap bsModal・`.modal.fade.in/show`）が開く**のを待つ。
3. **確定ボタン**: `.modal-footer button.btn-success.btn-ladda:has-text("承認")`（html:233, `*ngIf=workflow_status=='accepted'`・ladda）
   → これが `setWorkflowStatus()` → `setStatus(accepted)` を発火。comment(textarea html:224)は**任意・空でも通る**。
4. **成功シグナル**: toast `.toast-success` /「承認しました」。再読込後 `data.workflow.status==done` で「承認」ボタン消失・`.btn-danger`「再申請」(:101)出現。

Playwright 推奨:
```js
await page.locator('button.btn-success:has-text("承認")').first().click();  // モーダルを開く
const modal = page.locator('.modal.fade.in, .modal.fade.show').filter({ has: page.locator('.modal-footer') });
await modal.waitFor({ state: 'visible' });
await modal.locator('.modal-footer button.btn-success.btn-ladda:has-text("承認")').click();  // 確定
await page.locator('.toast-success, .toast-message:has-text("承認しました")').waitFor({ state: 'visible' });
await modal.waitFor({ state: 'hidden' });
```
要点: `.modal` スコープで絞らないと一覧側の承認ボタンを2回押す取り違えになる。fade アニメ中クリックを避け visible 待ち必須。WF履歴の承認者列は **display_name でなく email** が出る（別人性は email で判定）。
参照: view.component.html:130/187/224/231-236, view.component.ts:601(workflow_ok)/615(setWorkflowStatus)
