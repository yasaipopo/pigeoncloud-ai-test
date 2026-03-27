"""
PigeonCloud E2E テスト結果ビューアー - Lambda APIハンドラー
Lambda Function URLで動作するシンプルなREST API
"""

import json
import os
import boto3
import uuid
import hashlib
from datetime import datetime, timezone, timedelta
from boto3.dynamodb.conditions import Key, Attr
from botocore.exceptions import ClientError

# 環境変数
RUNS_TABLE = os.environ.get('RUNS_TABLE', 'pigeon-e2e-viewer-runs')
CASES_TABLE = os.environ.get('CASES_TABLE', 'pigeon-e2e-viewer-cases')
ASSETS_BUCKET = os.environ.get('ASSETS_BUCKET', '')
REGION = os.environ.get('REGION', 'ap-northeast-1')
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'pigeon-e2e-2026')

# トークン生成用固定salt
TOKEN_SALT = 'pigeon-e2e-viewer-salt-2026'


def generate_token(password: str) -> str:
    """パスワードからBearerトークンを生成（sha256固定値）"""
    raw = f"{password}{TOKEN_SALT}"
    return hashlib.sha256(raw.encode()).hexdigest()

# DynamoDBクライアント
dynamodb = boto3.resource('dynamodb', region_name=REGION)
s3_client = boto3.client(
    's3',
    region_name=REGION,
    endpoint_url=f'https://s3.{REGION}.amazonaws.com'
)
runs_table = dynamodb.Table(RUNS_TABLE)
cases_table = dynamodb.Table(CASES_TABLE)

# TTL: 90日後（DynamoDB自動削除）
TTL_DAYS = 90


def get_ttl():
    """90日後のUNIXタイムスタンプを返す"""
    expire_at = datetime.now(timezone.utc) + timedelta(days=TTL_DAYS)
    return int(expire_at.timestamp())


def cors_headers():
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type,x-api-key,authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Content-Type': 'application/json'
    }


def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': cors_headers(),
        'body': json.dumps(body, ensure_ascii=False, default=str)
    }


def verify_token(event) -> bool:
    """Authorizationヘッダーのトークンを検証する"""
    headers = event.get('headers', {}) or {}
    auth_header = headers.get('authorization', '') or headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return False
    token = auth_header[len('Bearer '):]
    expected = generate_token(ADMIN_PASSWORD)
    return token == expected


def handler(event, context):
    """Lambda Function URLのメインハンドラー"""
    method = event.get('requestContext', {}).get('http', {}).get('method', 'GET')
    path = event.get('rawPath', '/')

    # CORSプリフライト
    if method == 'OPTIONS':
        return {'statusCode': 200, 'headers': cors_headers(), 'body': ''}

    # 認証エンドポイント（トークン不要）
    if method == 'POST' and path == '/auth/login':
        return auth_login(event)

    # それ以外のエンドポイントはトークン検証必須
    if not verify_token(event):
        return response(401, {'error': '認証が必要です。ログインしてください。'})

    # ルーティング
    try:
        # GET /runs - 実行一覧
        if method == 'GET' and path == '/runs':
            return get_runs(event)

        # POST /runs - 実行登録
        elif method == 'POST' and path == '/runs':
            return create_run(event)

        # GET /runs/{runId} - 実行詳細
        elif method == 'GET' and path.startswith('/runs/') and path.count('/') == 2:
            run_id = path.split('/')[2]
            return get_run(run_id)

        # PUT /runs/{runId} - 実行更新（完了時のサマリー更新）
        elif method == 'PUT' and path.startswith('/runs/') and path.count('/') == 2:
            run_id = path.split('/')[2]
            return update_run(run_id, event)

        # GET /runs/{runId}/cases - テストケース一覧
        elif method == 'GET' and path.startswith('/runs/') and path.endswith('/cases'):
            run_id = path.split('/')[2]
            return get_cases(run_id, event)

        # POST /runs/{runId}/cases - テストケース結果一括登録
        elif method == 'POST' and path.startswith('/runs/') and path.endswith('/cases'):
            run_id = path.split('/')[2]
            return create_cases(run_id, event)

        # PATCH /runs/{runId}/cases/{caseId} - テストケースのS3キーを更新
        elif method == 'PATCH' and path.startswith('/runs/') and '/cases/' in path:
            parts = path.split('/')
            run_id = parts[2]
            case_id = '/'.join(parts[4:])
            return patch_case(run_id, case_id, event)

        # GET /assets/upload-url - S3署名付きURL発行
        elif method == 'POST' and path == '/assets/upload-url':
            return get_upload_url(event)

        # GET /assets/download-url - S3ダウンロード署名付きURL発行
        elif method == 'POST' and path == '/assets/download-url':
            return get_download_url(event)

        # GET /specs - spec一覧取得
        elif method == 'GET' and path == '/specs':
            return get_specs()

        # PUT /specs - spec一覧更新（upload_specs.pyが呼ぶ）
        elif method == 'PUT' and path == '/specs':
            return put_specs(event)

        else:
            return response(404, {'error': f'Not found: {method} {path}'})

    except Exception as e:
        print(f'ERROR: {e}')
        import traceback
        traceback.print_exc()
        return response(500, {'error': str(e)})


