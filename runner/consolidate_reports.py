"""
各エージェントのレポートを統合して最終レポートを生成する。

reports/
  agent-1/
    results.json
    claude_report.md
    screenshots/
  agent-2/
    ...
  final_report.md   ← このスクリプトが生成

使い方:
  python runner/consolidate_reports.py
"""
import json
import os
import requests
from datetime import datetime
from pathlib import Path

REPORTS_DIR = Path(os.environ.get("REPORTS_DIR", "/app/reports"))
SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "")
SLACK_NOTIFY_USER_ID = os.environ.get("SLACK_NOTIFY_USER_ID", "U869KKT8C")


def load_agent_results():
    """全エージェントの results.json を収集する"""
    agent_results = {}
    for agent_dir in sorted(REPORTS_DIR.glob("agent-*")):
        results_path = agent_dir / "results.json"
        if not results_path.exists():
            continue
        with open(results_path, encoding="utf-8") as f:
            results = json.load(f)
        agent_num = agent_dir.name  # "agent-1" など
        agent_results[agent_num] = results
    return agent_results


def load_agent_claude_reports():
    """全エージェントの claude_report.md を収集する"""
    reports = {}
    for agent_dir in sorted(REPORTS_DIR.glob("agent-*")):
        report_path = agent_dir / "claude_report.md"
        if report_path.exists():
            reports[agent_dir.name] = report_path.read_text(encoding="utf-8")
    return reports


def generate_final_report(agent_results: dict, claude_reports: dict) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 全体集計
    total_passed = total_failed = total_skipped = 0
    all_failures = []
    all_bugs = []

    for agent_name, results in agent_results.items():
        for r in results:
            if r["status"] == "passed":
                total_passed += 1
            elif r["status"] == "failed":
                total_failed += 1
                all_failures.append((agent_name, r))
            elif r["status"] == "skipped":
                total_skipped += 1

    # Claude報告から不具合を抽出
    for agent_name, report in claude_reports.items():
        if "不具合" in report or "バグ" in report or "エラー" in report:
            all_bugs.append((agent_name, report))

    total = total_passed + total_failed + total_skipped
    pass_rate = round(total_passed / total * 100, 1) if total > 0 else 0

    lines = []
    lines.append(f"# PigeonCloud テスト結果レポート")
    lines.append(f"")
    lines.append(f"**実行日時**: {now}")
    lines.append(f"**エージェント数**: {len(agent_results)}台")
    lines.append(f"")

    # ===== サマリー =====
    lines.append(f"## 📊 サマリー")
    lines.append(f"")
    lines.append(f"| 項目 | 件数 |")
    lines.append(f"|---|---|")
    lines.append(f"| ✅ 成功 | {total_passed}件 |")
    lines.append(f"| ❌ 失敗 | {total_failed}件 |")
    lines.append(f"| ⏭ スキップ | {total_skipped}件 |")
    lines.append(f"| 合計 | {total}件 |")
    lines.append(f"| 通過率 | {pass_rate}% |")
    lines.append(f"")

    # ===== エージェント別サマリー =====
    lines.append(f"## 🤖 エージェント別結果")
    lines.append(f"")
    lines.append(f"| エージェント | 成功 | 失敗 | スキップ | テスト環境 |")
    lines.append(f"|---|---|---|---|---|")
    for agent_name, results in agent_results.items():
        p = sum(1 for r in results if r["status"] == "passed")
        f = sum(1 for r in results if r["status"] == "failed")
        s = sum(1 for r in results if r["status"] == "skipped")
        env_path = REPORTS_DIR / agent_name / "test_env.txt"
        env = env_path.read_text().strip() if env_path.exists() else "-"
        lines.append(f"| {agent_name} | {p} | {f} | {s} | {env} |")
    lines.append(f"")

    # ===== あなたが対応すべきこと =====
    lines.append(f"## 🚨 あなたが対応すべきこと")
    lines.append(f"")

    if not all_bugs and total_failed == 0:
        lines.append(f"✅ **対応不要です。** 全テスト通過しました。")
    else:
        if all_bugs:
            lines.append(f"### 不具合（要対応）")
            lines.append(f"")
            for agent_name, report in all_bugs:
                lines.append(f"**{agent_name} 報告:**")
                lines.append(f"")
                # 報告の最初の500文字だけ
                lines.append(report[:500])
                if len(report) > 500:
                    lines.append(f"... (詳細: reports/{agent_name}/claude_report.md)")
                lines.append(f"")

        if total_failed > 0 and not all_bugs:
            lines.append(f"### ⚠️ テスト失敗あり（Claudeが調査中 or 調査済み）")
            lines.append(f"")
            lines.append(f"失敗テストはClaudeが仕様変更か不具合かを調査しました。")
            lines.append(f"不具合と判定されたものは上記「不具合」セクションに記載されます。")
            lines.append(f"")

    lines.append(f"---")
    lines.append(f"")

    # ===== 失敗テスト一覧 =====
    if all_failures:
        lines.append(f"## ❌ 失敗テスト一覧")
        lines.append(f"")
        for agent_name, r in all_failures:
            lines.append(f"### `{r['scenario']}` ({agent_name})")
            for e in r.get("errors", [])[:3]:
                lines.append(f"- **{e.get('type', '')}**: {e.get('message', '')[:200]}")
            if r.get("screenshot"):
                ss = Path(r["screenshot"]).name
                lines.append(f"- 📸 スクリーンショット: `reports/{agent_name}/screenshots/{ss}`")
            lines.append(f"")

    # ===== スキップ一覧 =====
    all_skipped_list = [
        (agent_name, r)
        for agent_name, results in agent_results.items()
        for r in results if r["status"] == "skipped"
    ]
    if all_skipped_list:
        lines.append(f"## ⏭ スキップ一覧（タイムアウト等）")
        lines.append(f"")
        for agent_name, r in all_skipped_list:
            msg = r.get("errors", [{}])[0].get("message", "")
            lines.append(f"- `{r['scenario']}` ({agent_name}): {msg}")
        lines.append(f"")

    lines.append(f"---")
    lines.append(f"*このレポートは PigeonCloud テストエージェントにより自動生成されました*")

    return "\n".join(lines)


