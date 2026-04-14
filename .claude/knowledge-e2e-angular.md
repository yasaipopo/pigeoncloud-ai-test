# E2Eテスト 知見（Angular・エージェント体制・テスト設計ルール）

最終更新: 2026-03-28

---

## エージェント体制

| キャラ | スキル | 役割 |
|---|---|---|
| **リーダー** | `/e2e` | パイプライン全体管理。TEST_NUMBER管理、agent起動、結果集計、シート更新、通知 |
| **テスト修正くん** | `/spec-create` | `specs/*.yaml` のテスト内容（description/expected）通りにspec.jsを実装・修正する。MCP Playwrightで実UIを確認してからコードを書く。 |
| **チェックくん** | `/check-run` | Playwright実行 + failedをPigeonCloudソースと照合してspecバグ/プロダクトバグ/環境依存に振り分け。環境依存の遅さは差し戻しにしない。 |
| **詳細調査くん** | — | タイムアウト等の根本原因をCloudWatch/ECS/RDS/ソースコードから調査。 |
| **不具合調査くん** | — | 障害・PRからyaml追加→DB更新→知見md。 |

```
① テスト内容チェック: yaml品質・網羅性（pigeon repo + Playwright MCP参照）
  → ② テスト修正くん: yaml通りにspec.js実装・修正
    → ③ チェックくん: Playwright実行 + 問題あれば差し戻し
      → ✅ PASS → コミット
      → ❌ FAIL(specバグ) → ②に差し戻し
      → ❌ FAIL(プロダクトバグ) → product-bugs.mdに記録
      → ⚠️ FAIL(環境依存/遅さ) → 再実行（差し戻しにしない）
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

### テスト実行の並列数制限
- **yaml/specチェック（①②）は10並列OK**（コード読むだけ、サーバーアクセスなし）
- **テスト実行（③）は最大3並列**（各テストがテナント作成+DB操作するためRDS負荷が集中）
- 10並列でテスト実行すると48プロセスが同時にDBアクセスしタイムアウト多発
- ①②が全完了後にまとめて③を3グループで実行するのが効率的

### 並列数の上限: 3並列
- 5並列以上はCPUオーバーヒートのリスクあり（128GBメモリでもCPUが問題）
- 3並列が安全な上限

### AGENT_NUMは各エージェントで別にする
- **同じAGENT_NUMを複数エージェントが使うと `.auth-state.{NUM}.json` が上書き競合する**
- テスト実行するエージェントには異なるAGENT_NUMを割り当てる（例: 30, 31, 32）
- yaml/specチェックのみのエージェントはAGENT_NUM不要（テスト実行しないため）

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

**注意**: `getAllTypeTableId` 以外のAPIヘルパー（`createAllTypeTable`, `createAllTypeData`等）を`createAuthContext`直後に呼ぶ場合、各spec.jsのbeforeAllで手動gotoが必要。R42で11ファイルが影響。2026-03-29修正済み。

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

## URLベースのテストケースの扱い

### 問題
specs/*.yaml に約420件のテストケースが「URLのみ」で定義されている。
例: `description: https://loftal.pigeon-cloud.com/admin/dataset__90/view/583`

これらのURLはPigeonCloudの不具合修正依頼や機能追加依頼のページ。URLだけではテスト内容が分からない。

### ルール
1. **URLベースのケースはPASSにしない**（①yamlチェックをOKにしない）
2. URLから依頼内容を取得し、**テストフロー（操作手順+チェック項目）に変換**する
3. **依頼内容をそのまま貼り付けてはいけない**。「〜が隠れる」→「カレンダー表示に切り替え→時間が隠れないことを確認」のように操作手順にする
4. **独立したケースにせず、既存テストの適切な場所に統合**する。例: カレンダー表示バグ → chart-calendarの既存カレンダーテスト内にチェック項目として追加
5. **テストが効率よく回る順番**に配置する（同じページを開くテストはまとめる）
6. 依頼内容の取得方法:
   ```bash
   # raw_query.js を使ってPigeonCloudから依頼内容を取得
   # URL: https://loftal.pigeon-cloud.com/admin/dataset__90/view/583 の場合
   # → db=popo, table=dataset__90, view=583 のレコードを取得
   node /Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/manage/raw_query.js \
     popo "SELECT * FROM dataset__90 WHERE id = 583" --env=prod
   ```
