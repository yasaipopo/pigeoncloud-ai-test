# PigeonCloud テストエージェント

PigeonCloudのステージング環境に対して自律的にE2Eテストを実行し、
問題があればClaudeが調査・判断・対応するDocker環境。

## セットアップ

```bash
# 1. 環境設定
cp .env.example .env
vi .env   # 必要な値を入力

# 2. PigeonCloudソースをclone（調査用・gitignore対象）
./setup.sh

# 3. Dockerビルド＆実行
docker-compose up --build
```

## フロー

```
run_agent.sh
  ↓
① Playwrightテスト実行（scenarios/*.yaml）
  ↓ 失敗あり
② Claude が画面を見て調査
  ├── 仕様変更 → scenarios/*.yaml を自動更新
  └── 不具合   → Slack通知
```

## ディレクトリ構成

```
pigeon-test/
├── Dockerfile
├── docker-compose.yml
├── .env.example        ← コミットOK
├── .env                ← gitignore（認証情報）
├── setup.sh            ← 初回セットアップ
├── run_agent.sh        ← エントリーポイント
├── agent_instructions.md ← Claudeへの指示書
├── requirements.txt
├── runner/
│   ├── test_runner.py  ← YAMLを読んでPlaywright実行
│   └── reporter.py     ← Slack通知
├── scenarios/          ← テストシナリオ（YAML）
├── reports/            ← gitignore（生成物）
└── src/                ← gitignore（pigeon_cloudソース）
    └── pigeon_cloud/
```

## シナリオYAMLの書き方

```yaml
name: シナリオ名
steps:
  - action: navigate
    value: /admin/login
  - action: fill
    selector: "#email"
    value: "{{ TEST_EMAIL }}"
  - action: click
    selector: "button[type=submit]"
assertions:
  - type: url_contains
    value: /admin/dashboard
  - type: element_visible
    selector: ".sidebar-menu"
screenshot: false
```

## Docker イメージのビルド・更新

### 初回ビルド

```bash
docker build -t pigeon-test_agent-1 .
```

### Playwright バージョンを上げたとき

`package.json` の `@playwright/test` バージョンを変更したら必ずイメージを再ビルドすること。

```bash
docker build -t pigeon-test_agent-1 .
```

**理由:** `Dockerfile` では `npm install` 後に `npx playwright install chromium` を実行して、
その npm バージョンに対応した Chromium をイメージにベイクしている。
再ビルドしないと起動のたびに Chromium（約180MB）がダウンロードされる。

```dockerfile
# Dockerfile の該当箇所
RUN npm install && ...

# npmバージョンに合わせたChromiumをイメージに焼き込む
RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx playwright install chromium --with-deps
```

### npm バージョンと Chromium の対応

| @playwright/test | Chromium |
|---|---|
| 1.44.x | chromium-1117 |
| 1.58.x | chromium-1208 |

## 注意事項

- `.env` は絶対にgitにコミットしない
- `src/` はgitignore済み（pigeon_cloudの機密情報を含む可能性）
- `reports/` はgitignore済み（スクリーンショット等の生成物）
- ステージングのテスト専用テナントのみ操作すること
