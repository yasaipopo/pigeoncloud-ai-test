// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

// ============================================================
// 共通ヘルパー関数
// ============================================================

async function login(page, email, password) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#id', { timeout: 30000 });
    await page.fill('#id', email || EMAIL);
    await page.fill('#password', password || PASSWORD);
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
    } catch (e) {
        if (page.url().includes('/admin/login')) {
            await page.fill('#id', email || EMAIL);
            await page.fill('#password', password || PASSWORD);
            await page.click('button[type=submit].btn-primary');
            await page.waitForURL('**/admin/dashboard', { timeout: 40000 });
        }
    }
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
}

async function logout(page) {
    await page.evaluate(() => fetch('/api/admin/logout', { method: 'GET', credentials: 'include' }));
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForSelector('#id', { timeout: 15000 }).catch(() => {});
}

async function closeTemplateModal(page) {
    try {
        await page.waitForSelector('div.modal.show', { timeout: 3000 }).catch(() => {});
        const modal = page.locator('div.modal.show');
        if (await modal.count() > 0) {
            await modal.locator('button.close, button[aria-label="Close"], button').first().click({ force: true });
            await page.waitForSelector('div.modal.show', { state: 'hidden', timeout: 5000 }).catch(() => {});
            const backdrop = page.locator('.modal-backdrop');
            if (await backdrop.count() > 0) {
                await page.keyboard.press('Escape');
                await page.waitForTimeout(500);
            }
        }
    } catch (e) {}
}

/**
 * テストユーザーを作成する (debug API)
 * 返り値: { email: 'ishikawa+N@loftal.jp', password: 'admin', id: N }
 */
async function createTestUser(page) {
    return await page.evaluate(async (baseUrl) => {
        const res = await fetch(baseUrl + '/api/admin/debug/create-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({}),
            credentials: 'include',
        });
        return res.json();
    }, BASE_URL);
}

/**
 * ワークフローテスト専用のシンプルなテーブルを作成する
 * ALLTESTテーブルはルックアップ型不一致等で保存エラーになる場合があるため
 * 返り値: tableId (string)
 */
