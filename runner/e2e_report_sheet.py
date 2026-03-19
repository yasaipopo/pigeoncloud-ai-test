"""
E2Eテスト結果 月次スプレッドシート管理スクリプト

月ごとに1スプレッドシートを作成し、
・specごとにタブを分けてテスト結果を記録
・summaryタブにpass/fail集計とfailed一覧（セルリンク付き）を記録

使い方:
  python runner/e2e_report_sheet.py --auth              # 初回のみ: ブラウザでGoogleログイン
  python runner/e2e_report_sheet.py --push-run          # 最新結果を月次シートに追記
  python runner/e2e_report_sheet.py --push-run --dry-run # 内容確認のみ（書き込みなし）
  python runner/e2e_report_sheet.py --show-url          # 今月のシートURLを表示

認証の優先順位:
  1. secrets/user_token.json（OAuth2ユーザー認証・シート作成可能）
  2. secrets/service_account.json（サービスアカウント・既存シートへの書き込みのみ）
"""

import json
import os
import sys
import re
import time
from datetime import datetime
from pathlib import Path

import yaml
import gspread
from googleapiclient.discovery import build
from dotenv import load_dotenv

load_dotenv()

# ============================================================
# 設定
# ============================================================
DRIVE_FOLDER_ID = "11hgtlCaOarDnvKeLhJWjzI7DNPF4M2RK"

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

SECRETS_DIR = Path(__file__).parent.parent / "secrets"
USER_TOKEN_PATH   = SECRETS_DIR / "user_token.json"
OAUTH_CLIENT_PATH = SECRETS_DIR / "oauth_client.json"
SA_PATH           = SECRETS_DIR / "service_account.json"
_sa_env = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
if _sa_env and Path(_sa_env).exists():
    SA_PATH = Path(_sa_env)

SPECS_DIR   = Path(__file__).parent.parent / "specs"
REPORTS_DIR = Path(__file__).parent.parent / "reports"

# spec名 → タブ表示名
SPEC_TAB_NAMES = {
    "auth":              "auth（認証）",
    "chart-calendar":    "chart-calendar（チャート）",
    "comments-logs":     "comments-logs（コメント）",
    "csv-export":        "csv-export（CSV）",
    "fields":            "fields（フィールド）",
    "filters":           "filters（フィルタ）",
    "layout-ui":         "layout-ui（レイアウト）",
    "notifications":     "notifications（通知）",
    "public-form":       "public-form（公開フォーム）",
    "records":           "records（レコード）",
    "reports":           "reports（帳票）",
    "system-settings":   "system-settings（設定）",
    "table-definition":  "table-definition（テーブル）",
    "uncategorized":     "uncategorized（その他）",
    "users-permissions": "users-permissions（ユーザー）",
    "workflow":          "workflow（ワークフロー）",
}

# 表示順序
SPEC_ORDER = list(SPEC_TAB_NAMES.keys())

# ステータス別背景色
STATUS_COLORS = {
    "passed":  {"red": 0.71, "green": 0.88, "blue": 0.80},  # 薄緑
    "failed":  {"red": 0.96, "green": 0.78, "blue": 0.76},  # 薄赤
    "skipped": {"red": 0.99, "green": 0.91, "blue": 0.70},  # 薄黄
    "skip":    {"red": 0.99, "green": 0.91, "blue": 0.70},
    "todo":    {"red": 0.91, "green": 0.91, "blue": 0.91},  # 薄灰
    "":        {"red": 1.0,  "green": 1.0,  "blue": 1.0},   # 白
}

# ヘッダー背景色
HEADER_COLOR = {"red": 0.20, "green": 0.40, "blue": 0.80}
SUMMARY_HEADER_COLOR = {"red": 0.25, "green": 0.25, "blue": 0.55}


# ============================================================
# 認証・クライアント
# 優先順位:
#   1. secrets/user_token.json（OAuth2ユーザー認証）
#   2. gcloud ADC（Application Default Credentials）← ishikawa@loftal.jp
#   3. secrets/service_account.json（サービスアカウント・作成不可）
# ============================================================
def get_credentials():
    """最適な認証情報を返す"""
    # 1. ユーザートークン（--authで生成）
    if USER_TOKEN_PATH.exists():
        from google.oauth2.credentials import Credentials as OAuthCreds
        from google.auth.transport.requests import Request
        creds = OAuthCreds.from_authorized_user_file(str(USER_TOKEN_PATH), SCOPES)
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            USER_TOKEN_PATH.write_text(creds.to_json())
        print("認証: OAuth2ユーザートークン使用", file=sys.stderr)
        return creds

    # 2. gcloud ADC（Application Default Credentials）
    try:
        import google.auth
        creds, project = google.auth.default(scopes=SCOPES)
        print(f"認証: gcloud ADC使用（project={project}）", file=sys.stderr)
        return creds
    except Exception:
        pass

    # 3. サービスアカウント（フォールバック）
    from google.oauth2.service_account import Credentials as SACreds
    print("認証: サービスアカウント使用（シート作成不可）", file=sys.stderr)
    return SACreds.from_service_account_file(str(SA_PATH), scopes=SCOPES)


def get_gspread_client():
    return gspread.authorize(get_credentials())


def get_drive_service():
    return build("drive", "v3", credentials=get_credentials())


