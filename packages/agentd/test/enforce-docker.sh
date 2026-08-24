#!/usr/bin/env bash
# Regression: the shipped container actually enforces reversibility.
#
# The Dockerfile carries the Landlock binary at /usr/local/bin/nefertari-enforce.
# If that ever stops being built, copied, or executable, the landlock driver in
# src/enforce.mjs finds nothing and degrades to fail-open — the daemon keeps
# classifying actions as reversible with nothing holding commands to it. That
# failure is silent, which is exactly why it needs a test.
#
# Verdicts are physical: the test reads the filesystem, never the exit message.
#
#   bash packages/agentd/test/enforce-docker.sh          # builds, then checks
#   IMAGE=my/image bash .../enforce-docker.sh            # checks an existing image
#
# Requires a Linux kernel >= 5.13 under the container runtime. Docker Desktop on
# Windows (WSL2) and macOS both provide one; verified at Landlock ABI 3.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Git Bash on Windows hands out /c/... paths; the Docker CLI needs C:/... .
if command -v cygpath >/dev/null 2>&1; then
  REPO_ROOT="$(cygpath -m "$REPO_ROOT")"
fi
IMAGE="${IMAGE:-nefertari-agentd:enforce-test}"
FAILED=0

note() { printf '%s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=1; }
pass() { printf '  ok    %s\n' "$*"; }

if [ -z "${IMAGE_PREBUILT:-}" ]; then
  note "building $IMAGE from $REPO_ROOT"
  if ! docker build -q -f "$REPO_ROOT/packages/agentd/Dockerfile" -t "$IMAGE" "$REPO_ROOT" >/dev/null; then
    note "build failed"
    exit 1
  fi
fi

note "checking enforcement inside $IMAGE"

# 0 — the binary is present and executable for the non-root runtime user.
if docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'test -x /usr/local/bin/nefertari-enforce'; then
  pass "enforcer present and executable"
else
  fail "enforcer missing from the image — the landlock driver will fail open"
  exit 1
fi

# 1 — a write inside the allowlist succeeds.
OUT=$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c '
  mkdir -p /tmp/allowed
  nefertari-enforce --allow-write /tmp/allowed -- /bin/sh -c "echo ok > /tmp/allowed/f" >/dev/null 2>&1
  cat /tmp/allowed/f 2>/dev/null
')
if [ "$OUT" = "ok" ]; then
  pass "write inside the allowlist succeeds"
else
  fail "write inside the allowlist was blocked (got '${OUT}') — enforcer too strict"
fi

# 2 — a write outside the allowlist is denied, verified on the filesystem.
OUT=$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c '
  mkdir -p /tmp/allowed /tmp/forbidden
  nefertari-enforce --allow-write /tmp/allowed -- /bin/sh -c "echo pwned > /tmp/forbidden/f" >/dev/null 2>&1
  test -e /tmp/forbidden/f && echo LEAKED || echo CONFINED
')
if [ "$OUT" = "CONFINED" ]; then
  pass "write outside the allowlist denied by the kernel"
else
  fail "write outside the allowlist LANDED — enforcement is not active"
fi

# 3 — reads stay allowed everywhere; confinement is about writes, not secrecy.
OUT=$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c '
  mkdir -p /tmp/allowed
  nefertari-enforce --allow-write /tmp/allowed -- /bin/sh -c "head -c 2 /etc/hostname" 2>/dev/null | head -c 2
')
if [ -n "$OUT" ]; then
  pass "reads outside the allowlist still permitted"
else
  fail "reads outside the allowlist were blocked — over-confinement"
fi

if [ "$FAILED" -eq 0 ]; then
  note "PASS — the container enforces reversibility"
  exit 0
fi
note "FAILED — see above"
exit 1
