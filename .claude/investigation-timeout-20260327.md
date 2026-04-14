# タイムアウト原因調査レポート

**調査日**: 2026-03-27
**調査者**: 詳細調査くん

---

## 1. create-all-type-table が遅い/504を返す原因

### 原因: ALBアイドルタイムアウト(60秒) vs API処理時間(60秒超)

**証拠:**

1. **ALBのアイドルタイムアウト = 60秒**
   ```
   pigeoncloud-staging-alb-new: idle_timeout.timeout_seconds = 60
   ```

2. **create-all-type-table APIの処理内容** (`background_debug.php:6669-8020`)
   - Step 1.5: ALLTESTグループ作成
   - Step 2: マスタテーブル作成（17フィールド）
   - Step 2.5: カテゴリマスタ3テーブル作成（大・中・小カテゴリ）
   - Step 3: 子テーブル作成（3フィールド）
   - Step 4: メインテーブル作成（**97フィールド**: 基本19 + 複数入力8 + 他テーブル参照4 + ルックアップ3 + 関連1 + 固定HTML1 + 計算式7 + 条件分岐8 + 集計7 + ステータス5 + 特殊5 + 連動プルダウン17 + ワークフロー9 + 制約4 + その他3）
   - Step 4.5: ルックアップcopy-fields拡張（14マッピング）
   - Step 5: 子テーブルcalcフィールド追加
   - Step 6: DDL実行・テーブル物理作成（6テーブル分のALTER TABLE）
   - Step 7: VIEW作成（6テーブル x 2回 + 再度createOrUpdate x 6）
   - Step 8: マスタ3件 + カテゴリデータ + メイン固定3件のデータ投入
   - Step 9: キャッシュクリア

3. **呼び出し方式**: `debug-tools.php:71`で`exec('php script.php add-all-type-table ...')` を子プロセスとして実行。`set_time_limit(120)`だが、`exec()`中はPHPのタイムリミットがカウントされない。

4. **タイムアウトチェーン**:
   ```
   ALB (60s) → Nginx/PHP-FPM → PHP exec() → script.php (実処理)
   ```
   ALBが60秒でクライアントに504を返すが、バックエンドのexec()は120秒まで処理を継続する。

### 対策案

| 優先度 | 対策 | 効果 | リスク |
|--------|------|------|--------|
| **A (推奨)** | ALBのidle_timeoutを120秒に延長 | 504を回避、テスト安定化 | 全テナントに影響（低リスク） |
| **B** | debug APIを非同期化（fire-and-forget + ポーリング方式に変更） | 根本解決 | 実装コスト大 |
| **C** | テスト側の現状維持（fire-and-forget + ポーリング） | 既に実装済み | 504エラーログが出続ける |

**現状のテスト側ヘルパー (`table-setup.js`) は既にfire-and-forget + ポーリング方式を採用しており、504を許容する設計になっている。** しかし、最大ポーリング時間が200秒（10秒 x 20回）のため、処理が120秒を超えるとタイムアウトする。

---

## 2. テーブル一覧画面が遅い原因

### 原因: Angular SPAの初期ロード + VIEWクエリの重さ

**証拠:**

1. **uncategorized-2.spec.js の beforeAll** (`line 234-246`)
   - `test.setTimeout(360000)` (6分) を設定
   - `setupAllTypeTable` + `createAllTypeData(page, 3)` を実行
   - **beforeAllでの360秒タイムアウトは、setupAllTypeTableのポーリング待ち時間が支配的**

2. **beforeEach** (`line 248-252`)
   - `test.setTimeout(30000)` を設定
   - `ensureLoggedIn(page)` + `closeTemplateModal(page)` のみ
   - 各テストは `waitForAngular(page)` で Angular の描画完了を待つ

3. **テーブル一覧の描画処理**:
   - ALLテストテーブルは97フィールド持つ
   - 一覧表示時にVIEW (`dataset__X_view`) を使ったクエリが走る
   - VIEWは他テーブル参照・ルックアップ・関連テーブル等のJOINを含み、重い
   - Angular側で全フィールドのレンダリングが必要

4. **ECSリソース**: Fargateタスクは **2 vCPU / 4GB RAM** で1タスクのみ。複数テナントが同居するとCPU/メモリ競合が起きる。

### 対策案

| 優先度 | 対策 | 効果 |
|--------|------|------|
| **A** | ALLテストテーブルのshow-listフィールドを減らす（一覧表示不要なフィールドを`show-list: false`に） | VIEWクエリ軽量化 |
| **B** | テスト側でbeforeEachのtimeoutを45秒に延長 | テスト安定化 |
| **C** | ECSタスク数を2以上に増やす | リソース競合緩和 |

---

## 3. CSVアップロードボタンがdisabledな原因

### 原因: Laddaライブラリの`[ladda]='sending'`バインディング

**証拠:**

1. **HTMLテンプレート** (`admin.component.html:1015`):
   ```html
   <button type="button" *ngIf="resetBeforeCsvUpload == 'false'"
           class="btn btn-primary" [ladda]='sending'
           (click)="openUploadConfirmModal()">
       アップロード
   </button>
   ```
   Laddaは`sending = true`の間ボタンにspinnerを表示し、**`disabled`属性を自動付与**する。