# ============================================================
# YAMLケース読み込み
# ============================================================
def load_spec_cases(spec_name: str) -> list[dict]:
    yaml_path = SPECS_DIR / f"{spec_name}.yaml"
    if not yaml_path.exists():
        return []
    with open(yaml_path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    cases = []
    for c in data.get("cases", []):
        if not c:
            continue
        cases.append({
            "case_no":     str(c.get("case_no", "")),
            "feature":     str(c.get("feature", "") or ""),
            "description": str(c.get("description", "") or ""),
            "expected":    str(c.get("expected", "") or ""),
        })
    return cases


# ============================================================
# results.json 読み込み
# ============================================================
def load_results() -> dict[str, str]:
    """spec/case_no → status のマップを返す"""
    results_json = REPORTS_DIR / "results.json"
    if not results_json.exists():
        print("⚠ reports/results.json が見つかりません", file=sys.stderr)
        return {}

    with open(results_json, encoding="utf-8") as f:
        data = json.load(f)

    result_map = {}
    for item in data:
        scenario = item.get("scenario", "")
        if "/" not in scenario:
            continue
        spec_name, case_no = scenario.split("/", 1)
        status = _normalize_status(str(item.get("status", "")))
        result_map[f"{spec_name}/{case_no}"] = status

    return result_map


def _normalize_status(s: str) -> str:
    s = s.lower().strip()
    if "passed" in s:
        return "passed"
    if "fail" in s:
        return "failed"
    if "todo" in s:
        return "todo"
    if "skip" in s:
        return "skipped"
    return s


# ============================================================
# 月次スプレッドシートの取得 or 作成
# ============================================================
def get_or_create_monthly_sheet(year: int, month: int) -> gspread.Spreadsheet:
    """月次スプレッドシートを取得、なければ作成してタブを初期化する"""
    sheet_title = f"E2Eテスト結果_{year:04d}-{month:02d}"

    drive = get_drive_service()
    client = get_gspread_client()

    # 既存ファイル検索
    query = (
        f"name='{sheet_title}' "
        f"and '{DRIVE_FOLDER_ID}' in parents "
        f"and mimeType='application/vnd.google-apps.spreadsheet' "
        f"and trashed=false"
    )
    result = drive.files().list(q=query, fields="files(id,name)").execute()
    files = result.get("files", [])

    if files:
        ss_id = files[0]["id"]
        print(f"既存スプレッドシート使用: {sheet_title} (id={ss_id})")
        return client.open_by_key(ss_id)

    # 新規作成
    print(f"新規スプレッドシート作成: {sheet_title}")
    file_meta = {
        "name": sheet_title,
        "mimeType": "application/vnd.google-apps.spreadsheet",
        "parents": [DRIVE_FOLDER_ID],
    }
    created = drive.files().create(body=file_meta, fields="id").execute()
    ss_id = created["id"]
    ss = client.open_by_key(ss_id)

    # デフォルトシートをsummaryにリネーム
    default_ws = ss.get_worksheet(0)
    default_ws.update_title("summary")

    # specタブを順番に追加・初期化（レート制限対策で間隔を空ける）
    for spec_name in SPEC_ORDER:
        tab_name = SPEC_TAB_NAMES[spec_name]
        cases = load_spec_cases(spec_name)
        _init_spec_tab(ss, tab_name, cases)
        print(f"  タブ作成: {tab_name} ({len(cases)}件)")
        time.sleep(2)  # Sheets API レート制限対策

    # summaryタブ初期化
    _init_summary_tab(ss.worksheet("summary"))
    print("  タブ作成: summary")

    print(f"スプレッドシート作成完了: https://docs.google.com/spreadsheets/d/{ss_id}")
    return ss


def _init_spec_tab(ss: gspread.Spreadsheet, tab_name: str, cases: list[dict]):
    """specタブを作成してヘッダー+ケース一覧を書き込む"""
    ws = ss.add_worksheet(title=tab_name, rows=len(cases) + 5, cols=50)

    # ヘッダー行（固定列）
    headers = ["case_no", "feature", "description（手順）", "expected（期待結果）"]
    ws.update(values=[headers], range_name="A1")

    # ケース一覧を書き込み
    if cases:
        rows = [[
            c["case_no"],
            c["feature"],
            c["description"],
            c["expected"],
        ] for c in cases]
        ws.update(values=rows, range_name="A2")

    # ヘッダー行をフリーズ・スタイル
    ws.freeze(rows=1, cols=4)
    _apply_header_style(ss, ws, HEADER_COLOR, end_col=4)

    # 列幅調整
    ss.batch_update({"requests": [
        {"updateDimensionProperties": {
            "range": {"sheetId": ws.id, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 1},
            "properties": {"pixelSize": 90}, "fields": "pixelSize"
        }},
        {"updateDimensionProperties": {
            "range": {"sheetId": ws.id, "dimension": "COLUMNS", "startIndex": 1, "endIndex": 2},
            "properties": {"pixelSize": 140}, "fields": "pixelSize"
        }},
        {"updateDimensionProperties": {
            "range": {"sheetId": ws.id, "dimension": "COLUMNS", "startIndex": 2, "endIndex": 4},
            "properties": {"pixelSize": 220}, "fields": "pixelSize"
        }},
    ]})


def _init_summary_tab(ws: gspread.Worksheet):
    """summaryタブを縦型レイアウトで初期化する。
    行=spec、列=実行回。
      A1: ""(空)       B列〜: 各実行日時
      A2〜A17: spec名
      A18: (空行)
      A19: passed計
      A20: failed計
      A21: skipped計
      A22: 失敗テスト →
    """
    col_a = [["（spec）"]]  # A1: 見出し
    for s in SPEC_ORDER:
        col_a.append([SPEC_TAB_NAMES[s]])
    col_a.append([""])          # A18: 空行
    col_a.append(["passed計"])  # A19
    col_a.append(["failed計"])  # A20
    col_a.append(["skipped計"]) # A21
    col_a.append(["失敗テスト →"])  # A22
    ws.update(values=col_a, range_name="A1")
    ws.freeze(rows=1, cols=1)


# ============================================================
# テスト結果の追記
# ============================================================
def _get_run_number(ss: gspread.Spreadsheet) -> int:
    """既存の「n回目テストレポート」タブから次の実行回数を返す"""
    worksheets = ss.worksheets()
    ws_titles = [ws.title for ws in worksheets]
    max_n = 0
    for title in ws_titles:
        m = re.match(r'^(\d+)回目テストレポート$', title)
        if m:
            max_n = max(max_n, int(m.group(1)))
    return max_n + 1


def push_run(dry_run: bool = False):
    """最新のテスト結果を月次シートに追記する"""
    now = datetime.now()
    year, month = now.year, now.month

    result_map = load_results()
    if not result_map:
        print("結果データがありません")
        return

    print(f"結果件数: {len(result_map)}件")

    if dry_run:
        print("[DRY RUN] 実際には書き込みません")
        print(f"  → 対象: E2Eテスト結果_{year:04d}-{month:02d}")
        print(f"  → タブ: n回目テストレポート + {', '.join(SPEC_ORDER)}")
        for spec_name in SPEC_ORDER:
            cases = load_spec_cases(spec_name)
            spec_results = {k: v for k, v in result_map.items() if k.startswith(f"{spec_name}/")}
            print(f"  → {spec_name}: {len(cases)}ケース / 結果{len(spec_results)}件")
        return

    ss = get_or_create_monthly_sheet(year, month)
    run_n = _get_run_number(ss)
    run_label = f"{run_n}回目"
    print(f"実行回数: {run_label} ({now.strftime('%Y/%m/%d %H:%M')})")

    # 集計用
    total_passed = total_failed = total_skipped = 0
    failed_links = []  # (表示名, URL)
    spec_stats = {}   # spec_name -> {"passed": N, "failed": N, "total": N}

    for spec_name in SPEC_ORDER:
        tab_name = SPEC_TAB_NAMES[spec_name]
        cases = load_spec_cases(spec_name)
        if not cases:
            continue

        try:
            ws = ss.worksheet(tab_name)
        except gspread.WorksheetNotFound:
            print(f"  タブ未作成: {tab_name} → 作成します")
            _init_spec_tab(ss, tab_name, cases)
            ws = ss.worksheet(tab_name)

        # 現在の列数を調べて、次の列（実行回列）を決定
        all_values = _api_call_with_retry(lambda: ws.get_all_values())
        header_row = all_values[0] if all_values else []

        # 4列（固定）+ 実行回数分
        # 同じ実行ラベルがすでにある場合はスキップ
        if run_label in header_row:
            print(f"  ⏭ {tab_name}: {run_label} は書き込み済み、スキップ")
            continue

        next_col_idx = max(len(header_row), 4)  # 0-indexed
        next_col_letter = _col_idx_to_letter(next_col_idx)

        if dry_run:
            print(f"  [DRY] {tab_name}: {next_col_letter}列に {run_label} を追記予定")
            continue

        # ヘッダー行に実行日時を追加
        _api_call_with_retry(lambda col=next_col_letter: ws.update(
            values=[[run_label]],
            range_name=f"{col}1"
        ))

        # case_no → 行番号マッピング（2行目から）
        case_to_row = {}
        for row_i, row in enumerate(all_values[1:], start=2):
            if row and row[0]:
                case_to_row[row[0]] = row_i

        # ステータスを書き込み
        value_updates = []
        color_requests = []
        spec_failed = []
        spec_p = spec_f = spec_s = 0

        for c in cases:
            case_no = c["case_no"]
            key = f"{spec_name}/{case_no}"
            status = result_map.get(key, "")
            row_num = case_to_row.get(case_no)
            if not row_num:
                continue

            cell_ref = f"{next_col_letter}{row_num}"
            value_updates.append({
                "range": f"'{tab_name}'!{cell_ref}",
                "values": [[status]],
            })

            color = STATUS_COLORS.get(status, STATUS_COLORS[""])
            color_requests.append({
                "repeatCell": {
                    "range": {
                        "sheetId": ws.id,
                        "startRowIndex": row_num - 1,
                        "endRowIndex": row_num,
                        "startColumnIndex": next_col_idx,
                        "endColumnIndex": next_col_idx + 1,
                    },
                    "cell": {"userEnteredFormat": {"backgroundColor": color}},
                    "fields": "userEnteredFormat(backgroundColor)",
                }
            })

            if status == "passed":
                total_passed += 1
                spec_p += 1
            elif status == "failed":
                total_failed += 1
                spec_f += 1
                spec_failed.append((case_no, c["feature"], ws.id, row_num, next_col_idx))
            elif status in ("skipped", "skip", "todo"):
                total_skipped += 1
                spec_s += 1

        spec_stats[spec_name] = {"passed": spec_p, "failed": spec_f, "skipped": spec_s, "total": len(cases)}

        # 一括書き込み
        if value_updates:
            _api_call_with_retry(lambda: ss.values_batch_update({
                "valueInputOption": "USER_ENTERED",
                "data": value_updates,
            }))
            time.sleep(2)
        if color_requests:
            for i in range(0, len(color_requests), 50):
                _api_call_with_retry(lambda batch=color_requests[i:i+50]: ss.batch_update({"requests": batch}))
                time.sleep(1)

        # ヘッダー列をスタイル
        time.sleep(2)
        _apply_run_header_style(ss, ws, next_col_idx)

        # failed一覧をリンク用に保存
        ss_url = f"https://docs.google.com/spreadsheets/d/{ss.id}"
        for case_no, feature, sheet_id, row_num, col_idx in spec_failed:
            # Sheetsのセルリンク形式
            cell_ref = f"{_col_idx_to_letter(col_idx)}{row_num}"
            link = f"{ss_url}/edit#gid={sheet_id}&range={cell_ref}"
            display = f"{spec_name}/{case_no}（{feature[:15]}）"
            failed_links.append((display, link))

        print(f"  ✅ {tab_name}: {len(value_updates)}件書き込み完了")

    if dry_run:
        return

    # n回目テストレポートタブ作成
    _create_run_report_tab(ss, run_n, now, total_passed, total_failed, total_skipped, spec_stats, failed_links)

    print(f"\n📊 実行結果サマリー: passed={total_passed} failed={total_failed} skipped={total_skipped}")
    print(f"🔗 シートURL: https://docs.google.com/spreadsheets/d/{ss.id}")
    return ss.id


def get_failed_specs() -> list[str]:
    """results.jsonから失敗があるspec名のリストを返す（Docker再実行用）"""
    result_map = load_results()
    failing = set()
    for key, status in result_map.items():
        if status == "failed":
            spec_name = key.split("/")[0]
            failing.add(spec_name)
    return sorted(failing)


def merge_run(dry_run: bool = False):
    """失敗specだけ再実行した結果を既存の最終列にマージして上書きする。
    新しい列は作らず、N回目テストレポートタブを更新する。
    """
    now = datetime.now()
    year, month = now.year, now.month

    result_map = load_results()
    if not result_map:
        print("結果データがありません")
        return

    # 今回の結果があるspecを特定
    updated_specs = {k.split("/")[0] for k in result_map}
    print(f"マージ対象spec: {', '.join(sorted(updated_specs))}")
    print(f"結果件数: {len(result_map)}件")

    if dry_run:
        print("[DRY RUN] 実際には書き込みません")
        return

    ss = get_or_create_monthly_sheet(year, month)

    # 最後の実行回数を特定（テストレポートタブから）
    run_n = _get_run_number(ss) - 1  # 既存の最後の回
    if run_n < 1:
        print("⚠️ 既存のテストレポートタブが見つかりません。--push-run を先に実行してください。")
        return
    run_label = f"{run_n}回目"
    print(f"マージ先: {run_label}")

    # 各specタブを更新（今回の結果があるspecのみ）
    # また全specのstatsを再集計（マージ後の最終状態）
    full_spec_stats = {}
    total_passed = total_failed = total_skipped = 0
    failed_links = []

    for spec_name in SPEC_ORDER:
        tab_name = SPEC_TAB_NAMES[spec_name]
        cases = load_spec_cases(spec_name)
        if not cases:
            continue

        try:
            ws = ss.worksheet(tab_name)
        except gspread.WorksheetNotFound:
            continue

        all_values = _api_call_with_retry(lambda: ws.get_all_values())
        header_row = all_values[0] if all_values else []

        # run_labelの列を探す
        if run_label not in header_row:
            print(f"  ⚠️ {tab_name}: {run_label}列が見つかりません → スキップ")
            continue
        col_idx = header_row.index(run_label)  # 0-indexed
        col_letter = _col_idx_to_letter(col_idx)

        # case_no → 行番号
        case_to_row = {}
        for row_i, row in enumerate(all_values[1:], start=2):
            if row and row[0]:
                case_to_row[row[0]] = row_i

        # case_no → 現在のステータス（シート上の値）
        current_status = {}
        for row_i, row in enumerate(all_values[1:], start=2):
            if row and row[0]:
                current_status[row[0]] = row[col_idx] if len(row) > col_idx else ""

        if spec_name in updated_specs:
            # 今回再実行したspec → 変更されたセルだけ更新
            value_updates = []
            color_requests = []
            spec_failed = []

            for c in cases:
                case_no = c["case_no"]
                key = f"{spec_name}/{case_no}"
                new_status = result_map.get(key)
                if new_status is None:
                    continue  # 今回実行していないケースはスキップ
                row_num = case_to_row.get(case_no)
                if not row_num:
                    continue

                old_status = current_status.get(case_no, "")
                if old_status == new_status:
                    continue  # 変化なし → 書き込み不要

                cell_ref = f"{col_letter}{row_num}"
                value_updates.append({
                    "range": f"'{tab_name}'!{cell_ref}",
                    "values": [[new_status]],
                })
                color = STATUS_COLORS.get(new_status, STATUS_COLORS[""])
                color_requests.append({
                    "repeatCell": {
                        "range": {
                            "sheetId": ws.id,
                            "startRowIndex": row_num - 1, "endRowIndex": row_num,
                            "startColumnIndex": col_idx, "endColumnIndex": col_idx + 1,
                        },
                        "cell": {"userEnteredFormat": {"backgroundColor": color}},
                        "fields": "userEnteredFormat(backgroundColor)",
                    }
                })

            if value_updates:
                _api_call_with_retry(lambda: ss.values_batch_update({
                    "valueInputOption": "USER_ENTERED",
                    "data": value_updates,
                }))
                time.sleep(1)
            if color_requests:
                for i in range(0, len(color_requests), 50):
                    _api_call_with_retry(lambda batch=color_requests[i:i+50]: ss.batch_update({"requests": batch}))
                    time.sleep(0.5)
            changed = len(value_updates)
            print(f"  ✅ {tab_name}: {changed}件更新（マージ）")
        else:
            print(f"  ⏭ {tab_name}: 今回未実行 → シート値をそのまま使用")

        # マージ後の最終ステータスを再集計（シート値 + 新結果を合算）
        sp = sf = sc = 0
        ss_url = f"https://docs.google.com/spreadsheets/d/{ss.id}"
        for c in cases:
            case_no = c["case_no"]
            key = f"{spec_name}/{case_no}"
            # 新結果があればそちらを優先、なければシート値
            if key in result_map:
                status = result_map[key]
            else:
                status = current_status.get(case_no, "")
            status = _normalize_status(status)
            row_num = case_to_row.get(case_no)

            if status == "passed":
                total_passed += 1; sp += 1
            elif status == "failed":
                total_failed += 1; sf += 1
                if row_num:
                    cell_ref = f"{col_letter}{row_num}"
                    link = f"{ss_url}/edit#gid={ws.id}&range={cell_ref}"
                    failed_links.append((f"{spec_name}/{case_no}（{c['feature'][:15]}）", link))
            elif status in ("skipped", "skip", "todo"):
                total_skipped += 1; sc += 1

        full_spec_stats[spec_name] = {"passed": sp, "failed": sf, "skipped": sc, "total": len(cases)}

    # テストレポートタブを更新（削除して再作成）
    _create_run_report_tab(ss, run_n, now, total_passed, total_failed, total_skipped, full_spec_stats, failed_links)

    print(f"\n📊 マージ後の結果: passed={total_passed} failed={total_failed} skipped={total_skipped}")
    print(f"🔗 シートURL: https://docs.google.com/spreadsheets/d/{ss.id}")
    return ss.id


def _generate_analysis(spec_stats: dict, passed: int, failed: int, skipped: int, total: int) -> list[str]:
    """失敗パターンを分析してテキスト行のリストを返す"""
    lines = []
    pass_rate = passed / total * 100 if total > 0 else 0

    # 総合判定
    if pass_rate >= 90:
        overall = f"✅ 良好  合格率 {pass_rate:.1f}%（{passed}/{total}件）"
    elif pass_rate >= 75:
        overall = f"⚠️ 要改善  合格率 {pass_rate:.1f}%（{passed}/{total}件）"
    else:
        overall = f"❌ 要対応  合格率 {pass_rate:.1f}%（{passed}/{total}件）"
    lines.append(overall)
    lines.append("")

    # 失敗が多いspec 上位
    failing = [(n, st) for n, st in spec_stats.items() if st.get("failed", 0) > 0]
    failing.sort(key=lambda x: x[1]["failed"], reverse=True)

    if failing:
        lines.append("【失敗が多いspec（上位）】")
        for spec_name, st in failing[:6]:
            tab_display = SPEC_TAB_NAMES.get(spec_name, spec_name)
            f_pct = st["failed"] / st["total"] * 100 if st["total"] > 0 else 0
            lines.append(f"  {tab_display}:  {st['failed']}件失敗  （失敗率 {f_pct:.0f}%）")
        lines.append("")

    # 推定原因パターン
    lines.append("【推定される失敗原因】")
    causes = []

    auth_failed = spec_stats.get("auth", {}).get("failed", 0)
    if auth_failed > 0:
        causes.append(f"  ・認証系失敗 {auth_failed}件: アカウントロック（20回/日制限）または"
                      f"ログイン設定の問題。IS_PRODUCTION=falseでロック無効化を確認（PR#2769）。")

    up_failed = spec_stats.get("users-permissions", {}).get("failed", 0)
    if up_failed > 0:
        causes.append(f"  ・ユーザー権限系失敗 {up_failed}件: URLルーティング変更の可能性"
                      f"（/admin/user → /admin/admin）。spec.jsのURL修正で解決できる可能性あり。")

    notif_failed = spec_stats.get("notifications", {}).get("failed", 0)
    if notif_failed > 0:
        causes.append(f"  ・通知系失敗 {notif_failed}件: SMTP設定またはメール受信タイムアウトの可能性。"
                      f"IMAPサーバーの接続確認を推奨。")

    unc_failed = spec_stats.get("uncategorized", {}).get("failed", 0)
    if unc_failed > 0:
        causes.append(f"  ・未分類テスト失敗 {unc_failed}件: 最大グループ。セレクター変更・タイムアウト・"
                      f"UI変更など複合的な原因が考えられる。動画で個別確認推奨。")

    fields_failed = spec_stats.get("fields", {}).get("failed", 0)
    if fields_failed > 0:
        causes.append(f"  ・フィールド系失敗 {fields_failed}件: テストデータ（ALLテストテーブル）が"
                      f"存在しない場合に発生。beforeAllのセットアップ処理を確認。")

    chart_failed = spec_stats.get("chart-calendar", {}).get("failed", 0)
    if chart_failed > 0:
        causes.append(f"  ・チャート/カレンダー失敗 {chart_failed}件: グラフの描画タイミング・"
                      f"データ未登録による表示エラーの可能性。waitForSelector追加を検討。")

    # 残りの失敗specをまとめる
    other_specs = [(n, st) for n, st in failing
                   if n not in {"auth", "users-permissions", "notifications",
                                "uncategorized", "fields", "chart-calendar"}]
    if other_specs:
        other_total = sum(st["failed"] for _, st in other_specs)
        names = "・".join(SPEC_TAB_NAMES.get(n, n) for n, _ in other_specs)
        causes.append(f"  ・その他 {other_total}件（{names}）: セレクター・期待値の変化が原因の可能性。")

    if not causes:
        causes.append("  ・失敗なし。全テスト正常通過。")

    lines.extend(causes)
    lines.append("")

    # スキップ分析
    if skipped > 0:
        skip_pct = skipped / total * 100
        lines.append("【スキップ分析】")
        lines.append(f"  スキップ {skipped}件（{skip_pct:.1f}%）: テスト環境制約（データなし・権限なし・外部サービス未設定）。")
        if skipped > total * 0.05:
            lines.append("  ⚠️ スキップ率が5%超。テスト環境のセットアップ（debug API）を活用して削減可能。")
        lines.append("")

    # 推奨アクション
    lines.append("【推奨アクション】")
    recs = []
    if auth_failed > 0:
        recs.append("  1. IS_PRODUCTION ガード確認（PR#2769 staging適用済み）→ 次回実行で改善されるか確認")
    if up_failed > 0:
        recs.append("  2. users-permissions.spec.js: /admin/user → /admin/admin への修正確認")
    if unc_failed > 10:
        recs.append("  3. uncategorized: 動画リンクで失敗内容を個別確認 → spec修正 or プロダクトバグとして起票")
    if fields_failed > 0 or chart_failed > 0:
        recs.append("  4. フィールド/チャート系: beforeAllでcreate-all-type-tableを呼ぶよう統一")
    if not recs:
        recs.append("  特に問題なし。次回テスト実行を継続してください。")
    lines.extend(recs)

    return lines


def _create_run_report_tab(
    ss: gspread.Spreadsheet,
    run_n: int,
    run_datetime: datetime,
    passed: int, failed: int, skipped: int,
    spec_stats: dict,
    failed_links: list[tuple[str, str]],
):
    """n回目テストレポートタブを新規作成してきれいなサマリーを書く"""
    tab_name = f"{run_n}回目テストレポート"
    total = passed + failed + skipped
    pass_rate_pct = passed / total * 100 if total > 0 else 0
    pass_rate = f"{pass_rate_pct:.1f}%" if total > 0 else "-"
    fail_rate = f"{failed/total*100:.1f}%" if total > 0 else "-"
    skip_rate = f"{skipped/total*100:.1f}%" if total > 0 else "-"

    # ========== 分析テキスト生成 ==========
    analysis_lines = _generate_analysis(spec_stats, passed, failed, skipped, total)

    # タブ作成（既存なら削除して再作成）
    try:
        ws_old = ss.worksheet(tab_name)
        ss.del_worksheet(ws_old)
    except gspread.WorksheetNotFound:
        pass

    # 失敗テスト行数・分析行数を考慮した行数
    total_rows = 30 + len(SPEC_ORDER) + len(failed_links) + len(analysis_lines) + 20
    ws = ss.add_worksheet(title=tab_name, rows=total_rows, cols=8)

    # ========== レイアウト定義 ==========
    # 行番号（1-indexed）
    R_TITLE        = 1
    R_DATETIME     = 2
    R_BLANK1       = 3
    R_SUMMARY_HDR  = 4
    R_TOTAL        = 5
    R_PASSED       = 6
    R_FAILED       = 7
    R_SKIPPED      = 8
    R_BLANK2       = 9
    R_SPEC_HDR     = 10
    R_SPEC_LABEL   = 11  # spec列ヘッダー
    R_SPEC_START   = 12  # specデータ開始行
    R_SPEC_END     = R_SPEC_START + len(SPEC_ORDER) - 1
    R_BLANK3       = R_SPEC_END + 1
    R_FAIL_HDR     = R_BLANK3 + 1
    R_FAIL_LABEL   = R_FAIL_HDR + 1
    R_FAIL_START   = R_FAIL_LABEL + 1
    R_FAIL_END     = R_FAIL_START + max(len(failed_links) - 1, 0)
    R_BLANK4       = R_FAIL_END + 1
    R_ANALYSIS_HDR = R_BLANK4 + 1
    R_ANALYSIS_START = R_ANALYSIS_HDR + 1

    # ========== データ書き込み ==========
    # rangeにシート名を付けないとデフォルトシートに書き込まれるため必須
    p_ = f"'{tab_name}'!"
    batch_data = []

    # タイトル行
    batch_data.append({
        "range": f"{p_}A{R_TITLE}:H{R_TITLE}",
        "values": [[f"{'　' * 5}{run_n}回目 テスト実行レポート", "", "", "", "", "", "", ""]],
    })

    # 実行日時
    batch_data.append({
        "range": f"{p_}A{R_DATETIME}",
        "values": [[f"実行日時：{run_datetime.strftime('%Y/%m/%d  %H:%M')}"]],
    })

    # 総合結果ヘッダー
    batch_data.append({
        "range": f"{p_}A{R_SUMMARY_HDR}",
        "values": [["■ 総合結果"]],
    })

    # 総合結果データ
    summary_rows = [
        ["", "合計",   total,  "件", "",  "",   "",    ""],
        ["", "✅ 成功", passed, "件", pass_rate, "", "", ""],
        ["", "❌ 失敗", failed, "件", fail_rate, "", "", ""],
        ["", "⏭ スキップ", skipped, "件", skip_rate, "", "", ""],
    ]
    batch_data.append({
        "range": f"{p_}A{R_TOTAL}:H{R_SKIPPED}",
        "values": summary_rows,
    })

    # spec別結果ヘッダー
    batch_data.append({
        "range": f"{p_}A{R_SPEC_HDR}",
        "values": [["■ spec別結果"]],
    })

    # spec列ラベル
    batch_data.append({
        "range": f"{p_}A{R_SPEC_LABEL}:F{R_SPEC_LABEL}",
        "values": [["spec名", "合計", "✅ 成功", "❌ 失敗", "⏭ スキップ", "判定"]],
    })

    # specデータ行
    spec_rows = []
    for spec_name in SPEC_ORDER:
        tab_display = SPEC_TAB_NAMES[spec_name]
        st = spec_stats.get(spec_name)
        if st is None:
            spec_rows.append([tab_display, "-", "-", "-", "-", "（未実行）"])
            continue
        p, f, s, t = st["passed"], st["failed"], st["skipped"], st["total"]
        if f == 0 and p > 0:
            verdict = "✅ 全件成功"
        elif f == 0 and p == 0:
            verdict = "⏭ スキップのみ"
        else:
            verdict = f"❌ {f}件失敗"
        spec_rows.append([tab_display, t, p, f, s, verdict])
    batch_data.append({
        "range": f"{p_}A{R_SPEC_START}:F{R_SPEC_END}",
        "values": spec_rows,
    })

    # 失敗テスト一覧ヘッダー
    batch_data.append({
        "range": f"{p_}A{R_FAIL_HDR}",
        "values": [["■ 失敗テスト一覧"]],
    })
    batch_data.append({
        "range": f"{p_}A{R_FAIL_LABEL}:C{R_FAIL_LABEL}",
        "values": [["テストケース", "機能名", "動画リンク"]],
    })

    # 分析・総括セクション
    batch_data.append({
        "range": f"{p_}A{R_ANALYSIS_HDR}",
        "values": [["■ 分析・総括"]],
    })
    if analysis_lines:
        batch_data.append({
            "range": f"{p_}A{R_ANALYSIS_START}:D{R_ANALYSIS_START + len(analysis_lines) - 1}",
            "values": [[line, "", "", ""] for line in analysis_lines],
        })

    # 一括書き込み
    _api_call_with_retry(lambda: ss.values_batch_update({
        "valueInputOption": "USER_ENTERED",
        "data": batch_data,
    }))

    # 失敗テストリンク（HYPERLINKは個別で）
    if failed_links:
        link_rows = []
        for name, url in failed_links:
            parts = name.split("（", 1)
            case_part = parts[0].strip()
            feat_part = parts[1].rstrip("）") if len(parts) > 1 else ""
            link_rows.append([case_part, feat_part, f'=HYPERLINK("{url}","▶ 動画")'])
        _api_call_with_retry(lambda: ss.values_batch_update({
            "valueInputOption": "USER_ENTERED",
            "data": [{
                "range": f"{p_}A{R_FAIL_START}:C{R_FAIL_START + len(link_rows) - 1}",
                "values": link_rows,
            }],
        }))

    # ========== スタイル ==========
    style_requests = []
    sheet_id = ws.id

    def _rgb(r, g, b):
        return {"red": r, "green": g, "blue": b}

    def _cell_style(start_row, end_row, start_col, end_col, bg=None, bold=False,
                    font_size=None, fg=None, halign=None, valign=None):
        fmt = {}
        if bg:
            fmt["backgroundColor"] = bg
        tf = {}
        if bold:
            tf["bold"] = True
        if font_size:
            tf["fontSize"] = font_size
        if fg:
            tf["foregroundColor"] = fg
        if tf:
            fmt["textFormat"] = tf
        if halign:
            fmt["horizontalAlignment"] = halign
        if valign:
            fmt["verticalAlignment"] = valign
        fields = "userEnteredFormat(" + ",".join(
            ([f"backgroundColor"] if bg else []) +
            (["textFormat"] if tf else []) +
            (["horizontalAlignment"] if halign else []) +
            (["verticalAlignment"] if valign else [])
        ) + ")"
        return {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": start_row - 1, "endRowIndex": end_row,
                    "startColumnIndex": start_col, "endColumnIndex": end_col,
                },
                "cell": {"userEnteredFormat": fmt},
                "fields": fields,
            }
        }

    # タイトル行：ダークブルー背景・白文字・大文字
    style_requests.append(_cell_style(
        R_TITLE, R_TITLE + 1, 0, 8,
        bg=_rgb(0.18, 0.35, 0.67), bold=True, font_size=14,
        fg=_rgb(1, 1, 1), halign="CENTER", valign="MIDDLE"
    ))

    # 実行日時行
    style_requests.append(_cell_style(
        R_DATETIME, R_DATETIME + 1, 0, 8,
        bg=_rgb(0.85, 0.90, 0.98)
    ))

    # セクションヘッダー（総合結果・spec別・失敗一覧）
    for r in [R_SUMMARY_HDR, R_SPEC_HDR, R_FAIL_HDR]:
        style_requests.append(_cell_style(
            r, r + 1, 0, 8,
            bg=_rgb(0.25, 0.45, 0.75), bold=True,
            fg=_rgb(1, 1, 1)
        ))

    # 総合結果データ
    style_requests.append(_cell_style(
        R_TOTAL, R_TOTAL + 1, 0, 8,
        bg=_rgb(0.95, 0.95, 0.95)
    ))
    style_requests.append(_cell_style(
        R_PASSED, R_PASSED + 1, 0, 8,
        bg=_rgb(0.71, 0.88, 0.80)  # 薄緑
    ))
    if failed > 0:
        style_requests.append(_cell_style(
            R_FAILED, R_FAILED + 1, 0, 8,
            bg=_rgb(0.96, 0.78, 0.76)  # 薄赤
        ))
    else:
        style_requests.append(_cell_style(
            R_FAILED, R_FAILED + 1, 0, 8,
            bg=_rgb(0.95, 0.95, 0.95)
        ))
    style_requests.append(_cell_style(
        R_SKIPPED, R_SKIPPED + 1, 0, 8,
        bg=_rgb(0.99, 0.91, 0.70)  # 薄黄
    ))

    # spec列ヘッダー
    style_requests.append(_cell_style(
        R_SPEC_LABEL, R_SPEC_LABEL + 1, 0, 6,
        bg=_rgb(0.20, 0.40, 0.80), bold=True,
        fg=_rgb(1, 1, 1), halign="CENTER"
    ))

    # spec行の交互色・判定色
    for i, spec_name in enumerate(SPEC_ORDER):
        row = R_SPEC_START + i
        st = spec_stats.get(spec_name)
        if st:
            f_cnt = st["failed"]
            if f_cnt == 0:
                row_bg = _rgb(0.90, 0.97, 0.93)  # 薄緑
            else:
                row_bg = _rgb(1.0, 0.93, 0.92)   # 薄ピンク
        else:
            row_bg = _rgb(0.96, 0.96, 0.96)
        style_requests.append(_cell_style(row, row + 1, 0, 6, bg=row_bg))

    # 失敗テスト列ヘッダー
    style_requests.append(_cell_style(
        R_FAIL_LABEL, R_FAIL_LABEL + 1, 0, 3,
        bg=_rgb(0.20, 0.40, 0.80), bold=True,
        fg=_rgb(1, 1, 1), halign="CENTER"
    ))

    # 失敗テスト行（薄赤）
    if failed_links:
        style_requests.append(_cell_style(
            R_FAIL_START, R_FAIL_START + len(failed_links), 0, 3,
            bg=_rgb(1.0, 0.94, 0.94)
        ))

    # 分析・総括セクションヘッダー
    style_requests.append(_cell_style(
        R_ANALYSIS_HDR, R_ANALYSIS_HDR + 1, 0, 8,
        bg=_rgb(0.25, 0.45, 0.75), bold=True,
        fg=_rgb(1, 1, 1)
    ))
    # 分析テキスト行
    if analysis_lines:
        for i, line in enumerate(analysis_lines):
            row = R_ANALYSIS_START + i
            if line.startswith("【") or line.startswith("■"):
                # 小見出し
                style_requests.append(_cell_style(
                    row, row + 1, 0, 6,
                    bg=_rgb(0.90, 0.93, 0.98), bold=True
                ))
            elif line.startswith("✅"):
                style_requests.append(_cell_style(
                    row, row + 1, 0, 6,
                    bg=_rgb(0.88, 0.97, 0.91)
                ))
            elif line.startswith("⚠️") or "要改善" in line:
                style_requests.append(_cell_style(
                    row, row + 1, 0, 6,
                    bg=_rgb(1.0, 0.97, 0.80)
                ))
            elif line.startswith("❌"):
                style_requests.append(_cell_style(
                    row, row + 1, 0, 6,
                    bg=_rgb(1.0, 0.91, 0.91)
                ))
            else:
                style_requests.append(_cell_style(
                    row, row + 1, 0, 6,
                    bg=_rgb(0.97, 0.97, 0.97)
                ))

    # スタイル一括適用
    _api_call_with_retry(lambda: ss.batch_update({"requests": style_requests}))

    # タイトル行をセル結合（A1:H1）
    _api_call_with_retry(lambda: ss.batch_update({"requests": [{
        "mergeCells": {
            "range": {
                "sheetId": sheet_id,
                "startRowIndex": R_TITLE - 1, "endRowIndex": R_TITLE,
                "startColumnIndex": 0, "endColumnIndex": 8,
            },
            "mergeType": "MERGE_ALL",
        }
    }]}))

    # 列幅調整
    _api_call_with_retry(lambda: ss.batch_update({"requests": [
        {"updateDimensionProperties": {
            "range": {"sheetId": sheet_id, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 1},
            "properties": {"pixelSize": 250}, "fields": "pixelSize"
        }},
        {"updateDimensionProperties": {
            "range": {"sheetId": sheet_id, "dimension": "COLUMNS", "startIndex": 1, "endIndex": 2},
            "properties": {"pixelSize": 80}, "fields": "pixelSize"
        }},
        {"updateDimensionProperties": {
            "range": {"sheetId": sheet_id, "dimension": "COLUMNS", "startIndex": 2, "endIndex": 5},
            "properties": {"pixelSize": 100}, "fields": "pixelSize"
        }},
        {"updateDimensionProperties": {
            "range": {"sheetId": sheet_id, "dimension": "COLUMNS", "startIndex": 5, "endIndex": 6},
            "properties": {"pixelSize": 140}, "fields": "pixelSize"
        }},
        # タイトル行の高さ
        {"updateDimensionProperties": {
            "range": {"sheetId": sheet_id, "dimension": "ROWS", "startIndex": R_TITLE - 1, "endIndex": R_TITLE},
            "properties": {"pixelSize": 50}, "fields": "pixelSize"
        }},
    ]}))

    print(f"  📋 {tab_name} タブ作成完了")


