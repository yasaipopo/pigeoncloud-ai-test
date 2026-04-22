"""
Spec品質チェッカー

tests/*.spec.js を厳密に評価し、テストが「実際にタイトルどおりのことをテストしているか」を
Google Sheetsに記録する。

使い方:
  python runner/spec_quality_checker.py records           # records.spec.jsをチェック
  python runner/spec_quality_checker.py records --push    # Sheetsに書き込み
  python runner/spec_quality_checker.py all --push        # 全specをチェックして書き込み
  python runner/spec_quality_checker.py records --claude  # Claude APIで深く分析（遅い）
"""

import sys
import os
import re
import json
import subprocess
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# 判定カテゴリ
# ---------------------------------------------------------------------------
VERDICT_REAL     = "✅ REAL"      # 本物のテスト（機能を正しく検証）
VERDICT_SHALLOW  = "⚠️ SHALLOW"   # 浅い（UI存在確認のみ・操作結果未検証）
VERDICT_SKIP     = "⚠️ SKIP"      # graceful passで実質未テスト
VERDICT_FAKE     = "❌ FAKE"      # タイトルと無関係・常にpass

CATEGORY_OK                = "OK"
CATEGORY_INCOMPLETE        = "INCOMPLETE"        # シナリオの一部しかテストしていない
CATEGORY_GRACEFUL_SKIP     = "GRACEFUL_SKIP"     # 早期returnでスキップしている
CATEGORY_SAME_AS_OTHER     = "SAME_AS_OTHER"     # 他テストと実質同一
CATEGORY_WRONG_TARGET      = "WRONG_TARGET"      # テスト対象が間違っている

