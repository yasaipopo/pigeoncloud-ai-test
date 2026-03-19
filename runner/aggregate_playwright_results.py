"""
Playwright JSON結果を集約してシート書き込み用 results.json を生成する

使い方:
  python runner/aggregate_playwright_results.py               # 全spec集約 → reports/results.json 更新
  python runner/aggregate_playwright_results.py --dry-run     # 集計のみ（書き込みなし）
  python runner/aggregate_playwright_results.py --spec auth   # 特定specのみ
  python runner/aggregate_playwright_results.py --all-agents  # 最新agentだけでなく全agentを使用

データソース（優先順位順）:
  1. playwright-results.json（Playwright JSON reporter出力・最優先）
  2. repair_run.log / initial_run.log（テキストログ・フォールバック）

出力形式 (reports/results.json):
  [
    {"scenario": "auth/1-1", "status": "passed",  "agent": 92, "file": "auth.spec.js"},
    {"scenario": "auth/1-2", "status": "skipped", "agent": 92, "file": "auth.spec.js"},
    ...
  ]
"""

import json
import re
import argparse
from pathlib import Path
from collections import defaultdict

REPORTS_DIR = Path(__file__).parent.parent / "reports"
OUTPUT_PATH = REPORTS_DIR / "results.json"

# ステータスのマッピング（Playwright → シート用）
STATUS_MAP = {
    "passed":    "passed",
    "failed":    "failed",
    "skipped":   "skipped",
    "timedOut":  "failed",
    "interrupted": "failed",
}

# repair_run.log の行パターン
# 例: "  ✓   1 [chromium] › tests/auth.spec.js:87:5 › Suite › 1-1: description (17.3s)"
# 例: "  ✗   3 [chromium] › tests/auth.spec.js:... › 1-3: description (5.0s)"
# 例: "  -   5 [chromium] › tests/auth.spec.js:... › 54-3: description"
LOG_LINE_RE = re.compile(
    r"^\s*([✓✗✘×\-–])\s+\d+\s+\[chromium\]\s+›\s+tests/(\w[\w-]+)\.spec\.js:\d+:\d+\s+›\s+.*?›\s+(.+?)(?:\s+\(\d+(?:\.\d+)?[smh]\))?\s*$"
)
CASE_NO_RE = re.compile(r"^([\d]+-[\d]+(?:-[\d]+)*|[\d]+)\s*[：:]")


def parse_playwright_json(json_path: Path, spec_name: str) -> dict[str, str]:
    """
    playwright-results.json を解析して {case_no: status} を返す。
    case_no は test title の先頭 "NNN-N:" から抽出。
    """
    try:
        data = json.loads(json_path.read_text())
    except Exception as e:
        print(f"  ⚠ 読み込みエラー: {json_path} ({e})")
        return {}

    results = {}

    def walk(node):
        for spec in node.get("specs", []):
            title = spec.get("title", "")
            m = CASE_NO_RE.match(title)
            if not m:
                continue
            case_no = m.group(1)

            # tests の最後の result を採用（retry考慮）
            for test in spec.get("tests", []):
                test_results = test.get("results", [])
                if test_results:
                    raw = test_results[-1].get("status", "skipped")
                else:
                    raw = test.get("status", "skipped")
                status = STATUS_MAP.get(raw, "skipped")
                # passed が一度でもあれば passed を優先
                if case_no not in results or status == "passed":
                    results[case_no] = status

        for child in node.get("suites", []):
            walk(child)

    for suite in data.get("suites", []):
        walk(suite)

    return results


def parse_log_file(log_path: Path) -> dict[str, dict[str, str]]:
    """
    repair_run.log / initial_run.log を解析して {spec_name: {case_no: status}} を返す。
    ✓ = passed, ✗/× = failed, - = skipped
    """
    try:
        lines = log_path.read_text(errors="replace").splitlines()
    except Exception as e:
        print(f"  ⚠ ログ読み込みエラー: {log_path} ({e})")
        return {}

    spec_results: dict[str, dict[str, str]] = defaultdict(dict)

    for line in lines:
        m = LOG_LINE_RE.match(line)
        if not m:
            continue
        mark, spec_name, title = m.group(1), m.group(2), m.group(3).strip()

        cn_m = CASE_NO_RE.match(title)
        if not cn_m:
            continue
        case_no = cn_m.group(1)

        if mark == "✓":
            status = "passed"
        elif mark in ("✗", "✘", "×"):
            status = "failed"
        else:  # - or –
            status = "skipped"

        # passed が一度でもあれば passed を優先
        prev = spec_results[spec_name].get(case_no)
        if prev != "passed":
            spec_results[spec_name][case_no] = status

    return dict(spec_results)


def collect_agent_sources() -> dict[str, dict[int, tuple[str, Path]]]:
    """
    全agentディレクトリを走査して、spec → {agent_num: (source_type, path)} を返す。
    source_type: "json" | "log"
    """
    # spec → {agent_num: (source_type, path)}
    spec_agents: dict[str, dict[int, tuple[str, Path]]] = defaultdict(dict)

    for agent_dir in sorted(REPORTS_DIR.glob("agent-*")):
        try:
            agent_num = int(agent_dir.name.split("-")[1])
        except (ValueError, IndexError):
            continue

        # 1) playwright-results.json（優先）
        json_path = agent_dir / "playwright-results.json"
        if json_path.exists():
            try:
                raw = json_path.read_text()
                for m in re.finditer(r'"file":\s*"(\w[\w-]*?)\.spec\.js"', raw):
                    spec_name = m.group(1)
                    # jsonソースは常にlogより優先
                    existing = spec_agents[spec_name].get(agent_num)
                    if existing is None or existing[0] == "log":
                        spec_agents[spec_name][agent_num] = ("json", json_path)
            except Exception:
                pass

        # 2) repair_run.log / initial_run.log（フォールバック）
        for log_name in ("repair_run.log", "initial_run.log"):
            log_path = agent_dir / log_name
            if not log_path.exists():
                continue
            try:
                raw = log_path.read_text(errors="replace")
                detected_specs = set(re.findall(r"tests/(\w[\w-]+)\.spec\.js", raw))
                for spec_name in detected_specs:
                    if agent_num not in spec_agents[spec_name]:
                        spec_agents[spec_name][agent_num] = ("log", log_path)
            except Exception:
                pass

    return dict(spec_agents)