def auth_login(event):
    """
    POST /auth/login - パスワード認証・トークン発行
    ボディ:
      - password: 管理パスワード
    """
    body = json.loads(event.get('body') or '{}')
    password = body.get('password', '')

    if password != ADMIN_PASSWORD:
        return response(401, {'error': 'パスワードが正しくありません'})

    token = generate_token(ADMIN_PASSWORD)
    return response(200, {'token': token})


def get_runs(event):
    """
    GET /runs - テスト実行一覧取得
    クエリパラメータ:
      - limit: 取得件数（デフォルト20）
      - last_key: ページネーションキー
      - status: フィルター（all/running/completed/failed）
    """
    params = event.get('queryStringParameters') or {}
    limit = int(params.get('limit', 20))
    last_key = params.get('last_key')
    status_filter = params.get('status', 'all')

    kwargs = {
        'IndexName': 'createdAt-index',
        'KeyConditionExpression': Key('status').eq('all'),
        'ScanIndexForward': False,  # 新しい順
        'Limit': limit,
    }

    if last_key:
        kwargs['ExclusiveStartKey'] = json.loads(last_key)

    result = runs_table.query(**kwargs)
    items = result.get('Items', [])

    # statusフィルター（all以外の場合）
    if status_filter != 'all':
        items = [i for i in items if i.get('runStatus') == status_filter]

    return response(200, {
        'items': items,
        'count': len(items),
        'last_key': json.dumps(result.get('LastEvaluatedKey')) if result.get('LastEvaluatedKey') else None
    })


def delete_cases_for_run(run_id):
    """指定runIdの既存ケースをすべて削除（runId固定上書き時のリセット用）"""
    try:
        result = cases_table.query(
            KeyConditionExpression=Key('runId').eq(run_id),
            ProjectionExpression='runId, caseId'
        )
        items = result.get('Items', [])
        while result.get('LastEvaluatedKey'):
            result = cases_table.query(
                KeyConditionExpression=Key('runId').eq(run_id),
                ProjectionExpression='runId, caseId',
                ExclusiveStartKey=result['LastEvaluatedKey']
            )
            items.extend(result.get('Items', []))
        with cases_table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={'runId': item['runId'], 'caseId': item['caseId']})
    except Exception as e:
        print(f'delete_cases_for_run error: {e}')


def create_run(event):
    """
    POST /runs - テスト実行登録（runIdが既存の場合は上書き＋ケース削除）
    ボディ:
      - runId: 実行ID（固定: agentN）
      - commitHash: コミットハッシュ
      - branch: ブランチ名
      - agentNum: エージェント番号
      - specFile: 対象specファイル
      - testEnvUrl: テスト環境URL
    """
    body = json.loads(event.get('body') or '{}')
    run_id = body.get('runId') or f"{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_unknown"

    now_iso = datetime.now(timezone.utc).isoformat()

    # 既存ケースをすべて削除してからrun情報を上書き
    delete_cases_for_run(run_id)

    item = {
        'runId': run_id,
        'status': 'all',           # GSI用パーティションキー（常に"all"）
        'runStatus': 'running',    # 実際のステータス
        'commitHash': body.get('commitHash', 'unknown'),
        'branch': body.get('branch', 'unknown'),
        'agentNum': body.get('agentNum', 1),
        'specFile': body.get('specFile', ''),
        'sessionId': str(body.get('sessionId', '1')),
        'testEnvUrl': body.get('testEnvUrl', ''),
        'totalCount': 0,
        'passCount': 0,
        'failCount': 0,
        'skipCount': 0,
        # reporter.js から送られるテスト総数（リアルタイム進捗バー用）
        'expectedTotal': body.get('expectedTotal', 0),
        # reporter.js が送る開始時刻（省略時は現在時刻）
        'startedAt': body.get('startedAt', now_iso),
        'finishedAt': None,
        'durationMs': 0,
        'createdAt': now_iso,
        'ttl': get_ttl()
    }

    runs_table.put_item(Item=item)

    return response(201, {'runId': run_id, 'message': '実行登録完了'})


