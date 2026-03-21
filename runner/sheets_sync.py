"""
Google Sheets ↔ YAMLシナリオ 同期スクリプト

シート構成:
  シートA (佐藤)テスト区分A_テスト仕様書2  GID:46306531  ヘッダー:1行目
  シートB (邊見)テスト区分B_テスト仕様書   GID:1775435119 ヘッダー:4行目

使い方:
  python runner/sheets_sync.py --pull          # Sheets → YAML生成
  python runner/sheets_sync.py --push          # テスト結果 → Sheetsに書き戻し
  python runner/sheets_sync.py --push-scenarios # Claudeが追加したYAML → Sheetsに反映
  python runner/sheets_sync.py --inspect       # シート構成確認
"""

import os
import re
import sys
import json
import yaml
import argparse
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

import gspread
from google.oauth2.service_account import Credentials

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID", "1h_gwuCGUAdj5fKPRZu438TKFkFkYUNUKz2K_vtEFlmI")

_sa_from_env = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
_sa_local = Path(__file__).parent.parent / "secrets" / "service_account.json"
# コンテナパスが存在しない場合はローカルパスにフォールバック
if _sa_from_env and Path(_sa_from_env).exists():
    SERVICE_ACCOUNT_PATH = _sa_from_env
else:
    SERVICE_ACCOUNT_PATH = str(_sa_local)

SCENARIOS_DIR = Path(os.environ.get("SCENARIOS_DIR", str(Path(__file__).parent.parent / "scenarios")))
REPORTS_DIR = Path(os.environ.get("REPORTS_DIR", str(Path(__file__).parent.parent / "reports")))
REPORTS_DIR.mkdir(exist_ok=True)

# staging (デフォルト) or production — 結果書き込み先シートタブを切り替える
ENV_TYPE = os.environ.get("ENV_TYPE", "staging")  # staging / production

# シート定義
SHEETS = [
    {
        "gid": 46306531,
        "name": "(佐藤)テスト区分A_テスト仕様書2",
        "prefix": "A",
        "header_row": 1,
        "col_no": "E",        # テストケースNo
        "col_feature": "F",   # 機能名
        "col_category": "G",  # カテゴリ
        "col_steps": "H",     # 手順
        "col_expected": "I",  # 予想結果
        "col_autify": "C",    # Autify実施可否
    },
    {
        "gid": 1775435119,
        "name": "(邊見)テスト区分B_テスト仕様書",
        "prefix": "B",
        "header_row": 4,
        "col_no": "E",
        "col_feature": "F",
        "col_category": "G",
        "col_steps": "H",
        "col_expected": "I",
        "col_autify": "B",    # Autify列（●が入ってる）
    },
]


def get_client():
    creds = Credentials.from_service_account_file(SERVICE_ACCOUNT_PATH, scopes=SCOPES)
    return gspread.authorize(creds)


def get_or_create_sheet(ss, sheet_name, template_sheet=None):
    """シートタブを取得。存在しない場合は新規作成（本番用タブ等）。"""
    try:
        return ss.worksheet(sheet_name)
    except gspread.exceptions.WorksheetNotFound:
        ws = ss.add_worksheet(title=sheet_name, rows=2000, cols=100)
        print(f">> シートタブ「{sheet_name}」を新規作成しました")
        # テンプレートシートのヘッダー行をコピー
        if template_sheet is not None:
            try:
                header_row = template_sheet.row_values(1)
                if header_row:
                    ws.append_row(header_row, value_input_option="USER_ENTERED")
            except Exception:
                pass
        return ws


def col_to_index(col: str) -> int:
    """列文字(A,B,...,Z,AA...)を0-indexedの数値に変換"""
    result = 0
    for ch in col.upper():
        result = result * 26 + (ord(ch) - ord('A') + 1)
    return result - 1


def col_letter(n: int) -> str:
    """0-indexedの列番号をA,B,...,Z,AA...に変換"""
    result = ""
    n += 1
    while n > 0:
        n, rem = divmod(n - 1, 26)
        result = chr(65 + rem) + result
    return result


def inspect_sheet():
    client = get_client()
    ss = client.open_by_key(SPREADSHEET_ID)
    print(f"スプレッドシート: {ss.title}")
    for ws in ss.worksheets():
        print(f"\n[{ws.id}] {ws.title}")
        for sheet_def in SHEETS:
            if ws.id == sheet_def["gid"]:
                hr = sheet_def["header_row"]
                headers = ws.row_values(hr)
                print(f"  ヘッダー行: {hr}行目")
                for i, h in enumerate(headers[:15]):
                    if h:
                        print(f"  {col_letter(i)}: {h}")


