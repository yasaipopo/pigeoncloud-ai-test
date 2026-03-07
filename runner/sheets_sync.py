"""
Google Sheets ↔ YAMLシナリオ 同期スクリプト

使い方:
  python runner/sheets_sync.py --pull          # Sheets → YAML生成
  python runner/sheets_sync.py --push          # テスト結果 → Sheetsに書き戻し
  python runner/sheets_sync.py --push-scenarios # Claude更新のYAML → Sheetsに反映
  python runner/sheets_sync.py --inspect       # シート構成を確認（デバッグ用）
"""

import os
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

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
]

SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID", "1h_gwuCGUAdj5fKPRZu438TKFkFkYUNUKz2K_vtEFlmI")
SHEET_GID = int(os.environ.get("SHEET_GID", "46306531"))
SERVICE_ACCOUNT_PATH = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "/app/secrets/service_account.json")

SCENARIOS_DIR = Path(os.environ.get("SCENARIOS_DIR", "/app/scenarios"))
REPORTS_DIR = Path(os.environ.get("REPORTS_DIR", "/app/reports"))

# ローカル実行時のパス解決
if not Path(SERVICE_ACCOUNT_PATH).exists():
    local_path = Path(__file__).parent.parent / "secrets" / "service_account.json"
    if local_path.exists():
        SERVICE_ACCOUNT_PATH = str(local_path)

if not SCENARIOS_DIR.exists():
    SCENARIOS_DIR = Path(__file__).parent.parent / "scenarios"

if not REPORTS_DIR.exists():
    REPORTS_DIR = Path(__file__).parent.parent / "reports"
    REPORTS_DIR.mkdir(exist_ok=True)


def get_client():
    creds = Credentials.from_service_account_file(SERVICE_ACCOUNT_PATH, scopes=SCOPES)
    return gspread.authorize(creds)


def get_sheet(client):
    """GIDからシートを取得"""
    spreadsheet = client.open_by_key(SPREADSHEET_ID)
    for ws in spreadsheet.worksheets():
        if ws.id == SHEET_GID:
            return ws
    # GIDで見つからなければ最初のシート
    return spreadsheet.get_worksheet(0)


def inspect_sheet():
    """シートの構成を確認する（デバッグ用）"""
    client = get_client()
    spreadsheet = client.open_by_key(SPREADSHEET_ID)

    print(f"スプレッドシート名: {spreadsheet.title}")
    print(f"シート一覧:")
    for ws in spreadsheet.worksheets():
        print(f"  - [{ws.id}] {ws.title} ({ws.row_count}行 x {ws.col_count}列)")

    print()
    sheet = get_sheet(client)
    print(f"対象シート: {sheet.title}")

    # ヘッダー行を取得
    all_values = sheet.get_all_values()
    if not all_values:
        print("シートが空です")
        return

    headers = all_values[0]
    print(f"列構成（{len(headers)}列）:")
    for i, h in enumerate(headers):
        col_letter = chr(ord('A') + i) if i < 26 else f"A{chr(ord('A') + i - 26)}"
        print(f"  {col_letter}: {h}")

    print(f"\nデータ行数: {len(all_values) - 1}行")
    if len(all_values) > 1:
        print(f"先頭データ例:")
        for h, v in zip(headers, all_values[1]):
            print(f"  {h}: {v[:80] if v else '(空)'}")


