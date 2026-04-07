#!/usr/bin/env python3
"""
全spec.jsの stepScreenshot 呼び出しを autoScreenshot に一括変換する。

変換前:
  await stepScreenshot(page, 'comments-logs', 'CL01', 'cl-010-s4', _testStart);

変換後:
  await autoScreenshot(page, 'CL01', 'cl-010', 0, _testStart);

やること:
1. 古い stepScreenshot 関数定義を削除
2. createAutoScreenshot の import を追加
3. autoScreenshot 変数の初期化を追加
4. 各 stepScreenshot 呼び出しを autoScreenshot に変換
   - caseNo は stepId から抽出（'cl-010-s4' → 'cl-010'）
   - checkIndex はそのcaseNoの何回目の呼び出しかをカウント
"""

import re
import os
import glob
import json

def get_spec_name_from_file(filepath):
    """ファイルパスからspec名を取得"""
    basename = os.path.basename(filepath).replace('.spec.js', '')
    return basename

def migrate_file(filepath, screenshot_map):
    """1ファイルを変換する"""
    spec_name = get_spec_name_from_file(filepath)

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # stepScreenshot関数定義がなければスキップ
    if 'async function stepScreenshot' not in content:
        return False

    lines = content.split('\n')
    new_lines = []

    # --- Phase 1: stepScreenshot関数定義を削除 ---
    in_step_screenshot_func = False
    brace_count = 0
    func_removed = False

    i = 0
    while i < len(lines):
        line = lines[i]

        # stepScreenshot関数の開始を検出
        if 'async function stepScreenshot' in line and not in_step_screenshot_func:
            in_step_screenshot_func = True
            brace_count = 0
            # この行からブレースを数える
            brace_count += line.count('{') - line.count('}')
            i += 1
            continue

        if in_step_screenshot_func:
            brace_count += line.count('{') - line.count('}')
            if brace_count <= 0:
                in_step_screenshot_func = False
                func_removed = True
                # 関数直後の空行も削除
                i += 1
                while i < len(lines) and lines[i].strip() == '':
                    i += 1
                continue
            i += 1
            continue

        new_lines.append(line)
        i += 1

    if not func_removed:
        print(f'  ⚠️ {spec_name}: stepScreenshot関数定義が見つかりませんでした')
        return False

    content = '\n'.join(new_lines)

    # --- Phase 2: import追加 ---
    # 既にcreateAutoScreenshotがインポートされていなければ追加
    if 'createAutoScreenshot' not in content:
        # 最初のrequire行の後に追加
        require_pattern = r"(const \{[^}]+\} = require\([^)]+\);)"
        match = re.search(require_pattern, content)
        if match:
            insert_pos = match.end()
            import_line = f"\nconst {{ createAutoScreenshot }} = require('./helpers/auto-screenshot');"
            content = content[:insert_pos] + import_line + content[insert_pos:]

    # --- Phase 3: autoScreenshot変数の初期化を追加 ---
    if f"createAutoScreenshot('{spec_name}')" not in content:
        # test.describe の直前に追加
        describe_match = re.search(r"test\.describe\(", content)
        if describe_match:
            insert_pos = describe_match.start()
            init_line = f"const autoScreenshot = createAutoScreenshot('{spec_name}');\n\n"
            content = content[:insert_pos] + init_line + content[insert_pos:]

    # --- Phase 4: stepScreenshot呼び出しを変換 ---
    # 各caseNoの呼び出し回数をカウントするために、まず全呼び出しを収集
    call_pattern = r"await stepScreenshot\(page,\s*'[^']+',\s*'([^']+)',\s*'([^']+)',\s*_testStart\);"

    # caseNoごとの呼び出しカウンター
    case_counters = {}

    def replace_call(match):
        movie = match.group(1)
        step_id = match.group(2)

        # stepIdからcaseNoを抽出: 'cl-010-s4' → 'cl-010'
        # パターン: {caseNo}-s{N} or {caseNo}-s{caseNo}-{N}
        case_match = re.match(r'(.+?)-s\d+$', step_id)
        if case_match:
            case_no = case_match.group(1)
        else:
            case_no = step_id

        # このcaseNoの何回目の呼び出しか
        key = f"{movie}/{case_no}"
        if key not in case_counters:
            case_counters[key] = 0
        check_index = case_counters[key]
        case_counters[key] += 1

        return f"await autoScreenshot(page, '{movie}', '{case_no}', {check_index}, _testStart);"

    content = re.sub(call_pattern, replace_call, content)

    # 残っているstepScreenshot呼び出しがないか確認
    remaining = len(re.findall(r'stepScreenshot\(', content))
    if remaining > 0:
        print(f'  ⚠️ {spec_name}: {remaining}個のstepScreenshot呼び出しが変換されませんでした')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

    converted = sum(case_counters.values())
    print(f'  ✅ {spec_name}: {converted}個の呼び出しを変換')
    return True


def main():
    specs_dir = os.path.join(os.path.dirname(__file__), '..', 'tests')
    map_path = os.path.join(specs_dir, 'helpers', 'screenshot-map.json')

    with open(map_path, 'r', encoding='utf-8') as f:
        screenshot_map = json.load(f)

    spec_files = sorted(glob.glob(os.path.join(specs_dir, '*.spec.js')))

    converted = 0
    for filepath in spec_files:
        if migrate_file(filepath, screenshot_map):
            converted += 1

    print(f'\n変換完了: {converted}ファイル')
    print('次のステップ: テスト実行してスクショが正しいファイル名で保存されるか確認')


if __name__ == '__main__':
    main()
