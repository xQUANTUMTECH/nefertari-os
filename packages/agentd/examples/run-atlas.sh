#!/usr/bin/env bash
# Run the ania→nefertari integration test against the REAL Atlas provider (kat-coder).
# Reads the Atlas key from ania's own .env so no secret is ever typed on a command line.
set -euo pipefail

export PATH="$HOME/.local/node/bin:$PATH"

ENVFILE="/mnt/c/Users/Acemagic S3A/Desktop/dev/agent-engine-template-sdk/ania-app/.env"
KEY="$(grep -E '^ATLAS_CLOUD_API_KEY=' "$ENVFILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"

export NEFERTARI_LLM_BASE_URL="https://api.atlascloud.ai/v1"
export NEFERTARI_LLM_API_KEY="$KEY"
export NEFERTARI_LLM_MODEL="kwaipilot/kat-coder-pro-v2.5"
export NEFERTARI_HOME="$(mktemp -d /tmp/nefertari-atlas-XXXX)"

cd "/mnt/c/Users/Acemagic S3A/Desktop/dev/nefertari-os/packages/agentd"
node --version
node examples/ania-on-nefertari.mjs
