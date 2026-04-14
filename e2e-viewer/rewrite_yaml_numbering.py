#!/usr/bin/env python3
"""
specs/*.yaml を一括で新採番 + movie単位 detailedFlow 整理するスクリプト

採番ルール: {spec_prefix}-{3桁 10刻み}  例: dash-010, rec-020
  - 途中挿入は dash-015 など空き番号を使う
  - 削除しても番号を詰めない

詳細フロー整理:
  - 同じ movie の先頭ケース → 完全なフロー（全ケースのタイムスタンプ一覧付き）
  - 2番目以降 → 短い参照テキスト

使い方:
    python3 e2e-viewer/rewrite_yaml_numbering.py
    python3 e2e-viewer/rewrite_yaml_numbering.py --spec dashboard
    python3 e2e-viewer/rewrite_yaml_numbering.py --dry-run
"""
import yaml
import sys
import argparse
import glob
import os
import re
from pathlib import Path
from collections import OrderedDict

# spec名 → 短いプレフィックスの対応表
SPEC_PREFIX = {
    'auth':                   'auth',
    'chart-calendar':         'cc',
    'chart-calendar-2':       'cc2',
    'comments-logs':          'cl',
    'csv-export':             'csv',
    'dashboard':              'dash',
    'fields':                 'fld',
    'fields-2':               'fld2',
    'fields-3':               'fld3',
    'fields-4':               'fld4',
    'fields-5':               'fld5',
    'filters':                'fil',
    'layout-ui':              'lui',
    'notifications':          'ntf',
    'notifications-2':        'ntf2',
    'payment':                'pay',
    'public-form':            'pf',
    'records':                'rec',
    'reports':                'rpt',
    'rpa':                    'rpa',
    'system-settings':        'sys',
    'table-definition':       'tbl',
    'templates':              'tpl',
    'uncategorized':          'unc',
    'uncategorized-2':        'unc2',
    'uncategorized-3':        'unc3',
    'uncategorized_with_flow':'uncf',
    'users-permissions':      'up',
    'workflow':               'wf',
}


def make_movie_header(cases_in_movie, spec_prefix):
    """movie内の全ケースをリストした見出しテキストを生成"""
    lines = []
    for c in cases_in_movie:
        new_no  = c.get('case_no', '')
        old_no  = str(c.get('old_case_no', ''))
        feature = c.get('feature', '')
        old_str = f' (旧: {old_no})' if old_no else ''
        lines.append(f'  {new_no:<14}{old_str:<12}  {feature}')
    return '\n'.join(lines)


def make_first_case_flow(movie, cases_in_movie, spec_prefix, original_flow):
    """先頭ケースの detailedFlow: 確認テスト番号一覧 + 元のフロー"""
    header = (
        f'【{movie} テストフロー】この動画で確認するテスト番号:\n'
        + make_movie_header(cases_in_movie, spec_prefix)
        + '\n'
    )
    if original_flow and original_flow.strip():
        return header + '\n━━━ 実行フロー ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' + original_flow.strip()
    return header


def make_ref_flow(movie, first_case_no):
    """2番目以降のケースの短い参照テキスト"""
    return f'{movie}テストフロー参照（{first_case_no} のdetailed_flowと同一）'


def process_yaml(filepath, dry_run=False):
    spec_name = Path(filepath).stem
    prefix = SPEC_PREFIX.get(spec_name, spec_name[:6])

    with open(filepath, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)

    if not data or 'cases' not in data:
        print(f'  SKIP {spec_name}: casesなし')
        return False

    cases = data['cases']

    # すでに全件新採番済みならスキップ
    already_done = all(
        str(c.get('case_no', '')).startswith(prefix + '-') for c in cases
    )
    if already_done and all('old_case_no' in c for c in cases):
        print(f'  SKIP {spec_name}: 採番済み')
        return False

    # ─── Step 1: 新採番 ───────────────────────────────────────────
    for i, case in enumerate(cases):
        old_no = str(case.get('case_no', ''))
        if not old_no.startswith(prefix + '-'):
            case['old_case_no'] = old_no
            case['case_no'] = f'{prefix}-{(i+1)*10:03d}'

    # ─── Step 2: movie 単位で detailedFlow を整理 ────────────────
    # movie ごとにグループ化（順序維持）
    movie_groups = OrderedDict()
    for case in cases:
        movie = case.get('movie', '')
        if movie not in movie_groups:
            movie_groups[movie] = []
        movie_groups[movie].append(case)

    for movie, group in movie_groups.items():
        if not movie:
            continue  # movie未設定はスキップ

        first = group[0]
        first_new_no = first['case_no']
        orig_flow = first.get('detailed_flow', '')

        # 先頭ケース: ヘッダー付きフロー
        first['detailed_flow'] = make_first_case_flow(movie, group, prefix, orig_flow)

        # 2番目以降: 短い参照テキスト
        for case in group[1:]:
            case['detailed_flow'] = make_ref_flow(movie, first_new_no)

    # ─── Step 3: 書き込み ─────────────────────────────────────────
    data['cases'] = cases

    if dry_run:
        print(f'  DRY-RUN {spec_name}: {len(cases)}件 prefix={prefix}')
        for c in cases[:3]:
            print(f'    {c["case_no"]} (旧: {c.get("old_case_no","")}) movie={c.get("movie","")}')
        return True

    # YAML書き込み（ruamel等がないのでシンプルに dump）
    # ただし yaml.dump は日本語を \u で書くので ensure_ascii=False 等の設定が必要
    class LiteralStr(str): pass
    def literal_representer(dumper, data):
        if '\n' in data:
            return dumper.represent_scalar('tag:yaml.org,2002:str', data, style='|')
        return dumper.represent_scalar('tag:yaml.org,2002:str', data)
    yaml.add_representer(LiteralStr, literal_representer)
    yaml.add_representer(str, literal_representer)

    with open(filepath, 'w', encoding='utf-8') as f:
        yaml.dump(data, f, allow_unicode=True, default_flow_style=False,
                  sort_keys=False, width=120)

    print(f'  OK    {spec_name}: {len(cases)}件 prefix={prefix}')
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--spec', default='', help='対象spec（例: dashboard）')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    script_dir = Path(__file__).parent
    specs_dir = script_dir.parent / 'specs'

    yaml_files = sorted(specs_dir.glob('*.yaml'))
    if args.spec:
        yaml_files = [f for f in yaml_files if args.spec in f.stem]

    # auth は既に完了済みなのでスキップ
    yaml_files = [f for f in yaml_files if f.stem != 'auth']

    print(f'対象: {len(yaml_files)}ファイル')
    changed = 0
    for f in yaml_files:
        try:
            if process_yaml(str(f), dry_run=args.dry_run):
                changed += 1
        except Exception as e:
            print(f'  ERROR {f.name}: {e}')

    print(f'\n完了: {changed}ファイル更新')


if __name__ == '__main__':
    main()
