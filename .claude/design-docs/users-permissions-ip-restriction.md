# 網羅フロー設計: users-permissions / IP制限 (R-139〜R-148)

**作成**: Claude + gemcli A (プロダクトコード) + gemcli B (既存テスト) 統合版
**ステータス**: 🟢 Step [3] ユーザー承認① 待ち

---

## 対象要件 10件 (全て priority:high)

| ID | 要件 | gemcli A 実装確認 |
|----|------|------------------|
| R-139 | IPアドレスで制限できる | ✅ Admin.php:433, ApiRequest.php:75 |
| R-140 | ネットワーク範囲で制限できる | ✅ IpChecker.php:44 |
| R-141 | ホワイトリスト・ブラックリスト管理 | ✅ Admin.php:458, Setting.php:431 (config.yml WHITELIST_IPS + グローバル) |
| R-142 | アクセスログを取得できる | ✅ index.php:449 (ブロック時ログ記録) |
| R-143 | 例外設定ができる | ✅ Admin.php:435 (SEC_DOMAIN バイパス) |
| R-144 | 一時的な許可ができる | ❌ **実装なし** (expires_at カラム存在せず) |
| R-145 | CIDR表記に対応される | ✅ IpChecker.php:10 (IPv4のみ、IPv6非対応) |
| R-146 | Error Case: IP検証エラー | ✅ IpChecker.php:10 (正規表現バリデーション) |
| R-147 | Error Case: ルール設定エラー | ✅ ApiRequest.php:79 |
| R-148 | Error Case: 403 Forbidden | ✅ ApiRequest.php:78 |

---

## gemcli A の重要な発見

### 実装構造（2レイヤー）
1. **グローバル制限**: `public/api/index.php` で `Setting::getAllowIpAddresses()` 呼び出し（`setting.allow_ip_addresses` カンマ区切り）
2. **管理者個別制限**: `ApiRequest::authorize()` が `$admin->isValidIp()` を呼び、`admin_allow_ips_multi` テーブル参照

### バイパス条件
- `SEC_DOMAIN` 経由アクセス → IP 制限バイパス (R-143)
- `config.yml` の `WHITELIST_IPS` 一致 → 常時許可 (R-141)
- `admin_allow_ips_multi` 空 → 全許可

### 仕様制約（テスト設計への影響）
- **IPv4 のみ対応、IPv6 非対応** → IPv6 テストは「非対応エラーが出ることを確認」
- **一時的な許可 (R-144) 実装なし** → テスト不可 / ユーザー判断要
- バリデーション正規表現: `/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/`

### B002 根本原因確定
- `NetCommon::isPrivateIp()` L210 で `FILTER_FLAG_NO_PRIV_RANGE` 指定
- 結果: プライベート IP (10/8, 172.16/12, 192.168/16) が `filter_var` で除外 → `getIp()` が null 返却

---

## gemcli B の重要な指摘

### 初期設計案で抜けていた 3 点（要強化）
1. **R-142 ログ出力**: /admin/logs 画面でブロック記録検証が抜け
2. **R-143 管理者例外**: master/SEC_DOMAIN の例外挙動検証が抜け
3. **R-148 HTTP Status**: `page.request.post()` による 403 厳密検証が抜け

### B002 再現精度の指摘
- 現状 10.0.0.1/32 ハードコード → 実行環境依存
- 接続元IP 動的取得してセットする方式に変更すべき

### 既存テスト資産（上書きせず活用すべき）
- up-ip-010 (OR条件), up-ip-020 (不正フォーマット), up-ip-030 (/32境界), up-b002 (基本疎通) は既存
- up-ip-040〜044 / up-1120〜up-1160 に整合

---

## 🎯 統合設計: ケース一覧

### 方針
- **動的IP取得**: beforeAll で `https://api.ipify.org?format=json` 呼び出し、`currentIp` 変数に保存
- **テスト順序**: 独立実行前提 (各テストは前後の状態に依存しない)
- **既存テスト**: up-ip-010〜044 は保持、新規ケースは up-ip-050〜 で追加

### ケース表

