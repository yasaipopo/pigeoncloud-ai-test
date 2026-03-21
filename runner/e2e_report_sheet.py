"""
E2Eテスト結果 月次スプレッドシート管理スクリプト

月ごとに1スプレッドシートを作成し、
・「テスト結果」タブ（1つ）に全spec・全ケースを記録（実行回ごとに列を追加）
・「n回目テストレポート」タブ（実行ごと）にサマリーを記録

使い方:
  python runner/e2e_report_sheet.py --auth              # 初回のみ: Googleログイン
  python runner/e2e_report_sheet.py --push-run          # 最新結果を月次シートに追記
  python runner/e2e_report_sheet.py --push-run --dry-run # 内容確認のみ（書き込みなし）
  python runner/e2e_report_sheet.py --show-url          # 今月のシートURLを表示
  python runner/e2e_report_sheet.py --rebuild           # テスト結果タブを作り直してから1回目として書き直す

認証の優先順位:
  1. secrets/user_token.json（OAuth2ユーザー認証・シート作成可能）
  2. gcloud ADC（Application Default Credentials）
  3. secrets/service_account.json（サービスアカウント）
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

# spec名 → 表示名（テストレポートタブ用）
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

# テスト結果タブ名
RESULTS_TAB = "テスト結果"
# 固定列数: A=spec, B=case_no, C=feature, D=description（手順）, E=expected（期待結果）
RESULTS_FIXED_COLS = 5

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
# ============================================================
def get_credentials():
    """最適な認証情報を返す"""
    if USER_TOKEN_PATH.exists():
        from google.oauth2.credentials import Credentials as OAuthCreds
        from google.auth.transport.requests import Request
        creds = OAuthCreds.from_authorized_user_file(str(USER_TOKEN_PATH), SCOPES)
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            USER_TOKEN_PATH.write_text(creds.to_json())
        print("認証: OAuth2ユーザートークン使用", file=sys.stderr)
        return creds

    try:
        import google.auth
        creds, project = google.auth.default(scopes=SCOPES)
        print(f"認証: gcloud ADC使用（project={project}）", file=sys.stderr)
        return creds
    except Exception:
        pass

    from google.oauth2.service_account import Credentials as SACreds
    print("認証: サービスアカウント使用", file=sys.stderr)
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


def _normalize_result_map(result_map: dict[str, str]) -> dict[str, str]:
    """uncategorized-2/3 を uncategorized に正規化してマージする"""
    normalized = {}
    for key, status in result_map.items():
        if "/" not in key:
            normalized[key] = status
            continue
        spec, case = key.split("/", 1)
        if spec in ("uncategorized-2", "uncategorized-3"):
            spec = "uncategorized"
        norm_key = f"{spec}/{case}"
        # passed が優先
        if norm_key not in normalized or status == "passed":
            normalized[norm_key] = status
    return normalized


# ============================================================
# 月次スプレッドシートの取得 or 作成
# ============================================================
def get_or_create_monthly_sheet(year: int, month: int) -> gspread.Spreadsheet:
    """月次スプレッドシートを取得、なければ作成してテスト結果タブを初期化する"""
    sheet_title = f"E2Eテスト結果_{year:04d}-{month:02d}"

    drive = get_drive_service()
    client = get_gspread_client()

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

    print(f"新規スプレッドシート作成: {sheet_title}")
    file_meta = {
        "name": sheet_title,
        "mimeType": "application/vnd.google-apps.spreadsheet",
        "parents": [DRIVE_FOLDER_ID],
    }
    created = drive.files().create(body=file_meta, fields="id").execute()
    ss_id = created["id"]
    ss = client.open_by_key(ss_id)

    # デフォルトシートを「テスト結果」にリネーム
    default_ws = ss.get_worksheet(0)
    default_ws.update_title(RESULTS_TAB)

    # テスト結果タブを初期化
    _init_results_tab(ss, default_ws)

    print(f"スプレッドシート作成完了: https://docs.google.com/spreadsheets/d/{ss_id}")
    return ss


def _init_results_tab(ss: gspread.Spreadsheet, ws: gspread.Worksheet):
    """テスト結果タブを全spec・全caseで初期化する。
    構成:
      A: spec, B: case_no, C: feature, D: description（手順）, E: expected（期待結果）
      F+: 実行回ごとの結果（1回目, 2回目, ...）
    """
    headers = ["spec", "case_no", "feature", "description（手順）", "expected（期待結果）"]

    # 全specの全caseを収集
    all_rows = []
    for spec_name in SPEC_ORDER:
        cases = load_spec_cases(spec_name)
        for c in cases:
            all_rows.append([
                spec_name,
                c["case_no"],
                c["feature"],
                c["description"],
                c["expected"],
            ])

    total_needed = len(all_rows) + 10
    # ワークシートをリサイズ
    _api_call_with_retry(lambda: ws.resize(rows=total_needed, cols=50))
    time.sleep(1)

    # ヘッダー・データ書き込み
    _api_call_with_retry(lambda: ws.update(values=[headers], range_name="A1"))
    if all_rows:
        # 大量データは分割して書き込み
        chunk_size = 500
        for i in range(0, len(all_rows), chunk_size):
            chunk = all_rows[i:i + chunk_size]
            start_row = i + 2  # 1-indexed, 1行目はヘッダー
            _api_call_with_retry(lambda c=chunk, r=start_row: ws.update(
                values=c, range_name=f"A{r}"
            ))
            time.sleep(1)

    # フリーズ・スタイル
    ws.freeze(rows=1, cols=RESULTS_FIXED_COLS)
    _apply_header_style(ss, ws, HEADER_COLOR, end_col=RESULTS_FIXED_COLS)

    # 列幅調整
    _api_call_with_retry(lambda: ss.batch_update({"requests": [
        {"updateDimensionProperties": {
            "range": {"sheetId": ws.id, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 1},
            "properties": {"pixelSize": 160}, "fields": "pixelSize"
        }},
        {"updateDimensionProperties": {
            "range": {"sheetId": ws.id, "dimension": "COLUMNS", "startIndex": 1, "endIndex": 2},
            "properties": {"pixelSize": 90}, "fields": "pixelSize"
        }},
        {"updateDimensionProperties": {
            "range": {"sheetId": ws.id, "dimension": "COLUMNS", "startIndex": 2, "endIndex": 3},
            "properties": {"pixelSize": 140}, "fields": "pixelSize"
        }},
        {"updateDimensionProperties": {
            "range": {"sheetId": ws.id, "dimension": "COLUMNS", "startIndex": 3, "endIndex": 5},
            "properties": {"pixelSize": 220}, "fields": "pixelSize"
        }},
    ]}))

    print(f"  テスト結果タブ: {len(all_rows)}件 初期化完了")


# ============================================================
# テスト結果の追記
# ============================================================
def _get_run_number(ss: gspread.Spreadsheet) -> int:
    """既存の「n回目テストレポート」タブから次の実行回数を返す"""
    worksheets = ss.worksheets()
    max_n = 0
    for ws in worksheets:
        m = re.match(r'^(\d+)回目テストレポート$', ws.title)
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

    # uncategorized-2/3 を uncategorized に正規化
    result_map = _normalize_result_map(result_map)
    print(f"結果件数: {len(result_map)}件（正規化後）")

    if dry_run:
        print("[DRY RUN] 実際には書き込みません")
        total_p = sum(1 for s in result_map.values() if s == "passed")
        total_f = sum(1 for s in result_map.values() if s == "failed")
        total_s = sum(1 for s in result_map.values() if s in ("skipped", "skip", "todo"))
        print(f"  → passed={total_p} failed={total_f} skipped={total_s}")
        return

    ss = get_or_create_monthly_sheet(year, month)
    run_n = _get_run_number(ss)
    run_label = f"{run_n}回目"
    print(f"実行回数: {run_label} ({now.strftime('%Y/%m/%d %H:%M')})")

    # テスト結果タブを取得（なければ作成）
    try:
        ws = ss.worksheet(RESULTS_TAB)
    except gspread.WorksheetNotFound:
        print(f"  テスト結果タブなし → 作成")
        ws = ss.add_worksheet(title=RESULTS_TAB, rows=1700, cols=50)
        _init_results_tab(ss, ws)

    all_values = _api_call_with_retry(lambda: ws.get_all_values())
    header_row = all_values[0] if all_values else []

    if run_label in header_row:
        print(f"  ⏭ {run_label} は書き込み済み、スキップ")
        return

    # 次の列インデックス
    next_col_idx = max(len(header_row), RESULTS_FIXED_COLS)
    next_col_letter = _col_idx_to_letter(next_col_idx)

    # ヘッダー行に実行ラベルを追加
    _api_call_with_retry(lambda: ws.update(
        values=[[run_label]], range_name=f"{next_col_letter}1"
    ))

    # case_to_row: "spec/case_no" → row_num (2-indexed)
    case_to_row = {}
    for row_i, row in enumerate(all_values[1:], start=2):
        if len(row) >= 2 and row[0] and row[1]:
            key = f"{row[0]}/{row[1]}"
            case_to_row[key] = row_i

    # ステータス書き込み
    value_updates = []
    color_requests = []
    total_passed = total_failed = total_skipped = 0
    failed_links = []
    spec_stats = {s: {"passed": 0, "failed": 0, "skipped": 0, "total": 0} for s in SPEC_ORDER}
    ss_url = f"https://docs.google.com/spreadsheets/d/{ss.id}"

    for spec_name in SPEC_ORDER:
        cases = load_spec_cases(spec_name)
        for c in cases:
            case_no = c["case_no"]
            key = f"{spec_name}/{case_no}"
            status = result_map.get(key, "")
            row_num = case_to_row.get(key)

            if not row_num:
                continue

            spec_stats[spec_name]["total"] += 1

            if not status:
                continue

            cell_ref = f"{next_col_letter}{row_num}"
            value_updates.append({
                "range": f"'{RESULTS_TAB}'!{cell_ref}",
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
                spec_stats[spec_name]["passed"] += 1
            elif status == "failed":
                total_failed += 1
                spec_stats[spec_name]["failed"] += 1
                link = f"{ss_url}/edit#gid={ws.id}&range={cell_ref}"
                failed_links.append((f"{spec_name}/{case_no}（{c['feature'][:15]}）", link))
            elif status in ("skipped", "skip", "todo"):
                total_skipped += 1
                spec_stats[spec_name]["skipped"] += 1

    # 一括書き込み（100件ずつ分割）
    if value_updates:
        for i in range(0, len(value_updates), 100):
            _api_call_with_retry(lambda batch=value_updates[i:i + 100]: ss.values_batch_update({
                "valueInputOption": "USER_ENTERED",
                "data": batch,
            }))
            time.sleep(1)

    # 色適用（50件ずつ）
    if color_requests:
        for i in range(0, len(color_requests), 50):
            _api_call_with_retry(lambda batch=color_requests[i:i + 50]: ss.batch_update({"requests": batch}))
            time.sleep(1)

    _apply_run_header_style(ss, ws, next_col_idx)

    print(f"  ✅ テスト結果タブ: {len(value_updates)}件書き込み完了")

    # n回目テストレポートタブ作成
    _create_run_report_tab(ss, run_n, now, total_passed, total_failed, total_skipped, spec_stats, failed_links)

    print(f"\n📊 実行結果サマリー: passed={total_passed} failed={total_failed} skipped={total_skipped}")
    print(f"🔗 シートURL: https://docs.google.com/spreadsheets/d/{ss.id}")
    return ss.id


def get_failed_specs() -> list[str]:
    """results.jsonから失敗があるspec名のリストを返す"""
    result_map = load_results()
    failing = set()
    for key, status in result_map.items():
        if status == "failed":
            spec_name = key.split("/")[0]
            failing.add(spec_name)
    return sorted(failing)


def merge_run(dry_run: bool = False):
    """失敗specだけ再実行した結果を既存の最終列にマージして上書きする。
    新しい列は作らず、n回目テストレポートタブを更新する。
    """
    now = datetime.now()
    year, month = now.year, now.month

    result_map = load_results()
    if not result_map:
        print("結果データがありません")
        return

    result_map = _normalize_result_map(result_map)
    updated_specs = {k.split("/")[0] for k in result_map}
    print(f"マージ対象spec: {', '.join(sorted(updated_specs))}")
    print(f"結果件数: {len(result_map)}件")

    if dry_run:
        print("[DRY RUN]")
        return

    ss = get_or_create_monthly_sheet(year, month)
    run_n = _get_run_number(ss) - 1
    if run_n < 1:
        print("⚠️ 既存のテストレポートタブが見つかりません。--push-run を先に実行してください。")
        return
    run_label = f"{run_n}回目"
    print(f"マージ先: {run_label}")

    try:
        ws = ss.worksheet(RESULTS_TAB)
    except gspread.WorksheetNotFound:
        print("テスト結果タブが見つかりません")
        return

    all_values = _api_call_with_retry(lambda: ws.get_all_values())
    header_row = all_values[0] if all_values else []

    if run_label not in header_row:
        print(f"⚠️ {run_label}列が見つかりません → スキップ")
        return
    col_idx = header_row.index(run_label)
    col_letter = _col_idx_to_letter(col_idx)

    # case_to_row & current_status
    case_to_row = {}
    current_status = {}
    for row_i, row in enumerate(all_values[1:], start=2):
        if len(row) >= 2 and row[0] and row[1]:
            key = f"{row[0]}/{row[1]}"
            case_to_row[key] = row_i
            current_status[key] = row[col_idx] if len(row) > col_idx else ""

    value_updates = []
    color_requests = []

    for key, new_status in result_map.items():
        row_num = case_to_row.get(key)
        if not row_num:
            continue
        old_status = current_status.get(key, "")
        if old_status == new_status:
            continue

        cell_ref = f"{col_letter}{row_num}"
        value_updates.append({
            "range": f"'{RESULTS_TAB}'!{cell_ref}",
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
        for i in range(0, len(value_updates), 100):
            _api_call_with_retry(lambda batch=value_updates[i:i + 100]: ss.values_batch_update({
                "valueInputOption": "USER_ENTERED",
                "data": batch,
            }))
            time.sleep(1)
    if color_requests:
        for i in range(0, len(color_requests), 50):
            _api_call_with_retry(lambda batch=color_requests[i:i + 50]: ss.batch_update({"requests": batch}))
            time.sleep(0.5)

    print(f"  ✅ {len(value_updates)}件更新（マージ）")

    # マージ後の最終ステータスで統計再集計
    total_passed = total_failed = total_skipped = 0
    full_spec_stats = {}
    failed_links = []
    ss_url = f"https://docs.google.com/spreadsheets/d/{ss.id}"

    for spec_name in SPEC_ORDER:
        cases = load_spec_cases(spec_name)
        sp = sf = sc = 0
        for c in cases:
            case_no = c["case_no"]
            key = f"{spec_name}/{case_no}"
            if key in result_map:
                status = result_map[key]
            else:
                status = _normalize_status(current_status.get(key, ""))
            row_num = case_to_row.get(key)

            if status == "passed":
                total_passed += 1; sp += 1
            elif status == "failed":
                total_failed += 1; sf += 1
                if row_num:
                    link = f"{ss_url}/edit#gid={ws.id}&range={col_letter}{row_num}"
                    failed_links.append((f"{spec_name}/{case_no}（{c['feature'][:15]}）", link))
            elif status in ("skipped", "skip", "todo"):
                total_skipped += 1; sc += 1
        full_spec_stats[spec_name] = {"passed": sp, "failed": sf, "skipped": sc, "total": len(cases)}

    _create_run_report_tab(ss, run_n, now, total_passed, total_failed, total_skipped, full_spec_stats, failed_links)

    print(f"\n📊 マージ後の結果: passed={total_passed} failed={total_failed} skipped={total_skipped}")
    print(f"🔗 シートURL: https://docs.google.com/spreadsheets/d/{ss.id}")
    return ss.id


# ============================================================
# n回目テストレポートタブ
# ============================================================
def _generate_analysis(spec_stats: dict, passed: int, failed: int, skipped: int, total: int) -> list[str]:
    """失敗パターンを分析してテキスト行のリストを返す"""
    lines = []
    pass_rate = passed / total * 100 if total > 0 else 0

    if pass_rate >= 90:
        overall = f"✅ 良好  合格率 {pass_rate:.1f}%（{passed}/{total}件）"
    elif pass_rate >= 75:
        overall = f"⚠️ 要改善  合格率 {pass_rate:.1f}%（{passed}/{total}件）"
    else:
        overall = f"❌ 要対応  合格率 {pass_rate:.1f}%（{passed}/{total}件）"
    lines.append(overall)
    lines.append("")

    failing = [(n, st) for n, st in spec_stats.items() if st.get("failed", 0) > 0]
    failing.sort(key=lambda x: x[1]["failed"], reverse=True)

    if failing:
        lines.append("【失敗が多いspec（上位）】")
        for spec_name, st in failing[:6]:
            tab_display = SPEC_TAB_NAMES.get(spec_name, spec_name)
            f_pct = st["failed"] / st["total"] * 100 if st["total"] > 0 else 0
            lines.append(f"  {tab_display}:  {st['failed']}件失敗  （失敗率 {f_pct:.0f}%）")
        lines.append("")

    lines.append("【推定される失敗原因】")
    causes = []

    auth_failed = spec_stats.get("auth", {}).get("failed", 0)
    if auth_failed > 0:
        causes.append(f"  ・認証系失敗 {auth_failed}件: アカウントロック or ログイン設定の問題。")

    up_failed = spec_stats.get("users-permissions", {}).get("failed", 0)
    if up_failed > 0:
        causes.append(f"  ・ユーザー権限系失敗 {up_failed}件: URLルーティング変更の可能性。")

    notif_failed = spec_stats.get("notifications", {}).get("failed", 0)
    if notif_failed > 0:
        causes.append(f"  ・通知系失敗 {notif_failed}件: SMTP設定またはメール受信タイムアウトの可能性。")

    unc_failed = spec_stats.get("uncategorized", {}).get("failed", 0)
    if unc_failed > 0:
        causes.append(f"  ・未分類テスト失敗 {unc_failed}件: セレクター変更・タイムアウト・UI変更など。")

    fields_failed = spec_stats.get("fields", {}).get("failed", 0)
    if fields_failed > 0:
        causes.append(f"  ・フィールド系失敗 {fields_failed}件: ALLテストテーブルが存在しない場合に発生。")

    chart_failed = spec_stats.get("chart-calendar", {}).get("failed", 0)
    if chart_failed > 0:
        causes.append(f"  ・チャート/カレンダー失敗 {chart_failed}件: グラフ描画タイミングの問題。")

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

    if skipped > 0:
        skip_pct = skipped / total * 100
        lines.append("【スキップ分析】")
        lines.append(f"  スキップ {skipped}件（{skip_pct:.1f}%）: 外部サービス未設定・環境制約など。")
        lines.append("")

    lines.append("【推奨アクション】")
    recs = []
    if auth_failed > 0:
        recs.append("  1. IS_PRODUCTION ガード確認 → 次回実行で改善されるか確認")
    if up_failed > 0:
        recs.append("  2. users-permissions.spec.js: URL修正確認")
    if unc_failed > 10:
        recs.append("  3. uncategorized: 動画リンクで失敗内容を個別確認 → spec修正 or プロダクトバグとして起票")
    if fields_failed > 0 or chart_failed > 0:
        recs.append("  4. フィールド/チャート系: beforeAllでcreate-all-type-tableを統一")
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
    """n回目テストレポートタブを作成・更新する"""
    tab_name = f"{run_n}回目テストレポート"
    total = passed + failed + skipped
    pass_rate_pct = passed / total * 100 if total > 0 else 0
    pass_rate = f"{pass_rate_pct:.1f}%" if total > 0 else "-"
    fail_rate = f"{failed/total*100:.1f}%" if total > 0 else "-"
    skip_rate = f"{skipped/total*100:.1f}%" if total > 0 else "-"

    analysis_lines = _generate_analysis(spec_stats, passed, failed, skipped, total)

    # 既存なら削除して再作成
    try:
        ss.del_worksheet(ss.worksheet(tab_name))
    except gspread.WorksheetNotFound:
        pass

    total_rows = 30 + len(SPEC_ORDER) + len(failed_links) + len(analysis_lines) + 20
    ws = ss.add_worksheet(title=tab_name, rows=total_rows, cols=8)

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
    R_SPEC_LABEL   = 11
    R_SPEC_START   = 12
    R_SPEC_END     = R_SPEC_START + len(SPEC_ORDER) - 1
    R_BLANK3       = R_SPEC_END + 1
    R_FAIL_HDR     = R_BLANK3 + 1
    R_FAIL_LABEL   = R_FAIL_HDR + 1
    R_FAIL_START   = R_FAIL_LABEL + 1
    R_FAIL_END     = R_FAIL_START + max(len(failed_links) - 1, 0)
    R_BLANK4       = R_FAIL_END + 1
    R_ANALYSIS_HDR = R_BLANK4 + 1
    R_ANALYSIS_START = R_ANALYSIS_HDR + 1

    p_ = f"'{tab_name}'!"
    batch_data = []

    batch_data.append({
        "range": f"{p_}A{R_TITLE}:H{R_TITLE}",
        "values": [[f"{'　' * 5}{run_n}回目 テスト実行レポート", "", "", "", "", "", "", ""]],
    })
    batch_data.append({
        "range": f"{p_}A{R_DATETIME}",
        "values": [[f"実行日時：{run_datetime.strftime('%Y/%m/%d  %H:%M')}"]],
    })
    batch_data.append({
        "range": f"{p_}A{R_SUMMARY_HDR}",
        "values": [["■ 総合結果"]],
    })
    batch_data.append({
        "range": f"{p_}A{R_TOTAL}:H{R_SKIPPED}",
        "values": [
            ["", "合計",   total,  "件", "",  "",   "",    ""],
            ["", "✅ 成功", passed, "件", pass_rate, "", "", ""],
            ["", "❌ 失敗", failed, "件", fail_rate, "", "", ""],
            ["", "⏭ スキップ", skipped, "件", skip_rate, "", "", ""],
        ],
    })
    batch_data.append({
        "range": f"{p_}A{R_SPEC_HDR}",
        "values": [["■ spec別結果"]],
    })
    batch_data.append({
        "range": f"{p_}A{R_SPEC_LABEL}:F{R_SPEC_LABEL}",
        "values": [["spec名", "合計", "✅ 成功", "❌ 失敗", "⏭ スキップ", "判定"]],
    })

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
    batch_data.append({
        "range": f"{p_}A{R_FAIL_HDR}",
        "values": [["■ 失敗テスト一覧"]],
    })
    batch_data.append({
        "range": f"{p_}A{R_FAIL_LABEL}:C{R_FAIL_LABEL}",
        "values": [["テストケース", "機能名", "シートリンク"]],
    })
    batch_data.append({
        "range": f"{p_}A{R_ANALYSIS_HDR}",
        "values": [["■ 分析・総括"]],
    })
    if analysis_lines:
        batch_data.append({
            "range": f"{p_}A{R_ANALYSIS_START}:D{R_ANALYSIS_START + len(analysis_lines) - 1}",
            "values": [[line, "", "", ""] for line in analysis_lines],
        })

    _api_call_with_retry(lambda: ss.values_batch_update({
        "valueInputOption": "USER_ENTERED",
        "data": batch_data,
    }))

    if failed_links:
        link_rows = []
        for name, url in failed_links:
            parts = name.split("（", 1)
            case_part = parts[0].strip()
            feat_part = parts[1].rstrip("）") if len(parts) > 1 else ""
            link_rows.append([case_part, feat_part, f'=HYPERLINK("{url}","▶ 確認")'])
        _api_call_with_retry(lambda: ss.values_batch_update({
            "valueInputOption": "USER_ENTERED",
            "data": [{
                "range": f"{p_}A{R_FAIL_START}:C{R_FAIL_START + len(link_rows) - 1}",
                "values": link_rows,
            }],
        }))

    # スタイル
    sheet_id = ws.id
    style_requests = []

    def _rgb(r, g, b):
        return {"red": r, "green": g, "blue": b}

    def _cell_style(start_row, end_row, start_col, end_col, bg=None, bold=False,
                    font_size=None, fg=None, halign=None, valign=None):
        fmt = {}
        if bg:
            fmt["backgroundColor"] = bg
        tf = {}
        if bold: tf["bold"] = True
        if font_size: tf["fontSize"] = font_size
        if fg: tf["foregroundColor"] = fg
        if tf: fmt["textFormat"] = tf
        if halign: fmt["horizontalAlignment"] = halign
        if valign: fmt["verticalAlignment"] = valign
        fields = "userEnteredFormat(" + ",".join(
            (["backgroundColor"] if bg else []) +
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

    style_requests.append(_cell_style(R_TITLE, R_TITLE + 1, 0, 8,
        bg=_rgb(0.18, 0.35, 0.67), bold=True, font_size=14,
        fg=_rgb(1, 1, 1), halign="CENTER", valign="MIDDLE"))
    style_requests.append(_cell_style(R_DATETIME, R_DATETIME + 1, 0, 8,
        bg=_rgb(0.85, 0.90, 0.98)))
    for r in [R_SUMMARY_HDR, R_SPEC_HDR, R_FAIL_HDR, R_ANALYSIS_HDR]:
        style_requests.append(_cell_style(r, r + 1, 0, 8,
            bg=_rgb(0.25, 0.45, 0.75), bold=True, fg=_rgb(1, 1, 1)))
    style_requests.append(_cell_style(R_TOTAL, R_TOTAL + 1, 0, 8, bg=_rgb(0.95, 0.95, 0.95)))
    style_requests.append(_cell_style(R_PASSED, R_PASSED + 1, 0, 8, bg=_rgb(0.71, 0.88, 0.80)))
    style_requests.append(_cell_style(R_FAILED, R_FAILED + 1, 0, 8,
        bg=_rgb(0.96, 0.78, 0.76) if failed > 0 else _rgb(0.95, 0.95, 0.95)))
    style_requests.append(_cell_style(R_SKIPPED, R_SKIPPED + 1, 0, 8, bg=_rgb(0.99, 0.91, 0.70)))
    style_requests.append(_cell_style(R_SPEC_LABEL, R_SPEC_LABEL + 1, 0, 6,
        bg=_rgb(0.20, 0.40, 0.80), bold=True, fg=_rgb(1, 1, 1), halign="CENTER"))
    for i, spec_name in enumerate(SPEC_ORDER):
        row = R_SPEC_START + i
        st = spec_stats.get(spec_name)
        row_bg = _rgb(0.90, 0.97, 0.93) if (st and st["failed"] == 0) else _rgb(1.0, 0.93, 0.92)
        style_requests.append(_cell_style(row, row + 1, 0, 6, bg=row_bg))
    style_requests.append(_cell_style(R_FAIL_LABEL, R_FAIL_LABEL + 1, 0, 3,
        bg=_rgb(0.20, 0.40, 0.80), bold=True, fg=_rgb(1, 1, 1), halign="CENTER"))
    if failed_links:
        style_requests.append(_cell_style(R_FAIL_START, R_FAIL_START + len(failed_links), 0, 3,
            bg=_rgb(1.0, 0.94, 0.94)))
    if analysis_lines:
        for i, line in enumerate(analysis_lines):
            row = R_ANALYSIS_START + i
            if line.startswith("【") or line.startswith("■"):
                style_requests.append(_cell_style(row, row + 1, 0, 6, bg=_rgb(0.90, 0.93, 0.98), bold=True))
            elif line.startswith("✅"):
                style_requests.append(_cell_style(row, row + 1, 0, 6, bg=_rgb(0.88, 0.97, 0.91)))
            elif line.startswith("⚠️") or "要改善" in line:
                style_requests.append(_cell_style(row, row + 1, 0, 6, bg=_rgb(1.0, 0.97, 0.80)))
            elif line.startswith("❌"):
                style_requests.append(_cell_style(row, row + 1, 0, 6, bg=_rgb(1.0, 0.91, 0.91)))
            else:
                style_requests.append(_cell_style(row, row + 1, 0, 6, bg=_rgb(0.97, 0.97, 0.97)))

    _api_call_with_retry(lambda: ss.batch_update({"requests": style_requests}))

    # タイトル行セル結合
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
        {"updateDimensionProperties": {
            "range": {"sheetId": sheet_id, "dimension": "ROWS", "startIndex": R_TITLE - 1, "endIndex": R_TITLE},
            "properties": {"pixelSize": 50}, "fields": "pixelSize"
        }},
    ]}))

    print(f"  📋 {tab_name} タブ作成完了")


# ============================================================
# シートを作り直す
# ============================================================
def rebuild_as_first_run():
    """テスト結果タブを削除して再作成し、現在のresults.jsonを「1回目」として書き直す。"""
    now = datetime.now()
    ss = get_or_create_monthly_sheet(now.year, now.month)
    client = get_gspread_client()
    ss = client.open_by_key(ss.id)

    print("=== Step 1: テスト結果タブ・n回目テストレポートタブを全削除 ===")

    # テスト結果タブを完全削除（重複行対策のため再作成）
    try:
        ws = ss.worksheet(RESULTS_TAB)
        ss.del_worksheet(ws)
        print(f"  {RESULTS_TAB}: 削除")
        time.sleep(1)
    except gspread.WorksheetNotFound:
        pass

    # n回目テストレポートタブを全削除
    worksheets = ss.worksheets()
    for ws_item in worksheets:
        if re.match(r'^\d+回目テストレポート$', ws_item.title):
            ss.del_worksheet(ws_item)
            print(f"  {ws_item.title}: 削除")
            time.sleep(1)

    print("\n=== Step 2: テスト結果タブを新規作成 ===")
    # 新規作成（シートに1つもタブがない場合に備えてデフォルト処理）
    worksheets = ss.worksheets()
    if not worksheets:
        # シートが空の場合は新規追加
        new_ws = ss.add_worksheet(title=RESULTS_TAB, rows=1700, cols=50)
    else:
        # 既存の最初のシートをリネーム
        try:
            new_ws = ss.add_worksheet(title=RESULTS_TAB, rows=1700, cols=50)
        except Exception:
            new_ws = ss.get_worksheet(0)
            new_ws.update_title(RESULTS_TAB)

    _init_results_tab(ss, new_ws)

    print("\n=== Step 3: 1回目として書き直し ===")
    push_run()


# ============================================================
# スタイルヘルパー
# ============================================================
def _apply_header_style(ss, ws, color, end_col=5):
    _api_call_with_retry(lambda: ss.batch_update({"requests": [
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
    ]}))


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


def _col_idx_to_letter(idx: int) -> str:
    """0-indexedの列番号をA, B, ..., Z, AA, AB, ... に変換"""
    result = ""
    idx += 1
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        result = chr(65 + rem) + result
    return result


# ============================================================
# 動画アップロード（オプション）
# ============================================================
def upload_videos(run_date: str = None) -> dict[str, str]:
    """reports/agent-*/videos/ 内の .webm を Drive にアップロード"""
    from googleapiclient.http import MediaFileUpload

    if not run_date:
        run_date = datetime.now().strftime("%Y-%m-%d")

    drive = get_drive_service()
    date_folder_id = _get_or_create_drive_folder(drive, run_date, DRIVE_FOLDER_ID)
    print(f"Drive日付フォルダ: {run_date} (id={date_folder_id})")

    video_files = list(REPORTS_DIR.glob("agent-*/videos/**/*.webm"))
    date_compact = run_date.replace("-", "")
    video_files = [v for v in video_files if date_compact in str(v)]

    print(f"アップロード対象動画: {len(video_files)}件")
    if not video_files:
        return {}

    spec_folders: dict[str, str] = {}
    result_links: dict[str, str] = {}

    for video_path in video_files:
        dir_name = video_path.parent.name
        spec_name, case_no = _parse_video_dirname(dir_name)
        if not spec_name:
            continue

        if spec_name not in spec_folders:
            spec_folders[spec_name] = _get_or_create_drive_folder(drive, spec_name, date_folder_id)
            time.sleep(0.5)

        upload_name = f"{case_no}.webm" if case_no else video_path.name
        file_meta = {"name": upload_name, "parents": [spec_folders[spec_name]]}

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
    return result_links


def _get_or_create_drive_folder(drive, name: str, parent_id: str) -> str:
    q = (f"name='{name}' and '{parent_id}' in parents "
         f"and mimeType='application/vnd.google-apps.folder' and trashed=false")
    result = drive.files().list(q=q, fields="files(id)").execute()
    if result["files"]:
        return result["files"][0]["id"]
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder", "parents": [parent_id]}
    created = drive.files().create(body=meta, fields="id").execute()
    return created["id"]


def _parse_video_dirname(dir_name: str) -> tuple[str, str]:
    name = re.sub(r'-chromium$', '', dir_name)
    for spec_name in sorted(SPEC_TAB_NAMES.keys(), key=len, reverse=True):
        prefix = spec_name.replace("-", "[-−]?")
        if re.match(rf"{prefix}", name, re.IGNORECASE):
            rest = name[len(spec_name):]
            case_m = re.search(r'[-−](\d+(?:[-−]\d+)*)', rest)
            if case_m:
                case_no = case_m.group(1).replace('−', '-')
                return spec_name, case_no
            return spec_name, ""
    return "", ""


# ============================================================
# 認証
# ============================================================
def do_auth():
    if not OAUTH_CLIENT_PATH.exists():
        print(f"❌ {OAUTH_CLIENT_PATH} が見つかりません")
        return
    from google_auth_oauthlib.flow import InstalledAppFlow
    flow = InstalledAppFlow.from_client_secrets_file(str(OAUTH_CLIENT_PATH), SCOPES)
    creds = flow.run_local_server(port=0)
    USER_TOKEN_PATH.write_text(creds.to_json())
    print(f"✅ 認証完了: {USER_TOKEN_PATH}")


# ============================================================
# エントリーポイント
# ============================================================
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="E2Eテスト結果 月次スプレッドシート管理")
    parser.add_argument("--auth",           action="store_true", help="OAuth2ユーザー認証（初回のみ）")
    parser.add_argument("--push-run",       action="store_true", help="最新結果を月次シートに追記")
    parser.add_argument("--rebuild",        action="store_true", help="テスト結果タブを作り直してから1回目として書き直す")
    parser.add_argument("--merge-run",      action="store_true", help="失敗spec再実行結果を最終列にマージ（新列を作らない）")
    parser.add_argument("--failed-specs",   action="store_true", help="results.jsonから失敗specのリストを出力")
    parser.add_argument("--upload-videos",  action="store_true", help="動画をDriveにアップロード")
    parser.add_argument("--show-url",       action="store_true", help="今月のシートURLを表示")
    parser.add_argument("--dry-run",        action="store_true", help="内容確認のみ（書き込みなし）")
    parser.add_argument("--date",           default=None, help="動画対象日付 (YYYY-MM-DD)")
    args = parser.parse_args()

    if args.failed_specs:
        specs = get_failed_specs()
        print(",".join(specs))
    elif args.merge_run:
        merge_run(dry_run=args.dry_run)
    elif args.rebuild:
        rebuild_as_first_run()
    elif args.auth:
        do_auth()
    elif args.push_run:
        ss_id = push_run(dry_run=args.dry_run)
        if args.upload_videos and ss_id and not args.dry_run:
            now = datetime.now()
            ss = get_gspread_client().open_by_key(ss_id)
            run_n = _get_run_number(ss) - 1
            run_label = f"{run_n}回目"
            video_links = upload_videos(args.date)
    elif args.upload_videos:
        now = datetime.now()
        run_date = args.date or now.strftime("%Y-%m-%d")
        video_links = upload_videos(run_date)
    elif args.show_url:
        now = datetime.now()
        ss = get_or_create_monthly_sheet(now.year, now.month)
        print(f"https://docs.google.com/spreadsheets/d/{ss.id}")
    else:
        parser.print_help()
