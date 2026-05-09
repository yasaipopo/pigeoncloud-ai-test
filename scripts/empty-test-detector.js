#!/usr/bin/env node
// 偽装テスト・空テスト検出スクリプト (AST ベース)
// 用途: tests/*.spec.js を解析し、ルール違反を機械的に検出
// 出力: .claude/local/empty-test-detector-result.{json,md}
//
// 検出カテゴリ:
//   A: 偽装テスト (navbar/ISE 不在のみ、try-catch 握り潰し、assertion 0 件)
//   B: assertion 緩和 (expect(true) / count >= 0 / .catch(() => {}))
//   C: タイトル不一致 (タイトル動詞と内容の乖離)
//   D: 記法違反 ([flow]/[check] 欠落、waitForTimeout、first() 多用)
//   E: プロダクトバグ隠蔽 (assertion を緩めて pass)
//   F: 不正スキップ (test.skip(true))

const fs = require('fs');
const path = require('path');
const { parse } = require('acorn');
const walk = require('acorn-walk');

const TESTS_DIR = path.resolve(__dirname, '..', 'tests');
const OUT_DIR = path.resolve(__dirname, '..', '.claude', 'local');
const OUT_JSON = path.join(OUT_DIR, 'empty-test-detector-result.json');
const OUT_MD = path.join(OUT_DIR, 'empty-test-detector-result.md');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function getNodeText(src, node) {
    return src.slice(node.start, node.end);
}

function getCalleeName(callee) {
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression') {
        const obj = getCalleeName(callee.object);
        const prop = callee.property.type === 'Identifier' ? callee.property.name : '?';
        return `${obj}.${prop}`;
    }
    return '?';
}

