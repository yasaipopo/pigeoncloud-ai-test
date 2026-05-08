// @ts-check
/**
 * Angular ng-select コンポーネント操作ヘルパー
 *
 * Pigeon Cloud は @ng-select/ng-select コンポーネントを多用しているが、
 * 操作パターンが spec ごとにバラバラで偽装テスト (操作スキップ) の原因になっていた。
 * このヘルパーで一元化する。
 *
 * 知見 md: .claude/knowledge-e2e-ng-select.md
 */

const { expect } = require('@playwright/test');

/**
 * ng-select の選択肢ドロップダウンを開く
 * @param {import('@playwright/test').Locator} ngSelect
 * @param {object} [options]
 * @param {number} [options.timeout=10000]
 */
async function openNgSelect(ngSelect, options = {}) {
    const timeout = options.timeout || 10000;
    await ngSelect.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    // ng-select の本体クリック (.ng-select-container か .ng-arrow-wrapper を優先)
    const clickable = ngSelect.locator('.ng-select-container, .ng-arrow-wrapper').first();
    if (await clickable.count() > 0) {
        await clickable.click({ timeout });
    } else {
        await ngSelect.click({ timeout });
    }
}

/**
 * ng-select の選択肢から指定テキストを選ぶ
 *
 * 実装上の注意:
 * - dropdown は body 直下に portal 配置されることがあるため、page.locator('.ng-option') で探す
 * - 検索可能 ng-select は文字入力で絞り込み可
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} ngSelect
 * @param {string|RegExp} optionText - 完全一致テキスト or 正規表現
 * @param {object} [options]
 * @param {number} [options.timeout=10000]
 * @param {boolean} [options.searchable=false] - 検索可能ng-select の場合 true
 * @param {boolean} [options.partial=true] - 部分一致 (filter hasText)
 */
async function selectNgSelectOption(page, ngSelect, optionText, options = {}) {
    const timeout = options.timeout || 10000;
    await openNgSelect(ngSelect, { timeout });

    // dropdown panel 表示待ち
    const panel = page.locator('.ng-dropdown-panel').first();
    await panel.waitFor({ state: 'visible', timeout: 5000 });

    // 検索ボックスがある場合は入力 (絞り込み)
    if (options.searchable && typeof optionText === 'string') {
        const input = ngSelect.locator('input[type="text"]').first();
        if (await input.count() > 0) {
            await input.fill(optionText);
            await page.waitForFunction(
                (txt) => Array.from(document.querySelectorAll('.ng-option')).some(o => (o.textContent || '').includes(txt)),
                optionText,
                { timeout: 5000 }
            ).catch(() => {});
        }
    }

    // .ng-option を hasText でフィルタ
    const optionLocator = page.locator('.ng-option').filter({ hasText: optionText }).first();
    await optionLocator.waitFor({ state: 'visible', timeout });
    await optionLocator.click({ timeout });

    // dropdown 閉じるまで待機
    await panel.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
}

/**
 * 現在選択されている値のテキストを取得 (未選択は null)
 * @param {import('@playwright/test').Locator} ngSelect
 */
async function getNgSelectValue(ngSelect) {
    const valueEl = ngSelect.locator('.ng-value-label, .ng-value').first();
    if (await valueEl.count() === 0) return null;
    const txt = await valueEl.textContent();
    return txt ? txt.trim() : null;
}

/**
 * ng-select に選択値があることを expect で検証
 * @param {import('@playwright/test').Locator} ngSelect
 * @param {string|RegExp} expectedText
 */
async function expectNgSelectValue(ngSelect, expectedText) {
    const valueLabel = ngSelect.locator('.ng-value-label, .ng-value').first();
    await expect(valueLabel).toBeVisible({ timeout: 5000 });
    if (typeof expectedText === 'string') {
        await expect(valueLabel).toContainText(expectedText);
    } else {
        await expect(valueLabel).toHaveText(expectedText);
    }
}

/**
 * 通知設定など label が直前にある ng-select を取得 (近接ベース)
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} labelText - label のテキスト (例: 'テーブル', 'アクション')
 * @returns {import('@playwright/test').Locator}
 */
function ngSelectByLabel(page, labelText) {
    // 戦略 1: 同じ form-group / row 内の label と ng-select の組み合わせ
    return page.locator(
        `xpath=//*[contains(@class,'form-group') or contains(@class,'row') or contains(@class,'col')][.//label[contains(normalize-space(.),"${labelText}")]]//ng-select`
    ).first();
}

module.exports = {
    openNgSelect,
    selectNgSelectOption,
    getNgSelectValue,
    expectNgSelectValue,
    ngSelectByLabel,
};