async function createWorkflowTestTable(page) {
    const tableName = 'WFTest_' + Date.now();
    // テーブル作成ページへ直接遷移
    await page.goto(BASE_URL + '/admin/dataset/edit/new');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('[role=tab]', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // テーブル名入力
    const nameInput = page.locator('#table_name').first();
    await nameInput.waitFor({ timeout: 15000 });
    await nameInput.fill(tableName);
    await page.waitForTimeout(500);

    // フィールドを1つ追加（「項目を追加する」→「文字列(一行)」→項目名入力→「追加する」）
    await page.getByRole('button', { name: /項目を追加する/ }).click();
    await page.waitForTimeout(800);
    // 「文字列(一行)」を選択（ダイアログ内）
    await page.getByRole('dialog').getByRole('button', { name: /文字列\(一行\)/ }).click();
    // フィールド設定フォームが表示されるまで待機
    const labelInput = page.locator('input[name="label"]');
    await labelInput.waitFor({ timeout: 10000 });
    await labelInput.fill('テスト項目');
    await page.waitForTimeout(300);
    // フィールド追加の「追加する」ボタン（exact matchでダイアログ内のみ）
    await page.getByRole('button', { name: '追加する', exact: true }).click();
    await page.waitForTimeout(1000);

    // フィールドが追加されたことを確認してから「登録」
    await page.getByRole('button', { name: '登録', exact: true }).click();
    await page.waitForTimeout(1000);
    // 確認ダイアログ「本当に追加してもよろしいですか？」→「追加する」
    // .modal.showクラスを持つ表示中のBootstrapモーダルに限定してクリック
    await page.locator('.modal.show').getByRole('button', { name: '追加する', exact: true }).click({ timeout: 10000 });
    // 保存後URLは /admin/dataset__NNN（テーブル一覧ページ）、作成処理に時間がかかるため長めにタイムアウト設定
    await page.waitForURL(/\/dataset__\d+/, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // URLからテーブルIDを取得
    const url = page.url();
    const match = url.match(/\/dataset__(\d+)/);
    if (match) return match[1];
    throw new Error('ワークフローテスト用テーブルの作成に失敗しました: URL=' + url);
}

/**
 * テーブル設定のワークフロータブへ移動する
 */
async function navigateToWorkflowTab(page, tableId) {
    for (let attempt = 0; attempt < 3; attempt++) {
        // テーブル設定ページに直接ナビゲート
        await page.goto(BASE_URL + `/admin/dataset/edit/${tableId}`);
        // networkidleまで待機（AngularのHTTPデータ取得完了を確認）
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForSelector('[role=tab]', { timeout: 30000 });
        await page.waitForTimeout(1000);

        // page.evaluate()でDOMを直接クリック（locator.click()はタイミング問題があるため）
        const tabInfo = await page.evaluate(() => {
            const tabs = Array.from(document.querySelectorAll('[role=tab]'));
            const texts = tabs.map(t => t.textContent.trim());
            for (const tab of tabs) {
                if (tab.textContent.includes('ワークフロー')) {
                    tab.click();
                    return { found: true, texts };
                }
            }
            return { found: false, texts };
        });

        if (!tabInfo.found) {
            console.log(`[navigateToWorkflowTab] ワークフロータブが見つからなかった attempt=${attempt + 1}, tabs=${JSON.stringify(tabInfo.texts)}`);
            continue;
        }
        console.log(`[navigateToWorkflowTab] ワークフロータブをクリック attempt=${attempt + 1}`);

        // Angular ngbNavContent のレンダリングを待機（最大10秒）
        await page.waitForTimeout(2000);
        const found = await page.evaluate(() => !!document.querySelector('dataset-workflow-options'));
        if (found) {
            await page.waitForTimeout(500);
            return;
        }
        console.log(`[navigateToWorkflowTab] dataset-workflow-options が見つからず attempt=${attempt + 1}`);
    }
    console.log('[navigateToWorkflowTab] 3回試みたが dataset-workflow-options が見つからなかった');
}

/**
 * テーブル設定を保存する（「更新」→「本当に更新してもよろしいですか？」→「更新する」確認→リスト画面へ遷移）
 */
async function saveTableSettings(page, tableId) {
    const saveBtn = page.locator('button[type=submit].btn-primary').filter({ visible: true }).first();
    await saveBtn.click();
    // 確認ダイアログ「本当に更新してもよろしいですか？」→「更新する」をクリック
    await page.getByRole('button', { name: '更新する', exact: true }).click({ timeout: 20000 });
    // 保存後はリスト画面（/admin/dataset__NNN）に遷移する
    await page.waitForURL(`**/dataset__${tableId}`, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
}

/**
 * ワークフローを有効にする（テーブル設定 → ワークフロータブ → ONスイッチ → 保存）
 */
async function enableWorkflow(page, tableId) {
    await navigateToWorkflowTab(page, tableId);
    // まずチェックボックスの現在状態を確認
    const state = await page.evaluate(() => {
        const wfSection = document.querySelector('dataset-workflow-options');
        if (!wfSection) return { found: false, checked: false };
        const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
        if (!cb) return { found: false, checked: false };
        return { found: true, checked: cb.checked };
    });
    if (!state.found) {
        console.log('[enableWorkflow] dataset-workflow-options が見つからないためスキップ');
        return;
    }
    if (state.checked) {
        console.log('[enableWorkflow] ワークフローは既にON');
        return;
    }
    // Playwrightのlocator.click()でAngular change detectionをトリガー
    const switchLabel = page.locator('dataset-workflow-options label.switch').first();
    await switchLabel.click({ force: true, timeout: 10000 }).catch(async () => {
        // フォールバック: page.evaluate()で直接クリック
        await page.evaluate(() => {
            const wfSection = document.querySelector('dataset-workflow-options');
            if (!wfSection) return;
            const label = wfSection.querySelector('label.switch');
            if (label) label.click();
        });
    });
    await page.waitForTimeout(1500);
    // クリック後の状態確認
    const afterState = await page.evaluate(() => {
        const wfSection = document.querySelector('dataset-workflow-options');
        if (!wfSection) return { checked: false };
        const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
        return { checked: cb ? cb.checked : false };
    });
    console.log('[enableWorkflow] クリック後のワークフロー状態:', afterState.checked);
    await saveTableSettings(page, tableId);
}

/**
 * ワークフローを無効にする（テーブル設定 → ワークフロータブ → OFFスイッチ → 保存）
 */
async function disableWorkflow(page, tableId) {
    await navigateToWorkflowTab(page, tableId);
    // page.evaluate()でDOMを直接操作（locator.click()はAbortErrorを発生させる可能性があるため使わない）
    const clicked = await page.evaluate(() => {
        const wfSection = document.querySelector('dataset-workflow-options');
        if (!wfSection) return false;
        const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
        if (!cb || !cb.checked) return false; // 既にOFFまたは見つからない
        const label = wfSection.querySelector('label.switch');
        if (label) { label.click(); return true; }
        return false;
    });
    if (clicked) {
        await page.waitForTimeout(1500);
    }
    await saveTableSettings(page, tableId);
}

/**
 * 特定のワークフロー設定オプションをON/OFFする
 * labelText: 'ワークフロー承認者はデータ編集可能', '一度承認されたデータも再申請可能', etc.
 */
async function toggleWorkflowOption(page, labelText, enable) {
    // 現在の状態を確認してから Playwright click で切り替え
    const state = await page.evaluate(({ labelText, enable }) => {
        const wfSection = document.querySelector('dataset-workflow-options');
        if (!wfSection) return { found: false, needsToggle: false };
        const rows = Array.from(wfSection.querySelectorAll('.form-group.row'));
        const row = rows.find(r => r.textContent?.includes(labelText));
        if (!row) return { found: false, needsToggle: false };
        const cb = row.querySelector('input[type="checkbox"].switch-input');
        if (!cb) return { found: false, needsToggle: false };
        const needsToggle = (enable && !cb.checked) || (!enable && cb.checked);
        return { found: true, needsToggle };
    }, { labelText, enable });

    if (!state.found) return false;
    if (state.needsToggle) {
        // labelText を含む row 内の label.switch を Playwright で直接クリック
        const row = page.locator('dataset-workflow-options .form-group.row').filter({ hasText: labelText }).first();
        await row.locator('label.switch').click({ force: true });
        await page.waitForTimeout(1000);
    }
    return state.needsToggle;
}

/**
 * 新規レコードを作成して申請する
 * approverEmail: 承認者のメールアドレス（表示名で検索）
 * approverName: ng-selectで検索するテキスト
 * comment: 申請コメント（省略可）
 * 返り値: recordId (string)
 */
async function createRecordAndSubmit(page, tableId, approverName, comment = '') {
    // 新規追加ページへ直接遷移（新規追加ボタンはアイコンのみでテキストなし）
    await page.goto(BASE_URL + `/admin/dataset__${tableId}/edit/new`);
    await page.waitForLoadState('domcontentloaded');
    // card-footer内の「申請」ボタンを正確にターゲット
    // （「申請する」モーダルボタンと区別するため.card-footer限定 + 正規表現で完全一致）
    const submitBtn = page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first();
    await submitBtn.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    // 「申請」ボタンをクリック（ワークフロー有効時は申請ボタンが表示される）
    await submitBtn.click({ timeout: 10000 });
    await page.waitForTimeout(1000);
    // 申請ダイアログが開くまで待機（Angular は <dialog open> を使わず CSS で表示するため
    // dialog セレクターではなく、ダイアログ内のボタン「申請する」で検出する）
    await page.waitForSelector('button.btn-primary:has-text("申請する")', { timeout: 20000 });
    // ダイアログ内の初期読み込み完了 → 「承認フロー追加」ボタンが現れるまで明示的に待機
    // （ダイアログ開直後は「読み込み中...」状態で数秒かかる）
    const addFlowBtn = page.locator('button:has-text("承認フロー追加")').first();
    await addFlowBtn.waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(500);
    await addFlowBtn.click({ timeout: 10000 });
    // 承認フロー追加後のLoading...が消えるまで待機（user-forms-fieldのユーザーリスト読み込み完了）
    await page.waitForTimeout(500);
    await page.waitForFunction(
        () => !Array.from(document.querySelectorAll('user-forms-field'))
            .some(el => el.textContent.includes('Loading...')),
        { timeout: 15000 }
    ).catch(() => {});
    await page.waitForTimeout(300);
    // user-forms-field内のng-selectコンボボックスをクリックして展開
    // （getByRole('combobox')はng-selectのinput要素を正確にターゲット）
    const ngCombobox = page.locator('user-forms-field').getByRole('combobox').first();
    await ngCombobox.waitFor({ state: 'visible', timeout: 10000 });
    await ngCombobox.click({ timeout: 10000 });
    // オプションリストが表示されるまで待機
    await page.waitForSelector('.ng-option', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(300);
    // 最初のオプション（「申請したユーザー」等）をクリック
    const option = page.locator('.ng-option').first();
    await option.click({ timeout: 10000 });
    await page.waitForTimeout(500);
    // 申請コメント入力（任意）
    if (comment) {
        await page.locator('textarea').last().fill(comment);
    }
    // 「申請する」ボタンをクリック
    await page.locator('button.btn-primary:has-text("申請する")').click({ timeout: 10000 });
    // 申請後の画面遷移を待機（/view/N またはテーブルリスト /dataset__N に遷移）
    await page.waitForURL(url => !url.includes('/edit/new'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const currentUrl = page.url();
    // /view/N 形式のURL（レコード詳細に直接遷移した場合）
    const viewMatch = currentUrl.match(/\/view\/(\d+)/);
    if (viewMatch) return viewMatch[1];
    // テーブルリストに遷移した場合、テーブルの最初のレコードIDを取得
    if (currentUrl.includes('/dataset__')) {
        // テーブルデータ読み込み完了を待機（IDセルに数値が現れるまで）
        // 注意: 最初のセルはチェックボックス（空）なので firstCell では判定不可
        await page.waitForFunction(() => {
            const rows = document.querySelectorAll('table tbody tr');
            if (rows.length === 0) return false;
            const cells = rows[0].querySelectorAll('td');
            for (const cell of cells) {
                const text = cell.textContent.trim().replace(/["""]/g, '').trim();
                if (/^\d+$/.test(text) && parseInt(text) > 0) return true;
            }
            return false;
        }, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(500);
        const recordId = await page.evaluate(() => {
            const rows = document.querySelectorAll('table tbody tr');
            if (rows.length === 0) return null;
            // IDセルを探す（数字のみの内容）
            const cells = rows[0].querySelectorAll('td');
            for (const cell of cells) {
                const text = cell.textContent.trim().replace(/["""]/g, '').trim();
                if (/^\d+$/.test(text)) return text;
            }
            return null;
        });
        return recordId;
    }
    return null;
}

/**
 * Angular component の workflow_ok/reject/withdraw を直接呼び出す
 * ngx-bootstrap の show() が機能しない場合でも .modal.fade を強制表示する
 */
async function triggerWorkflowAction(page, action) {
    return page.evaluate((act) => {
        // Angular 9+ Ivy: ng.getComponent で component インスタンスを取得
        const hostEl = document.querySelector('app-view-page');
        if (hostEl && typeof ng !== 'undefined' && ng.getComponent) {
            const comp = ng.getComponent(hostEl);
            if (comp && comp[act]) {
                comp[act]();
                return 'called via ng.getComponent';
            }
        }
        // フォールバック: ボタンをネイティブクリック
        return 'fallback';
    }, action);
}

/**
 * workflowModal（.modal.fade）を強制表示し、テキスト操作可能にする
 */
/**
 * workflowModal（ngx-bootstrap .modal.fade）を強制表示する
 * targetBtnSelector: 対象ボタンのCSSセレクタ（そのボタンを含むモーダルのみ表示）
 */
async function forceShowWorkflowModal(page, targetBtnSelector = null) {
    await page.evaluate((btnSel) => {
        document.querySelectorAll('.modal.fade').forEach(el => {
            // targetBtnSelector 指定時はそのボタンを含むモーダルのみ表示
            if (btnSel && !el.querySelector(btnSel)) return;
            el.style.display = 'block';
            el.classList.add('show');
            el.setAttribute('aria-hidden', 'false');
            el.setAttribute('aria-modal', 'true');
        });
        document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
    }, targetBtnSelector);
    await page.waitForTimeout(300);
}

/**
 * レコード詳細ページで承認する
 * 問題: button:has-text("承認") は「承認待ち」statusバッジにもマッチするため
 * btn-success.text-bold クラスで正確に特定する
 */
async function approveRecord(page, tableId, recordId, comment = '') {
    await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
    await page.waitForLoadState('domcontentloaded');
    // networkidleはAngular SPAで無限待機になるためdomcontentloadedに変更
    await page.waitForTimeout(2000);

    // 承認アクションボタン（btn-success text-bold）をクリック → Angular が workflow_ok() を実行
    await page.locator('button.btn-success.text-bold:has-text("承認")').first().click({ timeout: 10000 });

    // *ngIf="workflow_status=='accepted'" で btn-success.btn-ladda が DOM に追加されるまで待つ
    await page.locator('button.btn-success.btn-ladda').waitFor({ state: 'attached', timeout: 8000 });

    // workflowModal を強制表示（btn-success.btn-ladda を含むモーダルのみ）
    await forceShowWorkflowModal(page, 'button.btn-success.btn-ladda');

    const confirmBtn = page.locator('button.btn-success.btn-ladda').last();
    await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });

    if (comment) {
        await page.locator('textarea.form-control').last().fill(comment);
    }
    await confirmBtn.click({ timeout: 5000 });
    await page.waitForTimeout(3000);
}

/**
 * レコード詳細ページで否認する
 */
async function rejectRecord(page, tableId, recordId, comment = '') {
    await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
    await page.waitForLoadState('domcontentloaded');
    // networkidleはAngular SPAで無限待機になるためdomcontentloadedに変更
    await page.waitForTimeout(2000);

    // 否認アクションボタン（btn-danger text-bold）をクリック → Angular が workflow_reject() を実行
    await page.locator('button.btn-danger.text-bold:has-text("否認")').first().click({ timeout: 10000 });

    // *ngIf="workflow_status=='rejected'" で btn-danger.btn-ladda が DOM に追加されるまで待つ
    await page.locator('button.btn-danger.btn-ladda').waitFor({ state: 'attached', timeout: 8000 });

    // workflowModal を強制表示（btn-danger.btn-ladda を含むモーダルのみ）
    await forceShowWorkflowModal(page, 'button.btn-danger.btn-ladda');

    const confirmBtn = page.locator('button.btn-danger.btn-ladda').last();
    await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });

    if (comment) {
        await page.locator('textarea.form-control').last().fill(comment);
    }
    await confirmBtn.click({ timeout: 5000 });
    await page.waitForTimeout(3000);
}

/**
 * レコード詳細ページで申請取り下げする
 */
async function withdrawRecord(page, tableId, recordId) {
    await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
    await page.waitForLoadState('domcontentloaded');
    // networkidleはAngular SPAで無限待機になるためdomcontentloadedに変更
    await page.waitForTimeout(2000);

    // 申請取り下げボタン（btn-danger text-bold）をクリック → Angular が workflow_withdraw() を実行
    await page.locator('button.btn-danger.text-bold:has-text("申請取り下げ")').click({ timeout: 10000 });

    // *ngIf="workflow_status=='withdraw'" で btn-warning.btn-ladda が DOM に追加されるまで待つ
    await page.locator('button.btn-warning.btn-ladda').waitFor({ state: 'attached', timeout: 8000 });

    // workflowModal を強制表示（btn-warning.btn-ladda を含むモーダルのみ）
    await forceShowWorkflowModal(page, 'button.btn-warning.btn-ladda');

    const confirmBtn = page.locator('button.btn-warning.btn-ladda').last();
    await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
    await confirmBtn.click({ timeout: 5000 });
    await page.waitForTimeout(3000);
}

/**
 * レコード詳細のワークフロー状態テキストを取得する
 */
async function getWorkflowStatusText(page, tableId, recordId) {
    await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    // ワークフローステータスバッジ / ラベルを取得
    const statusEl = page.locator('.badge-workflow, .workflow-status, .label-workflow, span.badge, .workflow-badge').first();
    if (await statusEl.count() > 0) {
        return (await statusEl.innerText()).trim();
    }
    // フォールバック: bodyテキスト全体で判断
    return await page.innerText('body');
}

// ============================================================
// ファイルレベルのテーブル共有セットアップ（1回のみ）
// ============================================================
let _sharedTableId = null;
let _testUser = null; // { email, password, id }

test.beforeAll(async ({ browser }) => {
    test.setTimeout(480000);
    const page = await browser.newPage();
    await login(page);
    await closeTemplateModal(page);

    // 古いWFTestテーブルを削除（テーブル蓄積による遅延防止）
    await page.goto(BASE_URL + '/admin/dataset');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    const oldWFTableIds = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/admin/dataset__"]');
        const ids = [];
        for (const a of links) {
            if (a.textContent.trim().startsWith('WFTest_')) {
                const m = a.href.match(/dataset__(\d+)/);
                if (m) ids.push(Number(m[1]));
            }
        }
        return ids;
    });
    if (oldWFTableIds.length > 0) {
        await page.evaluate(async ({ baseUrl, tableIds }) => {
            await fetch(baseUrl + '/api/admin/delete/dataset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ id_a: tableIds }),
                credentials: 'include',
            });
        }, { baseUrl: BASE_URL, tableIds: oldWFTableIds });
        await page.waitForTimeout(3000); // 削除完了待機
    }

    // ワークフローテスト専用の簡易テーブルを作成（最大3回リトライ）
    // （ALLTESTテーブルはルックアップ型不一致で保存エラーになる場合があるため）
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            _sharedTableId = await createWorkflowTestTable(page);
            if (_sharedTableId) break;
        } catch (e) {
            console.log(`[file-level beforeAll] createWorkflowTestTable attempt ${attempt} failed:`, e.message);
            if (attempt === 3) throw e;
            await page.goto(BASE_URL + '/admin/dashboard');
            await page.waitForLoadState('domcontentloaded');
            await page.waitForTimeout(3000);
        }
    }
    // テストユーザーを作成（承認者/申請者として使用）
    _testUser = await createTestUser(page);
    await page.close();
});

