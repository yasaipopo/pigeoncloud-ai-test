# 本番 (ai-test.pigeon-cloud.com) で E2E を実行する手順

E2E テスト基盤は staging / production 両方でテナントを作成して動かせる。
ただし誤って本番にテナント爆発させたり、staging のクッキーで本番アクセスする事故を防ぐため、安全ガードと物理分離を入れている。

## 安全ガード

`tests/helpers/env-guard.js` の `assertProductionConfirmed` が以下のタイミングで実行される:

- `tests/global-setup.js` の `globalSetup` 冒頭
- `tests/helpers/create-test-env.js` の `createTestEnv` 冒頭

**動作:** `ADMIN_BASE_URL` が `pigeon-cloud.com` を含む場合、`CONFIRM_PRODUCTION=1` が無ければ throw する。

```
[安全ガード] ADMIN_BASE_URL=https://ai-test.pigeon-cloud.com は本番環境 (pigeon-cloud.com) を指しています。
本番でテスト環境を作成するには CONFIRM_PRODUCTION=1 を明示的に設定してください。
```

## env 別物理分離

storageState とテナント情報ファイルは env 別ファイル名で保存される:

| 種別 | ファイル名 |
|---|---|
| ログイン済みクッキー | `.auth-state.${envType}.${agentNum}.json` |
| テナント情報ランタイム | `.test_env_runtime.${envType}.${agentNum}` |

`envType` は `staging` または `production`。同じ `AGENT_NUM` でも env が違えばファイルが別になるため、cookie / テナント情報の取り違えが起こらない。

`envType` の判定 (`getEnvType`):
1. `ADMIN_BASE_URL` に `pigeon-cloud.com` が含まれる → `production`
2. `ADMIN_BASE_URL` がそれ以外で URL が設定されている → `staging` (ENV_TYPE と矛盾しても URL 優先)
3. URL が未設定 → `process.env.ENV_TYPE === 'production'` ? `production` : `staging`

URL 優先にしている理由: `ADMIN_BASE_URL=staging` だが `ENV_TYPE=production` のとき、staging のクッキーを `.auth-state.production.${N}.json` として保存する逆転を防ぐため。

## 実行手順

### 1. .env を本番用に切替

```bash
cp .env.prod .env
```

`.env.prod` には以下が入っている:
- `ADMIN_BASE_URL=https://ai-test.pigeon-cloud.com`
- `ADMIN_EMAIL=admin`
- `ADMIN_PASSWORD=...`
- `ENV_TYPE=production`

### 2. CONFIRM_PRODUCTION=1 を渡して実行

```bash
# 単発 spec
CONFIRM_PRODUCTION=1 AGENT_NUM=201 npx playwright test tests/auth.spec.js

# 全 spec (本番用シェル)
CONFIRM_PRODUCTION=1 bash run_all_specs_production.sh
```

### 3. AGENT_NUM レンジルール

| 環境 | 推奨 AGENT_NUM レンジ |
|---|---|
| staging | 1 - 199 (通常 1-100) |
| production | 200 以上 |

env 別ファイル分離があるので物理的衝突は起きないが、ログや reports ディレクトリの可読性のためにレンジを分ける。

## staging に戻すとき

```bash
cp .env.staging .env
unset CONFIRM_PRODUCTION  # 残ってると次回本番フラグになるので必ず unset
```

## 注意

- 本番テナント (`ai-test.pigeon-cloud.com` 配下に `tmp-testai-*`) を量産すると本番 RDS ストレージを圧迫する。テスト後に不要環境のクリーンアップを検討する (CLAUDE.md「staging RDSストレージに注意」参照)。
- 本番アカウント情報の変更は CLAUDE.md「アカウント情報の変更ポリシー」に従い**絶対に変更しない**。
- 本番テスト中に重要顧客テナントへ意図せずアクセスしないよう、`createTestEnv` で生成された `tmp-testai-*` ドメインのみ操作対象とする (既存実装で担保済み)。