def _push_summary(
    ss: gspread.Spreadsheet,
    run_label: str,
    passed: int, failed: int, skipped: int,
    spec_stats: dict,
    failed_links: list[tuple[str, str]],
):
    """summaryタブに1列追記する（縦型レイアウト）。
    レイアウト:
      列A: spec名（固定）
      列B〜: 実行回ごとの結果
        行1: 実行日時
        行2〜17: spec別 passed/total（カラー付き）
        行18: 空行
        行19: passed計
        行20: failed計
        行21: skipped計
        行22〜: 失敗テストリンク（縦並び）
    """
    # 行インデックス定数（1-indexed）
    SPEC_START_ROW  = 2                             # spec行 開始
    SPEC_END_ROW    = SPEC_START_ROW + len(SPEC_ORDER) - 1  # = 17
    BLANK_ROW       = SPEC_END_ROW + 1              # = 18
    PASSED_ROW      = BLANK_ROW + 1                 # = 19
    FAILED_ROW      = PASSED_ROW + 1                # = 20
    SKIPPED_ROW     = FAILED_ROW + 1                # = 21
    LINKS_START_ROW = SKIPPED_ROW + 1               # = 22

    try:
        ws = ss.worksheet("summary")
    except gspread.WorksheetNotFound:
        ws = ss.add_worksheet("summary", rows=200, cols=100)
        _init_summary_tab(ws)

    # 次の空列を探す（行1のヘッダーを参照）
    header_row = _api_call_with_retry(lambda: ws.row_values(1))
    next_col_idx = max(len(header_row), 1)  # 0-indexed（最低でもB列=1）
    next_col_letter = _col_idx_to_letter(next_col_idx)

    # 同じ実行ラベルがすでにある場合はスキップ
    if run_label in header_row:
        print(f"  ⏭ summary: {run_label} は書き込み済み、スキップ")
        return

    # --- 列データを構築 ---
    col_values = [[run_label]]  # 行1: 実行日時

    color_requests = []

    # 行2〜17: spec別結果
    for i, spec_name in enumerate(SPEC_ORDER):
        row_num = SPEC_START_ROW + i  # 2〜17
        st = spec_stats.get(spec_name)
        if st is None:
            col_values.append(["-"])
            continue
        p, f, t = st["passed"], st["failed"], st["total"]
        if f == 0 and p == t:
            cell_val = f"✅ {p}/{t}"
            color = STATUS_COLORS["passed"]
        elif f == 0:
            cell_val = f"{p}/{t}"
            color = STATUS_COLORS["skipped"]
        else:
            cell_val = f"❌ {f}失敗 ({p}/{t})"
            color = STATUS_COLORS["failed"]
        col_values.append([cell_val])
        color_requests.append({
            "repeatCell": {
                "range": {
                    "sheetId": ws.id,
                    "startRowIndex": row_num - 1,
                    "endRowIndex": row_num,
                    "startColumnIndex": next_col_idx,
                    "endColumnIndex": next_col_idx + 1,
                },
                "cell": {"userEnteredFormat": {"backgroundColor": color}},
                "fields": "userEnteredFormat(backgroundColor)",
            }
        })

    # 行18: 空行
    col_values.append([""])

    # 行19〜21: 合計
    col_values.append([passed])
    col_values.append([failed])
    col_values.append([skipped])

    # 失敗計セルを赤色
    if failed > 0:
        color_requests.append({
            "repeatCell": {
                "range": {
                    "sheetId": ws.id,
                    "startRowIndex": FAILED_ROW - 1,
                    "endRowIndex": FAILED_ROW,
                    "startColumnIndex": next_col_idx,
                    "endColumnIndex": next_col_idx + 1,
                },
                "cell": {"userEnteredFormat": {"backgroundColor": STATUS_COLORS["failed"]}},
                "fields": "userEnteredFormat(backgroundColor)",
            }
        })

    # 列をまとめて書き込み（行1〜21）
    _api_call_with_retry(lambda: ws.update(
        values=col_values,
        range_name=f"{next_col_letter}1",
        value_input_option="USER_ENTERED",
    ))

    if color_requests:
        _api_call_with_retry(lambda: ss.batch_update({"requests": color_requests}))

    # 行22〜: 失敗テストリンク（縦並び）
    if failed_links:
        link_formulas = [
            [f'=HYPERLINK("{url}","{name.replace(chr(34), chr(39))}")']
            for name, url in failed_links
        ]
        _api_call_with_retry(lambda: ws.update(
            values=link_formulas,
            range_name=f"{next_col_letter}{LINKS_START_ROW}",
            value_input_option="USER_ENTERED",
        ))
        # 失敗リンクセルを薄赤に
        _api_call_with_retry(lambda: ss.batch_update({"requests": [{
            "repeatCell": {
                "range": {
                    "sheetId": ws.id,
                    "startRowIndex": LINKS_START_ROW - 1,
                    "endRowIndex": LINKS_START_ROW - 1 + len(failed_links),
                    "startColumnIndex": next_col_idx,
                    "endColumnIndex": next_col_idx + 1,
                },
                "cell": {"userEnteredFormat": {"backgroundColor": STATUS_COLORS["failed"]}},
                "fields": "userEnteredFormat(backgroundColor)",
            }
        }]}))

    # ヘッダー列スタイル
    _api_call_with_retry(lambda: ss.batch_update({"requests": [{
        "repeatCell": {
            "range": {
                "sheetId": ws.id,
                "startRowIndex": 0, "endRowIndex": 1,
                "startColumnIndex": next_col_idx, "endColumnIndex": next_col_idx + 1,
            },
            "cell": {"userEnteredFormat": {
                "textFormat": {"bold": True},
                "backgroundColor": {"red": 0.85, "green": 0.92, "blue": 0.83},
                "horizontalAlignment": "CENTER",
            }},
            "fields": "userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)",
        }
    }]}))

    print(f"  📋 summaryタブ更新: 列{next_col_letter} / spec{len(spec_stats)}件 / failed_links{len(failed_links)}件")


