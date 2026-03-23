# PigeonCloud E2E テスト結果ビューアー

Playwright E2Eテスト結果をウェブブラウザで見やすく表示するシステム。

## 現在の環境

| 項目 | 値 |
|---|---|
| フロントエンドURL | https://dezmzppc07xat.cloudfront.net |
| API Gateway URL | https://ausatkfji9.execute-api.ap-northeast-1.amazonaws.com |
| ログインパスワード | `pigeon-e2e-2026` |
| AWSプロファイル | `lof-dev` |
| CFnスタック名 | `pigeon-e2e-viewer` |
| リージョン | `ap-northeast-1` |

## アーキテクチャ

```
[テスト実行完了]
      ↓
upload_results.py
  ├── playwright-results.json をパース
  ├── 動画/スクショ → S3 (presigned URL経由)
  └── テスト結果 → API Gateway → Lambda → DynamoDB

[ブラウザ]
  → CloudFront → S3 (login.html / index.html / run.html)
  → API Gateway → Lambda → DynamoDB / S3 presigned URL
```

## 構成コンポーネント

| コンポーネント | リソース名 | 役割 |
|---|---|---|
| **S3** (frontend) | `pigeon-e2e-viewer-frontend-{accountId}` | HTML静的ファイル（CloudFront経由） |
| **S3** (assets) | `pigeon-e2e-viewer-assets-{accountId}` | 動画・スクショ・トレース（90日TTL） |
| **DynamoDB** (runs) | `pigeon-e2e-viewer-runs` | テスト実行履歴 |
| **DynamoDB** (cases) | `pigeon-e2e-viewer-cases` | テストケース結果 |
| **Lambda** | `pigeon-e2e-viewer-api` | REST API (Python 3.12) |
| **API Gateway** | HTTP API | Lambda呼び出しエンドポイント |
| **CloudFront** | - | フロントエンドHTTPS配信 |

## ディレクトリ構成

```
e2e-viewer/
├── cloudformation/
│   └── main.yml          ← CloudFormationテンプレート（全リソース定義）
├── backend/
│   └── lambda/
│       └── index.py      ← Lambda関数（API処理・認証）
├── frontend/
│   ├── login.html        ← ログインページ
│   ├── index.html        ← 実行履歴一覧（__API_URL__ プレースホルダー）
│   └── run.html          ← 実行詳細（テストケース・動画・スクショ）
├── upload_results.py     ← テスト結果アップロードスクリプト
├── deploy.sh             ← デプロイスクリプト
└── README.md
```

## デプロイ手順

### 初回 / 更新デプロイ

```bash
# プロジェクトルートから実行
./e2e-viewer/deploy.sh pigeon-e2e-viewer

# パスワードを変更してデプロイ
ADMIN_PASSWORD=新しいパスワード ./e2e-viewer/deploy.sh pigeon-e2e-viewer
```

deploy.shが実行すること:
1. CloudFormationスタック作成/更新
2. Lambdaコードをzip化してアップロード
3. フロントHTMLを `/tmp/e2e-viewer-frontend/` にコピーし `__API_URL__` を実際のURLに置換してS3へアップ
4. CloudFrontキャッシュ無効化

## テスト結果のアップロード

```bash
# テスト完了後に実行
E2E_API_URL='https://ausatkfji9.execute-api.ap-northeast-1.amazonaws.com' \
python3 e2e-viewer/upload_results.py \
  --reports-dir reports/agent-1 \
  --agent-num 1 \
  --test-env-url "${TEST_BASE_URL}"

# 内容確認のみ（実際のアップロードなし）
E2E_API_URL='...' python3 e2e-viewer/upload_results.py --reports-dir reports/agent-1 --dry-run
```

### オプション

| オプション | 説明 | デフォルト |
|---|---|---|
| `--reports-dir` | レポートディレクトリ | `reports/agent-1` |
| `--api-url` | APIエンドポイント（`E2E_API_URL`環境変数でも可） | - |
| `--agent-num` | エージェント番号 | `1` |
| `--test-env-url` | テスト環境URL | `TEST_BASE_URL`環境変数 |
| `--password` | APIパスワード（`E2E_API_PASSWORD`環境変数でも可） | `pigeon-e2e-2026` |
| `--dry-run` | 確認のみ、実際のアップロードなし | - |

### playwright-results.json について

`playwright.config.js` に `['json', { outputFile: ... }]` が設定されているため、
`npx playwright test` を通常通り実行すれば自動生成される。

`--reporter=list` のみで実行した場合はJSONが生成されないため、
その場合は `runner/aggregate_playwright_results.py` でrepair_run.logから
`reports/results.json` を生成し、upload_results.pyは `reports/results.json` からも
読み込み可能（今後の対応）。

## 認証

- ログインパスワードはCloudFormation `AdminPassword` パラメータで管理
- Lambdaが `sha256(password + salt)` でトークンを生成
- フロントはlocalStorageにトークンを保存、全APIリクエストに `Authorization: Bearer` ヘッダーを付与
- パスワード変更: `ADMIN_PASSWORD=新パスワード ./e2e-viewer/deploy.sh pigeon-e2e-viewer`

## APIエンドポイント

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| `POST` | `/auth/login` | なし | ログイン（tokenを返す） |
| `GET` | `/runs` | 必要 | 実行履歴一覧 |
| `POST` | `/runs` | 必要 | 実行登録 |
| `GET` | `/runs/{runId}` | 必要 | 実行詳細 |
| `PUT` | `/runs/{runId}` | 必要 | 実行情報更新 |
| `GET` | `/runs/{runId}/cases` | 必要 | テストケース一覧（`?status=failed`でFAILのみ） |
| `POST` | `/runs/{runId}/cases` | 必要 | テストケース一括登録 |
| `POST` | `/assets/upload-url` | 必要 | S3アップロード用presigned URL発行 |
| `POST` | `/assets/download-url` | 必要 | S3ダウンロード用presigned URL発行 |

## コスト見積もり

テスト100回/月、500件/回、動画5MB/件として:

| サービス | 費用 |
|---|---|
| DynamoDB | ~$0.10 |
| Lambda + API Gateway | ~$0.00（無料枠内） |
| S3 (assets, 50GB) | ~$1.00 |
| CloudFront | ~$0.10 |
| **合計** | **~$1.20/月** |

## スタック削除

```bash
ACCOUNT_ID=$(aws --profile lof-dev sts get-caller-identity --query Account --output text)
aws --profile lof-dev s3 rm s3://pigeon-e2e-viewer-assets-${ACCOUNT_ID}/ --recursive
aws --profile lof-dev s3 rm s3://pigeon-e2e-viewer-frontend-${ACCOUNT_ID}/ --recursive
aws --profile lof-dev --region ap-northeast-1 cloudformation delete-stack --stack-name pigeon-e2e-viewer
```
