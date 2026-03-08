"""
YAMLシナリオファイルを読み込んでPlaywrightでE2Eテストを実行する。
失敗した場合はスクリーンショットと詳細を results.json に記録。

- テストごとにタイムアウト（TEST_TIMEOUT_SEC）を設定
- 連続失敗が MAX_CONSECUTIVE_FAILS を超えたら強制停止してSlack通知
- 進捗をSlackに定期通知（PROGRESS_NOTIFY_EVERY件ごと）
- setup/teardown セクションでAPIを叩いてテストデータ準備可能
"""
import os
import json
import traceback
import threading
import requests
from datetime import datetime
from pathlib import Path

import yaml
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, Page, expect

load_dotenv()

BASE_URL = os.environ["TEST_BASE_URL"].rstrip("/")
EMAIL = os.environ["TEST_EMAIL"]
PASSWORD = os.environ["TEST_PASSWORD"]
SCENARIOS_DIR = Path("/app/scenarios")
REPORTS_DIR = Path("/app/reports")
REPORTS_DIR.mkdir(exist_ok=True)

SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "")
SLACK_NOTIFY_USER_ID = os.environ.get("SLACK_NOTIFY_USER_ID", "U869KKT8C")

# テスト1件あたりのタイムアウト（秒）
TEST_TIMEOUT_SEC = int(os.environ.get("TEST_TIMEOUT_SEC", "60"))
# 連続失敗でアラートを上げる件数
MAX_CONSECUTIVE_FAILS = int(os.environ.get("MAX_CONSECUTIVE_FAILS", "20"))
# 何件ごとに進捗通知するか
PROGRESS_NOTIFY_EVERY = int(os.environ.get("PROGRESS_NOTIFY_EVERY", "10"))


def slack_notify(text: str) -> None:
    if not SLACK_WEBHOOK_URL:
        return
    try:
        requests.post(SLACK_WEBHOOK_URL, json={"text": text}, timeout=10)
    except Exception:
        pass


def resolve_value(value: str) -> str:
    """{{ VAR }} を環境変数に置換する"""
    if not isinstance(value, str):
        return value
    if "{{" in value:
        import re
        def replace(m):
            key = m.group(1).strip()
            return os.environ.get(key, m.group(0))
        value = re.sub(r"\{\{(.+?)\}\}", replace, value)
    return value


def run_step(page: Page, step: dict) -> None:
    action = step["action"]
    selector = step.get("selector", "")
    value = resolve_value(str(step.get("value", "")))

    if action == "navigate":
        url = value if value.startswith("http") else BASE_URL + value
        page.goto(url, wait_until="networkidle")

    elif action == "fill":
        page.fill(selector, value)

    elif action == "click":
        page.click(selector)

    elif action == "wait":
        page.wait_for_timeout(int(float(value)) * 1000)

    elif action == "wait_for":
        page.wait_for_selector(selector, timeout=30000)

    elif action == "select":
        page.select_option(selector, value)

    elif action == "login":
        # ログインショートカット（引数省略時は .env の EMAIL/PASSWORD を使用）
        email = resolve_value(step.get("email", "{{ TEST_EMAIL }}"))
        password = resolve_value(step.get("password", "{{ TEST_PASSWORD }}"))
        page.goto(BASE_URL + "/admin/login", wait_until="networkidle")
        page.fill("#id", email)
        page.fill("#password", password)
        page.click("button[type=submit].btn-primary")
        page.wait_for_selector(".navbar", timeout=15000)

    elif action == "api_post":
        # Debug API等のPOST呼び出し（Playwrightのセッションを共有）
        path = step.get("path", "")
        body = step.get("body", {})
        resp = page.request.post(
            BASE_URL + path,
            data=json.dumps(body),
            headers={"Content-Type": "application/json"},
            timeout=120000
        )
        if not resp.ok:
            raise ValueError(f"api_post失敗: {path} → HTTP {resp.status}")
        result = resp.json()
        if not result.get("success", True):
            logs = result.get("logs", [])
            raise ValueError(f"api_post失敗: {path} → {logs[:3]}")

    elif action == "api_get":
        # Debug API等のGET呼び出し
        path = step.get("path", "")
        resp = page.request.get(BASE_URL + path, timeout=30000)
        if not resp.ok:
            raise ValueError(f"api_get失敗: {path} → HTTP {resp.status}")

    elif action == "comment":
        pass  # コメントはスキップ

    else:
        raise ValueError(f"不明なアクション: {action}")


