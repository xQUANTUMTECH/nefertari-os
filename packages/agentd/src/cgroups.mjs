// cgroups v2 — the handle by which the OS holds a piece of work.
//
// Everything in the hardware chapter needs the same thing first: the ability to
// name a set of processes and then say something about them as a set. Freeze a
// goal that is waiting at the human gate so it costs nothing. Run the
// speculative pre-work of the inference window at a priority that yields to the
// first real tool call. Give the local inference service a lifecycle that is
// ours rather than its own. None of that is possible while every process the
// daemon spawns is just another child in whatever cgroup the daemon happens to
// be in.
//
// **This degrades to nothing, loudly.** cgroups need Linux, a writable
// /sys/fs/cgroup, and delegation — none of which hold on macOS, on Windows, or
// in an ordinary container. A daemon that refused to start without them would
// be useless in exactly the deployments people actually have, so every function
// here answers "unavailable" instead of throwing, and `available()` says why in
// a sentence a human can act on.
//
// Verified on Docker Desktop / WSL2, kernel 6.6: with root and a writable
// mount, `cpu` delegation works, `cpu.idle` and `cpu.weight` appear, and freeze
// reports `frozen 0 → 1 → 0` in cgroup.events. Under systemd on a real host the
// supported path is `Delegate=yes` on the unit, which grants a writable subtree
// without privileged mode.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.env.NEFERTARI_CGROUP_ROOT || "/sys/fs/cgroup";
// Everything this daemon creates lives under one parent, so a crash leaves a
// single directory to clean up rather than orphans scattered across the tree.
const PARENT = process.env.NEFERTARI_CGROUP_PARENT || "nefertari";

const parentPath = () => path.join(ROOT, PARENT);
const groupPath = (name) => path.join(parentPath(), name);

function read(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}

function write(p, value) {
  try {
    fs.writeFileSync(p, String(value));
    return true;
  } catch (e) {
    return e.code || "EFAIL";
  }
}

let cached = null;

/**
 * Whether this host can be told about groups of processes, and if not, why.
 * Cached: the answer cannot change without the daemon restarting, and probing
 * the filesystem on every tool call to learn the same thing is the sort of cost
 * that ends with the feature turned off.
 */
export function available() {
  if (cached) return cached;

  if (process.platform !== "linux") {
    cached = { ok: false, reason: `cgroups are a Linux facility; this host is ${process.platform}` };
    return cached;
  }
  if (!fs.existsSync(path.join(ROOT, "cgroup.controllers"))) {
    cached = { ok: false, reason: `no cgroup v2 at ${ROOT} (v1 hierarchies are not supported)` };
    return cached;
  }

  // Writability is the real question, and the only honest way to ask it is to
  // try: the mount can be read-only, the process can lack privileges, or the
  // subtree can be undelegated, and each looks identical from a stat().
  try {
    fs.mkdirSync(parentPath(), { recursive: true });
  } catch (e) {
    cached = {
      ok: false,
      reason:
        `cannot create ${parentPath()}: ${e.code}. ` +
        `Under systemd give the unit Delegate=yes; in Docker run with --privileged and remount ` +
        `/sys/fs/cgroup rw. Without it, freezing and priority control are unavailable and every ` +
        `other guarantee still holds.`,
    };
    return cached;
  }

  const controllers = (read(path.join(ROOT, "cgroup.controllers")) || "").split(/\s+/).filter(Boolean);
  cached = { ok: true, root: ROOT, parent: parentPath(), controllers };
  return cached;
}

/**
 * Ask the parent to hand `cpu` down to its children.
 *
 * Fails while the parent still holds processes directly — cgroup v2's "no
 * internal processes" rule — and that failure is not an error to hide: it means
 * this deployment put the daemon somewhere that cannot delegate, and priority
 * control will be missing while freezing still works. Both facts are reported.
 */
function enableCpu() {
  // Delegation is not a property of one directory, it is a chain: a child only
  // has cpu knobs if EVERY ancestor passed cpu down to it. Writing to the
  // immediate parent alone silently does nothing, and the symptom is a group
  // that exists and freezes perfectly while cpu.idle is simply absent — which
  // looks like an old kernel rather than a missing write.
  for (const dir of [ROOT, parentPath()]) {
    const p = path.join(dir, "cgroup.subtree_control");
    if (!fs.existsSync(p)) return false;
    if ((read(p) || "").includes("cpu")) continue;
    // Refused while the cgroup still holds processes directly (v2's "no
    // internal processes" rule). Not fatal: freezing works regardless, and the
    // caller is told which half it got.
    if (write(p, "+cpu") !== true) return false;
  }
  return true;
}

/** Create (or adopt) a named group. Returns { ok, path, cpu } or { ok: false, reason }. */
export function ensure(name) {
  const a = available();
  if (!a.ok) return { ok: false, reason: a.reason };
  const dir = groupPath(name);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `cannot create ${dir}: ${e.code}` };
  }
  // Whether cpu knobs exist is a property of this group, discovered rather than
  // assumed: delegation can be refused for reasons that have nothing to do with
  // us, and a caller that assumed cpu.idle exists would crash on a host where
  // freeze works perfectly well.
  const cpu = enableCpu() && fs.existsSync(path.join(dir, "cpu.idle"));
  return { ok: true, path: dir, cpu };
}

