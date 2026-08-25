// Doing the work before it is asked for, in the window where it is free.
//
// After every tool call there are seconds in which the model thinks and this
// machine does nothing — measured at 99-100% of a multi-step run. agentd is the
// only process on the host that sees both edges of that window, so it is the
// only one that can put work into it.
//
// The work chosen here is the copy that `timeline_checkpoint` will have to make
// anyway. Doing it early turns a checkpoint from "copy the tree" into "check the
// tree has not moved", which is stat-per-file instead of read-per-byte.
//
// THE CORRECTNESS RULE, which matters more than the speed-up:
//
//   A pre-built copy is adopted for a file ONLY IF that file's mtime is
//   strictly older than the moment the pre-build started reading.
//
// Anything touched at or after that instant is re-copied at checkpoint time, no
// matter what its size or mtime say. This is deliberately stricter than the
// mtime-and-size comparison that build systems settle for: a file written
// inside the same millisecond as the stamp would slip through that, and here
// the cost of slipping through is a checkpoint that silently disagrees with the
// tree it claims to be a copy of — a restore that quietly loses work. A
// speculative optimisation must never be able to produce a wrong answer, only a
// useless one.
//
// The other rule is that this must never compete with real work: the pre-build
// yields between files and is abandoned the instant a tool call arrives.

import fs from "node:fs";
import path from "node:path";
import { TIMELINE_DIR, ensureHome } from "./paths.mjs";
import { newId } from "./journal.mjs";
import { spawn } from "node:child_process";
import * as cgroups from "./cgroups.mjs";

const SPEC_DIR = () => path.join(TIMELINE_DIR, "speculative");

// How long to wait after a window opens before starting. A model that answers
// instantly should not find the machine busy with work for a call it already
// made; the window is seconds, so a fraction of one costs nothing.
const LEAD_MS = Number(process.env.NEFERTARI_SPECULATE_DELAY_MS) || 250;

const enabled = () => process.env.NEFERTARI_SPECULATE !== "0";

let pending = null; // { id, dir, startedAt, files, tree, done } — the finished shadow
let running = null; // { id, out, child, group } — the child currently copying
let timer = null;
const stats = { started: 0, completed: 0, abandoned: 0, adopted: 0, rejected: 0, files_reused: 0, files_restaled: 0 };

function walk(root, exclude, rel = "", out = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if ((e.isDirectory() || e.isSymbolicLink()) && exclude.includes(e.name)) continue;
    if (e.isSymbolicLink()) out.push({ rel: r, type: "link" });
    else if (e.isDirectory()) walk(root, exclude, r, out);
    else if (e.isFile()) out.push({ rel: r, type: "file" });
  }
  return out;
}

const PREBUILD = path.join(import.meta.dirname, "prebuild.mjs");

/**
 * Start the shadow copy as a CHILD, and return the handle to it.
 *
 * It used to run here, yielding to the event loop between files. That is fine
 * until one file is large: `copyFileSync` does not yield, so a single big file
 * blocked the daemon — and the daemon is what every tool call goes through.
 * Speculation that can stall a real call is worse than none, because the cost
 * lands on exactly the path it was meant to make faster.
 *
 * In a child, two things become possible that were not: the copy can be put
 * under `cpu.idle`, where it runs only when nothing else wants the CPU, and it
 * can be KILLED when a tool call arrives. Killing is instant and total;
 * abandoning a loop is neither.
 */
function startChild(dir, exclude) {
  const id = newId("spec");
  const out = path.join(SPEC_DIR(), id);
  fs.mkdirSync(out, { recursive: true });

  const argv = [PREBUILD, path.resolve(dir), out, ...exclude];
  const group = `spec-${process.pid}-${id}`;
  const cg = cgroups.ensure(group);
  let background = false;
  if (cg.ok) background = cgroups.setBackground(group).ok === true;

  // The child joins its own cgroup before exec. Moving it afterwards is a race
  // the mover usually loses, and here losing it means the copy runs at normal
  // priority — competing with the very work it exists to stay out of.
  const child = cg.ok
    ? spawn("/bin/sh", ["-c", `echo $$ > ${cgroups.procsPath(group)}; exec "$0" "$@"`, process.execPath, ...argv], {
        stdio: "ignore",
      })
    : spawn(process.execPath, argv, { stdio: "ignore" });

  child.unref();
  stats.started += 1;
  return { id, out, child, group: cg.ok ? group : null, background };
}