def pull_scenarios():
    """Sheets → YAML生成（A・B両シートから）"""
    client = get_client()
    ss = client.open_by_key(SPREADSHEET_ID)

    # 既存YAMLをクリア
    for f in SCENARIOS_DIR.glob("*.yaml"):
        f.unlink()

    total = 0
    for sheet_def in SHEETS:
        ws = ss.worksheet(sheet_def["name"])
        hr = sheet_def["header_row"]
        prefix = sheet_def["prefix"]

        all_rows = ws.get_all_values()
        headers = all_rows[hr - 1]  # 0-indexed
        data_rows = all_rows[hr:]   # ヘッダー行以降

        # 列インデックス
        idx_no       = col_to_index(sheet_def["col_no"])
        idx_feature  = col_to_index(sheet_def["col_feature"])
        idx_category = col_to_index(sheet_def["col_category"])
        idx_steps    = col_to_index(sheet_def["col_steps"])
        idx_expected = col_to_index(sheet_def["col_expected"])

        print(f"\n>> シート{prefix}: {sheet_def['name']} ({len(data_rows)}行)")

        count = 0
        for row_i, row in enumerate(data_rows):
            # 行の長さを補完
            row = row + [""] * (max(idx_no, idx_feature, idx_steps, idx_expected) + 1 - len(row))

            no       = row[idx_no].strip()
            feature  = row[idx_feature].strip()
            steps    = row[idx_steps].strip()
            expected = row[idx_expected].strip()

            # テストケースNoがない行はスキップ
            if not no or not steps:
                continue

            category = row[idx_category].strip() if idx_category < len(row) else ""
            name = f"{prefix}-{no}_{feature}" if feature else f"{prefix}-{no}"

            scenario = {
                "name": name,
                "sheet": prefix,
                "case_no": no,
                "feature": feature,
                "category": category,
                "description": steps,
                "expected": expected,
                "_sheet_row": hr + row_i + 1,  # Sheets上の実際の行番号
                "_sheet_gid": sheet_def["gid"],
                "steps": [
                    # 手順テキストからClaudeがPlaywrightステップを生成する
                    {"action": "comment", "value": line.strip()}
                    for line in steps.splitlines() if line.strip()
                ],
                "assertions": [
                    {"type": "comment", "value": line.strip()}
                    for line in expected.splitlines() if line.strip()
                ],
                "screenshot": True,
            }

            filename = f"{prefix}{no.replace('-', '_')}_{_slugify(feature)}.yaml"
            path = SCENARIOS_DIR / filename
            with open(path, "w", encoding="utf-8") as f:
                yaml.dump(scenario, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
            count += 1

        print(f"   {count}件のYAMLを生成")
        total += count

    print(f"\n>> 合計 {total}件のYAMLシナリオを生成しました")


def push_results():
    """テスト結果をSheetsの右端に新しい列として追加する。

    シートA: 右端に「チェック結果(YYYY/M)」列を追加（既存パターンに合わせる）
    シートB: 右端に「実施日」「結果」ペア列を追加（既存パターンに合わせる）
             ただしテスト実施者・備考・フラグ列より左に挿入する
    """
    results_path = REPORTS_DIR / "results.json"
    if not results_path.exists():
        print("results.jsonが見つかりません")
        return

    with open(results_path, encoding="utf-8") as f:
        results = json.load(f)

    client = get_client()
    ss = client.open_by_key(SPREADSHEET_ID)

    now_label = datetime.now().strftime("%Y/%m")
    now_date  = datetime.now().strftime("%Y/%m/%d")
    env_label = "" if ENV_TYPE == "staging" else "[本番]"

    # GIDごとに結果を集める
    sheets_cache = {}
    updates_by_gid = {}

    for result in results:
        yaml_file = result.get("file", "")
        if not yaml_file or not Path(yaml_file).exists():
            continue
        with open(yaml_file, encoding="utf-8") as f:
            sc = yaml.safe_load(f)

        gid     = sc.get("_sheet_gid")
        row_num = sc.get("_sheet_row")
        if not gid or not row_num:
            continue

        if gid not in sheets_cache:
            for sd in SHEETS:
                if sd["gid"] == gid:
                    base_name = sd["name"]
                    if ENV_TYPE == "production":
                        # 本番結果は「<シート名>_本番」タブに書き込む（なければ作成）
                        staging_ws = ss.worksheet(base_name)
                        target_name = base_name + "_本番"
                        target_ws = get_or_create_sheet(ss, target_name, template_sheet=staging_ws)
                    else:
                        target_ws = ss.worksheet(base_name)
                    sheets_cache[gid] = {"ws": target_ws, "def": sd}
                    updates_by_gid[gid] = []
                    break

        status = "OK" if result["status"] == "passed" else "NG"
        note   = result["errors"][0]["message"][:100] if result.get("errors") else ""
        updates_by_gid[gid].append((row_num, status, note))

    for gid, update_list in updates_by_gid.items():
        if not update_list:
            continue

        ws       = sheets_cache[gid]["ws"]
        sheet_def = sheets_cache[gid]["def"]
        hr        = sheet_def["header_row"]
        headers   = ws.row_values(hr)

        if gid == 46306531:
            # ===== シートA =====
            # 既存パターン: 右端に「チェック結果(YYYY/M)」を追加
            header_label = f"チェック結果{env_label}({now_label})"
            if header_label in headers:
                result_col = headers.index(header_label) + 1  # 1-indexed
            else:
                result_col = len(headers) + 1
                ws.update_cell(hr, result_col, header_label)

            cell_updates = [
                {"range": f"{col_letter(result_col - 1)}{row_num}", "values": [[status]]}
                for row_num, status, _ in update_list
            ]
            ss.values_batch_update({"valueInputOption": "USER_ENTERED", "data": cell_updates})
            print(f">> シートA: {len(cell_updates)}件 → 列「{header_label}」に書き込み")

        elif gid == 1775435119:
            # ===== シートB =====
            # 既存パターン: 「テスト実施者」列の手前に「実施日」「結果」ペアを挿入
            # テスト実施者列を特定（保護列）
            preserve_cols = ["テスト実施者", "備考", "再テスト\nフラグ", "修正", "再テスト完了フラグ"]
            insert_before = None
            for i, h in enumerate(headers):
                if h in preserve_cols:
                    insert_before = i  # 0-indexed
                    break

            date_label   = "実施日"
            result_label = "結果"
            date_header  = f"実施日{env_label}({now_label})"
            result_header = f"結果{env_label}({now_label})"

            if result_header in headers:
                date_col   = headers.index(date_header) + 1 if date_header in headers else None
                result_col = headers.index(result_header) + 1
            else:
                if insert_before is not None:
                    # テスト実施者列の手前に2列挿入（実際のシートIDを使用）
                    actual_sheet_id = ws.id
                    ws.spreadsheet.batch_update({"requests": [{
                        "insertDimension": {
                            "range": {
                                "sheetId": actual_sheet_id,
                                "dimension": "COLUMNS",
                                "startIndex": insert_before,
                                "endIndex": insert_before + 2
                            },
                            "inheritFromBefore": True
                        }
                    }]})
                    date_col   = insert_before + 1      # 1-indexed
                    result_col = insert_before + 2
                else:
                    # 末尾に追加
                    date_col   = len(headers) + 1
                    result_col = len(headers) + 2

                ws.update_cell(hr, date_col,   date_label)
                ws.update_cell(hr, result_col, result_label)

            cell_updates = []
            for row_num, status, _ in update_list:
                cell_updates.append({"range": f"{col_letter(date_col - 1)}{row_num}",   "values": [[now_date]]})
                cell_updates.append({"range": f"{col_letter(result_col - 1)}{row_num}", "values": [[status]]})

            ss.values_batch_update({"valueInputOption": "USER_ENTERED", "data": cell_updates})
            print(f">> シートB: {len(update_list)}件 → 列「{date_label}」「{result_label}」に書き込み")


def push_scenarios():
    """Claudeが追加・更新したYAML → Sheetsのマスターに反映（新規のみ）"""
    client = get_client()
    ss = client.open_by_key(SPREADSHEET_ID)

    for sheet_def in SHEETS:
        ws = ss.worksheet(sheet_def["name"])
        hr = sheet_def["header_row"]
        all_rows = ws.get_all_values()
        data_rows = all_rows[hr:]
        idx_no = col_to_index(sheet_def["col_no"])
        existing_nos = {
            row[idx_no].strip()
            for row in data_rows
            if len(row) > idx_no and row[idx_no].strip()
        }

        added = 0
        prefix = sheet_def["prefix"]
        for yaml_file in sorted(SCENARIOS_DIR.glob(f"{prefix}*.yaml")):
            with open(yaml_file, encoding="utf-8") as f:
                sc = yaml.safe_load(f)

            no = sc.get("case_no", "")
            if not no or no in existing_nos:
                continue

            # 末尾に行追加
            new_row = [""] * (col_to_index(sheet_def["col_expected"]) + 1)
            new_row[col_to_index(sheet_def["col_no"])]       = no
            new_row[col_to_index(sheet_def["col_feature"])]  = sc.get("feature", "")
            new_row[col_to_index(sheet_def["col_category"])] = sc.get("category", "")
            new_row[col_to_index(sheet_def["col_steps"])]    = sc.get("description", "")
            new_row[col_to_index(sheet_def["col_expected"])] = sc.get("expected", "")
            ws.append_row(new_row, value_input_option="USER_ENTERED")
            print(f"   Sheets{prefix}に追加: {no} {sc.get('feature','')}")
            added += 1

        if added:
            print(f">> シート{prefix}: {added}件追加")


def _slugify(text: str) -> str:
    text = re.sub(r'[^\w\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]', '_', text)
    return text[:30]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pull",            action="store_true", help="Sheets → YAML生成")
    parser.add_argument("--push",            action="store_true", help="テスト結果 → Sheetsに書き戻し")
    parser.add_argument("--push-scenarios",  action="store_true", help="YAML → Sheetsに反映")
    parser.add_argument("--inspect",         action="store_true", help="シート構成を確認")
    args = parser.parse_args()

    if args.inspect:
        inspect_sheet()
    elif args.pull:
        pull_scenarios()
    elif args.push:
        push_results()
    elif args.push_scenarios:
        push_scenarios()
    else:
        parser.print_help()
