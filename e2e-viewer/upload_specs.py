#!/usr/bin/env python3
"""
PigeonCloud E2E - spec一覧アップロードスクリプト

tests/*.spec.js を解析してテスト一覧JSONを生成し、S3にアップロードする。
Lambda の GET /specs エンドポイントが読み取るデータソースになる。

使い方:
    python e2e-viewer/upload_specs.py
    python e2e-viewer/upload_specs.py --dry-run  # S3アップロードせず標準出力のみ

環境変数:
    E2E_API_URL     - APIエンドポイント（必須）
    E2E_API_PASSWORD - APIパスワード（デフォルト: pigeon-e2e-2026）
"""

import os
import re
import sys
import json
import glob
import hashlib
import argparse
from datetime import datetime, timezone
from pathlib import Path


TOKEN_SALT = 'pigeon-e2e-viewer-salt-2026'


def generate_token(password: str) -> str:
    raw = f"{password}{TOKEN_SALT}"
    return hashlib.sha256(raw.encode()).hexdigest()


def parse_spec_file(filepath: str) -> dict:
    """spec.jsファイルを解析してテスト一覧を返す"""
    path = Path(filepath)
    mtime = path.stat().st_mtime
    last_modified = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    suites = []
    current_suite = None

    # test.describe と test() をパース（行単位で処理）
    lines = content.split('\n')

    for line in lines:
        # test.describe('Suite Name', ...) または test.describe("Suite Name", ...)
        describe_match = re.match(r"\s*test\.describe\(['\"](.+?)['\"]", line)
        if describe_match:
            suite_name = describe_match.group(1)
            current_suite = {'name': suite_name, 'tests': []}
            suites.append(current_suite)
            continue

        # test('Test Name', ...) または test.skip('Test Name', ...) または test.only(...)
        test_match = re.match(r"\s*test(?:\.skip|\.only|\.fixme)?\s*\(\s*['\"](.+?)['\"]", line)
        if test_match:
            title = test_match.group(1)
            is_skip = bool(re.match(r"\s*test\.skip\s*\(", line))
            is_todo = bool(re.search(r'test\.skip\s*\(.*true.*todo', line))

            # case_no を抽出（例: "1-1: ..." → "1-1"）
            case_no_match = re.match(r'^([\d\w]+-[\d\w]+(?:-\d+)?)', title)
            case_no = case_no_match.group(1) if case_no_match else ''

            test_entry = {
                'title': title,
                'caseNo': case_no,
                'skip': is_skip,
            }

            if current_suite is not None:
                current_suite['tests'].append(test_entry)
            else:
                # describeなしのトップレベルtest
                if not suites or suites[-1].get('name') != '_top':
                    suites.append({'name': '', 'tests': []})
                    current_suite = suites[-1]
                current_suite['tests'].append(test_entry)

    # 空のsuiteを除去
    suites = [s for s in suites if s['tests']]

    total = sum(len(s['tests']) for s in suites)
    skipped = sum(sum(1 for t in s['tests'] if t.get('skip')) for s in suites)

    return {
        'file': path.name,
        'lastModified': last_modified,
        'suites': suites,
        'totalTests': total,
        'skippedTests': skipped,
    }


def main():
    parser = argparse.ArgumentParser(description='spec.js一覧をS3にアップロード')
    parser.add_argument('--dry-run', action='store_true', help='S3アップロードせず出力のみ')
    parser.add_argument('--specs-dir', default='tests', help='spec.jsのディレクトリ（デフォルト: tests）')
    args = parser.parse_args()

    # プロジェクトルートに移動
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    specs_dir = project_root / args.specs_dir

    spec_files = sorted(specs_dir.glob('*.spec.js'))
    if not spec_files:
        print(f'ERROR: {specs_dir}/*.spec.js が見つかりません', file=sys.stderr)
        sys.exit(1)

    print(f'[upload_specs] {len(spec_files)}件のspec.jsを解析中...')

    specs_data = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'specs': []
    }

    for fp in spec_files:
        try:
            spec = parse_spec_file(str(fp))
            specs_data['specs'].append(spec)
            print(f'  {spec["file"]}: {spec["totalTests"]}件 (最終更新: {spec["lastModified"][:10]})')
        except Exception as e:
            print(f'  WARNING: {fp.name} のパースに失敗: {e}', file=sys.stderr)

    specs_json = json.dumps(specs_data, ensure_ascii=False, indent=2)

    if args.dry_run:
        print('\n--- specs.json (preview) ---')
        # 最初の200文字だけ表示
        preview = specs_json[:500]
        print(preview + '...' if len(specs_json) > 500 else preview)
        return

    # API経由でアップロード
    api_url = os.environ.get('E2E_API_URL', '')
    if not api_url:
        print('ERROR: E2E_API_URL が設定されていません', file=sys.stderr)
        print('  E2E_API_URL=https://... python e2e-viewer/upload_specs.py', file=sys.stderr)
        sys.exit(1)

    password = os.environ.get('E2E_API_PASSWORD', 'pigeon-e2e-2026')
    token = generate_token(password)

    import urllib.request
    req = urllib.request.Request(
        f'{api_url.rstrip("/")}/specs',
        data=specs_json.encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}'
        },
        method='PUT'
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode('utf-8')
            print(f'[upload_specs] アップロード完了: {resp.status} {body[:100]}')
    except Exception as e:
        print(f'ERROR: アップロード失敗: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
