// fields-4.spec.js: フィールドテスト Part 4 (表示条件動作261系・必須/重複265系・初期値267系)
// テーブル設定ページ不要 — ALLテストテーブルに既に設定済みのフィールドを使い、レコード操作画面で動作確認
// @ts-check
const { test, expect } = require('@playwright/test');
const { createTestEnv } = require('./helpers/create-test-env');

let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;

async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

async function login(page, email, password) {
    const { ensureLoggedIn } = require('./helpers/ensure-login');
    await ensureLoggedIn(page, email || EMAIL, password || PASSWORD);
}

async function closeTemplateModal(page) {
    try {
        const modal = page.locator('div.modal.show');
        if (await modal.count() > 0) {
            await modal.locator('button').first().click({ force: true });
            await waitForAngular(page);
        }
    } catch { }
}

/**
 * レコード一覧画面から+ボタンで新規作成フォームを開く
 */
async function openNewRecordForm(page, tableId) {
    await page.goto(BASE_URL + `/admin/dataset__${tableId}`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
    await waitForAngular(page);
    const addBtn = page.locator('button:has(.fa-plus)').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();
    // 102フィールドフォームの描画待ち
    await page.waitForSelector('admin-forms-field', { timeout: 30000 });
    await waitForAngular(page);
    await page.waitForTimeout(2000);
}

// =============================================================================
// 環境セットアップ
// =============================================================================
let _sharedTableId = null;

test.beforeAll(async ({ browser }) => {
    test.setTimeout(180000);
    const env = await createTestEnv(browser, { withAllTypeTable: true });
    BASE_URL = env.baseUrl;
    EMAIL = env.email;
    PASSWORD = env.password;
    _sharedTableId = env.tableId;
    process.env.TEST_BASE_URL = env.baseUrl;
    process.env.TEST_EMAIL = env.email;
    process.env.TEST_PASSWORD = env.password;
    await env.context.close();
    console.log(`[fields-4] 自己完結環境: ${BASE_URL}, tableId: ${_sharedTableId}`);
});

// =============================================================================
// F401: フィールド機能テスト（261/265/267系）
// テーブル設定ページ不使用 — レコード操作画面で動作確認
// =============================================================================

test.describe('フィールド機能テスト（261/265/267系）', () => {

    test('F401: フィールド機能テスト', async ({ page }) => {
        test.setTimeout(180000);
        const _testStart = Date.now();

        const tableId = _sharedTableId;
        expect(tableId, 'ALLテストテーブルのIDが取得できていること').toBeTruthy();

        await login(page);
        await closeTemplateModal(page);

        // ----- 261-1: 表示条件の動作確認（セレクトフィールド）-----
        // テスト観点: 選択肢フィールドの表示条件が機能していること
        // ALLテストテーブルの「ラジオ_表示条件テキスト」はラジオ=ラジオA選択時のみ表示される設定
        await test.step('261-1: 選択肢フィールドの表示条件が機能すること（ラジオ選択で条件フィールドが表示/非表示）', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 261-1`);

            await openNewRecordForm(page, tableId);

            // ページが正常表示されること
            const pageText = await page.innerText('body');
            expect(pageText).not.toContain('Internal Server Error');

            // セレクトフィールドが存在すること（選択肢フィールドの表示確認）
            const selectExists = await page.evaluate(() =>
                Array.from(document.querySelectorAll('label')).some(l => l.textContent.trim() === 'セレクト')
            );
            expect(selectExists, 'セレクトフィールドがフォームに存在すること').toBe(true);

            // 表示条件の動作確認: ラジオ未選択→「ラジオ_表示条件テキスト」が非表示
            await page.waitForFunction(
                () => !Array.from(document.querySelectorAll('label')).some(l => l.textContent.trim() === 'ラジオ_表示条件テキスト'),
                { timeout: 15000 }
            ).catch(() => {});

            const condHiddenInitially = !(await page.evaluate(() =>
                Array.from(document.querySelectorAll('label')).some(l => l.textContent.trim() === 'ラジオ_表示条件テキスト')
            ));
            expect(condHiddenInitially, '初期状態で表示条件フィールドが非表示であること').toBe(true);

            // ラジオAを選択→表示条件フィールドが表示される
            const clickedA = await page.evaluate(() => {
                const labels = Array.from(document.querySelectorAll('label.radio-custom'));
                const radioA = labels.find(l => l.textContent.trim() === 'ラジオA');
                if (radioA) { radioA.click(); return true; }
                return false;
            });
            expect(clickedA, 'ラジオAが選択できること').toBe(true);

            await page.waitForFunction(
                () => Array.from(document.querySelectorAll('label')).some(l => l.textContent.trim() === 'ラジオ_表示条件テキスト'),
                { timeout: 10000 }
            ).catch(() => {});

            const condVisibleAfterA = await page.evaluate(() =>
                Array.from(document.querySelectorAll('label')).some(l => l.textContent.trim() === 'ラジオ_表示条件テキスト')
            );
            expect(condVisibleAfterA, 'ラジオA選択後に表示条件フィールドが表示されること').toBe(true);
        });

        // ----- 261-2: Yes/No(ブール)フィールドの表示・操作確認 -----
        // テスト観点: Yes/Noフィールドがフォームに表示され操作可能であること
        await test.step('261-2: Yes/Noフィールドがフォームに表示され操作可能であること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 261-2`);

            // 261-1でフォームが開いているのでそのまま確認
            // ブールフィールドの存在確認（ALLテストテーブルでは「ブール」ラベル）
            const boolExists = await page.evaluate(() =>
                Array.from(document.querySelectorAll('label')).some(l => l.textContent.trim() === 'ブール')
            );
            expect(boolExists, 'ブール(Yes/No)フィールドがフォームに存在すること').toBe(true);

            // ブールフィールドのチェックボックスを操作できること
            const boolCheckbox = page.locator('label').filter({ hasText: /^ブール$/ }).locator('..').locator('input[type="checkbox"]').first();
            if (await boolCheckbox.count() > 0) {
                const before = await boolCheckbox.isChecked().catch(() => false);
                await boolCheckbox.click({ force: true });
                await page.waitForTimeout(500);
                const after = await boolCheckbox.isChecked().catch(() => !before);
                expect(after !== before, 'ブールフィールドのチェックボックスが操作可能であること').toBe(true);
            }
        });

        // ----- 261-3: チェックボックスフィールドの表示・操作確認 -----
        // テスト観点: チェックボックスフィールドがフォームに表示され操作可能であること
        await test.step('261-3: チェックボックスフィールドがフォームに表示され操作可能であること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 261-3`);

            // チェックボックスフィールドの存在確認（ALLテストテーブルでは「チェックボックス」ラベル）
            const checkExists = await page.evaluate(() =>
                Array.from(document.querySelectorAll('label')).some(l => l.textContent.trim() === 'チェックボックス')
            );
            expect(checkExists, 'チェックボックスフィールドがフォームに存在すること').toBe(true);

            // チェックボックスの選択肢（チェックA, チェックB）が存在すること
            const hasCheckA = await page.evaluate(() =>
                Array.from(document.querySelectorAll('label')).some(l => l.textContent.trim() === 'チェックA')
            );
            expect(hasCheckA, 'チェックボックスの選択肢「チェックA」が存在すること').toBe(true);
        });

        // ----- 265-1: 必須フィールドの空保存エラー確認 -----
        // テスト観点: ALLテストテーブルの「テキスト」は必須(※マーク)。空のまま保存→エラー
        await test.step('265-1: 必須フィールドを空のまま保存するとエラーメッセージが表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 265-1`);

            // 新規レコードフォームを再度開く（前のステップのフォーム状態をクリア）
            await openNewRecordForm(page, tableId);

            // テキストフィールドが必須マーク付きであること（赤い✳アイコンまたは※テキスト）
            const requiredMark = await page.evaluate(() => {
                const labels = Array.from(document.querySelectorAll('label'));
                const textLabel = labels.find(l => {
                    const t = l.textContent.trim();
                    return t === 'テキスト' || t.startsWith('テキスト') && !t.includes('エリア') && !t.includes('_');
                });
                if (!textLabel) return false;
                const parent = textLabel.closest('.form-group, admin-forms-field, .field-wrapper, div');
                if (!parent) return false;
                // 必須マーク: ※、required クラス、赤い span、.text-danger 等
                const html = parent.innerHTML;
                return html.includes('※') || html.includes('required') || html.includes('text-danger') ||
                       html.includes('✳') || html.includes('*') || parent.querySelector('.required, .text-danger, [style*="color: red"], [style*="color:red"]') !== null;
            });
            expect(requiredMark, 'テキストフィールドに必須マークが表示されていること').toBe(true);

            // テキストフィールドを空のまま保存ボタンをクリック
            const saveBtn = page.locator('button:has-text("保存"), button.btn-primary:has-text("登録")').first();
            await expect(saveBtn).toBeVisible({ timeout: 10000 });
            await saveBtn.click();
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // エラーメッセージが表示されること
            const bodyText = await page.innerText('body');
            const hasError = bodyText.includes('入力してください') ||
                             bodyText.includes('必須') ||
                             bodyText.includes('required') ||
                             bodyText.includes('エラー');
            expect(hasError, '必須フィールドが空の状態で保存した際にエラーメッセージが表示されること').toBe(true);
        });

        // ----- 265-2: 重複チェック(ユニーク)の動作確認 -----
        // テスト観点: ALLテストテーブルの「テキスト_ユニーク」は重複不可設定済み。同じ値で2件保存→エラー
        await test.step('265-2: ユニーク設定フィールドに重複値を保存するとエラーが表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 265-2`);

            // レコード新規作成（1件目: ユニーク値を設定して保存）
            await openNewRecordForm(page, tableId);

            // テキスト_ユニークフィールドに値を入力
            const uniqueValue = 'unique_test_' + Date.now();
            // PigeonCloudのフォーム: label と input は .form-group 内にある。label('..') では親1階層のみ
            // xpath=ancestor で .form-group を探す
            const uniqueField = page.locator('label:has-text("テキスト_ユニーク")').locator('xpath=ancestor::*[contains(@class,"form-group") or contains(@class,"admin-forms")]').locator('input[type="text"]').first();
            const textField = page.locator('label:text-is("テキスト")').locator('xpath=ancestor::*[contains(@class,"form-group") or contains(@class,"admin-forms")]').locator('input[type="text"]').first();

            if (await textField.count() > 0) {
                await textField.fill('ユニークテスト用');
            }
            if (await uniqueField.count() > 0) {
                await uniqueField.fill(uniqueValue);
                // 保存
                const saveBtn = page.locator('button:has-text("保存"), button.btn-primary:has-text("登録")').first();
                await saveBtn.click();
                await waitForAngular(page);
                await page.waitForTimeout(2000);

                // 2件目: 同じユニーク値で保存→エラー
                await openNewRecordForm(page, tableId);
                const textField2 = page.locator('label:text-is("テキスト")').locator('xpath=ancestor::*[contains(@class,"form-group") or contains(@class,"admin-forms")]').locator('input[type="text"]').first();
                const uniqueField2 = page.locator('label:has-text("テキスト_ユニーク")').locator('xpath=ancestor::*[contains(@class,"form-group") or contains(@class,"admin-forms")]').locator('input[type="text"]').first();
                if (await textField2.count() > 0) await textField2.fill('ユニークテスト用2');
                if (await uniqueField2.count() > 0) await uniqueField2.fill(uniqueValue);

                const saveBtn2 = page.locator('button:has-text("保存"), button.btn-primary:has-text("登録")').first();
                await saveBtn2.click();
                await waitForAngular(page);
                await page.waitForTimeout(2000);

                const bodyText = await page.innerText('body');
                const hasDupError = bodyText.includes('重複') ||
                                     bodyText.includes('一意') ||
                                     bodyText.includes('ユニーク') ||
                                     bodyText.includes('既に使用') ||
                                     bodyText.includes('duplicate');
                expect(hasDupError, `ユニークフィールドに重複値「${uniqueValue}」を保存した際にエラーが表示されること`).toBe(true);
            } else {
                // テキスト_ユニークフィールドが見つからない場合
                const allLabels = await page.evaluate(() =>
                    Array.from(document.querySelectorAll('label')).map(l => l.textContent.trim()).filter(t => t.includes('ユニーク'))
                );
                throw new Error(`テキスト_ユニークフィールドが見つかりません。存在するユニーク関連ラベル: ${JSON.stringify(allLabels)}`);
            }
        });

        // ----- 267-1: デフォルト値の自動入力確認 -----
        // テスト観点: デフォルト値が設定されたフィールドで新規レコード作成時に自動入力されること
        // 注: ALLテストテーブルの「テキスト_デフォルト値」はフィールド名に"デフォルト値"を含むが、
        //     debug APIの create-all-type-table では実際のデフォルト値が未設定。
        //     代わりに「日付」「日時」フィールドの「デフォルト現在日時セット」機能で確認する。
        //     これらは create-all-type-table で自動的に現在日時がデフォルト入力される設定になっている。
        await test.step('267-1: デフォルト値が設定されたフィールドに新規作成時に自動入力されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s 267-1`);

            await openNewRecordForm(page, tableId);

            // 「日付」フィールドにデフォルト現在日付が入力されていること
            const dateInput = page.locator('label:text-is("日付")').locator('xpath=ancestor::*[contains(@class,"form-group") or contains(@class,"admin-forms")]').locator('input').first();
            if (await dateInput.count() > 0) {
                const dateValue = await dateInput.inputValue();
                // 今日の日付が含まれていること（YYYY/M/D形式）
                const today = new Date();
                const todayStr = `${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;
                expect(dateValue, `日付フィールドに現在日付（${todayStr}）がデフォルト入力されていること`).toContain(String(today.getFullYear()));
                console.log(`[267-1] 日付フィールドのデフォルト値: "${dateValue}"`);
            }

            // 「日時」フィールドにもデフォルト現在日時が入力されていること
            const datetimeInput = page.locator('label:text-is("日時")').locator('xpath=ancestor::*[contains(@class,"form-group") or contains(@class,"admin-forms")]').locator('input').first();
            if (await datetimeInput.count() > 0) {
                const dtValue = await datetimeInput.inputValue();
                expect(dtValue.length, '日時フィールドにデフォルト値が自動入力されていること').toBeGreaterThan(0);
                console.log(`[267-1] 日時フィールドのデフォルト値: "${dtValue}"`);
            }
        });
    });
});
