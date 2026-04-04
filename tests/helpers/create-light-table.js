'use strict';

/**
 * 軽量テーブル作成ヘルパー
 *
 * ALLテストテーブル（102フィールド）の代わりに、テスト対象のフィールドだけを持つ
 * 軽量テーブルをUI操作で作成する。描画が一瞬で安定。
 *
 * 使い方:
 *   const { createLightTable } = require('./helpers/create-light-table');
 *   const tableId = await createLightTable(page, 'テスト用', ['日時', '文字列(一行)', '数値']);
 */

/**
 * 軽量テーブルをUIから作成
 *
 * @param {import('@playwright/test').Page} page - ログイン済みのpage
 * @param {string} tableName - テーブル名
 * @param {string[]} fieldTypes - 追加するフィールドタイプ名の配列
 *   例: ['日時', '文字列(一行)', '数値', '選択肢(単一選択)']
 * @returns {Promise<string>} 作成されたテーブルのID（URLパスから取得）
 */
async function createLightTable(page, tableName, fieldTypes = ['文字列(一行)']) {
    const BASE_URL = process.env.TEST_BASE_URL;

    // テーブル作成ページに遷移
    await page.goto(BASE_URL + '/admin/dataset/edit/new', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // テーブル名入力（:visible で非表示の重複inputを避ける）
    const nameInput = page.locator('input.form-control:visible').first();
    await nameInput.fill(tableName);
    await page.waitForTimeout(500);

    // フィールドをまとめて追加（ページ遷移を最小化）
    for (const fieldType of fieldTypes) {
        // 「＋項目を追加する」ボタン
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        const addBtn = page.locator('button:has-text("項目を追加する")').first();
        await addBtn.click();
        await page.waitForTimeout(1500);

        // フィールドタイプ選択モーダルでクリック
        const typeBtn = page.locator('.modal.show').locator(`text=${fieldType}`).first();
        await typeBtn.click();
        await page.waitForTimeout(2000);

        // フィールド追加後に設定モーダルが開くので閉じる（×ボタンまたはリロード）
        const settingModal = page.locator('.settingModal.show, .modal.show');
        if (await settingModal.count() > 0) {
            // 「変更する」ボタンがあればクリック（デフォルト設定で保存）
            const saveBtn2 = settingModal.locator('button:has-text("変更する")').first();
            if (await saveBtn2.isVisible().catch(() => false)) {
                await saveBtn2.click();
                await page.waitForTimeout(1500);
            } else {
                // ×ボタンで閉じる
                const closeBtn = settingModal.locator('button.close, .modal-header button').first();
                if (await closeBtn.isVisible().catch(() => false)) {
                    await closeBtn.click();
                    await page.waitForTimeout(1000);
                }
            }
        }
    }

    // テーブル保存（submitボタン）
    const saveBtn = page.locator('button[type=submit].btn-primary').last();
    await saveBtn.click();
    await page.waitForTimeout(3000);

    // 保存後のURLからテーブルIDを取得
    const url = page.url();
    const match = url.match(/dataset\/edit\/(\d+)/);
    if (match) {
        return match[1];
    }

    // URLから取得できない場合、サイドバーから取得
    const sidebarLink = await page.evaluate((name) => {
        const links = Array.from(document.querySelectorAll('a[href*="dataset__"]'));
        const link = links.find(a => a.textContent.trim() === name);
        if (link) {
            const m = link.href.match(/dataset__(\d+)/);
            return m ? m[1] : null;
        }
        return null;
    }, tableName);

    return sidebarLink;
}

module.exports = { createLightTable };
