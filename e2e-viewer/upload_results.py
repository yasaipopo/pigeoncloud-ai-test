#!/usr/bin/env python3
"""
PigeonCloud E2E テスト結果アップロードスクリプト
テスト完了後に以下をAPIに送信・S3にアップロードする:
  - playwright-results.json → DynamoDB（runs + cases）
  - 動画（videos/）→ S3
  - スクリーンショット（*.png）→ S3
  - トレース（trace.zip）→ S3

使い方:
  python e2e-viewer/upload_results.py \
    --reports-dir reports/agent-1 \
    --api-url https://xxxxxxxx.lambda-url.ap-northeast-1.on.aws \
    --agent-num 1

環境変数（オプション）:
  E2E_API_URL     - APIエンドポイントURL
  E2E_AGENT_NUM   - エージェント番号
  COMMIT_HASH     - コミットハッシュ（自動取得試行）
  GIT_BRANCH      - ブランチ名（自動取得試行）
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import boto3
import requests
from botocore.exceptions import ClientError


# =========================================
# 設定
# =========================================

DEFAULT_API_URL = os.environ.get('E2E_API_URL', '')
DEFAULT_AGENT_NUM = int(os.environ.get('E2E_AGENT_NUM', '1'))
AWS_PROFILE = os.environ.get('AWS_PROFILE', 'lof-dev')
AWS_REGION = os.environ.get('AWS_REGION', 'ap-northeast-1')

# S3に直接アップロード（バケット名がわかる場合）またはAPIのpresigned URLを使用
ASSETS_BUCKET = os.environ.get('E2E_ASSETS_BUCKET', '')

# 並列アップロードのスレッド数
UPLOAD_WORKERS = 4

# 認証トークン（Lambda側と同じアルゴリズム: sha256(password + salt)）
TOKEN_SALT = 'pigeon-e2e-viewer-salt-2026'
_api_password = os.environ.get('E2E_API_PASSWORD', 'pigeon-e2e-2026')
_api_token = os.environ.get('E2E_API_TOKEN', '')


def get_auth_token() -> str:
    """APIアクセス用Bearerトークンを返す"""
    if _api_token:
        return _api_token
    raw = f"{_api_password}{TOKEN_SALT}"
    return hashlib.sha256(raw.encode()).hexdigest()


def auth_headers() -> dict:
    return {'Authorization': f'Bearer {get_auth_token()}'}


# =========================================
# ユーティリティ
# =========================================

def get_git_info():
    """Gitのコミットハッシュとブランチ名を取得"""
    commit_hash = os.environ.get('COMMIT_HASH', '')
    branch = os.environ.get('GIT_BRANCH', '')

    if not commit_hash:
        try:
            result = subprocess.run(
                ['git', 'rev-parse', '--short', 'HEAD'],
                capture_output=True, text=True, timeout=5
            )
            commit_hash = result.stdout.strip() or 'unknown'
        except Exception:
            commit_hash = 'unknown'

    if not branch:
        try:
            result = subprocess.run(
                ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
                capture_output=True, text=True, timeout=5
            )
            branch = result.stdout.strip() or 'unknown'
        except Exception:
            branch = 'unknown'

    return commit_hash, branch


def slugify(text, max_len=80):
    """テスト名をS3キー安全な文字列に変換"""
    # 日本語などはそのまま保持（URLエンコードはS3/CLIが処理）
    # スラッシュ・コロン等の危険文字のみ置換
    text = re.sub(r'[/\\:*?"<>|]', '-', text)
    text = re.sub(r'\s+', '-', text)
    text = re.sub(r'-+', '-', text)
    return text[:max_len].strip('-')


def log(msg, level='INFO'):
    ts = datetime.now().strftime('%H:%M:%S')
    print(f'[{ts}] [{level}] {msg}')


# =========================================
# playwright-results.json パース
# =========================================

def parse_playwright_results(json_path):
    """
    playwright-results.json を読み込んでテスト結果を構造化する
    戻り値:
      stats: { totalCount, passCount, failCount, skipCount, durationMs, startedAt, finishedAt }
      cases: [ { caseId, testTitle, suiteName, specFile, caseStatus, durationMs,
                 errorMessage, errorStack, attachments: [{name, path, contentType}], startedAt } ]
    """
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    raw_stats = data.get('stats', {})
    start_time = raw_stats.get('startTime', datetime.now(timezone.utc).isoformat())
    duration_ms = int(raw_stats.get('duration', 0) * 1000)

    # finishedAt を計算
    try:
        from datetime import timedelta
        started = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
        finished = started + timedelta(milliseconds=duration_ms)
        finished_at = finished.isoformat()
    except Exception:
        finished_at = datetime.now(timezone.utc).isoformat()

    stats = {
        'startedAt': start_time,
        'finishedAt': finished_at,
        'durationMs': duration_ms,
        'totalCount': 0,
        'passCount': 0,
        'failCount': 0,
        'skipCount': 0
    }

    cases = []
    _collect_specs(data.get('suites', []), cases, parent_suite='')

    # 集計
    for case in cases:
        stats['totalCount'] += 1
        s = case['caseStatus']
        if s == 'passed':
            stats['passCount'] += 1
        elif s == 'failed':
            stats['failCount'] += 1
        elif s == 'skipped':
            stats['skipCount'] += 1

    return stats, cases


def _collect_specs(suites, cases, parent_suite):
    """再帰的にsuitesを走査してspecを収集"""
    for suite in suites:
        suite_title = suite.get('title', '')
        spec_file = suite.get('file', '')

        # 現在のsuiteタイトル（親があればjoin）
        current_suite = f'{parent_suite} > {suite_title}' if parent_suite else suite_title

        # 子specsを処理
        for spec in suite.get('specs', []):
            _process_spec(spec, current_suite, spec_file, cases)

        # 子suitesを再帰処理
        _collect_specs(suite.get('suites', []), cases, current_suite)


def _process_spec(spec, suite_name, spec_file, cases):
    """specをテストケース結果に変換"""
    test_title = spec.get('title', '')
    spec_ok = spec.get('ok', False)

    for test in spec.get('tests', []):
        results = test.get('results', [])
        if not results:
            continue

        # 最後のresult（リトライ考慮）を使用
        last_result = results[-1]
        status_raw = last_result.get('status', 'passed')

        # Playwright status→表示ステータス変換
        if status_raw == 'passed' and spec_ok:
            case_status = 'passed'
        elif status_raw == 'skipped':
            case_status = 'skipped'
        else:
            case_status = 'failed'

        # エラー情報
        error_message = ''
        error_stack = ''
        errors = last_result.get('errors', [])
        if errors:
            first_error = errors[0]
            error_message = first_error.get('message', '')
            # ANSIエスケープコードを除去
            error_message = re.sub(r'\x1b\[[0-9;]*m', '', error_message)
            error_stack = first_error.get('stack', '')
            error_stack = re.sub(r'\x1b\[[0-9;]*m', '', error_stack)

        # アタッチメント（動画・スクショ・トレース）
        attachments = []
        for att in last_result.get('attachments', []):
            if att.get('path'):
                attachments.append({
                    'name': att.get('name', ''),
                    'path': att.get('path', ''),
                    'contentType': att.get('contentType', 'application/octet-stream')
                })

        # ユニークなcaseId（テスト名のslug）
        case_id = slugify(test_title)
        if not case_id:
            case_id = str(uuid.uuid4())[:8]

        cases.append({
            'caseId': case_id,
            'testTitle': test_title,
            'suiteName': suite_name,
            'specFile': spec_file,
            'caseStatus': case_status,
            'durationMs': last_result.get('duration', 0),
            'errorMessage': error_message,
            'errorStack': error_stack,
            'attachments': attachments,
            'startedAt': last_result.get('startTime', '')
        })


# =========================================
# S3アップロード
# =========================================

def upload_to_s3_via_api(api_url, local_path, s3_key, content_type):
    """
    APIのpresigned URLを取得してS3にアップロード
    戻り値: (成功bool, s3_key)
    """
    try:
        # presigned URL取得
        r = requests.post(
            f'{api_url}/assets/upload-url',
            json={'key': s3_key, 'contentType': content_type},
            headers={**auth_headers(), 'Content-Type': 'application/json'},
            timeout=30
        )
        r.raise_for_status()
        upload_url = r.json()['uploadUrl']

        # アップロード
        with open(local_path, 'rb') as f:
            up = requests.put(upload_url, data=f, headers={'Content-Type': content_type}, timeout=300)
            up.raise_for_status()

        return True, s3_key
    except Exception as e:
        log(f'S3アップロード失敗: {local_path} -> {s3_key}: {e}', 'WARN')
        return False, s3_key


def upload_to_s3_direct(boto_session, bucket, local_path, s3_key, content_type):
    """
    boto3で直接S3にアップロード（バケット名がわかる場合）
    """
    try:
        s3 = boto_session.client('s3', region_name=AWS_REGION)
        s3.upload_file(
            str(local_path),
            bucket,
            s3_key,
            ExtraArgs={'ContentType': content_type}
        )
        return True, s3_key
    except Exception as e:
        log(f'S3直接アップロード失敗: {local_path} -> {s3_key}: {e}', 'WARN')
        return False, s3_key


def guess_content_type(path):
    """ファイル拡張子からMIMEタイプを推定"""
    ext = Path(path).suffix.lower()
    types = {
        '.webm': 'video/webm',
        '.mp4': 'video/mp4',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.zip': 'application/zip',
        '.json': 'application/json',
    }
    return types.get(ext, 'application/octet-stream')


def upload_attachments(cases, run_id, api_url, boto_session):
    """
    全テストケースのアタッチメントをS3にアップロードし、
    各caseのvideoKey / screenshotKeys / traceKeyを更新する
    """
    # アップロードタスクを収集
    upload_tasks = []
    for i, case in enumerate(cases):
        for att in case.get('attachments', []):
            local_path = att['path']
            if not os.path.exists(local_path):
                continue

            name = att['name']
            content_type = att['contentType'] or guess_content_type(local_path)

            # S3キーを構築: runs/{runId}/{caseId}/{name}/{filename}
            filename = Path(local_path).name
            s3_key = f'runs/{run_id}/{case["caseId"]}/{name}/{filename}'

            upload_tasks.append({
                'case_idx': i,
                'att_name': name,
                'local_path': local_path,
                's3_key': s3_key,
                'content_type': content_type
            })

    if not upload_tasks:
        log('アップロードするファイルがありません')
        return cases

    log(f'{len(upload_tasks)}個のファイルをアップロード中...')

    # 並列アップロード
    results = {}
    with ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as executor:
        futures = {}
        for task in upload_tasks:
            if boto_session and ASSETS_BUCKET:
                future = executor.submit(
                    upload_to_s3_direct,
                    boto_session, ASSETS_BUCKET,
                    task['local_path'], task['s3_key'], task['content_type']
                )
            else:
                future = executor.submit(
                    upload_to_s3_via_api,
                    api_url, task['local_path'], task['s3_key'], task['content_type']
                )
            futures[future] = task

        for future in as_completed(futures):
            task = futures[future]
            success, s3_key = future.result()
            if success:
                key = (task['case_idx'], task['att_name'])
                results[key] = s3_key
                log(f'  ✓ {Path(task["local_path"]).name}')

    # caseのキーを更新
    for i, case in enumerate(cases):
        for att in case.get('attachments', []):
            name = att['name']
            key = (i, name)
            if key in results:
                s3_key = results[key]
                if name == 'video':
                    case['videoKey'] = s3_key
                elif name == 'trace':
                    case['traceKey'] = s3_key
                elif name.startswith('screenshot') or att['contentType'].startswith('image/'):
                    if 'screenshotKeys' not in case:
                        case['screenshotKeys'] = []
                    case['screenshotKeys'].append(s3_key)

        # attachmentsキーを削除（APIに送らない）
        case.pop('attachments', None)

    log(f'アップロード完了: {len(results)}/{len(upload_tasks)}件')
    return cases


# =========================================
# API呼び出し
# =========================================

def api_post(api_url, path, data, retries=3):
    """APIにPOSTリクエスト（リトライあり）"""
    url = f'{api_url.rstrip("/")}{path}'
    headers = {**auth_headers(), 'Content-Type': 'application/json'}
    for attempt in range(retries):
        try:
            r = requests.post(url, json=data, headers=headers, timeout=60)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == retries - 1:
                raise
            log(f'  リトライ {attempt + 1}/{retries}: {e}', 'WARN')
            time.sleep(2 ** attempt)


def api_put(api_url, path, data):
    """APIにPUTリクエスト"""
    url = f'{api_url.rstrip("/")}{path}'
    headers = {**auth_headers(), 'Content-Type': 'application/json'}
    r = requests.put(url, json=data, headers=headers, timeout=60)
    r.raise_for_status()
    return r.json()


# =========================================
# メイン処理
# =========================================

def main():
    parser = argparse.ArgumentParser(description='E2Eテスト結果をAPIにアップロード')
    parser.add_argument('--reports-dir', default=os.environ.get('REPORTS_DIR', 'reports/agent-1'),
                        help='レポートディレクトリ（デフォルト: reports/agent-1）')
    parser.add_argument('--api-url', default=DEFAULT_API_URL,
                        help='APIエンドポイントURL')
    parser.add_argument('--agent-num', type=int, default=DEFAULT_AGENT_NUM,
                        help='エージェント番号（デフォルト: 1）')
    parser.add_argument('--run-id', default='',
                        help='実行ID（省略時は自動生成）')
    parser.add_argument('--spec-file', default='',
                        help='対象specファイル名')
    parser.add_argument('--test-env-url', default=os.environ.get('TEST_BASE_URL', ''),
                        help='テスト環境URL')
    parser.add_argument('--dry-run', action='store_true',
                        help='実際のアップロードを行わずに確認のみ')
    parser.add_argument('--password', default='',
                        help='APIパスワード（省略時: E2E_API_PASSWORD環境変数 or デフォルト値）')
    args = parser.parse_args()

    # パスワード上書き
    if args.password:
        global _api_password
        _api_password = args.password

    # 必須チェック
    if not args.api_url:
        log('--api-url または E2E_API_URL 環境変数が必要です', 'ERROR')
        sys.exit(1)

    reports_dir = Path(args.reports_dir)
    results_json = reports_dir / 'playwright-results.json'

    if not results_json.exists():
        log(f'playwright-results.json が見つかりません: {results_json}', 'ERROR')
        log('aggregate_playwright_results.py を実行して playwright-results.json を生成してください')
        sys.exit(1)

    log(f'=== E2Eテスト結果アップロード開始 ===')
    log(f'レポートディレクトリ: {reports_dir}')
    log(f'API URL: {args.api_url}')

    # Git情報取得
    commit_hash, branch = get_git_info()
    log(f'コミット: {commit_hash} / ブランチ: {branch}')

    # 実行ID生成
    run_id = args.run_id
    if not run_id:
        ts = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
        run_id = f'{ts}_{commit_hash}_agent{args.agent_num}'
    log(f'実行ID: {run_id}')

    # playwright-results.json パース
    log('playwright-results.json を解析中...')
    stats, cases = parse_playwright_results(results_json)
    log(f'  合計: {stats["totalCount"]}件 '
        f'(PASS: {stats["passCount"]}, '
        f'FAIL: {stats["failCount"]}, '
        f'SKIP: {stats["skipCount"]})')

    if args.dry_run:
        log('[DRY RUN] 実際のアップロードはスキップします')
        log(f'登録予定件数: {len(cases)}件')
        print(json.dumps({'runId': run_id, 'stats': stats, 'cases_count': len(cases)}, indent=2, ensure_ascii=False))
        return

    # boto3セッション（直接S3アクセス用）
    boto_session = None
    if ASSETS_BUCKET:
        try:
            boto_session = boto3.Session(profile_name=AWS_PROFILE, region_name=AWS_REGION)
            log(f'AWSプロファイル: {AWS_PROFILE} （直接S3アップロード）')
        except Exception as e:
            log(f'boto3セッション作成失敗（presigned URL方式を使用）: {e}', 'WARN')

    # 1. 実行登録（runs）
    log('テスト実行を登録中...')
    spec_file = args.spec_file
    if not spec_file:
        # 最初のテストケースからspecFileを取得
        spec_file = cases[0]['specFile'] if cases else ''

    api_post(args.api_url, '/runs', {
        'runId': run_id,
        'commitHash': commit_hash,
        'branch': branch,
        'agentNum': args.agent_num,
        'specFile': spec_file,
        'testEnvUrl': args.test_env_url
    })
    log(f'  実行登録完了: {run_id}')

    # 2. アタッチメント（動画・スクショ）をS3にアップロード
    log('アタッチメントをS3にアップロード中...')
    cases = upload_attachments(cases, run_id, args.api_url, boto_session)

    # 3. テストケース結果を一括登録（100件ずつ分割して送信）
    log(f'テストケース結果を登録中... ({len(cases)}件)')
    chunk_size = 100
    for i in range(0, len(cases), chunk_size):
        chunk = cases[i:i + chunk_size]
        api_post(args.api_url, f'/runs/{run_id}/cases', {'cases': chunk})
        log(f'  {min(i + chunk_size, len(cases))}/{len(cases)}件登録')

    # 4. 実行完了を更新（runs）
    log('実行完了を更新中...')
    api_put(args.api_url, f'/runs/{run_id}', {
        'runStatus': 'failed' if stats['failCount'] > 0 else 'completed',
        **stats
    })

    log(f'=== アップロード完了 ===')
    log(f'実行ID: {run_id}')
    log(f'結果: PASS {stats["passCount"]} / FAIL {stats["failCount"]} / SKIP {stats["skipCount"]}')


if __name__ == '__main__':
    main()
