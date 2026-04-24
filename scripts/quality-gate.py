import os
import sys
import re
import json
import argparse
import yaml

class QualityGate:
    def __init__(self):
        self.violations = []
        self.file_stats = {} # file_path -> {"tests": N, "violations": M}

    def report_violation(self, file_path, line_num, message):
        self.violations.append({
            "file": file_path,
            "line": line_num,
            "message": message
        })
        if file_path not in self.file_stats:
            self.file_stats[file_path] = {"tests": 0, "violations": 0}
        self.file_stats[file_path]["violations"] += 1

    def check_js_file(self, file_path):
        if file_path not in self.file_stats:
            self.file_stats[file_path] = {"tests": 0, "violations": 0}

        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
        except Exception as e:
            self.report_violation(file_path, 0, f"Error reading file: {e}")
            return

        content = "".join(lines)
        
        # Count tests and steps
        # test('...', ...) or test.step('...', ...)
        test_matches = re.findall(r"test\s*\(\s*['\"]", content)
        test_step_matches = re.findall(r"test\.step\(\s*['\"]", content)
        self.file_stats[file_path]["tests"] = len(test_matches) + len(test_step_matches)

        # Rule 1: test.skip() new additions
        for i, line in enumerate(lines, 1):
            if "test.skip(" in line:
                if "fileBeforeAllFailed" not in line:
                    self.report_violation(file_path, i, "test.skip without justification comment (fileBeforeAllFailed)")

        # Rule 2: expect(x || true).toBeTruthy()
        for i, line in enumerate(lines, 1):
            if re.search(r"expect\(.*\|\|.*true\)\.toBeTruthy\(\)", line):
                self.report_violation(file_path, i, "Trivial assertion: expect(x || true).toBeTruthy()")
            elif re.search(r"expect\(\s*true\s*\)\.toBeTruthy\(\)", line):
                 self.report_violation(file_path, i, "Trivial assertion: expect(true).toBeTruthy()")

        # Rule 3: waitForTimeout(N) with N >= 10000
        for i, line in enumerate(lines, 1):
            match = re.search(r"waitForTimeout\(\s*(\d+)\s*\)", line)
            if match:
                timeout = int(match.group(1))
                if timeout >= 10000:
                    self.report_violation(file_path, i, f"waitForTimeout({timeout}) exceeds 10s limit")

        # Rule 6: Commented out expect
        for i, line in enumerate(lines, 1):
            # Check if line starts with optional whitespace, then //, then optional whitespace, then expect(
            if re.search(r"^\s*//\s*expect\(", line):
                self.report_violation(file_path, i, "Commented out expect assertion")

        # Rule 4 & 5 & 7: Test block analysis
        self._analyze_js_test_blocks(file_path, content)

    def _analyze_js_test_blocks(self, file_path, content):
        # Find test(...) or test.step(...) blocks
        # This is an approximation for multi-line blocks
        test_pattern = re.compile(r"((?:test|test\.step)\s*\(\s*['\"].*?['\"].*?async.*?\{)(.*?)(\n\s*\}\s*\)\s*;|\n\s*\}\s*\))", re.DOTALL)

        for match in test_pattern.finditer(content):
            header = match.group(1)
            body = match.group(2)

            # Find line number
            line_num = content.count('\n', 0, match.start()) + 1

            test_name_match = re.search(r"['\"](.*?)['\"]", header)
            test_name = test_name_match.group(1) if test_name_match else "unknown"

            # Rule 4: Zero assertions
            if "expect(" not in body:
                self.report_violation(file_path, line_num, f"test '{test_name}' has no expect/assertion")
            else:
                # Rule 5: Only navbar/ISE check
                # Find all expect calls in this body
                expects = re.findall(r"expect\(.*?\)\..*?\(.*?\)", body)
                if len(expects) > 0:
                    is_only_generic = True
                    for exp in expects:
                        is_navbar = ".navbar" in exp or "navbar" in exp
                        is_ise = "Internal Server Error" in exp or "ISE" in exp
                        if not (is_navbar or is_ise):
                            is_only_generic = False
                            break
                    if is_only_generic:
                        self.report_violation(file_path, line_num, f"test '{test_name}' only checks navbar and/or Internal Server Error")

            # Rule 7: @requirements.txt(ID) tag missing
            # test ブロック本体だけでなく、直前の JSDoc コメント（/** ... */）も検査対象に含める。
            # タグは `@requirements.txt(R-XXX)` または `[req:R-XXX]` を許容する。
            # JSDoc は test 宣言の直前 500 文字以内に現れる最後のコメントブロックを参照する。
            before = content[max(0, match.start() - 500):match.start()]
            jsdoc_m = re.search(r"/\*\*[\s\S]*?\*/\s*$", before)
            jsdoc = jsdoc_m.group(0) if jsdoc_m else ''
            haystack = jsdoc + header + body
            if not re.search(r"@requirements\.txt\s*\(\s*R-\d{3}(?:\s*,\s*R-\d{3})*\s*\)|\[req:R-\d{3}\]", haystack):
                self.report_violation(file_path, line_num, f"test '{test_name}' is missing @requirements.txt(ID) tag")

    def check_yaml_file(self, file_path):
        if file_path not in self.file_stats:
            self.file_stats[file_path] = {"tests": 0, "violations": 0}

        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f)
        except Exception as e:
            self.report_violation(file_path, 0, f"YAML parse error: {e}")
            return

        if not data: return

        cases = data.get('cases', [])
        if not cases and 'steps' in data:
            cases = [data]

        self.file_stats[file_path]["tests"] = len(cases)

        for case in cases:
            case_no = case.get('case_no', 'unknown')
            assertions = case.get('assertions', [])
            
            # Rule 4: Zero assertions
            if not assertions:
                self.report_violation(file_path, 1, f"case '{case_no}' has no assertions")
            else:
                # Rule 5: Only navbar/ISE
                is_only_generic = True
                has_real_assertion = False
                for ass in assertions:
                    if ass.get('type') == 'comment': continue
                    
                    has_real_assertion = True
                    val = str(ass.get('value', ''))
                    sel = str(ass.get('selector', ''))
                    
                    is_navbar = ".navbar" in sel or "navbar" in sel
                    is_ise = "Internal Server Error" in val
                    
                    if not (is_navbar or is_ise):
                        is_only_generic = False
                        break
                
                if has_real_assertion and is_only_generic:
                    self.report_violation(file_path, 1, f"case '{case_no}' only checks navbar and/or Internal Server Error")
                elif not has_real_assertion:
                    self.report_violation(file_path, 1, f"case '{case_no}' has only comment assertions")

            # Rule 7: Requirements tag in description
            desc = case.get('description', '')
            if not re.search(r"@requirements\.txt\(R-\d{3}\)|\[req:R-\d{3}\]", desc):
                # self.report_violation(file_path, 1, f"case '{case_no}' is missing @requirements.txt(ID) tag")
                pass

    def run(self, files, json_output=False):
        for f in files:
            if f.endswith('.spec.js'):
                self.check_js_file(f)
            elif f.endswith('.yaml') or f.endswith('.yml'):
                self.check_yaml_file(f)

        if json_output:
            print(json.dumps(self.violations, indent=2, ensure_ascii=False))
        else:
            self.print_summary()

        return 1 if self.violations else 0

    def print_summary(self):
        all_paths = sorted(self.file_stats.keys())
        passed_count = 0
        total_violations = 0
        for path in all_paths:
            stats = self.file_stats[path]
            v_count = stats["violations"]
            t_count = stats["tests"]
            total_violations += v_count
            
            if v_count == 0:
                print(f"✓ {path}: {t_count} tests, 0 violations")
                passed_count += 1
            else:
                print(f"✗ {path}: {t_count} tests, {v_count} violations:")
                # Print violations for this file
                for v in self.violations:
                    if v['file'] == path:
                        line_info = f"L{v['line']}: " if v['line'] > 0 else ""
                        print(f"  - {line_info}{v['message']}")
        
        print("\n" + "="*50)
        print(f"SUMMARY:")
        print(f"  Files checked: {len(all_paths)}")
        print(f"  Passed:        {passed_count}")
        print(f"  Failed:        {len(all_paths) - passed_count}")
        print(f"  Total violations: {total_violations}")
        print("="*50)

def main():
    parser = argparse.ArgumentParser(description="E2E Spec/YAML Quality Gate")
    parser.add_argument("files", nargs="*", help="Files to check")
    parser.add_argument("--all", action="store_true", help="Check all spec.js and yaml files in tests/ and specs/")
    parser.add_argument("--json", action="store_true", help="Output in JSON format")
    
    args = parser.parse_args()
    
    target_files = args.files
    if args.all:
        # Search for .spec.js in tests/ and .yaml in specs/
        for root, _, files in os.walk("tests"):
            for f in files:
                if f.endswith(".spec.js"):
                    target_files.append(os.path.join(root, f))
        for root, _, files in os.walk("specs"):
            for f in files:
                if f.endswith(".yaml") or f.endswith(".yml"):
                    target_files.append(os.path.join(root, f))

    if not target_files:
        print("No files specified. Use --all or provide file paths.")
        sys.exit(0)

    gate = QualityGate()
    exit_code = gate.run(target_files, json_output=args.json)
    sys.exit(exit_code)

if __name__ == "__main__":
    main()