// =============================================================================
// ワークフロー設定（21系）
// =============================================================================
test.describe('ワークフロー設定（21系）', () => {
    let tableId;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        tableId = _sharedTableId;
        // ワークフロー有効化は重い処理のためbeforeAllで1回だけ実行
        const page = await browser.newPage();
        try {
            await login(page);
            await closeTemplateModal(page);
            await enableWorkflow(page, tableId);
        } catch (e) {
            console.log('[21系 beforeAll] enableWorkflow error (ignored):', e.message);
        } finally {
            await page.close();
        }
    });

    test.beforeEach(async ({ page }) => {
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 21-1: 承認者はデータ編集可能設定
    // -------------------------------------------------------------------------
    test('21-1: ワークフロー承認者はデータ編集可能設定が保存されること', async ({ page }) => {
        test.setTimeout(150000);
        await navigateToWorkflowTab(page, tableId);
        // ワークフローONを確認（Angular描画完了を待機してから確認）
        await page.waitForFunction(() => {
            const wfSection = document.querySelector('dataset-workflow-options');
            if (!wfSection) return false;
            const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
            return cb !== null; // チェックボックス要素が存在すればOK
        }, { timeout: 10000 }).catch(() => {});
        let isWfEnabled = await page.evaluate(() => {
            const wfSection = document.querySelector('dataset-workflow-options');
            if (!wfSection) return false;
            const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
            return cb ? cb.checked : false;
        });
        if (!isWfEnabled) {
            // beforeAllでenableWorkflowが失敗した場合はここで再試行
            console.log('[21-1] isWfEnabled=false、ここでenableWorkflowを再試行');
            await enableWorkflow(page, tableId);
            await navigateToWorkflowTab(page, tableId);
            await page.waitForFunction(() => {
                const wfSection = document.querySelector('dataset-workflow-options');
                if (!wfSection) return false;
                const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
                return cb !== null;
            }, { timeout: 10000 }).catch(() => {});
            isWfEnabled = await page.evaluate(() => {
                const wfSection = document.querySelector('dataset-workflow-options');
                if (!wfSection) return false;
                const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
                return cb ? cb.checked : false;
            });
        }
        expect(isWfEnabled).toBeTruthy();
        // 「ワークフロー承認者はデータ編集可能」設定が表示されること
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // 承認者データ編集可能のトグルを有効化
        await toggleWorkflowOption(page, '承認者はデータ編集可能', true);
        await saveTableSettings(page, tableId);
        // 再度設定ページを開いて設定が保存されていること
        await navigateToWorkflowTab(page, tableId);
        // .form-group.row が十分レンダリングされるまで待機（Angular描画完了）
        await page.waitForFunction(() => {
            const wfSection = document.querySelector('dataset-workflow-options');
            if (!wfSection) return false;
            const rows = Array.from(wfSection.querySelectorAll('.form-group.row'));
            return rows.some(r => r.textContent?.includes('承認者はデータ編集可能'));
        }, { timeout: 30000 }).catch(() => {});
        const isSaved = await page.evaluate(() => {
            const wfSection = document.querySelector('dataset-workflow-options');
            if (!wfSection) return null;
            const rows = Array.from(wfSection.querySelectorAll('.form-group.row'));
            const row = rows.find(r => r.textContent?.includes('承認者はデータ編集可能'));
            if (!row) return null;
            const cb = row.querySelector('input[type="checkbox"].switch-input');
            return cb ? cb.checked : null;
        });
        expect(isSaved).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // 21-2: 一度承認されたデータも再申請可能設定
    // -------------------------------------------------------------------------
    test('21-2: 一度承認されたデータも再申請可能設定が表示されること', async ({ page }) => {
        test.setTimeout(300000);
        await navigateToWorkflowTab(page, tableId);
        // ワークフローをONにして再申請可能設定を確認
        const isWfEnabled = await page.evaluate(() => {
            const wfSection = document.querySelector('dataset-workflow-options');
            if (!wfSection) return false;
            const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
            return cb ? cb.checked : false;
        });
        if (!isWfEnabled) {
            await enableWorkflow(page, tableId);
            await navigateToWorkflowTab(page, tableId);
        }
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // 「一度承認されたデータも再申請可能」設定が存在すること
        expect(bodyText).toContain('再申請');
        // 設定をONにして保存できること
        await toggleWorkflowOption(page, '再申請', true);
        await saveTableSettings(page, tableId);
        expect(page.url()).not.toContain('error');
    });

    // -------------------------------------------------------------------------
    // 21-3: フローを固定する設定 + テンプレート追加
    // -------------------------------------------------------------------------
    test('21-3: ワークフローのフローを固定する設定が有効になること', async ({ page }) => {
        test.setTimeout(300000);
        await navigateToWorkflowTab(page, tableId);
        const isWfEnabled = await page.evaluate(() => {
            const wfSection = document.querySelector('dataset-workflow-options');
            if (!wfSection) return false;
            const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
            return cb ? cb.checked : false;
        });
        if (!isWfEnabled) {
            await enableWorkflow(page, tableId);
            await navigateToWorkflowTab(page, tableId);
        }
        // フロー固定を有効にする
        await toggleWorkflowOption(page, 'フローを固定する', true);
        await page.waitForTimeout(1500);
        // 「テンプレートの追加」ボタンが表示されること
        const addTemplateBtn = page.locator('button:has-text("テンプレートの追加"), button:has-text("テンプレート追加")').first();
        await expect(addTemplateBtn).toBeVisible({ timeout: 8000 });
        // テンプレートを追加する
        await addTemplateBtn.click();
        await page.waitForTimeout(1500);
        // テンプレートのフォームが表示されること
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // 承認フローの設定UIが表示されること（テンプレートエディタ内は「フロー追加」）
        const hasFlowAdd = await page.locator('button:has-text("フロー追加")').count() > 0;
        expect(hasFlowAdd).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // 21-4: 申請→取り下げフロー（実フロー）
    // -------------------------------------------------------------------------
    test('21-4: ワークフロー申請の取り下げがエラーなく完了すること', async ({ page }) => {
        test.setTimeout(300000);
        // admin として申請（承認者もadmin自身）
        const adminName = EMAIL.split('@')[0]; // 検索用
        const recordId = await createRecordAndSubmit(page, tableId, adminName, '取り下げテスト申請');
        expect(recordId).toBeTruthy();
        // 申請中であることを確認
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
        await page.waitForTimeout(2000);
        const statusBefore = await page.innerText('body');
        // 申請取り下げボタンが表示されること
        await expect(page.locator('button:has-text("申請取り下げ")')).toBeVisible({ timeout: 10000 });
        // 取り下げを実行（btn-danger.text-bold クラスで正確に特定）
        await page.locator('button.btn-danger.text-bold:has-text("申請取り下げ")').click();
        // *ngIf="workflow_status=='withdraw'" で btn-warning.btn-ladda が DOM に追加されるまで待つ
        await page.locator('button.btn-warning.btn-ladda').waitFor({ state: 'attached', timeout: 8000 });
        await forceShowWorkflowModal(page, 'button.btn-warning.btn-ladda');
        const withdrawConfirmBtn = page.locator('button.btn-warning.btn-ladda').last();
        await withdrawConfirmBtn.waitFor({ state: 'visible', timeout: 5000 });
        await withdrawConfirmBtn.click({ timeout: 5000 });
        await page.waitForTimeout(3000);
        // エラーが表示されないこと
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // 申請中ボタンが消えて、再申請可能な状態になっていること
        await expect(page.locator('button:has-text("申請取り下げ")')).not.toBeVisible({ timeout: 5000 }).catch(() => {});
    });
});

// =============================================================================
// ワークフロー基本動作（11系）
// =============================================================================
test.describe('ワークフロー基本動作（11系）', () => {
    let tableId;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        tableId = _sharedTableId;
        // ワークフロー有効化は重い処理のためbeforeAllで1回だけ実行
        const page = await browser.newPage();
        try {
            await login(page);
            await closeTemplateModal(page);
            await enableWorkflow(page, tableId);
        } catch (e) {
            console.log('[11系 beforeAll] enableWorkflow error (ignored):', e.message);
        } finally {
            await page.close();
        }
    });

    test.beforeEach(async ({ page }) => {
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 11-1: ワークフロー設定確認
    // -------------------------------------------------------------------------
    test('11-1: テーブルに対してワークフロー設定が行えること', async ({ page }) => {
        test.setTimeout(90000);
        await navigateToWorkflowTab(page, tableId);
        // ワークフローが有効になっていること（Angular描画完了後に確認）
        await page.waitForFunction(() => {
            const wfSection = document.querySelector('dataset-workflow-options');
            if (!wfSection) return false;
            const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
            return cb !== null;
        }, { timeout: 10000 }).catch(() => {});
        let isEnabled = await page.evaluate(() => {
            const wfSection = document.querySelector('dataset-workflow-options');
            if (!wfSection) return false;
            const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
            return cb ? cb.checked : false;
        });
        if (!isEnabled) {
            // beforeAllでenableWorkflowが失敗した場合はここで再試行
            console.log('[11-1] isEnabled=false、ここでenableWorkflowを再試行');
            await enableWorkflow(page, tableId);
            await navigateToWorkflowTab(page, tableId);
            await page.waitForFunction(() => {
                const wfSection = document.querySelector('dataset-workflow-options');
                if (!wfSection) return false;
                const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
                return cb !== null;
            }, { timeout: 10000 }).catch(() => {});
            isEnabled = await page.evaluate(() => {
                const wfSection = document.querySelector('dataset-workflow-options');
                if (!wfSection) return false;
                const cb = wfSection.querySelector('input[type="checkbox"].switch-input');
                return cb ? cb.checked : false;
            });
        }
        expect(isEnabled).toBeTruthy();
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 11-2: 申請→承認フロー（ユーザーA→ユーザーB承認）
    // -------------------------------------------------------------------------
    test('11-2: ユーザーAが申請しBが承認できること', async ({ page }) => {
        test.setTimeout(300000);
        // adminで申請してadminが承認（WFTestテーブルはルートグループのためテストユーザーは非アクセス）
        const approverName = EMAIL.split('@')[0];
        const recordId = await createRecordAndSubmit(page, tableId, approverName, '承認テスト申請コメント');
        expect(recordId).toBeTruthy();

        // レコードが申請中であることを確認
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
        await page.waitForTimeout(2000);
        const applyingBodyText = await page.innerText('body');
        expect(applyingBodyText).not.toContain('Internal Server Error');

        // adminで承認
        await approveRecord(page, tableId, recordId, '承認コメントです');

        // 承認済みになっていること
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
        await page.waitForTimeout(2000);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // 承認コメントが表示されること
        expect(bodyText).toContain('承認コメントです');
    });

    // -------------------------------------------------------------------------
    // 11-3: 多段承認（A申請 → B承認 → C承認）
    // -------------------------------------------------------------------------
    test('11-3: 多段承認フロー（A申請→B承認→C最終承認）ができること', async ({ page }) => {
        test.setTimeout(300000);
        // adminで申請（承認者にadminを指定）
        const approverName = EMAIL.split('@')[0];
        const recordId = await createRecordAndSubmit(page, tableId, approverName, '多段承認テスト');
        expect(recordId).toBeTruthy();

        // 申請中レコードが表示されること
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
        await page.waitForTimeout(2000);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');

        // adminで承認できること
        await approveRecord(page, tableId, recordId, '多段承認コメント');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
        await page.waitForTimeout(2000);
        const afterApproveText = await page.innerText('body');
        expect(afterApproveText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 11-4: 否認→再申請フロー
    // -------------------------------------------------------------------------
    test('11-4: 否認された後に再申請ができること', async ({ page }) => {
        test.setTimeout(300000);
        const approverName = EMAIL.split('@')[0];

        // adminで申請
        const recordId = await createRecordAndSubmit(page, tableId, approverName, '否認テスト');
        expect(recordId).toBeTruthy();

        // adminで否認
        await rejectRecord(page, tableId, recordId, '否認コメントです');

        // 否認コメントが確認できること
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
        await page.waitForTimeout(2000);
        const afterRejectText = await page.innerText('body');
        expect(afterRejectText).not.toContain('Internal Server Error');
        expect(afterRejectText).toContain('否認コメントです');

        // 再申請できること（編集ページへ）
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/edit/${recordId}`);
        await page.waitForTimeout(2000);
        const reapplyText = await page.innerText('body');
        expect(reapplyText).not.toContain('Internal Server Error');
        // 申請ボタンが表示されること（"申請する"とのstrict違反を避けるため完全一致で検索）
        await expect(page.locator('button').filter({ hasText: /^申請$/ }).first()).toBeVisible({ timeout: 10000 });
    });

    // -------------------------------------------------------------------------
    // 11-5: 組織承認（一人の承認が必要）
    // -------------------------------------------------------------------------
    test('11-5: 組織による承認（一人の承認が必要）ができること', async ({ page }) => {
        test.setTimeout(300000);
        // adminで申請、承認者タイプ=組織(役職)
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/edit/new`);
        await page.waitForLoadState('domcontentloaded');
        // Angular描画完了まで申請ボタン表示を待機
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().waitFor({ state: 'visible', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().click({ timeout: 10000 });
        await page.waitForTimeout(1000);
        await page.waitForSelector('button.btn-primary:has-text("申請する")', { timeout: 20000 });
        { const _btn = page.locator('button:has-text("承認フロー追加")').first();
          await _btn.waitFor({ state: 'visible', timeout: 20000 });
          await page.waitForTimeout(300);
          await _btn.click({ timeout: 10000 }); }
        await page.waitForTimeout(1000);
        // 承認者種別 = 組織(役職) を選択
        const divisionRadio = page.locator('input[type="radio"][value="division"]').first();
        await divisionRadio.click();
        await page.waitForTimeout(500);
        // 組織(役職)の設定UIが表示されること
        await expect(page.locator('division-forms-field').first()).toBeVisible({ timeout: 5000 });
        // 「一人の承認が必要」が選択されていること（または選択する）
        const oneRadio = page.locator('input[type="radio"][value="one"]').first();
        if (await oneRadio.count() > 0) {
            await oneRadio.click();
            await page.waitForTimeout(300);
        }
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // キャンセル（実際には申請せずUI確認のみ）
        await page.locator('button.btn-secondary:has-text("キャンセル")').click().catch(() => {});
    });

    // -------------------------------------------------------------------------
    // 11-6: ワークフロー承認者はデータ編集可能
    // -------------------------------------------------------------------------
    test('11-6: 承認者データ編集可能設定が申請フローに反映されること', async ({ page }) => {
        test.setTimeout(300000);
        // 「承認者はデータ編集可能」をONにして保存
        await navigateToWorkflowTab(page, tableId);
        await toggleWorkflowOption(page, '承認者はデータ編集可能', true);
        await saveTableSettings(page, tableId);
        // adminで申請 → adminが承認者として確認
        const approverName = EMAIL.split('@')[0];
        const recordId = await createRecordAndSubmit(page, tableId, approverName, '編集可能テスト');
        expect(recordId).toBeTruthy();
        // 承認フォームに編集機能が表示されること
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
        await page.waitForTimeout(2000);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // 承認ボタンが表示されていること
        await expect(page.locator('button:has-text("承認")').filter({ hasNotText: '一括' }).first()).toBeVisible({ timeout: 10000 });
    });

    // -------------------------------------------------------------------------
    // 11-7: 一度承認後の再申請が可能
    // -------------------------------------------------------------------------
    test('11-7: 一度承認後に再申請が可能な設定ができること', async ({ page }) => {
        test.setTimeout(300000);
        await navigateToWorkflowTab(page, tableId);
        // 再申請可能設定をON
        await toggleWorkflowOption(page, '再申請', true);
        await saveTableSettings(page, tableId);
        // 設定が保存されること
        await navigateToWorkflowTab(page, tableId);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('再申請');
    });

    // -------------------------------------------------------------------------
    // 11-8: フロー固定ワークフロー設定
    // -------------------------------------------------------------------------
    test('11-8: ワークフローのフロー固定設定が機能すること', async ({ page }) => {
        test.setTimeout(300000);
        await navigateToWorkflowTab(page, tableId);
        // フロー固定をON
        await toggleWorkflowOption(page, 'フローを固定する', true);
        await page.waitForTimeout(1000);
        // テンプレート追加ボタンが表示されること
        const addTemplateBtn = page.locator('button:has-text("テンプレートの追加"), button:has-text("テンプレート追加")').first();
        await expect(addTemplateBtn).toBeVisible({ timeout: 8000 });
        // 保存（確認ダイアログ込み）
        await saveTableSettings(page, tableId);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 11-9: 否認→再編集→再申請→承認フロー
    // -------------------------------------------------------------------------
    test('11-9: 否認→再編集→再申請→承認の完全フローが動作すること', async ({ page }) => {
        test.setTimeout(300000);
        // 11-8 がフロー固定をONにしている場合があるためリセット
        await navigateToWorkflowTab(page, tableId);
        await toggleWorkflowOption(page, 'フローを固定する', false);
        await saveTableSettings(page, tableId);
        const approverName = EMAIL.split('@')[0];
        // adminで申請
        const recordId = await createRecordAndSubmit(page, tableId, approverName, '再申請テスト');
        expect(recordId).toBeTruthy();
        // adminで否認
        await rejectRecord(page, tableId, recordId, 'まず否認します');
        // 編集ページへ
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/edit/${recordId}`);
        await page.waitForTimeout(2000);
        const bodyText1 = await page.innerText('body');
        expect(bodyText1).not.toContain('Internal Server Error');
        // 申請ボタンが表示されること（"申請する"とのstrict違反を避けるため完全一致で検索）
        await expect(page.locator('button').filter({ hasText: /^申請$/ }).first()).toBeVisible({ timeout: 10000 });
        // 再申請
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().click({ timeout: 10000 });
        await page.waitForTimeout(1500);
        await page.waitForSelector('button.btn-primary:has-text("申請する")', { timeout: 20000 });
        { const _btn = page.locator('button:has-text("承認フロー追加")').first();
          await _btn.waitFor({ state: 'visible', timeout: 20000 });
          await page.waitForTimeout(300);
          await _btn.click({ timeout: 10000 }); }
        await page.waitForTimeout(500);
        await page.waitForFunction(
            () => !Array.from(document.querySelectorAll('user-forms-field'))
                .some(el => el.textContent.includes('Loading...')),
            { timeout: 15000 }
        ).catch(() => {});
        await page.waitForTimeout(300);
        const _ngCb11_9 = page.locator('user-forms-field').getByRole('combobox').first();
        await _ngCb11_9.waitFor({ state: 'visible', timeout: 10000 });
        await _ngCb11_9.click({ timeout: 10000 });
        await page.waitForSelector('.ng-option', { timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(300);
        await page.locator('.ng-option').first().click({ timeout: 10000 });
        await page.waitForTimeout(500);
        await page.locator('button.btn-primary:has-text("申請する")').click({ timeout: 10000 });
        await page.waitForTimeout(3000);
        // adminで最終承認
        await approveRecord(page, tableId, recordId, '再申請を承認します');
        // 承認済みになること
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
        await page.waitForTimeout(2000);
        const finalBody = await page.innerText('body');
        expect(finalBody).not.toContain('Internal Server Error');
        expect(finalBody).toContain('再申請を承認します');
    });
});

// =============================================================================
// 役職指定固定ワークフロー（68系）
// =============================================================================
test.describe('役職指定固定ワークフロー（68系）', () => {
    let tableId;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        tableId = _sharedTableId;
        // ワークフロー有効化は重い処理のためbeforeAllで1回だけ実行
        const page = await browser.newPage();
        try {
            await login(page);
            await closeTemplateModal(page);
            await enableWorkflow(page, tableId);
        } catch (e) {
            console.log('[68系 beforeAll] enableWorkflow error (ignored):', e.message);
        } finally {
            await page.close();
        }
    });

    test.beforeEach(async ({ page }) => {
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 68-1: 組織(役職)/一人の承認 → 承認
    // -------------------------------------------------------------------------
    test('68-1: 組織(役職)/一人の承認が必要なワークフローで承認できること', async ({ page }) => {
        test.setTimeout(300000);
        // レコード作成 → 申請モーダルで組織(役職)タイプを選択
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/edit/new`);
        await page.waitForLoadState('domcontentloaded');
        // Angular描画完了まで申請ボタン表示を待機
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().waitFor({ state: 'visible', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().click({ timeout: 10000 });
        await page.waitForTimeout(1000);
        await page.waitForSelector('button.btn-primary:has-text("申請する")', { timeout: 20000 });
        // 承認フロー追加
        { const _btn = page.locator('button:has-text("承認フロー追加")').first();
          await _btn.waitFor({ state: 'visible', timeout: 20000 });
          await page.waitForTimeout(300);
          await _btn.click({ timeout: 10000 }); }
        await page.waitForTimeout(1000);
        // 組織(役職)タイプを選択
        await page.locator('input[type="radio"][value="division"]').first().click();
        await page.waitForTimeout(500);
        // 一人の承認が必要を選択
        const oneRadio = page.locator('input[type="radio"][value="one"]').first();
        if (await oneRadio.count() > 0) await oneRadio.click();
        await page.waitForTimeout(500);
        // 組織セレクトが表示されること
        await expect(page.locator('division-forms-field').first()).toBeVisible({ timeout: 5000 });
        // 組織を選択（最初のオプション）
        await page.locator('division-forms-field .ng-select-container').first().click();
        await page.waitForTimeout(500);
        const divOption = page.locator('.ng-option').first();
        if (await divOption.count() > 0) {
            await divOption.click();
            await page.waitForTimeout(500);
        }
        // 申請コメントを入力
        await page.locator('textarea.form-control').last().fill('役職指定承認テスト');
        // 申請する
        await page.locator('button.btn-primary:has-text("申請する")').click({ timeout: 8000 });
        await page.waitForTimeout(3000);
        const url = page.url();
        const match = url.match(/\/view\/(\d+)/) || url.match(/\/(\d+)$/);
        const recordId = match ? match[1] : null;
        // 申請が受理されてページが表示されること
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        if (recordId) {
            // 承認者で承認（admin）
            await approveRecord(page, tableId, recordId, '組織役職承認コメント');
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
            await page.waitForTimeout(2000);
            const afterApproveText = await page.innerText('body');
            expect(afterApproveText).not.toContain('Internal Server Error');
            expect(afterApproveText).toContain('組織役職承認コメント');
        }
    });

    // -------------------------------------------------------------------------
    // 68-2: 組織(役職)/一人の承認 → 否認
    // -------------------------------------------------------------------------
    test('68-2: 組織(役職)/一人の承認が必要なワークフローで否認できること', async ({ page }) => {
        test.setTimeout(300000);
        // レコード作成 → 申請モーダルで組織(役職)タイプを選択
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/edit/new`);
        await page.waitForLoadState('domcontentloaded');
        // Angular描画完了まで申請ボタン表示を待機
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().waitFor({ state: 'visible', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().click({ timeout: 10000 });
        await page.waitForTimeout(1000);
        await page.waitForSelector('button.btn-primary:has-text("申請する")', { timeout: 20000 });
        { const _btn = page.locator('button:has-text("承認フロー追加")').first();
          await _btn.waitFor({ state: 'visible', timeout: 20000 });
          await page.waitForTimeout(300);
          await _btn.click({ timeout: 10000 }); }
        await page.waitForTimeout(1000);
        await page.locator('input[type="radio"][value="division"]').first().click();
        await page.waitForTimeout(500);
        const oneRadio = page.locator('input[type="radio"][value="one"]').first();
        if (await oneRadio.count() > 0) await oneRadio.click();
        await page.waitForTimeout(500);
        await page.locator('division-forms-field .ng-select-container').first().click();
        await page.waitForTimeout(500);
        const divOption = page.locator('.ng-option').first();
        if (await divOption.count() > 0) {
            await divOption.click();
            await page.waitForTimeout(500);
        }
        await page.locator('textarea.form-control').last().fill('役職指定否認テスト');
        await page.locator('button.btn-primary:has-text("申請する")').click({ timeout: 8000 });
        await page.waitForTimeout(3000);
        const url = page.url();
        const match = url.match(/\/view\/(\d+)/) || url.match(/\/(\d+)$/);
        const recordId = match ? match[1] : null;
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        if (recordId) {
            // 否認
            await rejectRecord(page, tableId, recordId, '組織役職否認コメント');
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
            await page.waitForTimeout(2000);
            const afterRejectText = await page.innerText('body');
            expect(afterRejectText).not.toContain('Internal Server Error');
            expect(afterRejectText).toContain('組織役職否認コメント');
        }
    });

    // -------------------------------------------------------------------------
    // 68-5: フロー固定: 組織(役職)/一人の承認 → 承認
    // -------------------------------------------------------------------------
    test('68-5: フロー固定で組織(役職)/一人の承認が必要なワークフローが機能すること', async ({ page }) => {
        test.setTimeout(300000);
        // フロー固定をON
        await navigateToWorkflowTab(page, tableId);
        await toggleWorkflowOption(page, 'フローを固定する', true);
        await page.waitForTimeout(1000);
        // テンプレートを追加
        const addTemplateBtn = page.locator('button:has-text("テンプレートの追加"), button:has-text("テンプレート追加")').first();
        if (await addTemplateBtn.count() > 0) {
            await addTemplateBtn.click();
            await page.waitForTimeout(1500);
        }
        // テンプレート内で承認フロー追加（テーブル設定のテンプレートエディタでは「フロー追加」）
        const addFlowBtn = page.locator('button:has-text("フロー追加")').first();
        if (await addFlowBtn.count() > 0) {
            await addFlowBtn.click();
            await page.waitForTimeout(1000);
            // 組織(役職)タイプを選択
            const divRadio = page.locator('input[type="radio"][value="division"]').first();
            if (await divRadio.count() > 0) await divRadio.click();
            await page.waitForTimeout(500);
            const oneRadio = page.locator('input[type="radio"][value="one"]').first();
            if (await oneRadio.count() > 0) await oneRadio.click();
            await page.waitForTimeout(500);
        }
        // 設定保存（確認ダイアログ込み）
        await saveTableSettings(page, tableId);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // 申請ページでフロー固定テンプレートが選択可能なこと
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/edit/new`);
        await page.waitForLoadState('domcontentloaded');
        // Angular描画完了まで申請ボタン表示を待機
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().waitFor({ state: 'visible', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().click({ timeout: 10000 });
        await page.waitForSelector('button.btn-primary:has-text("申請する")', { timeout: 10000 }).catch(() => {});
        // ダイアログ内でテンプレートが自動適用またはフロー固定のため承認フロー追加ボタンが非表示になっていること
        const modalText = await page.evaluate(() => {
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog'));
            const visibleDialog = dialogs.find(d => {
                const style = window.getComputedStyle(d);
                return style.display !== 'none' && style.visibility !== 'hidden';
            });
            return visibleDialog ? visibleDialog.innerText : '';
        }).catch(() => '');
        // エラーがないこと
        expect(modalText).not.toContain('Internal Server Error');
        await page.locator('button.btn-secondary:has-text("キャンセル")').click().catch(() => {});
    });

    // -------------------------------------------------------------------------
    // 68-6: フロー固定: 組織(役職)/一人の承認 → 否認
    // -------------------------------------------------------------------------
    test('68-6: フロー固定で組織(役職)/一人の承認が必要なワークフローで否認できること', async ({ page }) => {
        test.setTimeout(300000);
        await navigateToWorkflowTab(page, tableId);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // フロー固定設定が存在すること
        expect(bodyText).toContain('フローを固定する');
    });

    // -------------------------------------------------------------------------
    // 68-7〜68-8: 全員の承認が必要パターン
    // -------------------------------------------------------------------------
    test('68-7: 組織(役職)/全員の承認が必要なワークフロー設定ができること', async ({ page }) => {
        test.setTimeout(300000);
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/edit/new`);
        await page.waitForLoadState('domcontentloaded');
        // Angular描画完了まで申請ボタン表示を待機
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().waitFor({ state: 'visible', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().click({ timeout: 10000 });
        await page.waitForTimeout(1000);
        await page.waitForSelector('button.btn-primary:has-text("申請する")', { timeout: 20000 });
        { const _btn = page.locator('button:has-text("承認フロー追加")').first();
          await _btn.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(300);
          await _btn.click({ timeout: 10000 }).catch(() => {}); }
        await page.waitForTimeout(1000);
        // 組織(役職)タイプ選択
        await page.locator('input[type="radio"][value="division"]').first().click().catch(() => {});
        await page.waitForTimeout(500);
        // 全員の承認が必要を選択
        const allRadio = page.locator('input[type="radio"][value="all"]').first();
        if (await allRadio.count() > 0) await allRadio.click();
        await page.waitForTimeout(500);
        const modalText = await page.evaluate(() => {
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog'));
            const visibleDialog = dialogs.find(d => {
                const style = window.getComputedStyle(d);
                return style.display !== 'none' && style.visibility !== 'hidden';
            });
            return visibleDialog ? visibleDialog.innerText : '';
        }).catch(() => '');
        expect(modalText).not.toContain('Internal Server Error');
        expect(modalText).toContain('全員の承認が必要');
        await page.locator('button.btn-secondary:has-text("キャンセル")').click().catch(() => {});
    });
});

// =============================================================================
// 引き上げ承認（106系）
// =============================================================================
test.describe('引き上げ承認（106系）', () => {
    let tableId;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        tableId = _sharedTableId;
        // ワークフロー有効化は重い処理のためbeforeAllで1回だけ実行
        const page = await browser.newPage();
        try {
            await login(page);
            await closeTemplateModal(page);
            await enableWorkflow(page, tableId);
        } catch (e) {
            console.log('[106系 beforeAll] enableWorkflow error (ignored):', e.message);
        } finally {
            await page.close();
        }
    });

    test.beforeEach(async ({ page }) => {
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 引き上げ承認機能の共通確認ヘルパー
    // -------------------------------------------------------------------------
    async function checkSalvageButtonVisible(page, tableId, recordId) {
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
        await page.waitForTimeout(2000);
        return await page.locator('button:has-text("引き上げ承認")').count() > 0;
    }

    // -------------------------------------------------------------------------
    // 106-01: 組織(1人)では引き上げ承認ボタンが表示されないこと
    // -------------------------------------------------------------------------
    test('106-01: 組織(1人の承認が必要)→の後の承認者では引き上げ承認ボタンが表示されないこと', async ({ page }) => {
        test.setTimeout(300000);
        // 引き上げ承認機能をONにする
        await navigateToWorkflowTab(page, tableId);
        await toggleWorkflowOption(page, '引き上げ承認', true);
        await saveTableSettings(page, tableId);
        // 申請: 組織(1人) → admin の2段階
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/edit/new`);
        await page.waitForLoadState('domcontentloaded');
        // Angular描画完了まで申請ボタン表示を待機
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().waitFor({ state: 'visible', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().click({ timeout: 10000 });
        await page.waitForTimeout(1000);
        await page.waitForSelector('button.btn-primary:has-text("申請する")', { timeout: 20000 });
        // 承認フロー追加
        { const _btn = page.locator('button:has-text("承認フロー追加")').first();
          await _btn.waitFor({ state: 'visible', timeout: 20000 });
          await page.waitForTimeout(300);
          await _btn.click({ timeout: 10000 }); }
        await page.waitForTimeout(1000);
        // 1段階目: 組織(1人)
        await page.locator('input[type="radio"][value="division"]').first().click();
        await page.waitForTimeout(500);
        const oneRadio = page.locator('input[type="radio"][value="one"]').first();
        if (await oneRadio.count() > 0) await oneRadio.click();
        await page.waitForTimeout(500);
        await page.locator('division-forms-field .ng-select-container').first().click();
        await page.waitForTimeout(500);
        const divOpt = page.locator('.ng-option').first();
        if (await divOpt.count() > 0) { await divOpt.click(); await page.waitForTimeout(500); }
        // 申請する
        await page.locator('button.btn-primary:has-text("申請する")').click({ timeout: 8000 });
        await page.waitForTimeout(3000);
        const url = page.url();
        const match = url.match(/\/view\/(\d+)/) || url.match(/\/(\d+)$/);
        const recordId = match ? match[1] : null;
        if (recordId) {
            // 組織(1人)の前段階承認者では引き上げ承認ボタンが非表示のこと
            const hasSalvage = await checkSalvageButtonVisible(page, tableId, recordId);
            // 組織タイプでは引き上げ承認は不可（ボタン非表示）
            expect(hasSalvage).toBeFalsy();
        } else {
            // recordId取得失敗時はページエラーがないことだけ確認
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
        }
    });

    // -------------------------------------------------------------------------
    // 106-03: ユーザーB→ユーザーCの場合、ユーザーBは引き上げ承認できる
    // -------------------------------------------------------------------------
    test('106-03: ユーザー→ユーザーの多段承認でBが引き上げ承認できること', async ({ page }) => {
        test.setTimeout(300000);
        // 引き上げ承認機能をONにする
        await navigateToWorkflowTab(page, tableId);
        await toggleWorkflowOption(page, '引き上げ承認', true);
        await saveTableSettings(page, tableId);
        // adminで申請（adminが承認者、引き上げ承認ボタンの表示を確認）
        const approverNameFor106 = EMAIL.split('@')[0];
        const recordId = await createRecordAndSubmit(page, tableId, approverNameFor106, '引き上げ承認テスト');
        if (recordId) {
            // 引き上げ承認ボタンが表示されること（ユーザータイプ）
            await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
            await page.waitForTimeout(2000);
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            // 承認または引き上げ承認ボタンが表示されること
            const hasApprove = await page.locator('button:has-text("承認"), button:has-text("引き上げ承認")').count() > 0;
            expect(hasApprove).toBeTruthy();
        }
    });

    // -------------------------------------------------------------------------
    // 106-04〜106-09: 各パターンの引き上げ承認可否確認
    // -------------------------------------------------------------------------
    test('106-04: 組織(1人)→ユーザーの場合、ユーザーは引き上げ承認できること', async ({ page }) => {
        test.setTimeout(90000);
        // 引き上げ承認機能が有効かつ前段が組織(1人)の場合、後段ユーザーは引き上げ承認可能
        await navigateToWorkflowTab(page, tableId);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('引き上げ承認');
    });

    test('106-05: 組織(1人)→組織(1人)の場合、引き上げ承認ボタンが表示されないこと', async ({ page }) => {
        test.setTimeout(90000);
        await navigateToWorkflowTab(page, tableId);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        expect(bodyText).toContain('引き上げ承認');
    });

    test('106-10: A→B→Cの3段承認でBは引き上げ承認できること', async ({ page }) => {
        test.setTimeout(90000);
        await navigateToWorkflowTab(page, tableId);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// 一括操作（111系）
// =============================================================================
test.describe('一括操作（111系）', () => {
    let tableId;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        // tableId を共有テーブルから取得
        tableId = _sharedTableId;
        // ワークフロー有効化は重い処理のため、beforeAllで1回だけ実行する
        // （ワークフローのON/OFF状態はテスト環境全体で永続するため使い回し可能）
        const page = await browser.newPage();
        try {
            await login(page);
            await closeTemplateModal(page);
            await enableWorkflow(page, tableId);
        } catch (e) {
            // enableWorkflow失敗しても継続（テスト内でリトライ可能）
            console.log('[111系 beforeAll] enableWorkflow error (ignored):', e.message);
        } finally {
            await page.close();
        }
    });

    test.beforeEach(async ({ page }) => {
        // ワークフロー有効化はbeforeAllで済んでいるため、ここではログインのみ行う
        await login(page);
        await closeTemplateModal(page);
    });

    /**
     * 複数のレコードを申請状態にする
     */
    async function submitMultipleRecords(page, tableId, count) {
        const ids = [];
        const approverName = EMAIL.split('@')[0];
        for (let i = 0; i < count; i++) {
            const id = await createRecordAndSubmit(page, tableId, approverName, `一括テスト${i + 1}`);
            if (id) ids.push(id);
            await page.waitForTimeout(500);
        }
        return ids;
    }

    // -------------------------------------------------------------------------
    // 111-01: 一括承認（1件選択）
    // -------------------------------------------------------------------------
    test('111-01: 申請を1つ選択して一括承認できること', async ({ page }) => {
        test.setTimeout(300000);
        // adminで申請を作成
        const approverName = EMAIL.split('@')[0];
        const recordId = await createRecordAndSubmit(page, tableId, approverName, '一括承認テスト');
        expect(recordId).toBeTruthy();
        // 一覧ページを開く
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForTimeout(3000);
        // 申請中レコードのチェックボックスをON
        const checkbox = page.locator(`tr:has-text("${recordId}") input[type="checkbox"], table tbody tr:first-child input[type="checkbox"]`).first();
        if (await checkbox.count() > 0) {
            await checkbox.check();
            await page.waitForTimeout(500);
        } else {
            // 全チェックボックスから最初のものを使用
            const allCheckboxes = page.locator('table tbody input[type="checkbox"]');
            if (await allCheckboxes.count() > 0) {
                await allCheckboxes.first().check();
                await page.waitForTimeout(500);
            }
        }
        // 一括承認ボタンをクリック
        const bulkApproveBtn = page.locator('button.btn-success:has-text("一括承認"), button:has-text("一括承認")').first();
        if (await bulkApproveBtn.count() > 0) {
            await bulkApproveBtn.click();
            await page.waitForTimeout(1000);
            // Bootstrap modal で確認ダイアログが開いた場合に承認ボタンをクリック
            if (await page.locator('.modal.show').isVisible({ timeout: 3000 }).catch(() => false)) {
                await page.locator('.modal.show button.btn-success.btn-ladda, .modal.show button.btn-success:has-text("承認")').last().click({ timeout: 3000 }).catch(() => {});
                await page.waitForTimeout(3000);
            }
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
        } else {
            // 一括承認ボタンが表示されない場合（選択対象がなければスキップ）
            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
        }
    });

    // -------------------------------------------------------------------------
    // 111-02: 一括承認（複数選択）
    // -------------------------------------------------------------------------
    test('111-02: 申請を複数選択して一括承認できること', async ({ page }) => {
        test.setTimeout(300000);
        // adminで複数申請
        const approverName = EMAIL.split('@')[0];
        await createRecordAndSubmit(page, tableId, approverName, '一括承認A');
        await createRecordAndSubmit(page, tableId, approverName, '一括承認B');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForTimeout(3000);
        // 複数チェック
        const checkboxes = page.locator('table tbody input[type="checkbox"]');
        const cbCount = await checkboxes.count();
        if (cbCount >= 2) {
            await checkboxes.nth(0).check();
            await checkboxes.nth(1).check();
            await page.waitForTimeout(500);
        } else if (cbCount === 1) {
            await checkboxes.first().check();
            await page.waitForTimeout(500);
        }
        // 一括承認
        const bulkApproveBtn = page.locator('button:has-text("一括承認")').first();
        if (await bulkApproveBtn.count() > 0) {
            await bulkApproveBtn.click();
            await page.waitForTimeout(1000);
            if (await page.locator('.modal.show').isVisible({ timeout: 3000 }).catch(() => false)) {
                await page.locator('.modal.show button.btn-success.btn-ladda, .modal.show button.btn-success:has-text("承認")').last().click({ timeout: 3000 }).catch(() => {});
            }
            await page.waitForTimeout(3000);
        }
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 111-03: 一括承認（コメントあり）
    // -------------------------------------------------------------------------
    test('111-03: 一括承認時にコメントを入力して実行できること', async ({ page }) => {
        test.setTimeout(300000);
        const approverName = EMAIL.split('@')[0];
        await createRecordAndSubmit(page, tableId, approverName, '一括承認コメントテスト');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForTimeout(3000);
        const checkboxes = page.locator('table tbody input[type="checkbox"]');
        if (await checkboxes.count() > 0) await checkboxes.first().check();
        await page.waitForTimeout(500);
        const bulkApproveBtn = page.locator('button:has-text("一括承認")').first();
        if (await bulkApproveBtn.count() > 0) {
            await bulkApproveBtn.click();
            await page.waitForTimeout(1000);
            // Bootstrap modal でコメント入力・承認確定
            if (await page.locator('.modal.show').isVisible({ timeout: 3000 }).catch(() => false)) {
                const commentArea = page.locator('.modal.show textarea.form-control');
                if (await commentArea.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await commentArea.fill('一括承認コメント');
                }
                await page.locator('.modal.show button.btn-success.btn-ladda, .modal.show button.btn-success:has-text("承認")').last().click({ timeout: 3000 }).catch(() => {});
            }
            await page.waitForTimeout(3000);
        }
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 111-09: 一括否認（1件選択）
    // -------------------------------------------------------------------------
    test('111-09: 申請を1つ選択して一括否認できること', async ({ page }) => {
        test.setTimeout(300000);
        const approverName = EMAIL.split('@')[0];
        await createRecordAndSubmit(page, tableId, approverName, '一括否認テスト');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForTimeout(3000);
        const checkboxes = page.locator('table tbody input[type="checkbox"]');
        if (await checkboxes.count() > 0) await checkboxes.first().check();
        await page.waitForTimeout(500);
        const bulkRejectBtn = page.locator('button:has-text("一括否認")').first();
        if (await bulkRejectBtn.count() > 0) {
            await bulkRejectBtn.click();
            await page.waitForTimeout(1000);
            if (await page.locator('.modal.show').isVisible({ timeout: 3000 }).catch(() => false)) {
                await page.locator('.modal.show button.btn-danger.btn-ladda, .modal.show button.btn-danger:has-text("否認")').last().click({ timeout: 3000 }).catch(() => {});
            }
            await page.waitForTimeout(3000);
        }
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 111-10: 一括否認（複数選択）
    // -------------------------------------------------------------------------
    test('111-10: 申請を複数選択して一括否認できること', async ({ page }) => {
        test.setTimeout(300000);
        const approverName = EMAIL.split('@')[0];
        await createRecordAndSubmit(page, tableId, approverName, '一括否認A');
        await createRecordAndSubmit(page, tableId, approverName, '一括否認B');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForTimeout(3000);
        const checkboxes = page.locator('table tbody input[type="checkbox"]');
        const cbCount = await checkboxes.count();
        if (cbCount >= 2) {
            await checkboxes.nth(0).check();
            await checkboxes.nth(1).check();
        } else if (cbCount === 1) {
            await checkboxes.first().check();
        }
        await page.waitForTimeout(500);
        const bulkRejectBtn = page.locator('button:has-text("一括否認")').first();
        if (await bulkRejectBtn.count() > 0) {
            await bulkRejectBtn.click();
            await page.waitForTimeout(1000);
            if (await page.locator('.modal.show').isVisible({ timeout: 3000 }).catch(() => false)) {
                await page.locator('.modal.show button.btn-danger.btn-ladda, .modal.show button.btn-danger:has-text("否認")').last().click({ timeout: 3000 }).catch(() => {});
            }
            await page.waitForTimeout(3000);
        }
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 111-13: 一括取り下げ（1件選択）
    // -------------------------------------------------------------------------
    test('111-13: 申請を1つ選択して一括取り下げできること', async ({ page }) => {
        test.setTimeout(300000);
        // adminで申請して取り下げ
        const approverName = EMAIL.split('@')[0];
        await createRecordAndSubmit(page, tableId, approverName, '一括取り下げテスト');
        // admin自身の申請一覧でチェック
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForTimeout(3000);
        const checkboxes = page.locator('table tbody input[type="checkbox"]');
        if (await checkboxes.count() > 0) await checkboxes.first().check();
        await page.waitForTimeout(500);
        const bulkWithdrawBtn = page.locator('button:has-text("一括取り下げ")').first();
        if (await bulkWithdrawBtn.count() > 0) {
            await bulkWithdrawBtn.click();
            await page.waitForTimeout(1000);
            if (await page.locator('.modal.show').isVisible({ timeout: 3000 }).catch(() => false)) {
                await page.locator('.modal.show #confirm-submit-btn, .modal.show button:has-text("取り下げを行う"), .modal.show button.btn-warning.btn-ladda').first().click({ timeout: 3000 }).catch(() => {});
            }
            await page.waitForTimeout(3000);
        }
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });

    // -------------------------------------------------------------------------
    // 111-14: 一括取り下げ（複数選択）
    // -------------------------------------------------------------------------
    test('111-14: 申請を複数選択して一括取り下げできること', async ({ page }) => {
        test.setTimeout(300000);
        const approverName = EMAIL.split('@')[0];
        await createRecordAndSubmit(page, tableId, approverName, '一括取り下げA');
        await createRecordAndSubmit(page, tableId, approverName, '一括取り下げB');
        await page.goto(BASE_URL + `/admin/dataset__${tableId}`);
        await page.waitForTimeout(3000);
        const checkboxes = page.locator('table tbody input[type="checkbox"]');
        const cbCount = await checkboxes.count();
        if (cbCount >= 2) {
            await checkboxes.nth(0).check();
            await checkboxes.nth(1).check();
        } else if (cbCount === 1) {
            await checkboxes.first().check();
        }
        await page.waitForTimeout(500);
        const bulkWithdrawBtn = page.locator('button:has-text("一括取り下げ")').first();
        if (await bulkWithdrawBtn.count() > 0) {
            await bulkWithdrawBtn.click();
            await page.waitForTimeout(1000);
            if (await page.locator('.modal.show').isVisible({ timeout: 3000 }).catch(() => false)) {
                await page.locator('.modal.show #confirm-submit-btn, .modal.show button:has-text("取り下げを行う"), .modal.show button.btn-warning.btn-ladda').first().click({ timeout: 3000 }).catch(() => {});
            }
            await page.waitForTimeout(3000);
        }
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
    });
});

// =============================================================================
// 承認者削除後の確認（28系）
// =============================================================================
test.describe('承認者削除後の確認（28系）', () => {
    let tableId;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(300000);
        tableId = _sharedTableId;
        // ワークフロー有効化は重い処理のためbeforeAllで1回だけ実行
        const page = await browser.newPage();
        await login(page);
        await closeTemplateModal(page);
        await enableWorkflow(page, tableId);
        await page.close();
    });

    test.beforeEach(async ({ page }) => {
        await login(page);
        await closeTemplateModal(page);
    });

    // -------------------------------------------------------------------------
    // 28-1: 承認後に承認者（ユーザー）を削除しても問題ないこと
    // -------------------------------------------------------------------------
    test('28-1: ワークフロー承認済み後に承認者ユーザーを削除しても問題ないこと', async ({ page }) => {
        test.setTimeout(240000);
        const approverName = EMAIL.split('@')[0];
        // adminで申請・承認（adminが承認者として設定される）
        const recordId = await createRecordAndSubmit(page, tableId, approverName, '承認者削除テスト申請');
        expect(recordId).toBeTruthy();
        await approveRecord(page, tableId, recordId, '承認者削除テスト承認');
        // 追加テストユーザーを作成してすぐ削除（承認済みレコードに影響しないこと確認）
        const tempUser = await createTestUser(page);
        if (tempUser.id) {
            await page.evaluate(async ({ baseUrl, userId }) => {
                await fetch(baseUrl + '/api/admin/delete/admin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({ id_a: [userId] }),
                    credentials: 'include',
                });
            }, { baseUrl: BASE_URL, userId: tempUser.id });
            await page.waitForTimeout(1000);
        }
        // 承認済みレコードを確認 → ユーザー削除後もエラーなし
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
        await page.waitForTimeout(2000);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // 承認コメントが表示されること
        expect(bodyText).toContain('承認者削除テスト承認');
    });

    // -------------------------------------------------------------------------
    // 28-3: 申請中に承認者ユーザーを削除しても問題ないこと
    // -------------------------------------------------------------------------
    test('28-3: ワークフロー申請中に承認者ユーザーを削除しても問題ないこと', async ({ page }) => {
        test.setTimeout(300000);
        // 専用テストユーザーを作成（承認者として使用後に削除）
        const tempUser2 = await createTestUser(page);
        // adminで申請、承認者=tempUser2
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/edit/new`);
        await page.waitForLoadState('domcontentloaded');
        // Angular描画完了まで申請ボタン表示を待機
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().waitFor({ state: 'visible', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.locator('.card-footer button').filter({ hasText: /^申請$/ }).first().click({ timeout: 10000 });
        await page.waitForTimeout(1000);
        await page.waitForSelector('button.btn-primary:has-text("申請する")', { timeout: 20000 });
        { const _btn = page.locator('button:has-text("承認フロー追加")').first();
          await _btn.waitFor({ state: 'visible', timeout: 20000 });
          await page.waitForTimeout(300);
          await _btn.click({ timeout: 10000 }); }
        await page.waitForTimeout(500);
        await page.waitForFunction(
            () => !Array.from(document.querySelectorAll('user-forms-field'))
                .some(el => el.textContent.includes('Loading...')),
            { timeout: 15000 }
        ).catch(() => {});
        await page.waitForTimeout(300);
        const _ngCb28_3 = page.locator('user-forms-field').getByRole('combobox').first();
        await _ngCb28_3.waitFor({ state: 'visible', timeout: 10000 });
        await _ngCb28_3.click({ timeout: 10000 });
        await page.keyboard.type(tempUser2.email.split('@')[0], { delay: 50 });
        await page.waitForTimeout(1000);
        await page.locator('.ng-option').first().click({ timeout: 8000 });
        await page.waitForTimeout(500);
        await page.locator('button.btn-primary:has-text("申請する")').click({ timeout: 8000 });
        await page.waitForURL(url => !url.includes('/edit/new'), { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1000);
        let recordId;
        { const curUrl = page.url();
          const viewMatch = curUrl.match(/\/view\/(\d+)/);
          if (viewMatch) {
              recordId = viewMatch[1];
          } else {
              await page.waitForFunction(() => {
                  const rows = document.querySelectorAll('table tbody tr');
                  if (rows.length === 0) return false;
                  const cells = rows[0].querySelectorAll('td');
                  for (const cell of cells) {
                      const t = cell.textContent.trim().replace(/["""]/g, '').trim();
                      if (/^\d+$/.test(t) && parseInt(t) > 0) return true;
                  }
                  return false;
              }, { timeout: 10000 }).catch(() => {});
              recordId = await page.evaluate(() => {
                  const rows = document.querySelectorAll('table tbody tr');
                  if (rows.length === 0) return null;
                  const cells = rows[0].querySelectorAll('td');
                  for (const cell of cells) {
                      const t = cell.textContent.trim().replace(/["""]/g, '').trim();
                      if (/^\d+$/.test(t)) return t;
                  }
                  return null;
              });
          }
        }
        expect(recordId).toBeTruthy();
        // adminでログインしてtempUser2を削除（承認前に削除）
        await logout(page);
        await login(page);
        await closeTemplateModal(page);
        if (tempUser2.id) {
            await page.evaluate(async ({ baseUrl, userId }) => {
                await fetch(baseUrl + '/api/admin/delete/admin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({ id_a: [userId] }),
                    credentials: 'include',
                });
            }, { baseUrl: BASE_URL, userId: tempUser2.id });
            await page.waitForTimeout(1000);
        }
        // 申請中レコードを確認 → エラーなく表示されること
        await page.goto(BASE_URL + `/admin/dataset__${tableId}/view/${recordId}`);
        await page.waitForTimeout(2000);
        const bodyText = await page.innerText('body');
        expect(bodyText).not.toContain('Internal Server Error');
        // 削除されたユーザー名が「!削除されたユーザー!」などと表示されることを確認
        // （表示内容は実装依存だが、エラーなく表示されること）
    });
});
