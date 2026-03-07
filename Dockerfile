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

WORKDIR /app

# Pythonパッケージ
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# アプリケーションファイル
COPY runner/ ./runner/
COPY CLAUDE.md .
COPY agent_instructions.md .
COPY run_agent.sh .
RUN chmod +x run_agent.sh

# scenarios, reports, src はボリュームマウント
VOLUME ["/app/scenarios", "/app/reports", "/app/src"]

CMD ["./run_agent.sh"]
