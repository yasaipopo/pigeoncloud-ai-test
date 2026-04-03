# spec-fix-02: テスト修正（すぐ直せそう → 中程度の順）

## 状況
- 前回: 561+ pass / ~95 fail (85%+)
- 目標: failを減らしていく（丁寧に1specずつ）

## 優先度順
1. [✅] fields-3 - createTestEnv移行 + F311修正 → 20/20 全PASS (6.4分)
2. [✅] fields-4 - テーブル設定ページ不使用に全面書き換え → 1/1 全PASS (52秒)
3. [✅] chart-calendar-2 - 全6テストPASS (1 flaky) — openChartModalFromTable統合+フラグリセット
4. [改善] system-settings - createTestEnv移行 → 7 pass / 4 fail / 1 flaky (6→4 fail)
   - 残fail原因: SS01がパスワード変更設定を変更→セッション無効化→後続テストでログインできない
   - 対策案: SS01のパスワード関連stepを最後に移動、またはstep間でensureLoggedIn強化
5. [改善] uncategorized-2 - createTestEnv移行 → 6 pass / 2 fail (U201,U208) / 1 flaky
6. [テスト中] csv-export - createTestEnv移行
7. [  ] fields (7 fail) - セレクター修正
8. [  ] fields-2 (8 fail) - モーダルヘッダー+strict mode
9. [  ] layout-ui (4 fail)
10. [  ] notifications (5 fail)
11. [  ] workflow (~5 fail)
12. [  ] users-permissions (10 fail)
13. [  ] uncategorized (15 fail)

## AGENT_NUM: 500
