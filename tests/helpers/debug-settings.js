/**
 * debug-settings.js
 * /admin/debug-tools/settings エンドポイントを使って
 * admin_setting / setting テーブルを動的に操作するヘルパー
 *
 * エンドポイント:
 *   GET  /admin/debug-tools/settings                        → 現在値取得
 *   POST /admin/debug-tools/settings                        → 更新
 *     body: { table: 'admin_setting'|'setting', data: {...} }
 */

const BASE_URL = process.env.BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://localhost';

/**
 * 現在の admin_setting / setting を取得
 */
async function getSettings(request) {
    const resp = await request.get(`${BASE_URL}/admin/debug-tools/settings`);
    return await resp.json();
}

/**
 * admin_setting テーブルを更新
 * @param {object} request - Playwright の APIRequestContext
 * @param {object} data    - { field: value, ... }
 */
async function updateAdminSetting(request, data) {
    const resp = await request.post(`${BASE_URL}/admin/debug-tools/settings`, {
        data: { table: 'admin_setting', data }
    });
    const body = await resp.json();
    if (!body.result?.success) {
        throw new Error(`admin_setting 更新失敗: ${JSON.stringify(body)}`);
    }
    return body;
}

/**
 * setting テーブルを更新
 * @param {object} request - Playwright の APIRequestContext
 * @param {object} data    - { field: value, ... }
 */
async function updateSetting(request, data) {
    const resp = await request.post(`${BASE_URL}/admin/debug-tools/settings`, {
        data: { table: 'setting', data }
    });
    const body = await resp.json();
    if (!body.result?.success) {
        throw new Error(`setting 更新失敗: ${JSON.stringify(body)}`);
    }
    return body;
}

// ============================================================
// よく使うショートカット
// ============================================================

/**
 * ユーザー上限を外す（ユーザー作成失敗スキップを防ぐ）
 * テスト開始前の beforeAll で呼ぶ
 */
async function removeUserLimit(request) {
    return updateSetting(request, { max_user: 9999 });
}

/**
 * テーブル上限を外す
 */
async function removeTableLimit(request) {
    return updateSetting(request, { max_table_num: 9999 });
}

/**
 * 2要素認証を有効/無効にする
 */
async function setTwoFactor(request, enabled) {
    return updateAdminSetting(request, { setTwoFactor: enabled ? 'true' : 'false' });
}

/**
 * 自動ログアウト時間を設定（時間単位）
 * 例: setAutoLogout(request, 1) → 1時間後に自動ログアウト
 *     setAutoLogout(request, null) → 無効化
 */
async function setAutoLogout(request, hours) {
    return updateAdminSetting(request, { auto_logout_hour: hours ?? '' });
}

/**
 * ロックアウトタイムアウトを設定（分単位）
 * 例: setLockTimeout(request, 1) → 1分
 */
async function setLockTimeout(request, minutes) {
    return updateAdminSetting(request, { lock_timeout_min: minutes });
}

/**
 * パスワード複雑性チェックを無効化（テスト中のパスワード設定を簡単にする）
 */
async function disablePasswordComplexity(request) {
    return updateAdminSetting(request, { no_password_complexity_check: 'true' });
}

/**
 * パスワード複雑性チェックを有効化（テスト後のリストア）
 */
async function enablePasswordComplexity(request) {
    return updateAdminSetting(request, { no_password_complexity_check: 'false' });
}

/**
 * Google SAML を有効/無効にする
 * ※ 実際のSSO flowには外部IdPが必要だが、設定UI・ログイン画面変化はテスト可能
 */
async function setGoogleSaml(request, enabled) {
    return updateAdminSetting(request, { google_saml_enabled: enabled ? 'true' : 'false' });
}

/**
 * Microsoft SAML を有効/無効にする
 */
async function setAzureSaml(request, enabled) {
    return updateAdminSetting(request, { azure_saml_enabled: enabled ? 'true' : 'false' });
}

/**
 * 利用規約表示を有効/無効にする
 */
async function setTermsAndConditions(request, enabled) {
    return updateAdminSetting(request, { setTermsAndConditions: enabled ? 'true' : 'false' });
}

/**
 * SMTP設定を一括更新
 * テスト用SMTPサーバー（mailhog等）向け
 */
async function setupSmtp(request, { host, port = 1025, email = 'test@example.com', fromName = 'PigeonCloud Test' } = {}) {
    return updateAdminSetting(request, {
        use_smtp: 'true',
        smtp_host: host,
        smtp_port: String(port),
        smtp_email: email,
        smtp_auth: 'tls',
        smtp_auth_type: 'AUTO',
        smtp_from_name: fromName,
    });
}

/**
 * SMTP を無効化（テスト後リストア用）
 */
async function disableSmtp(request) {
    return updateAdminSetting(request, { use_smtp: 'false' });
}

/**
 * 機能フラグを一括設定
 * 例: setFeatureFlags(request, { enable_api: true, enable_filesearch: true })
 */
async function setFeatureFlags(request, flags) {
    const data = {};
    for (const [key, val] of Object.entries(flags)) {
        data[key] = val ? 'true' : 'false';
    }
    return updateSetting(request, data);
}

/**
 * パスワード変更間隔を設定（日単位）
 * null で無効化
 */
async function setPasswordExpiry(request, days) {
    return updateAdminSetting(request, { pw_change_interval_days: days ?? '' });
}

