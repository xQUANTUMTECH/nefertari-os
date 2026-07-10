// Time as a primitive: tree-level checkpoint / fork / restore / promote.
//
// snapshots.mjs is the safety net (per-file undo of one action). timeline.mjs is
// the performance engine: whole-tree state the agent can BRANCH on — checkpoint a
// working dir, fork it into K isolated copies (one per teammate / strategy), run
// them in parallel, promote the winner. Restore and promote auto-checkpoint the
// current tree first, so time travel is itself undoable.
//
// Backend = plain file copy (works on any host). The interface is stable so a
// CoW backend (btrfs/ZFS/overlayfs) can replace it without touching callers.

import fs from "node:fs";
import path from "node:path";
import { TIMELINE_DIR, ensureHome } from "./paths.mjs";
import { newId } from "./journal.mjs";

const DEFAULT_EXCLUDE = ["node_modules"];

function maxBytes() {
  const mb = Number(process.env.NEFERTARI_TIMELINE_MAX_MB) || 512;
  return mb * 1024 * 1024;
}

function ckptDir(id) {
  return path.join(TIMELINE_DIR, "checkpoints", id);
}
function forkDir(id) {
  return path.join(TIMELINE_DIR, "forks", id);
}

function readManifest(dir, kind, id) {
  const p = path.join(dir, "manifest.json");
  if (!fs.existsSync(p)) throw new Error(`${kind} not found: ${id}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Walk a tree, skipping excluded directory names at any depth.
// Returns relative file paths (POSIX separators for manifest stability).
function walk(root, exclude, rel = "", out = []) {
  const abs = path.join(root, rel);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue; // phase 1: links are not tracked
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!exclude.includes(e.name)) walk(root, exclude, r, out);
    } else if (e.isFile()) {
      out.push(r);
    }
  }
  return out;
}

function copyFiles(srcRoot, dstRoot, files) {
  for (const r of files) {
    const dst = path.join(dstRoot, r);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(srcRoot, r), dst);
  }
}

// Remove now-empty directories left behind by a restore (never touches excluded ones).
function pruneEmptyDirs(root, exclude, rel = "") {
  const abs = path.join(root, rel);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!e.isDirectory() || exclude.includes(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    pruneEmptyDirs(root, exclude, r);
    if (fs.readdirSync(path.join(root, r)).length === 0) fs.rmdirSync(path.join(root, r));
  }
}

// ---- checkpoint ----
export function checkpoint(dir, { label = "", exclude = DEFAULT_EXCLUDE, meta = {} } = {}) {
  ensureHome();
  const src = path.resolve(dir);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`not a directory: ${src}`);

  const files = walk(src, exclude);
  let bytes = 0;
  for (const r of files) bytes += fs.statSync(path.join(src, r)).size;
  if (bytes > maxBytes()) {
    throw new Error(
      `tree is ${Math.round(bytes / 1e6)} MB, over the ${Math.round(maxBytes() / 1e6)} MB checkpoint guard ` +
        `(raise NEFERTARI_TIMELINE_MAX_MB or exclude heavy dirs)`
    );
  }

  const id = newId("ckpt");
  const base = ckptDir(id);
  copyFiles(src, path.join(base, "tree"), files);
  const manifest = {
    id,
    kind: "checkpoint",
    label,
    dir: src,
    exclude,
    files: files.length,
    bytes,
    createdAt: new Date().toISOString(),
    meta,
  };
  fs.writeFileSync(path.join(base, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ---- fork: K isolated working copies of a checkpoint ----
export function fork(checkpointId, n = 1) {
  readManifest(ckptDir(checkpointId), "checkpoint", checkpointId); // existence check
  const srcTree = path.join(ckptDir(checkpointId), "tree");
  const files = walk(srcTree, []);
  const forks = [];
  for (let i = 0; i < n; i++) {
    const id = newId("fork");
    const base = forkDir(id);
    const tree = path.join(base, "tree");
    copyFiles(srcTree, tree, files);
    const manifest = { id, kind: "fork", from: checkpointId, path: tree, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(base, "manifest.json"), JSON.stringify(manifest, null, 2));
    forks.push(manifest);
  }
  return forks;
}

// Make `dir` identical to `srcTree` (checkpoint or fork content), leaving
// excluded dirs untouched at any depth. Deletes files that exist now but not in
// the source, then copies the source over.
function syncTree(srcTree, dir, exclude) {
  const want = new Set(walk(srcTree, []));
  const have = walk(dir, exclude);
  for (const r of have) if (!want.has(r)) fs.rmSync(path.join(dir, r));
  pruneEmptyDirs(dir, exclude);
  copyFiles(srcTree, dir, [...want]);
}

// ---- restore: put a working dir back to checkpoint T (auto-checkpoint first) ----
export function restoreTo(checkpointId, dir) {
  const cm = readManifest(ckptDir(checkpointId), "checkpoint", checkpointId);
  const target = path.resolve(dir || cm.dir);
  const safety = checkpoint(target, {
    label: `auto before restore to ${checkpointId}`,
    exclude: cm.exclude,
    meta: { auto: true, restoreTo: checkpointId },
  });
  syncTree(path.join(ckptDir(checkpointId), "tree"), target, cm.exclude);
  return { restored_to: checkpointId, dir: target, safety_checkpoint: safety.id };
}

// ---- promote: a winning fork becomes the working dir (auto-checkpoint first) ----
export function promote(forkId, dir) {
  const fm = readManifest(forkDir(forkId), "fork", forkId);
  const cm = readManifest(ckptDir(fm.from), "checkpoint", fm.from);
  const target = path.resolve(dir || cm.dir);
  const safety = checkpoint(target, {
    label: `auto before promote of ${forkId}`,
    exclude: cm.exclude,
    meta: { auto: true, promote: forkId },
  });
  syncTree(fm.path, target, cm.exclude);
  return { promoted: forkId, from_checkpoint: fm.from, dir: target, safety_checkpoint: safety.id };
}

export function list() {
  ensureHome();
  const out = [];
  for (const [sub, kind] of [
    ["checkpoints", "checkpoint"],
    ["forks", "fork"],
  ]) {
    const base = path.join(TIMELINE_DIR, sub);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, "manifest.json");
      if (fs.existsSync(p)) out.push(JSON.parse(fs.readFileSync(p, "utf8")));
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
