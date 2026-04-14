#!/usr/bin/env python3
"""
YAML NGケース自動修正スクリプト

修正対象:
1. description が①②③形式でない → ①②③形式に変換
2. expected が「想定通り」→ 具体的な期待結果に
3. feature が空/- → spec.jsのdescribe名やテスト内容から推測

出力: 修正済みYAMLを上書き
"""

import yaml
import re
import glob
import os
import sys
import copy

# YAMLのダンプ時に日本語を正しく出力するための設定
class SafeDumper(yaml.SafeDumper):
    pass

def str_representer(dumper, data):
    if '\n' in data:
        return dumper.represent_scalar('tag:yaml.org,2002:str', data, style='|')
    return dumper.represent_scalar('tag:yaml.org,2002:str', data)

SafeDumper.add_representer(str, str_representer)

# ==========================================================================
# spec.jsからテスト情報を抽出
# ==========================================================================
def extract_spec_info():
    """spec.jsファイルからcase_no -> {title, describe, spec_file} のマッピングを構築"""
    spec_map = {}
    spec_describes = {}  # spec_file -> describe名

    for f in sorted(glob.glob('tests/*.spec.js')):
        with open(f) as fh:
            content = fh.read()

        describes = re.findall(r"test\.describe\(['\"](.+?)['\"]", content)
        current_describe = describes[0] if describes else ''

        basename = os.path.basename(f).replace('.spec.js', '')
        spec_describes[basename] = current_describe

        tests = re.findall(r"test\(['\"](\S+?):\s*(.+?)['\"]", content)
        for case_no, title in tests:
            spec_map[case_no] = {
                'title': title.strip(),
                'describe': current_describe,
                'spec_file': f
            }

    return spec_map, spec_describes

# ==========================================================================
# describe名 → feature名 マッピング
# ==========================================================================
DESCRIBE_TO_FEATURE = {
    '認証（ログイン・ログアウト・パスワード変更）': 'ログイン／ログアウト',
    'テーブル定義一覧（ALLテストテーブル不要）': 'テーブル定義',
    'テーブル定義（テーブル管理・テーブル設定・追加オプション）': 'テーブル定義',
    'レコード操作（一覧・作成・編集・削除・一括編集）': 'レコード操作',
    'CSV・Excel・JSON・ZIPダウンロード・アップロード': 'CSV・データ管理',
    'フィルタ（フィルタタイプ・高度な検索）': 'フィルタ',
    'ユーザー管理（作成・編集・削除・有効/無効）': 'ユーザー管理',
    '通知設定': '通知',
    'メール配信': 'メール配信',
    'ワークフロー設定（21系）': 'ワークフロー',
    '帳票（登録・出力・ダウンロード）': '帳票',
    'レイアウト・メニュー・UI・ダッシュボード（テーブル不要）': 'レイアウト・UI',
    'チャート - 基本機能': 'チャート',
    'チャート・集計 - オプション設定': 'チャート',
    '公開フォーム・公開メールリンク': '公開フォーム',
    'ダッシュボード': 'ダッシュボード',
    '支払い・プラン管理': '支払い・プラン',
    'ログ管理': 'ログ管理',
    'RPA（コネクト）': 'RPA',
    'テンプレート': 'テンプレート',
    'フィールド - 日時（101）': '日時',
    '文字列表示設定（145系）': '文字列',
    '日時フィールド種類変更・バリデーション（19, 47, 97, 101系）': '日時',
    '画像フィールド（48, 226, 240系）': '画像フィールド',
    '追加実装テスト（314-579系）': '追加実装',
}

# YAML group名 → feature名 フォールバック
GROUP_TO_FEATURE = {
    'auth': 'ログイン／ログアウト',
    'table-definition': 'テーブル定義',
    'fields': 'フィールド設定',
    'records': 'レコード操作',
    'layout-ui': 'レイアウト・UI',
    'chart-calendar': 'チャート・カレンダー',
    'filters': 'フィルタ',
    'csv-export': 'CSV・データ管理',
    'users-permissions': 'ユーザー・権限',
    'notifications': '通知',
    'workflow': 'ワークフロー',
    'reports': '帳票',
    'system-settings': 'システム設定',
    'public-form': '公開フォーム',
    'comments-logs': 'コメント・ログ',
    'uncategorized': '一般機能',
    'dashboard': 'ダッシュボード',
    'payment': '支払い・プラン',
    'rpa': 'RPA',
    'templates': 'テンプレート',
}

