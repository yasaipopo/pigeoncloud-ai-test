#!/usr/bin/env python3
"""
ステップスクリーンショットをS3にアップロードするスクリプト
reports/agent-N/steps/{spec}/{movie}/{stepId}.jpg → S3 steps/{spec}/{movie}/{stepId}.jpg
"""
import os, sys, hashlib, glob, json
from pathlib import Path

TOKEN_SALT = 'pigeon-e2e-viewer-salt-2026'

def get_token(password):
    return hashlib.sha256(f"{password}{TOKEN_SALT}".encode()).hexdigest()

def main():
    import argparse, requests
    parser = argparse.ArgumentParser()
    parser.add_argument('--reports-dir', default='reports/agent-1')
    parser.add_argument('--api-url', default=os.environ.get('E2E_API_URL', ''))
    args = parser.parse_args()

    api_url = args.api_url
    token = get_token(os.environ.get('E2E_API_PASSWORD', 'pigeon-e2e-2026'))
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

    steps_dir = Path(args.reports_dir) / 'steps'
    if not steps_dir.exists():
        print('steps/ ディレクトリがありません')
        return

    files = list(steps_dir.glob('**/*.jpg')) + list(steps_dir.glob('**/*.jpeg')) + list(steps_dir.glob('**/*.png'))
    print(f'{len(files)} 件のステップスクリーンショットをアップロード...')

    for f in files:
        # パス: steps/{spec}/{movie}/{stepId}.jpg
        rel = f.relative_to(Path(args.reports_dir))
        s3_key = str(rel)

        # presigned URL 取得
        r = requests.post(f'{api_url}/assets/upload-url',
            headers=headers,
            json={'key': s3_key, 'contentType': 'image/jpeg'})
        if r.status_code != 200:
            print(f'  ✘ {s3_key}: URL取得失敗 {r.status_code}')
            continue

        upload_url = r.json().get('uploadUrl')
        # アップロード
        with open(f, 'rb') as fp:
            r2 = requests.put(upload_url, data=fp.read(), headers={'Content-Type': 'image/jpeg'})
        if r2.status_code in (200, 204):
            print(f'  ✓ {s3_key} ({f.stat().st_size // 1024}KB)')
        else:
            print(f'  ✘ {s3_key}: {r2.status_code}')

if __name__ == '__main__':
    main()
