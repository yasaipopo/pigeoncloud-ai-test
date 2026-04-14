#!/usr/bin/env python3
"""
uncategorized.yaml の detailed_flow を人間向けフローに書き直すスクリプト
- 各movieの先頭ケースにフル記述
- 残りのケースは「XXXテストフロー参照（unc-YYY のdetailed_flowと同一）」
"""

import yaml
import re

# Pythonのyamlダンプでブロックスタイルを維持するためのカスタム設定
class LiteralStr(str):
    pass

def literal_representer(dumper, data):
    if '\n' in data:
        return dumper.represent_scalar('tag:yaml.org,2002:str', data, style='|')
    return dumper.represent_scalar('tag:yaml.org,2002:str', data)

yaml.add_representer(LiteralStr, literal_representer)

def make_literal(s):
    if s is None:
        return None
    return LiteralStr(s) if '\n' in str(s) else s

# description からステップリストを抽出（①②③...）
def extract_steps(description):
    if not description:
        return []
    steps = []
    for line in description.strip().split('\n'):
        line = line.strip()
        if line:
            steps.append(line)
    return steps

# description の丸数字を除去して読みやすいステップに変換
def clean_step(step):
    return re.sub(r'^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]', '', step).strip()

# expected からアサーション（✅）リストを生成
def extract_assertions(expected):
    if not expected:
        return []
    lines = [l.strip() for l in expected.strip().split('\n') if l.strip()]
    assertions = []
    for line in lines:
        # 「・」「●」「-」で始まる行はそのまま
        line = re.sub(r'^[・●\-]', '', line).strip()
        if line:
            assertions.append(line)
    return assertions

def generate_detailed_flow(movie, cases_in_movie, first_case):
    """movieの先頭ケース用のdetailed_flowを生成する"""

    # ヘッダー: テスト番号一覧
    header_lines = [f'【{movie} テストフロー】この動画で確認するテスト番号:']
    for case in cases_in_movie:
        case_no = case['case_no']
        old_no = case.get('old_case_no', '')
        feature = case.get('feature', '')
        header_lines.append(f'  {case_no:<15}(旧: {old_no:<8}) {feature}')

    header_lines.append('')
    header_lines.append('━━━ 実行フロー ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    header_lines.append('')

    # 先頭ケースの操作ステップ
    description = first_case.get('description', '')
    expected = first_case.get('expected', '')

    steps = extract_steps(description)
    assertions = extract_assertions(expected)

    flow_lines = []

    # ケース番号とタイトル
    case_no = first_case['case_no']
    old_no = first_case.get('old_case_no', '')
    feature = first_case.get('feature', '')
    flow_lines.append(f'[0:00] {case_no} ── {feature}')

    # 操作ステップ（最大6行）
    for i, step in enumerate(steps[:6], 1):
        clean = clean_step(step)
        if clean:
            flow_lines.append(f'{i}. {clean}')

    # アサーション（✅）
    for assertion in assertions[:5]:
        if assertion:
            flow_lines.append(f'✅ {assertion}')

    all_lines = header_lines + flow_lines
    return '\n'.join(all_lines)

def main():
    yaml_path = '/Users/yasaipopo/PycharmProjects/pigeon-test/specs/uncategorized.yaml'

    with open(yaml_path, 'r', encoding='utf-8') as f:
        content = f.read()
        data = yaml.safe_load(content)

    cases = data['cases']

    # movieごとにケースを整理
    movies = {}
    movie_order = []
    movie_first = {}
    for case in cases:
        movie = case.get('movie', 'NONE')
        if movie not in movies:
            movies[movie] = []
            movie_order.append(movie)
            movie_first[movie] = case
        movies[movie].append(case)

    # 各ケースのdetailed_flowを更新
    updated_count = 0
    for case in cases:
        movie = case.get('movie', 'NONE')
        first_case = movie_first[movie]
        cases_in_movie = movies[movie]

        if case['case_no'] == first_case['case_no']:
            # 先頭ケース: フル記述
            new_flow = generate_detailed_flow(movie, cases_in_movie, first_case)
            case['detailed_flow'] = LiteralStr(new_flow)
            updated_count += 1
            print(f'  [先頭] {case["case_no"]} ({movie}) - フル記述生成')
        else:
            # それ以外: 参照テキスト
            ref_text = f'{movie}テストフロー参照（{first_case["case_no"]} のdetailed_flowと同一）'
            case['detailed_flow'] = ref_text
            updated_count += 1

    print(f'\n合計 {updated_count} 件更新')

    # YAMLを書き出す
    # カスタムダンパーで書き出し
    output_lines = []
    output_lines.append(f'group: {data["group"]}')
    output_lines.append(f'spec_file: {data["spec_file"]}')
    output_lines.append(f"base_url: '{data['base_url']}'")
    output_lines.append('cases:')

    for case in cases:
        output_lines.append(dump_case(case))

    output_content = '\n'.join(output_lines) + '\n'

    with open(yaml_path, 'w', encoding='utf-8') as f:
        f.write(output_content)

    print(f'書き込み完了: {yaml_path}')

def quote_yaml_str(s):
    """文字列をYAMLとして適切にエスケープ"""
    if s is None:
        return ''
    s = str(s)
    # シングルクォートをエスケープ
    if "'" in s and '"' not in s:
        return f'"{s}"'
    elif "'" in s:
        escaped = s.replace("'", "''")
        return f"'{escaped}'"
    elif any(c in s for c in [':', '{', '}', '[', ']', ',', '&', '*', '#', '?', '|', '-', '<', '>', '=', '!', '%', '@', '`']):
        escaped = s.replace("'", "''")
        return f"'{escaped}'"
    return s

def dump_case(case):
    """1ケースをYAML文字列にダンプ"""
    lines = ['- ']
    first = True

    # フィールドの順序を維持
    fields_order = ['case_no', 'sheet', 'feature', 'description', 'expected', 'movie', 'target_spec', 'detailed_flow', 'old_case_no']

    all_keys = list(case.keys())
    ordered_keys = [k for k in fields_order if k in case]
    remaining_keys = [k for k in all_keys if k not in fields_order]
    keys = ordered_keys + remaining_keys

    result_lines = []

    for i, key in enumerate(keys):
        val = case[key]
        prefix = '- ' if i == 0 else '  '

        if val is None:
            continue

        if isinstance(val, str) and '\n' in val:
            # ブロックスカラー
            indented = '\n'.join('    ' + line for line in val.split('\n'))
            result_lines.append(f'{prefix}{key}: |-')
            result_lines.append(indented)
        elif isinstance(val, str):
            # 通常文字列
            s = val
            needs_quote = False
            if s.startswith("'") or s.startswith('"'):
                needs_quote = True
            elif any(c in s for c in [':', '{', '}', '[', ']', '#', '&', '*', '!', '|', '>', "'", '"', '%', '@', '`']):
                needs_quote = True
            elif s.startswith('-') or s.startswith('?'):
                needs_quote = True

            if needs_quote:
                escaped = s.replace("'", "''")
                result_lines.append(f"{prefix}{key}: '{escaped}'")
            else:
                result_lines.append(f'{prefix}{key}: {s}')
        elif isinstance(val, bool):
            result_lines.append(f'{prefix}{key}: {str(val).lower()}')
        elif isinstance(val, int) or isinstance(val, float):
            result_lines.append(f'{prefix}{key}: {val}')
        else:
            result_lines.append(f'{prefix}{key}: {val}')

    return '\n'.join(result_lines)

if __name__ == '__main__':
    main()
