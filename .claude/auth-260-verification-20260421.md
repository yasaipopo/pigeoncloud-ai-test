# auth-260 マルチテナント分離脆弱性 独立検証レポート

**調査日**: 2026-04-21
**調査委託**: Gemini CLI (`~/.gemini/gemini-tracked`, 独立セッション)
**対象**: `tests/auth.spec.js` L1242 `auth-260: マルチテナント分離` (@requirements.txt(R-118))
**前回調査**: `.claude/auth-260-investigation-20260421.md`
**目的**: 前回調査結論の独立クロスチェック

---

## 結論

🔴 **CONFIRMED**（真に脆弱 / 前回調査が正しい）

独立した gemcli セッションで最初から再精査した結果、前回調査と同じ結論に到達した。マルチテナント環境でのセッション境界突破が実装上可能であることを、**別視点のコード精査でも確認**した。

---

## 独立検証の根拠（コード該当行明示）

### 1. セッションストアの共有（決定的証拠）

- `html_angular4/release/staging/php.ini` 等のセッション設定で、全テナントが同一の Redis (Valkey) インスタンス・同一データベース (`database=12` 等) をセッション保存先として共有。
- **キーのプレフィックスによるテナント分離も実装されていない**。
- これにより、PHPSESSID が衝突する環境でセッションデータが全テナント共通プールに格納される。

### 2. テナント識別子の欠落

- `Application/Service/LoginService.php::login()`
- `Application/Controllers/LoginController.php::_login()`

両者ともセッション (`$_SESSION['admin']`) に保存しているのは:
```php
$_SESSION['admin'] = [
    'table' => 'admin',
    'id' => $admin_id,
];
```

**どのテナント (`ALIAS_NAME`) で発行されたかの情報が含まれていない**。

### 3. 認証ミドルウェアでの照合欠落

- `routes/admin/admin.php` 末尾の認証ミドルウェア
- `Application/Class/AdminCommon.php::setAdmin()`

いずれもセッション内 `admin_id` で DB 検索するのみで、**セッションが現在の `HTTP_HOST` (`ALIAS_NAME`) に対して発行されたかの確認ロジックが存在しない**。

### 4. 動的 DB 切り替えメカニズムの悪用経路

- `lib/load_config.php` が `HTTP_HOST` から `ALIAS_NAME` を動的決定し、DB 接続先を切り替える。
- → 攻撃者がテナント A の有効 PHPSESSID をテナント B のドメインで送信すると、**テナント B の DB 内で同一 admin_id のユーザーとして認証される**。

---

## テナント分離パターン (a)(b)(c) 検証結果

| パターン | 結果 | 根拠 |
|---|---|---|
| (a) Cookie ドメイン制限 | ❌ なし | `lib/http_setup.php` で `session_set_cookie_params` 呼び出しあるが `domain` 未指定。デフォルトはホスト限定だが**手動で Cookie 付与する攻撃（curl/プロキシ）は防げない** |
| (b) セッションストア分離 | ❌ なし | `php.ini` で全テナント同一 Redis を指定。プレフィックス分離なし |
| (c) ミドルウェア照合 | ❌ なし | `routes/admin/admin.php` / `AdminCommon::setAdmin()` どちらもテナント一致確認ロジック無し |

**3 パターンすべて機能していない → 脆弱性成立**

---

## E2E テストの攻撃再現妥当性

**妥当**。

- `tests/auth.spec.js` の auth-260 で Cookie `domain` を別テナントのホストに書き換える手法は、マルチテナント環境において「別テナントの有効セッション ID が入手された場合のなりすまし」攻撃を正確にシミュレート。
- ブラウザ標準の Host-only cookie 保護はあるが、攻撃者が自作ツール（curl / プロキシ）で Cookie を手動付与すれば成立。
- **サーバサイドで検証が無い以上、ブラウザ側の挙動に依存した防御はセキュリティ境界として信頼できない**（OWASP 原則）。

---

## 既存 PHPUnit 状況

- `tests/Unit/Service/OpenSearchServiceTenantIsolationTest.php`: OpenSearch 検索結果レベルのテナント分離テストは存在（`assertTenantMatch` 等）
- **しかし、Web アプリのセッションレベルのテナント分離テストは未実装**

---

## 前回調査との差分

### 一致点（重要）

- ✅ セッションに `ALIAS_NAME` が保存されていない
- ✅ 認証ミドルウェアでテナント照合が欠落
- ✅ Redis セッションストアが全テナント共有
- ✅ `lib/load_config.php` で HTTP_HOST から DB 切り替えする構造

すべての主要指摘事項について、**独立調査で同じ結論を得た**。

### 相違点

- 特になし。2 つの独立セッションが同じ脆弱性パターンに到達。

### 追加で判明した事実

