# 網羅フロー設計: user-security.spec.js (R-127〜R-138, 12要件)

**作成**: Claude + gemcli A (プロダクトコード) + gemcli B (既存テスト)
**ステータス**: 🟢 Step [3] ユーザー承認① 待ち

---

## 対象要件 12 件
- **priority:high**: R-131 (クライアント認証), R-135 (認証エラー) の 2 件
- **priority:low**: R-127, 128, 129, 130, 132, 133, 134, 136, 137, 138 の 10 件

## gemcli A: プロダクトコード調査結果

### 実装ファイル
| 層 | ファイル | 行 | 役割 |
|----|---------|----|------|
| Service | `CertificateService.php` | 107, 332, 431, 248, 452 | 発行/検証/失効/エラー |
| Controller | `AdminController.php` | 45, 350, 465, 483 | UI endpoint (発行/ダウンロード/上限チェック) |
| Routes (Login) | `routes/login/admin/login.php` | - | ログイン時 X-Amzn-Mtls-Clientcert 検証 |
| Routes (Admin) | `routes/admin/admin.php` | 1165, 1185 | 管理画面アクセス時のmTLS検証、401 応答 |
| Angular | `certificate-management.component.ts` | - | 管理UI (一覧/発行/失効) |
| Angular (Error) | `maintenance/cert.component.ts` | - | エラーランディング |

### 要件別実装状況
| ID | 実装 | テスト可能性 |
|----|------|-------------|
| R-127 生成 | AWS Lambda (cert-generator) 連携 | △ (AWS依存) |
| R-128 検証 | openssl_x509_parse + user_certificate テーブル | ○ |
| R-129 失効 | user_certificate.revoked = true | ○ |
| R-130 ライフサイクル | AdminController:483 | ○ |
| **R-131 認証** | ALB mTLS → X-Amzn-Mtls-Clientcert 検証 | △ (ALB依存) |
| R-132 更新 | 新規発行で代替（更新ボタンなし） | ○ |
| R-133 インポート/エクスポート | certificate_package.zip で DL | ○ |
| R-134 生成エラー | Lambda 失敗時の例外 | ○ |
| **R-135 認証エラー** | 401 + error_type='client_cert_invalid' | △ (ALB依存) |
| R-136 失効エラー | DB更新失敗時の処理 | ○ |
| R-137 更新エラー | R-134 と共通 | ○ |
| R-138 設定エラー | 1人3枚上限 / 非master 操作拒否 | ○ |

---

## gemcli B: 既存テスト資産 + 指摘

### 既存テスト 3 件 (タグ無し)
| ファイル | 行 | ケース | 対応要件 | 品質 |
|---------|----|-------|---------|------|
| user-security.spec.js | 432 | us-cert-010 発行UI確認 | R-127 | UI疎通のみ |
| user-security.spec.js | 448 | us-cert-020 失効操作 | R-129 | 状態変化確認 |
| system-settings.spec.js | 1740 | 840-1 証明書管理ページ | R-127/128 | 文言存在確認 |

### 指摘 (設計案 10 件の判定)
| ケース | 判定 |
|-------|------|
| us-cert-010 発行UI | 既存重複 → 強化+タグ付与 |
| us-cert-020 一覧表示 | 既存重複 → 強化 |
| us-cert-030 失効 | 既存重複 → 強化 |
| us-cert-040 更新UI | 新規 (プロダクトに更新ボタンは無いため「新規発行での更新」確認) |
| us-cert-050 インポート | 新規 |
| us-cert-060 エクスポート | 新規 (certificate_package.zip DL確認) |
| us-cert-070 証明書なしで拒否 | 条件付可 (ALB→403 確認のみ) |
| us-cert-080 設定エラー | 新規 (上限超過等) |
| us-cert-090 失効済証明書でアクセス | **実装不可** (Playwright で動的証明書切替不可) |
| us-cert-100 生成エラー | 新規 |

---

## 🎯 統合設計

### 方針
1. **既存 3 テストにタグ付与 + assertion 強化**
2. **新規 5 ケース追加** (更新/インポート/エクスポート/設定エラー/生成エラー)
3. **R-131 実走・R-135 ALB依存・失効済みアクセス は test-env-limitations.md 記録**
4. **スキップ部分は UI 確認で代替**

### ケース表 (合計 11 件)

#### ✅ 既存強化 + タグ付与 (3件)
| 行 | ケース | タグ | 強化内容 |
|----|-------|-----|---------|
| 432 | us-cert-010 発行UI | R-127/130/133 | 「発行」「ダウンロード」ボタン表示確認を明示 |
| 448 | us-cert-020 失効操作 | R-129/136 | ステータス変化確認を具体化 |
| system-settings.spec.js:1740 | 840-1 | R-127/128 | ページ表示 + 一覧要素確認を明示 |

#### 🆕 新規 (5件)
| ケース | 要件 | 内容 |
|-------|------|------|
| us-cert-040 更新シナリオ | R-132/137 | 既存証明書失効後に新規発行 (=更新) の流れ |
| us-cert-050 インポート UI | R-133 | 証明書アップロード入力欄の存在確認 (実ファイルアップ不要、UI 疎通) |
| us-cert-060 エクスポート (DL) | R-133 | 発行後に certificate_package.zip のダウンロード動作確認 |
| us-cert-080 設定エラー (上限) | R-138 | 1 ユーザー 4 枚目発行で上限エラー表示 |
| us-cert-100 生成エラー処理 | R-134 | Lambda 失敗時の UI エラー表示（モック or エラーシナリオで）|

#### ❌ スキップ (test-env-limitations.md)
| ケース | 要件 | 理由 |
|-------|------|-----|
| us-cert-070 (UI 簡易は実装するが実走は skip) | R-131/135 | ALB mTLS 依存 (既に R-117 で記録済み) |
| us-cert-090 失効済証明書でアクセス | R-136 実走 | Playwright で動的証明書切替不可 |

---

## ✅ Step [3] ユーザー承認① 事項

1. [ ] 合計 **8 ケース** (既存強化 3 + 新規 5) の設計 OK か
2. [ ] us-cert-070 / us-cert-090 のスキップ OK か (R-117 と共通の ALB mTLS 依存)
3. [ ] us-cert-100 生成エラーは「Lambda 失敗シナリオを意図的に作る」のは困難なので、**UI エラーメッセージ表示確認に留める** で OK か

---

## スキップ率（全体）
- priority:high 76 件中スキップ 6 件 (IP/SAML/SSO/Cert/etc.) + 保留 1 件 = **7.9%**
- user-security の priority:high は R-131, R-135 の 2 件、いずれも既に R-117 で記録済みなので **追加スキップなし**
- ✅ 変化なし (目標 5% 超過は継続中、ただし決済/外部依存が主因)
