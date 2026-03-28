# 調査報告: notifications.spec.js 41件fail (Agent-33 第15回テスト)

## 調査日: 2026-03-29

## 概要
Agent-33のrepair_runで131テスト中41件が失敗。原因は2種類に分類される。

## 失敗の内訳

| カテゴリ | 件数 | 原因 |
|---------|------|------|
| LOADING (読み込み中) | 15件 | ページ遷移後のAngularレンダリング完了を待てていない |
| NET_DISC (ネットワーク切断) | 23件 | `net::ERR_INTERNET_DISCONNECTED` |
| OTHER (コンテキスト破棄等) | 3件 | Execution context destroyed / テーブル未作成 |

## 原因1: LOADINGパターン (15件) - 修正済み

### 根本原因
`page.goto()` 後の待機ロジックにレースコンディションがあった。

#### 問題のコードパターン
```javascript
await page.goto(BASE_URL + '/admin/notification/edit/new');
await page.waitForLoadState('domcontentloaded');
await page.waitForFunction(
    () => !document.body.innerText.includes('読み込み中'),
    { timeout: 30000 }
).catch(() => {});  // ← タイムアウト時にエラーを握りつぶし
await waitForAngular(page);
```

#### 問題点
1. **ネガティブチェックのレースコンディション**: `waitForFunction(() => !body.includes('読み込み中'))` は、Angularがまだ「読み込み中」テキストをDOMに挿入する前にチェックが走ると、即座にtrueを返す
2. **`.catch(() => {})` でエラー握りつぶし**: waitForFunctionがタイムアウトしても例外が捨てられ、ロード未完了のまま次のアサーションに進む
3. **`data-ng-ready="true"` の早期セット**: bodyにdata-ng-ready属性がAngularの初期化時点でセットされるが、SPAの内部ルーティングとコンテンツレンダリングはまだ完了していない

#### 結果
`expect(bodyText).toContain('通知設定')` で失敗。bodyTextは `"☰ / 読み込み中..."` のまま。

### 修正内容
ヘルパー関数 `gotoNotificationEditNew()` を新設し、32箇所のgotoを置換。

```javascript
async function gotoNotificationEditNew(page, expectedText = '通知設定') {
    await page.goto(BASE_URL + '/admin/notification/edit/new', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    });
    await waitForAngular(page);
    // ポジティブチェック: 期待テキストが表示されるまで待つ（catchなし）
    await page.waitForFunction(
        (text) => {
            const body = document.body.innerText;
            return body.includes(text) && !body.includes('読み込み中');
        },
        expectedText,
        { timeout: 30000 }
    );
}
```

**改善点**:
- ネガティブチェック → ポジティブ+ネガティブの複合チェック
- `.catch(() => {})` を削除（タイムアウト時は明示的に失敗させる）
- 全32箇所を統一的なヘルパーに置換

## 原因2: NET_DISCパターン (23件) - 修正不可（環境起因）

### 根本原因
テスト実行中にネットワーク接続が切断された。発生箇所はnotifications.specの後半とusers-permissions.specに集中。

可能性:
- テスト環境(pigeon-demo.com)のサーバー側の一時的な障害
- IPアドレス制限テスト(60-3〜60-14)でテスト環境自身がブロックされた可能性
- Docker/ネットワーク層の問題

### 対応
環境起因のためspec.jsの修正では対応不可。再実行で解消される見込み。

## 修正ファイル
- `tests/notifications.spec.js` - gotoNotificationEditNew ヘルパー追加 + 32箇所のgoto置換
