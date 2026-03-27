"""
PigeonCloud E2E テスト結果ビューアー - Lambda APIハンドラー
Lambda Function URLで動作するシンプルなREST API
"""

import json
import os
import re
import boto3
import uuid
import hashlib
from datetime import datetime, timezone, timedelta
from boto3.dynamodb.conditions import Key, Attr
from botocore.exceptions import ClientError

# 環境変数
RUNS_TABLE = os.environ.get('RUNS_TABLE', 'pigeon-e2e-viewer-runs')
CASES_TABLE = os.environ.get('CASES_TABLE', 'pigeon-e2e-viewer-cases')
PIPELINE_TABLE = os.environ.get('PIPELINE_TABLE', 'all-test-check-list')
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
pipeline_table = dynamodb.Table(PIPELINE_TABLE)

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

        # =========================================
        # パイプラインチェックシート
        # =========================================
        # GET /pipeline/summary - サマリー取得
        elif method == 'GET' and path == '/pipeline/summary':
            return pipeline_summary(event)

        # POST /pipeline/init - yamlから初期データ投入
        elif method == 'POST' and path == '/pipeline/init':
            return pipeline_init(event)

        # POST /pipeline/sync-results - E2Eビューアーの実行結果を同期
        elif method == 'POST' and path == '/pipeline/sync-results':
            return pipeline_sync_results(event)

        # POST /pipeline/bulk-update - 一括更新
        elif method == 'POST' and path == '/pipeline/bulk-update':
            return pipeline_bulk_update(event)

        # GET /pipeline - 全件取得（specフィルタ可）
        elif method == 'GET' and path == '/pipeline':
            return pipeline_get(event)

        # POST /pipeline - ステータス更新（1件 or バッチ）
        elif method == 'POST' and path == '/pipeline':
            return pipeline_update(event)

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


# =========================================
# パイプラインチェックシート API
# =========================================

def pipeline_get(event):
    """
    GET /pipeline - パイプラインチェック全件取得
    クエリパラメータ:
      - spec: specフィルタ（例: auth）
    """
    params = event.get('queryStringParameters') or {}
    spec_filter = params.get('spec')

    if spec_filter:
        # spec指定時はQuery
        result = pipeline_table.query(
            KeyConditionExpression=Key('spec').eq(spec_filter)
        )
        items = result.get('Items', [])
        # ページネーション対応
        while result.get('LastEvaluatedKey'):
            result = pipeline_table.query(
                KeyConditionExpression=Key('spec').eq(spec_filter),
                ExclusiveStartKey=result['LastEvaluatedKey']
            )
            items.extend(result.get('Items', []))
    else:
        # 全件Scan
        items = []
        result = pipeline_table.scan()
        items.extend(result.get('Items', []))
        while result.get('LastEvaluatedKey'):
            result = pipeline_table.scan(
                ExclusiveStartKey=result['LastEvaluatedKey']
            )
            items.extend(result.get('Items', []))

    return response(200, {
        'items': items,
        'count': len(items)
    })


