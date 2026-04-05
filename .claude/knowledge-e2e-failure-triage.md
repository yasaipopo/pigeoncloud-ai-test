# E2Eテスト フェイル種別と切り分け基準

最終更新: 2026-04-05

---

## フェイルの4種類

| 種別 | ラベル | 意味 | 対処 |
|---|---|---|---|
| **A: 環境依存（一時的）** | `FLAKY` | タイミング・サーバー負荷・ネットワークによる不安定なfail | 再実行で確認。連続2回failなら他の種別を疑う |
| **B: テストコードのバグ** | `SPEC_BUG` | セレクター・手順・アサーションが間違っている | spec.jsを修正 |
| **C: プロダクトのバグ** | `PRODUCT_BUG` | PigeonCloudの実装に問題がある | `.claude/product-bugs.md`に記録し開発チームへ報告 |
| **D: インフラ・設定の問題** | `INFRA_BUG` | テスト環境作成失敗・DB枯渇・Angularルーティング問題など | インフラ修正 or navigateToTable等のヘルパー修正 |

---

## 切り分けフロー

```
テストfail
  ↓
① 同じテストを再実行（AGENT_NUM変えて別環境で）
  ├─ 再実行でpass → 【A: FLAKY】環境依存。2回に1回以上failなら修正検討
  └─ 再実行でもfail → ②へ
  ↓
② エラーメッセージ・スクリーンショットを確認
  ├─ "timeout" / "navigation" / "Test ended" / "waitForSelector" 系
  │   ├─ beforeAll/beforeEachで詰まっている → 【D: INFRA_BUG】ログイン・テーブル作成問題
  │   └─ テスト本体で詰まっている → セレクターが存在しない可能性 → ③へ
  ├─ "500 Internal Server Error" / "エラーが発生しました" が画面に → 【C: PRODUCT_BUG】
  ├─ URLが期待と違う（dashboardにリダイレクト等） → 【D: INFRA_BUG】navigateToTable問題
  └─ 要素が見つからない / テキストが違う → ③へ
  ↓
③ MCP Playwright or スクリーンショットで実際のUIを確認
  ├─ UIが仕様通りに動いているがセレクターが違う → 【B: SPEC_BUG】セレクター修正
  ├─ UIが表示されているが動作がおかしい → 【C: PRODUCT_BUG】
  ├─ UIそのものが表示されていない（機能削除・変更） → 【B: SPEC_BUG】テスト仕様変更
  └─ UIが存在するのにクリック・入力できない → 【B: SPEC_BUG】手順・タイミング問題
```

---

## 種別ごとの詳細と典型パターン

### A: FLAKY（環境依存・一時的）

**典型エラー:**
- `waitForSelector: Timeout 15000ms exceeded` （たまに）
- `navigateToTable` のリトライ消費
- `createTestEnv` のポーリングが長引く
- RDS/サーバー高負荷時間帯のタイムアウト

**判断基準:**
- 同じコミットで再実行するとpassになる
- 時間帯によって結果が変わる（深夜帯はpass、昼間はfail等）
- エラーメッセージが毎回少し違う

**対処:**
- まず再実行（別AGENT_NUM推奨）
- 2回連続failなら SPEC_BUG or INFRA_BUG を疑う
- 頻度が高い場合は waitFor のタイムアウト値を上げる or navigateToTable のリトライ数を増やす

---

### B: SPEC_BUG（テストコードのバグ）

**典型エラー:**
- `expect(locator).toBeVisible()` → element not found
- `page.click('...')` → element not found or not clickable
- `expect(text).toContain('...')` → テキストが実UIと一致しない
- テスト本体でセレクターが古い（class名変更・DOM構造変更）

**判断基準:**
- スクリーンショットを見ると画面は正常表示されている
- 期待していたセレクター/テキストが実UIと違う
- 直前に spec.js を修正してから fail が増えた（リグレッション）

**対処:**
- MCP Playwright で実UIを確認してセレクターを修正
- テスト手順・アサーションを実UIに合わせて修正
- spec.js 修正後は単体実行で確認してからコミット

