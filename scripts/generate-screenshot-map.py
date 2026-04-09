#!/usr/bin/env python3
"""
yamlのdetailedFlowから✅行の番号を抽出し、screenshot-map.jsonを生成する。

生成されるJSON:
{
  "comments-logs": {
    "CL01": {
      "firstCase": "cl-010",
      "checks": {
        "cl-010": [2, 3],
        "cl-020": [5, 6],
        "cl-070": [8, 9]
      }
    }
  }
}

sheet.htmlが期待するスクショファイル名:
  steps/{spec}/{movie}/{firstCase}-s{lineNum}.jpg

使い方:
  python3 scripts/generate-screenshot-map.py
"""

import yaml
import json
import os
import re
import glob

def parse_detailed_flow(flow_text):
    """detailedFlowテキストから各ケースの✅行番号を抽出する"""
    if not flow_text or '━━━' not in flow_text:
        return {}

    lines = flow_text.split('\n')
    current_case = None
    case_checks = {}

    for line in lines:
        trimmed = line.strip()

        # ケースヘッダー検出: [0:00] case-no ── title
        case_match = re.match(r'\[[\d:]+\]\s+(\S+)\s+──', trimmed)
        if case_match:
            current_case = case_match.group(1)
            if current_case not in case_checks:
                case_checks[current_case] = []
            continue

        # タイムスタンプなしのケースヘッダー: case-no ── title
        case_match2 = re.match(r'^(\w[\w-]+)\s+──', trimmed)
        if case_match2 and not trimmed.startswith(('━', '【', '#')):
            current_case = case_match2.group(1)
            if current_case not in case_checks:
                case_checks[current_case] = []
            continue

        # 番号付きステップの✅検出: N. ✅ ... または N-N. ✅ ...
        step_match = re.match(r'^(\d+(?:-\d+)?)\.\s*✅', trimmed)
        if step_match and current_case:
            line_num = step_match.group(1)  # "10-2" or "30-4" 等
            case_checks[current_case].append(line_num)

    return case_checks


def main():
    specs_dir = os.path.join(os.path.dirname(__file__), '..', 'specs')
    output_path = os.path.join(os.path.dirname(__file__), '..', 'tests', 'helpers', 'screenshot-map.json')

    result = {}

    for yaml_file in sorted(glob.glob(os.path.join(specs_dir, '*.yaml'))):
        spec_name = os.path.basename(yaml_file).replace('.yaml', '')

        with open(yaml_file, 'r', encoding='utf-8') as f:
            try:
                data = yaml.safe_load(f)
            except Exception as e:
                print(f'  ⚠️ {spec_name}: YAML parse error: {e}')
                continue

        if not data or 'cases' not in data:
            continue

        # movie → 先頭ケースのマッピングを作成
        movie_first_case = {}
        for case in data['cases']:
            movie = case.get('movie', '')
            if movie and movie not in movie_first_case:
                movie_first_case[movie] = case['case_no']

        # detailedFlowがフル記述のケースを処理
        spec_data = {}
        for case in data['cases']:
            movie = case.get('movie', '')
            flow = case.get('detailed_flow', '')
            if not isinstance(flow, str) or '━━━' not in flow:
                continue

            case_checks = parse_detailed_flow(flow)
            if not case_checks:
                continue

            first_case = movie_first_case.get(movie, case['case_no'])

            spec_data[movie] = {
                'firstCase': first_case,
                'checks': case_checks
            }

        if spec_data:
            result[spec_name] = spec_data

    # JSON出力
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    # サマリー
    total_movies = sum(len(v) for v in result.values())
    total_checks = sum(
        sum(len(lines) for lines in movie_data['checks'].values())
        for spec_data in result.values()
        for movie_data in spec_data.values()
    )
    print(f'screenshot-map.json 生成完了: {len(result)} specs, {total_movies} movies, {total_checks} ✅ points')
    print(f'出力先: {output_path}')


if __name__ == '__main__':
    main()
