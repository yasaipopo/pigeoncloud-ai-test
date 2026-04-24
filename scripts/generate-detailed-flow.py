#!/usr/bin/env python3
"""
spec.js の [flow]/[check] コメントから yaml の detailed_flow と screenshot-map.json を一括生成する。

spec.js が唯一の正（Single Source of Truth）。
yaml の detailed_flow は手書き禁止 — このスクリプトで自動生成する。

使い方:
  python3 scripts/generate-detailed-flow.py                    # 全spec
  python3 scripts/generate-detailed-flow.py dashboard          # 指定specのみ
  python3 scripts/generate-detailed-flow.py --dry-run          # yaml書き込みなし（確認用）
"""

import re
import os
import sys
import json
import glob
import yaml


# ============================================================
# 1. spec.js パーサー
# ============================================================

def parse_spec_js(filepath):
    """
    spec.js から test.step / [flow] / [check] / autoScreenshot を抽出する。

    返り値: {
        movie_id: {
            'cases': [
                {
                    'case_no': 'dash-030',
                    'title': 'ダッシュボードにビューコンテンツを追加できること',
                    'movie': 'DB01',
                    'steps': [
                        {'type': 'flow',  'num': '30-1', 'text': '作成したタブを選択'},
                        {'type': 'check', 'num': '30-4', 'text': 'エラーメッセージが表示されないこと'},
                    ]
                }
            ]
        }
    }
    """
    with open(filepath, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    movies = {}  # movie_id -> [cases]
    current_case = None
    current_movie = None

    for line in lines:
        stripped = line.strip()

        # test.step('dash-030: タイトル', ...) or test.step('102-1: タイトル', ...)
        step_match = re.match(
            r"await\s+test\.step\(\s*'([a-zA-Z0-9]+(?:-\d+)+):\s+(.+?)'",
            stripped
        )
        if step_match:
            case_no = step_match.group(1)
            title = step_match.group(2)
            current_case = {
                'case_no': case_no,
                'title': title,
                'movie': None,
                'steps': []
            }
            continue

        # autoScreenshot(page, 'DB01', 'dash-030', _testStart) or (page, 'NT01', 'ntf-010', ...)
        ss_match = re.match(
            r"await\s+autoScreenshot\(\s*page\s*,\s*'(\w+)'\s*,\s*'([a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)+)'",
            stripped
        )
        if ss_match and current_case:
            movie_id = ss_match.group(1)
            current_case['movie'] = movie_id
            current_movie = movie_id
            if movie_id not in movies:
                movies[movie_id] = []
            movies[movie_id].append(current_case)
            current_case = None
            continue

        # // [flow] 30-1. ... or // [flow] cl-010-1. ... or // [flow] 107-1-3. ...
        flow_match = re.match(
            r'//\s*\[flow\]\s+(?:[a-zA-Z]+-)?(\d+(?:-\d+)+[a-z]?)\.\s*(.*)',
            stripped
        )
        if flow_match and current_case:
            current_case['steps'].append({
                'type': 'flow',
                'num': flow_match.group(1),
                'text': flow_match.group(2).strip()
            })
            continue

        # // [check] 30-4. ✅ ... or // [check] 107-1-3. ✅ ...
        check_match = re.match(
            r'//\s*\[check\]\s+(?:[a-zA-Z]+-)?(\d+(?:-\d+)+[a-z]?)\.\s*✅\s*(.*)',
            stripped
        )
        if check_match and current_case:
            current_case['steps'].append({
                'type': 'check',
                'num': check_match.group(1),
                'text': check_match.group(2).strip()
            })
            continue

    return movies


# ============================================================
# 2. detailed_flow テキスト生成
# ============================================================

def generate_detailed_flow(movie_id, cases, old_case_map):
    """
    movie内の全caseからdetailed_flowテキストを生成する。

    old_case_map: case_no -> old_case_no（yamlから取得）
    """
    lines = []

    # ヘッダー
    lines.append(f'【{movie_id} テストフロー】この動画で確認するテスト番号:')
    for case in cases:
        old = old_case_map.get(case['case_no'], '')
        old_str = f'(旧: {old})' if old else ''
        # 固定幅フォーマット
        lines.append(f"  {case['case_no']:<15}{old_str:<16}{case['title']}")

    lines.append('')
    lines.append('━━━ 実行フロー ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    # 各ケースのフロー
    for case in cases:
        lines.append('')
        lines.append(f"{case['case_no']} ── {case['title']}")

        for step in case['steps']:
            if step['type'] == 'check':
                lines.append(f"{step['num']}. ✅ {step['text']}")
            else:
                lines.append(f"{step['num']}. {step['text']}")

    return '\n'.join(lines) + '\n'


# ============================================================
# 3. screenshot-map.json 生成
# ============================================================

def generate_screenshot_map_entry(movie_id, cases):
    """movie単位のscreenshot-mapエントリを生成"""
    checks = {}
    for case in cases:
        case_checks = []
        for step in case['steps']:
            if step['type'] == 'check':
                case_checks.append(step['num'])
        if case_checks:
            checks[case['case_no']] = case_checks

    return {
        'firstCase': cases[0]['case_no'] if cases else '',
        'checks': checks
    }


# ============================================================
# 4. yaml更新
# ============================================================

def update_yaml(yaml_path, spec_movies, dry_run=False):
    """yamlのdetailed_flowフィールドを更新する"""
    with open(yaml_path, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)

    if not data or 'cases' not in data:
        return

    # old_case_no マップ作成
    old_case_map = {}
    for case in data['cases']:
        if case.get('old_case_no'):
            old_case_map[case['case_no']] = case['old_case_no']

    # movie_id -> case_no のマッピング（yaml側）
    movie_cases = {}
    for case in data['cases']:
        movie = case.get('movie', '')
        if movie:
            if movie not in movie_cases:
                movie_cases[movie] = []
            movie_cases[movie].append(case['case_no'])

    # 各movieのdetailed_flowを生成・更新
    updated_movies = []
    for movie_id, cases in spec_movies.items():
        flow_text = generate_detailed_flow(movie_id, cases, old_case_map)

        # yaml内の該当movieの先頭ケースにdetailed_flowを設定
        yaml_case_nos = movie_cases.get(movie_id, [])
        if not yaml_case_nos:
            continue

        first_case_no = yaml_case_nos[0]

        for case in data['cases']:
            if case['case_no'] == first_case_no:
                case['detailed_flow'] = flow_text
                updated_movies.append(movie_id)
                break

            # 同一movieの先頭以外は参照文字列に
            if case.get('movie') == movie_id and case['case_no'] != first_case_no:
                case['detailed_flow'] = f'{movie_id}テストフロー参照（{first_case_no}のdetailed_flowと同一）'

    if dry_run:
        for movie_id in updated_movies:
            cases = spec_movies[movie_id]
            flow_text = generate_detailed_flow(movie_id, cases, old_case_map)
            print(f'\n--- {movie_id} ---')
            print(flow_text)
        return updated_movies

    # yaml書き込み（raw文字列操作でフォーマット維持）
    write_yaml_preserving_format(yaml_path, data)
    return updated_movies


def write_yaml_preserving_format(yaml_path, data):
    """yamlを書き出す（detailed_flowはリテラルブロック | で出力）"""

    class FlowDumper(yaml.SafeDumper):
        pass

    def str_representer(dumper, data):
        if '\n' in data:
            return dumper.represent_scalar('tag:yaml.org,2002:str', data, style='|')
        if any(c in data for c in ':{}[]&*?|>!%@`'):
            return dumper.represent_scalar('tag:yaml.org,2002:str', data, style="'")
        return dumper.represent_scalar('tag:yaml.org,2002:str', data)

    FlowDumper.add_representer(str, str_representer)

    with open(yaml_path, 'w', encoding='utf-8') as f:
        yaml.dump(data, f, Dumper=FlowDumper, allow_unicode=True,
                  default_flow_style=False, sort_keys=False, width=200)


# ============================================================
# 5. メイン
# ============================================================

def main():
    dry_run = '--dry-run' in sys.argv
    target_spec = None
    for arg in sys.argv[1:]:
        if not arg.startswith('-'):
            target_spec = arg

    project_root = os.path.join(os.path.dirname(__file__), '..')
    tests_dir = os.path.join(project_root, 'tests')
    specs_dir = os.path.join(project_root, 'specs')
    map_output = os.path.join(tests_dir, 'helpers', 'screenshot-map.json')

    # spec.jsファイル一覧
    spec_files = sorted(glob.glob(os.path.join(tests_dir, '*.spec.js')))
    if target_spec:
        spec_files = [f for f in spec_files if target_spec in os.path.basename(f)]

    all_screenshot_map = {}
    total_updated = 0

    # 既存のscreenshot-map.jsonを読み込み（部分更新のため）
    if os.path.exists(map_output) and target_spec:
        with open(map_output, 'r', encoding='utf-8') as f:
            all_screenshot_map = json.load(f)

    for spec_file in spec_files:
        spec_name = os.path.basename(spec_file).replace('.spec.js', '')
        yaml_path = os.path.join(specs_dir, f'{spec_name}.yaml')

        if not os.path.exists(yaml_path):
            continue

        # spec.js パース
        movies = parse_spec_js(spec_file)
        if not movies:
            print(f'  ⏭ {spec_name}: [flow]/[check] コメントなし')
            continue

        # yaml更新
        updated = update_yaml(yaml_path, movies, dry_run=dry_run)

        # screenshot-map生成
        spec_map = {}
        for movie_id, cases in movies.items():
            spec_map[movie_id] = generate_screenshot_map_entry(movie_id, cases)
        all_screenshot_map[spec_name] = spec_map

        case_count = sum(len(c) for c in movies.values())
        check_count = sum(
            sum(1 for s in case['steps'] if s['type'] == 'check')
            for cases in movies.values() for case in cases
        )
        print(f'  ✅ {spec_name}: {len(movies)} movies, {case_count} cases, {check_count} ✅ checks'
              + (f' (updated: {", ".join(updated)})' if updated else ''))
        total_updated += len(updated or [])

    # screenshot-map.json 書き出し
    if not dry_run:
        os.makedirs(os.path.dirname(map_output), exist_ok=True)
        with open(map_output, 'w', encoding='utf-8') as f:
            json.dump(all_screenshot_map, f, ensure_ascii=False, indent=2)
        print(f'\n📸 screenshot-map.json 更新完了: {map_output}')

    total_specs = len([s for s in all_screenshot_map if all_screenshot_map[s]])
    total_checks = sum(
        sum(len(lines) for lines in m['checks'].values())
        for s in all_screenshot_map.values() for m in s.values()
    )
    print(f'📊 合計: {total_specs} specs, {total_checks} ✅ points, {total_updated} movies updated')

    if dry_run:
        print('\n⚠️  --dry-run モード: yamlは更新されていません')


if __name__ == '__main__':
    main()