def get_run(run_id):
    """GET /runs/{runId} - 実行詳細取得"""
    result = runs_table.get_item(Key={'runId': run_id})
    item = result.get('Item')
    if not item:
        return response(404, {'error': f'runId not found: {run_id}'})
    return response(200, item)


def update_run(run_id, event):
    """
    PUT /runs/{runId} - 実行情報更新（テスト完了時に呼ぶ）
    ボディ:
      - runStatus: completed/failed
      - totalCount, passCount, failCount, skipCount
      - finishedAt, durationMs
    """
    body = json.loads(event.get('body') or '{}')

    update_expr = 'SET runStatus = :s, totalCount = :tc, passCount = :pc, failCount = :fc, skipCount = :sk, finishedAt = :fa, durationMs = :dm'
    expr_values = {
        ':s': body.get('runStatus', 'completed'),
        ':tc': body.get('totalCount', 0),
        ':pc': body.get('passCount', 0),
        ':fc': body.get('failCount', 0),
        ':sk': body.get('skipCount', 0),
        ':fa': body.get('finishedAt', datetime.now(timezone.utc).isoformat()),
        ':dm': body.get('durationMs', 0)
    }

    runs_table.update_item(
        Key={'runId': run_id},
        UpdateExpression=update_expr,
        ExpressionAttributeValues=expr_values
    )

    return response(200, {'message': '更新完了'})


def get_cases(run_id, event):
    """
    GET /runs/{runId}/cases - テストケース一覧取得
    クエリパラメータ:
      - status: failed/passed/skipped/all（デフォルト: all）
      - limit: 取得件数（デフォルト: 500）
    """
    params = event.get('queryStringParameters') or {}
    status_filter = params.get('status', 'all')
    limit = int(params.get('limit', 500))

    if status_filter != 'all':
        # statusインデックスを使って絞り込み
        result = cases_table.query(
            IndexName='status-index',
            KeyConditionExpression=Key('runId').eq(run_id) & Key('caseStatus').eq(status_filter),
            Limit=limit
        )
    else:
        result = cases_table.query(
            KeyConditionExpression=Key('runId').eq(run_id),
            Limit=limit
        )

    items = result.get('Items', [])
    return response(200, {
        'items': items,
        'count': len(items),
        'runId': run_id
    })


def create_cases(run_id, event):
    """
    POST /runs/{runId}/cases - テストケース結果一括登録
    ボディ:
      - cases: テストケース結果の配列
        - caseId: ケースID（テスト名をslug化したもの）
        - testTitle: テストタイトル
        - suiteName: describe名
        - specFile: specファイル名
        - caseStatus: passed/failed/skipped
        - durationMs: 実行時間（ms）
        - errorMessage: エラーメッセージ（failedのみ）
        - errorStack: スタックトレース（failedのみ）
        - videoKey: S3キー（動画）
        - screenshotKeys: S3キーの配列（スクリーンショット）
        - traceKey: S3キー（trace.zip）
        - startedAt: 開始時刻
    """
    body = json.loads(event.get('body') or '{}')
    cases = body.get('cases', [])

    if not cases:
        return response(400, {'error': 'casesが空です'})

    now_iso = datetime.now(timezone.utc).isoformat()
    ttl = get_ttl()

    # DynamoDBへバッチ書き込み（25件ずつ）
    with cases_table.batch_writer() as batch:
        for case in cases:
            case_id = case.get('caseId') or str(uuid.uuid4())
            item = {
                'runId': run_id,
                'caseId': case_id,
                'testTitle': case.get('testTitle', ''),
                'suiteName': case.get('suiteName', ''),
                'specFile': case.get('specFile', ''),
                'caseStatus': case.get('caseStatus', 'passed'),
                'durationMs': case.get('durationMs', 0),
                'errorMessage': case.get('errorMessage', ''),
                'errorStack': case.get('errorStack', ''),
                'videoKey': case.get('videoKey', ''),
                'screenshotKeys': case.get('screenshotKeys', []),
                'traceKey': case.get('traceKey', ''),
                'steps': case.get('steps', []),
                'startedAt': case.get('startedAt', now_iso),
                'createdAt': now_iso,
                'ttl': ttl
            }
            batch.put_item(Item=item)

    # ケース登録後にrunのカウントを原子的に加算（リアルタイム進捗用）
    pass_delta = sum(1 for c in cases if c.get('caseStatus') == 'passed')
    fail_delta = sum(1 for c in cases if c.get('caseStatus') == 'failed')
    skip_delta = sum(1 for c in cases if c.get('caseStatus') == 'skipped')
    total_delta = len(cases)
    try:
        runs_table.update_item(
            Key={'runId': run_id},
            UpdateExpression='ADD passCount :p, failCount :f, skipCount :sk, totalCount :tc',
            ExpressionAttributeValues={
                ':p': pass_delta,
                ':f': fail_delta,
                ':sk': skip_delta,
                ':tc': total_delta,
            }
        )
    except Exception:
        pass  # カウント更新失敗は無視（ケース登録は成功済み）

    return response(201, {'message': f'{len(cases)}件登録完了', 'runId': run_id})


