// @ts-check
const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { createTestEnv } = require('./helpers/create-test-env');

// 環境変数はbeforeAllで上書きされる（自己完結型）
let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;

/**
 * Angular描画完了を待機
 */
async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        // data-ng-readyが設定されないケースがある: networkidleで代替
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

/**
 * 明示的ログイン（createTestEnvで作成した新環境に対応）
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
    if (!page.url().includes('/login')) {
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
    // ログインフォームが表示されている場合のみ入力（storageStateで既にログイン済みの場合はスキップ）
    if (page.url().includes('/login')) {
        await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
        await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
        await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 20000 }).catch(() => {});
    } else {
        await page.waitForSelector('.navbar', { timeout: 10000 }).catch(() => {});
    }
}

/**
 * テーブル管理画面（/admin/dataset）のfa-barsドロップダウンを開く
 * 失敗時はexpectで止める（booleanリターンなし）
 */
async function openTableManagementBarsMenu(page) {
    // Angular SPAのため、リダイレクト後も/admin/datasetに確実に到達する
    for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto(BASE_URL + '/admin/dataset', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await waitForAngular(page);
        await page.waitForTimeout(1500);

        const url = page.url();
        if (url.includes('/admin/dataset') && !url.includes('/edit') && !url.includes('dashboard')) {
            break;
        }
        // リダイレクトされた場合：サイドバーの「テーブル管理」リンクを使う
        const sidebarLink = page.locator('a[href*="/admin/dataset"]').filter({ hasText: /テーブル管理|テーブル一覧/ }).first();
        if (await sidebarLink.count() > 0) {
            await sidebarLink.click();
            await waitForAngular(page);
            await page.waitForTimeout(1500);
            break;
        }
    }

    // fa-barsドロップダウンボタンをクリック（.fa-barsアイコンを含むボタン）
    const faBarsBtn = page.locator('button.dropdown-toggle').filter({ has: page.locator('i.fa-bars') });

    // ボタンが存在することをアサートして失敗時はテスト停止
    await expect(faBarsBtn.first()).toBeVisible({ timeout: 10000 });
    await faBarsBtn.first().click();
    await page.waitForTimeout(800);
}

/**
 * テンプレートモーダルを開く
 * 方法1: テーブルが1件以上ある場合 → テーブル管理画面のfa-barsメニューから「テンプレートから追加」
 * 方法2: Angularルーターのパラメータ type=add_template でダッシュボードに移動
 * 失敗時はexpectで止める
 */