def pipeline_update(event):
    """
    POST /pipeline - ステータス更新（1件 or バッチ）
    ボディ（1件）:
      - spec, caseNo, field (yamlCheck/specCheck/runCheck), value, note, updatedBy
    ボディ（バッチ）:
      - updates: [{spec, caseNo, field, value, note, updatedBy}, ...]
    """
    body = json.loads(event.get('body') or '{}')
    now_iso = datetime.now(timezone.utc).isoformat()

    updates = body.get('updates')
    if not updates:
        # 1件モード
        updates = [body]

    results = []
    for item in updates:
        spec = item.get('spec')
        case_no = item.get('caseNo')
        field = item.get('field')
        value = item.get('value')
        note = item.get('note', '')
        updated_by = item.get('updatedBy', 'unknown')

        if not spec or not case_no or not field:
            results.append({'spec': spec, 'caseNo': case_no, 'error': 'spec, caseNo, field は必須です'})
            continue

        # フィールド名のバリデーション
        valid_fields = {
            'yamlCheck': 'yamlCheckNote',
            'specCheck': 'specCheckNote',
            'runCheck': 'runCheckNote',
        }
        if field not in valid_fields:
            results.append({'spec': spec, 'caseNo': case_no, 'error': f'不正なfield: {field}'})
            continue

        note_field = valid_fields[field]

        # 追加フィールド（stagingResult, mainResult, screenshotUrl, videoUrl等）
        extra_updates = []
        extra_names = {}
        extra_values = {}
        extra_idx = 0
        extra_field_whitelist = [
            'stagingResult', 'stagingRunId', 'stagingNote',
            'mainResult', 'mainRunId', 'mainNote',
            'screenshotUrl', 'videoUrl',
        ]
        for ef in extra_field_whitelist:
            if ef in item:
                extra_idx += 1
                attr_name = f'#ef{extra_idx}'
                attr_val = f':ev{extra_idx}'
                extra_updates.append(f'{attr_name} = {attr_val}')
                extra_names[attr_name] = ef
                extra_values[attr_val] = item[ef]

        try:
            update_parts = [f'#f = :v', f'{note_field} = :n', 'updatedAt = :t', 'updatedBy = :u']
            update_parts.extend(extra_updates)
            update_expr = 'SET ' + ', '.join(update_parts)

            attr_names = {'#f': field}
            attr_names.update(extra_names)

            attr_values = {
                ':v': value,
                ':n': note,
                ':t': now_iso,
                ':u': updated_by,
            }
            attr_values.update(extra_values)

            pipeline_table.update_item(
                Key={'spec': spec, 'caseNo': case_no},
                UpdateExpression=update_expr,
                ExpressionAttributeNames=attr_names,
                ExpressionAttributeValues=attr_values
            )
            results.append({'spec': spec, 'caseNo': case_no, 'status': 'ok'})
        except Exception as e:
            results.append({'spec': spec, 'caseNo': case_no, 'error': str(e)})

    return response(200, {'results': results, 'count': len(results)})


def pipeline_summary(event):
    """
    GET /pipeline/summary - パイプラインサマリー
    全ケースの ①yaml ②spec ③run のOK/NG/未チェック件数を返す
    クエリパラメータ:
      - spec: specフィルタ（省略時は全体）
    """
    params = event.get('queryStringParameters') or {}
    spec_filter = params.get('spec')

    # データ取得
    if spec_filter:
        result = pipeline_table.query(
            KeyConditionExpression=Key('spec').eq(spec_filter)
        )
        items = result.get('Items', [])
        while result.get('LastEvaluatedKey'):
            result = pipeline_table.query(
                KeyConditionExpression=Key('spec').eq(spec_filter),
                ExclusiveStartKey=result['LastEvaluatedKey']
            )
            items.extend(result.get('Items', []))
    else:
        items = []
        result = pipeline_table.scan()
        items.extend(result.get('Items', []))
        while result.get('LastEvaluatedKey'):
            result = pipeline_table.scan(
                ExclusiveStartKey=result['LastEvaluatedKey']
            )
            items.extend(result.get('Items', []))

    total = len(items)

    # 集計
    summary = {
        'total': total,
        'yaml': {'ok': 0, 'ng': 0, 'unchecked': 0},
        'spec': {'ok': 0, 'ng': 0, 'unchecked': 0},
        'run': {'pass': 0, 'fail_spec': 0, 'fail_product': 0, 'fail_env': 0, 'unchecked': 0},
        'staging': {'pass': 0, 'fail': 0, 'skip': 0, 'unchecked': 0},
        'main': {'pass': 0, 'fail': 0, 'skip': 0, 'unchecked': 0},
    }

    # spec別集計
    by_spec = {}

    for item in items:
        spec_name = item.get('spec', '')

        # yaml
        yc = item.get('yamlCheck')
        if yc == 'ok':
            summary['yaml']['ok'] += 1
        elif yc == 'ng':
            summary['yaml']['ng'] += 1
        else:
            summary['yaml']['unchecked'] += 1

        # spec
        sc = item.get('specCheck')
        if sc == 'ok':
            summary['spec']['ok'] += 1
        elif sc == 'ng':
            summary['spec']['ng'] += 1
        else:
            summary['spec']['unchecked'] += 1

        # run
        rc = item.get('runCheck')
        if rc == 'pass':
            summary['run']['pass'] += 1
        elif rc == 'fail_spec':
            summary['run']['fail_spec'] += 1
        elif rc == 'fail_product':
            summary['run']['fail_product'] += 1
        elif rc == 'fail_env':
            summary['run']['fail_env'] += 1
        else:
            summary['run']['unchecked'] += 1

        # staging
        sr = item.get('stagingResult')
        if sr == 'pass':
            summary['staging']['pass'] += 1
        elif sr == 'fail':
            summary['staging']['fail'] += 1
        elif sr == 'skip':
            summary['staging']['skip'] += 1
        else:
            summary['staging']['unchecked'] += 1

        # main
        mr = item.get('mainResult')
        if mr == 'pass':
            summary['main']['pass'] += 1
        elif mr == 'fail':
            summary['main']['fail'] += 1
        elif mr == 'skip':
            summary['main']['skip'] += 1
        else:
            summary['main']['unchecked'] += 1

        # spec別
        if spec_name not in by_spec:
            by_spec[spec_name] = {'total': 0, 'yaml_ok': 0, 'spec_ok': 0, 'run_pass': 0, 'staging_pass': 0, 'main_pass': 0}
        by_spec[spec_name]['total'] += 1
        if yc == 'ok':
            by_spec[spec_name]['yaml_ok'] += 1
        if sc == 'ok':
            by_spec[spec_name]['spec_ok'] += 1
        if rc == 'pass':
            by_spec[spec_name]['run_pass'] += 1
        if sr == 'pass':
            by_spec[spec_name]['staging_pass'] += 1
        if mr == 'pass':
            by_spec[spec_name]['main_pass'] += 1

    summary['bySpec'] = by_spec

    return response(200, summary)


