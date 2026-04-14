# E2Eテスト完了までのロードマップ

最終更新: 2026-04-07

## ゴール
テスターが sheet.html で動画を再生し、detailedFlow に沿って目視確認し、testerCheck を ✅ にする。

---

## 現状 (2026-04-07)

- **549 pass / 74 fail = 88%** (31 spec 実行済み)
- sheet.html: https://dezmzppc07xat.cloudfront.net/sheet.html
- staging 列: sync 済み（567件 pass 反映）
- 採番: 全 yaml を新番号（spec-010〜）に変更済み

---

## 残タスク（優先度順）

### 1. 動画パスの統一 【高・必須】

**問題**: テスト実行で動画は `runs/{runId}/{caseId}/video/video.webm` に保存されるが、
sheet.html の `playVideo()` は `videos/{spec}/{movie}/video.webm` を参照する。

**対策**（いずれか）:
- A. `playVideo()` を `runs/` パスにも対応させる（フロントエンド修正）
- B. `upload_results.py` で `videos/{spec}/{movie}/video.webm` にもコピーする
- C. テスト実行後に S3 上で `runs/` → `videos/` にコピーするスクリプトを作る

→ **Aが最もシンプル**。各runのcases テーブルから videoKey を取得して再生。

### 2. 旧 caseNo のクリーンアップ 【高】

**問題**: pipeline テーブルに旧番号（`1-1`, `144-01`等）と新番号（`auth-010`等）が共存。
auth は手動削除済みだが、他 spec は旧番号が残っている。

**対策**: 全 spec の旧番号を `/pipeline/cleanup` で削除。
```bash
# 全yamlを読んで validKeys を構築し cleanup を呼ぶスクリプト
E2E_API_URL=... python3 e2e-viewer/upload_yaml_specs.py  # 新番号を登録
# → その後 cleanup で旧番号を削除（validKeys = 全新番号）
```

### 3. detailedFlow 整備 【高・テスターチェック前に必須】

**問題**: auth.yaml のみ movie 単位で丁寧な detailedFlow を書いた。他 spec は自動変換のまま。

**対策**: 各 spec の yaml で movie ごとに：
- 先頭ケースに「この動画で確認するテスト番号」一覧 + タイムスタンプ付き実行フロー
- 他ケースは「参照」テキスト
- auth.yaml のフォーマットを参考に

**優先 spec**（テスト数が多い順）:
1. records (23 pass)
2. display-settings (149 pass)
3. field-datetime (120 pass)
4. content-dashboard (52 pass)

### 4. 残り 74 fail の修正 【中】

**修正不可（URL無効/D:INFRA）~20件**:
- notifications: `/admin/step_mail` (10件) → ソースコードで正しいURL確認
- mail-delivery: メール配信テーブル未設定 (3件) → createTestEnv拡張
- payment: Stripe/createTestEnv未移行 (3件)
- users-permissions: `/admin/organization` (2件) → ソースコードで確認
- system-settings: admin_setting (2件)

**要ソースコード確認 ~30件**:
- table-definition: アーカイブ/自動採番 (13件)
- field-image-file: フィールド設定モーダル (7件)
- field-datetime: パディング/フィールド追加 (8件)

**個別セレクター修正 ~24件**:
- data-operations, content-dashboard, layout-ui, notifications 等

### 5. 全 spec 再実行 + 動画再撮影 【中】

修正完了後、全 spec を再実行して最新の動画を撮影。
sheet.html にアップロード + sync-results 実行。

### 6. テスターチェック開始 【ゴール】

sheet.html で：
1. spec タブを選択
2. movie ごとに動画再生
3. 右パネルの detailedFlow と動画を照合
4. 問題なければ testerCheck を ✅ にクリック

---

## 重要な技術的知見

### sync-results の caseNo マッチング
- テストタイトル `AT01: 認証基本フロー` → `AT01` を抽出
- pipeline テーブルの `movie` フィールドでマッチ → 該当 movie の全 caseNo を更新
- Lambda に実装済み（2026-04-07）

### 無効な Angular ルート
以下のURLは「テーブルが見つかりません」になる:
- `/admin/dataset__N/setting/*` → 正: `/admin/dataset/edit/N`
- `/admin/user` → 正: `/admin/admin`
- `/admin/organization` → 現在のUIに存在しない
- `/admin/step_mail` → 現在のUIに存在しない
- `/admin/webhook` → 現在のUIに存在しない
- `/admin/admin_setting/edit/1` → `/admin/admin_setting` からリダイレクトさせて動的ID取得

### beforeEach の正しいパターン
```javascript
test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
    if (!page.url().includes('/login')) {
        await page.goto(BASE_URL + '/admin/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
    if (page.url().includes('/login')) {
        await page.fill('#id', EMAIL, { timeout: 15000 }).catch(() => {});
        await page.fill('#password', PASSWORD, { timeout: 15000 }).catch(() => {});
        await page.locator('button[type=submit].btn-primary').first().click({ timeout: 15000 }).catch(() => {});
        await page.waitForSelector('.navbar', { timeout: 15000 }).catch(() => {});
    }
    await waitForAngular(page);
    await page.waitForSelector('.sidebar-nav a, .nav-link', { timeout: 10000 }).catch(() => {});
    await closeTemplateModal(page);
});
```

### 採番スクリプト
```bash
# yaml の新採番 + detailedFlow 整理
python3 e2e-viewer/rewrite_yaml_numbering.py

# yaml → pipeline DB 同期
E2E_API_URL=... python3 e2e-viewer/upload_yaml_specs.py

# テスト結果アップロード
python3 e2e-viewer/upload_results.py --reports-dir reports/agent-N --api-url $E2E_API_URL --agent-num N
```