# ============================================================
# スタイルヘルパー
# ============================================================
def _apply_header_style(ss, ws, color, end_col=4):
    ss.batch_update({"requests": [
        {"repeatCell": {
            "range": {
                "sheetId": ws.id,
                "startRowIndex": 0, "endRowIndex": 1,
                "startColumnIndex": 0, "endColumnIndex": end_col,
            },
            "cell": {"userEnteredFormat": {
                "textFormat": {"bold": True, "foregroundColor": {"red": 1.0, "green": 1.0, "blue": 1.0}},
                "backgroundColor": color,
            }},
            "fields": "userEnteredFormat(textFormat,backgroundColor)",
        }}
    ]})


def _api_call_with_retry(fn, max_retries=5):
    """429レート制限時にリトライする"""
    for attempt in range(max_retries):
        try:
            return fn()
        except gspread.exceptions.APIError as e:
            if "429" in str(e) and attempt < max_retries - 1:
                wait = 15 * (attempt + 1)
                print(f"  ⏳ レート制限 (429)、{wait}秒待機... (試行{attempt+1}/{max_retries})")
                time.sleep(wait)
            else:
                raise


def _apply_run_header_style(ss, ws, col_idx):
    """実行日時ヘッダーセルをスタイル"""
    _api_call_with_retry(lambda: ss.batch_update({"requests": [
        {"repeatCell": {
            "range": {
                "sheetId": ws.id,
                "startRowIndex": 0, "endRowIndex": 1,
                "startColumnIndex": col_idx, "endColumnIndex": col_idx + 1,
            },
            "cell": {"userEnteredFormat": {
                "textFormat": {"bold": True},
                "backgroundColor": {"red": 0.85, "green": 0.92, "blue": 0.83},
                "horizontalAlignment": "CENTER",
            }},
            "fields": "userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)",
        }}
    ]}))


