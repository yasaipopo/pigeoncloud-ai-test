/**
 * PigeonCloud E2E ビューアー - Playwright カスタムレポーター
 *
 * テスト1件完了ごとにリアルタイムでDynamoDB/S3に登録する。
 * E2E_API_URL が設定されているときだけ動作する。
 *
 * playwright.config.js に追加:
 *   process.env.E2E_API_URL ? [['./e2e-viewer/reporter.js']] : []
 *
 * 環境変数:
 *   E2E_API_URL       - APIエンドポイント（必須）
 *   E2E_API_PASSWORD  - APIパスワード（デフォルト: pigeon-e2e-2026）
 *   E2E_API_TOKEN     - トークン直接指定（省略可）
 *   AGENT_NUM         - エージェント番号（デフォルト: 1）
 *   TEST_BASE_URL     - テスト環境URL
 */

const { createHash } = require('crypto');
const { existsSync, readFileSync } = require('fs');
const { basename } = require('path');
const { execSync } = require('child_process');

const TOKEN_SALT = 'pigeon-e2e-viewer-salt-2026';
const VIEWER_URL = 'https://dezmzppc07xat.cloudfront.net';

function generateToken(password) {
  return createHash('sha256').update(password + TOKEN_SALT).digest('hex');
}

async function uploadFileToPresignedUrl(presignedUrl, filePath, contentType) {
  const data = readFileSync(filePath);
  const resp = await fetch(presignedUrl, {
    method: 'PUT',
    body: data,
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
  });
  if (!resp.ok) throw new Error(`S3 PUT ${resp.status}`);
}

class E2EViewerReporter {
  constructor(options = {}) {
    this.apiUrl = (options.apiUrl || process.env.E2E_API_URL || '').replace(/\/$/, '');
    const password = options.password || process.env.E2E_API_PASSWORD || 'pigeon-e2e-2026';
    this.token = options.token || process.env.E2E_API_TOKEN || generateToken(password);
    this.agentNum = parseInt(options.agentNum || process.env.AGENT_NUM || '1');
    this.testEnvUrl = options.testEnvUrl || process.env.TEST_BASE_URL || '';

    this.runId = null;
    this.passCount = 0;
    this.failCount = 0;
    this.skipCount = 0;
    this.startTime = null;
    this._beginPromise = null;  // onBeginの非同期処理を追跡
  }

  // =========================================
  // HTTP ヘルパー
  // =========================================

