#!/usr/bin/env bash
# Run the performance benchmark across several models, N times per cell, inside
# the container — so the enforcer is active exactly as it is in a real run.
#
# A sample of one cannot separate a real effect from a model having a good turn,
# which is the first thing a sceptical reader will say. BENCH_RUNS is the answer.
#
#   ATLASCLOUD_API_KEY=... bash examples/run-bench-matrix.sh
#   BENCH_RUNS=5 bash examples/run-bench-matrix.sh deepseek-ai/deepseek-v4-flash
#   BENCH_RUNS=5 BENCH_FILTER=A bash examples/run-bench-matrix.sh   # bench A only
#
# Defaults to cheap models: the thesis is that the primitives help most where the
# model is small, so proving it on a flagship would prove the wrong thing.
set -uo pipefail

: "${ATLASCLOUD_API_KEY:?set ATLASCLOUD_API_KEY}"
RUNS="${BENCH_RUNS:-5}"
FILTER="${BENCH_FILTER:-}"
IMAGE="${IMAGE:-nefertari-agentd:enforce-test}"

if [ "$#" -gt 0 ]; then
  MODELS=("$@")
else
  MODELS=(
    "deepseek-ai/deepseek-v4-flash"
    "kwaipilot/kat-coder-air-v2.5"
    "bytedance/doubao-seed-2.0-lite-260428"
  )
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
command -v cygpath >/dev/null 2>&1 && REPO="$(cygpath -m "$REPO")"

OUTDIR="${BENCH_OUTDIR:-$(pwd)/bench-out}"
mkdir -p "$OUTDIR"
OUTDIR_M="$OUTDIR"
command -v cygpath >/dev/null 2>&1 && OUTDIR_M="$(cygpath -m "$OUTDIR")"

echo "models:  ${MODELS[*]}"
echo "runs:    $RUNS per cell"
echo "out:     $OUTDIR"
echo

for model in "${MODELS[@]}"; do
  echo "=============================================================="
  echo "  $model"
  echo "=============================================================="
  docker run --rm \
    -v "$REPO:/repo" -v "$OUTDIR_M:/out" \
    -w /repo/packages/agentd \
    -e NEFERTARI_LLM_BASE_URL="https://api.atlascloud.ai/v1" \
    -e NEFERTARI_LLM_API_KEY="$ATLASCLOUD_API_KEY" \
    -e NEFERTARI_LLM_MODEL="$model" \
    -e BENCH_RUNS="$RUNS" \
    -e BENCH_OUT="/out/bench-results.json" \
    -e BENCH_SUMMARY="/out/bench-summary.json" \
    --entrypoint node "$IMAGE" examples/bench-on-nefertari.mjs "$FILTER"
  echo
done

echo "raw     -> $OUTDIR/bench-results.json"
echo "summary -> $OUTDIR/bench-summary.json"
