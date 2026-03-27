# E2Eテスト 知見（Angular・エージェント体制・テスト設計ルール）

最終更新: 2026-03-28

---

## エージェント体制

| キャラ | スキル | 役割 |
|---|---|---|
| **リーダー** | `/e2e` | パイプライン全体管理。TEST_NUMBER管理、agent起動、結果集計、シート更新、通知 |
| **テスト修正くん** | `/spec-create` | `specs/*.yaml` のテスト内容（description/expected）通りにspec.jsを実装・修正する。MCP Playwrightで実UIを確認してからコードを書く。怒りくんのOKなしにコミット禁止。 |
| **怒りくん** | `/check-specs` | テスト品質チェック。タイトルと実装の一致、早期return、スキップを厳格に判定。NG→テスト作成君に差し戻し。 |
| **チェックくん** | `/check-run` | Playwright実行確認 + failedをPigeonCloudソースと照合してspecバグ/プロダクトバグ/環境依存に振り分け。 |
| **詳細調査くん** | — | タイムアウト等の根本原因をCloudWatch/ECS/RDS/ソースコードから調査。 |
| **不具合調査くん** | — | 問い合わせで発覚した不具合・PRを確認し、既存テストで検知できたか調査。検知できなければテストを追加。 |

```
テスト修正くんがspec.jsを修正（MCP Playwrightで実UI確認必須）
  → 怒りくんがレビュー（コード品質）
    → ✅ OK → チェックくんがPlaywright実行で動作確認
      → ✅ PASS → コミット
      → ❌ FAIL → テスト作成君へ差し戻し
    → ❌ NG → テスト作成君へ差し戻し
```

---

## 【最重要】テスト設計ルール

### ルール1: ALLテストテーブルは global-setup で1回だけ作成

```
global-setup.js → ensureAllTypeTable() → テーブル作成（1回だけ）
各spec.js → getAllTypeTableId(page) → ID取得のみ（作成しない）
```

**禁止事項:**
- ❌ 各specのbeforeAllで `setupAllTypeTable()` を呼ぶ（global-setupの責務）
- ❌ テスト途中で `deleteAllTypeTables()` を呼ぶ（他specが同じテーブルを使う）
- ❌ afterAllで `deleteAllTypeTables()` を呼ぶ（後続specが影響を受ける）

**テーブル削除テストが必要な場合:**
- 専用の一時テーブルを作成→削除する（ALLテストテーブルは触らない）

### ルール2: browser.newPage() ではなく createAuthContext(browser) を使う

```javascript
// ❌ 悪いパターン
const page = await browser.newPage(); // storageStateが効かない

// ✅ 良いパターン
const { createAuthContext } = require('./helpers/auth-context');
const { context, page } = await createAuthContext(browser);
// ... 処理 ...
await context.close();
```

### ルール3: テスト間のデータ状態に依存しない

- 各テストは**他のテストが作成/変更/削除したデータに依存しない**設計にする
- テストが必要なデータは**そのテスト自身のsetupで作成**する
- ALLテストテーブルのレコード件数を前提にしない（他テストが追加/削除する可能性）

### ルール4: MCP Playwright で実UI確認してからコードを書く

テスト作成君は必ず：
1. `mcp__playwright__browser_navigate` で対象ページを開く
2. `mcp__playwright__browser_snapshot` でDOM構造を確認
3. セレクター・ボタン名・URL遷移を確認してからspec.jsに書く

### ルール5: Laddaボタンのdisabled対策

`[ladda]='sending'` バインディングがボタンにdisabled属性を付与する。
`setInputFiles` では Angular の change イベントが発火しない場合がある。

```javascript
// ファイル選択後にchangeイベントを手動ディスパッチ
await page.setInputFiles('input[type=file]', filePath);
await page.evaluate(() => {
    document.querySelector('input[type=file]').dispatchEvent(new Event('change', { bubbles: true }));
});
```

### ルール6: CSVアップロードは非同期処理

PigeonCloudのCSVアップロードは非同期（S3→キュー→バックグラウンド処理）。
モーダル内にエラーは表示されない。結果は `/admin/csv`（CSV UP/DL履歴）で確認する。

---

## インフラ知見

### ALB idle_timeout = 60秒
- `create-all-type-table` APIは60秒超えるため504が返る
- バックエンドは処理を継続するが、フロントはエラーを受け取る
- 対策: global-setupでfire-and-forget + ポーリング待機

