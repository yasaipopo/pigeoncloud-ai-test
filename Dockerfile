# PlaywrightのUbuntu22.04公式イメージ（ブラウザ依存関係インストール済み）
FROM mcr.microsoft.com/playwright/python:v1.44.0-jammy

# Node.js（Claude Code CLI用）
RUN apt-get update && apt-get install -y \
    curl \
    git \
    openssh-client \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# 非rootユーザー作成（--dangerously-skip-permissions はroot不可のため）
RUN useradd -m -s /bin/bash agent && \
    mkdir -p /app && \
    chown -R agent:agent /app

WORKDIR /app

# Playwright JS（npm）の依存だけ先にインストール
COPY package.json .
RUN npm install && chown -R agent:agent /app/node_modules

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
RUN chmod +x run_agent.sh

# scenarios, reports, src はボリュームマウント
VOLUME ["/app/scenarios", "/app/reports", "/app/src"]

USER agent

CMD ["./run_agent.sh"]
