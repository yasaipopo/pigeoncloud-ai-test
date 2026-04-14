# R31 agent-33 notifications-2.spec.js 全fail調査

## 結果サマリー

- **対象**: `tests/notifications-2.spec.js` — メール配信テスト（99-1〜99-22, 142-01, 150-x, 156-1, 157, 197, 201, 218, 102-7）
- **症状**: 全7テスト（retry込み14件）が `(2.0m)` タイムアウトで失敗
- **テナント作成**: 成功 (`t177472763830833.pigeon-demo.com`)
- **storageState**: 成功 (`.auth-state.33.json`)
- **ALLテストテーブル**: 成功 (ID: 7)
- **beforeAll**: 成功（`createAuthContext` + `getAllTypeTableId`）

## 根本原因

**`beforeEach` で古い `login()` 関数を使用していたため、毎テストで2分のタイムアウトに到達**

### 原因の詳細

1. **`login()` は古い実装** — notifications.spec.js（Part 1）からの分割時に `ensureLoggedIn()` への移行が漏れた
   - `login()`: `/admin/login` にgoto → networkidle待ち(15秒) → フォーム入力 → waitForURL(40秒) → リトライ(40秒) = **最大100秒以上**
   - `ensureLoggedIn()`: ダッシュボードへgoto → navbar確認 → セッション有効なら即return = **通常5秒以内**

2. **`waitForAngular()` がcatchなし** — `body[data-ng-ready="true"]` のタイムアウト(15秒)が追加される
   - `login()` で100秒 + `closeTemplateModal` 内 `waitForAngular` で15秒 = 115秒
   - テスト本体の `waitForAngular` に入る前に120秒タイムアウト到達

3. **notifications.spec.js（Part 1）は既に修正済み** — `ensureLoggedIn` を使用、タイムアウトも300秒
   - Part 2 だけが古いコードのまま残っていた

### 他specとの比較

| spec | beforeEach | タイムアウト | 結果 |
|------|-----------|------------|------|
| notifications.spec.js (Part 1) | `ensureLoggedIn()` | 300秒 | PASS |
| table-definition.spec.js | `ensureLoggedIn()` | 120秒 | PASS |
| **notifications-2.spec.js** | **`login()`（古い）** | **120秒** | **FAIL** |

## 修正内容

### `tests/notifications-2.spec.js`

1. `ensureLoggedIn` をインポート追加
2. `beforeEach` の `login(page, EMAIL, PASSWORD)` → `ensureLoggedIn(page, EMAIL, PASSWORD)` に変更
3. `waitForAngular()` に `.catch(() => {})` を追加（他specと挙動を統一）

## 影響範囲

- notifications-2.spec.js の全テスト（99-1〜99-22, 142-01, 150-x, 156-1, 157, 197, 201, 218, 102-7）
- 他のspecには影響なし