/**
 * Where a process writes its own pid to join the group. Handed out so a child
 * can place ITSELF before exec: moving it afterwards is a race it usually
 * loses — a shell forks its pipeline within microseconds, and those
 * grandchildren stay wherever the shell was when it forked them. Measured, that
 * race reported a busy pipeline as 507us of CPU and a sleep as 11655us.
 */
export function procsPath(name) {
  return path.join(groupPath(name), "cgroup.procs");
}

/** Put a process under this group's control. Children it spawns follow it. */
export function move(name, pid) {
  const a = available();
  if (!a.ok) return { ok: false, reason: a.reason };
  const r = write(path.join(groupPath(name), "cgroup.procs"), pid);
  return r === true ? { ok: true } : { ok: false, reason: `cannot move pid ${pid}: ${r}` };
}

/**
 * Stop every process in the group without killing anything: zero CPU, memory
 * untouched, resumable in milliseconds. This is what a goal waiting at the
 * human gate should cost, and what the inference service should cost the
 * instant a real tool call arrives.
 */
export function freeze(name) {
  const a = available();
  if (!a.ok) return { ok: false, reason: a.reason };
  const r = write(path.join(groupPath(name), "cgroup.freeze"), "1");
  return r === true ? { ok: true, frozen: true } : { ok: false, reason: `cannot freeze: ${r}` };
}

export function thaw(name) {
  const a = available();
  if (!a.ok) return { ok: false, reason: a.reason };
  const r = write(path.join(groupPath(name), "cgroup.freeze"), "0");
  return r === true ? { ok: true, frozen: false } : { ok: false, reason: `cannot thaw: ${r}` };
}

/**
 * Whether the group is frozen, read from cgroup.events rather than inferred
 * from a process state letter in /proc — which reports the same `S` frozen or
 * not, and would make a broken freeze look like a working one.
 */
export function frozen(name) {
  const ev = read(path.join(groupPath(name), "cgroup.events"));
  if (ev === null) return null;
  const m = /^frozen\s+(\d)$/m.exec(ev);
  return m ? m[1] === "1" : null;
}

/**
 * Mark the group as background work: it runs only when nothing else wants the
 * CPU, and the first real tool call preempts it. This is the mechanism the
 * inference window needs — speculative pre-work that cannot possibly slow down
 * the thing it is preparing for.
 *
 * `cpu.idle` needs kernel >= 6.0 and a delegated cpu controller; where it is
 * missing the fallback is the lowest possible weight, which is not the same
 * guarantee (it still competes, just badly) and says so.
 */
export function setBackground(name) {
  const a = available();
  if (!a.ok) return { ok: false, reason: a.reason };
  const dir = groupPath(name);
  if (fs.existsSync(path.join(dir, "cpu.idle"))) {
    const r = write(path.join(dir, "cpu.idle"), "1");
    if (r === true) return { ok: true, mechanism: "cpu.idle", preemptible: true };
  }
  if (fs.existsSync(path.join(dir, "cpu.weight"))) {
    const r = write(path.join(dir, "cpu.weight"), "1");
    if (r === true) {
      return {
        ok: true,
        mechanism: "cpu.weight=1",
        preemptible: false,
        note: "cpu.idle unavailable (needs kernel >= 6.0): this work competes at the lowest weight rather than yielding outright",
      };
    }
  }
  return { ok: false, reason: "neither cpu.idle nor cpu.weight is available: the cpu controller was not delegated" };
}

/** What the group has actually consumed, for the journal and for sys_status. */
export function usage(name) {
  const stat = read(path.join(groupPath(name), "cpu.stat"));
  if (stat === null) return null;
  const out = {};
  for (const line of stat.split("\n")) {
    const [k, v] = line.split(/\s+/);
    if (k && v !== undefined) out[k] = Number(v);
  }
  return { usage_usec: out.usage_usec ?? null, nr_periods: out.nr_periods ?? null };
}

/**
 * Remove the group. Refuses while processes remain, which is the kernel's rule
 * and a good one: silently killing them to tidy up a directory would be the
 * daemon deciding to end work nobody asked it to end.
 */
export function destroy(name) {
  const a = available();
  // Checked first: reporting success because the directory is absent would tell
  // a host that never had cgroups that it had just cleaned some up.
  if (!a.ok) return { ok: false, reason: a.reason };
  const dir = groupPath(name);
  if (!fs.existsSync(dir)) return { ok: true };
  const procs = (read(path.join(dir, "cgroup.procs")) || "").split("\n").filter(Boolean);
  if (procs.length) return { ok: false, reason: `${procs.length} process(es) still in the group`, pids: procs };
  try {
    fs.rmdirSync(dir);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.code };
  }
}

/** Test seam: forget the probe. */
export function reset() {
  cached = null;
}
