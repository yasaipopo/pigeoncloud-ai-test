#!/bin/bash
# nvm遅延ロードの再帰問題を回避してPlaywrightテストを実行
export PATH="/Users/yasaipopo/.nvm/versions/node/v22.21.1/bin:$PATH"
export SKIP_GLOBAL_SETUP=1
exec npx playwright test "$@"
