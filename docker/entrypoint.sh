#!/usr/bin/env bash
set -e

# --- Claude Code state ---
mkdir -p ~/.claude/debug ~/.claude/projects

# Prune old debug logs (>7 days or >500MB total)
find ~/.claude/debug -type f -mtime +7 -delete 2>/dev/null || true
DEBUG_SIZE=$(du -sm ~/.claude/debug 2>/dev/null | cut -f1)
if [ "${DEBUG_SIZE:-0}" -gt 500 ]; then
    ls -1t ~/.claude/debug/* 2>/dev/null | tail -n +100 | xargs rm -f 2>/dev/null || true
fi

# --- Git config ---
if [ -n "$GIT_AUTHOR_NAME" ]; then
    git config --global user.name "$GIT_AUTHOR_NAME"
fi
if [ -n "$GIT_AUTHOR_EMAIL" ]; then
    git config --global user.email "$GIT_AUTHOR_EMAIL"
fi
git config --global --add safe.directory /workspace

# --- SSH setup ---
if [ -d /home/dev/.ssh ] && [ "$(ls -A /home/dev/.ssh 2>/dev/null)" ]; then
    mkdir -p ~/.ssh_local
    cp -r /home/dev/.ssh/* ~/.ssh_local/ 2>/dev/null || true
    chmod 700 ~/.ssh_local
    chmod 600 ~/.ssh_local/* 2>/dev/null || true
    export GIT_SSH_COMMAND="ssh -i ~/.ssh_local/id_ed25519 -i ~/.ssh_local/id_rsa -o StrictHostKeyChecking=accept-new"
    ssh-keyscan github.com >> ~/.ssh_local/known_hosts 2>/dev/null || true
fi

# --- Install dependencies ---
echo "Checking dependencies..."

# Python — install in editable mode if setup exists
if [ -f /workspace/pyproject.toml ] || [ -f /workspace/setup.py ]; then
    pip install -e /workspace --quiet 2>/dev/null || true
elif [ -f /workspace/requirements.txt ]; then
    pip install -r /workspace/requirements.txt --quiet 2>/dev/null || true
fi

# Node — detect platform mismatch and reinstall
if [ -f /workspace/package.json ]; then
    if [ -d /workspace/node_modules ] && [ -f /workspace/node_modules/.package-lock.json ]; then
        PLAT=$(node -e "try{console.log(require('/workspace/node_modules/.package-lock.json').packages['node_modules/esbuild']?.os?.[0]||'linux')}catch{console.log('linux')}" 2>/dev/null)
        if [ "$PLAT" = "win32" ]; then
            echo "Detected Windows node_modules — reinstalling for Linux..."
            rm -rf /workspace/node_modules
        fi
    fi
    cd /workspace && npm install --prefer-offline --no-audit --no-fund 2>/dev/null || true
    cd /workspace
fi

# Claude Code — check version
claude --version 2>/dev/null || true

# --- Welcome ---
echo ""
echo "================================================"
echo "  Speed Reader — Dev Sandbox"
echo "================================================"
if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "  Auth: API key configured"
else
    echo "  Auth: Run 'claude login' to authenticate"
fi
echo ""
echo "  Quick start:"
echo "    claude         — Launch Claude Code"
echo "    npm run dev    — Start dev server (when configured)"
echo ""
echo "================================================"
echo ""

exec "$@"
