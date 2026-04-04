'use strict';

/**
 * 軽量テーブル作成ヘルパー
 *
 * debug API（/api/admin/debug/create-light-table）でスキーマ定義に基づき
 * テーブル+フィールド+レコード+ワークフロー設定を一括作成。
 *
 * 使い方1: スキーマファイル指定
 *   const { createTableFromSchema } = require('./helpers/create-light-table');
 *   const result = await createTableFromSchema(page, 'datetime-test');
 *   // result.table_id, result.fields
 *
 * 使い方2: 直接指定
 *   const { createLightTable } = require('./helpers/create-light-table');
 *   const tableId = await createLightTable(page, 'テスト用', [
 *     { type: 'datetime', label: '日時', default_now: true },
 *     { type: 'text', label: 'テキスト', required: true }
 *   ]);
 */

const path = require('path');
const fs = require('fs');

/**
 * スキーマファイルからテーブル作成
 * @param {import('@playwright/test').Page} page
 * @param {string} schemaName - tests/schemas/ 内のファイル名（拡張子なし）
 * @returns {Promise<{table_id: string, fields: Array}>}
 */
async function createTableFromSchema(page, schemaName) {
    const schemaPath = path.join(__dirname, '..', 'schemas', schemaName + '.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    return await _callApi(page, schema);
}

/**
 * 直接指定でテーブル作成
 * @param {import('@playwright/test').Page} page
 * @param {string} tableName
 * @param {Array<string|Object>} fields - フィールド定義配列
 * @param {Object} [options] - { records, workflow }
 * @returns {Promise<string|null>} テーブルID
 */
async function createLightTable(page, tableName, fields = ['text'], options = {}) {
    const result = await _callApi(page, {
        name: tableName,
        fields,
        records: options.records,
        workflow: options.workflow,
    });
    return result?.table_id ? String(result.table_id) : null;
}

async function _callApi(page, body) {
    const result = await page.evaluate(async (b) => {
        try {
            const r = await fetch('/api/admin/debug/create-light-table', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify(b),
                credentials: 'include',
            });
            return r.json();
        } catch (e) {
            return { error: e.message };
        }
    }, body);

    if (result?.table_id) {
        console.log(`[createLightTable] テーブル作成完了: ${body.name || 'unnamed'}, tableId=${result.table_id}, fields=${result.fields?.length || 0}`);
        return result;
    }
    console.warn('[createLightTable] 失敗:', JSON.stringify(result).substring(0, 200));
    return null;
}

module.exports = { createLightTable, createTableFromSchema };
