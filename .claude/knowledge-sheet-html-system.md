# sheet.html システム — 仕組みと必須手順

最終更新: 2026-04-08

---

## sheet.htmlとは

`https://dezmzppc07xat.cloudfront.net/sheet.html`

テスターが動画・スクショ・detailedFlowをまとめて目視確認するUI。  
pipeline DynamoDBテーブルを参照して表示する。

---

## 動画の仕組み

### 保存場所（Playwright）
テスト実行時に自動録画される:
```
reports/agent-N/videos/{日付}_{コミット}/{spec}-{テスト名}-{movie}-chromium/video.webm
```

### S3へのアップロード
`upload_results.py` が動画をS3 `runs/{runId}/{caseId}/video/video.webm` にアップロードする。

### sheet.htmlが動画を見つける仕組み（3段階フォールバック）
```
1. pipeline.stagingRunId → runs API → videoKey → download URL
2. pipeline.videoKey → download URL
3. videos/{spec}/{movie}/video.webm（旧パス）
```

### ⚠️ 絶対に忘れてはいけない: sync-results の呼び出し
upload_results.py だけでは **pipeline テーブルに runId が紐付かない**。  
動画を表示させるには必ず sync-results を呼ぶこと:

```bash
source .env && TOKEN=$(python3 -c "
import hashlib; print(hashlib.sha256('pigeon-e2e-2026pigeon-e2e-viewer-salt-2026'.encode()).hexdigest())
") && curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "${E2E_API_URL}/pipeline/sync-results" \
  -d "{\"runId\":\"${RUN_ID}\",\"env\":\"staging\"}"
```

RUN_ID は upload_results.py の出力に表示される:
```
実行ID: 20260408_020000_abc1234_agent1  ← これがRUN_ID
```

---

## スクショの仕組み

### sheet.htmlが期待するファイル名（2種類）

**1. ケースヘッダー📷**（`dash-040 📷 ──` の📷クリック時）:
```
steps/{spec}/{movie}/{caseNo}.jpg
```

**2. ✅行📷**（`14. ✅ 📷` の📷クリック時）:
```
steps/{spec}/{movie}/{caseNo}-s{lineNum}.jpg
```

- **caseNo**: detailedFlow内で直前に検出された `(\w+-\d{3})\s` のID（**各ケースのcase_no**、firstCaseNoではない！）
- **lineNum**: ✅行の行頭番号 `(\d+)\.`

例: dash-040の✅が行14にある場合:
```
steps/dashboard/DB01/dash-040.jpg      ← ケースヘッダー
steps/dashboard/DB01/dash-040-s14.jpg  ← ✅行14
```

**重要**: sheet.htmlのフロントエンドコード（1318-1344行目）を根拠としている。推測でファイル名を決めない。

### ⚠️ 絶対に手動でファイル名を付けてはいけない
必ず `autoScreenshot` ヘルパーを使うこと。手動だと命名ミスが起きる。

```javascript
// spec.jsの先頭
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const autoScreenshot = createAutoScreenshot('dashboard');

// テスト内で（caseNo + 何番目の✅か）
await autoScreenshot(page, 'DB01', 'dash-010', 0, _testStart); // 0番目の✅
await autoScreenshot(page, 'DB01', 'dash-010', 1, _testStart); // 1番目の✅
await autoScreenshot(page, 'DB01', 'dash-020', 0, _testStart); // dash-020の0番目の✅
```

`autoScreenshot` は `screenshot-map.json` を参照して正しいファイル名を自動算出する。

### screenshot-map.jsonの再生成
yamlを変更したら必ず再生成すること:
```bash
python3 scripts/generate-screenshot-map.py
```

---

## テスト実行からsheet.html表示までの完全フロー

```bash
# 1. テスト実行（run-test.sh経由でREPORTS_DIRが正しく設定される）
AGENT_NUM=1 SKIP_GLOBAL_SETUP=1 bash run-test.sh tests/dashboard.spec.js --workers=1

# 2. スクショをS3にアップロード
python3 e2e-viewer/upload_step_screenshots.py --reports-dir reports/agent-1 --api-url "$E2E_API_URL"

# 3. テスト結果（動画含む）をS3にアップロード → RUN_IDを控える
python3 e2e-viewer/upload_results.py --reports-dir reports/agent-1 --api-url "$E2E_API_URL" --agent-num 1
# → 出力: 実行ID: 20260408_XXXXXX_YYYYYYY_agent1

# 4. yaml specsをpipeline DBに同期
E2E_API_URL="$E2E_API_URL" python3 e2e-viewer/upload_yaml_specs.py --spec dashboard

# 5. ★必須★ sync-results でpipelineにrunIdを紐付ける
TOKEN=$(python3 -c "import hashlib; print(hashlib.sha256('pigeon-e2e-2026pigeon-e2e-viewer-salt-2026'.encode()).hexdigest())")
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "${E2E_API_URL}/pipeline/sync-results" \
  -d '{"runId":"20260408_XXXXXX_YYYYYYY_agent1","env":"staging"}'

# 6. sheet.htmlで確認
# https://dezmzppc07xat.cloudfront.net/sheet.html
# → specタブを選択 → 動画再生 → 📷スクショクリック
```

---

## よくある失敗と対処

| 症状 | 原因 | 対処 |
|---|---|---|
| 動画が再生されない | sync-resultsを呼んでいない | 上記5のコマンドを実行 |
| 📷をクリックしても画像が出ない | autoScreenshotを使っていない/ファイル名が違う | autoScreenshotに切り替え + screenshot-map.json再生成 |
| スクショのS3パスが404 | yamlのdetailedFlowの行番号とファイル名がずれている | generate-screenshot-map.pyを実行してから再テスト |
| playwright-results.jsonがない | run-test.sh経由で実行していない | `bash run-test.sh` を使う（REPORTS_DIRが正しくセットされる） |

---

## 確認の鉄則

**「アップロード完了」のログだけ見て完了と判断しない。**  
必ず sheet.html を実際に開いて:
1. 動画が再生されること
2. 📷アイコンをクリックしてスクショが表示されること

を目視確認してから完了とする。
