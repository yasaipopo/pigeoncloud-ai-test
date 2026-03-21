"""
Google Sheets QA管理シート 管理番号付与・同期スクリプト

管理番号フォーマット: PC-{SPEC_CODE}-{sheet}-{case_no}
例: PC-AUTH-A-1-1, PC-FLD-B-113-04

使い方:
  python runner/sheets_manager.py --create       # QA管理タブを新規作成して全ケースを書き込む
  python runner/sheets_manager.py --push-results # テスト結果を管理番号で引き当てて書き込む
  python runner/sheets_manager.py --list         # 管理番号一覧を表示（Sheets不使用）
"""

import os
import re
import sys
import yaml
import argparse
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

import gspread
from google.oauth2.service_account import Credentials

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID", "1h_gwuCGUAdj5fKPRZu438TKFkFkYUNUKz2K_vtEFlmI")

_sa_from_env = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
_sa_local = Path(__file__).parent.parent / "secrets" / "service_account.json"
if _sa_from_env and Path(_sa_from_env).exists():
    SERVICE_ACCOUNT_PATH = _sa_from_env
else:
    SERVICE_ACCOUNT_PATH = str(_sa_local)

SPECS_DIR = Path(__file__).parent.parent / "specs"

# spec_file名（拡張子なし）→ SPEC_CODE マッピング
SPEC_CODE_MAP = {
    "auth":              "AUTH",
    "chart-calendar":    "CHART",
    "comments-logs":     "CMNT",
    "csv-export":        "CSV",
    "fields":            "FLD",
    "filters":           "FLTR",
    "layout-ui":         "LAYUI",
    "notifications":     "NTFY",
    "public-form":       "PUBF",
    "records":           "REC",
    "reports":           "RPT",
    "system-settings":   "SYS",
    "table-definition":  "TBL",
    "uncategorized":     "MISC",
    "users-permissions": "USR",
    "workflow":          "WF",
}

# QA管理シートの列定義
COL_ID       = 0   # A: 管理番号
COL_SPEC     = 1   # B: specファイル名
COL_SHEET    = 2   # C: sheet (A/B)
COL_CASE_NO  = 3   # D: case_no
COL_FEATURE  = 4   # E: feature
COL_CATEGORY = 5   # F: category
COL_DESC     = 6   # G: description（手順）
COL_EXPECTED = 7   # H: expected（期待結果）
COL_RESULT   = 8   # I: テスト結果
COL_NOTE     = 9   # J: 備考

HEADERS = [
    "管理番号",
    "spec",
    "sheet",
    "case_no",
    "feature",
    "category",
    "description（手順）",
    "expected（期待結果）",
    "テスト結果",
    "備考",
]

QA_SHEET_NAME = "QA管理"


def make_management_id(spec_code: str, sheet: str, case_no: str) -> str:
    """管理番号を生成する。例: PC-AUTH-A-1-1"""
    return f"PC-{spec_code}-{sheet}-{case_no}"


def load_all_cases() -> list[dict]:
    """全specのYAMLを読み込み、ケース一覧を返す。"""
    all_cases = []

    # 読み込み順序を固定（アルファベット順）
    yaml_files = sorted(SPECS_DIR.glob("*.yaml"))

    for yaml_path in yaml_files:
        spec_name = yaml_path.stem  # 例: "auth", "fields"
        spec_code = SPEC_CODE_MAP.get(spec_name)
        if not spec_code:
            print(f"  警告: {spec_name} はSPEC_CODE_MAPに未登録、スキップ", file=sys.stderr)
            continue

        with open(yaml_path, encoding="utf-8") as f:
            data = yaml.safe_load(f)

        cases = data.get("cases", [])
        for case in cases:
            case_no = str(case.get("case_no", "")).strip()
            sheet   = str(case.get("sheet", "")).strip()
            if not case_no or not sheet:
                continue

            mgmt_id = make_management_id(spec_code, sheet, case_no)
            all_cases.append({
                "id":          mgmt_id,
                "spec":        spec_name,
                "sheet":       sheet,
                "case_no":     case_no,
                "feature":     str(case.get("feature", "") or ""),
                "category":    str(case.get("category", "") or ""),
                "description": str(case.get("description", "") or ""),
                "expected":    str(case.get("expected", "") or ""),
                "result":      "",
                "note":        "",
            })

    return all_cases


def get_client():
    creds = Credentials.from_service_account_file(SERVICE_ACCOUNT_PATH, scopes=SCOPES)
    return gspread.authorize(creds)