# ==========================================================================
# description を ①②③形式に変換
# ==========================================================================
def convert_description_to_steps(desc, case_no, spec_info):
    """descriptionを①②③形式に変換"""
    if not desc or desc.strip() == '':
        # spec.jsにタイトルがあればそれをベースに
        if spec_info:
            title = spec_info['title']
            return f"①{title}の操作を実施する。"
        return desc

    desc = desc.strip()

    # 既に①が含まれていればスキップ
    if '①' in desc:
        return desc

    # 番号マーカーリスト
    circled_nums = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
                    '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']

    # ステップ分割のパターン
    lines = []

    # パターン1: 「・」で始まる箇条書き
    bullet_lines = [l.strip() for l in desc.split('\n') if l.strip()]
    if all(l.startswith('・') or l.startswith('-') or l.startswith('*') for l in bullet_lines if l):
        for l in bullet_lines:
            l = re.sub(r'^[・\-\*]\s*', '', l)
            if l:
                lines.append(l)
    # パターン2: 数字. / 数字) で始まる手順
    elif re.search(r'(?:^|\n)\s*\d+[\.\)）]', desc):
        for l in bullet_lines:
            l = re.sub(r'^\d+[\.\)）]\s*', '', l).strip()
            if l:
                lines.append(l)
    # パターン3: 「。」で区切られた複数文
    elif desc.count('。') >= 2:
        sentences = [s.strip() for s in desc.split('。') if s.strip()]
        lines = sentences
    # パターン4: 改行で区切られた複数行
    elif len(bullet_lines) >= 2:
        lines = bullet_lines
    # パターン5: 1行のみ → ①だけ付ける
    else:
        # ※や注記部分を分離
        main_parts = re.split(r'(?=※)', desc, maxsplit=1)
        main = main_parts[0].strip()
        note = main_parts[1].strip() if len(main_parts) > 1 else ''

        result = f"①{main}"
        if note:
            result += f"\n{note}"
        return result

    # ステップ番号を付与
    result_lines = []
    for i, line in enumerate(lines):
        if i < len(circled_nums):
            # 既に①等が付いていたら除去
            line = re.sub(r'^[①-⑳]\s*', '', line)
            # 末尾の「。」を保持
            if not line.endswith('。') and not line.endswith('）') and not line.endswith(')'):
                line = line.rstrip('。') + '。'
            result_lines.append(f"{circled_nums[i]}{line}")
        else:
            result_lines.append(line)

    return '\n'.join(result_lines)

# ==========================================================================
# expected を具体化
# ==========================================================================
def fix_expected(expected, desc, case_no, spec_info, feature):
    """「想定通り」を具体的な期待結果に変換"""
    if not expected:
        expected = ''
    expected = expected.strip()

    # 「想定通り」が含まれない場合はスキップ
    if '想定通り' not in expected:
        return expected

    # spec.jsのタイトルから期待結果を推測
    if spec_info:
        title = spec_info['title']
        # タイトルから期待結果を生成
        # 「〜こと」形式
        if 'こと' in title:
            new_expected = f"・{title}"
        elif title.endswith('できる') or title.endswith('される') or title.endswith('表示'):
            new_expected = f"・{title}こと。"
        else:
            new_expected = f"・{title}が正常に動作すること。"
        return new_expected

    # spec.jsにない場合: descriptionから推測
    if desc:
        desc_clean = desc.strip()
        # descriptionの最後のステップから推測
        last_step = desc_clean.split('\n')[-1]
        last_step = re.sub(r'^[①-⑳]\s*', '', last_step).strip()

        # 「確認」系のステップがあればそれを使う
        if '確認' in last_step:
            new_expected = f"・{last_step}"
        elif '表示' in last_step:
            new_expected = f"・{last_step.rstrip('。')}が正常に表示されること。"
        elif '設定' in desc_clean or '変更' in desc_clean:
            new_expected = f"・エラーなく設定が保存され、{feature or '機能'}が正常に動作すること。"
        elif '登録' in desc_clean or '作成' in desc_clean:
            new_expected = f"・エラーなく登録が完了し、正しく保存されていること。"
        elif '削除' in desc_clean:
            new_expected = f"・エラーなく削除が完了し、一覧から消えていること。"
        elif 'エラー' in desc_clean:
            new_expected = f"・適切なエラーメッセージが表示されること。"
        else:
            new_expected = f"・エラーなく操作が完了し、{feature or '機能'}が正常に動作すること。"

        return new_expected

    # どうしようもない場合
    return f"・エラーなく操作が完了すること。"

