#!/usr/bin/env python3
"""
プロダクトバグ一覧 md を E2E Viewer にアップロードする。

使い方:
  E2E_API_URL=https://... E2E_API_PASSWORD=... python3 e2e-viewer/upload_bugs.py

  or

  python3 e2e-viewer/upload_bugs.py --api-url ... --password ... [--md path/to/md]
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.error


DEFAULT_MD_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    '.claude',
    'product-bugs-suspected.md',
)


def get_token(api_url: str, password: str) -> str:
    """パスワードから認証トークンを取得"""
    req = urllib.request.Request(
        f'{api_url}/auth/login',
        data=json.dumps({'password': password}).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        data = json.loads(res.read().decode('utf-8'))
    return data['token']


def upload_md(api_url: str, token: str, md_content: str) -> dict:
    """PUT /bugs で md を upload"""
    req = urllib.request.Request(
        f'{api_url}/bugs',
        data=json.dumps({'markdown': md_content}, ensure_ascii=False).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
        },
        method='PUT',
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8') if e.fp else ''
        raise SystemExit(f'HTTP {e.code}: {body}')


def main():
    parser = argparse.ArgumentParser(description='プロダクトバグ md を E2E Viewer にアップロード')
    parser.add_argument('--api-url', default=os.environ.get('E2E_API_URL'),
                        help='API Gateway URL (env: E2E_API_URL)')
    parser.add_argument('--password', default=os.environ.get('E2E_API_PASSWORD'),
                        help='管理パスワード (env: E2E_API_PASSWORD) — 必須、デフォルト値なし')
    parser.add_argument('--md', default=DEFAULT_MD_PATH,
                        help=f'md ファイルパス (default: {DEFAULT_MD_PATH})')
    args = parser.parse_args()

    if not args.api_url:
        sys.exit('ERROR: --api-url または E2E_API_URL 環境変数が必要です')
    if not args.password:
        sys.exit('ERROR: --password または E2E_API_PASSWORD 環境変数が必要です')
    if not os.path.exists(args.md):
        sys.exit(f'ERROR: md ファイルが見つかりません: {args.md}')

    with open(args.md, 'r', encoding='utf-8') as f:
        md_content = f.read()

    print(f'[upload_bugs] md 読み込み: {args.md} ({len(md_content)} bytes)')
    token = get_token(args.api_url, args.password)
    print(f'[upload_bugs] 認証完了')
    result = upload_md(args.api_url, token, md_content)
    print(f'[upload_bugs] アップロード完了: {result}')


if __name__ == '__main__':
    main()