---

### C: PRODUCT_BUG（プロダクトのバグ）

**典型エラー:**
- 画面に `Internal Server Error` / `エラーが発生しました` が表示される
- データが保存されない / 取得できない
- 本来表示されるべきUIが消えている
- 500/404 HTTPエラー

**判断基準:**
- スクリーンショットにエラー画面が写っている
- 別の環境（本番等）で同じ手順を踏んでも再現する
- テストコードを変えても fail し続ける
- 過去passだったのに最新の pigeon_cloud デプロイ後から fail し始めた

**対処:**
- `.claude/product-bugs.md` に記録（症状・再現手順・スクリーンショット）
- 開発チームに報告
- テストコードは変更しない（バグを隠蔽しない）
- 修正されるまで `test.skip` で一時スキップ可（但し必ずコメントに理由を書く）

---

### D: INFRA_BUG（インフラ・設定の問題）

**典型エラー:**
- `page.fill: Test ended`（beforeAll でのログイン処理ハング）
- `"beforeAll" hook timeout of 300000ms exceeded`
- `createTestEnv` 失敗（テーブル作成ポーリングタイムアウト）
- URLが `dashboard` にリダイレクトされる（navigateToTable 問題）
- `storageState` の古い cookie で別環境にアクセスしてしまう

**判断基準:**
- テスト本体ではなく beforeAll/beforeEach で止まっている
- 複数の無関係なテストが同時に fail する（ログイン・テーブル作成の共通処理が壊れた）
- 環境作成 or ナビゲーションのログが異常
- `did not run` が大量に出る（前の describe の beforeAll 失敗で後続がスキップ）

**対処:**
- `helpers/create-test-env.js` / `helpers/navigate-to-table.js` を修正
- `beforeAll`/`beforeEach` のタイムアウト・リトライ設定を見直す
- fill/click に `{ timeout: 15000 }` を付ける
- localStorage.clear() は goto() の後に実行する（ドメイン問題）

---

## 切り分け早見表

| 症状 | まず疑う種別 |
|---|---|
| 再実行でpassになった | A: FLAKY |
| beforeAll/beforeEachで止まる | D: INFRA_BUG |
| 画面にエラーメッセージ | C: PRODUCT_BUG |
| dashboardにリダイレクト | D: INFRA_BUG (navigateToTable) |
| セレクターが見つからない | B: SPEC_BUG (UIと不一致) |
| テキスト・値が違う | B: SPEC_BUG or C: PRODUCT_BUG |
| spec.js修正直後からfail増加 | B: SPEC_BUG (リグレッション) |
| 大量の `did not run` | D: INFRA_BUG (beforeAll失敗) |
| デプロイ直後からfail | C: PRODUCT_BUG |

---

## リグレッション検知ルール

**前回より fail が増えた場合（最重要）:**

```
前回 N fail → 今回 N+M fail (M > 0)
```

1. `git diff HEAD~1` で変更箇所を確認
2. 増えた fail が変更箇所と関係ある spec か確認
3. 関係ある → 【B: SPEC_BUG】修正を revert or 修正し直す
4. 無関係な spec が増えた → 【D: INFRA_BUG】共通ヘルパーを壊した可能性

**CLAUDE.md のルール再確認:**
> 前回よりfailが増えた場合は即座に原因調査。修正がリグレッションを起こした可能性があるため、diffを確認して原因を特定する。

---

## product-bugs.md の記録フォーマット

`.claude/product-bugs.md` に以下の形式で記録する:

```markdown
## {spec名}/{case_no}: {テスト名}

- **発見日**: YYYY-MM-DD
- **症状**: {何が起きているか}
- **期待値**: {テストが期待している動作}
- **実際**: {実際に起きていること}
- **スクリーンショット**: {パス or なし}
- **判定**: C: PRODUCT_BUG
- **対応**: 開発チームに報告 / 修正待ち / 修正済み(YYYY-MM-DD)
```