# ---------------------------------------------------------------------------
# records.spec.js の手動解析結果
# （静的解析 + 実行ログ + Playwright実動作確認による）
# ---------------------------------------------------------------------------
RECORDS_ANALYSIS = [
    {
        "id": "143-01",
        "title": "レコード一覧にコメントアイコンが表示されること",
        "describe": "レコード操作（一覧・作成・編集・削除・一括編集）",
        "verdict": VERDICT_SHALLOW,
        "category": CATEGORY_INCOMPLETE,
        "line": 192,
        "reason": (
            "コメントAPIで投稿後にアイコン表示を確認するが、"
            "hover時の「件数・最新投稿時間」表示の検証がない（テスト名のスコープを満たしていない）。"
            "また `.fa-comment` 等の広いセレクタは他の要素にもマッチする可能性あり。"
        ),
        "fix": "commentIconのhover後にtooltip/popoverの内容（件数・時間）を検証すること。",
        "run_log": "コメントアイコン確認OK（5.3s）",
        "actual_behavior": "APIでコメント投稿→アイコン存在確認",
    },
    {
        "id": "167-1",
        "title": "チェックボックスをクリックすると一括削除ボタンが表示されること",
        "describe": "レコード操作（一覧・作成・編集・削除・一括編集）",
        "verdict": VERDICT_REAL,
        "category": CATEGORY_OK,
        "line": 269,
        "reason": "チェックボックスクリック→一括削除ボタン表示の一連フロー。適切なアサーション。",
        "fix": "",
        "run_log": "PASS (2.9s)",
        "actual_behavior": "checkbox.click() → bulkDeleteBtn.toBeVisible()",
    },
    {
        "id": "180-1",
        "title": "一括編集メニューが表示され、一括編集を実行できること",
        "describe": "レコード操作（一覧・作成・編集・削除・一括編集）",
        "verdict": VERDICT_SHALLOW,
        "category": CATEGORY_INCOMPLETE,
        "line": 299,
        "reason": (
            "「一括編集を実行できること」とタイトルにあるが、実際にはモーダルが開くことのみ確認。"
            "「項目を追加」→フィールド選択→値入力→実行→レコード変更確認まで行っていない。"
        ),
        "fix": "実際に一括編集を実行してレコードの値が変わることを検証すること。",
        "run_log": "PASS (2.5s)",
        "actual_behavior": "ハンバーガーメニュー→「一括編集」クリック→モーダル表示確認",
    },
    {
        "id": "180-2",
        "title": "権限のないデータが含まれる場合は一括編集がされないこと",
        "describe": "レコード操作（一覧・作成・編集・削除・一括編集）",
        "verdict": VERDICT_FAKE,
        "category": CATEGORY_SAME_AS_OTHER,
        "line": 345,
        "reason": (
            "「権限のないデータ」を作成せず、180-1と実質同一の操作のみ実施。"
            "一括編集モーダルが開くことしか検証していない。"
            "「一括編集がされないこと」（禁止の確認）を全くテストしていない。"
        ),
        "fix": (
            "権限制限のあるレコードを別ユーザーで作成し、"
            "管理者で一括編集しようとした際にエラーまたは対象外になることを確認すること。"
        ),
        "run_log": "PASS (3.0s) ← 180-1と同等時間",
        "actual_behavior": "180-1と同一（ハンバーガーメニュー→モーダル表示確認）",
    },
    {
        "id": "180-3",
        "title": "編集中でロックされているデータも強制的に上書きされること",
        "describe": "レコード操作（一覧・作成・編集・削除・一括編集）",
        "verdict": VERDICT_FAKE,
        "category": CATEGORY_SAME_AS_OTHER,
        "line": 387,
        "reason": (
            "【Playwright実動作確認済み・仕様矛盾あり】"
            "ロック中データを作成していない（別セッション処理なし）。180-1と実質同一のモーダル表示確認のみ。"
            "さらに重大問題：実際のモーダルには "
            "「※編集中でロックされているデータは更新されません。その場合はログに記録されます。」"
            "と記載されており、テストタイトル「強制的に上書きされること」と仕様が逆の可能性がある。"
            "テストタイトル自体が間違っているかYAMLシナリオと仕様書の確認が必要。"
        ),
        "fix": (
            "まずYAMLシナリオ・仕様書で正しい期待値を確認すること。"
            "「ロック中は更新されない」が正しい仕様なら、タイトルを修正してロック中データを作成し、"
            "一括編集後もそのデータが変化しないことを検証すること。"
        ),
        "run_log": "PASS (2.4s) ← console.log: '一括編集'のみ",
        "actual_behavior": "180-1と同一（ハンバーガーメニュー→モーダル表示確認）",
    },
    {
        "id": "180-4",
        "title": "フィルタ適用中にのみ一括編集がかかること",
        "describe": "レコード操作（一覧・作成・編集・削除・一括編集）",
        "verdict": VERDICT_FAKE,
        "category": CATEGORY_SAME_AS_OTHER,
        "line": 435,
        "reason": (
            "フィルタを一切適用していない。180-1と実質同一のモーダル表示確認のみ。"
            "「フィルタ適用中にのみ」の条件検証（フィルタなし時との比較）が完全に欠如。"
        ),
        "fix": (
            "フィルタを適用して絞り込み後に一括編集を実行し、"
            "フィルタ対象のレコードのみが編集されフィルタ外は変化しないことを確認すること。"
        ),
        "run_log": "PASS (2.6s)",
        "actual_behavior": "180-1と同一（ハンバーガーメニュー→モーダル表示確認）",
    },
    {
        "id": "237",
        "title": "レコード一覧のスクロールバーを問題なく操作できること",
        "describe": "レコード操作（一覧・作成・編集・削除・一括編集）",
        "verdict": VERDICT_FAKE,
        "category": CATEGORY_WRONG_TARGET,
        "line": 479,
        "reason": (
            "【Playwright実動作確認済み】`.table-responsive` は独立したdivラッパーではなく"
            "`<table>` 要素自体に付与されたクラス名。HTMLテーブル要素に対してscrollLeftを設定しても"
            "スクロールは機能しない。さらにエラーは `.catch(() => {})` でサイレント無視。"
            "最終アサーションは .navbar のみ。スクロール操作は実質何も行っていない。"
        ),
        "fix": (
            "テーブルを囲む実際のスクロールコンテナ要素を特定すること（親divやbodyなど）。"
            "スクロール後に `el.scrollLeft` の値が実際に変化したことをevaluateで確認すること。"
        ),
        "run_log": "PASS (1.8s) ← scrollLeft操作が無効 + エラーをcatchで無視",
        "actual_behavior": "table要素のscrollLeft変更（無効）→ .navbar確認のみ",
    },
    {
        "id": "35-1",
        "title": "参照中のテーブルを削除しようとするとエラーが表示されること",
        "describe": "レコード操作（一覧・作成・編集・削除・一括編集）",
        "verdict": VERDICT_FAKE,
        "category": CATEGORY_WRONG_TARGET,
        "line": 521,
        "reason": (
            "【Playwright実動作確認済み】セレクタが2箇所で間違っている。"
            "(1) `tr:has-text('ALLテスト_選択肢マスタ')` を使用しているが、"
            "実際のDOMはテーブル定義一覧が `li.cdk-drag` 要素のリスト形式のため `tr` にマッチしない。"
            "(2) エラーはネイティブの `alert()` ダイアログで表示されるが、"
            "テストは `.alert-danger` / `.toast-error` を確認しており捕捉できない。"
            "機能自体は正常に動作しており、正しいセレクタを使えばエラーメッセージ全文"
            "「ALLテスト_選択肢マスタはALLテストテーブルから参照されているため、削除できません」が確認できる。"
        ),
        "fix": (
            "(1) セレクタを `li.cdk-drag:has-text('ALLテスト_選択肢マスタ')` に修正。"
            "(2) `page.on('dialog')` でnative alert()をインターセプトしてメッセージ内容を検証すること。"
            "エラーメッセージに「参照されているため」が含まれることをassertする。"
        ),
        "run_log": "PASS (1.4s) ← '削除ボタンが見つからないため、ページ表示のみ確認'",
        "actual_behavior": "tr セレクタが li.cdk-drag にマッチせず削除ボタン未発見 → .navbar確認のみ",
    },
    {
        "id": "52-1",
        "title": "関連レコード一覧の項目名未入力でエラーが発生すること",
        "describe": "レコード操作（一覧・作成・編集・削除・一括編集）",
        "verdict": VERDICT_REAL,
        "category": CATEGORY_OK,
        "line": 577,
        "reason": (
            "graceful passパスが存在するが、実行ログより実際はモーダルが開きエラー確認まで実行されている。"
            "「項目名未入力でエラー」という本来の検証が動いている。"
        ),
        "fix": "",
        "run_log": "PASS (6.2s) ← modalState: relation_table確認済み",
        "actual_behavior": "モーダル→「関連レコード一覧」選択→空で送信→エラー確認",
    },
    {
        "id": "52-2",
        "title": "関連レコード一覧の対象テーブル未入力でエラーが発生すること",
        "describe": "レコード操作（一覧・作成・編集・削除・一括編集）",
        "verdict": VERDICT_REAL,
        "category": CATEGORY_OK,
        "line": 679,
        "reason": "52-1と同様、実際はモーダルが開きエラー確認まで実行されている。",
        "fix": "",
        "run_log": "PASS (5.9s) ← modalState: relation_table確認済み",
        "actual_behavior": "モーダル→「関連レコード一覧」選択→項目名のみ入力→テーブル未選択で送信→エラー確認",
    },
    {
        "id": "一括-1",
        "title": "レコード一覧にチェックボックスと全選択UIが存在すること",
        "describe": "レコード一括操作（チェックボックス選択・一括削除・一括編集）",
        "verdict": VERDICT_REAL,
        "category": CATEGORY_OK,
        "line": 829,
        "reason": "データ行のチェックボックス + ヘッダー全選択チェックボックスの両方を確認。適切。",
        "fix": "",
        "run_log": "PASS (2.5s)",
        "actual_behavior": "各行checkbox + ヘッダーcheckboxの存在確認",
    },
    {
        "id": "一括-2",
        "title": "全選択チェックボックスをクリックすると一括操作ボタンが表示されること",
        "describe": "レコード一括操作（チェックボックス選択・一括削除・一括編集）",
        "verdict": VERDICT_REAL,
        "category": CATEGORY_OK,
        "line": 871,
        "reason": "全選択クリック後に一括削除ボタンまたは選択件数表示を確認。本物のフロー。",
        "fix": "",
        "run_log": "PASS (2.6s)",
        "actual_behavior": "ヘッダーcheckbox.click() → 一括操作ボタン表示確認",
    },
    {
        "id": "一括-3",
        "title": "1件選択して一括削除を実行すると件数が減ること",
        "describe": "レコード一括操作（チェックボックス選択・一括削除・一括編集）",
        "verdict": VERDICT_REAL,
        "category": CATEGORY_OK,
        "line": 918,
        "reason": "削除前後の件数比較あり（afterCount < beforeCount）。最も本物らしいテスト。",
        "fix": "",
        "run_log": "PASS (5.2s)",
        "actual_behavior": "checkbox→削除ボタン→confirm→リロード→件数減少確認",
    },
    {
        "id": "一括-4",
        "title": "複数選択後に一括編集メニューが表示されること（UIが存在する場合）",
        "describe": "レコード一括操作（チェックボックス選択・一括削除・一括編集）",
        "verdict": VERDICT_REAL,
        "category": CATEGORY_OK,
        "line": 990,
        "reason": "ハンバーガーメニューから一括編集メニュー項目の確認。タイトルにも「UIが存在する場合」と明記。",
        "fix": "",
        "run_log": "PASS (2.6s)",
        "actual_behavior": "ハンバーガーメニュー→「一括編集」メニューアイテム確認",
    },
    {
        "id": "ORD-01",
        "title": "レコード一覧に並び替えボタンまたはドラッグハンドルが存在すること",
        "describe": "レコード並び替え",
        "verdict": VERDICT_FAKE,
        "category": CATEGORY_GRACEFUL_SKIP,
        "line": 1057,
        "reason": (
            "実行ログより常にgraceful pass（並び替えUIが見つからない）。"
            "ソースコード確認済み: isMovable = table_info.table == 'dataset' のため、"
            "個別テーブルページ（/admin/dataset__{id}）では並び替えUIは表示されない。"
            "テストステップ: ✅.navbar → ✅.navbar の2ステップのみ。並び替えとは無関係。"
        ),
        "fix": (
            "並び替え機能を有効化するにはテーブル設定でorder_fieldを設定する必要がある。"
            "beforeAllでorder_fieldを設定するかtest.skip('並び替え機能未設定のためスキップ')として"
            "明示的にスキップすること。graceful passは削除すること。"
        ),
        "run_log": "PASS (1.2s) ← 'ORD-01: 並び替えUIが見つからない' → .navbar確認のみ",
        "actual_behavior": ".navbar 2回確認のみ。並び替えUIは一切確認していない。",
    },
    {
        "id": "ORD-02",
        "title": "並び替えモードに切り替えられること",
        "describe": "レコード並び替え",
        "verdict": VERDICT_FAKE,
        "category": CATEGORY_GRACEFUL_SKIP,
        "line": 1091,
        "reason": (
            "ORD-01と同様に常にgraceful pass。"
            "テストステップ: ✅.navbar → ✅.navbar の2ステップのみ。"
            "「並び替えモードに切り替えられること」を全くテストしていない。"
            "この問題はユーザーが指摘した典型例。"
        ),
        "fix": "ORD-01と同様。並び替え機能が有効な状態でのみ実行するか、明示的にスキップすること。",
        "run_log": "PASS (1.2s) ← 'ORD-02: 並び替えボタンが見つからない' → .navbar確認のみ",
        "actual_behavior": ".navbar 2回確認のみ。モード切替は一切確認していない。",
    },
    {
        "id": "LOCK-01",
        "title": "レコード編集開始でロック状態になること",
        "describe": "編集ロック",
        "verdict": VERDICT_REAL,
        "category": CATEGORY_OK,
        "line": 1183,
        "reason": (
            "編集ボタンクリック後に編集UI（保存/キャンセルボタン等）が表示されることを確認。"
            "実行ログより indicator=1 で実際に編集UIが検出されている。"
        ),
        "fix": "",
        "run_log": "PASS (2.3s) ← URL:false, indicator:1",
        "actual_behavior": "詳細ページ→「編集」クリック→編集UI変化確認",
    },
    {
        "id": "LOCK-02",
        "title": "編集キャンセルでロックが解除されること",
        "describe": "編集ロック",
        "verdict": VERDICT_REAL,
        "category": CATEGORY_OK,
        "line": 1254,
        "reason": "編集後キャンセルで「編集」ボタンが再表示されることを確認。ロック解除の実質的な検証。",
        "fix": "",
        "run_log": "PASS (3.1s)",
        "actual_behavior": "「編集」→「キャンセル」→「編集」ボタン再表示確認",
    },
    {
        "id": "LOCK-03",
        "title": "編集保存でロックが解除されること",
        "describe": "編集ロック",
        "verdict": VERDICT_SHALLOW,
        "category": CATEGORY_INCOMPLETE,
        "line": 1316,
        "reason": (
            "保存後にエラーなし確認のみ。「ロックが解除されること」（=編集ボタンの再表示）を"
            "直接確認していない。LOCK-02と対称的なアサーションが不足。"
        ),
        "fix": "保存後に「編集」ボタンが再表示されることを確認すること（LOCK-02と同じパターン）。",
        "run_log": "PASS (2.5s)",
        "actual_behavior": "「編集」→「保存」→エラーなし確認のみ（編集ボタン再表示未確認）",
    },
]


