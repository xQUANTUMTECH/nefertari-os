// cgroups v2: the handle by which the OS holds a piece of work.
//
// Two halves. The first runs everywhere and checks the thing that matters most
// on the hosts people actually have: that an unavailable facility degrades to a
// clear "no" rather than an exception, and explains itself. The second needs a
// writable /sys/fs/cgroup and runs the real mechanism — freeze a process, watch
// cgroup.events say so, thaw it — and SKIPS with the reason otherwise.
//
// A test that silently passed where the mechanism is absent would be worse than
// no test: it would report a working freeze on every laptop in the world.
//
//   docker run --rm --privileged --cgroupns=private --user root \
//     -v "$PWD:/repo" -w /repo/packages/agentd --entrypoint /bin/sh IMAGE \
//     -c 'mount -o remount,rw /sys/fs/cgroup; node test/cgroups.mjs'
import fs from "node:fs";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import * as cg from "../src/cgroups.mjs";

const NAME = "test-" + Math.random().toString(36).slice(2, 8);

// --- everywhere: an honest "no" ---
{
  const a = cg.available();
  assert.equal(typeof a.ok, "boolean");
  if (!a.ok) {
    assert.ok(a.reason && a.reason.length > 20, "an unavailable facility must explain itself, not just refuse");
    // The reason has to be actionable: it is the only thing an operator sees.
    assert.ok(
      /Delegate=yes|--privileged|Linux|cgroup v2/.test(a.reason),
      `the reason must name what to do or why not: "${a.reason}"`
    );
    // And nothing may throw.
    for (const call of [
      () => cg.ensure(NAME),
      () => cg.move(NAME, process.pid),
      () => cg.freeze(NAME),
      () => cg.thaw(NAME),
      () => cg.setBackground(NAME),
      () => cg.destroy(NAME),
    ]) {
      const r = call();
      assert.equal(r.ok, false, "every call must answer, not throw");
      assert.ok(r.reason, "and say why");
    }
    assert.equal(cg.frozen(NAME), null, "frozen() is null when unknowable, never false");
    assert.equal(cg.usage(NAME), null);
    console.log(`  ok — unavailable here, and it says so: ${a.reason.slice(0, 90)}…`);
    console.log("  skip — the real mechanism needs a writable /sys/fs/cgroup");
    console.log("CGROUP TESTS PASSED (degradation only)");
    process.exit(0);
  }
  console.log(`  ok — available: ${a.controllers.join(" ")}`);
}

// --- where it is real: the mechanism ---
const g = cg.ensure(NAME);
assert.ok(g.ok, `ensure must succeed when available: ${g.reason}`);
assert.ok(fs.existsSync(g.path));
console.log(`  ok — group created${g.cpu ? " with cpu control" : " (cpu controller not delegated)"}`);

const child = spawn("sleep", ["300"], { stdio: "ignore" });
try {
  const m = cg.move(NAME, child.pid);
  assert.ok(m.ok, `move must succeed: ${m.reason}`);
  assert.equal(cg.frozen(NAME), false, "a fresh group is not frozen");
  console.log("  ok — a process is under the group's control");

  const f = cg.freeze(NAME);
  assert.ok(f.ok, `freeze must succeed: ${f.reason}`);
  await sleep(300);
  assert.equal(cg.frozen(NAME), true, "cgroup.events must report frozen — /proc's state letter does not change");
  console.log("  ok — frozen, verified from cgroup.events");

  const t = cg.thaw(NAME);
  assert.ok(t.ok, `thaw must succeed: ${t.reason}`);
  await sleep(300);
  assert.equal(cg.frozen(NAME), false, "and it comes back");
  console.log("  ok — thawed");

  const bg = cg.setBackground(NAME);
  if (g.cpu) {
    assert.ok(bg.ok, `setBackground must succeed where cpu is delegated: ${bg.reason}`);
    assert.ok(["cpu.idle", "cpu.weight=1"].includes(bg.mechanism));
    if (bg.mechanism === "cpu.weight=1") assert.ok(bg.note, "the weaker guarantee must be stated, not implied");
    console.log(`  ok — background priority via ${bg.mechanism}${bg.preemptible ? " (preemptible)" : ""}`);
  } else {
    assert.equal(bg.ok, false, "without a delegated cpu controller this must refuse, not pretend");
    console.log("  ok — refuses background priority where cpu was not delegated");
  }

  const u = cg.usage(NAME);
  assert.ok(u === null || typeof u.usage_usec === "number");

  const d = cg.destroy(NAME);
  assert.equal(d.ok, false, "destroying an occupied group must refuse rather than kill its processes");
  assert.ok(d.pids.length >= 1);
  console.log("  ok — refuses to destroy a group that still holds work");
} finally {
  child.kill("SIGKILL");
}

await sleep(300);
assert.ok(cg.destroy(NAME).ok, "an empty group is removable");
console.log("  ok — an empty group is removed");
console.log("CGROUP TESTS PASSED");