def notify_slack_summary(agent_results: dict, all_bugs: list):
    if not SLACK_WEBHOOK_URL:
        return

    total_passed = sum(
        1 for results in agent_results.values()
        for r in results if r["status"] == "passed"
    )
    total_failed = sum(
        1 for results in agent_results.values()
        for r in results if r["status"] == "failed"
    )
    total = sum(len(results) for results in agent_results.values())
    pass_rate = round(total_passed / total * 100, 1) if total > 0 else 0

    if total_failed == 0 and not all_bugs:
        icon = "✅"
        status = "全テスト通過"
    elif all_bugs:
        icon = "🚨"
        status = f"不具合あり（要確認）"
    else:
        icon = "⚠️"
        status = f"失敗あり（調査済み）"

    text = (
        f"<@{SLACK_NOTIFY_USER_ID}> {icon} 【PigeonCloud テスト完了】{status}\n"
        f"✅ {total_passed}件成功 / ❌ {total_failed}件失敗 / 全{total}件 ({pass_rate}%)\n"
        f"エージェント: {len(agent_results)}台\n"
        f"詳細: reports/final_report.md を確認してください"
    )

    if all_bugs:
        text += f"\n\n🚨 *不具合報告あり* — 対応が必要です"

    try:
        requests.post(SLACK_WEBHOOK_URL, json={"text": text}, timeout=10)
        print("Slack通知を送信しました")
    except Exception as e:
        print(f"Slack通知失敗: {e}")


def main():
    agent_results = load_agent_results()
    claude_reports = load_agent_claude_reports()

    if not agent_results:
        print("エージェント結果が見つかりません（reports/agent-*/results.json）")
        return

    print(f"集計対象: {list(agent_results.keys())}")

    report = generate_final_report(agent_results, claude_reports)

    out_path = REPORTS_DIR / "final_report.md"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"レポート生成: {out_path}")

    # 不具合抽出
    all_bugs = [
        (agent_name, r)
        for agent_name, report_text in claude_reports.items()
        for r in [report_text]
        if "不具合" in report_text or "バグ" in report_text
    ]

    notify_slack_summary(agent_results, all_bugs)


if __name__ == "__main__":
    main()