| 要件 | ケースID | 区分 | フロー | 期待結果 | 判断 |
|------|---------|------|------|---------|------|
| R-139 | up-ip-040 | 正常系 | 許可IP=0.0.0.0/0 → testUser ログイン | ✅ 成功 | 既存保持 |
| R-139 | up-ip-041 | 異常系 | 許可IP=`currentIp` と異なるIP /32 → ログイン試行 | ✅ 拒否、URL=/login | **動的IP化改修** |
| R-139 | up-ip-044 | B002再現 | 許可IP=`currentIp`/32 (動的取得) → ログイン試行 | ✅ 成功 (B002未修正なら fail) | **動的IP化改修** |
| R-140 | up-ip-050 | CIDR /24 | 許可IP=`currentIp` の /24 → ログイン | ✅ 成功 | 新規 |
| R-140 | up-ip-060 | CIDR 外 | 許可IP=`currentIp` と異なる /24 → ログイン | ✅ 拒否 | 新規 |
| R-140 | up-ip-030 | /32 厳密 | 既存 | 既存 | 既存保持 |
| R-141 | up-ip-010 | OR条件 | 既存 (複数IP OR マッチ) | 既存 | 既存保持 |
| R-141 | up-ip-042 | 削除で全許可 | 既存 | 既存 | 既存保持 |
| R-141 | up-ip-070 | 並び替え | 3IP設定 → ドラッグ並び替え → 保存確認 | ✅ 順序変更保存 | 新規 |
| R-142 | up-ip-080 | 拒否ログ | 許可外IPで拒否 → /admin/logs 確認 | ✅ ブロック記録あり | 新規 |
| R-142 | up-ip-090 | 成功ログ | 許可IPで成功 → /admin/logs 確認 | ✅ ログイン成功記録あり | 新規 |
| R-143 | up-ip-100 | master も対象 | 管理者自身に厳格IP設定 → master 再ログイン | ✅ master も拒否される (対象外扱いではない) | 新規 (仕様: 対象と確定) |
| R-143 | up-ip-110 | SEC_DOMAIN | E2E 検証不可 → **スキップ** | — | **test-env-limitations.md 記録済** |
| R-144 | — | 一時許可 | プロダクト未実装 → **スキップ** | — | **test-env-limitations.md 記録済** |
| R-145 | up-ip-030 | /32 境界 | 既存 | 既存 | 既存保持 |
| R-145 | up-ip-120 | /31 ペア | /31 で 2IP マッチ確認 | ✅ 2つの連続IPが許可される | 新規 |
| R-145 | up-ip-130 | /16, /8 | /16, /8 レンジ検証 | ✅ 各レンジで制限動作 | 新規 |
| R-146 | up-ip-020 | 不正フォーマット (192.168.1.300) | 既存 | 既存 | 既存保持 |
| R-146 | up-ip-043 | 999.999.999.999 | 既存 | 既存 | 既存保持 |
| R-146 | up-ip-140 | IPv6 (::1) | IPv6 入力 → バリデーションエラー (IPv4のみ対応) | ✅ エラー表示 | 新規 |
| R-146 | up-ip-150 | 空文字＋スペース | "  " で更新 → エラー or trim 保存 | ✅ 挙動確認 | 新規 |
| R-147 | up-ip-160 | 同一IP重複 | 同じIPを2行入力 → 保存 | ✅ エラー or 重複排除 | 新規 |
| R-148 | up-ip-170 | 403 API直接 | 許可外IPで `page.request.post('/api/admin/...')` | ✅ status=403 | 新規 (gemcli B 提案) |

### 合計: **22 ケース** (既存11 + 新規11)
※ ユーザー判断で up-ip-110 (SEC_DOMAIN) と R-144 (一時許可) をスキップに変更、up-ip-100 を「master も対象」の正検証に変更

---

## ✅ ユーザー判断結果（2026-04-19）

1. **master 管理者は IP 制限対象** (バイパス機能なし)
   - → R-143 の「master 例外」テスト (up-ip-100) は**削除**
   - → 代わりに「master も一般ユーザー同様 IP 制限を受けること」を確認する正の検証に変更

2. **R-143 SEC_DOMAIN バイパス (up-ip-110)**: E2E 検証不可 → スキップ
   - `.claude/test-env-limitations.md` に記録済み
   - 解消条件: pigeon_cloud に debug API 追加 or X-Forwarded-Host 検証機構

3. **R-144 一時的な許可**: プロダクト未実装 → スキップ
   - `.claude/test-env-limitations.md` に記録済み
   - 別途機能追加チケットで対応

4. **動的IP取得**: **テストコード側で** VPN の現在IPを取得する方針確定
   - 環境変数 `CURRENT_IP` 優先 → api.ipify.org → 失敗時は fail (skip 禁止)

---

## 🔵 gemcli B から追加で取り込んだ観点（既に統合済み）

- ✅ R-142 ログ出力 (up-ip-080, 090)
- ✅ R-143 master 例外 (up-ip-100)
- ✅ R-148 HTTP Status 厳密検証 (up-ip-170)
- ✅ B002 動的IP化 (up-ip-041, 044)

---

## ✅ Step [3] ユーザー承認① 済（2026-04-19）

承認内容:
- ケース総数 **22件** (既存11 + 新規11) で網羅
- R-143 SEC_DOMAIN: スキップ → `test-env-limitations.md` 記録済
- R-144 一時許可: スキップ → `test-env-limitations.md` 記録済
- 動的IP: `CURRENT_IP` env → api.ipify.org → fail
- 既存 up-ip-040〜044 を動的IP化改修
- master 管理者は IP 制限対象 (例外扱いではない)

次: Step [4] 実機確認 → Step [5] 実装
