#!/usr/bin/env node
/**
 * convert-to-test-step.js
 *
 * spec.jsのtest()をyamlのmovie番号に基づいてtest.step()形式にまとめる変換スクリプト
 *
 * 使い方:
 *   node scripts/convert-to-test-step.js [spec名]
 *   例: node scripts/convert-to-test-step.js workflow
 *   引数なし: specsディレクトリの全yamlを対象に変換
 */

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SPECS_DIR = path.join(ROOT, 'specs');
const TESTS_DIR = path.join(ROOT, 'tests');

// ============================================================
// ユーティリティ: 対応する閉じブレース位置を探す
// ============================================================
function findClosingBrace(content, start) {
    const len = content.length;
    let depth = 0;
    let inString = null;
    let i = start;
    while (i < len) {
        const ch = content[i];
        if (inString) {
            if (ch === '\\') { i += 2; continue; }
            if (ch === inString) inString = null;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            inString = ch;
            i++;
            continue;
        }
        // 行コメント
        if (ch === '/' && content[i + 1] === '/') {
            const nl = content.indexOf('\n', i);
            i = nl === -1 ? len : nl + 1;
            continue;
        }
        // ブロックコメント
        if (ch === '/' && content[i + 1] === '*') {
            const end = content.indexOf('*/', i + 2);
            i = end === -1 ? len : end + 2;
            continue;
        }
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
        i++;
    }
    return len - 1;
}

