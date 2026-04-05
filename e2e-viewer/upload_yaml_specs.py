#!/usr/bin/env python3
"""
PigeonCloud E2E - specs/*.yaml を pipeline テーブルに同期するスクリプト

specs/*.yaml に記載された case_no / old_case_no / movie / detailed_flow などを
pipeline テーブルに書き込む。overwrite=true で既存データも上書き。

使い方:
    E2E_API_URL=https://... python3 e2e-viewer/upload_yaml_specs.py
    E2E_API_URL=https://... python3 e2e-viewer/upload_yaml_specs.py --dry-run
    E2E_API_URL=https://... python3 e2e-viewer/upload_yaml_specs.py --spec auth

環境変数:
    E2E_API_URL      - APIエンドポイント（必須）
    E2E_API_PASSWORD - APIパスワード（デフォルト: pigeon-e2e-2026）
"""

import os
import sys
import json
import glob
import hashlib
import argparse
import urllib.request
from pathlib import Path

try:
    import yaml
except ImportError:
    print('ERROR: pyyaml が必要です。pip install pyyaml を実行してください', file=sys.stderr)
    sys.exit(1)

TOKEN_SALT = 'pigeon-e2e-viewer-salt-2026'


def generate_token(password: str) -> str:
    raw = f"{password}{TOKEN_SALT}"
    return hashlib.sha256(raw.encode()).hexdigest()


def api_post(api_url: str, path: str, data: dict, token: str) -> dict:
    body = json.dumps(data, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(
        f'{api_url.rstrip("/")}{path}',
        data=body,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}'
        },
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode('utf-8'))


def load_yaml_spec(filepath: str) -> dict:
    """specs/*.yaml を読み込んでパース"""
    with open(filepath, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)
    return data


def yaml_to_pipeline_cases(yaml_data: dict) -> list:
    """YAMLデータを pipeline/init 用ケースリストに変換"""
    cases = []
    for case in yaml_data.get('cases', []):
        case_no = str(case.get('case_no', ''))
        if not case_no:
            continue

        pipeline_case = {
            'caseNo': case_no,
            'oldCaseNo': str(case.get('old_case_no', '')),
            'feature': case.get('feature', ''),
            'description': case.get('description', '') or '',
            'expected': case.get('expected', '') or '',
            'movie': case.get('movie', ''),
            'detailedFlow': case.get('detailed_flow', '') or '',
        }
        # 説明文の改行を正規化
        for field in ('description', 'expected', 'detailedFlow'):
            if isinstance(pipeline_case[field], str):
                pipeline_case[field] = pipeline_case[field].strip()

        cases.append(pipeline_case)
    return cases


def main():
    parser = argparse.ArgumentParser(description='specs/*.yaml を pipeline テーブルに同期')
    parser.add_argument('--dry-run', action='store_true', help='APIに送信せず内容を表示')
    parser.add_argument('--spec', default='', help='対象specを絞り込む（例: auth）')
    parser.add_argument('--overwrite', action='store_true', default=True,
                        help='既存データも上書き（デフォルト: True）')
    args = parser.parse_args()

    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    specs_dir = project_root / 'specs'

    yaml_files = sorted(specs_dir.glob('*.yaml'))
    if not yaml_files:
        print(f'ERROR: {specs_dir}/*.yaml が見つかりません', file=sys.stderr)
        sys.exit(1)

    # specフィルタ
    if args.spec:
        yaml_files = [f for f in yaml_files if args.spec in f.stem]

    api_url = os.environ.get('E2E_API_URL', '')
    password = os.environ.get('E2E_API_PASSWORD', 'pigeon-e2e-2026')
    token = generate_token(password)

    if not api_url and not args.dry_run:
        print('ERROR: E2E_API_URL が設定されていません', file=sys.stderr)
        sys.exit(1)

    all_specs = []
    for yaml_file in yaml_files:
        try:
            data = load_yaml_spec(str(yaml_file))
            spec_name = yaml_file.stem  # auth, records, etc.
            cases = yaml_to_pipeline_cases(data)
            all_specs.append({'spec': spec_name, 'cases': cases})
            print(f'  {yaml_file.name}: {len(cases)}件'
                  + (f' (新番号あり: {sum(1 for c in cases if c["oldCaseNo"])}件)' if any(c["oldCaseNo"] for c in cases) else ''))
        except Exception as e:
            print(f'  WARNING: {yaml_file.name} のパースに失敗: {e}', file=sys.stderr)

    if args.dry_run:
        print('\n--- pipeline/init payload (preview) ---')
        preview = json.dumps({'specs': all_specs, 'overwrite': args.overwrite},
                             ensure_ascii=False, indent=2)
        print(preview[:1000] + '...' if len(preview) > 1000 else preview)
        return

    # 一括送信
    print(f'\n[upload_yaml_specs] {len(all_specs)}件のspecを pipeline/init に送信中...')
    try:
        result = api_post(api_url, '/pipeline/init', {
            'specs': all_specs,
            'overwrite': args.overwrite
        }, token)
        print(f'[upload_yaml_specs] 完了: {result}')
    except Exception as e:
        print(f'ERROR: 送信失敗: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