def pull_scenarios():
    """Sheets → YAMLシナリオ生成"""
    print(">> Google Sheets からシナリオを取得中...")
    client = get_client()
    sheet = get_sheet(client)
    records = sheet.get_all_records()

    if not records:
        print("シートにデータがありません")
        return

    print(f"   {len(records)}件のテストケースを取得")

    # 既存のYAMLをクリア（Sheetsが正）
    for f in SCENARIOS_DIR.glob("*.yaml"):
        f.unlink()

    generated = 0
    for i, row in enumerate(records):
        scenario = _row_to_scenario(row, i)
        if scenario is None:
            continue

        filename = f"{str(i+1).zfill(2)}_{_slugify(scenario['name'])}.yaml"
        path = SCENARIOS_DIR / filename
        with open(path, "w", encoding="utf-8") as f:
            yaml.dump(scenario, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
        print(f"   生成: {filename}")
        generated += 1

    print(f">> {generated}件のYAMLシナリオを生成しました")


def _row_to_scenario(row: dict, index: int) -> dict | None:
    """シートの1行をYAML用dictに変換（列名に合わせて調整）"""
    # 列名の候補を柔軟に対応
    name = _get_col(row, ["テスト名", "name", "Name", "テストケース名", "テストケース"])
    if not name:
        return None

    # スキップフラグ
    skip = _get_col(row, ["スキップ", "skip", "無効"])
    if skip and str(skip).strip().lower() in ["1", "true", "yes", "○", "✓"]:
        return None

    url = _get_col(row, ["URL", "url", "パス", "path"])
    steps_raw = _get_col(row, ["手順", "steps", "Steps", "操作手順"])
    assertions_raw = _get_col(row, ["期待結果", "assertions", "Assertions", "確認事項"])
    category = _get_col(row, ["カテゴリ", "category", "Category"])
    priority = _get_col(row, ["優先度", "priority", "Priority"])

    # stepsをパース（YAML文字列 or テキスト）
    steps = _parse_steps(steps_raw, url)
    assertions = _parse_assertions(assertions_raw, url)

    scenario = {"name": name}
    if category:
        scenario["category"] = category
    if priority:
        scenario["priority"] = priority
    scenario["steps"] = steps
    scenario["assertions"] = assertions
    scenario["screenshot"] = True
    scenario["_sheet_row"] = index + 2  # Sheetsの行番号（ヘッダー込み）

    return scenario


def _parse_steps(raw: str, url: str = "") -> list:
    """手順文字列をstepsリストに変換"""
    if not raw:
        steps = []
        if url:
            steps.append({"action": "navigate", "value": url})
        return steps

    # YAML形式ならそのままパース
    try:
        parsed = yaml.safe_load(raw)
        if isinstance(parsed, list):
            return parsed
    except Exception:
        pass

    # テキスト形式（行ごとに解釈）
    steps = []
    if url:
        steps.append({"action": "navigate", "value": url})

    for line in raw.strip().splitlines():
        line = line.strip().lstrip("-").strip()
        if not line:
            continue
        # 「IDにadminを入力」のような自然言語はClaude任せにするためそのままコメント
        steps.append({"action": "comment", "value": line})

    return steps


def _parse_assertions(raw: str, url: str = "") -> list:
    """期待結果文字列をassertionsリストに変換"""
    if not raw:
        return []

    try:
        parsed = yaml.safe_load(raw)
        if isinstance(parsed, list):
            return parsed
    except Exception:
        pass

    assertions = []
    for line in raw.strip().splitlines():
        line = line.strip().lstrip("-").strip()
        if not line:
            continue
        assertions.append({"type": "comment", "value": line})

    return assertions


def _get_col(row: dict, keys: list) -> str:
    """複数の列名候補から値を取得"""
    for k in keys:
        if k in row and row[k] is not None and str(row[k]).strip():
            return str(row[k]).strip()
    return ""


def _slugify(text: str) -> str:
    """ファイル名に使える文字列に変換"""
    import re
    text = re.sub(r'[^\w\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]', '_', text)
    return text[:40]


def push_results():
    """テスト結果をSheetsに書き戻す"""
    results_path = REPORTS_DIR / "results.json"
    if not results_path.exists():
        print("results.jsonが見つかりません")
        return

    with open(results_path, encoding="utf-8") as f:
        results = json.load(f)

    client = get_client()
    sheet = get_sheet(client)
    headers = sheet.row_values(1)

    # 列インデックスを特定
    result_col = _find_col(headers, ["結果", "result", "Result", "テスト結果"])
    date_col = _find_col(headers, ["最終実行日", "last_run", "実行日"])
    note_col = _find_col(headers, ["Claude備考", "備考", "note", "Note", "コメント"])

    if not result_col:
        print("「結果」列が見つかりません。シートに列を追加してください")
        return

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    updates = []

    for result in results:
        row_num = None
        # YAMLの_sheet_rowを使う
        scenario_file = result.get("file", "")
        if scenario_file:
            try:
                with open(scenario_file, encoding="utf-8") as f:
                    sc = yaml.safe_load(f)
                row_num = sc.get("_sheet_row")
            except Exception:
                pass

        if not row_num:
            continue

        status = "✅ passed" if result["status"] == "passed" else "❌ failed"
        if result_col:
            updates.append({"range": f"{_col_letter(result_col)}{row_num}", "values": [[status]]})
        if date_col:
            updates.append({"range": f"{_col_letter(date_col)}{row_num}", "values": [[now]]})
        if note_col and result.get("errors"):
            note = result["errors"][0]["message"][:200] if result["errors"] else ""
            updates.append({"range": f"{_col_letter(note_col)}{row_num}", "values": [[note]]})

    if updates:
        spreadsheet = client.open_by_key(SPREADSHEET_ID)
        spreadsheet.values_batch_update({
            "valueInputOption": "USER_ENTERED",
            "data": updates
        })
        print(f">> {len(updates)}件の結果をSheetsに書き戻しました")
    else:
        print(">> 書き戻す結果がありませんでした")


def push_scenarios():
    """Claude更新のYAML → Sheetsに反映（新規追加分のみ）"""
    client = get_client()
    sheet = get_sheet(client)
    headers = sheet.row_values(1)
    existing = sheet.get_all_records()
    existing_names = {r.get("テスト名", r.get("name", "")) for r in existing}

    name_col = _find_col(headers, ["テスト名", "name", "Name", "テストケース名"])
    steps_col = _find_col(headers, ["手順", "steps", "Steps"])
    assertions_col = _find_col(headers, ["期待結果", "assertions", "Assertions"])

    added = 0
    for yaml_file in sorted(SCENARIOS_DIR.glob("*.yaml")):
        with open(yaml_file, encoding="utf-8") as f:
            sc = yaml.safe_load(f)

        name = sc.get("name", "")
        if not name or name in existing_names:
            continue

        # 新規行を末尾に追加
        new_row = [""] * len(headers)
        if name_col:
            new_row[name_col - 1] = name
        if steps_col:
            new_row[steps_col - 1] = yaml.dump(sc.get("steps", []), allow_unicode=True)
        if assertions_col:
            new_row[assertions_col - 1] = yaml.dump(sc.get("assertions", []), allow_unicode=True)

        sheet.append_row(new_row, value_input_option="USER_ENTERED")
        print(f"   Sheetsに追加: {name}")
        added += 1

    print(f">> {added}件のシナリオをSheetsに追加しました")


def _find_col(headers: list, keys: list) -> int | None:
    """列名から1-indexedの列番号を返す"""
    for k in keys:
        if k in headers:
            return headers.index(k) + 1
    return None


def _col_letter(col_num: int) -> str:
    """1-indexed列番号をA,B,...,Z,AA,...に変換"""
    result = ""
    while col_num > 0:
        col_num, remainder = divmod(col_num - 1, 26)
        result = chr(65 + remainder) + result
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pull", action="store_true", help="Sheets → YAML生成")
    parser.add_argument("--push", action="store_true", help="テスト結果 → Sheetsに書き戻し")
    parser.add_argument("--push-scenarios", action="store_true", help="YAML → Sheetsに反映")
    parser.add_argument("--inspect", action="store_true", help="シート構成を確認")
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
