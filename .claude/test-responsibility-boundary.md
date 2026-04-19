# テスト責務分離ポリシー (E2E vs PHPUnit / Integration)

**目的**: 同じロジックを複数レイヤーで重複テストしない。メンテナンスコスト削減 + カバレッジの透明性。

**基本方針**:
- **PHPUnit (Unit)**: 純粋ロジック、境界値、バリデーション関数、エンティティ単体
- **PHPUnit (Integration)**: 複数クラス連携、DB ラウンドトリップ、サービス層
- **E2E (Playwright)**: UI 入力 → 保存 → 表示のラウンドトリップ、ログインフロー、画面遷移、UI エラー表示、統合シナリオ

---

## 機能別: テストレベル区分表

### IP制限 (R-139〜R-148)

| シナリオ | PHPUnit | E2E | 備考 |
|---------|---------|-----|------|
| CIDR 判定 (/32, /24, /16, /8, /0) | ✅ `IpCheckerTest::testIsCheckCurrentIpIsValid` | ❌ 不要 | 重複 |
| 単一 IP 許可/拒否ロジック | ✅ `IpCheckerTest` | △ 代表1件のみ | 統合検証 |
| **OR 条件 (複数IP)** | ✅ `IpCheckerTest` L73 | ✅ 必須 (UI→ログイン統合) | 1マッチ/全ミスを E2E で |
| IP 形式バリデーション (256.x, /33) | ✅ `IpCheckerTest::testIsValidIp` | △ UI エラー表示確認のみ | 重複しない |
| プライベートIP判定 | ✅ `NetCommonTest::testIsPrivateIp` | ❌ 不要 | RFC1918 全部カバー済み |
| VPN IP ホワイトリスト | ✅ `NetCommonTest::testIsVpnIpAddr` | ❌ 不要 | |
| UI 複数行追加/削除/並び替え | ❌ | ✅ 必須 | UI固有 |
| UI 入力→DB 保存ラウンドトリップ | ❌ | ✅ 必須 | UI固有 |
| /admin/logs での記録確認 | ❌ | ✅ 必須 | UI固有 |
| ログイン拒否画面フロー | ❌ | ✅ 必須 | フロー |
| master 管理者も制限対象 | △ Admin::isValidIp は未テスト | ✅ 必須 | 統合 |
| SEC_DOMAIN バイパス | ❌ 未実装 | ❌ インフラ依存 skip | test-env-limitations |
| `NetCommon::getIp()` ヘッダー解析 | △ markTestSkipped 状態 | ❌ 不要 | 先に PHPUnit 強化推奨 |

**E2E spec #1 users-permissions 再設計**:

Keep (UI 統合検証):
- up-ip-040 (0.0.0.0/0 全許可)
- up-ip-041 (1.1.1.1/32 拒否)
- up-ip-042 (削除で全許可)
- up-ip-043 (UI バリデーションエラー表示)
- up-ip-044 (現在IP/32)
- up-ip-050 (/24 レンジ代表1件)
- up-ip-070 (UI 複数IP保存)
- up-ip-080/090 (ログ画面)
- up-ip-100 (master も対象)
- up-ip-150 (スペース UI 挙動)
- up-ip-160 (重複保存 UI 挙動)
- up-ip-170 (API 拒否)

**削除 (PHPUnit で十分)**:
- ~~up-ip-060 (/24 外)~~ → up-ip-041 と論理同じ、CIDR は PHPUnit で網羅
- ~~up-ip-120 (/31 ペア)~~ → PHPUnit `IpCheckerTest` で境界値網羅
- ~~up-ip-130 (/16 /8)~~ → PHPUnit で網羅

**追加 (OR 条件 UI 統合)**:
- up-ip-200: 2 IPs (現在IP + ダミー) → UI 保存 → 現在IPマッチでログイン成功
- up-ip-210: 2 IPs (ダミー1 + ダミー2) → UI 保存 → 全ミスでログイン拒否

---

### 認証 (R-103〜R-126)

| シナリオ | PHPUnit | E2E | 備考 |
|---------|---------|-----|------|
| Admin エンティティ単体 | △ `AdminPasswordExpirationTest` 部分 | △ | |
| 2FA TOTP 生成/検証 | △ 要 PHPUnit | ✅ 必須 (UI統合) | |
| SAML 認証フロー | △ | ❌ IdP 依存 skip | test-env-limitations |
| SSO リダイレクト | △ | ❌ 外部依存 skip | |
| クライアント証明書 | △ | ❌ ALB 依存 skip | |
| アカウントロック 20 回 | △ | ✅ 必須 | |
| パスワードポリシー | △ | ✅ 必須 (UI バリデーション) | |

（TODO: 他の feature area も随時追記）

---

## 追加調査 (gemcli 2026-04-19 / 2026-04-20)

### PHPUnit に存在
- `IpCheckerTest.php`: IPv4 のみ、IPv6 非対応
- `NetCommonTest.php`: `testGetIp` は markTestSkipped 状態 (モック化が必要)

### PHPUnit に **追加推奨** (プロダクト側で対応すべき)
- `Admin::isValidIp()` のテスト (システム+個別ホワイトリスト組み合わせ)
- `NetCommon::getIp()` のヘッダー解析テスト (モック化)

---

## ルール: 新規 E2E テスト追加時のチェック

Step [2] 網羅フロー設計の際に必ず確認:

1. ✅ 該当機能の PHPUnit テストを grep (Unit + Integration)
2. ✅ `tests/test_coverage.md` (pigeon_cloud 側) を参照
3. ✅ PHPUnit でロジック検証済みのケースを E2E で **重複させない**
4. ✅ E2E 追加分は「UI 統合」「ラウンドトリップ」「統合シナリオ」のいずれかに該当するか確認
5. ✅ 設計書に各ケースのテストレベル (L1/L2/L3/L0) を明記