def get_verdict_emoji(verdict):
    if verdict == VERDICT_REAL:
        return "✅"
    elif verdict == VERDICT_SHALLOW:
        return "⚠️"
    elif verdict == VERDICT_SKIP:
        return "⚠️"
    elif verdict == VERDICT_FAKE:
        return "❌"
    return "❓"


def print_report(analysis):
    """コンソールにレポートを出力"""
    print("\n" + "="*80)
    print("records.spec.js 品質チェックレポート")
    print("="*80)

    summary = {VERDICT_REAL: 0, VERDICT_SHALLOW: 0, VERDICT_SKIP: 0, VERDICT_FAKE: 0}
    for item in analysis:
        summary[item["verdict"]] = summary.get(item["verdict"], 0) + 1

    print(f"\nサマリー:")
    print(f"  ✅ REAL   (本物): {summary[VERDICT_REAL]}件")
    print(f"  ⚠️ SHALLOW(浅い): {summary[VERDICT_SHALLOW]}件")
    print(f"  ⚠️ SKIP   (スキップ): {summary.get(VERDICT_SKIP, 0)}件")
    print(f"  ❌ FAKE   (偽テスト): {summary[VERDICT_FAKE]}件")
    print(f"  合計: {len(analysis)}件\n")

    for item in analysis:
        if item["verdict"] != VERDICT_REAL:
            print(f"{item['verdict']} [{item['id']}] {item['title']}")
            print(f"  分類: {item['category']}")
            print(f"  理由: {item['reason'][:100]}...")
            if item["fix"]:
                print(f"  修正: {item['fix'][:80]}...")
            print()