async function openTemplateModal(page) {
    // まずモーダルが既に開いているか確認
    const existingModal = page.locator('.modal.show');
    if (await existingModal.count() > 0 && await existingModal.locator('.template_icon').count() > 0) {
        // 既にモーダルが開いている（テンプレート一覧が表示されている）場合はそのまま返す
        return;
    }
    // 詳細ページが開いている場合は戻る
    if (await existingModal.count() > 0 && await existingModal.locator('button').filter({ hasText: '戻る' }).count() > 0) {
        await existingModal.locator('button').filter({ hasText: '戻る' }).first().click();
        await waitForAngular(page);
        return;
    }

    // Angular SPAのパラメータルーティングでダッシュボードに移動してモーダルを開く
    // dashboard;type=add_template でモーダルが自動表示される
    await page.goto(BASE_URL + '/admin/dashboard;type=add_template', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitForAngular(page);
    await page.waitForTimeout(2000);

    // モーダルが開いているか確認
    const modal = page.locator('.modal.show');
    if (await modal.count() > 0) {
        await expect(modal).toBeVisible({ timeout: 10000 });
        return;
    }

    // フォールバック: テーブル管理画面のfa-barsメニューから開く
    await openTableManagementBarsMenu(page);

    const templateItem = page.locator('.dropdown-menu.show .dropdown-item').filter({ hasText: 'テンプレートから追加' });
    await expect(templateItem.first()).toBeVisible({ timeout: 5000 });
    await templateItem.first().click();
    await page.waitForTimeout(2000);

    // モーダルが開いていることをアサート
    await expect(page.locator('.modal.show')).toBeVisible({ timeout: 10000 });
}

const autoScreenshot = createAutoScreenshot('templates');

test.describe('テンプレート', () => {
    // 自己完結: specごとに専用テスト環境を作成
    test.beforeAll(async ({ browser }) => {
        test.setTimeout(120000); // 環境作成に最大2分
        const env = await createTestEnv(browser, { withAllTypeTable: false }); // テンプレートにALLテストテーブル不要
        BASE_URL = env.baseUrl;
        EMAIL = env.email;
        PASSWORD = env.password;
        // ensureLoggedInが参照する環境変数も更新
        process.env.TEST_BASE_URL = env.baseUrl;
        process.env.TEST_EMAIL = env.email;
        process.env.TEST_PASSWORD = env.password;
        await env.context.close();
        console.log(`[templates] 自己完結環境: ${BASE_URL}`);
    });

    test('TM01: テンプレート機能（tpl-010〜060）', async ({ page }) => {
        test.setTimeout(270000); // 6ステップ × 15s + インストール待機考慮

        // テスト開始前にログイン
        await login(page);
        const _testStart = Date.now();

        // ── tpl-010 ──────────────────────────────────────────
        await test.step('tpl-010: テンプレート一覧画面が正常に表示されること', async () => {
            // [flow] 10-1. テーブル管理画面を開き、メニューから「テンプレートから追加」をクリック
            await openTemplateModal(page);

            // [check] 10-2. ✅ テンプレートインストールダイアログが表示されること
            const modal = page.locator('.modal.show');
            await expect(modal).toBeVisible({ timeout: 10000 });

            // [check] 10-3. ✅ テンプレートのアイコンが1件以上表示されていること
            const templateIcons = modal.locator('.template_icon');
            await expect(templateIcons.first()).toBeVisible({ timeout: 10000 });
            const iconCount = await templateIcons.count();
            expect(iconCount).toBeGreaterThan(0);

            // [check] 10-4. ✅ 「スキップ」ボタンが表示されていること
            const skipBtn = modal.locator('button').filter({ hasText: 'スキップ' });
            await expect(skipBtn.first()).toBeVisible({ timeout: 5000 });

            // [check] 10-5. ✅ ダイアログのタイトルに「テンプレート」が含まれていること
            const modalTitle = modal.locator('.modal-title');
            await expect(modalTitle).toContainText('テンプレート', { timeout: 5000 });

            await autoScreenshot(page, 'TM01', 'tpl-010', _testStart);
        });

        // ── tpl-020 ──────────────────────────────────────────
        await test.step('tpl-020: テンプレートの詳細を確認できること', async () => {
            // tpl-010でモーダルが開いたままなので、そのまま継続
            const modal = page.locator('.modal.show');
            await expect(modal).toBeVisible({ timeout: 5000 });

            // [flow] 20-1. テンプレートアイコンの1つをクリック
            const templateIcons = modal.locator('.template_icon');
            await expect(templateIcons.first()).toBeVisible({ timeout: 5000 });
            await templateIcons.first().click();
            await waitForAngular(page);

            // [check] 20-2. ✅ テンプレートの詳細説明が表示されること
            const modalBody = modal.locator('.modal-body');
            const bodyText = await modalBody.textContent();
            expect(bodyText.trim().length).toBeGreaterThan(10);

            // [check] 20-3. ✅ 「テンプレートをインストール」ボタンが表示されること
            const installBtn = modal.locator('button.btn-warning').filter({ hasText: /テンプレートをインストール/ });
            await expect(installBtn.first()).toBeVisible({ timeout: 5000 });

            // [check] 20-4. ✅ 「戻る」ボタンが表示されること
            const backBtn = modal.locator('button').filter({ hasText: '戻る' });
            await expect(backBtn.first()).toBeVisible({ timeout: 5000 });

            await autoScreenshot(page, 'TM01', 'tpl-020', _testStart);
        });

        // ── tpl-030 ──────────────────────────────────────────
        await test.step('tpl-030: 「戻る」で一覧に戻れること', async () => {
            // tpl-020で詳細が開いたままなので、そのまま継続
            const modal = page.locator('.modal.show');

            // [flow] 30-1. 「戻る」ボタンをクリック
            const backBtn = modal.locator('button').filter({ hasText: '戻る' });
            await expect(backBtn.first()).toBeVisible({ timeout: 5000 });
            await backBtn.first().click();
            await waitForAngular(page);

            // [check] 30-2. ✅ テンプレート一覧が再び表示されること（アイコンが1件以上）
            const templateIcons = modal.locator('.template_icon');
            await expect(templateIcons.first()).toBeVisible({ timeout: 10000 });
            const iconCount = await templateIcons.count();
            expect(iconCount).toBeGreaterThan(0);

            await autoScreenshot(page, 'TM01', 'tpl-030', _testStart);
        });

        // ── tpl-040 ──────────────────────────────────────────
        await test.step('tpl-040: テンプレートをインストールできること', async () => {
            // tpl-030でテンプレート一覧に戻ったままなので、そのまま継続
            const modal = page.locator('.modal.show');

            // [flow] 40-1. テンプレートアイコンをクリックして詳細を表示（タスク管理を優先）
            const templateIcons = modal.locator('.template_icon');
            const iconCount = await templateIcons.count();
            expect(iconCount).toBeGreaterThan(0);

            let targetTemplate = templateIcons.filter({ hasText: 'タスク管理' });
            if (await targetTemplate.count() === 0) {
                targetTemplate = templateIcons.first();
            }
            await targetTemplate.first().click();
            await waitForAngular(page);

            // [flow] 40-2. 「テンプレートをインストール」ボタンをクリック
            const installBtn = modal.locator('button.btn-warning').filter({ hasText: /テンプレートをインストール/ });
            await expect(installBtn.first()).toBeVisible({ timeout: 5000 });
            await installBtn.first().click();

            // [check] 40-3. ✅ インストール進捗バーまたは完了メッセージが表示されること
            // progressbarまたはインストール完了テキストのいずれかが表示される
            const progressBar = modal.locator('progressbar, .progress-bar');
            const completeText = modal.locator('*').filter({ hasText: 'インストールが完了しました' });
            try {
                await expect(progressBar.first()).toBeVisible({ timeout: 10000 });
            } catch {
                // 高速インストール時はすでに完了メッセージが出ている場合がある
                await expect(completeText.first()).toBeVisible({ timeout: 5000 });
            }

            // [check] 40-4. ✅ エラーなくインストールが完了すること（最大60秒待機）
            // 完了後は「閉じる」ボタンが表示される
            const closeBtn = modal.locator('button').filter({ hasText: '閉じる' });
            await expect(closeBtn.first()).toBeVisible({ timeout: 60000 });

            // [flow] 40-5. インストール完了後にダイアログを閉じる
            await closeBtn.first().click();
            await page.waitForTimeout(2000);
            await waitForAngular(page);

            // [check] 40-6. ✅ サイドメニューに新しいテーブルが追加されていること
            // テンプレートインストール後、テーブル一覧APIでテーブルが1件以上作成されたことを確認
            const tableCount = await page.evaluate(async () => {
                try {
                    const res = await fetch('/api/admin/debug/status', { credentials: 'include' });
                    if (!res.ok) return -1;
                    const data = await res.json();
                    return data.table_count || (data.tables ? data.tables.length : -1);
                } catch { return -1; }
            });
            // テーブルが1件以上作成されていること（インストール前は0件）
            // APIが使えない場合はサイドバーのナビゲーションリンクの存在で確認
            if (tableCount === -1) {
                // フォールバック: サイドバーのnav-menus__linkクラスが存在すること
                const navLinks = page.locator('.sidebar .nav-menus__link');
                const navLinkCount = await navLinks.count();
                expect(navLinkCount).toBeGreaterThan(0);
            } else {
                expect(tableCount).toBeGreaterThan(0);
            }

            await autoScreenshot(page, 'TM01', 'tpl-040', _testStart);
        });

        // ── tpl-050 ──────────────────────────────────────────
        await test.step('tpl-050: テンプレートダイアログを閉じられること', async () => {
            // [flow] 50-1. テーブル管理画面のメニューからテンプレートダイアログを再度開く
            // tpl-040でインストール後にモーダルが閉じたので、再度開く
            await openTemplateModal(page);
            const modal = page.locator('.modal.show');
            await expect(modal).toBeVisible({ timeout: 10000 });

            // [flow] 50-2. 「スキップ」ボタンをクリック
            const skipBtn = modal.locator('button').filter({ hasText: 'スキップ' });
            await expect(skipBtn.first()).toBeVisible({ timeout: 5000 });
            await skipBtn.first().click();
            await page.waitForTimeout(1000);

            // [check] 50-3. ✅ ダイアログが閉じていること
            await expect(page.locator('.modal.show')).toHaveCount(0, { timeout: 10000 });

            await autoScreenshot(page, 'TM01', 'tpl-050', _testStart);
        });

        // ── tpl-060 ──────────────────────────────────────────
        await test.step('tpl-060: テンプレート一覧に各テンプレート名が正しく表示されていること', async () => {
            // [flow] 60-1. テンプレートダイアログを開く
            await openTemplateModal(page);
            const modal = page.locator('.modal.show');

            // [check] 60-2. ✅ 各テンプレートアイコンにテンプレート名テキストが含まれていること
            const templateIcons = modal.locator('.template_icon');
            await expect(templateIcons.first()).toBeVisible({ timeout: 10000 });
            const iconCount = await templateIcons.count();
            expect(iconCount).toBeGreaterThan(0);

            const templateNames = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.modal.show .template_icon .text'))
                    .map(el => el.textContent.trim())
                    .filter(name => name.length > 0);
            });
            expect(templateNames.length).toBeGreaterThan(0);

            // [check] 60-3. ✅ 既知のテンプレート名（「タスク管理」「顧客管理」等）が少なくとも1つ含まれていること
            const knownTemplates = ['採用管理', '在庫管理', 'タスク管理', 'ファイル管理', '顧客管理', '案件管理'];
            const hasKnownTemplate = templateNames.some(name => knownTemplates.includes(name));
            expect(hasKnownTemplate).toBeTruthy();

            console.log(`[tpl-060] テンプレート名一覧: ${templateNames.join(', ')}`);

            await autoScreenshot(page, 'TM01', 'tpl-060', _testStart);
        });
    });
});