def list_cases():
    """管理番号一覧をターミナルに表示（Sheets不使用）"""
    cases = load_all_cases()
    # spec別集計
    counts = {}
    for c in cases:
        counts[c["spec"]] = counts.get(c["spec"], 0) + 1

    print(f"{'管理番号':<30} {'feature':<20}")
    print("-" * 60)
    for c in cases[:20]:
        print(f"{c['id']:<30} {c['feature'][:20]:<20}")
    print(f"  ... 省略 ...")
    print()
    print("spec別件数:")
    for spec_name in sorted(counts):
        code = SPEC_CODE_MAP.get(spec_name, "?")
        print(f"  {spec_name:<25} ({code:<6}) : {counts[spec_name]}件")
    print(f"\n合計: {len(cases)}件")


def create_qa_sheet():
    """QA管理タブを新規作成して全ケースを書き込む。
    既存の同名タブがある場合は削除して再作成する。
    """
    cases = load_all_cases()
    print(f"全{len(cases)}件のテストケースを読み込みました")

    client = get_client()
    ss = client.open_by_key(SPREADSHEET_ID)

    # 既存の同名タブを削除
    existing = [ws for ws in ss.worksheets() if ws.title == QA_SHEET_NAME]
    if existing:
        print(f"既存の「{QA_SHEET_NAME}」タブを削除します")
        ss.del_worksheet(existing[0])

    # 新規タブ作成（列数10、行数=ヘッダー1行+データ行）
    total_rows = len(cases) + 1
    ws = ss.add_worksheet(title=QA_SHEET_NAME, rows=total_rows + 100, cols=10)
    print(f"「{QA_SHEET_NAME}」タブを作成しました")

    # ヘッダー行を書き込む
    ws.update(values=[HEADERS], range_name="A1")

    # ヘッダー行をフリーズ・太字に
    ws.freeze(rows=1)
    requests = [
        {
            "repeatCell": {
                "range": {
                    "sheetId": ws.id,
                    "startRowIndex": 0,
                    "endRowIndex": 1,
                },
                "cell": {
                    "userEnteredFormat": {
                        "textFormat": {"bold": True},
                        "backgroundColor": {
                            "red": 0.2,
                            "green": 0.4,
                            "blue": 0.8,
                        },
                    }
                },
                "fields": "userEnteredFormat(textFormat,backgroundColor)",
            }
        }
    ]
    ss.batch_update({"requests": requests})

    # データを一括書き込み（100件ずつバッチ処理）
    batch_size = 100
    total_written = 0
    for i in range(0, len(cases), batch_size):
        batch = cases[i:i + batch_size]
        rows = []
        for c in batch:
            rows.append([
                c["id"],
                c["spec"],
                c["sheet"],
                c["case_no"],
                c["feature"],
                c["category"],
                c["description"],
                c["expected"],
                c["result"],
                c["note"],
            ])
        start_row = i + 2  # 1-indexed、ヘッダーが1行目なのでデータは2行目から
        range_notation = f"A{start_row}"
        ws.update(values=rows, range_name=range_notation)
        total_written += len(batch)
        print(f"  {total_written}/{len(cases)}件書き込み完了...")

    print(f"\n完了: {len(cases)}件を「{QA_SHEET_NAME}」タブに書き込みました")
    print(f"URL: https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}")


# ステータス別の背景色（RGB 0.0〜1.0）
STATUS_COLORS = {
    "passed":  {"red": 0.71, "green": 0.88, "blue": 0.80},  # 薄緑 #b7e1cd
    "failed":  {"red": 0.96, "green": 0.78, "blue": 0.76},  # 薄赤 #f4c7c3
    "skip":    {"red": 0.99, "green": 0.91, "blue": 0.70},  # 薄黄 #fce8b2
    "skipped": {"red": 0.99, "green": 0.91, "blue": 0.70},
    "todo":    {"red": 0.91, "green": 0.91, "blue": 0.91},  # 薄灰 #e8eaed
    "":        {"red": 1.0,  "green": 1.0,  "blue": 1.0},   # 白
}


def normalize_status(status: str) -> str:
    s = status.lower().strip()
    if "passed" in s:
        return "passed"
    if "fail" in s:
        return "failed"
    if "todo" in s:
        return "todo"
    if "skip" in s:
        return "skip"
    return s