### RDSがボトルネック
- ECS CPU: 平均4%（I/Oバウンド）
- RDS CPU: テスト集中時に45%まで上昇
- 97フィールドのVIEW作成/JOINクエリが重い
- 対策: テーブル作成を1回に集約（global-setup）、中期でフィールド数軽量化

### ECS Auto Scaling
- CPUベース（しきい値55%）だがCPUが上がらないためスケールアウトしない
- Web: Max=2, 現在1タスク / Queue: Max=3
- PHPはI/Oバウンドのため、リクエスト数ベースのスケーリングが適切

---

## Angular固有の知見

### 知見1: Reactive Forms ([formControl]) に fill() が効かない場合

**方法A: Native Input Value Setter（確実）**
```javascript
await page.evaluate((value) => {
    const input = document.querySelector('#name');
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSet.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}, 'テストDB_12345');
```

### 知見2: チュートリアルモーダル
新しいテスト環境で `/admin/dashboard` を開くと「テンプレートからインストール」モーダルが自動表示される。
```javascript
const hasTutorial = await page.locator('.modal.show')
    .filter({ hasText: 'テンプレートからインストール' })
    .isVisible({ timeout: 3000 }).catch(() => false);
if (hasTutorial) {
    await page.locator('.modal.show button:has-text("スキップ")').first()
        .click({ force: true }).catch(() => {});
    await waitForAngular(page);
}
```

### 知見3: about:blank から fetch すると cookies が送られない

`createAuthContext(browser)` で作ったページは `about:blank`。この状態で `page.evaluate(fetch(...))` を呼ぶと、`credentials: 'include'` でもcookiesが送られない（オリジンが異なるため）。

**対策**: fetch前に `page.goto(BASE_URL + '/admin/dashboard')` する。`getAllTypeTableId` には自動でこの処理が入っている。

### 知見4: /admin/add/xxx は PHP に届かない
Nginx: `/api/` → PHP、`/` → Angular SPA。API呼び出しは `/api/admin/` プレフィックスを使う。

### 知見4: パスワード変更フロー
`password_changed='false'` + `ignore_new_pw_input='false'` でフォーム表示。
`create-user` レスポンスに `id` が含まれる（list/admin不要）。

### 知見5: create-user のレスポンス
```json
{"result":"success","id":4,"success":true,"email":"ishikawa+4@loftal.jp","password":"admin"}
```
`id` フィールドで直接ユーザーIDを取得可能。

---

## debug API一覧

| エンドポイント | 用途 |
|---|---|
| `POST /api/admin/debug/create-all-type-table` | ALLテストテーブル作成（重い、60秒超） |
| `POST /api/admin/debug/delete-all-type-tables` | ALLテストテーブル全削除 |
| `POST /api/admin/debug/create-all-type-data` | テストデータ投入 |
| `GET /api/admin/debug/status` | 環境ステータス（テーブル一覧含む） |
| `POST /api/admin/debug/create-user` | テストユーザー作成 |
| `POST /api/admin/debug/settings` | admin_setting/setting テーブル更新 |
| `POST /api/admin/create-trial` | テスト環境（テナント）作成。`with_all_type_table: true` でテーブル同時作成（staging要デプロイ） |

---

## 不具合検知パターン集

### パターン1: Angular onValueChanged 非同期化リグレッション（2026-03-27発生）

**障害概要**: `forms.component.ts` の `onValueChanged()` を `getSelectOptions().subscribe()` 内に移動した結果、全フィールドの値更新が非同期API完了待ちになり、API応答前に保存するとデータモデルに値が未反映でデータロスが発生。

**検知に必要なテスト**:
- 「値を入力 → 保存 → ページリロード/再遷移 → 値が保存されている」の End-to-End 検証
- 特に**複数フィールドを同時編集して保存**するケースが重要（race conditionが顕在化しやすい）
- テストは `records.spec.js` の `SAVE-01` ~ `SAVE-04` で実装済み

**テスト設計のポイント**:
1. 保存後に必ず**別のページに遷移して（またはリロードして）値を再取得**する。同じページ内でDOMの値を見るだけでは不十分（データモデルには値があってもDBに未保存の場合がある）
2. Angular Reactive Forms に値を設定する際は Native Input Value Setter + `input`/`change` イベントのディスパッチが確実
3. 「保存ボタンクリック後のURL遷移」を待つだけでは不十分。保存が実際にDBに到達したか確認するために、詳細画面で値を再表示する

**対応テスト**: `tests/records.spec.js` の `SAVE-01` ~ `SAVE-04`
