#!/usr/bin/env bash
# Run the Nefertari performance benchmark against the REAL Atlas provider.
# Usage: run-atlas-bench.sh <model> [benchFilter]
# Reads the Atlas key from ania's .env so no secret is typed on a command line.
set -euo pipefail

export PATH="$HOME/.local/node/bin:$PATH"

ENVFILE="/mnt/c/Users/Acemagic S3A/Desktop/dev/agent-engine-template-sdk/ania-app/.env"
KEY="$(grep -E '^ATLAS_CLOUD_API_KEY=' "$ENVFILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"

export NEFERTARI_LLM_BASE_URL="https://api.atlascloud.ai/v1"
export NEFERTARI_LLM_API_KEY="$KEY"
export NEFERTARI_LLM_MODEL="${1:?usage: run-atlas-bench.sh <model> [benchFilter]}"
export NEFERTARI_ENFORCE_BIN="$HOME/nef-enforce-target/release/nefertari-enforce"
export BENCH_OUT="${BENCH_OUT:-/tmp/nef-bench-results.json}"

cd "/mnt/c/Users/Acemagic S3A/Desktop/dev/nefertari-os/packages/agentd"
node examples/bench-on-nefertari.mjs "${2:-}"
