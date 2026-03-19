// @ts-check
/**
 * IMAPメール受信チェックヘルパー
 *
 * 使い方:
 *   const { waitForEmail, deleteTestEmails } = require('./helpers/mail-checker');
 *
 *   const mail = await waitForEmail({ subjectContains: '承認依頼', timeout: 30000 });
 *   expect(mail.subject).toContain('承認依頼');
 *   await deleteTestEmails({ subjectContains: '承認依頼' });
 *
 * 認証情報は .env に記載（IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS）
 */

const { ImapFlow } = require('imapflow');

// .env から認証情報を読む（Playwrightがdotenvを自動ロードするため不要な場合も多い）
const IMAP_HOST = process.env.IMAP_HOST || 'www3569.sakura.ne.jp';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;

/**
 * IMAPクライアントを作成して接続する
 * @returns {Promise<ImapFlow>}
 */
async function createClient() {
    if (!IMAP_USER || !IMAP_PASS) {
        throw new Error('IMAP認証情報が未設定です。.envにIMAP_USER/IMAP_PASSを設定してください');
    }
    const client = new ImapFlow({
        host: IMAP_HOST,
        port: IMAP_PORT,
        secure: true,
        auth: {
            user: IMAP_USER,
            pass: IMAP_PASS,
        },
        logger: false,  // ログを抑制（デバッグ時は true に）
    });
    await client.connect();
    return client;
}

/**
 * メールが届くまで待機する
 *
 * @param {Object} options
 * @param {string}  [options.subjectContains]  - 件名に含まれる文字列
 * @param {string}  [options.from]             - 送信元アドレス（部分一致）
 * @param {string}  [options.to]               - 宛先アドレス（部分一致）
 * @param {Date}    [options.since]            - この日時以降に受信したメール（省略時: 直近5分）
 * @param {number}  [options.timeout]          - タイムアウトms（デフォルト: 60000）
 * @param {number}  [options.pollInterval]     - ポーリング間隔ms（デフォルト: 3000）
 * @param {string}  [options.mailbox]          - メールボックス名（デフォルト: INBOX）
 * @returns {Promise<{subject: string, from: string, to: string, date: Date, text: string, html: string}>}
 */
async function waitForEmail(options = {}) {
    const {
        subjectContains,
        from,
        to,
        since,
        timeout = 60000,
        pollInterval = 3000,
        mailbox = 'INBOX',
    } = options;

    // sinceが未指定の場合は5分前
    const sinceDate = since || new Date(Date.now() - 5 * 60 * 1000);

    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        const client = await createClient();
        try {
            await client.mailboxOpen(mailbox);

            // 検索条件を組み立てる
            const searchCriteria = { since: sinceDate };
            if (from) searchCriteria.from = from;
            if (to)   searchCriteria.to = to;

            const uids = await client.search(searchCriteria, { uid: true });

            if (uids.length > 0) {
                // 最新のメールから順に確認
                for (const uid of uids.reverse()) {
                    const msg = await client.fetchOne(String(uid), {
                        envelope: true,
                        bodyStructure: true,
                        source: true,
                    }, { uid: true });

                    if (!msg) continue;

                    const subject = msg.envelope?.subject || '';
                    const fromAddr = msg.envelope?.from?.[0]?.address || '';
                    const toAddr   = msg.envelope?.to?.[0]?.address   || '';

                    // subjectContainsフィルター
                    if (subjectContains && !subject.includes(subjectContains)) continue;
                    if (from && !fromAddr.includes(from)) continue;
                    if (to   && !toAddr.includes(to))     continue;

                    // ソースからテキストを取得
                    const rawSource = msg.source?.toString('utf-8') || '';

                    return {
                        uid,
                        subject,
                        from: fromAddr,
                        to: toAddr,
                        date: msg.envelope?.date,
                        text: rawSource,
                        html: rawSource,
                    };
                }
            }
        } finally {
            await client.logout();
        }

        // まだ届いていない場合は待機してリトライ
        if (Date.now() + pollInterval < deadline) {
            await new Promise(r => setTimeout(r, pollInterval));
        } else {
            break;
        }
    }

    const criteria = [
        subjectContains ? `件名「${subjectContains}」` : '',
        from ? `from:${from}` : '',
        to   ? `to:${to}`     : '',
    ].filter(Boolean).join(', ');
    throw new Error(`タイムアウト: ${timeout}ms 以内にメールが届きませんでした（${criteria}）`);
}

/**
 * 条件に一致するメールを全件削除する（テスト後クリーンアップ用）
 *
 * @param {Object} options
 * @param {string}  [options.subjectContains]
 * @param {Date}    [options.since]
 * @param {string}  [options.mailbox]
 * @returns {Promise<number>} 削除件数
 */
async function deleteTestEmails(options = {}) {
    const {
        subjectContains,
        since,
        mailbox = 'INBOX',
    } = options;

    const sinceDate = since || new Date(Date.now() - 60 * 60 * 1000); // デフォルト1時間前以降

    const client = await createClient();
    let deletedCount = 0;
    try {
        await client.mailboxOpen(mailbox, { readOnly: false });
        const uids = await client.search({ since: sinceDate }, { uid: true });

        if (uids.length === 0) return 0;

        const toDelete = [];
        for (const uid of uids) {
            const msg = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
            if (!msg) continue;
            const subject = msg.envelope?.subject || '';
            if (!subjectContains || subject.includes(subjectContains)) {
                toDelete.push(uid);
            }
        }

        if (toDelete.length > 0) {
            await client.messageDelete(toDelete.map(String), { uid: true });
            deletedCount = toDelete.length;
        }
    } finally {
        await client.logout();
    }
    return deletedCount;
}

module.exports = { waitForEmail, deleteTestEmails };
