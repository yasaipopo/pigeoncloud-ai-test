'use strict';

/**
 * 軽量テーブル作成ヘルパー
 *
 * debug API（/api/admin/debug/create-light-table）で
 * テスト対象のフィールドだけを持つ軽量テーブルをDBレベルで直接作成。
 * UIフロー不要、モーダル問題なし、一瞬で完了。
 *
 * 使い方:
 *   const { createLightTable } = require('./helpers/create-light-table');
 *   const tableId = await createLightTable(page, 'テスト用', ['datetime', 'text', 'number']);
 */

/**
 * @param {import('@playwright/test').Page} page - ログイン済みのpage
 * @param {string} tableName - テーブル名
 * @param {string[]} fieldTypes - フィールドタイプ名の配列
 *   例: ['datetime', 'text', 'number', 'boolean', 'select', 'checkbox', 'file', 'image']
 * @returns {Promise<string|null>} テーブルID
 */
async function createLightTable(page, tableName, fieldTypes = ['text']) {
    const result = await page.evaluate(async ({ name, fields }) => {
        try {
            const r = await fetch('/api/admin/debug/create-light-table', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ name, fields }),
                credentials: 'include',
            });
            return r.json();
        } catch (e) {
            return { error: e.message };
        }
    }, { name: tableName, fields: fieldTypes });

    if (result.table_id) {
        return String(result.table_id);
    }
    console.warn('[createLightTable] 失敗:', JSON.stringify(result));
    return null;
}

module.exports = { createLightTable };
