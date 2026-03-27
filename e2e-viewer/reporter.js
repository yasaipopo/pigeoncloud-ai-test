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
const https = require('https');
const http = require('http');

const TOKEN_SALT = 'pigeon-e2e-viewer-salt-2026';
const VIEWER_URL = 'https://dezmzppc07xat.cloudfront.net';

function generateToken(password) {
  return createHash('sha256').update(password + TOKEN_SALT).digest('hex');
}

async function uploadFileToPresignedUrl(presignedUrl, filePath, contentType) {
  const data = readFileSync(filePath);
  process.stdout.write(`[E2EViewer] S3 PUT start: size=${data.length}\n`);
  return new Promise((resolve, reject) => {
    const url = new URL(presignedUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': data.length,
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        process.stdout.write(`[E2EViewer] S3 PUT done: status=${res.statusCode}\n`);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`S3 PUT ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('S3 PUT timeout'));
    });
    req.write(data);
    req.end();
  });
}

/**
 * result.steps からexpect/test.stepカテゴリのステップを再帰収集
 * @param {Array} steps
 * @param {Array} acc
 * @returns {{ title: string, ok: boolean, category: string }[]}
 */
function collectSteps(steps, acc = []) {
  for (const step of steps || []) {
    if (step.category === 'test.step') {
      acc.push({ title: `▶ ${step.title}`, ok: !step.error, category: 'step' });
      collectSteps(step.steps, acc);
    } else if (step.category === 'expect') {
      acc.push({ title: step.title, ok: !step.error, category: 'expect' });
    } else {
      collectSteps(step.steps, acc);
    }
  }
  return acc;
}

class E2EViewerReporter {
  constructor(options = {}) {
    this.apiUrl = (options.apiUrl || process.env.E2E_API_URL || '').replace(/\/$/, '');
    const password = options.password || process.env.E2E_API_PASSWORD || 'pigeon-e2e-2026';
    this.token = options.token || process.env.E2E_API_TOKEN || generateToken(password);
    this.agentNum = parseInt(options.agentNum || process.env.AGENT_NUM || '1');
    this.testEnvUrl = options.testEnvUrl || process.env.TEST_BASE_URL || '';

    this.sessionId = options.sessionId || process.env.TEST_NUMBER || '1';
    this.runId = null;
    this.passCount = 0;
    this.failCount = 0;
    this.skipCount = 0;
    this.startTime = null;
    this._beginPromise = null;  // onBeginの非同期処理を追跡
    this._caseQueue = [];       // {caseData, uploadPromises[]} キュー（onEndで一括DynamoDB登録）
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

  async _patch(path, body) {
    const resp = await fetch(`${this.apiUrl}${path}`, {
      method: 'PATCH',
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

    // runId: エージェント番号固定（毎回同じIDで上書き）
    // ユーザーが明示的に別runを指定した場合のみ変更する
    this.runId = `agent${this.agentNum}`;

    // specファイル一覧: ルート→プロジェクト(chromium)→ファイル の2段階降りる
    const specFiles = [...new Set(
      (suite.suites || [])
        .flatMap(projectSuite => projectSuite.suites || [])
        .map(fileSuite => basename(fileSuite.title || ''))
        .filter(Boolean)
    )];
    this.specFile = specFiles.join(',');

    // テスト総数をカウント（リアルタイム進捗バーのETA計算に使用）
    // allTests() はPlaywright公開APIで全テストを返す
    const expectedTotal = suite.allTests ? suite.allTests().length : 0;

    this._beginPromise = this._post('/runs', {
      runId: this.runId,
      sessionId: this.sessionId,
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
      process.stdout.write(`[E2EViewer] 実行登録失敗: ${e.message}\n`);
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
      steps: collectSteps(result.steps).slice(0, 60),
    };

    // ① リアルタイム進捗: S3キーなしで即時DynamoDB登録（カウント加算）
    try {
      await this._post(`/runs/${this.runId}/cases`, { cases: [caseData] });
    } catch (e) {
      // 無視
    }

    // ② S3アップロード: アップロード完了次第リアルタイムでDynamoDBをPATCH
    const uploadPromises = (result.attachments || [])
      .filter(att => att.path && existsSync(att.path))
      .map(att => {
        const fileName = basename(att.path);
        const s3Key = `runs/${this.runId}/${caseId.slice(0, 40)}/${att.name}/${fileName}`;
        return this._post('/assets/upload-url', {
          key: s3Key,
          contentType: att.contentType || 'application/octet-stream',
        }).then(({ uploadUrl }) => uploadFileToPresignedUrl(uploadUrl, att.path, att.contentType)
        ).then(() => {
          if (att.name === 'video') {
            caseData.videoKey = s3Key;
          } else if (att.name === 'trace') {
            caseData.traceKey = s3Key;
          } else {
            (caseData.screenshotKeys ??= []).push(s3Key);
          }
          // アップロード完了後すぐにDynamoDBをPATCH（リアルタイム反映）
          const patch = {};
          if (caseData.videoKey) patch.videoKey = caseData.videoKey;
          if (caseData.screenshotKeys?.length) patch.screenshotKeys = caseData.screenshotKeys;
          if (caseData.traceKey) patch.traceKey = caseData.traceKey;
          if (Object.keys(patch).length > 0) {
            return this._patch(
              `/runs/${this.runId}/cases/${encodeURIComponent(caseData.caseId)}`,
              patch
            ).catch(e => {
              process.stdout.write(`[E2EViewer] realtime patch失敗 (${att.name}): ${e.message}\n`);
            });
          }
        }).catch(e => {
          process.stdout.write(`[E2EViewer] upload failed (${att.name}): ${e.message}\n`);
        });
      });

    this._caseQueue.push({ caseData, uploadPromises });
  }

  /**
   * 全テスト完了後: S3アップロード完了待ち → ケースのS3キーを更新 → ランの最終ステータスを更新
   */
  async onEnd(result) {
    if (!this.apiUrl || !this.runId) return;

    // ① キューに積まれたS3アップロードをすべて完了させてからDynamoDBを更新
    process.stdout.write(`[E2EViewer] S3アップロード待機中 (${this._caseQueue.length}件)...\n`);
    for (const { caseData, uploadPromises } of this._caseQueue) {
      await Promise.all(uploadPromises);
      // S3キーがあればDynamoDBをPATCH
      const patch = {};
      if (caseData.videoKey) patch.videoKey = caseData.videoKey;
      if (caseData.screenshotKeys?.length) patch.screenshotKeys = caseData.screenshotKeys;
      if (caseData.traceKey) patch.traceKey = caseData.traceKey;
      if (Object.keys(patch).length > 0) {
        await this._patch(
          `/runs/${this.runId}/cases/${encodeURIComponent(caseData.caseId)}`,
          patch
        ).catch(e => {
          process.stdout.write(`[E2EViewer] case patch失敗 (${caseData.caseId}): ${e.message}\n`);
        });
      }
    }

    // ② ランの最終ステータスを更新
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
      process.stdout.write(`[E2EViewer] 完了更新失敗: ${e.message}\n`);
    }
  }
}

module.exports = E2EViewerReporter;
