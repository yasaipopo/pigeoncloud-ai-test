# E2Eテスト パフォーマンス知見

作成: 2026-03-25

---

## 知見1: waitForTimeout は Playwright の auto-waiting を妨げる

### 問題
```javascript
// ❌ 悪いパターン: waitForTimeout は固定sleep
await page.click('.save-btn');
await page.waitForTimeout(2000);           // ← 無条件に2秒待つ
await expect(page.locator('.success')).toBeVisible();
```

### 原因
`waitForTimeout` はただの `sleep`。  
Playwright の `expect()` / `locator.click()` / `locator.fill()` は**内部でポーリング・auto-waitingを持っている**。  
よって waitForTimeout → expect のパターンは2000msを無駄に消費している。

### 正しい書き方
```javascript
// ✅ 良いパターン: expect が自動的に待機してくれる
await page.click('.save-btn');
// waitForTimeout 不要: expect は要素が現れるまで最大5秒(デフォルト)リトライする
await expect(page.locator('.success')).toBeVisible();

// タイムアウトが不安なら明示的に延ばす
await expect(page.locator('.success')).toBeVisible({ timeout: 10000 });
```

### 削除安全な条件（最保守的ルール: 検証済み）
**以下の条件を全て満たす場合のみ削除可能:**
1. 前の実質行が `await page.goto(` を含む（waitForSelector等ではない）
2. 次の実質行（空行・コメント除く）が `await expect(` で始まる

```python
# 自動削除スクリプトの判定条件
def is_pure_goto(prev_line):
    return 'await page.goto(' in prev_line and 'waitForSelector' not in prev_line
```

### ⚠️ 削除してはいけない（失敗事例あり）

**失敗1: click後を削除** → タブ切り替え後のコンテンツ未ロード
```javascript
// ❌ 削除してはいけない
await clickSettingTab(page, '権限設定');
await page.waitForTimeout(1000);  // ← Angular タブ切り替え完了待ち
await expect(page.locator('.navbar')).toBeVisible();  // これはすぐpass（navbar常在）
// 後続の count() が失敗 ↓
expect(await page.locator('.tab-pane.active').count()).toBeGreaterThan(0);  // count() はauto-waitしない
```

**失敗2: waitForSelector後を削除** → Angular ルーティング未完了
```javascript
// ❌ 削除してはいけない
try { await page.waitForSelector('.dataset-tabs [role=tab]', { timeout: 60000 }); } catch(e) {}
await page.waitForTimeout(1500);  // ← Angular routing 完全完了待ち（安全マージン）
await expect(page.locator('.navbar')).toBeVisible();
```
`waitForSelector` でタブがDOMに出ても Angular のルーティング処理は継続中。

**その他削除不可:**
- goto直後で次が条件分岐 (`if (!page.url().includes(...))`)
- アニメーション完了待ち（DOM変化なし）
- `count()` / `textContent()` / `getAttribute()` 直前 — これらはauto-waitしない
- テストの最後の行（次のauto-waitがない）

### 根本原因: count() はauto-waitしない / .navbar は即時pass
Playwright auto-waiting が効くのは actionability チェック（click, fill）と `expect(locator)` のみ。
`locator.count()` / `locator.textContent()` / `locator.getAttribute()` は**即値を返す**。
また `expect(page.locator('.navbar')).toBeVisible()` は navbar が常に存在するため**即 pass** してしまい、
待機として機能しない。

---

## 知見2: Angular SPA の goto 後待機は waitForSelector に置き換えられる

### 問題
```javascript
// ❌ 悪いパターン
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);  // Angular bootを待っているつもり
```

### 理由
`domcontentloaded` はHTMLロード直後に発火するが、Angular のブートストラップは未完了。  
固定2秒は「たぶん終わってるだろう」という推測に過ぎない。  
Angular が速ければ2秒は無駄、遅ければ2秒では足りない。

### 正しい書き方
```javascript
// ✅ 良いパターン: .navbar が出るまで待つ（=Angular bootの完了指標）
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
// waitForTimeout 不要: expect が .navbar を最大10秒ポーリング
await expect(page.locator('.navbar')).toBeVisible({ timeout: 10000 });
```

---

## 知見3: retries ではなく正しいwaitに直すべき