/** Read what the child produced, or null if it did not finish. */
function adoptChild(job, dir) {
  let manifest;
  try {
    // The manifest is renamed into place last, so its presence is the proof
    // that the copy completed. A partial tree simply has none.
    manifest = JSON.parse(fs.readFileSync(path.join(job.out, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
  const files = new Map(Object.entries(manifest.files || {}));
  stats.completed += 1;
  return {
    id: job.id,
    dir: path.resolve(dir),
    startedAt: manifest.startedAt,
    files,
    tree: path.join(job.out, "tree"),
    done: true,
    background: job.background,
  };
}

function stopChild(job) {
  if (!job) return;
  try {
    job.child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  if (job.group) cgroups.destroy(job.group);
}

/** A tool call finished: the window is open. */
export function windowOpen(dir, exclude = ["node_modules"]) {
  if (!enabled() || !dir) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    ensureHome();
    // One shadow at a time. A second would double the disk cost to hedge a
    // guess that is already cheap to be wrong about.
    if (pending || running) return;
    try {
      const job = startChild(dir, exclude);
      running = job;
      job.child.on("exit", () => {
        if (running !== job) return; // abandoned; windowClose already cleaned up
        running = null;
        const built = adoptChild(job, dir);
        if (built) {
          pending = built;
        } else {
          stats.abandoned += 1;
          try {
            fs.rmSync(job.out, { recursive: true, force: true });
          } catch {
            /* swept later */
          }
        }
        if (job.group) cgroups.destroy(job.group);
      });
    } catch {
      running = null;
    }
  }, LEAD_MS);
  timer.unref?.();
}

/** A tool call arrived: the window is closed, and real work has priority. */
export function windowClose() {
  clearTimeout(timer);
  if (!running) return;
  const job = running;
  running = null;
  stats.abandoned += 1;
  stopChild(job);
  // Removed rather than kept: a half-copied tree with no manifest is useless,
  // and disk left behind by an optimisation is the optimisation costing money.
  try {
    fs.rmSync(job.out, { recursive: true, force: true });
  } catch {
    /* swept later */
  }
}

/**
 * Offer the pre-built copy to a checkpoint of `dir`.
 *
 * Returns null when there is nothing usable — a different directory, an
 * unfinished build, or none at all — and the caller copies as it always did.
 *
 * When there IS one, returns { tree, reuse, restale } where `reuse` names the
 * files whose mtime is strictly older than the build's start (safe to take from
 * the shadow) and `restale` names every other file the tree currently holds.
 * The caller must copy `restale` itself. Nothing here decides that a file is
 * unchanged because it looks unchanged: it decides only that a file was
 * definitely not touched after we read it.
 */
export function claim(dir, exclude = ["node_modules"]) {
  if (!pending || !pending.done) return null;
  if (path.resolve(dir) !== pending.dir) {
    stats.rejected += 1;
    return null;
  }

  const current = walk(dir, exclude);
  const reuse = [];
  const restale = [];

  for (const e of current) {
    const rec = pending.files.get(e.rel);
    if (!rec || rec.type !== e.type) {
      restale.push(e);
      continue;
    }
    let st;
    try {
      st = e.type === "link" ? fs.lstatSync(path.join(dir, e.rel)) : fs.statSync(path.join(dir, e.rel));
    } catch {
      restale.push(e);
      continue;
    }
    // Strictly older. Equality is not good enough: a write inside the same
    // millisecond as the stamp is indistinguishable from one before it.
    const untouched = st.mtimeMs < pending.startedAt && (e.type === "link" || st.size === rec.size);
    if (untouched) reuse.push(e);
    else restale.push(e);
  }

  stats.adopted += 1;
  stats.files_reused += reuse.length;
  stats.files_restaled += restale.length;
  const tree = pending.tree;
  // Claimed once: the shadow is consumed by the checkpoint that takes it, and
  // leaving it around would invite a second, older adoption.
  const consumed = pending;
  pending = null;
  queueMicrotask(() => {
    try {
      fs.rmSync(path.join(SPEC_DIR(), consumed.id), { recursive: true, force: true });
    } catch {
      /* swept later */
    }
  });
  return { tree, reuse, restale };
}

/** What speculation has actually bought, for sys_status and the benchmark. */
export function speculationStats() {
  return {
    ...stats,
    ready: Boolean(pending?.done),
    // Said rather than implied: without cgroup v2 the copy still runs in a
    // child, but at ordinary priority.
    background: Boolean(pending?.background ?? running?.background),
    enabled: enabled(),
  };
}

/** Test seam. */
export function reset() {
  clearTimeout(timer);
  stopChild(running);
  running = null;
  pending = null;
  for (const k of Object.keys(stats)) stats[k] = 0;
}
