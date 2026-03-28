# 調査: 第15回テスト Agent-31 workflow系テスト 31-34秒fail

## 調査日: 2026-03-29

## 対象テスト
- workflow 11-1〜11-6（ワークフロー基本動作）
- workflow 21-1〜21-4（ワークフロー設定）

## 根本原因: ネットワーク切断 (ERR_INTERNET_DISCONNECTED)

### エラーの詳細
全ての失敗テストで同一のエラーパターン:
```
TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.
  - waiting for locator('#id') to be visible
  → 行19: await page.goto(BASE_URL + '/admin/login');
  → 行21: await page.waitForSelector('#id', { timeout: 30000 });
```

### なぜ31-34秒でfailするか
1. `page.goto()` がERR_INTERNET_DISCONNECTEDで即座に失敗（ページは空のまま）
2. `page.waitForLoadState('domcontentloaded')` はすぐ通過（空ページでもdocumentは存在する）
3. `page.waitForSelector('#id', { timeout: 30000 })` が30秒間 `#id` を探すが、ページが空なので見つからない
4. 30秒のタイムアウト + goto/waitの初期化で合計31-34秒でfail

### 補足: beforeAll エラー
repair_run.logに以下が6回出現:
```
beforeAll table creation error (ignored): page.goto: net::ERR_INTERNET_DISCONNECTED at https://tmptestai2026032900391831.pigeon-demo.com/admin/dashboard
```
→ テーブル作成のbeforeAllもネットワーク切断で失敗しているが `(ignored)` で無視されて後続テストが進む

## 結論
- **setTimeoutが短い（30秒）のが直接原因ではない**
- **サーバーへのネットワーク接続自体が切れていた**（ERR_INTERNET_DISCONNECTED）
- gotoが失敗しても例外が投げられずにwaitForSelectorまで到達→30秒timeout
- テスト実行環境（Docker Agent-31）とpigeon-demo.comの間で一時的なネットワーク断が発生

## 修正内容

### workflow.spec.js の login() 関数を強化
- `page.goto()` にリトライ機構を追加（最大3回、5秒間隔）
- goto の timeout を 60秒に延長
- `waitUntil: 'domcontentloaded'` を明示指定
- `#id` セレクタの待機タイムアウトを 30秒→60秒 に延長

### 修正前
```javascript
async function login(page, email, password) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#id', { timeout: 30000 });
```

### 修正後
```javascript
async function login(page, email, password) {
    // ネットワーク一時切断からの回復のため、gotoを最大3回リトライ
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await page.goto(BASE_URL + '/admin/login', { timeout: 60000, waitUntil: 'domcontentloaded' });
            break;
        } catch (e) {
            console.log(`[login] goto attempt ${attempt}/3 failed: ${e.message.split('\n')[0]}`);
            if (attempt === 3) throw e;
            await page.waitForTimeout(5000);
        }
    }
    await page.waitForSelector('#id', { timeout: 60000 });
```

## 残課題
- 他22個のspec.jsにも同じ脆弱なloginパターンがある（今回はworkflow.spec.jsのみ修正）
- 共通のauth-context.jsまたはhelperにリトライ付きloginを集約することを検討すべき
- ネットワーク断の根本原因（Docker環境のネットワーク設定、同時接続数制限など）は別途調査が必要
