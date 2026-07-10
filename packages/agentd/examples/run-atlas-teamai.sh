#!/usr/bin/env bash
# Run the Team AI ops executor against the REAL Atlas provider (kat-coder),
# with the Landlock enforcer active on reversible shell commands.
# Reads the Atlas key from ania's .env so no secret is typed on a command line.
set -euo pipefail

export PATH="$HOME/.local/node/bin:$PATH"

ENVFILE="/mnt/c/Users/Acemagic S3A/Desktop/dev/agent-engine-template-sdk/ania-app/.env"
KEY="$(grep -E '^ATLAS_CLOUD_API_KEY=' "$ENVFILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"

export NEFERTARI_LLM_BASE_URL="https://api.atlascloud.ai/v1"
export NEFERTARI_LLM_API_KEY="$KEY"
export NEFERTARI_LLM_MODEL="kwaipilot/kat-coder-pro-v2.5"
export NEFERTARI_HOME="$(mktemp -d /tmp/nefertari-teamai-XXXX)"
export NEFERTARI_ENFORCE_BIN="$HOME/nef-enforce-target/release/nefertari-enforce"

cd "/mnt/c/Users/Acemagic S3A/Desktop/dev/nefertari-os/packages/agentd"
node examples/team-ai-on-nefertari.mjs
