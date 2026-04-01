# Playwright トークン節約ルール

## ルール: MCP Playwright は使わず、Playwright CLI を使う

### 理由
MCP Playwrightのスナップショットは1回数千トークン消費する。CLIなら必要な情報だけ取得できる。

### AIからブラウザ操作する場合
```bash
# ❌ MCP Playwright（トークン大量消費）
mcp__playwright__browser_navigate
mcp__playwright__browser_snapshot

# ✅ Playwright CLIスクリプト（トークン節約）
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://ai-test.pigeon-demo.com/admin/login');
  await page.fill('#id', 'admin');
  await page.fill('#password', '10b21o7bLe3H');
  await page.click('button[type=submit]');
  await page.waitForSelector('.navbar');
  // 必要な情報だけ取得
  const text = await page.innerText('.some-selector');
  console.log(text);
  await browser.close();
})();
"
```

### テスト実行
```bash
# テスト実行は常にCLI
npx playwright test tests/xxx.spec.js --reporter=list
```

### 例外
- ユーザーが明示的にMCP Playwrightを使うよう指示した場合のみ使用可
