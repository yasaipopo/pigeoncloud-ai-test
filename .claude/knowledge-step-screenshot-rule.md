# ステップスクリーンショット撮影ルール

最終更新: 2026-04-07

## 基本ルール

### いつ撮るか
- **✅ マークがある行は全て撮る**（同じ画面でも1行ずつ撮る）
- 📷アイコンが付く行にファイルがないと壊れた画像が表示されるため、漏れなく撮ること
- ✅ がなくても**目視確認が必要な画面遷移の結果**には撮る

### 命名規則
- `{stepId}-s{N}.jpg` — N はフロー内の番号（✅ がある行の番号）
- 同じ画面の連続 ✅ は最後の番号を使う
  - 例: `3. ✅ div.warning が表示` + `4. ✅ テキスト含む` → `auth-010-s4.jpg`（1枚でOK）

### 何を撮るか
- **テスト対象のページ**を撮る（`page` ではなく `firefoxPage` 等、操作している画面）
- 画面全体ではなくビューポート表示（`fullPage: false`）
- JPEG quality: 30（軽量）

## 具体例

### auth-010: 推奨ブラウザ警告
```
1. Firefox UA を偽装して /admin/login を開く
2. admin / パスワード でログインしてダッシュボードに遷移
3. ✅ div.warning が表示されること        ← ここと4は同じ画面
4. ✅ 「推奨されている...」が含まれること  ← s4 で1枚撮る
```
→ `auth-010-s4.jpg`（警告バー表示画面）

### auth-020: マスターログイン/ログアウト
```
1. /admin/login を開き admin / パスワードを入力してログイン
2. ✅ ダッシュボードに遷移し .navbar が表示されること  ← s2 で撮る
3. アバターアイコン → ログアウトメニューをクリック
4. ✅ /admin/login に戻ること                           ← s4 で撮る
```
→ `auth-020-s2.jpg`（ダッシュボード表示）+ `auth-020-s4.jpg`（ログインページに戻った画面）

### auth-030: ユーザーログイン/ログアウト
```
1. テストユーザーを作成
2. テストユーザーでログイン
3. ✅ ダッシュボードに遷移し .navbar が表示されること  ← s3 で撮る
4. ログアウト → ✅ /admin/login に戻ること              ← s4 で撮る
```
→ `auth-030-s3.jpg` + `auth-030-s4.jpg`

## 撮らなくていい場合
- API呼び出しだけのステップ（画面変化なし）
- 次のステップですぐ画面が変わる中間操作

## 実装パターン
```javascript
// ✅ の直後に撮影
await expect(page.locator('.navbar')).toBeVisible();
await stepScreenshot(page, 'auth', 'AT01', 'auth-020-s2', _testStart);

// 別コンテキスト(firefoxPage等)の場合はそちらで撮影
await expect(warningEl.first()).toBeVisible();
await stepScreenshot(firefoxPage, 'auth', 'AT01', 'auth-010-s4', _testStart);
```

## フロントエンド側の表示
- detailedFlow 内の `N. ✅` の横に 📷 アイコンが自動表示
- クリックで `steps/{spec}/{movie}/{stepId}-sN.jpg` を取得して表示