4. 取得した依頼内容（不具合内容/機能追加内容）に基づいてテストフローを設計
5. yamlの `description` と `expected` を具体的な操作手順と期待結果に書き換える

### yamlチェック時の判定
- URLのみの description → **❌ NG**（テストフローに書き直す必要あり）
- 依頼内容をそのまま貼り付け（「【バグ修正確認】〜が隠れる」等） → **❌ NG**（操作手順に変換必要）
- URLを含むがテストフロー（操作手順+期待結果）も書かれている → **✅ OK**（参考URLとして許容）

### 統合の例
依頼: 「カレンダー表示で時間が隠れる」(PR #267で修正済み)

❌ 悪い例（独立ケース）:
```yaml
- case_no: "248"
  description: 【バグ修正確認】カレンダー表示で時間が隠れてしまう。
  expected: 想定通りの結果となること。
```

✅ 良い例（既存テストに統合）:
chart-calendar.yaml の既存カレンダー表示テスト（例: 114-01）の中に追加:
```yaml
- case_no: "114-01"
  description: |
    ①カレンダービューを開く
    ②週表示に切り替える
    ③長い文字列のイベントが表示されていることを確認
    ④時間表示が隠れていないことを確認（#248 修正確認）
  expected: |
    カレンダーの週表示が正常に表示され、時間が隠れていないこと
```

---

## テスト構造: 中カテゴリ単位でまとめる

### ルール
1テスト（test関数）= 1動画。そのため**細かいチェック項目を独立テストにしない**。

**中カテゴリ**（同じページ/同じ操作文脈で確認できるチェック群）を1つのtest関数にまとめる。
その中に複数のexpect/チェック項目を詰め込む。

### 構造

```yaml
# yaml
cases:
- case_no: "CAL-WEEK"
  feature: カレンダー週表示
  category: 中カテゴリ（1動画）
  description: |
    ①カレンダービューを開く
    ②週表示に切り替える
    ③イベントが正しく表示されること
    ④時間表示が隠れていないこと（#248修正確認）
    ⑤長文イベントでもレイアウトが崩れないこと
  expected: |
    週表示が正常表示され、時間が隠れず、レイアウトが崩れないこと
  includes:
    - "114-01"  # 元々の週表示テスト
    - "248"     # バグ修正確認（カレンダー時間隠れ）
```

```javascript
// spec.js — 1つのtest関数 = 1動画
test('CAL-WEEK: カレンダー週表示の総合チェック', async ({ page }) => {
    // ① カレンダービューを開く
    await page.goto(BASE_URL + '/admin/dataset__' + tableId);
    await switchToCalendarView(page);

    // ② 週表示に切り替え
    await page.click('button:has-text("週")');
    await waitForAngular(page);

    // ③ イベントが表示されている（114-01）
    await expect(page.locator('.fc-event')).toBeVisible();

    // ④ 時間が隠れていない（#248修正確認）
    const timeEl = page.locator('.fc-event-time');
    await expect(timeEl.first()).toBeVisible();
    const timeBox = await timeEl.first().boundingBox();
    expect(timeBox.height).toBeGreaterThan(0);

    // ⑤ 長文でもレイアウト崩れない
    // ...
});
```

### メリット
- **動画が意味のある単位**になる（同じ文脈の操作が1動画に）
- **テスト実行時間の大幅短縮**（ページ遷移・ログイン回数が減る）
- **バグ修正確認は既存フローの1チェック項目として追加**（独立テストにしない）

### yaml の `movie` フィールド（動画番号）
**既存のcase_noはそのまま残す。行を統合・削除しない。**
代わりに各ケースに `movie` フィールドを追加して、どの動画に属するかを示す:

```yaml
cases:
- case_no: "105-01"
  movie: "MV001"  # チャート機能総合
  feature: チャート
  description: ...
- case_no: "105-02"
  movie: "MV001"  # 同じ動画
  feature: チャート
  description: ...
- case_no: "15-1"
  movie: "MV002"  # 集計機能総合
  feature: 集計
  description: ...
```

同じ `movie` 番号のケースは1つのtest関数（= 1動画）内で順番にチェックされる。
sheetでは動画番号列が表示され、同じ動画のケースがグルーピングされる。

### 動画内のケース順序ルール
- **同じ画面でできることはまとめる**（ページ遷移を最小限に）
- **前提操作 → チェック → 次の画面** の流れにする
- テストの順番変更・description微調整はOK（効率化のため）
- **テスト自体を減らすのは絶対禁止。順番を変えるだけ。**
- 例: テーブル設定画面にいる間にフィールド追加・権限設定・CSV設定をまとめてチェック

### 動画番号の命名
`{spec略称}{連番}` 形式:
- chart-calendar: CC01, CC02, CC03
- workflow: WF01, WF02
- fields: FD01, FD02
- uncategorized: UC01, UC02, ...

### 動画の区切り方（5〜20分）

**動画を見た人が操作の流れを理解できる**単位でまとめる。

**良い例:**
```
【ワークフロー基本フロー（10分）】
WF作成 → フロー設定 → テストレコード作成 → 申請 → 承認者で確認 → 承認 → 否認テスト → 再申請 → 最終承認
→ 途中で各種チェック（バッジ表示、メール通知、ステータス変更等）
```

**悪い例:**
```
【WF承認（1分）】
いきなり申請済みWFが表示される → 承認ボタンクリック → OK
→ なぜ承認できる状態なのか文脈がない
```

**原則:**
- 前提となる操作（作成・設定）から始める。いきなり結果画面から始めない
- 同じ機能の操作フロー全体を1動画に収める
- 5〜20分が目安。短すぎる（1-2分）は細かすぎ、30分超は長すぎ
- ログインからでなくてもOKだが、**操作の文脈がつながること**が重要

---

## テスト品質の問題（2026-03-29時点）

581件（27%）が「ふざけたテスト」状態:
- navbar+ISEだけ: 270件（ページが500エラーにならないことだけ確認）
- ISEチェックだけ: 182件
- assertionなし: 118件

**ワースト**: fields-2(97%), fields-3(86%), chart-calendar-2(75%), fields(61%)

これらは「テスト名に書いてある機能の検証」をしていない。
MCP Playwrightで実UIを確認しながら1件ずつ具体的なassertion追加が必要。

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

---

## ワークフロー ビジュアルフローエディタ（2026-04-03確認）

### アクセス方法
1. テーブル設定→ワークフロータブ→ワークフローON
2. 「ワークフローのフローを固定する」をONにする
3. 「フローを設計する」ボタンをクリック → ビジュアルモーダルが開く

### UI構造
- **タイトル**: 「承認フローの設計」
- **左サイド**: フロー一覧（フローがない場合は「フローがありません」）
- **メイン**: フロー設計エリア（追加前は「『追加』ボタンでフローを作成してください」）
- **左下**: 「＋追加」ボタン（緑）→ フロー追加
- **右下**: 「完了」ボタン
- **右上**: 「×」閉じるボタン
- **注意書き**: 「この画面で『更新』ボタンを押すまで保存されません」

### セレクター
- フローを設計するボタン: `button:has-text("フローを設計する")`
- 追加ボタン: `.modal.show button:has-text("追加")`
- 完了ボタン: `button:has-text("完了")`
- フロー一覧: フロー固定ON後に表示される

### テスト設計のポイント
- 旧UIのワークフロー設定（`.workflow-path-block`等）は使えない
- 新UIはモーダル内のビジュアルエディタ
- フロー追加→承認者設定→完了→更新 の流れ

---

## テーブル設定ページのUI刷新（2026-04-02発見）

### 変更内容
テーブル設定ページ（`/admin/dataset/edit/{id}`）のUIが大幅に刷新された。

**旧UI**:
- フィールド一覧がフラットに表示、各フィールドに`.overSetting`ボタン
- 102フィールドが全て1ページに表示

**新UI**:
- 左サイドにタブメニュー（基本設定、メニュー、一覧画面、詳細・編集画面、CSV、ワークフロー、地図設定、その他）
- フィールド一覧は別タブに移動。`.overSetting`クラスは存在しない
- `＋項目を追加する`ボタンが下部にある

### 影響範囲
- fields.spec.js, fields-2.spec.js, fields-3.spec.js, fields-4.spec.js, fields-5.spec.js
- `.overSetting`セレクターを使う全テスト
- navigateToFieldPage(), assertFieldPageLoaded(), openFieldEditPanel(), getFieldLabelMap()

### 調査結果（2026-04-02）
**UIは変わっていなかった！** テーブルID:22が壊れていただけ。
- テーブル22: `.overSetting` = 0（壊れている）
- テーブル8: `.overSetting` = 6（正常）
- テーブル137（新ALLテスト）: `.overSetting` = 102（正常）

global-setupがID:137を返すようになり、fields-5は全PASS。
**テーブル設定ページのUI自体は変わっていない。**

### 知見: ALLテストテーブルのフィールドラベルとPigeonCloudのUI表示名は異なる（2026-04-02発見）

テストで `filter({ hasText: '選択肢(単一選択)' })` としてもALLテストテーブルのラベルは `セレクト`。
対応表:
| テスト表記 | ALLテストテーブルのラベル |
|---|---|
| 時刻 | 時間 |
| 文章(複数行) | テキストエリア |
| 選択肢(単一選択) | セレクト |
| 選択肢(複数選択) | チェックボックス |
| 他テーブル参照 | 参照_admin |
| 関連レコード一覧 | 関連_マスタ |
| Yes / No | ブール |

### 知見: /new, /add への直接gotoはAngular SPAで白画面（2026-04-02発見）
`/admin/dataset__N/new` や `/admin/dataset__N/add` はAngular SPAの内部ルートで、直接URLアクセスすると白画面になる。
レコード新規作成は一覧画面（`/admin/dataset__N`）から「新規作成」ボタンクリックで遷移する。

### 知見: フィールド行のクリックではモーダルは開かない（2026-04-02発見）

`.field-drag`はフィールド追加パネル（左サイド）のドラッグ要素。既存フィールドの設定モーダルを開くには`.pc-field-block`内の`.overSetting`をクリックする。

```javascript
// ❌ 悪い: field-dragクリック → モーダル開かない
const field = page.locator('.field-drag').filter({ hasText: '日時' }).first();
await field.click();

// ✅ 良い: pc-field-block + overSettingクリック → モーダルが開く
const field = page.locator('.pc-field-block').filter({ hasText: '日時' }).first();
await field.locator('.overSetting').click({ force: true });
```

### 知見: UI文言変更「更新する」→「変更する」（2026-04-02発見）
フィールド設定モーダルの保存ボタンが「更新する」→「変更する」に変更された。
全specで`hasText: '更新する'`を`hasText: '変更する'`に修正済み（60箇所）。

### 知見: ALLテストテーブルIDは変わることがある
- テスト環境で複数回create-all-type-tableを実行するとIDが変わる
- 古いID(22)が壊れて新しいID(137)が作成された
- global-setupの`getAllTypeTableId`が最新のIDを返すため、各specはこれに依存すべき
- **テーブルIDをハードコードしない**（`.test_env_runtime`等にキャッシュされた古い値にも注意）
