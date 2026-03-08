"""
個別YAMLシナリオをグループ単位のYAMLにまとめるスクリプト。

Docker Claude エージェントがこのグループYAMLを読んで
Playwrightで実際にテストし、spec.jsを生成する。

使い方:
  python runner/group_scenarios.py
  → specs/*.yaml を生成する
"""
import os
import re
import yaml
from pathlib import Path

SCENARIOS_DIR = Path(os.environ.get("SCENARIOS_DIR", "scenarios"))
SPECS_DIR = Path(os.environ.get("SPECS_DIR", "specs"))
SPECS_DIR.mkdir(exist_ok=True)

# ============================================================
# グルーピング定義
# feature名（部分一致）→ spec名
# ============================================================
GROUPS = [
    {
        "spec": "auth",
        "name": "認証（ログイン・ログアウト・パスワード変更）",
        "match_features": ["ログイン", "ログアウト", "パスワード変更", "推奨ブラウザ", "同時ログイン"],
        "match_cases": [],  # case_noで直接指定する場合
    },
    {
        "spec": "table-definition",
        "name": "テーブル定義・テーブル管理・テーブル設定",
        "match_features": ["テーブル定義", "テーブル管理", "テーブル設定", "テーブル選択", "テーブル権限設定", "テーブル"],
        "match_cases": [],
    },
    {
        "spec": "fields",
        "name": "フィールド追加・各フィールドタイプ",
        "match_features": [
            "フィールドの追加", "フィールド",
            "文字列", "文章", "数値", "Yes_No", "Yes/No",
            "選択肢", "日時", "画像", "ファイル", "他テーブル参照",
            "計算", "計算式", "固定テキスト", "自動採番",
            "列", "項目",
        ],
        "match_cases": [],
    },
    {
        "spec": "records",
        "name": "レコード操作（一覧・作成・編集・削除・一括編集）",
        "match_features": ["レコード", "一括編集", "関連レコード"],
        "match_cases": [],
    },
    {
        "spec": "layout-ui",
        "name": "レイアウト・メニュー・UI・ダッシュボード",
        "match_features": ["レイアウト", "メニュー", "ダッシュボード", "ショートカット", "UI", "アイコン", "カスタムCSS"],
        "match_cases": [],
    },
    {
        "spec": "chart-calendar",
        "name": "チャート・カレンダー・集計",
        "match_features": ["チャート", "カレンダー", "集計"],
        "match_cases": [],
    },
    {
        "spec": "filters",
        "name": "フィルタ",
        "match_features": ["フィルタ"],
        "match_cases": [],
    },
    {
        "spec": "csv-export",
        "name": "CSV・Excel・JSON・ZIPダウンロード・アップロード",
        "match_features": ["CSV", "Excel", "JSON", "ZIP", "Zip", "エクスポート", "インポート"],
        "match_cases": [],
    },
    {
        "spec": "users-permissions",
        "name": "ユーザー管理・権限設定・組織・役職・グループ",
        "match_features": ["ユーザー", "権限", "組織", "役職", "グループ", "アクセス"],
        "match_cases": [],
    },
    {
        "spec": "notifications",
        "name": "通知設定・メール配信",
        "match_features": ["通知", "メール", "配信", "SMTP"],
        "match_cases": [],
    },
    {
        "spec": "workflow",
        "name": "ワークフロー",
        "match_features": ["ワークフロー"],
        "match_cases": [],
    },
    {
        "spec": "reports",
        "name": "帳票",
        "match_features": ["帳票"],
        "match_cases": [],
    },
    {
        "spec": "system-settings",
        "name": "共通設定・システム設定・契約設定",
        "match_features": ["共通設定", "システム", "契約", "その他設定", "SMTP設定"],
        "match_cases": [],
    },
    {
        "spec": "public-form",
        "name": "公開フォーム・公開メールリンク",
        "match_features": ["公開フォーム", "公開メール"],
        "match_cases": [],
    },
    {
        "spec": "comments-logs",
        "name": "コメント・ログ管理",
        "match_features": ["コメント", "ログ"],
        "match_cases": [],
    },
]


def feature_matches(feature: str, patterns: list) -> bool:
    for p in patterns:
        if p.lower() in feature.lower():
            return True
    return False


def load_all_scenarios():
    scenarios = []
    for f in sorted(SCENARIOS_DIR.glob("*.yaml")):
        with open(f, encoding="utf-8") as fp:
            sc = yaml.safe_load(fp)
        sc["_filename"] = f.name
        scenarios.append(sc)
    return scenarios


def main():
    scenarios = load_all_scenarios()
    print(f"シナリオ読み込み: {len(scenarios)}件")

    # グループへの振り分け
    assigned = set()
    group_cases = {g["spec"]: [] for g in GROUPS}

    for g in GROUPS:
        for sc in scenarios:
            if sc["_filename"] in assigned:
                continue
            feature = sc.get("feature", "") or ""
            if feature_matches(feature, g["match_features"]):
                group_cases[g["spec"]].append(sc)
                assigned.add(sc["_filename"])

    # 未分類
    unassigned = [sc for sc in scenarios if sc["_filename"] not in assigned]

    # グループYAMLを出力
    for g in GROUPS:
        cases = group_cases[g["spec"]]
        if not cases:
            continue

        output = {
            "group": g["name"],
            "spec_file": f"tests/{g['spec']}.spec.js",
            "base_url": "{{ TEST_BASE_URL }}",
            "cases": [
                {
                    "case_no": sc.get("case_no", ""),
                    "sheet": sc.get("sheet", ""),
                    "feature": sc.get("feature", ""),
                    "category": sc.get("category", ""),
                    "description": sc.get("description", ""),
                    "expected": sc.get("expected", ""),
                }
                for sc in cases
            ]
        }

        out_path = SPECS_DIR / f"{g['spec']}.yaml"
        with open(out_path, "w", encoding="utf-8") as f:
            yaml.dump(output, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
        print(f"  [{g['spec']}.yaml] {len(cases)}件")

    # 未分類をまとめる
    if unassigned:
        output = {
            "group": "未分類（機能名なし）",
            "spec_file": "tests/uncategorized.spec.js",
            "base_url": "{{ TEST_BASE_URL }}",
            "cases": [
                {
                    "case_no": sc.get("case_no", ""),
                    "sheet": sc.get("sheet", ""),
                    "feature": sc.get("feature", ""),
                    "description": sc.get("description", ""),
                    "expected": sc.get("expected", ""),
                }
                for sc in unassigned
            ]
        }
        out_path = SPECS_DIR / "uncategorized.yaml"
        with open(out_path, "w", encoding="utf-8") as f:
            yaml.dump(output, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
        print(f"  [uncategorized.yaml] {len(unassigned)}件（機能名なし）")

    print(f"\n完了: {SPECS_DIR}/ に出力しました")


if __name__ == "__main__":
    main()
