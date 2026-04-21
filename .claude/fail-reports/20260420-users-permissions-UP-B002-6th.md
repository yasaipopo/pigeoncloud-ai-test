# Fail 分析レポート: users-permissions / UP-B002 6 回目

- **作成**: 2026-04-20
- **spec**: users-permissions (IP 制限 R-139〜R-148)
- **runId**: `20260419_185638_48e662d_agent99`
- **結果**: 14 pass / 7 fail / 0 skip
- **レビュー URL**: https://dezmzppc07xat.cloudfront.net/sheet.html?spec=users-permissions&review=pending&reviewLabel=UP-B002-6th-14pass-7fail
- **分類記号**: 🔴 PRODUCT / 🟡 SPEC / 🟠 ENV / ⚪ UNKNOWN

---

## 🔴 1. up-b002: プライベートIP環境でIP制限が誤作動

- **症状**: `NetCommon::getIp()` がプライベート IP を除外して null を返すため、IP 制限が常に拒否する
- **該当プロダクトコード**: `/Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/Application/NetCommon.php`
  - L210 付近: `filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE)`
  - `FILTER_FLAG_NO_PRIV_RANGE` を外すか、プライベート IP を別関数で許容する必要あり
- **影響**: VPN / 社内 LAN 環境での IP 制限運用が不可能
- **既記載**: `.claude/product-bugs.md` → `bug-b002`
- **対応方針**: プロダクト側で tmprepo 経由 PR (NetCommon::getIp の flag 除去 or プライベート IP 許容モード追加)

---

## 🔴 2. up-ip-043: 不正フォーマット 999.999.999.999 でバリデーション走らず

- **症状**: 3 桁数字ならオクテット値が範囲外 (0-255) でもバリデーション通過
- **該当プロダクトコード**: `/Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/Application/IpChecker.php`
  - L10: 正規表現 `/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/`
  - 各オクテット `\d{1,3}` は `999` も通してしまう。`(25[0-5]|2[0-4]\d|1\d\d|\d{1,2})` のような範囲チェックが必要
- **既記載**: `.claude/product-bugs.md` → `up-ip-043`
- **対応方針**: プロダクト側で正規表現修正 or filter_var(FILTER_VALIDATE_IP) 併用

---

## 🟡 3. up-ip-070: 複数IP保存 → 再読込で順序保持（spec バグ）

- **症状**: 保存後リロードした画面で IP 表示が検出できず (`sectionText = "アクセス許可IP（設定しない場合全て）"` のラベルのみ)
- **原因**: **テスト側の bug**。`page.locator('[class*="wrap-field-allow_ips"]').innerText()` は `<input>` の `value` を拾わない (innerText は表示テキストのみ)
- **該当テストコード**: `tests/users-permissions.spec.js` L5370-5373
  ```js
  const sectionText = await page.locator('[class*="wrap-field-allow_ips"]').innerText();
  const hasCurrentIp = sectionText.includes(currentIp) || sectionText.includes(ipA);
  ```
- **修正方針**: input value を直接読む
  ```js
  const inputs = page.locator('[class*="wrap-field-allow_ips"] input');
  const values = await inputs.evaluateAll(els => els.map(e => e.value));
  const hasCurrentIp = values.some(v => v.includes(currentIp));
  ```
- **プロダクトは正常**: 他の up-ip-050/060 等で保存後ログイン成功しているため保存機能は OK

---

## 🔴 4. up-ip-150: スペース文字単独 "   " で ISE

- **症状**: スペースのみ入力して保存後、ページに "500" が含まれる (Internal Server Error)
- **該当プロダクトコード**: 要調査だが、次のいずれかの可能性
  - `IpChecker.php` の正規表現: 空文字・スペースを想定外の入力として扱う際に例外 → 500
  - `Admin.php` / `Setting::getAllowIpAddresses()`: trim 未実施でカンマ区切り parse 時に空要素が array に入る → array 操作で例外
  - DB INSERT: NOT NULL 制約違反等
- **再現**: staging 環境で半角スペース 3 つをアクセス許可IPに入れて更新 → その testUser で画面遷移 → 500 ページ
- **既記載**: `.claude/product-bugs.md` → `up-ip-150` (2026-04-20 追記済)
- **対応方針**: 入力値の trim + 空文字バリデーション追加

---

## 🔴 5. up-ip-160: 同一IP 2行登録で全消失

- **症状**: 同じ IP (5.5.5.5/32) を 2 行に入力 → 保存 → 再読込で 0 件
- **該当プロダクトコード**: `admin_allow_ips_multi` テーブルへの upsert ロジック (Admin.php 保存ハンドラ付近)
  - 重複検出時に `delete existing + insert new` の順序で失敗した可能性
  - UNIQUE 制約違反 → 全トランザクション rollback → 結果 0 件
- **既記載**: `.claude/product-bugs.md` → `up-ip-160`
- **対応方針**: 重複入力を保存前にフロントでバリデーション、または upsert で INSERT IGNORE / ON DUPLICATE KEY UPDATE に変更

---

## 🔴 6. up-ip-170: 許可外IP下で API が 200 を返す

- **症状**: testUser に 1.1.1.1/32 を設定 → testUser ログイン失敗 (/admin/login 残留、拒否は正常) → その後 `GET /api/admin/admin/me` が 200 OK
- **該当プロダクトコード**:
  - `/Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/Application/ApiRequest.php` L75-78
  - `authorize()` 内の `$admin->isValidIp()` チェックがユーザー限定で、`admin/me` エンドポイントに別経路で到達している疑い
  - または master admin のセッションが残っていて IP チェックをバイパス
- **既記載**: `.claude/product-bugs.md` → `up-ip-170`
- **対応方針**: `/api/admin/admin/me` でも IP 制限を発動させる。または testUser セッションから直接叩いた時だけ 401 返すよう修正

---

## 🔴 7. up-ip-230: 不正マスク /33 でバリデーション欠落

- **症状**: CIDR マスク `/33` (IPv4 無効範囲) を入力して保存ボタン押下もエラー表示が一切出ない
- **該当プロダクトコード**: `IpChecker.php` L10
  - 正規表現 `/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/`
  - `\d{1,2}` は `/33` から `/99` まで通してしまう。`(\/([0-9]|[1-2][0-9]|3[0-2]))?` のように 0-32 に制限すべき
- **既記載**: `.claude/product-bugs.md` → `up-ip-230` (2026-04-20 追記済)
- **対応方針**: 正規表現を 0-32 限定に修正

---

## 📊 集計

| 分類 | 件数 | ケース |
|---|---|---|
| 🔴 PRODUCT | 6 | up-b002, up-ip-043, up-ip-150, up-ip-160, up-ip-170, up-ip-230 |
| 🟡 SPEC | 1 | up-ip-070 |
| 🟠 ENV | 0 | — |
| ⚪ UNKNOWN | 0 | — |

## 🎯 次アクション

### 即時（このセッション内）
- [x] product-bugs.md に up-ip-150, up-ip-230 追記済
- [ ] up-ip-070 spec bug 修正 (innerText → inputs value) ← ユーザー判断

### 次セッション以降
- [ ] プロダクト側 PR (tmprepo PopoframeworkSlim):
  - bug-b002: NetCommon::getIp の FILTER_FLAG_NO_PRIV_RANGE 除去
  - up-ip-043, up-ip-230: IpChecker 正規表現をオクテット範囲・CIDR 0-32 制限に修正
  - up-ip-150: 入力値 trim + 空文字バリデーション
  - up-ip-160: upsert ロジック修正
  - up-ip-170: API レイヤー IP チェック追加
