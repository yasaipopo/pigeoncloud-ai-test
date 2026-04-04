# 管理設定ページ知見

## その他設定（admin_setting）
- URL: `/admin/admin_setting/edit/1`
- 内容: 二段階認証、パスワードリセット、利用規約、パスワード強制変更間隔
- Angular描画に5秒必要（`waitForTimeout(5000)`）
- 二段階認証ON: adminユーザーのIDがメールアドレスでないとエラー

## 共通設定（setting）
- URL: `/admin/setting`
- 注意: Angular SPAで `setting` をテーブル名として解釈する場合がある → 「テーブルが見つかりません」
- SMTP設定等

## システム利用状況
- URL: `/admin/setting/system_info` → ルートにリダイレクトされることがある
- 代替: `/admin/admin_setting/edit/1` ページ内で確認

## テーブル管理
- URL: `/admin/dataset`
- テーブル一覧が表示
- 「手動でテーブルを作成」ボタン（テンプレートモーダルの背後にある場合がある）

## debug API
- `POST /api/admin/debug/settings` — setting/admin_settingテーブルの値を更新
  - body: `{ table: 'setting', data: { max_user: 9999 } }`
  - `admin` テーブルは非対応

## ログインフロー
- `/admin/login` → ID/PW入力 → `.navbar` 待ち
- パスワード変更画面が出る場合がある（`pw_change_interval_days` 設定）
- アカウントロック: ログイン失敗回数超過
