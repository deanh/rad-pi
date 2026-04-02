#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# bootstrap-rad-agent.sh
#
# Sets up a node for multiplayer agentic workflows with Radicle + Pi.
# Installs: Radicle, rad-plan, rad-context, Pi agent, and Radicle skills.
#
# Usage:
#   curl -sSf https://your-host/bootstrap-rad-agent.sh | bash
#   # or
#   ./bootstrap-rad-agent.sh [--alias <node-alias>]
#
# Requires: Ubuntu 24.04, sudo access, internet connectivity
# =============================================================================

# ---------------------------------------------------------------------------
# Configuration — edit these before distributing
# ---------------------------------------------------------------------------

# Git repos for rad-plan and rad-context (cargo install sources)
RAD_CONTEXT_REPO="https://seed.radicle.garden/z2yMM9ynsfbVKC5r3z3vxgKkqQ3Yb.git"    # TODO: set this
RAD_PLAN_REPO="https://seed.radicle.garden/z4L8L9ctRYn2bcPuUT4GRz7sggG1v.git"  # TODO: set this

# Pi Radicle integration (published npm package)
RAD_PI_PACKAGE="rad-pi"  # https://www.npmjs.com/package/rad-pi

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

NODE_ALIAS=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --alias) NODE_ALIAS="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if [ -z "$NODE_ALIAS" ]; then
    NODE_ALIAS="rad-agent-$(hostname -s)"
    echo "No --alias provided, using: $NODE_ALIAS"
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { echo -e "\n\033[1;34m==>\033[0m \033[1m$1\033[0m"; }
ok()  { echo -e "    \033[1;32m✓\033[0m $1"; }
err() { echo -e "    \033[1;31m✗\033[0m $1"; exit 1; }

check_cmd() {
    command -v "$1" &>/dev/null && ok "$1 found" || return 1
}

# ---------------------------------------------------------------------------
# 1. System prerequisites
# ---------------------------------------------------------------------------

log "Installing system prerequisites"

sudo apt-get update -qq
sudo apt-get install -y -qq build-essential git curl pkg-config libssl-dev

# Node.js 22 (for Pi)
if ! check_cmd node; then
    log "Installing Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
fi
ok "node $(node --version)"

# Rust (for rad-plan, rad-context)
if ! check_cmd cargo; then
    log "Installing Rust"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi
ok "cargo $(cargo --version | cut -d' ' -f2)"

# ---------------------------------------------------------------------------
# 2. Radicle
# ---------------------------------------------------------------------------

log "Installing Radicle"

if ! check_cmd rad; then
    curl -sSf https://radicle.xyz/install | sh
    # Add to PATH if the installer put it somewhere non-standard
    export PATH="$HOME/.radicle/bin:$PATH"
    echo 'export PATH="$HOME/.radicle/bin:$PATH"' >> "$HOME/.bashrc"
fi
ok "rad $(rad --version 2>/dev/null || echo '(version check failed)')"

# ---------------------------------------------------------------------------
# 3. rad-plan and rad-context
# ---------------------------------------------------------------------------

if ! check_cmd rad-plan; then
    log "Installing rad-plan"
    CARGO_BUILD_JOBS=1 cargo install --git "$RAD_PLAN_REPO" 2&>1 | tail -1
fi
check_cmd rad-plan || err "rad-plan installation failed"

if ! check_cmd rad-context; then
    log "Installing rad-context"
    CARGO_BUILD_JOBS=1 cargo install --git "$RAD_CONTEXT_REPO" --locked 2>&1 | tail -1
fi
check_cmd rad-context || err "rad-context installation failed"

# ---------------------------------------------------------------------------
# 4. Pi agent
# ---------------------------------------------------------------------------

npm config set prefix ~/.npm-global && echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc

log "Installing Pi coding agent"

if ! check_cmd pi; then
    npm install -g @mariozechner/pi-coding-agent
fi
ok "pi installed"

# ---------------------------------------------------------------------------
# 5. Pi Radicle package (skills, extensions, templates)
# ---------------------------------------------------------------------------

log "Installing rad-pi package"

pi install "npm:$RAD_PI_PACKAGE"
ok "rad-pi installed via pi install"

# ---------------------------------------------------------------------------
# 6. Radicle identity
# ---------------------------------------------------------------------------

log "Setting up Radicle identity"

if rad self &>/dev/null 2>&1; then
    EXISTING_NID=$(rad self | head -1)
    ok "existing identity found: $EXISTING_NID"
else
    echo "" | rad auth --alias "$NODE_ALIAS" --stdin
    ok "identity created with alias: $NODE_ALIAS"
fi

NID=$(rad self | grep -oP 'z6Mk\w+' | head -1 || echo "(could not parse NID)")

# ---------------------------------------------------------------------------
# 7. Verify
# ---------------------------------------------------------------------------

log "Verification"

PASS=true
for cmd in rad rad-plan rad-context pi node npm cargo; do
    check_cmd "$cmd" || { echo "    ✗ $cmd missing"; PASS=false; }
done

# Verify rad-pi package is installed
if pi list 2>/dev/null | grep -q "rad-pi"; then
    ok "rad-pi package installed"
else
    echo "    ✗ rad-pi package not found (try: pi install rad-pi)"
    PASS=false
fi

echo ""
if $PASS; then
    echo -e "\033[1;32m========================================\033[0m"
    echo -e "\033[1;32m  Node ready: $NODE_ALIAS\033[0m"
    echo -e "\033[1;32m  NID: $NID\033[0m"
    echo -e "\033[1;32m========================================\033[0m"
else
    echo -e "\033[1;31mSome components failed to install. Check output above.\033[0m"
    exit 1
fi

echo ""
echo "Next steps:"
echo "  1. Set your LLM API key:  export ANTHROPIC_API_KEY=\"sk-ant-...\""
echo "  2. Start the Radicle node: rad node start"
echo "  3. Connect to the mesh:    rad node connect <PEER_NID>@<PEER_IP>:8776"
echo "  4. Seed a repo:            rad seed <RID>"
echo "  5. Test Pi + Radicle:      cd <repo> && pi -p 'List open Radicle issues'"
