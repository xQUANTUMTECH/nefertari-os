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

const SPEC_DIR = () => path.join(TIMELINE_DIR, "speculative");

// How long to wait after a window opens before starting. A model that answers
// instantly should not find the machine busy with work for a call it already
// made; the window is seconds, so a fraction of one costs nothing.
const LEAD_MS = Number(process.env.NEFERTARI_SPECULATE_DELAY_MS) || 250;

const enabled = () => process.env.NEFERTARI_SPECULATE !== "0";

let pending = null; // { id, dir, startedAt, files, tree, done } — the shadow being built or built
let timer = null;
let aborted = false;
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

const yieldToLoop = () => new Promise((r) => setImmediate(r));

/**
 * Build a shadow copy of `dir` in the background. Yields between files and
 * checks for abandonment, so a tool call arriving mid-build stops it inside one
 * file rather than after the whole tree.
 */
async function build(dir, exclude) {
  const id = newId("spec");
  const tree = path.join(SPEC_DIR(), id, "tree");
  // The stamp is taken BEFORE reading anything: a file written while we copy it
  // has an mtime at or after this, so it can never be adopted.
  const startedAt = Date.now();
  fs.mkdirSync(tree, { recursive: true });

  const files = new Map();
  const entries = walk(dir, exclude);
  stats.started += 1;

  for (const e of entries) {
    if (aborted) {
      stats.abandoned += 1;
      try {
        fs.rmSync(path.join(SPEC_DIR(), id), { recursive: true, force: true });
      } catch {
        /* the next sweep will get it */
      }
      return null;
    }
    const src = path.join(dir, e.rel);
    const dst = path.join(tree, e.rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (e.type === "link") {
        const target = fs.readlinkSync(src);
        fs.symlinkSync(target, dst);
        files.set(e.rel, { type: "link", mtimeMs: fs.lstatSync(src).mtimeMs });
      } else {
        const st = fs.statSync(src);
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
        files.set(e.rel, { type: "file", mtimeMs: st.mtimeMs, size: st.size });
      }
    } catch {
      // A file that vanished or cannot be read mid-build is simply not part of
      // the shadow; checkpoint will handle it for real.
    }
    await yieldToLoop();
  }

  stats.completed += 1;
  return { id, dir: path.resolve(dir), startedAt, files, tree, done: true };
}

/** A tool call finished: the window is open. */
export function windowOpen(dir, exclude = ["node_modules"]) {
  if (!enabled() || !dir) return;
  aborted = false;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    ensureHome();
    // One shadow at a time. A second would double the disk cost to hedge a
    // guess, and the guess is already cheap to be wrong about.
    if (pending) return;
    try {
      pending = await build(dir, exclude);
    } catch {
      pending = null;
    }
  }, LEAD_MS);
  timer.unref?.();
}

/** A tool call arrived: the window is closed, and real work has priority. */
export function windowClose() {
  aborted = true;
  clearTimeout(timer);
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
    enabled: enabled(),
  };
}

/** Test seam. */
export function reset() {
  clearTimeout(timer);
  aborted = false;
  pending = null;
  for (const k of Object.keys(stats)) stats[k] = 0;
}