def push_results_by_id(results_yaml_path: str = None):
    """テスト結果を管理番号で引き当ててSheetsに書き込む。
    results.json（build_results_v2.py の出力）を優先して使用。
    ステータスに応じてセルに色付けも行う。
    """
    import json

    RESULTS_JSON = Path(__file__).parent.parent / "reports" / "results.json"
    result_map = {}  # mgmt_id → normalized status

    if RESULTS_JSON.exists():
        # results.json を使う（メイン）
        # 先に YAML から case_no → sheet のマッピングを作る
        case_sheet_map = {}  # (spec_name, case_no) → sheet
        yaml_files = sorted(SPECS_DIR.glob("*.yaml"))
        for yaml_path in yaml_files:
            spec_name = yaml_path.stem
            with open(yaml_path, encoding="utf-8") as f:
                data = yaml.safe_load(f)
            for case in data.get("cases", []):
                case_no = str(case.get("case_no", "")).strip()
                sheet   = str(case.get("sheet", "")).strip()
                if case_no and sheet:
                    case_sheet_map[(spec_name, case_no)] = sheet

        with open(RESULTS_JSON, encoding="utf-8") as f:
            results = json.load(f)

        for item in results:
            scenario = item.get("scenario", "")
            if "/" not in scenario:
                continue
            spec_name, case_no = scenario.split("/", 1)
            spec_code = SPEC_CODE_MAP.get(spec_name)
            if not spec_code:
                continue
            sheet = case_sheet_map.get((spec_name, case_no), "A")
            mgmt_id = make_management_id(spec_code, sheet, case_no)
            result_map[mgmt_id] = normalize_status(str(item.get("status", "")))
        print(f"results.json から {len(result_map)} 件読み込み")

    else:
        # フォールバック: specs/*.yaml の actual_steps を使う
        yaml_files = sorted(SPECS_DIR.glob("*.yaml"))
        for yaml_path in yaml_files:
            spec_name = yaml_path.stem
            spec_code = SPEC_CODE_MAP.get(spec_name)
            if not spec_code:
                continue
            with open(yaml_path, encoding="utf-8") as f:
                data = yaml.safe_load(f)
            actual_steps = data.get("actual_steps", [])
            for step in actual_steps:
                case_no = str(step.get("case_no", "")).strip()
                status  = normalize_status(str(step.get("status", "")))
                for case in data.get("cases", []):
                    if str(case.get("case_no", "")).strip() == case_no:
                        sheet = str(case.get("sheet", "")).strip()
                        mgmt_id = make_management_id(spec_code, sheet, case_no)
                        result_map[mgmt_id] = status
        print(f"specs YAML から {len(result_map)} 件読み込み")

    if not result_map:
        print("actual_stepsが見つかりません")
        return

    print(f"{len(result_map)}件の結果を取得")

    client = get_client()
    ss = client.open_by_key(SPREADSHEET_ID)

    try:
        ws = ss.worksheet(QA_SHEET_NAME)
    except gspread.WorksheetNotFound:
        print(f"「{QA_SHEET_NAME}」タブが見つかりません。先に --create を実行してください")
        return

    all_values = ws.get_all_values()
    id_to_row = {}
    for row_i, row in enumerate(all_values[1:], start=2):
        if row and row[0]:
            id_to_row[row[0]] = row_i

    # 値の更新リストと色フォーマットリストを同時に作成
    value_updates = []
    format_requests = []
    not_found = []
    sheet_prefix = f"'{QA_SHEET_NAME}'!"

    for mgmt_id, status in result_map.items():
        row_num = id_to_row.get(mgmt_id)
        if not row_num:
            not_found.append(mgmt_id)
            continue

        display = status if status else ""
        value_updates.append({
            "range": f"{sheet_prefix}I{row_num}",
            "values": [[display]],
        })

        color = STATUS_COLORS.get(status, STATUS_COLORS[""])
        format_requests.append({
            "repeatCell": {
                "range": {
                    "sheetId": ws.id,
                    "startRowIndex": row_num - 1,
                    "endRowIndex": row_num,
                    "startColumnIndex": 8,  # I列（0-indexed）
                    "endColumnIndex": 9,
                },
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": color,
                    }
                },
                "fields": "userEnteredFormat(backgroundColor)",
            }
        })

    # 値を一括書き込み
    if value_updates:
        ss.values_batch_update({
            "valueInputOption": "USER_ENTERED",
            "data": value_updates,
        })
        print(f"{len(value_updates)}件の結果をSheetsに書き込みました")

    # 色を一括適用（50件ずつバッチ）
    if format_requests:
        batch_size = 50
        for i in range(0, len(format_requests), batch_size):
            ss.batch_update({"requests": format_requests[i:i + batch_size]})
        print(f"{len(format_requests)}件のセルに色を適用しました")
        counts = {}
        for mid, st in result_map.items():
            counts[st] = counts.get(st, 0) + 1
        for st, cnt in sorted(counts.items()):
            print(f"  {st}: {cnt}件")

    if not_found:
        print(f"\n{len(not_found)}件はシートに見つかりませんでした（管理番号の差異）:")
        for mid in not_found[:10]:
            print(f"  {mid}")
        if len(not_found) > 10:
            print(f"  ... 他{len(not_found) - 10}件")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Google Sheets QA管理シート 管理番号付与・同期スクリプト")
    parser.add_argument("--create",       action="store_true", help="QA管理タブを新規作成して全ケースを書き込む")
    parser.add_argument("--push-results", action="store_true", help="テスト結果をSheetsに書き込む")
    parser.add_argument("--list",         action="store_true", help="管理番号一覧を表示（Sheets不使用）")
    args = parser.parse_args()

    if args.create:
        create_qa_sheet()
    elif args.push_results:
        push_results_by_id()
    elif args.list:
        list_cases()
    else:
        parser.print_help()
