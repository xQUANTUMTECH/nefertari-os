// Time as a primitive: tree-level checkpoint / fork / restore / promote.
//
// snapshots.mjs is the safety net (per-file undo of one action). timeline.mjs is
// the performance engine: whole-tree state the agent can BRANCH on — checkpoint a
// working dir, fork it into K isolated copies (one per teammate / strategy), run
// them in parallel, promote the winner. Restore and promote auto-checkpoint the
// current tree first, so time travel is itself undoable.
//
// Backend = plain file copy (works on any host), with a clone fast path where the
// filesystem offers one. The interface is stable so a CoW backend (btrfs/ZFS/
// overlayfs) can replace it without touching callers.

import fs from "node:fs";
import path from "node:path";
import { TIMELINE_DIR, ensureHome } from "./paths.mjs";
import { newId } from "./journal.mjs";
import * as speculate from "./speculate.mjs";

// Directory names never copied into a checkpoint. These are reproducible from a
// manifest and dwarf the source they belong to, so copying them K times would
// make forking cost more than the work being forked. See linkExcluded() for how
// a fork still reaches them.
const DEFAULT_EXCLUDE = ["node_modules"];

// Ask the kernel to clone rather than copy where the filesystem supports it
// (btrfs, XFS with reflink=1, APFS). Node falls back to a full copy on its own
// when the filesystem says no, so this is free everywhere and fast where it counts.
const CLONE = fs.constants.COPYFILE_FICLONE;

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
//
// Returns entries, not bare paths, because a symlink has to survive the round
// trip AS a symlink: pnpm and bun build node_modules out of links, and a tree
// whose links were dropped is not a copy of anything — it is a tree that no
// longer installs, builds or tests. Links are recorded by target and never
// followed, which also makes cycles impossible.
function walk(root, exclude, rel = "", out = []) {
  const abs = path.join(root, rel);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    // An excluded name is excluded whatever it is. A fork carries a LINK named
    // after each excluded dir; matching only real directories here would let
    // that link travel back on promote and replace the original with a link to
    // itself.
    if ((e.isDirectory() || e.isSymbolicLink()) && exclude.includes(e.name)) continue;
    if (e.isSymbolicLink()) {
      out.push({ rel: r, type: "link", target: fs.readlinkSync(path.join(root, r)) });
    } else if (e.isDirectory()) {
      if (!exclude.includes(e.name)) walk(root, exclude, r, out);
    } else if (e.isFile()) {
      out.push({ rel: r, type: "file" });
    }
  }
  return out;
}

const rels = (entries) => entries.map((e) => e.rel);

// Reproduce `entries` from srcRoot into dstRoot: files copied (cloned where the
// filesystem allows), links recreated pointing at the same target.
function materialize(srcRoot, dstRoot, entries) {
  for (const e of entries) {
    const dst = path.join(dstRoot, e.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (e.type === "link") {
      if (path.resolve(path.dirname(dst), e.target) === path.resolve(dst)) continue; // self-link
      try {
        fs.rmSync(dst, { force: true, recursive: false });
      } catch {
        /* nothing there, or a directory we are about to fail on loudly */
      }
      fs.symlinkSync(e.target, dst);
      continue;
    }
    try {
      fs.copyFileSync(path.join(srcRoot, e.rel), dst, CLONE);
    } catch (err) {
      // Windows refuses to overwrite read-only destinations with EPERM —
      // git marks .git/objects/* read-only, so any tree containing a repo
      // would brick restore/promote. Clear the bit and retry once.
      if (err.code !== "EPERM" && err.code !== "EACCES") throw err;
      fs.chmodSync(dst, 0o644);
      fs.copyFileSync(path.join(srcRoot, e.rel), dst, CLONE);
    }
  }
}

// Remove now-empty directories left behind by a restore (never touches excluded ones).
function pruneEmptyDirs(root, exclude, rel = "") {
  const abs = path.join(root, rel);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isSymbolicLink() || !e.isDirectory() || exclude.includes(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    pruneEmptyDirs(root, exclude, r);
    if (fs.readdirSync(path.join(root, r)).length === 0) fs.rmdirSync(path.join(root, r));
  }
}

// The three heaviest directories in a tree, so an over-budget checkpoint can say
// WHAT to exclude instead of only how far over it is.
function heaviest(root, entries, n = 3) {
  const byTop = new Map();
  for (const e of entries) {
    if (e.type !== "file") continue;
    const top = e.rel.split("/")[0];
    let size = 0;
    try {
      size = fs.statSync(path.join(root, e.rel)).size;
    } catch {
      /* vanished mid-walk */
    }
    byTop.set(top, (byTop.get(top) || 0) + size);
  }
  return [...byTop.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, bytes]) => `${name} (${Math.round(bytes / 1e6)} MB)`);
}