def _col_idx_to_letter(idx: int) -> str:
    """0-indexedの列番号をA, B, ..., Z, AA, AB, ... に変換"""
    result = ""
    idx += 1  # 1-indexed
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        result = chr(65 + rem) + result
    return result


# ============================================================
# 動画アップロード & シートリンク更新
# ============================================================
def upload_videos(run_date: str = None) -> dict[str, str]:
    """
    reports/agent-*/videos/ 内の .webm を Drive にアップロードして
    (spec_name, case_no) -> drive_url マップを返す。

    Drive 構成:
      {DRIVE_FOLDER_ID}/
      └── {run_date}/         ← 例: 2026-03-14
          └── {spec_name}/    ← 例: fields
              └── {case_no}.webm
    """
    from googleapiclient.http import MediaFileUpload

    if not run_date:
        run_date = datetime.now().strftime("%Y-%m-%d")

    drive = get_drive_service()

    # ① 日付フォルダを取得 or 作成
    date_folder_id = _get_or_create_drive_folder(drive, run_date, DRIVE_FOLDER_ID)
    print(f"Drive日付フォルダ: {run_date} (id={date_folder_id})")

    # ② reports/agent-*/videos/**/*.webm を収集
    video_files = list(REPORTS_DIR.glob("agent-*/videos/**/*.webm"))
    # 指定日付のもののみ（ディレクトリ名に日付が含まれる）
    date_compact = run_date.replace("-", "")
    video_files = [v for v in video_files if date_compact in str(v)]

    print(f"アップロード対象動画: {len(video_files)}件")
    if not video_files:
        return {}

    # ③ spec別サブフォルダを作成してアップロード
    spec_folders: dict[str, str] = {}  # spec_name -> folder_id
    result_links: dict[str, str] = {}  # f"{spec}/{case_no}" -> drive_url

    for video_path in video_files:
        # ディレクトリ名からspec名とcase_noを解析
        # 例: fields（フィールド）-101-1-日時_デフォルト現在時刻設定-chromium
        dir_name = video_path.parent.name
        spec_name, case_no = _parse_video_dirname(dir_name)
        if not spec_name:
            continue

        # specサブフォルダ
        if spec_name not in spec_folders:
            spec_folders[spec_name] = _get_or_create_drive_folder(drive, spec_name, date_folder_id)
            time.sleep(0.5)

        # ファイル名: {case_no}.webm
        upload_name = f"{case_no}.webm" if case_no else video_path.name
        file_meta = {"name": upload_name, "parents": [spec_folders[spec_name]]}

        # 既存チェック（同名ファイルがあればスキップ）
        existing = drive.files().list(
            q=f"name='{upload_name}' and '{spec_folders[spec_name]}' in parents and trashed=false",
            fields="files(id)"
        ).execute().get("files", [])

        if existing:
            file_id = existing[0]["id"]
        else:
            media = MediaFileUpload(str(video_path), mimetype="video/webm", resumable=True)
            uploaded = drive.files().create(body=file_meta, media_body=media, fields="id").execute()
            file_id = uploaded["id"]
            print(f"  ✅ アップロード: {spec_name}/{upload_name}")

        drive_url = f"https://drive.google.com/file/d/{file_id}/view"
        key = f"{spec_name}/{case_no}" if case_no else f"{spec_name}/{upload_name}"
        result_links[key] = drive_url

    print(f"アップロード完了: {len(result_links)}件")
    date_folder_url = f"https://drive.google.com/drive/folders/{date_folder_id}"
    print(f"フォルダURL: {date_folder_url}")
    return result_links


