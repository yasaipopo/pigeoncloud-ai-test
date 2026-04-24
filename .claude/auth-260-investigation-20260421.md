# 詳細レポート：auth-260 マルチテナント分離 fail の調査結果

**調査日**: 2026-04-21
**調査委託**: Gemini CLI (`~/.gemini/gemini-tracked`)
**対象テスト**: `tests/auth.spec.js` `auth-260: マルチテナント分離` (@requirements.txt(R-118))
**対象プロダクトコード**: `/Users/yasaipopo/PhpStormProjects/PopoframeworkSlim` (staging ブランチ)

---

## 結論
**🔴 PRODUCT bug**（重大なセキュリティ脆弱性）

マルチテナント環境において、セッションがテナント間で分離されていません。攻撃者がテナント A の有効なセッション ID を入手し、それをテナント B のドメインで使用した場合、テナント B の同じ `admin_id` を持つユーザーとして認証をパスしてしまいます。

## 根拠

### テスト実装の妥当性
E2E テスト `auth-260` は、テナント A で取得した Cookie の `domain` をテナント B のホスト名に書き換えてアクセスを試みています。これはセッションハイジャックおよびテナント間境界突破の典型的な攻撃シナリオを正しく再現しています。

つまり **テスト側は正しく攻撃経路を再現しており、SPEC bug ではない**。

### プロダクト側コード該当箇所

#### 1. セッション作成時の不備
`Application/Controllers/LoginController.php` (L269-273 付近):
```php
private function _login($admin_id) {
    $_SESSION['admin'] = [
        'table' => 'admin',
        'id' => $admin_id
    ];
    // ALIAS_NAME (テナント名) を保存していない
```
→ ログイン時の session に「どのテナントで発行されたか」の情報が一切保存されていない。

#### 2. 認証ミドルウェアでの検証欠落
`routes/admin/admin.php` (L1105-1109 付近):
```php
// AdminCommon::setAdmin($request); // ここでもセッションからadmin_idを取得
$admin = null;
if (!empty($_SESSION['admin']['id'])) {
    $dao = new AdminDao();
    $admin = $dao->find_by_id($_SESSION['admin']['id']);
    // ここで取得される $admin は、現在の HTTP_HOST から解決された DB のユーザー。
    // 「このセッションがこのドメインのために発行されたか」のチェックがない。
}
```
→ `ALIAS_NAME` (HTTP_HOST 由来のテナント識別子) と session のテナントが一致するかの検証が **完全に欠落**。

#### 3. ALIAS_NAME の解決
`lib/load_config.php` で `HTTP_HOST` から `ALIAS_NAME` を導出し DB 接続先を切り替える仕組みは存在する。
しかしこの ALIAS_NAME が session に記録されない・照合されない。

### 攻撃経路シナリオ追跡

1. **ログイン**: `tenant-a.example.com` でログイン。サーバーは `PHPSESSID=XYZ` を発行。サーバー側のセッションデータには `admin.id = 1` が格納される。
2. **Cookie 操作**: ブラウザまたはプロキシを用いて、`PHPSESSID=XYZ` の Domain を `tenant-b.example.com` に書き換える。
3. **アクセス**: `tenant-b.example.com/admin/dashboard` にアクセス。
4. **サーバー処理**:
   - `lib/load_config.php` が `HTTP_HOST` から `ALIAS_NAME = 'tenant-b'` を決定し、DB 接続先を Tenant B に向ける。
   - `session_start()` が実行され、**共通のセッションストレージから** `PHPSESSID=XYZ` を読み込む。`$_SESSION['admin']['id'] = 1` が復元される。
   - `routes/admin/admin.php` のミドルウェアが Tenant B の DB で `id = 1` のユーザーを検索。
   - **存在した場合、`$admin` が有効となり、ダッシュボードへのアクセスが許可される**。

本件はセッションストレージ（Redis または `/tmp` 等のファイル）が全テナントで共有されている場合に発生する。Staging 環境および多くのオンプレミス環境はこの構成である可能性が高い。

## 対応方針

### 1. セッションデータの拡張
`Application/Controllers/LoginController.php` を修正し、ログイン時に tenant 識別子を記録する:
```php
private function _login($admin_id) {
    $_SESSION['admin'] = [
        'table' => 'admin',
        'id' => $admin_id,
        'tenant' => ALIAS_NAME,  // 追加
    ];
}
```

### 2. ガードロジックの追加
`routes/admin/admin.php` および `Application/Http/Requests/ApiRequest.php`（API 用）において、以下のチェックを追加する:
```php
if (empty($_SESSION['admin']['tenant']) || $_SESSION['admin']['tenant'] !== ALIAS_NAME) {
    // セッション破棄 & 401 or ログイン画面へリダイレクト
    session_destroy();
    // redirect or 401
}
```

### 3. 既存セッションへの移行対応
既存の（tenant 未保存）セッションは一度ログアウト扱いにする必要がある。デプロイ時のセッションローテーションを検討。

### 4. PHPUnit テスト追加
アプリケーション全体のセッションベース分離テストを `tests/Integration/` に追加する。

## 既存 PHPUnit テスト
`tests/Unit/Service/OpenSearchServiceTenantIsolationTest.php` に OpenSearch レベルでの分離テストは存在するが、**アプリケーション全体のセッションベースの分離を検証するテストは PHPUnit レベルでは未実装**。

## 次のアクション
1. `.claude/product-bugs.md` に本件を記録（E2E テスト側は修正しない、fail のまま残す）
2. プロダクト側修正 PR を `tmprepo staging` でブランチを切って作成
3. ユーザー（開発チーム）に報告して優先度判断を仰ぐ
4. 修正後に auth-260 が pass することで回帰防止

## 補足
- Staging 環境および多くのオンプレミス環境でこの構成（セッションストア共有）である可能性が高いため、早急な修正が推奨される。
- 攻撃成立条件: 「両テナントに同一 admin_id のユーザーが存在すること」。テナント B の admin_id=1 が欠番なら突破できないが、新規テナント作成時に admin_id=1 が自動採番されるフローであれば常に成立する。
