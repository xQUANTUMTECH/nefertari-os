// Phase-1 snapshot backend: file-copy. Works on any host (WSL2, container, bare metal).
// Interface is stable so btrfs/ZFS/Nix-generation backends can replace it later.

import fs from "node:fs";
import path from "node:path";
import { SNAPSHOT_DIR, ensureHome } from "./paths.mjs";
import { newId } from "./journal.mjs";

// Snapshot the given absolute paths BEFORE a write action touches them.
export function snapshot(paths, meta = {}) {
  ensureHome();
  const id = newId("snap");
  const dir = path.join(SNAPSHOT_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const entries = paths.map((p, i) => {
    const abs = path.resolve(p);
    const existed = fs.existsSync(abs);
    const stored = existed ? path.join(dir, `f${i}`) : null;
    if (existed) fs.copyFileSync(abs, stored);
    return { original: abs, stored: stored ? path.basename(stored) : null, existed };
  });
  const manifest = { id, createdAt: new Date().toISOString(), meta, entries };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return id;
}

export function restore(id) {
  const dir = path.join(SNAPSHOT_DIR, id);
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`snapshot not found: ${id}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const restored = [];
  for (const e of manifest.entries) {
    if (e.existed) {
      fs.mkdirSync(path.dirname(e.original), { recursive: true });
      fs.copyFileSync(path.join(dir, e.stored), e.original);
      restored.push({ path: e.original, action: "restored" });
    } else if (fs.existsSync(e.original)) {
      // File did not exist before the action: undo = remove it.
      fs.rmSync(e.original);
      restored.push({ path: e.original, action: "removed (did not exist before)" });
    }
  }
  return restored;
}

export function list() {
  ensureHome();
  return fs
    .readdirSync(SNAPSHOT_DIR)
    .filter((d) => fs.existsSync(path.join(SNAPSHOT_DIR, d, "manifest.json")))
    .map((d) => JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, d, "manifest.json"), "utf8")))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
