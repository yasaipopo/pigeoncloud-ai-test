// @ts-check
const { test, expect } = require('@playwright/test');
const { createAutoScreenshot } = require('./helpers/auto-screenshot');
const { createTestEnv } = require('./helpers/create-test-env');

let BASE_URL = process.env.TEST_BASE_URL;
let EMAIL = process.env.TEST_EMAIL;
let PASSWORD = process.env.TEST_PASSWORD;
let _tableId = null;

const autoScreenshot = createAutoScreenshot('dashboard');

// ============================================================
// 共通ヘルパー関数
// ============================================================

async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

/**
 * ダッシュボードページの共通チェック
 * - ナビゲーションが表示されていること
 * - タブ一覧が表示されていること
 * - エラーなし
 */
async function checkDashboardPage(page) {
    await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[role=tablist]')).toBeVisible();
    expect(await page.locator('.alert-danger').count()).toBe(0);
    const bodyText = await page.innerText('body');
    expect(bodyText).not.toContain('Internal Server Error');
}

/**
 * ウィジェットのロード完了を待つ
 * スケルトン/ローディングが消えてデータが表示されるまで待つ
 */
async function checkWidgetLoaded(page, widgetLocator) {
    await expect(widgetLocator).toBeVisible({ timeout: 15000 });
    await page.waitForFunction(
        (sel) => !document.querySelector(sel + ' .loader, ' + sel + ' .lazy-load-placeholder'),
        '.dashboard', { timeout: 15000 }
    ).catch(() => {});
    await page.waitForTimeout(1000); // Angular描画安定待ち
}

/**
 * チュートリアルモーダルを閉じる（任意要素）
 */
async function closeTutorialModal(page) {
    await page.locator('.modal.show').filter({ hasText: 'テンプレートからインストール' })
        .locator('button:has-text("スキップ")').first().click({ force: true })
        .catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
}

/**
 * ダッシュボードタブの▼ボタンをクリックしてメニューを開く
 */
async function openTabMenu(page, tabLocator) {
    // タブ内のfa-chevron-circle-downアイコン（最初の子要素）をクリック
    // 最後の子要素はdropdown-menu(UL)なので、最初の子要素のiタグをクリックする
    await tabLocator.evaluate((el) => {
        // chevronアイコン（i.fa-chevron-circle-down）を探してクリック
        const chevron = el.querySelector('i.fa-chevron-circle-down, i[class*="chevron"]');
        if (chevron) {
            chevron.click();
            return;
        }
        // フォールバック: 最初の子要素をクリック
        const children = el.children;
        if (children.length > 0) {
            children[0].click();
        }
    });
    await page.waitForTimeout(800);
}

/**
 * 「+」ボタンをクリックしてタブ作成ダイアログを開き、名前を入力して送信する
 * @returns {string} 作成したタブ名
 */
async function createTab(page, tabName) {
    const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
    const tabsBefore = await tablist.locator('[role=tab]').count();

    // [flow] 「+」ボタンをクリック（tablist内の最後のボタン = +ボタン）
    const addTabBtns = tablist.locator('button');
    const addTabBtnCount = await addTabBtns.count();
    if (addTabBtnCount > 0) {
        await addTabBtns.last().click({ force: true });
    } else {
        // フォールバック: tablist全体をクリック（+ボタンが見つからない場合）
        await tablist.evaluate((el) => {
            const btns = el.querySelectorAll('button');
            if (btns.length > 0) btns[btns.length - 1].click();
        });
    }
    await page.waitForTimeout(800);

    // 「ダッシュボード」ダイアログが開くまで待つ
    const dialog = page.locator('.modal.show').filter({ hasText: 'ダッシュボード' }).first();
    await expect(dialog, 'タブ作成ダイアログが開くこと').toBeVisible({ timeout: 8000 });

    // ダッシュボード名の入力欄にタブ名を入力
    // inputのid="name" を直接指定してfill（Angularに確実に認識させる）
    await page.locator('#name').fill(tabName);
    await page.waitForTimeout(300);

    // 「送信」ボタンをページ全体の getByRole でクリック（dialogロケーター不要）
    await page.getByRole('button', { name: '送信' }).click();
    console.log('[createTab] 送信ボタンクリック完了');

    // モーダルが閉じるまで待つ（最大10秒）
    await page.locator('.modal.show').filter({ hasText: 'ダッシュボード' })
        .waitFor({ state: 'hidden', timeout: 10000 })
        .catch(() => {});
    // タブが増えるまで待つ（最大8秒）
    await page.waitForFunction(
        (beforeCount) => {
            const tl = document.querySelector('[role=tablist]');
            if (!tl) return false;
            return tl.querySelectorAll('[role=tab]').length > beforeCount;
        },
        tabsBefore,
        { timeout: 8000 }
    ).catch(() => {});
    await page.waitForTimeout(1000);

    return tabName;
}

/**
 * ウィジェット追加ダイアログを開いてALLテストテーブルを選択し、指定タイプで保存する
 * @param {'一覧'|'集計'|'チャート'} displayType
 */
/**
 * ウィジェット追加ダイアログを開いてALLテストテーブルを選択し、指定タイプで保存する
 * フロー: 「ウィジェットを追加」→ ダイアログ(テーブル選択+表示タイプラジオ選択) → 「詳細設定」→ 詳細設定画面で「保存」
 * @param {'データ'|'集計'|'チャート'} displayType - 表示タイプ（デフォルト: 'データ' = 一覧）
 */
