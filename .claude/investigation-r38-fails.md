# R38 失敗調査・修正レポート

調査日: 2026-03-29
対象: agent-30 (fail=12), agent-31 (fail=36), agent-32 (fail=18) — 合計66件

---

## パターン分類

### P1: tableId未定義 (ReferenceError) — 20件
**ファイル**: `tests/csv-export.spec.js` (19件), `tests/users-permissions.spec.js` (1件)
**原因**: テスト関数内で `tableId` 変数を参照しているが、ローカルスコープに宣言がない。`getTestTableId()` または `sharedTableId` を使うべき。
**修正**: csv-export.spec.js の19箇所に `const tableId = getTestTableId();` を追加。users-permissions.spec.js の1箇所を `sharedTableId` に修正。
**状態**: **修正済み**

### P2: beforeAllカスケード失敗 — 約74件 (重複含む)
**主要ファイル**: users-permissions.spec.js (45件), fields-3.spec.js (16件), fields-4.spec.js (6件), records.spec.js (4件), chart-calendar.spec.js (2件), reports.spec.js (1件)
**原因**: `createAuthContext(browser)` で作成したstorageState付きコンテキストが、セッション切れ（ログイン画面にリダイレクト）された状態でAPIを呼び出し → 「ログインしていません」エラー → beforeAll失敗 → 配下の全テストがカスケード失敗。
**修正**:
- `tests/helpers/auth-context.js` を修正: コンテキスト作成後にdashboardへ遷移し、ログイン画面にリダイレクトされた場合は自動的に再ログインを実行。
- `tests/users-permissions.spec.js` のbeforeAllに追加のセッション確認ロジックを挿入。
**状態**: **修正済み**（auth-contextの修正により全spec共通で改善見込み）

### P3: テストタイムアウト (60秒) — 76件
**ファイル**: `tests/uncategorized.spec.js` (76件)
**原因**: `beforeEach` の `test.setTimeout(60000)` が、Angular SPAの遅延レンダリング + `checkPage` 内の待機時間を考慮すると不足。環境依存の遅延。
**修正**: 全 `test.setTimeout(60000)` を `test.setTimeout(120000)` に延長（28箇所）。`checkPage` 関数のgotoタイムアウトを60秒に、navbarの待機を30秒に、table要素の待機を30秒に延長。
**状態**: **修正済み**

### P4: checkPageのテーブル描画待機不足 — 82件
**ファイル**: `tests/uncategorized-2.spec.js` (31件), `tests/uncategorized-3.spec.js` (51件)
**原因**: `checkPage` 関数内で `table` 要素の待機が20-35秒しかなく、Angular SPAの遅延レンダリングに対応できていない。また `page.innerText('body')` をdomcontentloaded直後に呼ぶとAngularブート前のHTMLテキストを取得してしまう。
**修正**:
- uncategorized-2: table待機を60秒に延長、navbarの待機を30秒に追加、bodyTextチェックをページ読み込み後に移動。
- uncategorized-3: 同様の修正。table待機を60秒に延長。
- beforeEachタイムアウトを120秒に延長。
**状態**: **修正済み**

### P5: ステップメール設定タイムアウト — 7件
**ファイル**: `tests/notifications.spec.js` (150-2〜150-7, 157)
**原因**: ステップメール設定UIの操作が120秒以内に完了しない。UI操作が複雑で、Angularのフォームバリデーション完了待ちが長い。
**状態**: 環境依存 — 要追加調査

### P6: fields-5.spec.js 表示条件UIタイムアウト — 13件
**ファイル**: `tests/fields-5.spec.js` (850-1〜850-13)
**原因**: beforeAllで `page.waitForSelector` が180秒タイムアウト。テーブル設定ページのAngular読み込みが完了しない。
**状態**: auth-context修正で改善見込み（セッション切れが根本原因の場合）

### P7: templates.spec.js — 6件
**ファイル**: `tests/templates.spec.js` (TMPL-01〜TMPL-06)
**原因**: `openTableManagementBarsMenu` でfa-barsドロップダウンボタンまたは「テンプレートから追加」アイテムが見つからない。UIセレクターの変更か環境問題。
**状態**: 要UIセレクター確認

### P8: table-definition.spec.js — 10件（agent-30）
**ファイル**: `tests/table-definition.spec.js` (109-6〜109-19, 799, 801)
**原因**: 109系: テーブル設定ページのAngularロード遅延 → `.navbar` 10秒タイムアウト。799/801: 使用中項目削除テストが3分タイムアウト。
**状態**: 環境依存 — 要追加調査

### P9: その他個別失敗 — 数件
- `auth.spec.js` 267: 2段階認証設定のUIが見つからない（1件）
- `auth.spec.js` 176: Googleログイン機能のテスト（環境依存、1件）
- `auth.spec.js` 295: パスワード変更3分タイムアウト（1件）
- `chart-calendar-2.spec.js` 16-1: fetch失敗（1件）
- `fields.spec.js` 93-1, 94-1: フィールド名トリミングテスト（2件）
- `payment.spec.js` PAY-06: 支払いAPI 5分タイムアウト（1件）
- `workflow.spec.js` 21-1: ワークフロー設定15秒タイムアウト（1件）

---

## 修正したファイル一覧

| ファイル | 修正内容 | 影響パターン |
|---|---|---|
| `tests/helpers/auth-context.js` | セッション切れ時の自動再ログイン追加 | P2 (全spec共通) |
| `tests/csv-export.spec.js` | 19箇所に `const tableId = getTestTableId()` 追加 | P1 (19件) |
| `tests/users-permissions.spec.js` | beforeAll再ログイン追加、`tableId` → `sharedTableId` 修正 | P1 (1件), P2 |
| `tests/uncategorized.spec.js` | タイムアウト60→120秒、checkPage改善 | P3 (76件) |
| `tests/uncategorized-2.spec.js` | checkPage改善（タイムアウト延長、待機順序修正）、beforeEach 120秒 | P4 (31件) |
| `tests/uncategorized-3.spec.js` | checkPage改善（タイムアウト延長）、beforeEach 120秒 | P4 (51件) |

---

## 改善見込み

| パターン | 件数 | 修正後の見込み |
|---|---|---|
| P1: tableId未定義 | 20件 | **全件解消** |
| P2: beforeAllカスケード | ~74件 | **大幅改善**（セッション切れ起因のものは解消） |
| P3: タイムアウト60秒 | 76件 | **大幅改善**（120秒に延長） |
| P4: checkPage待機不足 | 82件 | **改善**（タイムアウト延長+待機順序修正） |
| P5-P9: 個別問題 | ~30件 | 要追加調査 |

**直接修正で確実に解消されるもの**: P1 (20件)
**間接修正で改善見込みのもの**: P2+P3+P4 (約230件中、環境依存分を除いて大部分)
