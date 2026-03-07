"""
YAMLシナリオファイルを読み込んでPlaywrightでE2Eテストを実行する。
失敗した場合はスクリーンショットと詳細を results.json に記録。
"""
import os
import json
import glob
import traceback
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
    value = resolve_value(step.get("value", ""))

    if action == "navigate":
        url = value if value.startswith("http") else BASE_URL + value
        page.goto(url, wait_until="networkidle")
    elif action == "fill":
        page.fill(selector, value)
    elif action == "click":
        page.click(selector)
    elif action == "wait":
        page.wait_for_timeout(int(value) * 1000)
    elif action == "wait_for":
        page.wait_for_selector(selector)
    elif action == "select":
        page.select_option(selector, value)
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
            expect(page.locator(assertion["selector"])).to_be_visible()
        elif atype == "element_not_visible":
            expect(page.locator(assertion["selector"])).to_be_hidden()
        elif atype == "text_contains":
            expect(page.locator(assertion["selector"])).to_contain_text(assertion["value"])
        elif atype == "title_contains":
            assert assertion["value"] in page.title(), f"タイトル '{page.title()}' に '{assertion['value']}' が含まれない"
        elif atype == "comment":
            pass  # コメントはスキップ
        return True, ""
    except Exception as e:
        return False, str(e)


def run_scenario(scenario_path: Path) -> dict:
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
            # 最初のnavigateがなければログインページへ
            first_action = scenario.get("steps", [{}])[0].get("action")
            if first_action != "navigate":
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
            # 失敗またはscreenshot=trueなら撮影
            if result["status"] == "failed" or scenario.get("screenshot"):
                ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                ss_path = REPORTS_DIR / f"screenshot_{scenario_path.stem}_{ts}.png"
                page.screenshot(path=str(ss_path), full_page=True)
                result["screenshot"] = str(ss_path)

            browser.close()

    return result


def main():
    scenario_files = sorted(SCENARIOS_DIR.glob("**/*.yaml"))
    if not scenario_files:
        print("シナリオファイルが見つかりません: scenarios/*.yaml")
        return []

    all_results = []
    for sf in scenario_files:
        print(f"実行中: {sf.name} ... ", end="", flush=True)
        result = run_scenario(sf)
        status = "OK" if result["status"] == "passed" else "FAIL"
        print(status)
        if result["errors"]:
            for e in result["errors"]:
                print(f"  -> {e['message']}")
        all_results.append(result)

    # results.json に保存
    results_path = REPORTS_DIR / "results.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    passed = sum(1 for r in all_results if r["status"] == "passed")
    failed = sum(1 for r in all_results if r["status"] == "failed")
    print(f"\n結果: {passed}件成功 / {failed}件失敗 (合計{len(all_results)}件)")
    print(f"レポート: {results_path}")

    return all_results


if __name__ == "__main__":
    main()