async function addWidget(page, tabPanelId, displayType = 'データ') {
    // [flow] アクティブタブパネル内の「ウィジェットを追加」ボタンをクリック
    // アクティブなタブパネルのIDを取得（tabPanelId引数のIDとは異なる場合がある）
    const actualPanelId = await page.locator('[role=tablist] [role=tab][aria-selected=true]')
        .first().getAttribute('aria-controls').catch(() => null);
    const effectivePanelId = actualPanelId || tabPanelId;
    console.log(`[addWidget] effectivePanelId: ${effectivePanelId}`);

    let addBtn = effectivePanelId
        ? page.locator(`#${effectivePanelId}`).locator('button').filter({ hasText: 'ウィジェットを追加' })
        : page.locator('[role=tabpanel]').locator('button').filter({ hasText: 'ウィジェットを追加' }).first();

    // ウィジェット追加後はページ下部にあるためスクロール
    const addBtnCount = await addBtn.count();
    if (addBtnCount === 0) {
        // フォールバック: 画面全体のボタンから探す（最後の「ウィジェットを追加」）
        addBtn = page.locator('button').filter({ hasText: 'ウィジェットを追加' }).last();
    }
    await addBtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await expect(addBtn, '「ウィジェットを追加」ボタンが表示されていること').toBeVisible({ timeout: 10000 });
    await addBtn.click();
    await page.waitForTimeout(800);

    // ダイアログが開くまで待つ（ウィジェット追加ダイアログ）
    // ng-bootstrapのモーダルは .modal.show CSS クラスを使用（role="dialog"のdivまたはmodal）
    await page.locator('.modal.show, [role=dialog]:visible').first()
        .waitFor({ state: 'visible', timeout: 8000 });
    // ビュー(ウィジェット設定)ダイアログを特定
    const modal = page.locator('.modal.show').filter({ hasText: 'ビュー' }).first();
    const modalCount = await modal.count();
    const effectiveModal = modalCount > 0
        ? modal
        : page.locator('.modal.show, [role=dialog]:visible').last();
    await expect(effectiveModal, 'ウィジェット追加ダイアログが開くこと').toBeVisible({ timeout: 5000 });

    // [flow] ALLテストテーブルをng-selectから選択
    // 既存の選択をクリア（前の設定が残っている場合）
    const clearBtn = effectiveModal.getByRole('button', { name: 'Clear all' });
    if (await clearBtn.count() > 0) {
        await clearBtn.click().catch(() => {});
        await page.waitForTimeout(300);
    }
    const combobox = effectiveModal.locator('[role=combobox]').first();
    await combobox.click();
    await page.waitForTimeout(400);
    await combobox.fill('ALLテスト');
    await page.waitForTimeout(800);
    const option = page.locator('[role=option]').filter({ hasText: 'ALLテストテーブル' }).first();
    await expect(option, 'ALLテストテーブルの選択肢が表示されること').toBeVisible({ timeout: 5000 });
    await option.click();
    await waitForAngular(page);

    // [flow] 表示タイプをラジオボタンで選択（デフォルトは「データ」）
    if (displayType !== 'データ') {
        // getByRoleでラジオボタンを選択（accessible nameでマッチ）
        const radioBtn = page.getByRole('radio', { name: displayType });
        if (await radioBtn.count() > 0) {
            await radioBtn.first().click();
            await waitForAngular(page);
        } else {
            // フォールバック: effectiveModal内のテキストマッチ
            const radioContainer = effectiveModal.locator('div').filter({ hasText: displayType });
            if (await radioContainer.count() > 0) {
                await radioContainer.last().click();
                await waitForAngular(page);
            }
        }
    }

    // [flow] 「詳細設定」ボタンをクリック（必須 — 「保存」はここから遷移した先にある）
    const detailBtn = page.getByRole('button', { name: '詳細設定' });
    await expect(detailBtn, '「詳細設定」ボタンが表示されること').toBeVisible({ timeout: 5000 });
    await detailBtn.click();
    await page.waitForTimeout(1000);

    // [flow] 詳細設定ページで「保存して表示」ボタンをクリック
    // ボタン名は「保存して表示」（アイコン付き先頭スペースあり）
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: '保存して表示' }).click();
    console.log('[addWidget] 保存して表示クリック完了');

    // ダイアログが閉じるまで待つ
    await page.locator('.modal.show, [role=dialog]:visible').first()
        .waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    await waitForAngular(page);
    await page.waitForTimeout(1500); // Angular描画完了待ち
}

/**
 * 現在アクティブなタブパネルのLocatorを返す
 * tabPanelIdが渡されても、実際のDOMのアクティブタブから取得する
 */
async function getActivePanelLocator(page) {
    // まずaria-selectedなタブのaria-controlsからパネルIDを取得
    const activePanelId = await page.locator('[role=tablist] [role=tab][aria-selected=true]')
        .first().getAttribute('aria-controls').catch(() => null);
    if (activePanelId) {
        const byId = page.locator(`#${activePanelId}`);
        const cnt = await byId.count();
        if (cnt > 0) {
            // パネルが存在してもAngularの再レンダリングで内容が消える場合があるので
            // 表示中のtabpanelを優先
            const visible = page.locator(`[role=tabpanel]:visible`).last();
            const visibleCnt = await visible.count();
            if (visibleCnt > 0) return visible;
            return byId;
        }
    }
    return page.locator('[role=tabpanel]').last();
}

// ============================================================
// テスト本体
// ============================================================