### 誤った発想
「waitForTimeoutを短くして、失敗したら retries: 1 でリトライすればいい」

### 問題点
- retry はテスト**全体**を最初からやり直す（10〜30秒ロス）
- 短い固定waitが原因で失敗 → retry でも同じ短い固定waitが走る
- flakyなテストが増えてCIが不安定になる

### 正解
- waitForTimeout を**条件付き待機**に置き換える（Playwright auto-waiting を活用）
- retries は genuine な flakiness（ネットワーク遅延・サーバー不安定）のためのもの
- retries: 0 (高速化) or retries: 1 (安定化) はプロジェクトの方針次第

---

## 知見4: 実測された削減効果

### 2026-03-25 計測値（全spec.js）
| 値 | 件数 | 合計時間 |
|---|---|---|
| waitForTimeout(2000) | 458件 | 916秒 |
| waitForTimeout(1000) | 509件 | 509秒 |
| waitForTimeout(1500) | 266件 | 399秒 |
| waitForTimeout(3000) | 99件 | 297秒 |
| **合計** | **1813件+** | **約46分** |

このうち削除安全（expect直前・goto後locator直前）は推定600〜700件 = **約25〜33分削減可能**

### table-definition.spec.js での実験結果（2026-03-25）
- 削除前（agent-459）: 116 passed, 2 flaky, 14.2分
- **第1回（106件削除）**: click後も削除 → 12-x系全て retry #1 → **失敗** → 復元
- **第2回（62件削除）**: waitForSelector後も削除 → 12-x系 retry #1 → **失敗** → 復元
- **第3回（18件削除）**: 純粋goto後のみ → サーバー側タイムアウトで別の失敗（変更は無関係）→ **復元**

### 結論: waitForTimeout 削減は効果が小さくリスクが高い
- 安全に削除できる範囲（純粋goto後のみ）は **18件=29秒** と小さい
- waitForSelector後、click後はAngularタイミング上削除不可
- **正しいアプローチはProduct側の改修**（施策A・B参照）

---

## 知見5: このMDの存在を新しいspec.jsに明記する方法

**spec.js生成時の注意書き（CLAUDE.mdまたはここに記載済み）**:
> `waitForTimeout` は原則禁止。代わりに `await expect(...).toBeVisible({ timeout: N })` を使う。
> どうしても必要な場合（アニメーション待ち等）のみ、コメントで理由を明記して使用。

---

## 実装済みの高速化施策まとめ（2026-03-25時点）

| 施策 | 効果 | 実施日 |
|---|---|---|
| page.goto に domcontentloaded+timeout 追加 | タイムアウト多発を解消 | 2026-03-25 |
| storageState でログインキャッシュ | ログイン処理をスキップ | 2026-03-25 |
| ensureLoggedIn でセッション確認 | beforeEach の高速化 | 2026-03-25 |
| retries: 1 → 0 | 失敗時の無駄なリトライ削除 | 2026-03-19 |
| chart-calendar の beforeAll 最適化 | テーブル作成を1回に集約 | 2026-03-19 |
| ECS CPU 1024→2048, Memory 2048→4096 | サーバー応答速度改善 | 2026-03-25 |
| RDS db.t4g.medium → db.t4g.large | DB応答速度改善 | 2026-03-25 |
| waitForTimeout削減（試み） | 安全範囲が小さすぎ（18件=29秒）で断念。Product側改修が正解 | 2026-03-25 |

---

## 知見3: waitForAngular の body[data-ng-ready="true"] はcatch必須

### 問題
各spec.jsにインラインで定義された `waitForAngular` 関数が `body[data-ng-ready="true"]` を15秒waitForSelectorしているが、
PigeonCloudの環境によってはこの属性が設定されないケースがある。
catchなしだと例外がthrowされ、テスト全体が失敗する。

### 根本原因
R37 agent-30 で **166件中85件が navbar-not-visible** で失敗していた。
原因は `waitForAngular` が throw → 後続の `.navbar` 確認に到達しない → テスト失敗のcascade。

### 正しい実装（ui-operations.js と同じ）
```javascript
async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        // data-ng-readyが設定されないケースがある: networkidleで代替
        await page.waitForLoadState('networkidle').catch(() => {});
    }
}
```

