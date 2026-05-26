/**
 * 環境判定 helper (Phase 3 共通化)
 * - trial env vs production env 自動判定
 * - 機能 ON/OFF 設定の参照
 */

/**
 * 環境タイプ判定
 * @returns {'production' | 'staging'}
 */
function getEnvironmentType() {
    if (process.env.ENV_TYPE === 'production') return 'production';
    const adminUrl = process.env.ADMIN_BASE_URL || '';
    if (adminUrl.includes('ai-test.pigeon-cloud.com')) return 'production';
    return 'staging';
}

const IS_PROD_ENV = getEnvironmentType() === 'production';
const IS_TRIAL_ENV = !IS_PROD_ENV;

/**
 * 機能 ON/OFF フラグ (環境変数 or 設定値 ベース)
 * trial env では多くがデフォルト無効
 */
const FeatureFlags = {
    HAS_LOCK_FEATURE: process.env.LOCK_TIMEOUT_MIN && process.env.LOCK_TIMEOUT_MIN !== '0',
    HAS_CERT_FEATURE: process.env.MAX_CLIENT_SECURE_USER_NUM && process.env.MAX_CLIENT_SECURE_USER_NUM !== '0',
    HAS_STEP_MAIL: process.env.STEP_MAIL_OPTION === 'true',
    HAS_STRIPE_SANDBOX: !!process.env.STRIPE_SANDBOX_KEY,
    HAS_INTERNAL_MANAGE_KEY: !!process.env.INTERNAL_MANAGE_KEY,
    HAS_OPEN_SEARCH: process.env.HAS_OPEN_SEARCH === 'true',
};

/**
 * trial env で動作しない機能テスト用の標準 skip 条件
 * @param {string} feature - 'IP_RESTRICTION' | 'LOCK' | 'CERT' | 'STEP_MAIL' | 'STRIPE' | 'OPEN_SEARCH' | 'SAML'
 * @returns {{skip: boolean, reason: string}}
 */
function getTrialSkipCondition(feature) {
    const conditions = {
        IP_RESTRICTION: {
            skip: IS_TRIAL_ENV,
            reason: 'trial env で IP 制限機能が動作しない (admin API が拒否されず success)。本番テスト環境推奨'
        },
        LOCK: {
            skip: IS_TRIAL_ENV && !FeatureFlags.HAS_LOCK_FEATURE,
            reason: 'trial env で lock_timeout_min=0 デフォルト。設定有効化後に再有効化'
        },
        CERT: {
            skip: IS_TRIAL_ENV && !FeatureFlags.HAS_CERT_FEATURE,
            reason: 'trial env で max_client_secure_user_num=0 デフォルト。証明書発行 UI 不在'
        },
        STEP_MAIL: {
            skip: IS_TRIAL_ENV && !FeatureFlags.HAS_STEP_MAIL,
            reason: 'trial env で step_mail_option=false デフォルト'
        },
        STRIPE: {
            skip: !FeatureFlags.HAS_STRIPE_SANDBOX,
            reason: 'STRIPE_SANDBOX_KEY 未設定: Stripe Sandbox 実決済テスト不可'
        },
        OPEN_SEARCH: {
            skip: IS_TRIAL_ENV && !FeatureFlags.HAS_OPEN_SEARCH,
            reason: 'trial env で OpenSearch インデックス未構築'
        },
        SAML: {
            skip: !IS_PROD_ENV,
            reason: 'SAML IdP 実連携は本番環境でのみ動作'
        },
        PERMISSION_NEGATIVE: {
            skip: IS_TRIAL_ENV,
            reason: 'trial env で権限制御 API が機能無効 (一般ユーザーでも 200 返却)'
        },
    };
    return conditions[feature] || { skip: false, reason: '' };
}

module.exports = {
    IS_PROD_ENV,
    IS_TRIAL_ENV,
    getEnvironmentType,
    FeatureFlags,
    getTrialSkipCondition,
};