def pipeline_init(event):
    """
    POST /pipeline/init - yamlから初期データ投入
    ボディ:
      - specs: [{spec: 'auth', cases: [{caseNo, feature, description, expected}, ...]}, ...]
      - overwrite: true の場合既存データも上書き（デフォルト: false、既存はスキップ）
    """
    body = json.loads(event.get('body') or '{}')
    specs_data = body.get('specs', [])
    overwrite = body.get('overwrite', False)
    now_iso = datetime.now(timezone.utc).isoformat()

    total_count = 0
    skip_count = 0

    for spec_group in specs_data:
        spec_name = spec_group.get('spec', '')
        cases = spec_group.get('cases', [])

        for case in cases:
            case_no = case.get('caseNo', '')
            if not spec_name or not case_no:
                continue

            if not overwrite:
                # 既存チェック
                try:
                    existing = pipeline_table.get_item(
                        Key={'spec': spec_name, 'caseNo': case_no}
                    )
                    if 'Item' in existing:
                        skip_count += 1
                        continue
                except Exception:
                    pass

            item = {
                'spec': spec_name,
                'caseNo': case_no,
                'feature': case.get('feature', ''),
                'description': case.get('description', ''),
                'expected': case.get('expected', ''),
                'yamlCheck': case.get('yamlCheck') or None,
                'yamlCheckNote': case.get('yamlCheckNote', ''),
                'specCheck': case.get('specCheck') or None,
                'specCheckNote': case.get('specCheckNote', ''),
                'runCheck': case.get('runCheck') or None,
                'runCheckNote': case.get('runCheckNote', ''),
                'updatedAt': now_iso,
                'updatedBy': 'pipeline_init',
            }

            # Noneの値を除去（DynamoDBはNoneを保存できない）
            item = {k: v for k, v in item.items() if v is not None}

            pipeline_table.put_item(Item=item)
            total_count += 1

    return response(200, {
        'message': f'{total_count}件登録完了（{skip_count}件スキップ）',
        'registered': total_count,
        'skipped': skip_count,
    })


