FROM python:3.12-slim-bookworm

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    sqlite3 \
    curl \
    ca-certificates \
    gnupg \
    openssh-client \
    djvulibre-bin \
    unrar-free \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Playwright browser dependencies (for E2E tests)
RUN npx playwright install-deps chromium 2>/dev/null || true

# Python dependencies (cached layer)
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt || true

# Non-root user
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd -g ${USER_GID} dev \
    && useradd -m -u ${USER_UID} -g ${USER_GID} -s /bin/bash dev \
    && mkdir -p /home/dev/.claude/debug /home/dev/.claude/projects \
    && mkdir -p /home/dev/.cache/pip /home/dev/.npm \
    && chown -R dev:dev /home/dev

# Pre-create named volume mount points with correct ownership
# Docker copies permissions from the image on first volume creation
RUN mkdir -p /workspace/node_modules \
             /workspace/__pycache__ \
             /workspace/.pytest_cache \
    && chown -R dev:dev /workspace

USER dev
WORKDIR /workspace

COPY --chown=dev:dev docker/entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["bash", "/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