// ============================================================
// 1. YAML読み込み: case_no → movie マッピング
// ============================================================
function buildMovieMap(yamlPath) {
    const raw = fs.readFileSync(yamlPath, 'utf8');
    let doc;
    try {
        doc = yaml.load(raw);
    } catch (e) {
        throw new Error(`YAML解析エラー: ${yamlPath}\n${e.message}`);
    }

    if (!doc || !Array.isArray(doc.cases)) {
        return { caseNoToMovie: {}, movieToFeature: {}, movieOrder: [] };
    }

    const caseNoToMovie = {};
    const movieToFeature = {};
    const movieOrder = [];

    for (const c of doc.cases) {
        if (!c.case_no) continue;
        const caseNo = String(c.case_no);
        const movie = c.movie ? String(c.movie).trim() : null;
        caseNoToMovie[caseNo] = movie;
        if (movie && !movieToFeature[movie]) {
            // feature名の改行・特殊文字をスペースに置換してシングルクォートを安全に
            const featureName = (c.feature || movie)
                .replace(/[\r\n]+/g, ' ')
                .replace(/'/g, "\\'")
                .trim();
            movieToFeature[movie] = featureName;
            movieOrder.push(movie);
        }
    }

    return { caseNoToMovie, movieToFeature, movieOrder };
}

// ============================================================
// 2. テスト名からcase_noを抽出
// ============================================================
function extractCaseNo(title) {
    // "48-1: xxx" → "48-1"
    // "226: xxx" → "226"
    // "14-12-1: xxx" → "14-12-1"
    const m = title.match(/^([\d][\d\-]*)(?=\s*[:：])/);
    return m ? m[1] : null;
}

// ============================================================
// 3. spec.jsをチャンクに分解
//
// チャンクの種類:
//   { type: 'verbatim', text }    - そのまま出力するテキスト
//   { type: 'describe', name, innerContent, fullText } - test.describe ブロック
//
// describe の innerContent は再帰的にチャンクに分解される
// ============================================================
function splitIntoChunks(content) {
    const chunks = [];
    let pos = 0;
    const len = content.length;

    while (pos < len) {
        // test.describe を探す（行頭からの空白は無視）
        const describeRe = /\btest\.describe\s*\(/g;
        describeRe.lastIndex = pos;
        const m = describeRe.exec(content);
        if (!m) {
            // 残りは全部 verbatim
            chunks.push({ type: 'verbatim', text: content.slice(pos) });
            break;
        }

        const matchStart = m.index;
        // matchStartより前の部分は verbatim
        if (matchStart > pos) {
            chunks.push({ type: 'verbatim', text: content.slice(pos, matchStart) });
        }

        // describe名を取得
        const afterParen = content.slice(matchStart + m[0].length);
        const nameMatch = afterParen.match(/^\s*(['"`])([\s\S]*?)\1/);
        const describeName = nameMatch ? nameMatch[2] : '';

        // コールバックの { を探す
        const bracePos = content.indexOf('{', matchStart + m[0].length);
        if (bracePos === -1) {
            // { が見つからない場合は残りをverbatimに
            chunks.push({ type: 'verbatim', text: content.slice(matchStart) });
            break;
        }

        const braceEnd = findClosingBrace(content, bracePos);
        const innerContent = content.slice(bracePos + 1, braceEnd);

        // ); の閉じを含む終端を取得
        let endPos = braceEnd + 1;
        const closeMatch = content.slice(endPos).match(/^[^\n;]*[;)]/);
        if (closeMatch) endPos += closeMatch[0].length;
        // 末尾の改行も含める
        if (endPos < len && content[endPos] === '\n') endPos++;

        chunks.push({
            type: 'describe',
            name: describeName,
            innerContent,
            fullText: content.slice(matchStart, endPos),
        });
        pos = endPos;
    }

    return chunks;
}

// ============================================================
// 4. describe innerContent から test() / hook / その他 を抽出
// ============================================================
function parseDescribeInner(innerContent) {
    const items = [];
    let pos = 0;
    const len = innerContent.length;

    while (pos < len) {
        const remaining = innerContent.slice(pos);

        // --- test.beforeAll / beforeEach / afterAll / afterEach ---
        const hookRe = /^([\s\S]*?)(test\.(beforeAll|beforeEach|afterAll|afterEach)\s*\()/;
        const hookM = remaining.match(hookRe);

        // --- test( / test.only( ---
        // test.beforeAll 等は除外する。
        // test の直後が .only でも .beforeAll 等でもなく、直接 ( が続く場合のみマッチ
        // test\s*( または test\s*.\s*only\s*( のみ
        const testRe = /^([\s\S]*?)\btest(\s*\.\s*only)?\s*\(\s*(['"`])/;
        const testM = remaining.match(testRe);

        // どちらが先に出てくるか
        const hookOffset = hookM ? hookM[1].length : Infinity;
        const testOffset = testM ? testM[1].length : Infinity;

        if (hookOffset === Infinity && testOffset === Infinity) {
            // もう test も hook もない
            items.push({ type: 'other', text: remaining });
            break;
        }

        if (hookOffset <= testOffset) {
            // hook が先
            const leadText = hookM[1];
            if (leadText) items.push({ type: 'other', text: leadText });

            const hookStart = pos + hookOffset;
            const hookType = hookM[3]; // 'beforeAll', 'beforeEach', etc.

            // callback { を探す: => の後にある { が本体
            // async ({ browser }) => { のような場合、=> を探してからその後の { を探す
            const arrowPos = innerContent.indexOf('=>', hookStart + hookM[2].length);
            const bracePos = arrowPos !== -1
                ? innerContent.indexOf('{', arrowPos + 2)
                : innerContent.indexOf('{', hookStart + hookM[2].length);
            if (bracePos === -1) break;
            const braceEnd = findClosingBrace(innerContent, bracePos);
            let endPos = braceEnd + 1;
            const closeM = innerContent.slice(endPos).match(/^[^\n;]*[;)]/);
            if (closeM) endPos += closeM[0].length;
            if (endPos < len && innerContent[endPos] === '\n') endPos++;

            items.push({
                type: hookType,
                text: innerContent.slice(hookStart, endPos),
            });
            pos = hookStart + (endPos - hookStart);
            continue;
        }

        // test が先
        // testM: [fullMatch, leadingText, optionalOnly, quoteChar]
        const leadText = testM[1];
        if (leadText) items.push({ type: 'other', text: leadText });

        const testStart = pos + testOffset;
        // testStart から始まる "test" + optional ".only" + "(" + optional空白 の長さを計算
        const testMatchFull = innerContent.slice(testStart).match(/^test(\s*\.\s*only)?\s*\(\s*/);
        const testKeywordLen = testMatchFull ? testMatchFull[0].length : 5;

        // testKeywordLen 後は quote 文字から始まるのでその位置からタイトルを取得
        const afterParen = innerContent.slice(testStart + testKeywordLen);
        const titleM = afterParen.match(/^(['"`])([\s\S]*?)\1/);
        const title = titleM ? titleM[2] : '';

        // async引数を取得
        const afterTitle = afterParen.slice(titleM ? titleM[0].length : 0);
        const asyncArgsM = afterTitle.match(/^\s*,\s*(async\s*\([^)]*\))\s*=>/);
        const asyncArgs = asyncArgsM ? asyncArgsM[1] : 'async ({ page })';

        // callback { を探す: async ({ page }) => { の形なので => の後の { を探す
        const arrowPos = innerContent.indexOf('=>', testStart + testKeywordLen);
        const bracePos = arrowPos !== -1
            ? innerContent.indexOf('{', arrowPos + 2)
            : innerContent.indexOf('{', testStart + testKeywordLen);
        if (bracePos === -1) break;
        const braceEnd = findClosingBrace(innerContent, bracePos);
        let endPos = braceEnd + 1;
        const closeM = innerContent.slice(endPos).match(/^[^\n;]*[;)]/);
        if (closeM) endPos += closeM[0].length;
        if (endPos < len && innerContent[endPos] === '\n') endPos++;

        const bodyContent = innerContent.slice(bracePos + 1, braceEnd);
        const caseNo = extractCaseNo(title);

        items.push({
            type: 'test',
            title,
            caseNo,
            asyncArgs,
            body: bodyContent,
            fullText: innerContent.slice(testStart, endPos),
        });
        pos = testStart + (endPos - testStart);
    }

    return items;
}

// ============================================================
// 5. describeブロックをmovie単位のtest.step()形式に変換
// ============================================================
function convertDescribeToSteps(describe, caseNoToMovie, movieToFeature, movieOrder) {
    const { name, innerContent } = describe;
    const items = parseDescribeInner(innerContent);

    // test / hook / other に分類
    const hooks = [];
    const others = [];
    const tests = [];

    let beforeTestSection = true;
    for (const item of items) {
        if (item.type === 'test') {
            beforeTestSection = false;
            tests.push(item);
        } else if (['beforeAll', 'beforeEach', 'afterAll', 'afterEach'].includes(item.type)) {
            hooks.push(item);
            if (tests.length > 0) beforeTestSection = false;
        } else {
            // other
            if (beforeTestSection) {
                others.push(item);
            } else {
                // テストブロック以降のotherはとりあえずothers末尾に
                others.push(item);
            }
        }
    }

    // movieごとにテストをグループ化
    const movieGroups = new Map();
    const noMovieTests = [];

    for (const t of tests) {
        const movie = t.caseNo ? caseNoToMovie[t.caseNo] : null;
        if (!movie) {
            noMovieTests.push(t);
            continue;
        }
        if (!movieGroups.has(movie)) {
            movieGroups.set(movie, []);
        }
        movieGroups.get(movie).push(t);
    }

    // movieがない場合はそのまま返す
    if (movieGroups.size === 0) {
        return describe.fullText;
    }

    // movie番号の順序: yamlのmovieOrder優先
    const orderedMovies = [];
    for (const m of movieOrder) {
        if (movieGroups.has(m)) orderedMovies.push(m);
    }
    for (const m of movieGroups.keys()) {
        if (!orderedMovies.includes(m)) orderedMovies.push(m);
    }

    // describe ブロックを再構築
    const INDENT_DESCRIBE = '    ';    // describeボディのインデント (4スペース)
    const INDENT_TEST = '        ';    // test内のインデント (8スペース)
    const INDENT_STEP = '            '; // test.step内のインデント (12スペース)

    /**
     * テキストブロックを指定インデントで再インデントする
     * - 空行は空のまま
     * - 元の最小インデントを検出して、それをbaseIndentに置き換える
     */
    function reindent(text, targetIndent) {
        const rawLines = text.split('\n');
        // 空でない行の最小インデント（スペース数）を検出
        const nonEmpty = rawLines.filter(l => l.trim() !== '');
        if (nonEmpty.length === 0) return text;
        const minIndent = Math.min(...nonEmpty.map(l => l.match(/^(\s*)/)[1].length));
        return rawLines.map(line => {
            if (line.trim() === '') return '';
            const stripped = line.slice(minIndent);
            return targetIndent + stripped;
        }).join('\n');
    }

    const lines = [];
    lines.push(`test.describe('${name}', () => {`);

    // others（let/const等の変数宣言）は4スペースインデントで出力
    for (const o of others) {
        lines.push(reindent(o.text, INDENT_DESCRIBE).trimEnd());
    }

    // hooks（beforeAll/beforeEach/afterAll）は4スペースインデントで出力
    for (const h of hooks) {
        lines.push('');
        lines.push(reindent(h.text, INDENT_DESCRIBE).trimEnd());
    }

    // movie単位のtest
    for (const movie of orderedMovies) {
        const movieTests = movieGroups.get(movie);
        if (!movieTests || movieTests.length === 0) continue;

        const featureName = movieToFeature[movie] || movie;
        const testName = `${movie}: ${featureName}`;

        lines.push('');
        lines.push(`${INDENT_DESCRIBE}test('${testName}', async ({ page }) => {`);

        for (const t of movieTests) {
            // bodyを12スペースインデントに正規化
            const reindentedBody = reindent(t.body, INDENT_STEP);

            // タイトルにシングルクォートが含まれる場合はエスケープ
        const safeTitle = t.title.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        lines.push(`${INDENT_TEST}await test.step('${safeTitle}', async () => {`);
            lines.push(`${INDENT_STEP}const STEP_TIME = Date.now();`);
            lines.push(reindentedBody);
            lines.push(`${INDENT_TEST}});`);
        }

        lines.push(`${INDENT_DESCRIBE}});`);
    }

    // movieなしのテストはそのまま出力（元のインデントで）
    for (const t of noMovieTests) {
        lines.push('');
        lines.push(reindent(t.fullText, INDENT_DESCRIBE).trimEnd());
    }

    lines.push('});\n');

    return lines.join('\n') + '\n';
}

// ============================================================
// 6. メイン変換処理
// ============================================================
function convertSpec(specName) {
    const yamlPath = path.join(SPECS_DIR, `${specName}.yaml`);
    const specPath = path.join(TESTS_DIR, `${specName}.spec.js`);
    const bakPath = path.join(TESTS_DIR, `${specName}.spec.js.bak`);

    if (!fs.existsSync(yamlPath)) {
        console.error(`[エラー] YAMLファイルが見つかりません: ${yamlPath}`);
        return false;
    }
    if (!fs.existsSync(specPath)) {
        console.error(`[エラー] spec.jsファイルが見つかりません: ${specPath}`);
        return false;
    }

    console.log(`\n[変換開始] ${specName}`);
    console.log(`  YAML: ${yamlPath}`);
    console.log(`  Spec: ${specPath}`);

    const { caseNoToMovie, movieToFeature, movieOrder } = buildMovieMap(yamlPath);
    const movieCount = new Set(Object.values(caseNoToMovie).filter(Boolean)).size;
    console.log(`  movie番号数: ${movieCount}`);

    if (movieCount === 0) {
        console.log(`  [スキップ] movie番号が設定されていないため変換不要`);
        return true;
    }

    // バックアップ
    fs.copyFileSync(specPath, bakPath);
    console.log(`  バックアップ作成: ${bakPath}`);

    const content = fs.readFileSync(specPath, 'utf8');

    // チャンク分解
    const chunks = splitIntoChunks(content);

    // 各チャンクを変換
    const outputParts = chunks.map(chunk => {
        if (chunk.type === 'verbatim') {
            return chunk.text;
        }
        if (chunk.type === 'describe') {
            return convertDescribeToSteps(chunk, caseNoToMovie, movieToFeature, movieOrder);
        }
        return '';
    });

    const converted = outputParts.join('');

    // 書き込み
    fs.writeFileSync(specPath, converted, 'utf8');
    console.log(`  変換後ファイル書き込み完了`);

    // 構文チェック
    try {
        execSync(`node --check "${specPath}"`, { stdio: 'pipe' });
        console.log(`  [OK] 構文チェック通過`);
    } catch (e) {
        console.error(`  [エラー] 構文チェック失敗!`);
        console.error(e.stderr ? e.stderr.toString() : e.message);
        fs.copyFileSync(bakPath, specPath);
        console.log(`  [復元] バックアップから復元しました: ${bakPath}`);
        return false;
    }

    // 統計
    const testsBefore = (content.match(/\btest\s*\(/g) || []).length;
    const testsAfter = (converted.match(/\btest\s*\(/g) || []).length;
    const stepsAfter = (converted.match(/await test\.step\s*\(/g) || []).length;
    console.log(`  テスト数: ${testsBefore}件 → ${testsAfter}件（test.step: ${stepsAfter}件）`);

    return true;
}

// ============================================================
// 7. エントリーポイント
// ============================================================
function main() {
    const args = process.argv.slice(2);

    if (args.length > 0) {
        const specName = args[0];
        const success = convertSpec(specName);
        process.exit(success ? 0 : 1);
    } else {
        const yamlFiles = fs.readdirSync(SPECS_DIR)
            .filter(f => f.endsWith('.yaml'))
            .map(f => f.replace('.yaml', ''));

        console.log(`[全ファイル変換] 対象: ${yamlFiles.length}件`);
        const results = { success: [], failed: [], skipped: [] };

        for (const specName of yamlFiles) {
            const specPath = path.join(TESTS_DIR, `${specName}.spec.js`);
            if (!fs.existsSync(specPath)) {
                console.log(`[スキップ] spec.jsなし: ${specName}`);
                results.skipped.push(specName);
                continue;
            }
            const ok = convertSpec(specName);
            if (ok) {
                results.success.push(specName);
            } else {
                results.failed.push(specName);
            }
        }

        console.log('\n========== 変換結果サマリー ==========');
        console.log(`  成功: ${results.success.length}件`);
        console.log(`  失敗: ${results.failed.length}件`);
        console.log(`  スキップ: ${results.skipped.length}件`);
        if (results.failed.length > 0) {
            console.log(`  失敗ファイル: ${results.failed.join(', ')}`);
        }

        process.exit(results.failed.length > 0 ? 1 : 0);
    }
}

main();
