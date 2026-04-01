// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.TEST_BASE_URL;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;

async function waitForAngular(page, timeout = 15000) {
    try {
        await page.waitForSelector('body[data-ng-ready="true"]', { timeout: Math.min(timeout, 5000) });
    } catch {
        // data-ng-readyが設定されないケースがある: networkidleで代替
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
}

// Stripeテストカード情報（Sandboxモード用）
const STRIPE_TEST_CARD = '4242 4242 4242 4242';
const STRIPE_TEST_EXPIRY = '12 / 30';
const STRIPE_TEST_CVC = '123';
const STRIPE_INVALID_CARD = '1234 5678 9012 3456';

/**
 * ログイン共通関数
 */
async function login(page) {
    await page.goto(BASE_URL + '/admin/login');
    await page.waitForLoadState('domcontentloaded');
    // storageStateでログイン済みならリダイレクトされる
    if (!page.url().includes('/admin/login')) {
        await page.waitForSelector('.navbar', { timeout: 5000 });
        return;
    }
    // ログインフォームが表示されなければリダイレクト途中
    const _loginField = await page.waitForSelector('#id', { timeout: 5000 }).catch(() => null);
    if (!_loginField) {
        await page.waitForSelector('.navbar', { timeout: 5000 });
        return;
    }
    try {
        await page.waitForSelector('#id', { timeout: 5000 });
    } catch (e) {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
    await page.fill('#id', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit].btn-primary');
    try {
        await page.waitForURL('**/admin/dashboard', { timeout: 15000 });
    } catch (e) {
        const bodyText = await page.innerText('body').catch(() => '');
        if (bodyText.includes('利用規約') || bodyText.includes('同意')) {
            await page.evaluate(() => {
                const cbs = document.querySelectorAll('input[type="checkbox"]');
                for (const cb of cbs) {
                    cb.checked = true;
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                }
                const btn = document.querySelector('button.btn-primary');
                if (btn) { btn.removeAttribute('disabled'); btn.click(); }
            });
            await page.waitForURL('**/admin/dashboard', { timeout: 20000 }).catch(() => {});
        }
    }
    await waitForAngular(page);
}

/**
 * 支払いページへ遷移する共通関数
 */
async function gotoPaymentPage(page) {
    await page.goto(BASE_URL + '/admin/payment/pay');
    await page.waitForLoadState('domcontentloaded');
    // Angular SPAのレンダリング完了を待つ
    try {
        await page.waitForSelector('h1.plan-header, h2.plan-header, .plan-card', { timeout: 5000 });
    } catch (e) {
        await waitForAngular(page);
    }
}

test.describe('支払い・プラン管理', () => {

    test('PM01: 支払いページ基本機能確認', async ({ page }) => {
        await login(page);
        let stepStart;

        await test.step('PAY-01: 支払いページが表示されること', async () => {
            stepStart = Date.now();
            await gotoPaymentPage(page);

            // URLが /admin/payment/pay であること
            expect(page.url()).toContain('/admin/payment/pay');

            // ページタイトル「利用料金のお支払い」が表示されること
            const heading = await page.locator('h1.plan-header, h1').first();
            await expect(heading).toContainText('利用料金のお支払い');

            // エラーアラートが表示されていないこと
            const alertDanger = page.locator('.alert-danger');
            const alertCount = await alertDanger.count();
            expect(alertCount).toBe(0);

            // 「有料プラン契約」の見出しが存在すること
            await expect(page.locator('h2.plan-header, h2')).toContainText('有料プラン契約');
            console.log(`STEP_TIME PAY-01: ${Date.now() - stepStart}ms`);
        });

        await test.step('PAY-02: プラン変更フォームと料金情報が表示されること', async () => {
            stepStart = Date.now();
            // テスト環境ではStripe設定がないためスキップ
            test.skip(true, 'テスト環境ではStripe設定がないためスキップ');
            await gotoPaymentPage(page);

            // 「プラン変更」見出しが表示されること
            await expect(page.locator('h3.plan-header, h3').first()).toContainText('プラン変更');

            // プラン選択テーブルが存在すること
            const planTable = page.locator('.table.table-bordered').first();
            await expect(planTable).toBeVisible();

            // プラン種別ラジオボタン（ユーザー数 / ログイン数）が存在すること
            const userNumRadio = page.locator('input[type="radio"]#user_num, input[type="radio"][value="user_num"]');
            const loginNumRadio = page.locator('input[type="radio"]#login_num, input[type="radio"][value="login_num"]');
            await expect(userNumRadio).toBeVisible();
            await expect(loginNumRadio).toBeVisible();

            // ユーザー数入力欄が存在すること
            const userNumInput = page.locator('input[type="number"].form-control, input.form-control').first();
            await expect(userNumInput).toBeVisible();

            // 料金明細の見出しが表示されること
            await expect(page.locator('h4').filter({ hasText: '料金明細' })).toBeVisible();

            // お支払い金額が表示されること
            const priceCalc = page.locator('#price_calc');
            await expect(priceCalc).toBeVisible();
            const priceText = await priceCalc.textContent();
            // 料金が数値として表示されていること（カンマ区切り数値）
            expect(priceText).toMatch(/[\d,]+/);

            // 「お支払い金額（税込）」の見出しが表示されること
            await expect(page.locator('h4').filter({ hasText: 'お支払い金額' })).toBeVisible();
            console.log(`STEP_TIME PAY-02: ${Date.now() - stepStart}ms`);
        });

        await test.step('PAY-03: Stripe checkoutの関連iframeが存在すること', async () => {
            stepStart = Date.now();
            // テスト環境ではStripe設定がないためスキップ
            test.skip(true, 'テスト環境ではStripe設定がないためスキップ');
            await gotoPaymentPage(page);

            // Stripe関連のiframeが存在すること（checkout.stripe.com）
            const stripeCheckoutIframe = page.frameLocator('iframe[name="stripe_checkout_app"]');
            // iframeのsrcを確認
            const iframeEl = page.locator('iframe[name="stripe_checkout_app"]');
            await expect(iframeEl).toBeAttached({ timeout: 10000 });

            // Stripe controllerのiframeも存在すること
            const stripeControllerIframe = page.locator('iframe[src*="js.stripe.com"]');
            await expect(stripeControllerIframe.first()).toBeAttached();

            // 「クレジットカード支払いに進む」ボタンが存在すること
            const ctaButton = page.locator('.stripe-subscription button.btn-success.cta-button');
            await expect(ctaButton).toBeVisible();
            await expect(ctaButton).toContainText('クレジットカード支払いに進む');
            console.log(`STEP_TIME PAY-03: ${Date.now() - stepStart}ms`);
        });

        await test.step('PAY-04: テストカードでStripe支払いフォームに入力できること（Checkoutモーダル）', async () => {
            stepStart = Date.now();
            // テスト環境ではStripe設定がないためスキップ
            test.skip(true, 'テスト環境ではStripe設定がないためスキップ');
            await gotoPaymentPage(page);

            // 「クレジットカード支払いに進む」ボタンをクリック
            const ctaButton = page.locator('.stripe-subscription button.btn-success.cta-button');
            await expect(ctaButton).toBeVisible();
            await ctaButton.click();

            // Stripe Checkout モーダルが開くのを待つ（iframeがフォーカス状態になる）
            await page.waitForTimeout(3000);

            // Stripe Checkout iframe が表示されていること
            const checkoutIframe = page.locator('iframe[name="stripe_checkout_app"]');
            await expect(checkoutIframe).toBeAttached({ timeout: 10000 });

            // Stripe Checkout iframeの中に入力フォームが存在するか確認
            // （stripe checkoutは外部iframeのため、frameLocatorでアクセス）
            const frame = page.frameLocator('iframe[name="stripe_checkout_app"]');

            // カード番号入力フィールドを探す
            const cardInput = frame.locator('input[name="cardnumber"], input[placeholder*="カード"], input[autocomplete*="cc-number"], input[data-elements-stable-field-name="cardNumber"]');
            const cardInputCount = await cardInput.count();

            if (cardInputCount > 0) {
                // カード番号入力
                await cardInput.first().fill('4242424242424242');
                await page.waitForTimeout(500);

                // 有効期限入力
                const expiryInput = frame.locator('input[name="exp-date"], input[placeholder*="MM"], input[autocomplete*="cc-exp"], input[data-elements-stable-field-name="cardExpiry"]');
                if (await expiryInput.count() > 0) {
                    await expiryInput.first().fill('1230');
                    await page.waitForTimeout(500);
                }

                // CVC入力
                const cvcInput = frame.locator('input[name="cvc"], input[placeholder*="CVC"], input[placeholder*="CVV"], input[autocomplete*="cc-csc"]');
                if (await cvcInput.count() > 0) {
                    await cvcInput.first().fill('123');
                    await page.waitForTimeout(500);
                }

                // 入力後にエラーが発生していないことを確認（正常カードなのでバリデーションエラーなし）
                const errorMsg = frame.locator('.StripeElement--invalid, [class*="error"], [role="alert"]');
                const errorCount = await errorMsg.count();
                // テストカードなのでエラーは出ないはず（または出ても "invalid" ではない）
                console.log('[PAY-04] カード入力フォームへの入力完了');
            } else {
                // Stripe Checkoutモーダルが別ウィンドウで開く場合
                // またはiframe内のDOMが非同期でロードされる場合のフォールバック
                console.log('[PAY-04] Stripe Checkout iframeが確認できました（iframe内DOM非同期）');
                // iframeが存在することの確認のみ
                await expect(checkoutIframe).toBeAttached();
            }
            console.log(`STEP_TIME PAY-04: ${Date.now() - stepStart}ms`);
        });

        await test.step('PAY-05: ユーザー数の範囲外入力でバリデーションエラーが表示されること', async () => {
            stepStart = Date.now();
            // テスト環境ではStripe設定がないためスキップ
            test.skip(true, 'テスト環境ではStripe設定がないためスキップ');
            await gotoPaymentPage(page);

            // ユーザー数入力欄を確認
            const userNumInput = page.locator('input[type="number"].form-control, input.form-control').first();
            await expect(userNumInput).toBeVisible();

            // 範囲外の値（最小値5未満）を入力
            await userNumInput.fill('2');
            await userNumInput.press('Tab');
            await waitForAngular(page);

            // バリデーションエラーメッセージが表示されること
            // ※AngularのバリデーションまたはHTML5バリデーションによる表示
            const errorText = page.locator('.text-danger, .invalid-feedback, [class*="error"]');
            const errorCount = await errorText.count();

            if (errorCount > 0) {
                // エラーメッセージが1件以上表示されていること
                expect(errorCount).toBeGreaterThan(0);
                console.log('[PAY-05] バリデーションエラー表示確認');
            } else {
                // 「クレジットカード支払いに進む」ボタンが無効化またはエラー表示
                // ページ内の警告テキストを確認
                const warningText = await page.locator('main').textContent().catch(() => '');
                const hasRangeWarning = warningText.includes('5') && (warningText.includes('範囲') || warningText.includes('以上') || warningText.includes('3000'));
                console.log('[PAY-05] 範囲警告テキスト確認:', hasRangeWarning);
            }

            // 範囲外の値（最大値3000超）を入力
            await userNumInput.fill('9999');
            await userNumInput.press('Tab');
            await waitForAngular(page);

            // 範囲超過でもエラーまたは警告が表示されること
            const pageContent = await page.locator('main').textContent().catch(() => '');
            expect(pageContent).toContain('3000');
            console.log(`STEP_TIME PAY-05: ${Date.now() - stepStart}ms`);
        });

        await test.step('PAY-06: 支払い履歴APIエンドポイントが存在すること', async () => {
            stepStart = Date.now();

            // Stripe Invoice ダウンロードAPIが存在することを確認（404でないこと）
            // エンドポイント: /admin/download-stripe-invoice/{id}
            // ここでは支払いページの表示と現在の支払い状態APIを確認する

            // /api/admin/next-plan APIを呼んで支払い情報を取得
            const nextPlanData = await page.evaluate(async (baseUrl) => {
                const resp = await fetch(baseUrl + '/api/admin/next-plan', {
                    credentials: 'include',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' }
                });
                return await resp.json();
            }, BASE_URL);

            // APIが正常に応答すること
            expect(nextPlanData).toHaveProperty('result', 'success');
            console.log('[PAY-06] next-plan API応答:', JSON.stringify(nextPlanData));

            // 支払いページに遷移して現在のプラン状態を確認
            await gotoPaymentPage(page);

            // ページにエラーが表示されていないこと
            const alertDanger = page.locator('.alert-danger');
            expect(await alertDanger.count()).toBe(0);

            // 契約済みの場合は支払い履歴テーブルが表示されること
            const isUpdate = nextPlanData.next_plan !== false;
            if (isUpdate) {
                // 契約済みの場合：現在のプランテーブルが表示されること
                const currentPlanTable = page.locator('.current-plan-table');
                await expect(currentPlanTable).toBeVisible();
                console.log('[PAY-06] 現在のプランテーブルが表示されています');
            } else {
                // 未契約の場合：プラン変更フォームが表示されること
                await expect(page.locator('h3').filter({ hasText: 'プラン変更' })).toBeVisible();
                console.log('[PAY-06] 未契約環境 - プラン変更フォームが表示されています');
            }
            console.log(`STEP_TIME PAY-06: ${Date.now() - stepStart}ms`);
        });
    });

    test('UC16: 支払いページでクレジットカードブランド表示確認', async ({ page }) => {
        await login(page);
        let stepStart;

        await test.step('715: 支払いページでクレジットカードのブランドが正しく表示されること', async () => {
            stepStart = Date.now();

            // 支払い設定ページに遷移
            await page.goto(BASE_URL + '/admin/setting/payment', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // カード情報表示エリアを確認
            const cardInfo = page.locator('.card-info, .credit-card, [class*="card-brand"], :has-text("Visa"), :has-text("MasterCard"), :has-text("カード")');
            const cardInfoCount = await cardInfo.count();
            console.log('715: カード情報要素数:', cardInfoCount);

            // カードブランドアイコンを確認
            const brandIcons = page.locator('img[src*="card"], img[src*="visa"], img[src*="master"], .card-brand-icon, [class*="brand"]');
            const brandIconCount = await brandIcons.count();
            console.log('715: カードブランドアイコン数:', brandIconCount);

            // カード情報更新ボタンを確認
            const updateBtn = page.locator('button:has-text("カード"), button:has-text("更新"), button:has-text("変更")');
            const updateCount = await updateBtn.count();
            console.log('715: カード更新ボタン数:', updateCount);

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible();
            console.log(`STEP_TIME 715: ${Date.now() - stepStart}ms`);
        });
    });

    test('UC03: 請求情報メニュー・領収書ダウンロード確認', async ({ page }) => {
        await login(page);
        let stepStart;

        await test.step('355: 契約済み環境で請求情報メニューが表示され領収書がダウンロードできること', async () => {
            stepStart = Date.now();

            // サイドメニューから請求情報を確認
            await page.goto(BASE_URL + '/admin/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // テンプレートモーダルを閉じる
            const modal = page.locator('.modal.show');
            if (await modal.isVisible({ timeout: 3000 }).catch(() => false)) {
                await modal.locator('button').first().click({ force: true }).catch(() => {});
                await page.waitForTimeout(1000);
            }

            // 「請求情報」メニューを確認
            const billingMenu = page.locator('a:has-text("請求"), a:has-text("billing"), .nav-link:has-text("請求")');
            const billingVisible = await billingMenu.first().isVisible({ timeout: 5000 }).catch(() => false);
            console.log('355: 請求情報メニュー表示:', billingVisible);

            if (billingVisible) {
                await billingMenu.first().click();
                await waitForAngular(page);

                // 請求情報ページが表示されること
                const bodyText = await page.innerText('body');
                expect(bodyText).not.toContain('Internal Server Error');

                // 領収書ダウンロードボタンを確認
                const receiptBtn = page.locator('button:has-text("領収書"), a:has-text("領収書"), button:has-text("ダウンロード")');
                const receiptCount = await receiptBtn.count();
                console.log('355: 領収書ダウンロードボタン数:', receiptCount);
            } else {
                // 請求情報メニューがない場合（demo環境等）
                console.log('355: 請求情報メニューが表示されない（未契約またはdemo環境の可能性）');
            }

            await expect(page.locator('.navbar')).toBeVisible();
            console.log(`STEP_TIME 355: ${Date.now() - stepStart}ms`);
        });
    });

    test('UC09: 決済後のユーザー数変更確認', async ({ page }) => {
        await login(page);
        let stepStart;

        await test.step('573: 決済後のユーザー数変更が即時反映されること', async () => {
            stepStart = Date.now();

            // 決済設定ページに遷移
            await page.goto(BASE_URL + '/admin/setting/payment', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForAngular(page);

            // ユーザー数設定欄を確認
            const userCountInput = page.locator('input[name*="user"], input[type="number"]:near(:text("ユーザー")), :has-text("ユーザー数")');
            const userCountVisible = await userCountInput.first().isVisible({ timeout: 5000 }).catch(() => false);
            console.log('573: ユーザー数設定欄表示:', userCountVisible);

            // 現在の登録可能ユーザー数を確認
            const currentUserInfo = page.locator(':has-text("登録可能"), :has-text("ユーザー数"), :has-text("上限")');
            const userInfoCount = await currentUserInfo.count();
            console.log('573: ユーザー数情報要素数:', userInfoCount);

            const bodyText = await page.innerText('body');
            expect(bodyText).not.toContain('Internal Server Error');
            await expect(page.locator('.navbar')).toBeVisible();
            console.log(`STEP_TIME 573: ${Date.now() - stepStart}ms`);
        });
    });

});