- **Redis (Valkey) を使っていて database 番号も共通** (`database=12` 等)。前回調査では「Redis または /tmp 等のファイル」と推測形だったが、今回 php.ini を読んで Redis 共有使用を確定。
- **cookie_domain 未設定を直接確認**。`session_set_cookie_params` は呼ばれているが第 4 引数 domain が明示されていない。

---

## 修正推奨箇所

### 1. ログイン時 session 拡張

**ファイル**: `Application/Service/LoginService.php`
**修正内容**: `login` メソッド内で以下を追加
```php
$_SESSION['admin']['alias'] = ALIAS_NAME;
```

**ファイル**: `Application/Controllers/LoginController.php::_login()`
**修正内容**: 同じく `$_SESSION['admin']['alias'] = ALIAS_NAME;` を追加

（SAML ログイン `SamlLoginController.php` / `SamlMSLoginController.php` も同様対応必要）

### 2. ガードロジック追加

**ファイル**: `routes/admin/admin.php`
**修正内容**: `/admin` グループの認証ミドルウェアに以下を追加
```php
if (!empty($_SESSION['admin']['id'])) {
    if (empty($_SESSION['admin']['alias']) || $_SESSION['admin']['alias'] !== ALIAS_NAME) {
        // テナント不一致 → セッション破棄 + 401
        session_destroy();
        return $response->withStatus(401);
    }
}
```

**ファイル**: `Application/Class/AdminCommon.php::setAdmin()`
**修正内容**: 同じ照合ロジックを関数冒頭に追加

### 3. 既存セッションの移行対応

既存セッションには `alias` が無いため、デプロイ直後は全ユーザー強制ログアウト扱いにする必要あり。
- 対応案 A: セッションローテーション（全 Redis キー一掃）
- 対応案 B: `alias` が無いセッションは legacy 扱いとして強制再ログイン誘導

### 4. API リクエスト用の対応

**ファイル**: `Application/Http/Requests/ApiRequest.php`（存在する場合）
**修正内容**: API 用ミドルウェアにも同じ `alias` 照合を追加

---

## PHPUnit 追加推奨

### テストファイル（新規）
`/Users/yasaipopo/PhpStormProjects/PopoframeworkSlim/tests/IntegrationTest/Security/TenantIsolationTest.php`

### テストケース例

```php
public function test_session_cannot_be_reused_across_tenants()
{
    // 1. テナント A でログインし、PHPSESSID を取得
    $sessionA = $this->loginAsTenantA('admin', 'password');

    // 2. 同じ PHPSESSID を保持したまま HTTP_HOST をテナント B に書き換え
    $_SERVER['HTTP_HOST'] = 'tenant-b.pigeon-demo.com';
    $response = $this->client->get('/admin/init_data', [
        'cookies' => ['PHPSESSID' => $sessionA],
    ]);

    // 3. 401 Unauthorized またはログイン画面へのリダイレクトを期待
    $this->assertContains($response->getStatusCode(), [401, 302]);
    if ($response->getStatusCode() === 302) {
        $this->assertStringContainsString('/login', $response->getHeaderLine('Location'));
    }
}

public function test_login_stores_alias_in_session()
{
    $this->loginAsTenantA('admin', 'password');
    $this->assertEquals('tenant-a', $_SESSION['admin']['alias']);
}

public function test_middleware_rejects_session_without_alias()
{
    // legacy セッション（alias 無し）をシミュレート
    $_SESSION['admin'] = ['table' => 'admin', 'id' => 1];
    $response = $this->client->get('/admin/init_data');
    $this->assertEquals(401, $response->getStatusCode());
}
```

---

## 次のアクション

1. **`.claude/product-bugs.md` に本件を記録**（未記録なら）
2. **ユーザー（開発チーム）に CONFIRMED 結果を報告** → 優先度判断を仰ぐ
3. プロダクト側修正 PR を `tmprepo staging` でブランチ切って作成（**ユーザー承認後に着手**）
4. E2E テスト `auth-260` は fail のまま残す → 修正後に pass することで回帰防止
5. PHPUnit テナント分離テストを同 PR で追加

---

## 補足事項

- staging 環境および本番環境の **両方** でこの構成（Redis 共有・テナント照合無し）である可能性が高いため、早急な修正が推奨される。
- 攻撃成立条件: 「両テナントに同一 `admin_id` のユーザーが存在」
  - テナント B の `admin_id=1` が欠番なら突破不可だが、**新規テナント作成時に admin_id=1 が自動採番されるフロー**なら常に成立
  - この自動採番挙動は DB スキーマ (AUTO_INCREMENT) から考えて成立する可能性大
- この脆弱性は**認証後に任意のテナントのデータを閲覧・改ざん可能**なため、影響度は Critical