  _headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  async _post(path, body, retries = 2) {
    const url = `${this.apiUrl}${path}`;
    for (let i = 0; i <= retries; i++) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: this._headers(),
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
        }
        return await resp.json();
      } catch (e) {
        if (i === retries) throw e;
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }

  async _put(path, body) {
    const resp = await fetch(`${this.apiUrl}${path}`, {
      method: 'PUT',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  }

  // =========================================
  // Git情報取得
  // =========================================

  _getGitInfo() {
    let commitHash = 'unknown';
    let branch = 'unknown';
    try {
      commitHash = execSync(
        'git -C /app/src/pigeon_cloud rev-parse --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim() || 'unknown';
    } catch (e) {}
    try {
      branch = execSync(
        'git rev-parse --abbrev-ref HEAD',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim() || 'unknown';
    } catch (e) {}
    return { commitHash, branch };
  }

  // =========================================
  // Playwright Reporter フック
  // =========================================

  /**
   * suiteを再帰的に走査してテスト総数をカウント（expectedTotal用）
   */
  _countTests(suite) {
    let n = 0;
    // spec（テストケース）を数える
    for (const spec of suite.specs || []) {
      n += spec.tests?.length || 1;
    }
    // 子suiteを再帰的に数える
    for (const child of suite.suites || []) {
      n += this._countTests(child);
    }
    return n;
  }

  /**
   * テスト開始前: ランを登録してrunIdを確定させる
   * onBeginはsyncだが、非同期処理をPromiseとして保持し
   * onTestEndで await する
   */
  onBegin(config, suite) {
    if (!this.apiUrl) return;

    this.startTime = Date.now();
    const { commitHash, branch } = this._getGitInfo();
    this.commitHash = commitHash;
    this.branch = branch;

    // runId生成
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    this.runId = `${ts}_${commitHash}_agent${this.agentNum}`;

    // specファイル一覧（ルートsuiteの直下suites = ファイル単位）
    const specFiles = [...new Set(
      (suite.suites || []).map(s => basename(s.title || '')).filter(Boolean)
    )];
    this.specFile = specFiles.join(',');

    // テスト総数をカウント（リアルタイム進捗バーのETA計算に使用）
    const expectedTotal = this._countTests(suite);

    this._beginPromise = this._post('/runs', {
      runId: this.runId,
      commitHash,
      branch,
      agentNum: this.agentNum,
      specFile: this.specFile,
      testEnvUrl: this.testEnvUrl,
      runStatus: 'running',
      startedAt: new Date(this.startTime).toISOString(),
      expectedTotal,
    }).then(() => {
      process.stdout.write(`\n[E2EViewer] 実行登録: ${this.runId} (総数: ${expectedTotal}件)\n`);
    }).catch(e => {
      process.stderr.write(`[E2EViewer] 実行登録失敗: ${e.message}\n`);
      this.runId = null;  // 登録失敗時はその後のアップロードをスキップ
    });
  }

  /**
   * テスト1件完了ごとに呼ばれる
   * 結果をDynamoDBに登録し、動画・スクリーンショットをS3にアップロード
   */
  async onTestEnd(test, result) {
    if (!this.apiUrl) return;

    // onBeginの非同期処理（run登録）が完了するのを待つ
    if (this._beginPromise) {
      await this._beginPromise;
      this._beginPromise = null;
    }
    if (!this.runId) return;

    // ステータス変換
    let caseStatus;
    if (result.status === 'skipped') {
      caseStatus = 'skipped';
      this.skipCount++;
    } else if (result.status === 'passed' && test.ok()) {
      caseStatus = 'passed';
      this.passCount++;
    } else {
      caseStatus = 'failed';
      this.failCount++;
    }

    // caseId: テストタイトルパスをスラッグ化
    const titlePath = test.titlePath().filter(Boolean);
    const caseId = titlePath.join('__')
      .replace(/[/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80);

    // エラーメッセージ（ANSIコード除去）
    let errorMessage = '';
    if (result.errors?.length > 0) {
      errorMessage = (result.errors[0].message || '')
        .replace(/\x1b\[[0-9;]*m/g, '')
        .slice(0, 500);
    }

    const caseData = {
      caseId,
      testTitle: test.title,
      suiteName: titlePath.slice(0, -1).join(' > '),
      specFile: basename(test.location?.file || ''),
      caseStatus,
      durationMs: result.duration || 0,
      errorMessage,
      startedAt: (result.startTime || new Date()).toISOString(),
    };

    // アタッチメント（動画・スクリーンショット・トレース）をS3にアップロード
    for (const att of result.attachments || []) {
      if (!att.path || !existsSync(att.path)) continue;
      const fileName = basename(att.path);
      const s3Key = `runs/${this.runId}/${caseId.slice(0, 40)}/${att.name}/${fileName}`;
      try {
        const { uploadUrl } = await this._post('/assets/upload-url', {
          key: s3Key,
          contentType: att.contentType || 'application/octet-stream',
        });
        await uploadFileToPresignedUrl(uploadUrl, att.path, att.contentType);
        if (att.name === 'video') {
          caseData.videoKey = s3Key;
        } else if (att.name === 'trace') {
          caseData.traceKey = s3Key;
        } else {
          (caseData.screenshotKeys ??= []).push(s3Key);
        }
      } catch (e) {
        // S3アップロード失敗はテスト結果登録には影響させない
      }
    }

    // DynamoDBにテストケース結果を登録
    try {
      await this._post(`/runs/${this.runId}/cases`, { cases: [caseData] });
    } catch (e) {
      // ケース登録失敗は無視（次のテストを止めない）
    }
  }

  /**
   * 全テスト完了後: ランの最終ステータス・集計を更新
   */
  async onEnd(result) {
    if (!this.apiUrl || !this.runId) return;

    const totalCount = this.passCount + this.failCount + this.skipCount;
    const durationMs = Date.now() - (this.startTime || Date.now());

    try {
      await this._put(`/runs/${this.runId}`, {
        runStatus: this.failCount > 0 ? 'failed' : 'completed',
        totalCount,
        passCount: this.passCount,
        failCount: this.failCount,
        skipCount: this.skipCount,
        durationMs,
        startedAt: new Date(this.startTime).toISOString(),
        finishedAt: new Date().toISOString(),
      });
      process.stdout.write(
        `\n[E2EViewer] ✅ 完了: PASS ${this.passCount} / FAIL ${this.failCount} / SKIP ${this.skipCount}\n`
        + `[E2EViewer] 🔗 ${VIEWER_URL}\n`
      );
    } catch (e) {
      process.stderr.write(`[E2EViewer] 完了更新失敗: ${e.message}\n`);
    }
  }
}

module.exports = E2EViewerReporter;