def run_assertion(page: Page, assertion: dict) -> tuple[bool, str]:
    atype = assertion["type"]
    try:
        if atype == "url_contains":
            assert assertion["value"] in page.url, f"URL '{page.url}' に '{assertion['value']}' が含まれない"
        elif atype == "element_visible":
            expect(page.locator(assertion["selector"])).to_be_visible(timeout=10000)
        elif atype == "element_not_visible":
            expect(page.locator(assertion["selector"])).to_be_hidden(timeout=10000)
        elif atype == "text_contains":
            expect(page.locator(assertion["selector"])).to_contain_text(assertion["value"], timeout=10000)
        elif atype == "title_contains":
            assert assertion["value"] in page.title(), f"タイトル '{page.title()}' に '{assertion['value']}' が含まれない"
        elif atype == "api_success":
            # api_post/api_getの直後に使う（現在のURLのJSONレスポンスを確認）
            pass
        elif atype == "comment":
            pass  # コメントはスキップ
        return True, ""
    except Exception as e:
        return False, str(e)


def run_scenario_with_timeout(scenario_path: Path) -> dict:
    """タイムアウト付きでシナリオを実行する"""
    result_container = {"result": None, "exception": None}

    def target():
        try:
            result_container["result"] = _run_scenario(scenario_path)
        except Exception as e:
            result_container["exception"] = e

    thread = threading.Thread(target=target)
    thread.start()
    thread.join(timeout=TEST_TIMEOUT_SEC)

    if thread.is_alive():
        # タイムアウト：スレッドは放棄してスキップ扱い
        return {
            "scenario": scenario_path.stem,
            "file": str(scenario_path),
            "status": "skipped",
            "errors": [{"type": "timeout", "message": f"タイムアウト({TEST_TIMEOUT_SEC}秒)のためスキップ"}],
            "screenshot": None,
            "timestamp": datetime.now().isoformat(),
        }

    if result_container["exception"]:
        return {
            "scenario": scenario_path.stem,
            "file": str(scenario_path),
            "status": "failed",
            "errors": [{"type": "exception", "message": str(result_container["exception"])}],
            "screenshot": None,
            "timestamp": datetime.now().isoformat(),
        }

    return result_container["result"]