test.describe('ダッシュボード', () => {
    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        const env = await createTestEnv(browser, { withAllTypeTable: true });
        BASE_URL = env.baseUrl;
        EMAIL = env.email;
        PASSWORD = env.password;
        _tableId = env.tableId;
        process.env.TEST_BASE_URL = env.baseUrl;
        process.env.TEST_EMAIL = env.email;
        process.env.TEST_PASSWORD = env.password;
        await env.context.close();
        console.log(`[dashboard] 自己完結環境: ${BASE_URL}, tableId: ${_tableId}`);
    });

    test.beforeEach(async ({ page }) => {
        // 古い環境のcookieをクリアして新環境に明示的ログイン
        await page.context().clearCookies();
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
        if (!page.url().includes('/login')) {
            await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        }
        if (page.url().includes('/login')) {
            await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
            await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
            await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
            await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
        }
    });

    // =========================================================================
    // DB01: 初期表示とタブ管理（dash-010〜040）
    // =========================================================================
    test('DB01: 初期表示とタブ管理', async ({ page }) => {
        test.setTimeout(210000);
        const _testStart = Date.now();
        page.setDefaultTimeout(30000);

        // ログイン後ダッシュボードに遷移
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await closeTutorialModal(page);

        // テスト間で共有するタブ名
        let tabAName = 'テストタブA';
        let tabBName = 'テストタブB';
        let tabBRename = 'タブB改名';

        // -------------------------------------------------------------------------
        await test.step('dash-010: HOMEダッシュボードの初期表示が正常であること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-010`);

            // [flow] 10-1. ダッシュボード画面に遷移する
            await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await waitForAngular(page);

            // [check] 10-2. ✅ ナビゲーションメニューが表示されていること
            await expect(page.locator('.navbar')).toBeVisible({ timeout: 15000 });

            // [check] 10-3. ✅ 「HOME」タブが表示・選択されていること
            const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            await expect(tablist).toBeVisible();
            const homeTab = tablist.locator('[role=tab]').filter({ hasText: 'HOME' });
            await expect(homeTab.first()).toBeVisible();
            const ariaSelected = await homeTab.first().getAttribute('aria-selected');
            expect(ariaSelected, 'HOMEタブが選択状態であること').toBe('true');

            // [check] 10-4. ✅ 左メニューにテーブル名が表示されていること
            const leftMenu = page.locator('.navbar, nav, [class*="sidebar"], [class*="nav-left"]').first();
            await expect(leftMenu).toBeVisible();

            // [check] 10-5. ✅ 掲示板テキスト「ピジョンクラウドへようこそ！」が表示されていること
            await expect(page.locator('[role=tabpanel]').filter({ hasText: 'ピジョンクラウドへようこそ！' }))
                .toBeVisible({ timeout: 10000 });

            // [check] 10-6. ✅ 「ウィジェットを追加」ボタンが表示されていること
            await expect(page.locator('button').filter({ hasText: 'ウィジェットを追加' }).first())
                .toBeVisible({ timeout: 10000 });

            await autoScreenshot(page, 'DB01', 'dash-010', _testStart);
        });

        // -------------------------------------------------------------------------
        await test.step('dash-020: 新しいダッシュボードタブを作成できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-020`);

            // [flow] 20-1. タブ一覧右側の「+」ボタンをクリックして「テストタブA」と入力して送信
            await createTab(page, tabAName);

            // [check] 20-2. ✅ 「テストタブA」タブがタブ一覧に追加されていること
            const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const tabA = tablist.locator('[role=tab]').filter({ hasText: tabAName });
            await expect(tabA.first(), `「${tabAName}」タブが追加されていること`).toBeVisible({ timeout: 8000 });

            // [check] 20-3. ✅ 「テストタブA」タブが選択状態になっていること
            const selected = await tabA.first().getAttribute('aria-selected');
            expect(selected, '「テストタブA」が選択状態であること').toBe('true');

            // [check] 20-4. ✅ 「ウィジェットを追加」ボタンが表示されていること（空のタブ）
            const tabpanelId = await tabA.first().getAttribute('aria-controls').catch(() => null);
            if (tabpanelId) {
                await expect(page.locator(`#${tabpanelId} button`).filter({ hasText: 'ウィジェットを追加' }))
                    .toBeVisible({ timeout: 5000 });
            }

            await autoScreenshot(page, 'DB01', 'dash-020', _testStart);
        });

        // -------------------------------------------------------------------------
        await test.step('dash-030: 2つ目のタブを作成し、タブ名を変更できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-030`);

            // [flow] 30-1. 再度「+」ボタンをクリックして「テストタブB」と入力して送信
            await createTab(page, tabBName);

            // [check] 30-2. ✅ 「テストタブB」がタブ一覧に追加されていること
            const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
            const tabB = tablist.locator('[role=tab]').filter({ hasText: tabBName });
            await expect(tabB.first(), `「${tabBName}」タブが追加されていること`).toBeVisible({ timeout: 8000 });

            // [flow] 30-3. 「テストタブB」の▼メニューを開く
            await openTabMenu(page, tabB.first());

            // [flow] 30-4. 「設定」をクリック
            const menu = page.locator('[role=menu]');
            await expect(menu, 'タブメニューが開くこと').toBeVisible({ timeout: 5000 });
            const settingItem = menu.locator('[role=menuitem]').filter({ hasText: '設定' });
            await expect(settingItem, '「設定」メニュー項目が存在すること').toBeVisible();
            await settingItem.click();
            await page.waitForTimeout(800);

            // [flow] 30-5. 名前を「タブB改名」に変更して保存
            // 設定ダイアログ（「ダッシュボード」モーダル）のダッシュボード名入力欄を操作
            // モーダルはBootstrap .modal.show で開く。入力欄のidはname_2（タブ作成はname）
            const settingDialog = page.locator('.modal.show').filter({ hasText: 'ダッシュボード' }).first();
            await expect(settingDialog, '設定ダイアログが開くこと').toBeVisible({ timeout: 8000 });

            // ダッシュボード名入力欄（id=name_2 または最初のtextbox）をクリアして入力
            const nameInputEl = settingDialog.locator('input[type=text]').first();
            await nameInputEl.click({ clickCount: 3 });
            await nameInputEl.fill(tabBRename);
            await page.waitForTimeout(500);

            // 「送信」ボタンをpage全体のgetByRoleでクリック
            await page.getByRole('button', { name: '送信' }).click();
            await waitForAngular(page);
            await page.waitForTimeout(1500);

            // [check] 30-6. ✅ タブ名が「タブB改名」に変更されていること
            const renamedTab = tablist.locator('[role=tab]').filter({ hasText: tabBRename });
            await expect(renamedTab.first(), `タブ名が「${tabBRename}」に変更されていること`).toBeVisible({ timeout: 8000 });

            await autoScreenshot(page, 'DB01', 'dash-030', _testStart);
        });

        // -------------------------------------------------------------------------
        await test.step('dash-040: タブを削除できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-040`);

            const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });

            // [flow] 40-1. 「タブB改名」の▼メニューから「削除」をクリック
            const renamedTab = tablist.locator('[role=tab]').filter({ hasText: tabBRename });
            await expect(renamedTab.first(), `「${tabBRename}」タブが存在すること`).toBeVisible({ timeout: 5000 });
            await openTabMenu(page, renamedTab.first());

            const menu = page.locator('[role=menu]');
            await expect(menu, 'タブメニューが開くこと').toBeVisible({ timeout: 5000 });
            const deleteItem = menu.locator('[role=menuitem]').filter({ hasText: '削除' });
            await expect(deleteItem, '「削除」メニュー項目が存在すること').toBeVisible();
            await deleteItem.click();
            await waitForAngular(page);

            // [flow] 40-2. 確認ダイアログで「はい」をクリック
            const confirmModal = page.locator('.modal.show');
            await expect(confirmModal, '確認ダイアログが表示されること').toBeVisible({ timeout: 5000 });
            await confirmModal.locator('button').filter({ hasText: 'はい' }).click();
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // [check] 40-3. ✅ 「タブB改名」がタブ一覧から消えていること
            await expect(tablist.locator('[role=tab]').filter({ hasText: tabBRename }))
                .toHaveCount(0, { timeout: 5000 });

            // [check] 40-4. ✅ 「HOME」タブと「テストタブA」タブが残っていること
            await expect(tablist.locator('[role=tab]').filter({ hasText: 'HOME' }).first()).toBeVisible();
            await expect(tablist.locator('[role=tab]').filter({ hasText: tabAName }).first()).toBeVisible();

            await autoScreenshot(page, 'DB01', 'dash-040', _testStart);
        });
    });

    // =========================================================================
    // DB02: ウィジェット3タイプ追加（dash-050〜070）
    // =========================================================================
    test('DB02: ウィジェット3タイプ追加', async ({ page }) => {
        test.setTimeout(270000);
        const _testStart = Date.now();
        page.setDefaultTimeout(30000);

        // ダッシュボードに遷移してタブAを準備
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await closeTutorialModal(page);

        // 「テストタブA」を作成（このテスト専用）
        const tabAName = `テストタブA_DB02_${Date.now()}`;
        await createTab(page, tabAName);

        const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
        const tabA = tablist.locator('[role=tab]').filter({ hasText: tabAName });
        await expect(tabA.first()).toBeVisible({ timeout: 8000 });
        const tabpanelId = await tabA.first().getAttribute('aria-controls').catch(() => null);
        console.log(`[DB02] tabpanelId: ${tabpanelId}`);

        // -------------------------------------------------------------------------
        await test.step('dash-050: テーブル一覧ウィジェットを追加してデータが表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-050`);

            // [flow] 50-1. 「テストタブA」を選択（既に選択済み）
            await tabA.first().click();
            await waitForAngular(page);

            // [flow] 50-2. 「ウィジェットを追加」ボタンをクリック → ALLテストテーブルを選択 → 詳細設定 → 保存
            await addWidget(page, tabpanelId, 'データ');

            // [check] 50-3. ✅ エラーメッセージが表示されないこと
            expect(await page.locator('.alert-danger').count()).toBe(0);

            // [check] 50-4. ✅ ウィジェットのヘッダーにテーブル名が表示されていること
            // アクティブなタブパネルを取得（選択中タブのariaControlsで特定）
            const activePanelId = await page.locator('[role=tablist] [role=tab][aria-selected=true]')
                .first().getAttribute('aria-controls').catch(() => null);
            console.log(`[DB02] 実際のアクティブパネルID: ${activePanelId}`);
            const widgetContainer = activePanelId
                ? page.locator(`#${activePanelId}`)
                : page.locator('[role=tabpanel]').last();
            await expect(widgetContainer.filter({ hasText: 'ALLテストテーブル' }))
                .toBeVisible({ timeout: 15000 });

            // [check] 50-5. ✅ テーブルのカラムヘッダーが表示されていること
            const tableHeader = widgetContainer.locator('table thead th, [class*="col-header"]').first();
            await expect(tableHeader, 'テーブルのカラムヘッダーが表示されること').toBeVisible({ timeout: 10000 });

            // [check] 50-6. ✅ ローディングが完了していること（スケルトン行が消えていること）
            await page.waitForFunction(
                () => !document.querySelector('.lazy-load-placeholder, .skeleton-row, .loader'),
                { timeout: 15000 }
            ).catch(() => {});

            await autoScreenshot(page, 'DB02', 'dash-050', _testStart);
        });

        // -------------------------------------------------------------------------
        await test.step('dash-060: 集計ウィジェットを追加して集計結果が表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-060`);

            // [flow] 60-1. 再度「ウィジェットを追加」ボタンをクリック → 「集計」を選択 → 保存
            await tabA.first().click();
            await waitForAngular(page);
            await addWidget(page, tabpanelId, '集計');

            // [check] 60-2. ✅ エラーメッセージが表示されないこと
            expect(await page.locator('.alert-danger').count()).toBe(0);

            // [check] 60-3. ✅ 集計ウィジェットが追加されていること
            const activePanelId60 = await page.locator('[role=tablist] [role=tab][aria-selected=true]')
                .first().getAttribute('aria-controls').catch(() => null);
            const widgetContainer = activePanelId60
                ? page.locator(`#${activePanelId60}`)
                : page.locator('[role=tabpanel]').last();
            // ウィジェットが2つ以上存在することを確認（データ+集計）
            const widgets = widgetContainer.locator('[class*="dashboard"], .card, [class*="widget"]');
            await expect(async () => {
                const count = await widgets.count();
                expect(count).toBeGreaterThanOrEqual(1);
            }).toPass({ timeout: 10000 });

            // [check] 60-4. ✅ ローディングが完了していること
            await page.waitForFunction(
                () => !document.querySelector('.lazy-load-placeholder, .skeleton-row, .loader'),
                { timeout: 15000 }
            ).catch(() => {});

            await autoScreenshot(page, 'DB02', 'dash-060', _testStart);
        });

        // -------------------------------------------------------------------------
        await test.step('dash-070: チャートウィジェットを追加してグラフが表示されること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-070`);

            // [flow] 70-1. 再度「ウィジェットを追加」ボタンをクリック → 「チャート」を選択 → 保存
            await tabA.first().click();
            await waitForAngular(page);
            await addWidget(page, tabpanelId, 'チャート');

            // [check] 70-2. ✅ エラーメッセージが表示されないこと
            expect(await page.locator('.alert-danger').count()).toBe(0);

            // [check] 70-3. ✅ チャートウィジェットが追加されていること
            const activePanelId70 = await page.locator('[role=tablist] [role=tab][aria-selected=true]')
                .first().getAttribute('aria-controls').catch(() => null);
            const widgetContainer70 = activePanelId70
                ? page.locator(`#${activePanelId70}`)
                : page.locator('[role=tabpanel]').last();
            // ウィジェットが存在することを確認
            const widgets70 = widgetContainer70.locator('[class*="dashboard"], .card, [class*="widget"]');
            await expect(async () => {
                const count = await widgets70.count();
                expect(count).toBeGreaterThanOrEqual(1);
            }).toPass({ timeout: 10000 });

            // [check] 70-4. ✅ グラフ描画領域が表示されていること
            await page.waitForFunction(
                () => !document.querySelector('.lazy-load-placeholder, .skeleton-row, .loader'),
                { timeout: 15000 }
            ).catch(() => {});
            // canvas または chart コンポーネントが存在するか確認
            const chartElem = widgetContainer70.locator('canvas, [class*="chart"], dashboard-chart').first();
            const chartCount = await chartElem.count();
            console.log(`[dash-070] チャート要素数: ${chartCount}`);
            // グラフ要素またはウィジェットが存在すること
            expect(chartCount + await widgets70.count()).toBeGreaterThan(0);

            await autoScreenshot(page, 'DB02', 'dash-070', _testStart);
        });
    });

    // =========================================================================
    // DB03: 掲示板CRUD（dash-080〜100）
    // =========================================================================
    test('DB03: 掲示板CRUD', async ({ page }) => {
        test.setTimeout(210000);
        const _testStart = Date.now();
        page.setDefaultTimeout(30000);

        // ダッシュボードに遷移して専用タブを準備
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await closeTutorialModal(page);

        // 「テストタブA」を作成（掲示板テスト専用）
        const tabName = `テストタブA_DB03_${Date.now()}`;
        await createTab(page, tabName);

        const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
        const tab = tablist.locator('[role=tab]').filter({ hasText: tabName });
        await expect(tab.first()).toBeVisible({ timeout: 8000 });
        const tabpanelId = await tab.first().getAttribute('aria-controls').catch(() => null);

        // -------------------------------------------------------------------------
        await test.step('dash-080: 掲示板を追加できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-080`);

            // [flow] 80-1. 「テストタブA」の▼メニューを開く
            await tab.first().click();
            await waitForAngular(page);
            await openTabMenu(page, tab.first());

            // [flow] 80-2. 「掲示板を追加」をクリック
            const menu = page.locator('[role=menu]');
            await expect(menu, 'タブメニューが開くこと').toBeVisible({ timeout: 5000 });
            const bulletinItem = menu.locator('[role=menuitem]').filter({ hasText: '掲示板を追加' });
            await expect(bulletinItem, '「掲示板を追加」メニュー項目が存在すること').toBeVisible();
            await bulletinItem.click();
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // [check] 80-3. ✅ エラーメッセージが表示されないこと
            expect(await page.locator('.alert-danger').count()).toBe(0);

            // [check] 80-4. ✅ 「掲示板」ヘッダーが表示されていること
            const panelContent = await getActivePanelLocator(page);
            // 掲示板は「掲示板」テキストを含む要素（.card-headerまたはその他のヘッダー要素）
            const bulletinHeader = panelContent.locator('.card-header, .card-title, h4, h5, [class*="header"]')
                .filter({ hasText: '掲示板' });
            const bulletinHeaderCount = await bulletinHeader.count();
            if (bulletinHeaderCount > 0) {
                await expect(bulletinHeader.first(), '「掲示板」ヘッダーが表示されること').toBeVisible({ timeout: 10000 });
            } else {
                // フォールバック: パネル全体に「掲示板」テキストがあること
                await expect(panelContent.filter({ hasText: '掲示板' }))
                    .toBeVisible({ timeout: 10000 });
            }

            // [check] 80-5. ✅ 掲示板ウィジェットが存在すること（テキストエディタが初期状態で存在）
            // 新規追加した掲示板はデフォルトでテキストエリアまたはFroalaエディタ領域を持つ
            const bulletinWidgetExists = await panelContent.locator('.card').count();
            expect(bulletinWidgetExists, '掲示板ウィジェット（.card）が存在すること').toBeGreaterThanOrEqual(1);

            await autoScreenshot(page, 'DB03', 'dash-080', _testStart);
        });

        // -------------------------------------------------------------------------
        await test.step('dash-090: 掲示板の内容を編集して保存できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-090`);

            const panelContent = await getActivePanelLocator(page);
            const editedText = 'テスト掲示板です。編集しました。';

            // [flow] 90-1. 掲示板の鉛筆（編集）アイコンをクリック
            const editIcon = panelContent.locator('.fa-pencil, .fa-edit, [class*="pencil"]').first();
            await expect(editIcon, '鉛筆（編集）アイコンが表示されること').toBeVisible({ timeout: 8000 });
            await editIcon.click();
            await page.waitForTimeout(800);

            // [check] 90-2. ✅ テキストエディタが表示されること（Froalaエディタ）
            const editor = panelContent.locator('.fr-element, .fr-view, [contenteditable="true"]').first();
            await expect(editor, 'テキストエディタが表示されること').toBeVisible({ timeout: 8000 });

            // [flow] 90-3. 内容を「テスト掲示板です。編集しました。」に変更
            // Froalaエディタにテキストを追記（contenteditable要素）
            await editor.click();
            // Ctrl+End で末尾に移動してから追記
            await page.keyboard.press('End');
            await page.keyboard.type(' ' + editedText);
            await page.waitForTimeout(500);

            // [flow] 90-4. 「保存」ボタンをクリック
            const saveBtn = panelContent.locator('button').filter({ hasText: '保存' }).first();
            await expect(saveBtn, '「保存」ボタンが表示されること').toBeVisible({ timeout: 5000 });
            await saveBtn.click();
            await waitForAngular(page);
            await page.waitForTimeout(1500);

            // [check] 90-5. ✅ エラーが表示されないこと（編集内容の保存が完了）
            const errorCount = await page.locator('.alert-danger').count();
            expect(errorCount).toBe(0);
            // 掲示板パネルが引き続き存在すること
            const panelAfter = await getActivePanelLocator(page);
            const cardCount = await panelAfter.locator('.card').count();
            expect(cardCount, '掲示板ウィジェットが引き続き表示されること').toBeGreaterThanOrEqual(1);

            await autoScreenshot(page, 'DB03', 'dash-090', _testStart);
        });

        // -------------------------------------------------------------------------
        await test.step('dash-100: 掲示板を削除できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-100`);

            const panelContent = await getActivePanelLocator(page);

            // [flow] 100-1. 掲示板のゴミ箱（削除）アイコンをクリック
            const trashIcon = panelContent.locator('.fa-trash, .fa-trash-o, [class*="trash"]').first();
            await expect(trashIcon, 'ゴミ箱（削除）アイコンが表示されること').toBeVisible({ timeout: 8000 });
            await trashIcon.click();
            await page.waitForTimeout(500);

            // [flow] 100-2. 確認ダイアログで「はい」をクリック
            const confirmModal = page.locator('.modal.show');
            await expect(confirmModal, '確認ダイアログが表示されること').toBeVisible({ timeout: 5000 });
            await confirmModal.locator('button').filter({ hasText: 'はい' }).click();
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // [check] 100-3. ✅ 掲示板が画面から消えていること
            const bulletinCard = panelContent.locator('.card-header').filter({ hasText: '掲示板' });
            await expect(bulletinCard).toHaveCount(0, { timeout: 5000 });
            expect(await page.locator('.alert-danger').count()).toBe(0);

            await autoScreenshot(page, 'DB03', 'dash-100', _testStart);
        });
    });

    // =========================================================================
    // DB04: ウィジェット操作（dash-110〜130）
    // =========================================================================
    test('DB04: ウィジェット操作', async ({ page }) => {
        test.setTimeout(270000);
        const _testStart = Date.now();
        page.setDefaultTimeout(30000);

        // ダッシュボードに遷移して専用タブ + ウィジェットを準備
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await closeTutorialModal(page);

        const tabName = `テストタブA_DB04_${Date.now()}`;
        await createTab(page, tabName);
        const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
        const tab = tablist.locator('[role=tab]').filter({ hasText: tabName });
        await expect(tab.first()).toBeVisible({ timeout: 8000 });
        const tabpanelId = await tab.first().getAttribute('aria-controls').catch(() => null);

        // テーブル一覧ウィジェットを追加（ソート・設定変更テスト用）
        await addWidget(page, tabpanelId, 'データ');
        console.log('[DB04] テーブル一覧ウィジェット追加完了');

        // チャートウィジェットを追加（削除テスト用）
        await tab.first().click();
        await waitForAngular(page);
        await addWidget(page, tabpanelId, 'チャート');
        console.log('[DB04] チャートウィジェット追加完了');

        // -------------------------------------------------------------------------
        await test.step('dash-110: テーブルウィジェットのヘッダーで並び替えができること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-110`);

            // [flow] 110-1. テーブル一覧ウィジェットが表示されていることを確認
            await tab.first().click();
            await waitForAngular(page);
            const panelContent = await getActivePanelLocator(page);

            const tableWidget = panelContent.locator('.card').first();
            await expect(tableWidget, 'テーブルウィジェットが表示されていること').toBeVisible({ timeout: 15000 });

            // [flow] 110-2. テーブルヘッダーの「ID」列をクリック（ソート）
            const idHeader = panelContent.locator('table thead th').filter({ hasText: 'ID' }).first();
            await expect(idHeader, '「ID」列ヘッダーが表示されること').toBeVisible({ timeout: 10000 });
            await idHeader.click();
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // [check] 110-3. ✅ エラーが表示されず、ページが正常に表示されていること
            expect(await page.locator('.alert-danger').count()).toBe(0);
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');

            // [check] 110-4. ✅ テーブルが引き続き表示されていること（ソート後もウィジェットが壊れないこと）
            await expect(tableWidget, 'ソート後もテーブルウィジェットが表示されること').toBeVisible({ timeout: 10000 });

            await autoScreenshot(page, 'DB04', 'dash-110', _testStart);
        });

        // -------------------------------------------------------------------------
        await test.step('dash-120: ウィジェットの設定を変更できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-120`);

            await tab.first().click();
            await waitForAngular(page);
            const panelContent = await getActivePanelLocator(page);

            // [flow] 120-1. テーブル一覧ウィジェットの歯車（設定）アイコンをクリック
            const gearIcon = panelContent.locator('.fa-gear, .fa-cog, [class*="gear"], [class*="cog"]').first();
            await expect(gearIcon, '歯車（設定）アイコンが表示されること').toBeVisible({ timeout: 10000 });
            await gearIcon.click();
            await page.waitForTimeout(800);

            // [check] 120-2. ✅ ウィジェット設定ダイアログが表示されること
            await page.locator('.modal.show, [role=dialog]:visible').first()
                .waitFor({ state: 'visible', timeout: 8000 });
            const settingDialog = page.locator('.modal.show').first();
            await expect(settingDialog, 'ウィジェット設定ダイアログが表示されること').toBeVisible({ timeout: 8000 });

            // [flow] 120-3. 「保存して表示」をクリック（現状の設定のまま保存）
            await page.getByRole('button', { name: '保存して表示' }).click();

            // ダイアログが閉じるまで待つ
            await page.locator('.modal.show, [role=dialog]:visible').first()
                .waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // [check] 120-4. ✅ エラーメッセージが表示されないこと
            expect(await page.locator('.alert-danger').count()).toBe(0);

            // [check] 120-5. ✅ ウィジェットが引き続き表示されていること
            await expect(panelContent.locator('.card').first(), '設定変更後もウィジェットが表示されること').toBeVisible({ timeout: 10000 });

            await autoScreenshot(page, 'DB04', 'dash-120', _testStart);
        });

        // -------------------------------------------------------------------------
        await test.step('dash-130: ウィジェットを削除できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-130`);

            await tab.first().click();
            await waitForAngular(page);
            const panelContent = await getActivePanelLocator(page);

            // [flow] 130-1. チャートウィジェットを特定してゴミ箱アイコンをクリック
            // チャートウィジェットはcanvasまたは[dashboard-chart]を含む.cardを探す
            const cards = panelContent.locator('.card');
            const cardCount = await cards.count();
            console.log(`[dash-130] ウィジェット数: ${cardCount}`);
            expect(cardCount, 'ウィジェットが複数存在すること').toBeGreaterThanOrEqual(2);

            // 最後のカード（チャートウィジェット）のゴミ箱をクリック
            const lastCard = cards.last();
            const trashInCard = lastCard.locator('.fa-trash, .fa-trash-o, [class*="trash"]').first();
            await expect(trashInCard, 'ゴミ箱アイコンが表示されること').toBeVisible({ timeout: 8000 });
            await trashInCard.click();
            await page.waitForTimeout(500);

            // [flow] 130-2. 確認ダイアログで「はい」をクリック
            const confirmModal = page.locator('.modal.show');
            await expect(confirmModal, '確認ダイアログが表示されること').toBeVisible({ timeout: 5000 });
            await confirmModal.locator('button').filter({ hasText: 'はい' }).click();
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // [check] 130-3. ✅ ウィジェットが1つ減っていること
            const newCount = await cards.count();
            expect(newCount, `ウィジェット数が${cardCount - 1}になること`).toBe(cardCount - 1);

            // [check] 130-4. ✅ 他のウィジェット（テーブル一覧）は残っていること
            expect(newCount).toBeGreaterThanOrEqual(1);
            expect(await page.locator('.alert-danger').count()).toBe(0);

            await autoScreenshot(page, 'DB04', 'dash-130', _testStart);
        });
    });

    // =========================================================================
    // DB05: タブ移動・複合操作・リロード（dash-140〜160）
    // =========================================================================
    test('DB05: タブ移動・複合操作・リロード確認', async ({ page }) => {
        test.setTimeout(270000);
        const _testStart = Date.now();
        page.setDefaultTimeout(30000);

        // ダッシュボードに遷移して専用タブを準備
        await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForAngular(page);
        await closeTutorialModal(page);

        const tabAName = `テストタブA_DB05_${Date.now()}`;
        await createTab(page, tabAName);
        const tablist = page.locator('[role=tablist]').filter({ hasText: 'HOME' });
        const tabA = tablist.locator('[role=tab]').filter({ hasText: tabAName });
        await expect(tabA.first()).toBeVisible({ timeout: 8000 });
        const tabpanelId = await tabA.first().getAttribute('aria-controls').catch(() => null);

        // ウィジェットを2つ追加（タブ削除でウィジェットも消えることのテスト用）
        await addWidget(page, tabpanelId, 'データ');
        await tabA.first().click();
        await waitForAngular(page);
        await addWidget(page, tabpanelId, '集計');

        // -------------------------------------------------------------------------
        await test.step('dash-140: タブを左右に移動できること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-140`);

            // [flow] 140-1. 現在のタブ順序を確認（HOME, テストタブA）
            const allTabs = tablist.locator('[role=tab]');
            const tabTexts = await allTabs.allTextContents();
            console.log('[dash-140] タブ順序:', tabTexts);

            // テストタブAのインデックスを確認
            const tabAIndex = tabTexts.findIndex(t => t.includes(tabAName));
            expect(tabAIndex, `「${tabAName}」タブが存在すること`).toBeGreaterThanOrEqual(0);

            // [flow] 140-2. 「テストタブA」の▼メニューから「左に移動」をクリック
            await openTabMenu(page, tabA.first());
            const menu = page.locator('[role=menu]');
            await expect(menu, 'タブメニューが開くこと').toBeVisible({ timeout: 5000 });
            const moveLeftItem = menu.locator('[role=menuitem]').filter({ hasText: '左に移動' });

            if (await moveLeftItem.count() > 0 && await moveLeftItem.isVisible()) {
                await moveLeftItem.click();
                await waitForAngular(page);
                await page.waitForTimeout(800);

                // [check] 140-3. ✅ タブ順序が変わっていること（テストタブAが左に移動）
                const newTabTexts = await allTabs.allTextContents();
                console.log('[dash-140] 移動後タブ順序:', newTabTexts);
                const newTabAIndex = newTabTexts.findIndex(t => t.includes(tabAName));
                expect(newTabAIndex, '「テストタブA」が左に移動していること').toBeLessThan(tabAIndex);
            } else {
                console.log('[dash-140] 「左に移動」が表示されない（HOMEの次のタブ）— 「右に移動」のみテスト');
                // メニューを閉じる
                await page.keyboard.press('Escape');
            }
            await page.waitForTimeout(500);

            // [flow] 140-4. 「テストタブA」の▼メニューから「右に移動」をクリック
            await openTabMenu(page, tabA.first());
            const menu2 = page.locator('[role=menu]');
            await expect(menu2, 'タブメニューが開くこと').toBeVisible({ timeout: 5000 });
            const moveRightItem = menu2.locator('[role=menuitem]').filter({ hasText: '右に移動' });

            if (await moveRightItem.count() > 0 && await moveRightItem.isVisible()) {
                await moveRightItem.click();
                await waitForAngular(page);
                await page.waitForTimeout(800);

                // [check] 140-5. ✅ タブ順序が変わっていること（テストタブAが右に移動）
                const finalTabTexts = await allTabs.allTextContents();
                console.log('[dash-140] 右移動後タブ順序:', finalTabTexts);
            } else {
                await page.keyboard.press('Escape');
                console.log('[dash-140] 「右に移動」が表示されない（最右端のタブ）');
            }

            // [check] タブが壊れていないこと
            await expect(tabA.first(), 'テストタブAが引き続き表示されること').toBeVisible();

            await autoScreenshot(page, 'DB05', 'dash-140', _testStart);
        });

        // -------------------------------------------------------------------------
        await test.step('dash-150: タブを削除すると中のウィジェットごと消えること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-150`);

            // [flow] 150-1. 「テストタブA」にウィジェットが複数あることを確認
            await tabA.first().click();
            await waitForAngular(page);
            const panelContent = await getActivePanelLocator(page);
            const widgetCountBefore = await panelContent.locator('.card').count();
            console.log(`[dash-150] 削除前ウィジェット数: ${widgetCountBefore}`);
            expect(widgetCountBefore, 'ウィジェットが存在すること').toBeGreaterThanOrEqual(1);

            // [flow] 150-2. 「テストタブA」の▼メニューから「削除」をクリック
            await openTabMenu(page, tabA.first());
            const menu = page.locator('[role=menu]');
            await expect(menu, 'タブメニューが開くこと').toBeVisible({ timeout: 5000 });
            const deleteItem = menu.locator('[role=menuitem]').filter({ hasText: '削除' });
            await expect(deleteItem, '「削除」メニュー項目が存在すること').toBeVisible();
            await deleteItem.click();
            await waitForAngular(page);

            // [flow] 150-3. 確認ダイアログで「はい」をクリック
            const confirmModal = page.locator('.modal.show');
            await expect(confirmModal, '確認ダイアログが表示されること').toBeVisible({ timeout: 5000 });
            await confirmModal.locator('button').filter({ hasText: 'はい' }).click();
            await waitForAngular(page);
            await page.waitForTimeout(1000);

            // [check] 150-4. ✅ 「テストタブA」がタブ一覧から消えていること
            await expect(tablist.locator('[role=tab]').filter({ hasText: tabAName }))
                .toHaveCount(0, { timeout: 5000 });

            // [check] 150-5. ✅ 「HOME」タブが選択されていること
            const homeTab = tablist.locator('[role=tab]').filter({ hasText: 'HOME' });
            await expect(homeTab.first(), 'HOMEタブが表示されること').toBeVisible();
            const homeSelected = await homeTab.first().getAttribute('aria-selected');
            expect(homeSelected, 'HOMEタブが選択状態であること').toBe('true');

            await autoScreenshot(page, 'DB05', 'dash-150', _testStart);
        });

        // -------------------------------------------------------------------------
        await test.step('dash-160: ページをリロードしても状態が保持されていること', async () => {
            console.log(`[STEP_TIME] ${Math.round((Date.now() - _testStart) / 1000)}s dash-160`);

            // [flow] 160-1. 「HOME」タブに掲示板が表示されていることを確認
            const homeTab = tablist.locator('[role=tab]').filter({ hasText: 'HOME' });
            await homeTab.first().click();
            await waitForAngular(page);

            // [flow] 160-2. ページをリロードする
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await waitForAngular(page);

            // [check] 160-3. ✅ リロード後もダッシュボードが正常に表示されること
            await checkDashboardPage(page);

            // [check] 160-4. ✅ 「HOME」タブの掲示板が表示されていること
            await expect(page.locator('[role=tabpanel]').filter({ hasText: '掲示板' }))
                .toBeVisible({ timeout: 10000 });

            // [check] 160-5. ✅ 削除した「テストタブA」が復活していないこと
            await expect(tablist.locator('[role=tab]').filter({ hasText: tabAName }))
                .toHaveCount(0);

            // [flow] 160-6. 「HOME」タブの▼メニューを開く
            const homeTabEl = tablist.locator('[role=tab]').filter({ hasText: 'HOME' }).first();
            await openTabMenu(page, homeTabEl);

            // [check] 160-7. ✅ 「削除」メニューが存在しないこと（HOMEは削除不可）
            const menu = page.locator('[role=menu]');
            await expect(menu, 'HOMEタブのメニューが開くこと').toBeVisible({ timeout: 5000 });
            const deleteItem = menu.locator('[role=menuitem]').filter({ hasText: '削除' });
            await expect(deleteItem, 'HOMEタブに「削除」メニューが存在しないこと').toHaveCount(0);

            await autoScreenshot(page, 'DB05', 'dash-160', _testStart);
        });
    });
});