### 対象
23個のspec.jsファイル + helpers/ui-operations.js が同じ関数を定義している。
**新しいspec.jsを作る際は必ずtry/catch付きで定義すること。**

### 修正日: 2026-03-29

---

## 知見4: タイムアウト設定の適正値（2026-04-01 全面修正）

### 問題
全specに `test.setTimeout(300000)` 〜 `test.setTimeout(1800000)` が594箇所あった。
1テストに最大30分待つ設定のため、セレクターが見つからない時に数分〜数十分黙って待ち続け、failの検出が極めて遅かった。

### 適正値ルール

| 対象 | 適正値 | 理由 |
|---|---|---|
| `playwright.config.js` timeout | **60000** (60秒) | テスト関数全体。stepが多い場合のみtest.setTimeout(120000) |
| `config.expect.timeout` | **5000** (5秒) | expect()のデフォルト。要素がDOMにあれば5秒で十分 |
| `test.setTimeout()` | **120000** (2分) | step数が多いテスト関数のみ。通常はconfig default(60秒)で十分 |
| `page.goto()` / `reload()` timeout | **15000** (15秒) | ページ遷移系。ネットワーク往復+HTML取得 |
| `waitForURL()` timeout | **15000** (15秒) | ログイン後リダイレクト等 |
| `waitForSelector()` timeout | **5000** (5秒) | DOM要素待ち（ページ遷移なし）。Angular描画含め5秒で十分 |
| `expect().toBeVisible()` | **引数なし** | config.expect.timeout(5秒)に統一。個別指定は不要 |
| `waitForAngular` / `networkidle` | **5000** (5秒) | SPA描画完了待ち。5秒超えたらcatchで続行 |
| テーブル作成等の重い処理 | **60000** (60秒) | create-trial, create-all-type-table（global-setup内のみ） |

### 例外（長いタイムアウトが許容されるケース）
- `create-trial`（テナント作成）: 最大30秒
- `create-all-type-table`（ALLテストテーブル作成）: 最大30秒（504 Gateway Timeout対策でポーリングあり）
- → これらは `global-setup.js` 内で実行されるため、個別テストのtimeoutとは無関係

### 修正日: 2026-04-01

---

## 知見5: networkidle にはタイムアウト必須

### 問題
```javascript
// ❌ 悪いパターン: タイムアウトなし
await page.waitForLoadState('networkidle').catch(() => {});
```
`networkidle` は500ms間リクエストがないことを要求する。
Angular SPAではポーリングやWebSocket等で常にリクエストが発生するため、永久にブロックする場合がある。
`.catch(() => {})` は **例外をキャッチする** が、**タイムアウトするまでブロックする**（デフォルト=configのtimeout=60秒）。

### 正しい書き方
```javascript
// ✅ 良いパターン: 5秒タイムアウト付き
await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
```

### 影響範囲
全specの `waitForAngular()` 関数内 + helpers内（28箇所）

### 修正日: 2026-04-01

---

## 知見6: count() > 0 で visibility を確認せずに click() してはいけない

### 問題
```javascript
// ❌ 悪いパターン: DOMに存在するがCSSでhiddenな要素にclick
const checkbox = page.locator('input[type="checkbox"]').first();
if (await checkbox.count() > 0) {
    await checkbox.click();  // ← visibleになるまで120秒リトライ → タイムアウト
}
```
`count()` はDOMに存在するかだけを確認。`display:none` や `visibility:hidden` の要素も含む。
`click()` は Playwright の actionability check で **visible になるまで待機** するため、hidden要素に対して永久にリトライする。

### 正しい書き方
```javascript
// ✅ 良いパターン: :visible セレクター + isVisible() で確認
const checkbox = page.locator('input[type="checkbox"]:visible').first();
if (await checkbox.isVisible().catch(() => false)) {
    await checkbox.click();
}
```

### 同様に危険なパターン
- `locator.count() > 0` → `locator.click()`
- `locator.count() > 0` → `locator.fill()`
- `locator.count() > 0` → `locator.check()`

全て `isVisible()` でガードするか、`:visible` セレクターを使うこと。

### 修正日: 2026-04-01

---

## 知見7: ensureLoggedIn のフォールバックチェーン

### 問題
`tests/helpers/ensure-login.js` のtimeoutが60s, 90s, 30sの連鎖だった。
最悪ケース: goto(60s) + navbar(30s) + fullLogin(goto 60s + selector 60s + waitForURL 90s) = **300秒**