def push_to_sheets(analysis, spreadsheet_id, credentials_path):
    """Google Sheetsに書き込む"""
    try:
        from googleapiclient.discovery import build
        from google.oauth2.service_account import Credentials
        from google.oauth2.credentials import Credentials as OAuthCredentials
        from google.auth.transport.requests import Request
        import pickle

        # 認証（user_token.json優先）
        creds = None
        token_path = Path("secrets/user_token.json")
        service_account_path = Path(credentials_path)

        if token_path.exists():
            with open(token_path) as f:
                token_data = json.load(f)
            from google.oauth2.credentials import Credentials as OAuthCreds
            creds = OAuthCreds.from_authorized_user_info(token_data, [
                "https://www.googleapis.com/auth/spreadsheets"
            ])
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
        elif service_account_path.exists():
            creds = Credentials.from_service_account_file(
                str(service_account_path),
                scopes=["https://www.googleapis.com/auth/spreadsheets"]
            )

        if not creds:
            print("認証情報が見つかりません")
            return False

        service = build("sheets", "v4", credentials=creds)
        sheets = service.spreadsheets()

        tab_name = "Spec品質チェック_records"
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M")

        # タブが存在するか確認して削除・再作成
        spreadsheet = sheets.get(spreadsheetId=spreadsheet_id).execute()
        existing_sheets = [s["properties"]["title"] for s in spreadsheet["sheets"]]

        requests_batch = []
        if tab_name in existing_sheets:
            sheet_id = next(
                s["properties"]["sheetId"]
                for s in spreadsheet["sheets"]
                if s["properties"]["title"] == tab_name
            )
            requests_batch.append({"deleteSheet": {"sheetId": sheet_id}})

        requests_batch.append({
            "addSheet": {
                "properties": {
                    "title": tab_name,
                    "gridProperties": {"rowCount": 100, "columnCount": 10},
                }
            }
        })

        sheets.batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": requests_batch}
        ).execute()

        # カウント
        counts = {VERDICT_REAL: 0, VERDICT_SHALLOW: 0, VERDICT_SKIP: 0, VERDICT_FAKE: 0}
        for item in analysis:
            counts[item["verdict"]] = counts.get(item["verdict"], 0) + 1

        # データ構築
        header_row = ["チェック実施日:", now_str, "", "", "", "", "", "", "", ""]
        summary_row = [
            "サマリー",
            f"✅ REAL: {counts[VERDICT_REAL]}",
            f"⚠️ SHALLOW: {counts[VERDICT_SHALLOW]}",
            f"⚠️ SKIP: {counts.get(VERDICT_SKIP, 0)}",
            f"❌ FAKE: {counts[VERDICT_FAKE]}",
            f"合計: {len(analysis)}",
            "", "", "", ""
        ]
        blank_row = [""] * 10
        column_row = [
            "テストID", "テストタイトル", "describe", "判定", "カテゴリ",
            "実行時間/ログ", "実際の動作", "問題の理由", "修正方針", "行番号"
        ]

        data_rows = [header_row, summary_row, blank_row, column_row]
        for item in analysis:
            data_rows.append([
                item["id"],
                item["title"],
                item["describe"],
                item["verdict"],
                item["category"],
                item.get("run_log", ""),
                item.get("actual_behavior", ""),
                item["reason"],
                item.get("fix", ""),
                str(item.get("line", "")),
            ])

        # 書き込み
        sheets.values().update(
            spreadsheetId=spreadsheet_id,
            range=f"'{tab_name}'!A1",
            valueInputOption="RAW",
            body={"values": data_rows}
        ).execute()

        # 書式設定（ヘッダー行を太字・背景色）
        # 最新のsheetIdを取得
        spreadsheet2 = sheets.get(spreadsheetId=spreadsheet_id).execute()
        new_sheet_id = next(
            s["properties"]["sheetId"]
            for s in spreadsheet2["sheets"]
            if s["properties"]["title"] == tab_name
        )

        # 列ヘッダー行（row 4）を太字+背景色
        header_row_idx = 3  # 0-indexed
        format_requests = [
            # ヘッダー行 太字+背景
            {
                "repeatCell": {
                    "range": {
                        "sheetId": new_sheet_id,
                        "startRowIndex": header_row_idx,
                        "endRowIndex": header_row_idx + 1,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "textFormat": {"bold": True, "foregroundColor": {"red": 1, "green": 1, "blue": 1}},
                            "backgroundColor": {"red": 0.2, "green": 0.2, "blue": 0.2},
                        }
                    },
                    "fields": "userEnteredFormat(textFormat,backgroundColor)"
                }
            },
        ]

        # 判定ごとに色付け
        verdict_colors = {
            VERDICT_REAL:    {"red": 0.85, "green": 0.95, "blue": 0.85},
            VERDICT_SHALLOW: {"red": 1.0,  "green": 0.95, "blue": 0.80},
            VERDICT_SKIP:    {"red": 1.0,  "green": 0.90, "blue": 0.70},
            VERDICT_FAKE:    {"red": 1.0,  "green": 0.85, "blue": 0.85},
        }
        for i, item in enumerate(analysis):
            row_idx = header_row_idx + 1 + i  # 0-indexed
            color = verdict_colors.get(item["verdict"], {"red": 1, "green": 1, "blue": 1})
            format_requests.append({
                "repeatCell": {
                    "range": {
                        "sheetId": new_sheet_id,
                        "startRowIndex": row_idx,
                        "endRowIndex": row_idx + 1,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "backgroundColor": color
                        }
                    },
                    "fields": "userEnteredFormat.backgroundColor"
                }
            })

        # 列幅調整
        col_widths = [80, 300, 200, 100, 150, 150, 200, 350, 300, 60]
        for col_idx, width in enumerate(col_widths):
            format_requests.append({
                "updateDimensionProperties": {
                    "range": {
                        "sheetId": new_sheet_id,
                        "dimension": "COLUMNS",
                        "startIndex": col_idx,
                        "endIndex": col_idx + 1,
                    },
                    "properties": {"pixelSize": width},
                    "fields": "pixelSize"
                }
            })

        sheets.batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": format_requests}
        ).execute()

        print(f"\n✅ Google Sheetsに書き込み完了")
        print(f"   タブ: '{tab_name}'")
        print(f"   URL: https://docs.google.com/spreadsheets/d/{spreadsheet_id}")
        return True

    except Exception as e:
        print(f"❌ シート書き込みエラー: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    args = sys.argv[1:]
    spec_name = args[0] if args else "records"
    push = "--push" in args

    if spec_name == "records":
        analysis = RECORDS_ANALYSIS
    else:
        print(f"未対応のspec: {spec_name}（現在はrecordsのみ対応）")
        sys.exit(1)

    print_report(analysis)

    if push:
        spreadsheet_id = os.environ.get("SPREADSHEET_ID", "1h_gwuCGUAdj5fKPRZu438TKFkFkYUNUKz2K_vtEFlmI")
        credentials_path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "secrets/service_account.json")
        push_to_sheets(analysis, spreadsheet_id, credentials_path)
    else:
        print("（Sheetsへの書き込みは --push オプションで実行）")


if __name__ == "__main__":
    main()