2. **sendingフラグのライフサイクル** (`admin.component.ts`):
   - `uploadCsv()` (line 2076): `this.sending = true`
   - 成功時 (line 2087): `this.sending = false`
   - エラー時 (line 2132): `this.sending = false`
   - **前回のアップロードが失敗（ネットワークエラー等）した場合、`sending`がfalseに戻らない可能性がある**

3. **テスト側の対処**:
   - `table-definition.spec.js:2809` では `force: true` でクリック
   - `table-definition.spec.js:2816-2825` では `evaluate`で`disabled`属性を強制削除してクリック
   - **これは回避策であり、根本原因は`sending`フラグが残存する状態**

4. **CSVモーダルの2段階フロー**:
   ```
   CSVモーダル → 「アップロード」クリック → openUploadConfirmModal()
   → check_csv_no_change_modal == true なら直接 uploadCsv()
   → そうでなければ確認モーダル表示 → 確認モーダルの「アップロード」 → uploadCsv()
   ```
   確認モーダル側のボタンも `[ladda]='sending'` (line 1050) で制御されている。

5. **`changeCsv(event)` (line 1992-2003)**: ファイル選択時は`sending`フラグに触れない。テスト側で`setInputFiles`を使った場合、Angularの`(change)`イベントが発火しない可能性があり、`this.csv`がnullのままになるケースがある。

### 対策案

| 優先度 | 対策 | 効果 |
|--------|------|------|
| **A (テスト側)** | `setInputFiles`後にAngularの`changeCsv`イベントを手動トリガーする | ファイル選択を確実にAngularに通知 |
| **B (テスト側)** | アップロードボタンクリック前に`sending`フラグをfalseにリセット: `page.evaluate(() => { document.querySelector('.modal button.btn-primary')?.removeAttribute('disabled'); })` | disabled回避（既に一部実装済み） |
| **C (プロダクト側)** | `openCsvModal()`実行時に`this.sending = false`をリセットする | モーダルオープンごとにフラグクリア |

---

## 4. サーバーリソース状況

### ECS

| 項目 | 値 |
|------|-----|
| クラスター | `pigeoncloud-staging-cluster-v2` |
| サービス | `pigeoncloud-staging-v2` |
| 状態 | ACTIVE |
| 希望タスク数 | 1 |
| 実行中タスク数 | **2** (PRIMARY=1, ACTIVE=1 ← 前回デプロイの残) |
| タスクCPU | 2048 (2 vCPU) |
| タスクメモリ | 4096 MB (4 GB) |

**問題**: desiredCount=1なのにrunningCount=2。旧デプロイメントのタスクが1つ残っている（ドレイン中）。これはリソースに影響を与えないが、デプロイの安定性に関わる。

### RDS

| 項目 | 値 |
|------|-----|
| インスタンスID | `pigeoncloud-staging-mysql` |
| クラス | `db.t4g.large` (2 vCPU / 8 GB RAM) |
| 状態 | available |
| エンジン | MySQL |
| Multi-AZ | No |
| ストレージ | 100 GB |

**問題**: Single-AZで冗長性なし。t4g.largeは本番ワークロードには小さめだが、ステージング環境としては妥当。

### ALB

| 項目 | 値 |
|------|-----|
| ALB名 | `pigeoncloud-staging-alb-new` |
| アイドルタイムアウト | **60秒** ← **これがcreate-all-type-table 504の直接原因** |

### PHP設定

| 項目 | 値 |
|------|-----|
| `max_execution_time` (php.ini) | 90秒 |
| `set_time_limit` (debug-tools.php) | 120秒 |
| `set_time_limit` (script.php exec) | exec中はカウントされない |

### CloudWatch Logs（直近2時間）

- **ERROR**: `ResourceNotFoundException`（Secrets Manager）、PDOException（`job_logs`テーブル不存在）が散見
- **504/timeout**: 直接的な504ログは確認できず（ALBログは別のロググループの可能性）
- **create-all-type**: 直近24時間でcreate-all-type-tableの実行ログなし

---

## 総合評価と推奨対策

### 即効性のある対策（テスト側）

1. **ALBタイムアウト延長**: `idle_timeout.timeout_seconds` を60→120に変更（要ユーザー確認・WRITE操作）
2. **テスト側ポーリング最大時間の延長**: `maxPolls`を20→30に（200秒→300秒）
3. **CSVアップロードテスト**: `setInputFiles`後にchangeイベントを手動ディスパッチ

### 中期対策（プロダクト側）

4. **debug APIの非同期化**: create-all-type-tableをバックグラウンドジョブに変更し、ステータスポーリングで完了検出
5. **ALLテストテーブルのフィールド数削減**: 97フィールドの`show-list`を必要最小限に
6. **CSVモーダルオープン時のsendingリセット**: `openCsvModal()`に`this.sending = false`を追加

### 関連ファイル

| ファイル | 内容 |
|----------|------|
| `/Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/routes/admin/debug-tools.php` | debug API定義（create-all-type-table呼び出し） |
| `/Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/routes_script/background_debug.php:6669-8020` | create-all-type-table実処理 |
| `/Users/yasaipopo/PycharmProjects/pigeon-test/tests/helpers/table-setup.js` | テスト側ヘルパー（ポーリング方式） |
| `/Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/html_angular4/src/app/admin/admin.component.html:1015` | CSVアップロードボタン（Ladda） |
| `/Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/html_angular4/src/app/admin/admin.component.ts:2030-2140` | uploadCsv()処理 |
