# PlaywrightのUbuntu22.04公式イメージ（ブラウザ依存関係インストール済み）
FROM mcr.microsoft.com/playwright/python:v1.44.0-jammy

# Node.js（Claude Code CLI用）+ sudo（playwright Chrome インストーラーが su root を使うため）
RUN apt-get update && apt-get install -y \
    curl \
    git \
    openssh-client \
    sudo \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# 非rootユーザー作成（--dangerously-skip-permissions はroot不可のため）
# sudoグループに追加 + PAM設定：playwright が su root でChrome インストール可能にする
RUN useradd -m -s /bin/bash agent && \
    mkdir -p /app && \
    chown -R agent:agent /app && \
    chown -R agent:agent /home/agent/.npm 2>/dev/null || true && \
    usermod -aG sudo agent && \
    # PAM: sudoグループのユーザーはパスワードなしで su root できる
    sed -i '1s/^/auth       sufficient   pam_succeed_if.so quiet ruser ingroup sudo\n/' /etc/pam.d/su

WORKDIR /app

# Playwright JS（npm）の依存だけ先にインストール
COPY package.json .
RUN npm install && chown -R agent:agent /app/node_modules

# npmでインストールされたPlaywright JSバージョン用のChromiumをイメージにベイク
# → コンテナ起動時のダウンロード不要になる
RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx playwright install chromium --with-deps 2>/dev/null || \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx playwright install chromium && \
    chown -R agent:agent /ms-playwright

# Pythonパッケージ
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# アプリケーションファイル
COPY --chown=agent:agent runner/ ./runner/
COPY --chown=agent:agent specs/ ./specs/
COPY --chown=agent:agent tests/ ./tests/
COPY --chown=agent:agent playwright.config.js .
COPY --chown=agent:agent CLAUDE.md .
COPY --chown=agent:agent agent_instructions.md .
COPY --chown=agent:agent run_agent.sh .
COPY --chown=agent:agent run_orchestrator.sh .
COPY --chown=agent:agent agent_prompt_template.txt .
COPY --chown=agent:agent orchestrator_prompt.txt .
RUN chmod +x run_agent.sh run_orchestrator.sh

# scenarios, reports, src はボリュームマウント
VOLUME ["/app/scenarios", "/app/reports", "/app/src"]

USER agent

# MODE=orchestrator → Claude Code親として run_orchestrator.sh を起動
# MODE=それ以外    → 従来の run_agent.sh を起動（単体エージェント）
CMD ["/bin/bash", "-c", \
  "if [ \"$MODE\" = 'orchestrator' ]; then \
     ./run_orchestrator.sh; \
   else \
     ./run_agent.sh; \
   fi"]