/**
 * 通知上限を設定（デフォルト 1000/日）
 */
async function setNotifyLimit(request, limitPerDay) {
    return updateSetting(request, { notify_limit_per_day: limitPerDay });
}

/**
 * アクション上限を設定（RPA・自動化テスト向け）
 */
async function setActionLimits(request, { perMin = 999, per15min = 9999 } = {}) {
    return updateSetting(request, {
        action_limit_per_min: perMin,
        action_limit_per_15min: per15min,
    });
}

/**
 * ワークフローCSV編集を有効/無効にする
 */
async function setWorkflowCsvEdit(request, enabled) {
    return updateSetting(request, { workflow_status_edit_by_csv: enabled ? 'true' : 'false' });
}

/**
 * スナップショット保存: テスト前に現在の設定を保存
 * 返り値を afterAll/afterEach で restoreSettings() に渡す
 */
async function snapshotSettings(request) {
    const body = await getSettings(request);
    return {
        admin_setting: body.result?.admin_setting || {},
        setting: body.result?.setting || {},
    };
}

/**
 * スナップショットからリストア
 * @param {object} request
 * @param {object} snapshot - snapshotSettings() の返り値
 */
async function restoreSettings(request, snapshot) {
    if (snapshot.admin_setting && Object.keys(snapshot.admin_setting).length > 0) {
        await updateAdminSetting(request, snapshot.admin_setting);
    }
    if (snapshot.setting && Object.keys(snapshot.setting).length > 0) {
        await updateSetting(request, snapshot.setting);
    }
}

// ============================================================
// テーブルスナップショット（JSON export/import 利用）
// ============================================================

/**
 * テーブル定義をJSONでダウンロード（スナップショット保存）
 *
 * ⚠️ 使用方針:
 *   - 初回は必ずUIの操作でテーブルを作成すること（このAPIだけで済ませない）
 *   - 同じテーブル作成を複数のspecで繰り返す場合のキャッシュとして使う
 *   - 例: createAllTypeTable() を spec A で実行 → スナップショット保存
 *         spec B では saveTableSnapshot のバッファを restoreTableFromSnapshot で復元
 *
 * 使用例:
 *   // spec A の afterAll で保存
 *   ALL_TYPE_TABLE_SNAPSHOT = await saveTableSnapshot(page, tableId);
 *
 *   // spec B の beforeAll で復元（作成済みなら）
 *   if (ALL_TYPE_TABLE_SNAPSHOT) {
 *     await restoreTableFromSnapshot(page, ALL_TYPE_TABLE_SNAPSHOT, groupName);
 *   } else {
 *     await createAllTypeTable(page); // 初回はUI操作
 *   }
 *
 * @param {import('@playwright/test').Page} page - 認証済みPageオブジェクト
 * @param {number|string} datasetId - テーブルID
 * @param {object} options
 * @param {boolean} options.includeData - データも含める（デフォルト: false）
 * @returns {Buffer} JSON バイナリ
 */
async function saveTableSnapshot(page, datasetId, { includeData = false } = {}) {
    const params = new URLSearchParams({
        'dataset_id[]': String(datasetId),
        export_data: String(includeData),
        export_notification: 'false',
        export_grant: 'false',
        export_filter: 'false',
    });
    const resp = await page.request.get(`${BASE_URL}/admin/download-json?${params}`);
    if (!resp.ok()) {
        throw new Error(`テーブルスナップショット取得失敗: ${resp.status()} ${await resp.text()}`);
    }
    return await resp.body();
}

/**
 * テーブルをJSONスナップショットから復元（インポート）
 * 使用例: await restoreTableFromSnapshot(page, snap, 'テナントグループ名');
 *
 * @param {import('@playwright/test').Page} page - 認証済みPageオブジェクト
 * @param {Buffer} jsonBuffer - saveTableSnapshot() の返り値
 * @param {string} groupName - テナントのグループ名（POST body: group_name）
 */
async function restoreTableFromSnapshot(page, jsonBuffer, groupName) {
    const formData = new FormData();
    formData.append('json', new Blob([jsonBuffer], { type: 'application/json' }), 'snapshot.json');
    formData.append('group_name', groupName || '');

    const resp = await page.request.fetch(`${BASE_URL}/admin/upload-json`, {
        method: 'POST',
        multipart: {
            json: {
                name: 'snapshot.json',
                mimeType: 'application/json',
                buffer: jsonBuffer,
            },
            group_name: groupName || '',
        },
    });
    if (!resp.ok()) {
        throw new Error(`テーブルスナップショット復元失敗: ${resp.status()} ${await resp.text()}`);
    }
    return await resp.json();
}

module.exports = {
    getSettings,
    updateAdminSetting,
    updateSetting,
    // テーブルスナップショット
    saveTableSnapshot,
    restoreTableFromSnapshot,
    // ショートカット
    removeUserLimit,
    removeTableLimit,
    setTwoFactor,
    setAutoLogout,
    setLockTimeout,
    disablePasswordComplexity,
    enablePasswordComplexity,
    setGoogleSaml,
    setAzureSaml,
    setTermsAndConditions,
    setupSmtp,
    disableSmtp,
    setFeatureFlags,
    setPasswordExpiry,
    setNotifyLimit,
    setActionLimits,
    setWorkflowCsvEdit,
    snapshotSettings,
    restoreSettings,
    saveTableSnapshot,
    restoreTableFromSnapshot,
};