storageStateが有効なら1〜5秒で完了するのに、失効時のフォールバックで5分待つ。

### 適正値
- `goto`: 15000ms
- `navbar`: 10000ms
- `waitForSelector('#id')`: 15000ms
- `waitForURL`: 15000ms
- 最悪ケース: **70秒以内**

### 修正日: 2026-04-01

---

## 知見8: locator strict mode violation — .first() の付け忘れ

### 問題
```javascript
// ❌ 悪いパターン: ページに複数のtableがある場合エラー
const table = page.locator('table');
await expect(table).toBeVisible();
// → strict mode violation: locator('table') resolved to 3 elements
```

### 正しい書き方
```javascript
// ✅ 良いパターン
const table = page.locator('table:visible').first();
await expect(table).toBeVisible();
```

### 修正日: 2026-04-01

---

## 知見9: goto後のexpect(.navbar)は5秒では不足

goto→waitForAngular→expect(.navbar).toBeVisible()でAngular SPAブートが5秒以内に完了しないケースがある。
全696箇所の`.navbar` toBeVisibleに`{ timeout: 15000 }`を追加済み。

### 修正日: 2026-04-01

---

## 知見10: PigeonCloudのデータテーブルセレクター

`locator('table').first()` はhiddenなtableにマッチする。`.pc-list-view, table.table-striped` を使う。

### 修正日: 2026-04-01

---

## 知見11: 独自login関数を各specに定義しない

各specの独自login関数は `button[type=submit]` 複数マッチ等で壊れやすい。
`const { ensureLoggedIn } = require('./helpers/ensure-login');` に統一する。

### 修正日: 2026-04-01

---

## 知見12: フィールド設定モーダルのヘッダーは「項目編集」

overSettingクリックで開くモーダルのヘッダーは `項目編集` であり、フィールドタイプ名ではない。
フィールドタイプ名はモーダル内のh5で確認する。

### 発見日: 2026-04-01（fields-2で発見、未修正）

---

## 知見13: /edit/new への直接goto は白画面になる

Angular SPAの内部ルート `/admin/dataset__{id}/edit/new` に直接gotoすると白画面。
レコード一覧 → +ボタン（`button:has(.fa-plus)`）でクリック遷移すること。
管理画面ルート（`/admin/notification/edit/new`等）は問題ない。

### 修正日: 2026-04-04（workflow, advanced-features, users-permissionsで修正）

---

## 知見14: run-test.sh を使ってテスト実行

`.zshrc`のnvm遅延ロードが再帰呼出しを起こすため、`run-test.sh`経由で実行する。
```bash
AGENT_NUM=N bash run-test.sh tests/XXX.spec.js --reporter=list --workers=1
```

### 発見日: 2026-04-04

---

## 知見15: 同時テスト実行は3-4個まで

同時に多数のcreateTestEnv（10+）を走らせるとai-testサーバーのRDS負荷が高くなり、テーブル作成タイムアウト（120秒超え）が発生する。同時実行は3-4個までに抑える。

### 発見日: 2026-04-04

---

## 知見16: テーブル作成直後はAngularメニューに未登録

create-trialやcreateTestEnvでテーブル作成後、Angularのメニューデータにテーブルが登録されていない。
`page.goto('/admin/dataset__N')`すると**ダッシュボードにフォールバック**する。

**対策**: `navigateToTable(page, BASE_URL, tableId)` ヘルパーを使う（tests/helpers/navigate-to-table.js）。
ダッシュボードリロード→dataset__Nに遷移→+ボタンが見つかるまでリトライ（最大3回）。

### 発見日: 2026-04-05

---

## 知見17: clearCookiesがbeforeEachに必須

fixture pageのstorageStateに古い環境のcookieが残り、createTestEnvの新環境にログインできない。
全specのbeforeEachの先頭で`await page.context().clearCookies()`を呼ぶこと。

### 発見日: 2026-04-05

同時に多数のcreateTestEnv（10+）を走らせるとai-testサーバーのRDS負荷が高くなり、テーブル作成タイムアウト（120秒超え）が発生する。同時実行は3-4個までに抑える。

### 発見日: 2026-04-04
