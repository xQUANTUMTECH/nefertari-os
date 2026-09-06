// Pluggable kernel-level enforcement of the reversibility verdict.
//
// The classifier decides a command is REVERSIBLE; enforcement makes that a
// physical fact by confining the command's WRITES to the working dir (+ /tmp)
// so a classifier false-negative literally cannot write elsewhere. Which
// mechanism does the confining is a DRIVER — Nefertari's core stays neutral:
//
//   null      no confinement (fail-open) — non-Linux hosts, or opt-out
//   landlock  our own nefertari-enforce Rust binary (Landlock, zero external dep) — DEFAULT
//   landrun   the community `landrun` tool (Landlock v5, incl. network rules) — preset
//   custom    ANY sandboxer wired entirely through env vars — no code changes
//
// Pick with NEFERTARI_ENFORCE_DRIVER (default "landlock"; "auto" = landlock else
// fail-open). This is the agnostic contract: we do not depend on any one
// vendor's sandbox — the built-in driver has no dependency, and any external
// tool (Anthropic sandbox-runtime, firejail, bubblewrap…) plugs in as `custom`.
//
// NOISY / system-changing commands (installs, service ops, git) legitimately
// touch system paths and are already surfaced to the human, so they run
// unconfined. Irreversible commands never reach here — they're gated first.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CLASS } from "./broker.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED = process.env.NEFERTARI_ENFORCE === "1";

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Resolve a bare command name against PATH (no spawning). Returns the absolute
// path or null. Absolute/relative inputs are checked directly.
function onPath(name) {
  if (!name) return null;
  if (name.includes("/")) return isExecutable(name) ? name : null;
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

function jsonArray(env, fallback = []) {
  const raw = process.env[env];
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Where the Landlock wrapper lives, or null. Exported because confining a
 * COMMAND and confining the AGENT ITSELF are the same mechanism pointed at
 * different processes, and duplicating the search would let the two disagree
 * about which binary is in use.
 */
export function enforcerPath() {
  const bin =
    process.env.NEFERTARI_ENFORCE_BIN ||
    [
      path.resolve(HERE, "../../enforce/target/release/nefertari-enforce"),
      "/usr/local/bin/nefertari-enforce",
    ].find(isExecutable);
  return bin && isExecutable(bin) ? bin : null;
}

// --- drivers: each returns { file, args } or null when unavailable ---

const drivers = {
  null: () => null, // handled specially (means "run plain"), never "unavailable"

  // Our Rust wrapper. Grants read+exec everywhere, write only to writePaths.
  landlock({ command, writePaths, readPaths }) {
    const bin = enforcerPath();
    if (!bin) return null;
    const args = [];
    for (const w of writePaths) args.push("--allow-write", w);
    for (const r of readPaths) args.push("--allow-read", r);
    args.push("--", "bash", "-lc", command);
    return { file: bin, args };
  },

  // Community `landrun` (github.com/Zouuup/landrun): --rox read+exec, --rw read-write.
  landrun({ command, writePaths, readPaths }) {
    const bin = onPath(process.env.NEFERTARI_LANDRUN_BIN || "landrun");
    if (!bin) return null;
    const args = ["--rox", "/"];
    for (const w of writePaths) args.push("--rw", w);
    for (const r of readPaths) args.push("--ro", r);
    args.push("--", "bash", "-lc", command);
    return { file: bin, args };
  },

  // Wire ANY sandboxer via env — the truly vendor-neutral escape hatch.
  //   NEFERTARI_ENFORCE_CUSTOM_BIN=firejail
  //   NEFERTARI_ENFORCE_CUSTOM_PREARGS=["--quiet","--private-tmp"]
  //   NEFERTARI_ENFORCE_CUSTOM_WRITE_FLAG=--whitelist   (omit to skip write paths)
  //   NEFERTARI_ENFORCE_CUSTOM_READ_FLAG=--read-only    (optional)
  //   NEFERTARI_ENFORCE_CUSTOM_SEP=--                   (default "--"; "" to omit)
  custom({ command, writePaths, readPaths }) {
    const bin = onPath(process.env.NEFERTARI_ENFORCE_CUSTOM_BIN);
    if (!bin) return null;
    const args = [...jsonArray("NEFERTARI_ENFORCE_CUSTOM_PREARGS")];
    const wf = process.env.NEFERTARI_ENFORCE_CUSTOM_WRITE_FLAG;
    const rf = process.env.NEFERTARI_ENFORCE_CUSTOM_READ_FLAG;
    if (wf) for (const w of writePaths) args.push(wf, w);
    if (rf) for (const r of readPaths) args.push(rf, r);
    const sep = process.env.NEFERTARI_ENFORCE_CUSTOM_SEP ?? "--";
    if (sep) args.push(sep);
    args.push("bash", "-lc", command);
    return { file: bin, args };
  },
};

// Which driver to use. "auto" tries landlock and quietly falls open.
function selectedDriver() {
  const name = (process.env.NEFERTARI_ENFORCE_DRIVER || "landlock").toLowerCase();
  return name === "auto" ? "landlock" : name;
}

// Can this host confine a command right now? Not "is the binary there": the
// binary can be there on a kernel without Landlock, and it refuses rather than
// pretend — so it is asked, once. The answer is a property of the host, not of
// the call, and is cached for the life of the process. `net` is false for every
// driver today: Landlock ABI 3 has no network rules, so a confined command can
// still send bytes out, and the classifier keeps treating that as the gate's
// business.
// Cached per driver configuration: tests switch drivers through the
// environment mid-process, and an answer for the wrong driver is worse than none.
let caps, capsKey;
const configKey = () => [selectedDriver(), process.env.NEFERTARI_ENFORCE_BIN, process.env.NEFERTARI_LANDRUN_BIN, process.env.NEFERTARI_ENFORCE_CUSTOM_BIN].join("|");
export function capabilities() {
  if (caps && capsKey === configKey()) return caps;
  capsKey = configKey();
  const off = (reason) => (caps = { ok: false, driver: selectedDriver(), fs: false, net: false, reason });
  const name = selectedDriver();
  if (name === "null") return off("driver null: confinement opted out");
  const driver = drivers[name];
  if (!driver) return off(`unknown enforcement driver "${name}"`);
  const probe = driver({ command: "true", writePaths: ["/tmp"], readPaths: [] });
  if (!probe) return off(`${name}: sandboxer binary not found`);
  // The custom driver is whatever the operator wired in; it has no flag
  // contract to probe, and the declaration is the operator's to keep.
  if (name === "custom") return (caps = { ok: true, driver: name, fs: true, net: false, reason: "custom: sandboxer declared by the operator, not probed; network not confined" });
  const r = spawnSync(probe.file, probe.args, { timeout: 5000, encoding: "utf8" });
  if (r.status !== 0) return off(`${name}: ${((r.stderr || r.stdout || "").trim().split("\n")[0]) || "probe failed"}`);
  return (caps = { ok: true, driver: name, fs: true, net: false, reason: `${name}: writes confined to the working dir; network not confined` });
}
/** Test seam: forget the cached answer (the environment changed). */
export function resetCapabilities() {
  caps = undefined;
}

// Commands whose whole point is to write OUTSIDE the working directory. Noisy
// by classification, and confining them would only make them fail: an
// approved `apt-get install` that cannot touch /usr is a broken promise, not a
// safer one.
const OUTSIDE_CWD =
  /(^|[\s;&|])(sudo\s+)?(apt(-get)?|dpkg|yum|dnf|pacman|brew|snap|systemctl|service|docker|kubectl|pip3? install|cargo install|npm (install|i|ci)\b[^;&|]*(-g|--global))\b/;

// Returns { file, args, enforced, driver } ready for execFile. Reversible
// commands are confined, and so are noisy ones — a command the allowlist did
// not know, running inside a checkpointed working dir, is exactly what the
// sandbox is for. Two things run plain: an irreversible command a human
// approved as written, and a noisy command that exists to write outside the
// working dir (see OUTSIDE_CWD). Falls open to plain bash when the selected
// driver is unavailable, unless NEFERTARI_ENFORCE=1.
export function enforceWrap(command, { cls, cwd }) {
  const plain = { file: "bash", args: ["-lc", command], enforced: false, driver: "null" };
  if (cls === CLASS.IRREVERSIBLE) return plain;
  if (cls === CLASS.NOISY && OUTSIDE_CWD.test(command)) return plain;

  const name = selectedDriver();
  if (name === "null") return plain;

  const driver = drivers[name];
  if (!driver) {
    if (REQUIRED) throw new Error(`NEFERTARI_ENFORCE=1 but enforcement driver "${name}" is unknown`);
    return plain;
  }
  // A binary on a kernel that cannot back it refuses every command it wraps —
  // found the day the enforcer was first built on a host without Landlock, when
  // `ls` started failing with exit 3. Ask the host, not the filesystem.
  const caps = capabilities();
  if (!caps.ok) {
    if (REQUIRED) throw new Error(`NEFERTARI_ENFORCE=1 but ${caps.reason}`);
    return plain;
  }

  const writePaths = [cwd, "/tmp"].filter(Boolean);
  const readPaths = jsonArray("NEFERTARI_ENFORCE_READ_PATHS");
  const wrapped = driver({ command, writePaths, readPaths });
  if (!wrapped) {
    if (REQUIRED) throw new Error(`NEFERTARI_ENFORCE=1 but the "${name}" enforcement driver is not available on this host`);
    return plain;
  }
  return { ...wrapped, enforced: true, driver: name };
}
