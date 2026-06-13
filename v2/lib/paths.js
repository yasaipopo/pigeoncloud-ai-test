'use strict';
const os = require('os');
const path = require('path');

// E2E 実行成果物の月ごとローカルアーカイブ（2026-06-13 ユーザー指示）
// 既定: ~/pigeon-e2e-archive/YYYY-MM/{runId}/  （report.md / evidence / video を集約）
// E2E_ARCHIVE_ROOT 環境変数で変更可
function archiveRoot() {
    return process.env.E2E_ARCHIVE_ROOT || path.join(os.homedir(), 'pigeon-e2e-archive');
}

/** runId（YYYYMMDD-HHMM-... 形式）から月フォルダを切ったアーカイブ run-dir を返す */
function archiveRunDir(runId) {
    const m = String(runId).match(/^(\d{4})(\d{2})/);
    const month = m ? `${m[1]}-${m[2]}` : 'unknown-month';
    return path.join(archiveRoot(), month, runId);
}

module.exports = { archiveRoot, archiveRunDir };

// CLI: node v2/lib/paths.js <runId>  → アーカイブ run-dir を出力（シェルから run-dir を組み立てる用）
if (require.main === module) {
    const runId = process.argv[2];
    if (!runId) { console.error('usage: node v2/lib/paths.js <runId>'); process.exit(1); }
    process.stdout.write(archiveRunDir(runId));
}