def patch_case(run_id, case_id, event):
    """
    PATCH /runs/{runId}/cases/{caseId} - ケースのS3キーを後から更新
    ボディ:
      - videoKey, screenshotKeys, traceKey（いずれか）
    """
    body = json.loads(event.get('body') or '{}')
    expr_parts = []
    expr_values = {}
    if 'videoKey' in body:
        expr_parts.append('videoKey = :vk')
        expr_values[':vk'] = body['videoKey']
    if 'screenshotKeys' in body:
        expr_parts.append('screenshotKeys = :sk')
        expr_values[':sk'] = body['screenshotKeys']
    if 'traceKey' in body:
        expr_parts.append('traceKey = :tk')
        expr_values[':tk'] = body['traceKey']
    if not expr_parts:
        return response(400, {'error': '更新フィールドがありません'})

    cases_table.update_item(
        Key={'runId': run_id, 'caseId': case_id},
        UpdateExpression='SET ' + ', '.join(expr_parts),
        ExpressionAttributeValues=expr_values
    )
    return response(200, {'message': '更新完了'})


SPECS_S3_KEY = 'specs/all.json'


def get_specs():
    """
    GET /specs - spec一覧取得
    S3の specs/all.json を読み込んで返す。
    """
    if not ASSETS_BUCKET:
        return response(503, {'error': 'ASSETS_BUCKET が設定されていません'})

    try:
        obj = s3_client.get_object(Bucket=ASSETS_BUCKET, Key=SPECS_S3_KEY)
        data = json.loads(obj['Body'].read().decode('utf-8'))
        return response(200, data)
    except s3_client.exceptions.NoSuchKey:
        return response(404, {'error': 'spec一覧がまだアップロードされていません。upload_specs.pyを実行してください。'})
    except Exception as e:
        return response(500, {'error': str(e)})


def put_specs(event):
    """
    PUT /specs - spec一覧更新
    ボディ: specs.json の内容
    S3の specs/all.json に保存する。
    """
    if not ASSETS_BUCKET:
        return response(503, {'error': 'ASSETS_BUCKET が設定されていません'})

    body = event.get('body') or '{}'
    try:
        # JSONバリデーション
        data = json.loads(body)
        if 'specs' not in data:
            return response(400, {'error': 'specsフィールドが必要です'})
    except json.JSONDecodeError as e:
        return response(400, {'error': f'JSONパースエラー: {e}'})

    s3_client.put_object(
        Bucket=ASSETS_BUCKET,
        Key=SPECS_S3_KEY,
        Body=body.encode('utf-8'),
        ContentType='application/json'
    )

    return response(200, {
        'message': 'spec一覧を保存しました',
        'specsCount': len(data.get('specs', [])),
        'generatedAt': data.get('generatedAt', '')
    })


def get_upload_url(event):
    """
    POST /assets/upload-url - S3アップロード用署名付きURL発行
    ボディ:
      - key: S3キー（例: runs/20260319_194119/video.webm）
      - contentType: MIMEタイプ（例: video/webm）
    有効期限: 1時間
    """
    body = json.loads(event.get('body') or '{}')
    key = body.get('key')
    content_type = body.get('contentType', 'application/octet-stream')

    if not key:
        return response(400, {'error': 'keyが必要です'})

    url = s3_client.generate_presigned_url(
        'put_object',
        Params={
            'Bucket': ASSETS_BUCKET,
            'Key': key,
            'ContentType': content_type
        },
        ExpiresIn=3600
    )

    return response(200, {'uploadUrl': url, 'key': key})


def get_download_url(event):
    """
    POST /assets/download-url - S3ダウンロード用署名付きURL発行
    ボディ:
      - key: S3キー
    有効期限: 1時間
    """
    body = json.loads(event.get('body') or '{}')
    key = body.get('key')

    if not key:
        return response(400, {'error': 'keyが必要です'})

    url = s3_client.generate_presigned_url(
        'get_object',
        Params={
            'Bucket': ASSETS_BUCKET,
            'Key': key
        },
        ExpiresIn=86400  # 24時間（元1時間→動画がloading状態になる問題を修正）
    )

    return response(200, {'downloadUrl': url, 'key': key})