// A fork is made from the checkpoint TREE, which never held the excluded dirs.
// Without them `npm test` in a fork cannot resolve a single import, so the one
// thing forks exist for — running the real suite down K branches at once — does
// not run. Linking each excluded dir back at the original is what makes it work
// at zero copy cost.
//
// Writes through such a link land on the ORIGINAL path, which the Landlock
// enforcer refuses because it is outside the fork's allowlist: the link gives a
// fork read access to its dependencies and nothing more. With enforcement off
// (NEFERTARI_ENFORCE_DRIVER=null, or a non-Linux host) that protection is gone
// and a fork could write into the shared directory — set
// NEFERTARI_TIMELINE_LINK_EXCLUDED=0 there.
// existsSync() follows the link and answers false for a dangling one, which is
// exactly the case that then fails EEXIST on create.
function lexists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function linkExcluded(originDir, treeDir, exclude) {
  if (process.env.NEFERTARI_TIMELINE_LINK_EXCLUDED === "0") return [];
  const linked = [];
  for (const name of exclude) {
    const src = path.join(originDir, name);
    const dst = path.join(treeDir, name);
    if (!fs.existsSync(src) || lexists(dst)) continue;
    try {
      fs.symlinkSync(src, dst, "junction");
      linked.push(name);
    } catch {
      // Windows without developer mode refuses symlinks to a non-admin. Not
      // fatal: the fork simply lacks its dependencies, which is the old behaviour.
    }
  }
  return linked;
}

// ---- checkpoint ----
export function checkpoint(dir, { label = "", exclude = DEFAULT_EXCLUDE, meta = {} } = {}) {
  ensureHome();
  const src = path.resolve(dir);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`not a directory: ${src}`);

  const entries = walk(src, exclude);
  let bytes = 0;
  for (const e of entries) {
    if (e.type !== "file") continue; // a link costs its target's name, not its target
    try {
      bytes += fs.statSync(path.join(src, e.rel)).size;
    } catch {
      /* vanished mid-walk */
    }
  }
  if (bytes > maxBytes()) {
    throw new Error(
      `tree is ${Math.round(bytes / 1e6)} MB, over the ${Math.round(maxBytes() / 1e6)} MB checkpoint guard. ` +
        `Heaviest: ${heaviest(src, entries).join(", ")}. ` +
        `Raise NEFERTARI_TIMELINE_MAX_MB, or pass exclude to leave those out.`
    );
  }

  const id = newId("ckpt");
  const base = ckptDir(id);
  const treeDir = path.join(base, "tree");
  fs.mkdirSync(base, { recursive: true });

  // A copy made during the last inference window, if there is one for this
  // directory. It is offered per file: only those provably untouched since the
  // pre-build began are taken, and everything else is copied here and now. The
  // work saved is real; the risk of adopting something stale is not taken.
  const claimed = speculate.claim(src, exclude);
  let reused = 0;
  if (claimed) {
    fs.renameSync(claimed.tree, treeDir); // same filesystem: the whole tree, instantly
    // The shadow can hold files the working dir has since lost. They are in
    // neither list, so they are swept rather than silently checkpointed as
    // present.
    const known = new Set([...claimed.reuse, ...claimed.restale].map((e) => e.rel));
    for (const e of walk(treeDir, [])) {
      if (!known.has(e.rel)) fs.rmSync(path.join(treeDir, e.rel), { force: true });
    }
    materialize(src, treeDir, claimed.restale);
    reused = claimed.reuse.length;
  } else {
    fs.mkdirSync(treeDir, { recursive: true }); // empty trees are valid checkpoints
    materialize(src, treeDir, entries);
  }
  const links = entries.filter((e) => e.type === "link").length;
  const manifest = {
    id,
    kind: "checkpoint",
    label,
    dir: src,
    exclude,
    files: entries.length - links,
    links,
    bytes,
    ...(claimed ? { speculated: reused, copied: claimed.restale.length } : {}),
    createdAt: new Date().toISOString(),
    meta,
  };
  fs.writeFileSync(path.join(base, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ---- fork: K isolated working copies of a checkpoint ----
export function fork(checkpointId, n = 1) {
  const cm = readManifest(ckptDir(checkpointId), "checkpoint", checkpointId);
  const srcTree = path.join(ckptDir(checkpointId), "tree");
  const entries = walk(srcTree, []);
  const forks = [];
  for (let i = 0; i < n; i++) {
    const id = newId("fork");
    const base = forkDir(id);
    const tree = path.join(base, "tree");
    fs.mkdirSync(tree, { recursive: true }); // empty trees are valid forks
    materialize(srcTree, tree, entries);
    const linked = linkExcluded(cm.dir, tree, cm.exclude || []);
    const manifest = {
      id,
      kind: "fork",
      from: checkpointId,
      path: tree,
      linked,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(base, "manifest.json"), JSON.stringify(manifest, null, 2));
    forks.push(manifest);
  }
  return forks;
}

// Make `dir` identical to `srcTree` (checkpoint or fork content), leaving
// excluded dirs untouched at any depth. Deletes files that exist now but not in
// the source, then reproduces the source over it.
//
// The source is walked with the SAME exclude list as the target: a fork carries
// a link named after each excluded dir, and copying that link into the working
// dir would replace real dependencies with a link pointing at themselves.
function syncTree(srcTree, dir, exclude) {
  const src = walk(srcTree, exclude);
  const want = new Set(rels(src));
  const have = walk(dir, exclude);
  for (const e of have) if (!want.has(e.rel)) fs.rmSync(path.join(dir, e.rel), { force: true });
  pruneEmptyDirs(dir, exclude);
  materialize(srcTree, dir, src);
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