def _get_or_create_drive_folder(drive, name: str, parent_id: str) -> str:
    """指定名のDriveフォルダを取得 or 作成してIDを返す"""
    q = (f"name='{name}' and '{parent_id}' in parents "
         f"and mimeType='application/vnd.google-apps.folder' and trashed=false")
    result = drive.files().list(q=q, fields="files(id)").execute()
    if result["files"]:
        return result["files"][0]["id"]
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder", "parents": [parent_id]}
    created = drive.files().create(body=meta, fields="id").execute()
    return created["id"]


def _parse_video_dirname(dir_name: str) -> tuple[str, str]:
    """
    Playwrightが生成するビデオディレクトリ名からspec名とcase_noを解析する。
    例: 'fields（フィールド）-101-1-日時の現在時刻設定-chromium'
         → ('fields', '101-1')
    例: 'reports-帳票（登録）-236-帳票設定で-chromium'
         → ('reports', '236')
    """
    # -chromium 末尾を除去
    name = re.sub(r'-chromium$', '', dir_name)

    # specタブ名でマッチ（長い名前を優先するためソート）
    for spec_name in sorted(SPEC_TAB_NAMES.keys(), key=len, reverse=True):
        prefix = spec_name.replace("-", "[-−]?")
        if re.match(rf"{prefix}", name, re.IGNORECASE):
            # spec名以降の文字列からcase_no（数字ハイフン数字）を探す
            rest = name[len(spec_name):]
            case_m = re.search(r'[-−](\d+(?:[-−]\d+)*)', rest)
            if case_m:
                case_no = case_m.group(1).replace('−', '-')
                return spec_name, case_no
            return spec_name, ""
    return "", ""


