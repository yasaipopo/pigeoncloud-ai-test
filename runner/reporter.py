"""
テスト結果をSlackに通知する
"""
import os
import json
import requests
from pathlib import Path

SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "")
SLACK_NOTIFY_USER_ID = os.environ.get("SLACK_NOTIFY_USER_ID", "U869KKT8C")
REPORTS_DIR = Path("/app/reports")


def notify_slack(results: list, claude_report: str = "") -> None:
    if not SLACK_WEBHOOK_URL:
        print("SLACK_WEBHOOK_URLが未設定のためSlack通知をスキップ")
        return

    passed = [r for r in results if r["status"] == "passed"]
    failed = [r for r in results if r["status"] == "failed"]

    # サマリー
    if not failed:
        header = f"<@{SLACK_NOTIFY_USER_ID}> ✅ 【PigeonCloud】テスト全件通過"
        color = "#36a64f"
    else:
        header = f"<@{SLACK_NOTIFY_USER_ID}> ❌ 【PigeonCloud】テスト失敗あり"
        color = "#e01e5a"

    lines = [
        f"*結果*: {len(passed)}件成功 / {len(failed)}件失敗",
    ]

    if failed:
        lines.append("\n*失敗したシナリオ:*")
        for r in failed:
            lines.append(f"• `{r['scenario']}`")
            for e in r.get("errors", [])[:2]:
                lines.append(f"  → {e['message'][:100]}")

    if claude_report:
        lines.append("\n*Claude調査レポート:*")
        lines.append(claude_report[:800])

    payload = {
        "attachments": [{
            "color": color,
            "title": header,
            "text": "\n".join(lines),
            "footer": "PigeonCloud Test Agent",
        }]
    }

    resp = requests.post(SLACK_WEBHOOK_URL, json=payload, timeout=10)
    if resp.status_code == 200:
        print("Slack通知を送信しました")
    else:
        print(f"Slack通知に失敗: {resp.status_code} {resp.text}")


if __name__ == "__main__":
    results_path = REPORTS_DIR / "results.json"
    if results_path.exists():
        with open(results_path, encoding="utf-8") as f:
            results = json.load(f)
        claude_report_path = REPORTS_DIR / "claude_report.md"
        claude_report = claude_report_path.read_text(encoding="utf-8") if claude_report_path.exists() else ""
        notify_slack(results, claude_report)
    else:
        print("results.jsonが見つかりません")