def aggregate(spec_filter: str | None = None, latest_only: bool = False) -> list[dict]:
    """全specの結果を集約して records のリストを返す

    マージ戦略:
    - 古いagentから順に処理し、新しいagentが上書き（passed/failedのみ）
    - 新しいagentが "skipped" の場合は古い結果を保持（環境失敗によるall-skippedを無視）
    - latest_only=True の場合は最新agentのみ使用（passed/failedが0でも適用）
    """
    all_records: dict[str, dict] = {}  # "spec/case_no" -> record

    # データソース収集
    spec_agents = collect_agent_sources()

    if not spec_agents:
        print("データソースが見つかりませんでした")
        return []

    # specフィルタ
    if spec_filter:
        spec_agents = {k: v for k, v in spec_agents.items() if k == spec_filter}

    # 各specについて処理
    for spec_name in sorted(spec_agents.keys()):
        agents = spec_agents[spec_name]
        if latest_only:
            agent_num = max(agents.keys())
            agent_map = {agent_num: agents[agent_num]}
        else:
            # 全agent・古い順で処理（新しいものが上書き）
            agent_map = agents

        for agent_num, (source_type, source_path) in sorted(agent_map.items()):
            if source_type == "json":
                case_results = parse_playwright_json(source_path, spec_name)
                source_label = "playwright-results.json"
            else:
                log_results = parse_log_file(source_path)
                case_results = log_results.get(spec_name, {})
                source_label = source_path.name

            if not case_results:
                continue

            # 全件skippedの場合は環境失敗とみなしてスキップ（latest_only=Falseのみ）
            actual_runs = sum(1 for s in case_results.values() if s in ("passed", "failed"))
            if not latest_only and actual_runs == 0:
                continue

            for case_no, status in case_results.items():
                key = f"{spec_name}/{case_no}"
                if not latest_only:
                    # マージモード: passed/failedは常に上書き、skippedは既存がなければセット
                    prev = all_records.get(key)
                    if status in ("passed", "failed") or prev is None:
                        all_records[key] = {
                            "scenario": key,
                            "status": status,
                            "agent": agent_num,
                            "file": f"{spec_name}.spec.js",
                            "errors": [],
                        }
                else:
                    all_records[key] = {
                        "scenario": key,
                        "status": status,
                        "agent": agent_num,
                        "file": f"{spec_name}.spec.js",
                        "errors": [],
                    }

            p = sum(1 for s in case_results.values() if s == "passed")
            f = sum(1 for s in case_results.values() if s == "failed")
            s = sum(1 for s in case_results.values() if s == "skipped")
            print(f"  {spec_name} (agent-{agent_num}, {source_label}): {len(case_results)}件 "
                  f"(passed={p} failed={f} skipped={s})")

    return list(all_records.values())


def print_summary(records: list[dict]):
    """spec別サマリーを表示"""
    from collections import Counter
    spec_stats: dict[str, Counter] = defaultdict(Counter)
    for r in records:
        spec = r["scenario"].split("/")[0]
        spec_stats[spec][r["status"]] += 1

    total_p = total_f = total_s = 0
    print("\n📊 集計サマリー:")
    print(f"{'spec':<25} {'passed':>8} {'failed':>8} {'skipped':>8} {'計':>6}")
    print("-" * 60)
    for spec in sorted(spec_stats.keys()):
        c = spec_stats[spec]
        p, f, s = c["passed"], c["failed"], c["skipped"]
        total_p += p; total_f += f; total_s += s
        flag = " ❌" if f > 0 else ""
        print(f"{spec:<25} {p:>8} {f:>8} {s:>8} {p+f+s:>6}{flag}")
    print("-" * 60)
    print(f"{'合計':<25} {total_p:>8} {total_f:>8} {total_s:>8} {total_p+total_f+total_s:>6}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Playwright結果を集約してresults.jsonを更新")
    parser.add_argument("--dry-run",     action="store_true",  help="集計のみ（ファイル書き込みなし）")
    parser.add_argument("--spec",        default=None,         help="特定specのみ集約 (例: auth)")
    parser.add_argument("--latest-only", action="store_true",  help="各specの最新agentのみ使用（デフォルト: 全agent結果をマージ）")
    args = parser.parse_args()

    print("=== Playwright結果集約 ===")
    records = aggregate(
        spec_filter=args.spec,
        latest_only=args.latest_only,
    )

    print_summary(records)

    if not args.dry_run:
        OUTPUT_PATH.write_text(json.dumps(records, ensure_ascii=False, indent=2))
        print(f"\n✅ {OUTPUT_PATH} に {len(records)}件 書き込みました")
    else:
        print(f"\n[DRY RUN] {len(records)}件（書き込みなし）")
