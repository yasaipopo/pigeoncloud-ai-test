"""
重複行のある specタブを削除して再作成し、テスト結果を書き直す。

問題: specタブに同じ case_no が複数行ある場合、case_to_row dict が
      最後の行をマッピングするため、最初の行（見えている行）にデータが書かれない。

解決: 重複のある specタブを削除 → _init_spec_tab() で再作成 → push_run() で書き直し
"""

import sys
import time
from pathlib import Path

# パスを通す
sys.path.insert(0, str(Path(__file__).parent))

import gspread
import e2e_report_sheet as sheet_mod

# 修正対象 spec（重複が確認されているもの）
AFFECTED_SPECS = [
    "auth",            # 14行 / ユニーク10行 (重複4)
    "chart-calendar",  # 75行 / ユニーク54行 (重複21)
    "comments-logs",   # 13行 / ユニーク8行 (重複5)
    "fields",          # 365行 / ユニーク217行 (重複148)
    "layout-ui",       # 33行 / ユニーク21行 (重複12)
    "records",         # 12行 / ユニーク10行 (重複2)
    "system-settings", # 55行 / ユニーク31行 (重複24)
    "table-definition",# 194行 / ユニーク134行 (重複60)
    "uncategorized",   # 580行 / ユニーク579行 (重複1)
    "users-permissions",# 106行 / ユニーク69行 (重複37)
    # 重複なし: csv-export, filters, notifications, public-form, reports, workflow
]


def check_duplicates(ws) -> tuple[int, int]:
    """(total_rows, unique_rows) を返す"""
    values = sheet_mod._api_call_with_retry(lambda: ws.get_all_values())
    data_rows = [row[0] for row in values[1:] if row and row[0]]
    total = len(data_rows)
    unique = len(set(data_rows))
    return total, unique


def fix_spec_tab(ss: gspread.Spreadsheet, spec_name: str) -> bool:
    """指定 spec のタブを削除して再作成する。成功したら True"""
    tab_name = sheet_mod.SPEC_TAB_NAMES[spec_name]
    cases = sheet_mod.load_spec_cases(spec_name)
    if not cases:
        print(f"  ⚠ {spec_name}: YAML なし → スキップ")
        return False

    # 重複チェック
    try:
        ws = ss.worksheet(tab_name)
        total, unique = check_duplicates(ws)
        print(f"  {spec_name}: {total}行 / ユニーク{unique}行 (重複{total-unique})")
        if total == unique:
            print(f"    → 重複なし、スキップ")
            return False
    except gspread.WorksheetNotFound:
        print(f"  {spec_name}: タブなし → 新規作成")

    # タブ削除
    try:
        ws = ss.worksheet(tab_name)
        ss.del_worksheet(ws)
        print(f"    → タブ削除")
        time.sleep(2)
    except gspread.WorksheetNotFound:
        pass

    # タブ再作成
    sheet_mod._init_spec_tab(ss, tab_name, cases)
    print(f"    → タブ再作成完了 ({len(cases)}件)")
    time.sleep(2)
    return True


def main():
    from datetime import datetime

    now = datetime.now()
    print("=== specタブ重複行修正スクリプト ===\n")

    ss = sheet_mod.get_or_create_monthly_sheet(now.year, now.month)
    client = sheet_mod.get_gspread_client()
    ss = client.open_by_key(ss.id)

    print("Step 1: 重複のある specタブを削除して再作成")
    fixed = []
    for spec_name in AFFECTED_SPECS:
        if fix_spec_tab(ss, spec_name):
            fixed.append(spec_name)

    if not fixed:
        print("\n修正対象なし。終了します。")
        return

    print(f"\n修正したspec: {', '.join(fixed)}")

    # 既存の実行列・テストレポートも削除（重複修正後の clean state にするため）
    print("\nStep 2: 既存の実行列・テストレポートタブを削除")

    # specタブの E列以降を削除
    for spec_name in sheet_mod.SPEC_ORDER:
        tab_name = sheet_mod.SPEC_TAB_NAMES[spec_name]
        try:
            ws = ss.worksheet(tab_name)
            all_values = sheet_mod._api_call_with_retry(lambda: ws.get_all_values())
            header_row = all_values[0] if all_values else []
            run_col_count = len(header_row) - 4
            if run_col_count > 0:
                sheet_mod._api_call_with_retry(lambda ws=ws, cnt=run_col_count: ss.batch_update({"requests": [{
                    "deleteDimension": {
                        "range": {
                            "sheetId": ws.id,
                            "dimension": "COLUMNS",
                            "startIndex": 4,
                            "endIndex": 4 + cnt,
                        }
                    }
                }]}))
                print(f"  {tab_name}: 実行列{run_col_count}列削除")
                time.sleep(1)
        except gspread.WorksheetNotFound:
            pass

    # summaryタブ削除
    try:
        ws = ss.worksheet("summary")
        ss.del_worksheet(ws)
        print("  summaryタブ: 削除")
        time.sleep(1)
    except gspread.WorksheetNotFound:
        pass

    # n回目テストレポートタブ削除
    import re
    worksheets = ss.worksheets()
    for ws in worksheets:
        if re.match(r'^\d+回目テストレポート$', ws.title):
            ss.del_worksheet(ws)
            print(f"  {ws.title}: 削除")
            time.sleep(1)

    print("\nStep 3: 1回目として書き直し")
    sheet_mod.push_run()

    print("\n✅ 完了")


if __name__ == "__main__":
    main()
