#!/usr/bin/env sh
# Make cgroup v2 delegation actually work inside a container, so the tests that
# need `cpu` run instead of skipping.
#
# The obstacle is cgroup v2's "no internal processes" rule. A container's root
# cgroup holds every process in the container, and a cgroup that holds processes
# directly cannot hand controllers down to its children — so `+cpu` either fails
# or, worse, is accepted and then makes every child reject a process with EIO.
# (That second case is not hypothetical: it silently broke the freeze, see
# `enableCpu()` in src/cgroups.mjs.)
#
# The fix is the same one systemd uses on a real host: move everything into a
# leaf cgroup so the root holds nothing, and delegate from there.
#
#   docker run --rm --privileged --cgroupns=private --user root \
#     -v "$PWD:/repo" -w /repo/packages/agentd --entrypoint /bin/sh \
#     nefertari-agentd:enforce-test \
#     -c 'sh test/cgroup-delegate.sh && bash test/run-all.sh'
#
# Without this the suite still passes — the cgroup tests skip and say so. With
# it, the freeze, the priority knobs and CPU accounting are actually exercised.
set -u

[ -d /sys/fs/cgroup ] || { echo "no /sys/fs/cgroup"; exit 0; }

mount -o remount,rw /sys/fs/cgroup 2>/dev/null

mkdir -p /sys/fs/cgroup/init || exit 0
# One at a time: cgroup.procs takes a single pid per write, and a process that
# has exited between the read and the write is not an error worth stopping for.
for pid in $(cat /sys/fs/cgroup/cgroup.procs 2>/dev/null); do
  echo "$pid" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null
done

left=$(wc -l < /sys/fs/cgroup/cgroup.procs 2>/dev/null || echo "?")
if [ "$left" != "0" ]; then
  echo "cgroup-delegate: $left process(es) still in the root; cpu delegation will not be available"
  exit 0
fi

if echo "+cpu" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null; then
  echo "cgroup-delegate: cpu delegated from the root"
else
  echo "cgroup-delegate: the root refused +cpu; freezing still works"
fi