function findLineCol(src, offset) {
    const before = src.slice(0, offset);
    const lines = before.split('\n');
    return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

function isTestCall(node) {
    if (node.type !== 'CallExpression') return null;
    if (node.arguments.length < 2) return null;
    // test('title-string', async () => {...}) のみ test 定義として認識
    // test.skip(condition, 'message') / test.skip(condition) はスキップ文なので除外
    const arg0 = node.arguments[0];
    const arg1 = node.arguments[1];
    const arg0IsTitle = (arg0.type === 'Literal' && typeof arg0.value === 'string') ||
                        (arg0.type === 'TemplateLiteral');
    const arg1IsFunc = arg1.type === 'ArrowFunctionExpression' || arg1.type === 'FunctionExpression';
    if (!arg0IsTitle || !arg1IsFunc) return null;

    const callee = node.callee;
    if (callee.type === 'Identifier' && callee.name === 'test') return 'test';
    if (callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' && callee.object.name === 'test') {
        const propName = callee.property.name;
        // test.step は外側 test 内部の step 呼び出しなので、独立検出対象から除外
        // (二重カウント防止)
        if (propName === 'step') return null;
        if (['only', 'fail', 'fixme', 'skip'].includes(propName)) {
            return `test.${propName}`;
        }
    }
    return null;
}

function getStringLiteral(arg) {
    if (!arg) return null;
    if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
    if (arg.type === 'TemplateLiteral' && arg.quasis.length === 1) return arg.quasis[0].value.cooked;
    return null;
}

// expect の弱さ判定
const WEAK_EXPECT_PATTERNS = [
    // expect(...).not.toContain('Internal Server Error')
    /\.not\.toContain\(\s*['"`]Internal Server Error['"`]\s*\)/,
    // expect(true).toBeTruthy() / expect(true).toBe(true)
    /expect\(\s*true\s*\)\.(toBeTruthy|toBe)\(/,
    // expect(x || true)
    /expect\([^)]*\|\|\s*true\s*\)/,
    // expect(x).toBeGreaterThanOrEqual(0) — 常に true
    /\.toBeGreaterThanOrEqual\(\s*0\s*\)/,
];

const NAVBAR_VISIBLE_PATTERN = /\.locator\(\s*['"`]\.navbar['"`]\s*\)\s*\)\.toBeVisible/;
const NAVBAR_VISIBLE_PATTERN_V2 = /['"`]\.navbar['"`].*?toBeVisible/s;

// タイトルから「具体的操作動詞」を抽出 (タイトル不一致判定用)
const ACTION_VERBS = ['削除', '追加', '作成', '変更', '更新', '保存', '入力', 'クリック', 'D&D', 'ドラッグ', '入れ替え', '並び替え', 'カンマ', '色がつく', '反映', 'できること'];
const ACTION_API_HINTS = {
    '削除': /\.delete|削除|trash|removeRow|deleteRow/i,
    '追加': /\.click.*?(追加|追加する|新規|add|create)|fill.*?(name|title|用途)/i,
    '作成': /createTable|createUser|create-trial|新規|テーブル作成|レコード追加/i,
    '変更': /fill\(|selectOption|変更|update/i,
    '更新': /click.*?更新|保存|update/i,
    '保存': /click.*?保存|save/i,
    '入力': /\.fill\(|\.type\(/,
    'クリック': /\.click\(/,
    'D&D': /dragAndDrop|mouse\.move|mouse\.down/,
    'ドラッグ': /dragAndDrop|mouse\.move/,
    'カンマ': /,\\d|toMatch.*,/,
    '色がつく': /background|color|getComputedStyle/,
};

function analyzeTestBody(src, testNode, fileText) {
    const bodyStart = testNode.arguments[1] ? testNode.arguments[1].start : null;
    const bodyEnd = testNode.arguments[1] ? testNode.arguments[1].end : null;
    if (bodyStart === null) return null;

    const body = fileText.slice(bodyStart, bodyEnd);
    const title = getStringLiteral(testNode.arguments[0]) || '<unknown>';

    // expect 数
    const expectMatches = body.match(/\bexpect\s*\(/g) || [];
    const expectCount = expectMatches.length;

    // 弱い expect
    let weakExpectCount = 0;
    const weakReasons = [];
    for (const pat of WEAK_EXPECT_PATTERNS) {
        const m = body.match(new RegExp(pat.source, pat.flags + 'g'));
        if (m) {
            weakExpectCount += m.length;
            weakReasons.push(pat.source);
        }
    }
    // navbar.toBeVisible のみのケース
    const navbarVisibleCount = (body.match(/['"`]\.navbar['"`][^)]*\)\.toBeVisible/g) || []).length;

    // ISE 不在チェックの有無
    const hasIseNotContain = /\.not\.toContain\(\s*['"`]Internal Server Error['"`]\s*\)/.test(body);

    // .catch(() => {}) パターン
    const catchSwallowCount = (body.match(/\.catch\(\s*\(\s*[a-zA-Z_$]*\s*\)\s*=>\s*\{\s*\}\s*\)/g) || []).length;
    const catchSwallowReturnNull = (body.match(/\.catch\(\s*\(\s*[a-zA-Z_$]*\s*\)\s*=>\s*null\s*\)/g) || []).length;
    const catchSwallowReturnFalse = (body.match(/\.catch\(\s*\(\s*[a-zA-Z_$]*\s*\)\s*=>\s*false\s*\)/g) || []).length;
    const totalCatchSwallow = catchSwallowCount + catchSwallowReturnNull + catchSwallowReturnFalse;

    // 早期 return (test 関数内)
    const earlyReturnCount = (body.match(/^\s*return\s*;?\s*$/gm) || []).length;

    // try-catch + console.log
    const tryCatchSwallowCount = (body.match(/catch\s*\([^)]*\)\s*\{\s*console\.log/g) || []).length;

    // [flow] / [check] コメント有無
    const flowCommentCount = (body.match(/\/\/\s*\[flow\]/g) || []).length;
    const checkCommentCount = (body.match(/\/\/\s*\[check\]/g) || []).length;

    // waitForTimeout
    const waitForTimeoutCount = (body.match(/\bwaitForTimeout\s*\(/g) || []).length;

    // first() / nth()
    const firstCount = (body.match(/\.first\(\s*\)/g) || []).length;
    const nthCount = (body.match(/\.nth\(\s*\d+\s*\)/g) || []).length;

    // タイトル動詞と内容の不一致判定 (簡易)
    let titleMismatchVerbs = [];
    for (const verb of ACTION_VERBS) {
        if (title.includes(verb)) {
            const hint = ACTION_API_HINTS[verb];
            if (hint && !hint.test(body)) {
                titleMismatchVerbs.push(verb);
            }
        }
    }

    // スキップ判定 (カテゴリ F or 永続スキップ) — 偽装判定より前に評価が必要
    //   test.skip(true, '理由') は永続スキップ (機能廃止/外部依存等)、test-env-limitations.md に記録される前提で妥当
    //   test.skip(true) (理由なし) は不正スキップ
    //   test.skip(IS_TRIAL_ENV, ...) / test.skip(fileBeforeAllFailed, ...) は環境ガードで妥当
    let isImproperSkip = false;
    let isPermanentSkip = false;
    const permanentSkipPattern = /test\.skip\s*\(\s*true\s*,\s*['"`]/;
    if (permanentSkipPattern.test(body)) {
        isPermanentSkip = true;
    }
    if (!isPermanentSkip) {
        const improperSkipPattern = /test\.skip\s*\(\s*true\s*[,)]/;
        if (improperSkipPattern.test(body)) {
            isImproperSkip = true;
        }
    }

    // 偽装判定 (カテゴリ A 該当)
    //   永続スキップ (test.skip(true, '理由')) は偽装ではなく妥当な記録
    const isFakeTest = !isPermanentSkip && (
        // expect が 0 件
        expectCount === 0 ||
        // expect が全て弱いものだけ
        (expectCount > 0 && weakExpectCount + navbarVisibleCount >= expectCount) ||
        // ISE 不在チェック + navbar 可視のみ
        (hasIseNotContain && navbarVisibleCount > 0 && expectCount <= 2 + weakExpectCount)
    );

    // assertion 緩和判定 (カテゴリ B)
    const isWeakAssertion = weakExpectCount > 0 || totalCatchSwallow > 0;

    // タイトル不一致 (カテゴリ C)
    const isTitleMismatch = titleMismatchVerbs.length > 0;

    // 記法違反 (カテゴリ D)
    const violationsD = [];
    if (flowCommentCount === 0 && checkCommentCount === 0) violationsD.push('[flow]/[check] 欠落');
    if (waitForTimeoutCount > 0) violationsD.push(`waitForTimeout × ${waitForTimeoutCount}`);
    if (firstCount > 5) violationsD.push(`first() × ${firstCount}`);
    if (nthCount > 0) violationsD.push(`nth() × ${nthCount}`);

    const lineRange = {
        start: findLineCol(fileText, testNode.start).line,
        end: findLineCol(fileText, testNode.end).line,
    };

    const violations = [];
    if (isFakeTest) violations.push({ category: 'A', detail: `偽装テスト: expect=${expectCount} weak=${weakExpectCount} navbar=${navbarVisibleCount} ISE_check=${hasIseNotContain}` });
    if (isWeakAssertion) violations.push({ category: 'B', detail: `緩和: weak_expect=${weakExpectCount} catch_swallow=${totalCatchSwallow}` });
    if (isTitleMismatch) violations.push({ category: 'C', detail: `タイトル動詞 [${titleMismatchVerbs.join(',')}] と内容の乖離` });
    if (violationsD.length > 0) violations.push({ category: 'D', detail: violationsD.join(', ') });
    if (tryCatchSwallowCount > 0) violations.push({ category: 'E', detail: `try-catch+console.log握り潰し × ${tryCatchSwallowCount}` });
    if (isImproperSkip) violations.push({ category: 'F', detail: 'test.skip(true) 固定スキップ' });
    if (earlyReturnCount > 0) violations.push({ category: 'A', detail: `早期 return × ${earlyReturnCount}` });

    return {
        title,
        line: lineRange,
        expectCount,
        weakExpectCount,
        navbarVisibleCount,
        hasIseNotContain,
        flowCommentCount,
        checkCommentCount,
        waitForTimeoutCount,
        firstCount,
        nthCount,
        catchSwallowCount: totalCatchSwallow,
        tryCatchSwallowCount,
        earlyReturnCount,
        titleMismatchVerbs,
        violations,
        isFakeTest,
        isPermanentSkip,
        isImproperSkip,
    };
}

/**
 * spec 内のヘルパー関数定義をすべて抽出 (function name(){...} / const name = async ...)
 * 戻り値: Map<関数名, { expectCount, body }>
 *
 * これにより `await verifyCrud(...)` のようなヘルパー呼び出しが
 * 内部 expect を持つかを判定できるようにする (AST false positive 削減)
 */
function extractHelpers(ast, src) {
    const helpers = new Map();

    function recordHelper(name, bodyStart, bodyEnd) {
        if (!name || bodyStart == null) return;
        const body = src.slice(bodyStart, bodyEnd);
        const expectCount = (body.match(/\bexpect\s*\(/g) || []).length;
        helpers.set(name, { expectCount, bodyLength: body.length });
    }

    walk.simple(ast, {
        FunctionDeclaration(node) {
            if (node.id && node.id.name) {
                recordHelper(node.id.name, node.body.start, node.body.end);
            }
        },
        VariableDeclarator(node) {
            // const x = async () => {...} / function () {...}
            if (node.id && node.id.name && node.init && (
                node.init.type === 'ArrowFunctionExpression' ||
                node.init.type === 'FunctionExpression'
            )) {
                recordHelper(node.id.name, node.init.body.start, node.init.body.end);
            }
        }
    });

    return helpers;
}

/**
 * test body 内のヘルパー呼び出しを集計し、内部 expect を加算する
 */
function expandHelperExpects(body, helpers) {
    let extra = 0;
    // `await name(...)` / `name(...)` の呼び出し名を抽出
    const callRegex = /\b(?:await\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
    let m;
    while ((m = callRegex.exec(body)) !== null) {
        const fnName = m[1];
        if (helpers.has(fnName)) {
            extra += helpers.get(fnName).expectCount;
        }
    }
    return extra;
}

function analyzeFile(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8');
    let ast;
    try {
        ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, locations: false });
    } catch (e) {
        return { file: filePath, error: e.message, tests: [] };
    }

    // Step 1: ヘルパー関数の expect 数を事前抽出
    const helpers = extractHelpers(ast, text);

    const tests = [];
    walk.simple(ast, {
        CallExpression(node) {
            const kind = isTestCall(node);
            if (!kind) return;
            if (node.arguments.length < 2) return;
            const result = analyzeTestBody(text, node, text);
            if (!result) return;
            result.kind = kind;

            // Step 2: ヘルパー呼び出し内の expect を加算
            const bodyStart = node.arguments[1].start;
            const bodyEnd = node.arguments[1].end;
            const body = text.slice(bodyStart, bodyEnd);
            const helperExtraExpects = expandHelperExpects(body, helpers);
            result.helperExpectCount = helperExtraExpects;
            result.totalExpectCount = result.expectCount + helperExtraExpects;

            // Step 3: 偽装判定をヘルパー込みで再判定
            //   永続スキップ (test.skip(true, '理由') / test.skip('title', async () => {})) は偽装ではないので除外
            //   kind === 'test.skip' は test 関数定義レベルの永続スキップ (Playwright の skip 宣言)
            if (kind === 'test.skip') {
                result.isPermanentSkip = true;
            }
            const totalEffective = result.totalExpectCount;
            const weakExpectCount = result.weakExpectCount;
            const navbarVisibleCount = result.navbarVisibleCount;
            const hasIseNotContain = result.hasIseNotContain;
            const isFakeTestRevised = !result.isPermanentSkip && (
                totalEffective === 0 ||
                (totalEffective > 0 && weakExpectCount + navbarVisibleCount >= totalEffective) ||
                (hasIseNotContain && navbarVisibleCount > 0 && totalEffective <= 2 + weakExpectCount)
            );
            result.isFakeTestRevised = isFakeTestRevised;
            // 元の violations を再評価: ヘルパー込みで偽装ではないなら A 違反を取り除く
            if (!isFakeTestRevised) {
                result.violations = result.violations.filter(v => v.category !== 'A');
            }
            // ヘルパー由来 expect を含めても偽装なら A 維持 + 詳細更新
            if (isFakeTestRevised && result.violations.find(v => v.category === 'A')) {
                const aVio = result.violations.find(v => v.category === 'A');
                aVio.detail = `偽装テスト: total_expect=${totalEffective} (own=${result.expectCount} helper=${helperExtraExpects}) weak=${weakExpectCount} navbar=${navbarVisibleCount} ISE_check=${hasIseNotContain}`;
            }
            // isFakeTest フラグも再評価値に置き換え
            result.isFakeTest = isFakeTestRevised;

            tests.push(result);
        }
    });

    return { file: filePath, tests };
}

function main() {
    const specs = fs.readdirSync(TESTS_DIR)
        .filter(f => f.endsWith('.spec.js'))
        .map(f => path.join(TESTS_DIR, f));

    const allResults = [];
    let totalTests = 0;
    let totalViolatingTests = 0;
    let categoryCount = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };

    for (const specPath of specs) {
        const result = analyzeFile(specPath);
        if (result.error) {
            console.error(`[ERROR] ${path.basename(specPath)}: ${result.error}`);
            allResults.push({ file: path.basename(specPath), error: result.error });
            continue;
        }
        const violatingTests = result.tests.filter(t => t.violations.length > 0);
        totalTests += result.tests.length;
        totalViolatingTests += violatingTests.length;
        for (const t of violatingTests) {
            for (const v of t.violations) {
                categoryCount[v.category] = (categoryCount[v.category] || 0) + 1;
            }
        }

        allResults.push({
            file: path.basename(specPath),
            totalTests: result.tests.length,
            violatingTests: violatingTests.length,
            violationRate: result.tests.length > 0 ? (violatingTests.length / result.tests.length) : 0,
            tests: result.tests,
        });
    }

    // ソート: 違反率の高い順
    allResults.sort((a, b) => (b.violationRate || 0) - (a.violationRate || 0));

    // JSON 出力
    const summary = {
        generated_at: new Date().toISOString(),
        totalSpecs: allResults.length,
        totalTests,
        totalViolatingTests,
        overallViolationRate: totalTests > 0 ? totalViolatingTests / totalTests : 0,
        categoryCount,
        specs: allResults,
    };
    fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));

    // Markdown 出力
    const lines = [];
    lines.push(`# AST 空テスト検出結果 (生成日: ${new Date().toISOString().slice(0, 19)})`);
    lines.push('');
    lines.push(`## サマリー`);
    lines.push(`- 対象 spec 数: ${summary.totalSpecs}`);
    lines.push(`- 総テスト数: ${summary.totalTests}`);
    lines.push(`- 違反テスト数: ${summary.totalViolatingTests}`);
    lines.push(`- 全体違反率: ${(summary.overallViolationRate * 100).toFixed(1)}%`);
    lines.push('');
    lines.push(`## カテゴリ別違反件数`);
    lines.push('| カテゴリ | 件数 | 内容 |');
    lines.push('|---|---|---|');
    lines.push(`| A 偽装テスト | ${categoryCount.A || 0} | navbar/ISE のみ、assertion 0、早期 return |`);
    lines.push(`| B assertion 緩和 | ${categoryCount.B || 0} | expect(true), .catch(() => {}) 等 |`);
    lines.push(`| C タイトル不一致 | ${categoryCount.C || 0} | タイトル動詞と内容の乖離 |`);
    lines.push(`| D 記法違反 | ${categoryCount.D || 0} | [flow]/[check] 欠落、waitForTimeout、first 多用 |`);
    lines.push(`| E プロダクトバグ隠蔽 | ${categoryCount.E || 0} | try-catch+console.log 握り潰し |`);
    lines.push(`| F 不正スキップ | ${categoryCount.F || 0} | test.skip(true) 固定 |`);
    lines.push('');
    lines.push(`## spec 別違反率 (高い順)`);
    lines.push('| spec | 総テスト | 違反 | 違反率 |');
    lines.push('|---|---|---|---|');
    for (const r of allResults) {
        if (r.error) {
            lines.push(`| ${r.file} | ERROR | - | ${r.error} |`);
            continue;
        }
        lines.push(`| ${r.file} | ${r.totalTests} | ${r.violatingTests} | ${(r.violationRate * 100).toFixed(0)}% |`);
    }
    lines.push('');
    lines.push(`## 違反テスト詳細 (TOP 50, 重大度順)`);
    const allViolations = [];
    for (const r of allResults) {
        if (r.error) continue;
        for (const t of r.tests) {
            if (t.violations.length === 0) continue;
            allViolations.push({
                file: r.file,
                title: t.title,
                line: t.line,
                violations: t.violations,
                expectCount: t.expectCount,
                weakExpectCount: t.weakExpectCount,
                isFakeTest: t.isFakeTest,
            });
        }
    }
    // ソート: A 偽装 > E 隠蔽 > B 緩和 > F 不正スキップ > C 不一致 > D 記法
    const severityOrder = { A: 0, E: 1, B: 2, F: 3, C: 4, D: 5 };
    allViolations.sort((a, b) => {
        const minA = Math.min(...a.violations.map(v => severityOrder[v.category]));
        const minB = Math.min(...b.violations.map(v => severityOrder[v.category]));
        return minA - minB;
    });

    for (let i = 0; i < Math.min(50, allViolations.length); i++) {
        const v = allViolations[i];
        lines.push(`### ${i + 1}. ${v.file}: "${v.title}" (行 ${v.line.start}-${v.line.end})`);
        lines.push(`- expect=${v.expectCount}, weak=${v.weakExpectCount}, fake=${v.isFakeTest}`);
        for (const vio of v.violations) {
            lines.push(`- **[${vio.category}]** ${vio.detail}`);
        }
        lines.push('');
    }

    fs.writeFileSync(OUT_MD, lines.join('\n'));

    console.log(`✅ 完了: ${allResults.length} spec / ${summary.totalTests} tests / ${summary.totalViolatingTests} violations (${(summary.overallViolationRate * 100).toFixed(1)}%)`);
    console.log(`   JSON: ${OUT_JSON}`);
    console.log(`   MD:   ${OUT_MD}`);
}

main();
