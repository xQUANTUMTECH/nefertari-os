#!/usr/bin/env bash
# Run the Fortuna BRAND executor against the REAL Atlas provider, with the
# Landlock enforcer active on reversible shell commands.
# Reads the Atlas key from ania's .env so no secret is typed on a command line.
set -euo pipefail

export PATH="$HOME/.local/node/bin:$PATH"

ENVFILE="${ATLAS_ENV_FILE:-$HOME/.atlas.env}"   # override: ATLAS_ENV_FILE=/path/to/.env
[ -f "$ENVFILE" ] || { echo "No env file at $ENVFILE. Point ATLAS_ENV_FILE at a file containing ATLAS_CLOUD_API_KEY=..." >&2; exit 1; }
KEY="$(grep -E '^ATLAS_CLOUD_API_KEY=' "$ENVFILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"

export NEFERTARI_LLM_BASE_URL="https://api.atlascloud.ai/v1"
export NEFERTARI_LLM_API_KEY="$KEY"
export NEFERTARI_LLM_MODEL="${NEFERTARI_LLM_MODEL:-deepseek-ai/deepseek-v4-pro}"
export NEFERTARI_HOME="$(mktemp -d /tmp/nefertari-brand-XXXX)"
export NEFERTARI_ENFORCE_BIN="$HOME/nef-enforce-target/release/nefertari-enforce"

cd "$(dirname "$0")/.."
node examples/brand-on-nefertari.mjs
