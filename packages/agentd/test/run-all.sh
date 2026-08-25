#!/usr/bin/env bash
# Run every agentd test, each in a NEFERTARI_HOME of its own.
#
# The isolation is the point. Tests do `process.env.NEFERTARI_HOME ||= mkdtemp()`,
# which quietly does nothing wherever the variable is already set — and the
# container image sets it to /data. Every test then shares one home, pending
# approvals and timelines pile up across the run, and assertions that count them
# fail depending on what ran before. The failure looks like a bug in whatever
# test happens to run last, which is the worst kind to chase.
#
#   bash packages/agentd/test/run-all.sh
#   bash packages/agentd/test/run-all.sh timeline plan     # a subset
#
# Some tests need Linux: the enforcer is Landlock, so on Windows or macOS they
# skip their kernel proof rather than fail. Run the whole suite in the container
# for the real verdict:
#   docker run --rm -v "$PWD:/repo" -w /repo/packages/agentd \
#     --entrypoint /bin/sh nefertari-agentd:enforce-test -c 'bash test/run-all.sh'
#
# That run still SKIPS the cgroup half: freezing needs a writable
# /sys/fs/cgroup, which an ordinary container does not have. For the freeze
# and the gate-freeze to actually run:
#   docker run --rm --privileged --cgroupns=private --user root \
#     -v "$PWD:/repo" -w /repo/packages/agentd --entrypoint /bin/sh \
#     nefertari-agentd:enforce-test \
#     -c 'sh test/cgroup-delegate.sh && bash test/run-all.sh'
#
# cgroup-delegate.sh moves the container's processes out of the root cgroup so
# `cpu` can be delegated. Without it freezing works but cpu.idle and per-command
# CPU accounting are unavailable, and those tests skip.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

if [ "$#" -gt 0 ]; then
  TESTS=("$@")
else
  TESTS=(timeline timeline-links speculate speculate-child planshape workingset egress journal-chain dedupe leases idle cgroups gatefreeze waitfor inferd mcpsocket run plan trajectories enforce smoke http ocs e2e e2e-hard redteam)
fi

FAILED=()
for t in "${TESTS[@]}"; do
  [ -f "test/$t.mjs" ] || { printf '%-18s skip (no such test)\n' "$t:"; continue; }
  printf '%-18s ' "$t:"
  home="$(mktemp -d "${TMPDIR:-/tmp}/nef-test-XXXXXX")"
  if out="$(NEFERTARI_HOME="$home" node "test/$t.mjs" 2>&1)"; then
    echo "PASS"
  else
    echo "FAIL"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    FAILED+=("$t")
  fi
  rm -rf "$home"
done

echo
if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "ALL TESTS PASSED (${#TESTS[@]})"
  exit 0
fi
echo "FAILED: ${FAILED[*]}"
exit 1