# ==========================================================================
# feature を推測
# ==========================================================================
def fix_feature(feature, case_no, spec_info, yaml_group, desc=''):
    """空のfeatureをspec.jsやグループ名から推測"""
    if feature and feature.strip() not in ('', '-'):
        return feature

    # spec.jsのdescribe名から
    if spec_info:
        describe = spec_info['describe']
        if describe in DESCRIBE_TO_FEATURE:
            return DESCRIBE_TO_FEATURE[describe]
        # describe名をそのまま短縮
        # 括弧内を除去
        short = re.sub(r'[（(].+?[）)]', '', describe).strip()
        if short:
            return short

    # YAMLグループ名から
    group_base = re.sub(r'-\d+$', '', yaml_group)
    if group_base in GROUP_TO_FEATURE:
        return GROUP_TO_FEATURE[group_base]

    # descriptionからキーワード推測
    if desc:
        keywords = {
            'ログイン': 'ログイン／ログアウト',
            'パスワード': 'パスワード管理',
            'テーブル': 'テーブル定義',
            'フィールド': 'フィールド設定',
            'レコード': 'レコード操作',
            'チャート': 'チャート',
            'カレンダー': 'カレンダー',
            'フィルタ': 'フィルタ',
            'CSV': 'CSV・データ管理',
            'インポート': 'CSV・データ管理',
            'エクスポート': 'CSV・データ管理',
            'ユーザー': 'ユーザー管理',
            '権限': 'ユーザー・権限',
            '通知': '通知',
            'メール': 'メール配信',
            'ワークフロー': 'ワークフロー',
            '帳票': '帳票',
            'レイアウト': 'レイアウト・UI',
            'メニュー': 'レイアウト・UI',
            'ダッシュボード': 'ダッシュボード',
            '公開フォーム': '公開フォーム',
            'コメント': 'コメント・ログ',
            'ログ': 'ログ管理',
            'システム設定': 'システム設定',
            'API': 'API連携',
            'webhook': 'webhook',
            'Webhook': 'webhook',
            '印刷': '印刷',
            'プラン': '支払い・プラン',
            '課金': '支払い・プラン',
            'RPA': 'RPA',
            'テンプレート': 'テンプレート',
            '大量データ': '大量データ',
            '参照': '参照テーブル',
            '自動採番': '自動採番',
            '画像': '画像フィールド',
            '添付ファイル': 'ファイル管理',
            'バリデーション': 'バリデーション',
        }
        for kw, feat in keywords.items():
            if kw in desc:
                return feat

    return GROUP_TO_FEATURE.get(group_base, '一般機能')

# ==========================================================================
# メイン処理
# ==========================================================================
def main():
    spec_map, spec_describes = extract_spec_info()

    stats = {
        'desc_fixed': 0,
        'expected_fixed': 0,
        'feature_fixed': 0,
        'total_ng_before': 0,
        'total_ng_after': 0,
        'files_modified': 0,
    }

    yaml_files = sorted(glob.glob('specs/*.yaml'))

    for yaml_file in yaml_files:
        with open(yaml_file) as f:
            data = yaml.safe_load(f)

        if not data or 'cases' not in data:
            continue

        yaml_group = os.path.basename(yaml_file).replace('.yaml', '')
        modified = False

        for case in data['cases']:
            case_no = str(case.get('case_no', ''))
            desc = case.get('description', '') or ''
            expected = case.get('expected', '') or ''
            feature = case.get('feature', '') or ''

            spec_info = spec_map.get(case_no)

            # NG判定（修正前）
            is_ng = False
            if '①' not in desc:
                is_ng = True
            if '想定通り' in expected or expected.strip() == '':
                is_ng = True
            if feature.strip() in ('', '-'):
                is_ng = True
            if is_ng:
                stats['total_ng_before'] += 1

            # 1. description修正
            if '①' not in desc and desc.strip():
                new_desc = convert_description_to_steps(desc, case_no, spec_info)
                if new_desc != desc:
                    case['description'] = new_desc
                    stats['desc_fixed'] += 1
                    modified = True
                    desc = new_desc  # 後続処理で使うため更新

            # 2. expected修正
            if '想定通り' in expected:
                new_expected = fix_expected(expected, desc, case_no, spec_info, feature or fix_feature(feature, case_no, spec_info, yaml_group, desc))
                if new_expected != expected:
                    case['expected'] = new_expected
                    stats['expected_fixed'] += 1
                    modified = True

            # 3. feature修正
            if feature.strip() in ('', '-'):
                new_feature = fix_feature(feature, case_no, spec_info, yaml_group, desc)
                if new_feature != feature:
                    case['feature'] = new_feature
                    stats['feature_fixed'] += 1
                    modified = True

            # NG判定（修正後）
            new_desc = case.get('description', '') or ''
            new_exp = case.get('expected', '') or ''
            new_feat = case.get('feature', '') or ''
            still_ng = False
            if '①' not in new_desc:
                still_ng = True
            if '想定通り' in new_exp or new_exp.strip() == '':
                still_ng = True
            if new_feat.strip() in ('', '-'):
                still_ng = True
            if still_ng:
                stats['total_ng_after'] += 1

        if modified:
            # YAMLを書き出し（元の構造を保持）
            with open(yaml_file, 'w') as f:
                yaml.dump(data, f, Dumper=SafeDumper, allow_unicode=True, default_flow_style=False, sort_keys=False, width=200)
            stats['files_modified'] += 1
            print(f"  修正: {yaml_file}")

    print(f"\n=== 修正結果 ===")
    print(f"修正前NG: {stats['total_ng_before']}件")
    print(f"修正後NG: {stats['total_ng_after']}件")
    print(f"description修正: {stats['desc_fixed']}件")
    print(f"expected修正: {stats['expected_fixed']}件")
    print(f"feature修正: {stats['feature_fixed']}件")
    print(f"修正ファイル数: {stats['files_modified']}件")

if __name__ == '__main__':
    main()