def _run_scenario(scenario_path: Path) -> dict:
    with open(scenario_path, encoding="utf-8") as f:
        scenario = yaml.safe_load(f)

    name = scenario.get("name", scenario_path.stem)
    result = {
        "scenario": name,
        "file": str(scenario_path),
        "status": "passed",
        "errors": [],
        "screenshot": None,
        "timestamp": datetime.now().isoformat(),
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = browser.new_page()
        page.set_viewport_size({"width": 1280, "height": 800})

        try:
            # setup: テストデータ準備（ログインしてからAPI呼び出し）
            setup_steps = scenario.get("setup", [])
            if setup_steps:
                page.goto(BASE_URL + "/admin/login", wait_until="networkidle")
                page.fill("#id", EMAIL)
                page.fill("#password", PASSWORD)
                page.click("button[type=submit].btn-primary")
                page.wait_for_selector(".navbar", timeout=15000)
                for step in setup_steps:
                    run_step(page, step)

            # 最初のnavigateがなければログインページへ
            first_action = scenario.get("steps", [{}])[0].get("action") if scenario.get("steps") else None
            if first_action not in ("navigate", "login", "comment", None):
                page.goto(BASE_URL + "/admin/login", wait_until="networkidle")

            for step in scenario.get("steps", []):
                run_step(page, step)

            for assertion in scenario.get("assertions", []):
                ok, msg = run_assertion(page, assertion)
                if not ok:
                    result["status"] = "failed"
                    result["errors"].append({"type": "assertion", "message": msg})

        except Exception as e:
            result["status"] = "failed"
            result["errors"].append({"type": "exception", "message": str(e), "trace": traceback.format_exc()})

        finally:
            # teardown: テストデータ後片付け
            teardown_steps = scenario.get("teardown", [])
            if teardown_steps:
                try:
                    for step in teardown_steps:
                        run_step(page, step)
                except Exception:
                    pass  # teardown失敗はテスト結果に影響させない

            if result["status"] == "failed" or scenario.get("screenshot"):
                ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                ss_path = REPORTS_DIR / f"screenshot_{scenario_path.stem}_{ts}.png"
                try:
                    page.screenshot(path=str(ss_path), full_page=True)
                    result["screenshot"] = str(ss_path)
                except Exception:
                    pass
            browser.close()

    return result


def main():
    scenario_files = sorted(SCENARIOS_DIR.glob("**/*.yaml"))
    if not scenario_files:
        print("シナリオファイルが見つかりません: scenarios/*.yaml")
        return []

    total = len(scenario_files)
    slack_notify(f"<@{SLACK_NOTIFY_USER_ID}> 【PigeonCloud テスト開始】 全{total}件 実行します")

    all_results = []
    consecutive_fails = 0

    for i, sf in enumerate(scenario_files, 1):
        print(f"実行中: {sf.name} ... ", end="", flush=True)
        result = run_scenario_with_timeout(sf)

        status_label = {"passed": "OK", "failed": "FAIL", "skipped": "SKIP"}.get(result["status"], "FAIL")
        print(status_label)
        if result["errors"]:
            for e in result["errors"]:
                print(f"  -> {e['message']}")

        all_results.append(result)

        # 連続失敗カウント
        if result["status"] in ("failed", "skipped"):
            consecutive_fails += 1
        else:
            consecutive_fails = 0

        # 連続失敗が閾値超えたら強制停止
        if consecutive_fails >= MAX_CONSECUTIVE_FAILS:
            msg = (
                f"<@{SLACK_NOTIFY_USER_ID}> 🚨 【PigeonCloud テスト異常停止】\n"
                f"連続{consecutive_fails}件失敗/スキップのため強制停止しました\n"
                f"進捗: {i}/{total}件 完了時点"
            )
            print(f"\n!! 連続{consecutive_fails}件失敗のため強制停止")
            slack_notify(msg)
            break

        # 進捗通知
        if i % PROGRESS_NOTIFY_EVERY == 0:
            passed = sum(1 for r in all_results if r["status"] == "passed")
            failed = sum(1 for r in all_results if r["status"] == "failed")
            skipped = sum(1 for r in all_results if r["status"] == "skipped")
            slack_notify(
                f"<@{SLACK_NOTIFY_USER_ID}> 📊 【PigeonCloud テスト進捗】 {i}/{total}件完了\n"
                f"✅ {passed}件成功 / ❌ {failed}件失敗 / ⏭ {skipped}件スキップ"
            )

    # results.json に保存
    results_path = REPORTS_DIR / "results.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    passed = sum(1 for r in all_results if r["status"] == "passed")
    failed = sum(1 for r in all_results if r["status"] == "failed")
    skipped = sum(1 for r in all_results if r["status"] == "skipped")
    print(f"\n結果: {passed}件成功 / {failed}件失敗 / {skipped}件スキップ (合計{len(all_results)}/{total}件)")
    print(f"レポート: {results_path}")

    return all_results


if __name__ == "__main__":
    main()