def pipeline_bulk_update(event):
    """
    POST /pipeline/bulk-update - 一括ステータス更新
    ボディ:
      - spec: spec名（省略時は全spec対象）
      - field: yamlCheck / specCheck / runCheck
      - value: 設定する値
      - note: 備考（省略可）
      - updatedBy: 更新者
      - caseNos: 対象caseNoのリスト（省略時はspec内全件）
      - onlyUnchecked: true の場合、未チェック（null/空）のケースのみ更新
    """
    body = json.loads(event.get('body') or '{}')
    spec_filter = body.get('spec')
    field = body.get('field')
    value = body.get('value')
    note = body.get('note', '')
    updated_by = body.get('updatedBy', 'bulk_update')
    case_nos = body.get('caseNos')
    only_unchecked = body.get('onlyUnchecked', False)
    now_iso = datetime.now(timezone.utc).isoformat()

    if not field:
        return response(400, {'error': 'field は必須です'})

    valid_fields = {
        'yamlCheck': 'yamlCheckNote',
        'specCheck': 'specCheckNote',
        'runCheck': 'runCheckNote',
    }
    if field not in valid_fields:
        return response(400, {'error': f'不正なfield: {field}'})

    note_field = valid_fields[field]

    # 対象アイテム取得
    if spec_filter:
        result = pipeline_table.query(
            KeyConditionExpression=Key('spec').eq(spec_filter)
        )
        items = result.get('Items', [])
        while result.get('LastEvaluatedKey'):
            result = pipeline_table.query(
                KeyConditionExpression=Key('spec').eq(spec_filter),
                ExclusiveStartKey=result['LastEvaluatedKey']
            )
            items.extend(result.get('Items', []))
    else:
        items = []
        result = pipeline_table.scan()
        items.extend(result.get('Items', []))
        while result.get('LastEvaluatedKey'):
            result = pipeline_table.scan(
                ExclusiveStartKey=result['LastEvaluatedKey']
            )
            items.extend(result.get('Items', []))

    # caseNosフィルタ
    if case_nos:
        case_nos_set = set(case_nos)
        items = [i for i in items if i.get('caseNo') in case_nos_set]

    # onlyUncheckedフィルタ
    if only_unchecked:
        items = [i for i in items if not i.get(field)]

    # 一括更新
    updated_count = 0
    for item in items:
        try:
            pipeline_table.update_item(
                Key={'spec': item['spec'], 'caseNo': item['caseNo']},
                UpdateExpression=f'SET #f = :v, {note_field} = :n, updatedAt = :t, updatedBy = :u',
                ExpressionAttributeNames={'#f': field},
                ExpressionAttributeValues={
                    ':v': value,
                    ':n': note,
                    ':t': now_iso,
                    ':u': updated_by,
                }
            )
            updated_count += 1
        except Exception as e:
            print(f'bulk-update error: {item["spec"]}#{item["caseNo"]}: {e}')

    return response(200, {
        'message': f'{updated_count}件更新完了',
        'updated': updated_count,
        'total_candidates': len(items),
    })


