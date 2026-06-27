'use strict';
// テスト一覧シート読取（read-only）。SA鍵ファイル secrets/service_account.json を keyFile として使う（秘密鍵は出力しない）。
// 使い方: node v2/tools/read-sheet.js <spreadsheetId> [gid] [outCsvPath] [keyFile]
const fs = require('fs');
const { google } = require('googleapis');

const SPREADSHEET_ID = process.argv[2];
const GID = process.argv[3] || null;
const OUT = process.argv[4] || '/tmp/testlist.csv';
const KEY_FILE = process.argv[5] || './secrets/service_account.json';

(async () => {
  if (!fs.existsSync(KEY_FILE)) { console.error('SA鍵ファイルが無い:', KEY_FILE); process.exit(2); }
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();
  console.log('使用SA(client_email):', client.email); // 公開識別子のみ
  const sheets = google.sheets({ version: 'v4', auth: client });

  // メタ取得（シート名一覧・gid→title 解決）
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const tabs = meta.data.sheets.map(s => ({ title: s.properties.title, gid: s.properties.sheetId, rows: s.properties.gridProperties.rowCount, cols: s.properties.gridProperties.columnCount }));
  console.log('シートタブ:', JSON.stringify(tabs.map(t => `${t.title}(gid=${t.gid})`)));

  let targetTitle = tabs[0].title;
  if (GID) { const m = tabs.find(t => String(t.gid) === String(GID)); if (m) targetTitle = m.title; }
  console.log('読取タブ:', targetTitle);

  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${targetTitle}'` });
  const rows = resp.data.values || [];
  console.log('行数:', rows.length);

  // CSV化して保存
  const csv = rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\n');
  fs.writeFileSync(OUT, csv);
  console.log('保存:', OUT);

  // 冒頭プレビュー
  console.log('--- 先頭8行 ---');
  rows.slice(0, 8).forEach((r, i) => console.log(i, JSON.stringify(r.slice(0, 8))));
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
