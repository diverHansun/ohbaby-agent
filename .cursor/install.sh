#!/usr/bin/env bash
# Idempotent bootstrap for the ohbaby-agent Cloud Agent environment.
# Provisions Node 24 (the project requires Node >= 24, but the base image
# ships Node 22), activates the pinned pnpm, installs dependencies, and builds
# the workspace so the CLI and local web UI can run immediately.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# The base image provides nvm; use it to install and default to Node 24.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24
nvm use 24

node --version

# pnpm version is pinned via package.json "packageManager"; provide it via corepack.
corepack enable
corepack prepare pnpm@9.15.0 --activate

pnpm install --frozen-lockfile

# Build every workspace package (runtime, server, CLI, and web UI bundle) so the
# `ohbaby` CLI and `ohbaby serve` web daemon are runnable without a separate step.
pnpm build
