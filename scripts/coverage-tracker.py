import os
import json
import re
import argparse
from datetime import datetime

GAP_MATRIX_PATH = "/tmp/gap-matrix.json"
OUTPUT_PATH = ".claude/coverage-tracker.json"
TESTS_DIR = "tests"

def load_requirements():
    if not os.path.exists(GAP_MATRIX_PATH):
        raise FileNotFoundError(f"Gap matrix not found at {GAP_MATRIX_PATH}")
        
    with open(GAP_MATRIX_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    requirements = []
    for item in data:
        if item.get('type') == 'requirement':
            requirements.append(item)
    
    # Assign R-XXX IDs based on index
    mapped_reqs = {}
    for i, req in enumerate(requirements, 1):
        req_id = f"R-{i:03d}"
        mapped_reqs[req_id] = {
            "requirement": req.get("item"),
            "feature_area": req.get("feature_area"),
            "priority": req.get("priority"),
            "covered_by": [],
            "status": "uncovered"
        }
    return mapped_reqs

def scan_tests(mapped_reqs):
    # Regex patterns
    # Handles: @requirements.txt(R-001), @requirements.txt R-001, // @requirements.txt R-001
    tag_pattern = re.compile(r"@requirements\.txt(?:\s*\(?\s*)(R-\d{3})(?:\s*\)?)?")
    # Handles: [req:R-001], test('req:R-001', ...)
    title_pattern = re.compile(r"\[?req:(R-\d{3})\]?")
    
    if not os.path.exists(TESTS_DIR):
        print(f"Warning: Tests directory '{TESTS_DIR}' not found.")
        return

    for root, _, files in os.walk(TESTS_DIR):
        for file in files:
            if file.endswith(".spec.js") or file.endswith(".test.js"):
                path = os.path.join(root, file)
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        lines = f.readlines()
                        for i, line in enumerate(lines, 1):
                            # Check for tags in comments or code
                            tags = tag_pattern.findall(line)
                            # Check for tags in test titles
                            titles = title_pattern.findall(line)
                            
                            found_ids = set(tags + titles)
                            for rid in found_ids:
                                if rid in mapped_reqs:
                                    match_info = f"{path}:{i}: {line.strip()}"
                                    if match_info not in mapped_reqs[rid]["covered_by"]:
                                        mapped_reqs[rid]["covered_by"].append(match_info)
                                        mapped_reqs[rid]["status"] = "covered"
                except Exception as e:
                    print(f"Error reading {path}: {e}")

def generate_report():
    mapped_reqs = load_requirements()
    scan_tests(mapped_reqs)
    
    total = len(mapped_reqs)
    covered = sum(1 for r in mapped_reqs.values() if r["status"] == "covered")
    uncovered = total - covered
    rate = round(covered / total, 2) if total > 0 else 0
    
    # Calculate summary by feature area
    feature_stats = {}
    for rid, data in mapped_reqs.items():
        fa = data["feature_area"] or "Unknown"
        if fa not in feature_stats:
            feature_stats[fa] = {"total": 0, "covered": 0}
        feature_stats[fa]["total"] += 1
        if data["status"] == "covered":
            feature_stats[fa]["covered"] += 1
            
    for fa in feature_stats:
        fs = feature_stats[fa]
        fs["coverage_rate"] = round(fs["covered"] / fs["total"], 2) if fs["total"] > 0 else 0

    report = {
        "generated_at": datetime.now().isoformat(),
        "summary": {
            "total_requirements": total,
            "covered": covered,
            "uncovered": uncovered,
            "coverage_rate": rate,
            "feature_area_summary": feature_stats
        },
        "mapping": mapped_reqs
    }
    
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    
    print(f"Generated {OUTPUT_PATH}")
    print(f"Total: {total}, Covered: {covered}, Uncovered: {uncovered}, Rate: {rate:.2%}")

def check_report():
    if not os.path.exists(OUTPUT_PATH):
        print(f"Report not found at {OUTPUT_PATH}. Run with --generate first.")
        return
    
    with open(OUTPUT_PATH, 'r', encoding='utf-8') as f:
        report = json.load(f)
    
    summary = report["summary"]
    print("=== Coverage Summary ===")
    print(f"Total Requirements: {summary['total_requirements']}")
    print(f"Covered:           {summary['covered']}")
    print(f"Uncovered:         {summary['uncovered']}")
    print(f"Coverage Rate:     {summary['coverage_rate']:.2%}")
    print("\n=== Feature Area Summary ===")
    fa_summary = summary.get("feature_area_summary", {})
    # Sort by total requirements descending
    sorted_fas = sorted(fa_summary.items(), key=lambda x: x[1]["total"], reverse=True)
    for fa, stats in sorted_fas:
        print(f"{fa:30}: {stats['covered']}/{stats['total']} ({stats['coverage_rate']:.0%})")
    print("=========================")

def list_uncovered():
    if not os.path.exists(OUTPUT_PATH):
        print(f"Report not found at {OUTPUT_PATH}. Run with --generate first.")
        return
    
    with open(OUTPUT_PATH, 'r', encoding='utf-8') as f:
        report = json.load(f)
    
    mapping = report["mapping"]
    uncovered = [
        {"id": rid, **data} 
        for rid, data in mapping.items() 
        if data["status"] == "uncovered"
    ]
    
    # Sort by priority: high > medium > low
    priority_map = {"high": 0, "medium": 1, "low": 2}
    uncovered.sort(key=lambda x: (priority_map.get(x["priority"], 3), x["id"]))
    
    print("=== Uncovered Requirements (Sorted by Priority) ===")
    for item in uncovered:
        print(f"[{item['id']}] ({item['priority']:6}) {item['feature_area']:25}: {item['requirement']}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Coverage Tracker for Requirements")
    parser.add_argument("--generate", action="store_true", help="Generate coverage-tracker.json")
    parser.add_argument("--check", action="store_true", help="Display summary report")
    parser.add_argument("--uncovered", action="store_true", help="List uncovered requirements")
    
    args = parser.parse_args()
    
    if args.generate:
        generate_report()
    elif args.check:
        check_report()
    elif args.uncovered:
        list_uncovered()
    else:
        parser.print_help()