def update_sheet_video_links(ss: gspread.Spreadsheet, run_label: str, video_links: dict[str, str]):
    """シートのfailedセルの隣に動画リンクを書き込む"""
    for spec_name in SPEC_ORDER:
        tab_name = SPEC_TAB_NAMES[spec_name]
        spec_videos = {k.split("/", 1)[1]: v for k, v in video_links.items()
                       if k.startswith(f"{spec_name}/")}
        if not spec_videos:
            continue

        try:
            ws = ss.worksheet(tab_name)
        except gspread.WorksheetNotFound:
            continue

        all_values = _api_call_with_retry(lambda: ws.get_all_values())
        header_row = all_values[0] if all_values else []

        # run_labelの列を探す（ステータス列）
        if run_label not in header_row:
            continue
        status_col_idx = header_row.index(run_label)
        video_col_idx = status_col_idx + 1
        video_col_letter = _col_idx_to_letter(video_col_idx)

        # ヘッダーに「動画」を追加（まだなければ）
        if len(header_row) <= video_col_idx or header_row[video_col_idx] != "動画":
            _api_call_with_retry(lambda: ws.update(
                values=[["動画"]], range_name=f"{video_col_letter}1"
            ))

        # case_no → 行番号
        case_to_row = {}
        for row_i, row in enumerate(all_values[1:], start=2):
            if row and row[0]:
                case_to_row[row[0]] = row_i

        updates = []
        for case_no, url in spec_videos.items():
            row_num = case_to_row.get(case_no)
            if not row_num:
                continue
            updates.append({
                "range": f"'{tab_name}'!{video_col_letter}{row_num}",
                "values": [[f'=HYPERLINK("{url}","▶")']],
            })

        if updates:
            _api_call_with_retry(lambda u=updates: ss.values_batch_update({
                "valueInputOption": "USER_ENTERED",
                "data": u,
            }))
            time.sleep(1)
            print(f"  🎬 {tab_name}: {len(updates)}件の動画リンク追加")


# ============================================================
# エントリーポイント
# ============================================================
def do_auth():
    """OAuth2ユーザー認証を実行してトークンを保存する（初回のみ）"""
    if not OAUTH_CLIENT_PATH.exists():
        print(f"❌ {OAUTH_CLIENT_PATH} が見つかりません")
        print()
        print("以下の手順で作成してください:")
        print("1. https://console.cloud.google.com/apis/credentials?project=pigeoncloud")
        print("2. 「認証情報を作成」→「OAuth 2.0 クライアント ID」")
        print("3. アプリの種類: デスクトップアプリ")
        print("4. ダウンロードした JSON を secrets/oauth_client.json として保存")
        return

    from google_auth_oauthlib.flow import InstalledAppFlow
    flow = InstalledAppFlow.from_client_secrets_file(str(OAUTH_CLIENT_PATH), SCOPES)
    creds = flow.run_local_server(port=0)
    USER_TOKEN_PATH.write_text(creds.to_json())
    print(f"✅ 認証完了: {USER_TOKEN_PATH} に保存しました")
    print("次回から --push-run で自動的にユーザー認証が使用されます")