def pipeline_sync_results(event):
    """
    POST /pipeline/sync-results - E2Eビューアーの実行結果をパイプラインシートに同期
    /runs/{runId}/cases から全ケースの結果を取得し、
    all-test-check-list テーブルの stagingResult/mainResult/screenshotUrl/videoUrl を更新する。

    ボディ:
      - runId: E2Eビューアーの実行ID（例: agent30）
      - env: 'staging' or 'main'（結果の書き込み先を決定）
    """
    body = json.loads(event.get('body') or '{}')
    run_id = body.get('runId')
    env = body.get('env', 'staging')

    if not run_id:
        return response(400, {'error': 'runId は必須です'})

    if env not in ('staging', 'main'):
        return response(400, {'error': 'env は staging または main のみ有効です'})

    # 1. E2Eビューアーからケース結果を取得（全件）
    all_cases = []
    result = cases_table.query(
        KeyConditionExpression=Key('runId').eq(run_id)
    )
    all_cases.extend(result.get('Items', []))
    while result.get('LastEvaluatedKey'):
        result = cases_table.query(
            KeyConditionExpression=Key('runId').eq(run_id),
            ExclusiveStartKey=result['LastEvaluatedKey']
        )
        all_cases.extend(result.get('Items', []))

    if not all_cases:
        return response(404, {'error': f'runId={run_id} のケースが見つかりません'})

    # 2. ケースをspec+caseNoにマッピング
    #    caseId形式: "spec-name__case-no" or specFile から推測
    now_iso = datetime.now(timezone.utc).isoformat()
    result_field = 'stagingResult' if env == 'staging' else 'mainResult'
    run_id_field = 'stagingRunId' if env == 'staging' else 'mainRunId'
    note_field = 'stagingNote' if env == 'staging' else 'mainNote'

    updated_count = 0
    skipped_count = 0
    errors = []

    for case in all_cases:
        case_status = case.get('caseStatus', '')
        spec_file = case.get('specFile', '')
        case_id = case.get('caseId', '')
        test_title = case.get('testTitle', '')

        # specファイル名からspec名を抽出（例: tests/auth.spec.js → auth）
        spec_name = spec_file.replace('tests/', '').replace('.spec.js', '').replace('.spec.ts', '')

        # caseNoの推測:
        # testTitleに "1-1:" のようなパターンがある場合はそれを使う
        # caseIdが "1-1__description" 形式ならハイフン含む先頭部分
        case_no = ''

        # testTitleから "数字-数字" パターンを抽出
        title_match = re.match(r'^(\d+-\d+)', test_title)
        if title_match:
            case_no = title_match.group(1)
        else:
            # caseIdから試行（"1-1__..." or "1-1-..."）
            case_id_match = re.match(r'^(\d+-\d+)', case_id)
            if case_id_match:
                case_no = case_id_match.group(1)

        if not spec_name or not case_no:
            skipped_count += 1
            continue

        # statusマッピング: passed → pass, failed → fail, skipped → skip
        mapped_status = {
            'passed': 'pass',
            'failed': 'fail',
            'skipped': 'skip',
        }.get(case_status, case_status)

        # screenshotUrl / videoUrl の取得
        screenshot_keys = case.get('screenshotKeys', [])
        video_key = case.get('videoKey', '')

        # S3署名付きURLを生成（キーがある場合のみ）
        screenshot_url = ''
        video_url = ''
        if ASSETS_BUCKET:
            if screenshot_keys and len(screenshot_keys) > 0:
                try:
                    screenshot_url = s3_client.generate_presigned_url(
                        'get_object',
                        Params={'Bucket': ASSETS_BUCKET, 'Key': screenshot_keys[0]},
                        ExpiresIn=86400 * 7  # 7日間
                    )
                except Exception:
                    pass
            if video_key:
                try:
                    video_url = s3_client.generate_presigned_url(
                        'get_object',
                        Params={'Bucket': ASSETS_BUCKET, 'Key': video_key},
                        ExpiresIn=86400 * 7  # 7日間
                    )
                except Exception:
                    pass

        # 3. パイプラインテーブルを更新
        try:
            update_parts = [
                f'#rf = :rv',
                f'#ri = :rid',
                'updatedAt = :t',
                'updatedBy = :u',
            ]
            attr_names = {
                '#rf': result_field,
                '#ri': run_id_field,
            }
            attr_values = {
                ':rv': mapped_status,
                ':rid': run_id,
                ':t': now_iso,
                ':u': f'sync:{run_id}',
            }

            # エラーメッセージがあればnoteに記録
            error_msg = case.get('errorMessage', '')
            if error_msg:
                update_parts.append(f'#nf = :nv')
                attr_names['#nf'] = note_field
                attr_values[':nv'] = error_msg[:500]  # 500文字に制限

            # S3キーを直接保存（URLは表示時に生成する方が安全）
            if screenshot_keys and len(screenshot_keys) > 0:
                update_parts.append('screenshotKey = :sk')
                attr_values[':sk'] = screenshot_keys[0]
            if video_key:
                update_parts.append('videoKey = :vk')
                attr_values[':vk'] = video_key

            pipeline_table.update_item(
                Key={'spec': spec_name, 'caseNo': case_no},
                UpdateExpression='SET ' + ', '.join(update_parts),
                ExpressionAttributeNames=attr_names,
                ExpressionAttributeValues=attr_values,
                ConditionExpression='attribute_exists(spec)',  # 存在するアイテムのみ更新
            )
            updated_count += 1
        except ClientError as e:
            if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                skipped_count += 1  # パイプラインに未登録のケース
            else:
                errors.append(f'{spec_name}/{case_no}: {str(e)}')
        except Exception as e:
            errors.append(f'{spec_name}/{case_no}: {str(e)}')

    result_msg = f'{updated_count}件同期完了（{skipped_count}件スキップ）'
    if errors:
        result_msg += f'、{len(errors)}件エラー'

    return response(200, {
        'message': result_msg,
        'updated': updated_count,
        'skipped': skipped_count,
        'errors': errors[:20],  # エラーは最大20件
        'totalCases': len(all_cases),
        'runId': run_id,
        'env': env,
    })
