#!/bin/bash
# =============================================================
# PigeonCloud E2Eビューアー デプロイスクリプト
#
# 使い方:
#   ./e2e-viewer/deploy.sh [stack-name]
#
# 前提:
#   - AWS CLIインストール済み・プロファイル lof-dev が設定済み
#   - zip コマンドが使える
#
# 実行内容:
#   1. CloudFormationスタックのデプロイ
#   2. Lambda関数コードのアップロード
#   3. フロントエンドをS3にアップロード
#   4. CloudFrontキャッシュ無効化
# =============================================================

set -e

STACK_NAME="${1:-pigeon-e2e-viewer}"
AWS_PROFILE="${AWS_PROFILE:-lof-dev}"
AWS_REGION="ap-northeast-1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# デプロイ時のパスワード（デフォルト: pigeon-e2e-2026）
ADMIN_PASSWORD="${ADMIN_PASSWORD:-pigeon-e2e-2026}"

echo "=== PigeonCloud E2E ビューアー デプロイ ==="
echo "スタック名: ${STACK_NAME}"
echo "プロファイル: ${AWS_PROFILE}"
echo "リージョン: ${AWS_REGION}"
echo ""

# AWS CLIプロファイル確認
if ! aws --profile "${AWS_PROFILE}" sts get-caller-identity > /dev/null 2>&1; then
  echo "ERROR: AWSプロファイル '${AWS_PROFILE}' が使えません"
  echo "  aws configure --profile ${AWS_PROFILE} で設定してください"
  exit 1
fi

# =========================================
# Step 1: CloudFormationデプロイ
# =========================================
echo "[1/4] CloudFormationスタックをデプロイ中..."
aws --profile "${AWS_PROFILE}" --region "${AWS_REGION}" cloudformation deploy \
  --stack-name "${STACK_NAME}" \
  --template-file "${SCRIPT_DIR}/cloudformation/main.yml" \
  --parameter-overrides \
    ProjectName="${STACK_NAME}" \
    Environment="prod" \
    AdminPassword="${ADMIN_PASSWORD}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset

echo "  CloudFormationデプロイ完了"

# =========================================
# CloudFormation Outputs取得
# =========================================
get_output() {
  aws --profile "${AWS_PROFILE}" --region "${AWS_REGION}" cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

LAMBDA_FUNCTION_NAME="${STACK_NAME}-api"
FRONTEND_BUCKET=$(get_output FrontendBucketName)
ASSETS_BUCKET=$(get_output AssetsBucketName)
CLOUDFRONT_URL=$(get_output CloudFrontURL)
LAMBDA_URL=$(get_output ApiUrl)

echo ""
echo "  フロントエンドバケット: ${FRONTEND_BUCKET}"
echo "  アセットバケット: ${ASSETS_BUCKET}"
echo "  CloudFront URL: ${CLOUDFRONT_URL}"
echo "  API Gateway URL: ${LAMBDA_URL}"

# =========================================
# Step 2: Lambda関数コードのアップロード
# =========================================
echo ""
echo "[2/4] Lambda関数をアップロード中..."

LAMBDA_ZIP="/tmp/pigeon-e2e-lambda.zip"
rm -f "${LAMBDA_ZIP}"

cd "${SCRIPT_DIR}/backend/lambda"
zip -q "${LAMBDA_ZIP}" index.py
cd - > /dev/null

aws --profile "${AWS_PROFILE}" --region "${AWS_REGION}" lambda update-function-code \
  --function-name "${LAMBDA_FUNCTION_NAME}" \
  --zip-file "fileb://${LAMBDA_ZIP}" \
  --query "FunctionName" \
  --output text

echo "  Lambda関数アップロード完了"

# Lambda更新完了を待つ
aws --profile "${AWS_PROFILE}" --region "${AWS_REGION}" lambda wait function-updated \
  --function-name "${LAMBDA_FUNCTION_NAME}"

# =========================================
# Step 3: フロントエンドをS3にアップロード
# =========================================
echo ""
echo "[3/4] フロントエンドをS3にアップロード中..."

# /tmp/ にコピーして __API_URL__ を実際のURLに置換してからアップ
FRONTEND_TMP="/tmp/e2e-viewer-frontend"
rm -rf "${FRONTEND_TMP}"
cp -r "${SCRIPT_DIR}/frontend/" "${FRONTEND_TMP}/"

# __API_URL__ を実際の API Gateway URL で置換（全HTMLファイル対象）
find "${FRONTEND_TMP}" -name "*.html" -exec \
  sed -i '' "s|__API_URL__|${LAMBDA_URL}|g" {} \;

echo "  API URL埋め込み完了: ${LAMBDA_URL}"

aws --profile "${AWS_PROFILE}" --region "${AWS_REGION}" s3 sync \
  "${FRONTEND_TMP}/" \
  "s3://${FRONTEND_BUCKET}/" \
  --delete \
  --cache-control "max-age=300"

echo "  フロントエンドアップロード完了"

# =========================================
# Step 3.5: spec一覧をアップロード
# =========================================
echo ""
echo "[3.5/4] spec一覧をアップロード中..."
cd "${SCRIPT_DIR}/.."
if E2E_API_URL="${LAMBDA_URL}" E2E_API_PASSWORD="${ADMIN_PASSWORD}" python3 e2e-viewer/upload_specs.py 2>&1; then
  echo "  spec一覧アップロード完了"
else
  echo "  WARNING: spec一覧アップロード失敗（スキップ）"
fi
cd - > /dev/null

# =========================================
# Step 4: CloudFrontキャッシュ無効化
# =========================================
echo ""
echo "[4/4] CloudFrontキャッシュを無効化中..."

DISTRIBUTION_ID=$(aws --profile "${AWS_PROFILE}" --region "${AWS_REGION}" cloudfront list-distributions \
  --query "DistributionList.Items[?Origins.Items[0].DomainName=='${FRONTEND_BUCKET}.s3.ap-northeast-1.amazonaws.com'].Id" \
  --output text)

if [ -n "${DISTRIBUTION_ID}" ]; then
  aws --profile "${AWS_PROFILE}" cloudfront create-invalidation \
    --distribution-id "${DISTRIBUTION_ID}" \
    --paths "/*" \
    --query "Invalidation.Id" \
    --output text
  echo "  キャッシュ無効化開始（反映まで約1-2分）"
else
  echo "  CloudFrontディストリビューションIDが取得できませんでした（スキップ）"
fi

# =========================================
# 完了
# =========================================
echo ""
echo "=== デプロイ完了 ==="
echo ""
echo "  フロントエンドURL: ${CLOUDFRONT_URL}"
echo "  API Gateway URL: ${LAMBDA_URL}"
echo ""
echo "  ログイン:"
echo "  URL: ${CLOUDFRONT_URL}/login.html"
echo "  パスワード: \${ADMIN_PASSWORD} (デフォルト: pigeon-e2e-2026)"
echo ""
echo "  upload_results.py での使い方:"
echo "  E2E_API_URL='${LAMBDA_URL}' python e2e-viewer/upload_results.py \\"
echo "    --reports-dir reports/agent-1 \\"
echo "    --agent-num 1"
echo ""
echo "  パスワードを変更する場合:"
echo "  ADMIN_PASSWORD='新パスワード' ./e2e-viewer/deploy.sh ${STACK_NAME}"
