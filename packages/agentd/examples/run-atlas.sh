#!/usr/bin/env bash
# Run the ania→nefertari integration test against the REAL Atlas provider (kat-coder).
# Reads the Atlas key from ania's own .env so no secret is ever typed on a command line.
set -euo pipefail

export PATH="$HOME/.local/node/bin:$PATH"

ENVFILE="${ATLAS_ENV_FILE:-$HOME/.atlas.env}"   # override: ATLAS_ENV_FILE=/path/to/.env
[ -f "$ENVFILE" ] || { echo "No env file at $ENVFILE. Point ATLAS_ENV_FILE at a file containing ATLAS_CLOUD_API_KEY=..." >&2; exit 1; }
KEY="$(grep -E '^ATLAS_CLOUD_API_KEY=' "$ENVFILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"

export NEFERTARI_LLM_BASE_URL="https://api.atlascloud.ai/v1"
export NEFERTARI_LLM_API_KEY="$KEY"
export NEFERTARI_LLM_MODEL="kwaipilot/kat-coder-pro-v2.5"
export NEFERTARI_HOME="$(mktemp -d /tmp/nefertari-atlas-XXXX)"

cd "$(dirname "$0")/.."
node --version
node examples/ania-on-nefertari.mjs