def fix_summary_header():
    """既存のsummaryタブを縦型レイアウトに再構築する（A列にspec名を書き込み直す）"""
    now = datetime.now()
    ss = get_or_create_monthly_sheet(now.year, now.month)
    try:
        ws = ss.worksheet("summary")
    except gspread.WorksheetNotFound:
        ws = ss.add_worksheet("summary", rows=200, cols=100)

    # A列を新レイアウトで書き込み
    _init_summary_tab(ws)

    # A列（spec名列）をスタイル
    total_rows = 1 + len(SPEC_ORDER) + 1 + 3 + 1  # ヘッダー + specs + 空行 + 3合計 + 失敗テスト
    _api_call_with_retry(lambda: ss.batch_update({"requests": [{
        "repeatCell": {
            "range": {"sheetId": ws.id, "startRowIndex": 0, "endRowIndex": total_rows,
                      "startColumnIndex": 0, "endColumnIndex": 1},
            "cell": {"userEnteredFormat": {
                "backgroundColor": SUMMARY_HEADER_COLOR,
                "textFormat": {"bold": True, "foregroundColor": {"red": 1, "green": 1, "blue": 1}},
            }},
            "fields": "userEnteredFormat(backgroundColor,textFormat)",
        }
    }]}))

    print(f"✅ summaryタブ縦型レイアウトに更新完了（A列: spec名 / B列〜: 実行回）")


def cleanup_run_columns():
    """全タブで最後の実行列以外をすべて削除する。

    specタブ: 固定列(A-D=index 0-3)以降の実行列のうち、最後の1列だけ残す。
    summaryタブ: 固定列(A=index 0)以降の実行列のうち、最後の1列だけ残す。
    """
    now = datetime.now()
    ss = get_or_create_monthly_sheet(now.year, now.month)

    def _delete_columns_except_last(ws, fixed_cols: int):
        """固定列の後ろに実行列が複数ある場合、最後の1列以外を削除する。
        fixed_cols: 固定列数（specタブ=4, summaryタブ=1）
        """
        all_values = _api_call_with_retry(lambda: ws.get_all_values())
        header_row = all_values[0] if all_values else []
        run_cols = len(header_row) - fixed_cols  # 実行列の数

        if run_cols <= 1:
            print(f"    {ws.title}: 実行列 {run_cols}件 → スキップ")
            return

        # 削除する列数: run_cols - 1（最後以外）
        # 右から左に向かって削除（インデックスがずれないように）
        delete_count = run_cols - 1
        # fixed_cols〜fixed_cols+delete_count-1 を削除
        # = startIndex: fixed_cols, endIndex: fixed_cols + delete_count
        _api_call_with_retry(lambda: ss.batch_update({"requests": [{
            "deleteDimension": {
                "range": {
                    "sheetId": ws.id,
                    "dimension": "COLUMNS",
                    "startIndex": fixed_cols,
                    "endIndex": fixed_cols + delete_count,
                }
            }
        }]}))
        time.sleep(2)
        print(f"    {ws.title}: {delete_count}列削除（実行列 {run_cols}→1）")

    # specタブ（固定列=4）
    for spec_name in SPEC_ORDER:
        tab_name = SPEC_TAB_NAMES[spec_name]
        try:
            ws = ss.worksheet(tab_name)
        except gspread.WorksheetNotFound:
            print(f"    {tab_name}: タブなし → スキップ")
            continue
        _delete_columns_except_last(ws, fixed_cols=4)

    # summaryタブ（固定列=1）
    try:
        ws = ss.worksheet("summary")
        _delete_columns_except_last(ws, fixed_cols=1)
    except gspread.WorksheetNotFound:
        print("    summary: タブなし → スキップ")

    print(f"\n✅ クリーンアップ完了（最後の実行列のみ残しました）")


def rebuild_as_first_run():
    """全specタブの実行列・summaryタブ・n回目テストレポートタブを全削除し、
    現在のresults.jsonを「1回目」として書き直す。"""
    now = datetime.now()
    ss = get_or_create_monthly_sheet(now.year, now.month)
    client = get_gspread_client()
    ss = client.open_by_key(ss.id)  # 最新のシート情報を取得

    print("=== Step 1: 既存実行列・不要タブを全削除 ===")

    # specタブの実行列（E列以降）を全削除
    for spec_name in SPEC_ORDER:
        tab_name = SPEC_TAB_NAMES[spec_name]
        try:
            ws = ss.worksheet(tab_name)
        except gspread.WorksheetNotFound:
            print(f"  {tab_name}: タブなし → スキップ")
            continue

        all_values = _api_call_with_retry(lambda: ws.get_all_values())
        header_row = all_values[0] if all_values else []
        run_col_count = len(header_row) - 4  # 固定列4列以降が実行列
        if run_col_count > 0:
            _api_call_with_retry(lambda ws=ws, cnt=run_col_count: ss.batch_update({"requests": [{
                "deleteDimension": {
                    "range": {
                        "sheetId": ws.id,
                        "dimension": "COLUMNS",
                        "startIndex": 4,
                        "endIndex": 4 + cnt,
                    }
                }
            }]}))
            print(f"  {tab_name}: {run_col_count}列削除")
            time.sleep(1.5)
        else:
            print(f"  {tab_name}: 実行列なし → スキップ")

    # summaryタブ削除
    try:
        ws = ss.worksheet("summary")
        ss.del_worksheet(ws)
        print("  summaryタブ: 削除")
        time.sleep(1)
    except gspread.WorksheetNotFound:
        print("  summaryタブ: なし → スキップ")

    # n回目テストレポートタブを全削除
    worksheets = ss.worksheets()
    for ws in worksheets:
        if re.match(r'^\d+回目テストレポート$', ws.title):
            ss.del_worksheet(ws)
            print(f"  {ws.title}: 削除")
            time.sleep(1)

    print("\n=== Step 2: 1回目として書き直し ===")
    push_run()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="E2Eテスト結果 月次スプレッドシート管理")
    parser.add_argument("--auth",           action="store_true", help="OAuth2ユーザー認証（初回のみ）")
    parser.add_argument("--push-run",       action="store_true", help="最新結果を月次シートに追記")
    parser.add_argument("--fix-summary",    action="store_true", help="summaryタブのヘッダーを新形式に更新")
    parser.add_argument("--cleanup-tabs",   action="store_true", help="全タブの実行列を最後の1列以外削除")
    parser.add_argument("--rebuild",        action="store_true", help="全実行列・summaryタブを削除して1回目として書き直す")
    parser.add_argument("--merge-run",      action="store_true", help="失敗spec再実行結果を最終列にマージ（新列を作らない）")
    parser.add_argument("--failed-specs",   action="store_true", help="results.jsonから失敗specのリストを出力（Docker引数用）")
    parser.add_argument("--upload-videos",  action="store_true", help="動画をDriveにアップロードしてシートにリンク追加")
    parser.add_argument("--show-url",       action="store_true", help="今月のシートURLを表示")
    parser.add_argument("--dry-run",        action="store_true", help="内容確認のみ（書き込みなし）")
    parser.add_argument("--date",           default=None, help="動画対象日付 (YYYY-MM-DD、省略時は今日)")
    args = parser.parse_args()

    if args.failed_specs:
        specs = get_failed_specs()
        print(",".join(specs))
    elif args.merge_run:
        merge_run(dry_run=args.dry_run)
    elif args.rebuild:
        rebuild_as_first_run()
    elif args.cleanup_tabs:
        cleanup_run_columns()
    elif args.fix_summary:
        fix_summary_header()
    elif args.auth:
        do_auth()
    elif args.push_run:
        ss_id = push_run(dry_run=args.dry_run)
        # --push-run と同時に --upload-videos も指定された場合
        if args.upload_videos and ss_id and not args.dry_run:
            now = datetime.now()
            ss = get_gspread_client().open_by_key(ss_id)
            run_n = _get_run_number(ss)  # push_runで1タブ増えているので -1
            run_label = f"{run_n - 1}回目"
            video_links = upload_videos(args.date)
            if video_links:
                update_sheet_video_links(ss, run_label, video_links)
    elif args.upload_videos:
        now = datetime.now()
        run_date = args.date or now.strftime("%Y-%m-%d")
        ss = get_or_create_monthly_sheet(now.year, now.month)
        # 最新の実行回数を検出（最後のレポートタブ番号）
        run_n = _get_run_number(ss)
        run_label = f"{run_n - 1}回目"  # すでに書き込み済みの最後の回
        print(f"動画リンク対象: {run_label}")
        video_links = upload_videos(run_date)
        if video_links:
            update_sheet_video_links(ss, run_label, video_links)
    elif args.show_url:
        now = datetime.now()
        ss = get_or_create_monthly_sheet(now.year, now.month)
        print(f"https://docs.google.com/spreadsheets/d/{ss.id}")
    else:
        parser.print_help()
