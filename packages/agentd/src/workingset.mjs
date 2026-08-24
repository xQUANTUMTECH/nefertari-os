// The orientation tax, paid from data already on disk.
//
// Every OS assumes its caller remembers the machine. An agent does not: it wakes
// with no memory and spends its first turns re-discovering a workspace it has
// already worked in — ls, find, cat, git status — one model inference each. That
// is the first of the four taxes in docs/PERFORMANCE-TRACK.md, and the roadmap's
// answer to it is T4/T5, typed system state.
//
// This is the cheap half of that answer, available now: the journal already
// records every file read, written and deleted, and every command run, with a
// timestamp. Replayed, it IS the working set — no new bookkeeping, no daemon
// watching the filesystem, nothing to keep in sync.
//
// It also answers the question a resuming session actually has, which is not
// "what is here" but "what moved while I was gone": a file whose mtime is newer
// than the last action recorded against it was changed by someone else, and that
// is exactly where a stale assumption is about to cost a wrong edit.
//
// What it is not: a picture of the whole machine. It sees what this daemon did,
// so a workspace touched only outside Nefertari looks empty, and it says so
// rather than implying the workspace is.

import fs from "node:fs";
import path from "node:path";
import { readAll } from "./journal.mjs";

const FS_TOOLS = { fs_read: "read", fs_write: "wrote", fs_delete: "deleted" };

// mtime resolution and clock skew between the journal write and the file write
// are both real; a second of slack keeps a file the agent itself just wrote from
// being reported as changed underneath it.
const SKEW_MS = 1000;

function inside(dir, p) {
  if (!dir) return true;
  const abs = path.resolve(p);
  return abs === dir || abs.startsWith(dir + path.sep) || abs.startsWith(dir + "/");
}

export function workingSet({ dir, limit = 40, commandLimit = 15, since } = {}) {
  const root = dir ? path.resolve(dir) : null;
  const sinceMs = since ? Date.parse(since) : null;

  const files = new Map(); // abs path -> record
  const commands = new Map(); // command -> record
  let considered = 0;

  for (const e of readAll()) {
    if (!e || e.decision !== "executed") continue;
    const ts = e.ts;
    if (sinceMs && Date.parse(ts) < sinceMs) continue;

    const action = FS_TOOLS[e.tool];
    if (action) {
      const p = e.args?.path;
      if (typeof p !== "string" || !p || !inside(root, p)) continue;
      considered++;
      const abs = path.resolve(p);
      const prev = files.get(abs);
      files.set(abs, {
        path: abs,
        last_action: action,
        last_at: ts,
        actions: (prev?.actions || 0) + 1,
        // A file read once and written ten times is not the same kind of thing
        // as one read ten times; keeping both makes the difference visible.
        writes: (prev?.writes || 0) + (action === "wrote" ? 1 : 0),
      });
    } else if (e.tool === "shell") {
      const cmd = e.args?.command;
      if (typeof cmd !== "string" || !cmd) continue;
      const cwd = e.args?.cwd;
      if (cwd && !inside(root, cwd)) continue;
      considered++;
      const prev = commands.get(cmd);
      commands.set(cmd, { command: cmd, cwd: cwd || null, last_at: ts, runs: (prev?.runs || 0) + 1, last_outcome: e.outcome ?? null });
    }
  }

  const changed = [];
  const out = [];
  for (const rec of [...files.values()].sort((a, b) => b.last_at.localeCompare(a.last_at)).slice(0, limit)) {
    let exists = false;
    let mtime = null;
    try {
      const st = fs.statSync(rec.path);
      exists = true;
      mtime = new Date(st.mtimeMs).toISOString();
    } catch {
      /* deleted, moved, or never existed outside the journal */
    }
    const movedUnderUs = exists && mtime && Date.parse(mtime) > Date.parse(rec.last_at) + SKEW_MS;
    const item = { ...rec, exists, mtime, changed_since_last_action: movedUnderUs };
    if (movedUnderUs) changed.push(rec.path);
    if (rec.last_action === "deleted" && exists) item.note = "deleted here, but present again";
    out.push(item);
  }

  return {
    dir: root,
    since: since ?? null,
    entries_considered: considered,
    files: out,
    commands: [...commands.values()].sort((a, b) => b.last_at.localeCompare(a.last_at)).slice(0, commandLimit),
    changed_since_last_action: changed,
    // Said out loud so an empty answer is never read as an empty workspace.
    note:
      considered === 0
        ? "No journalled activity for this scope. Nefertari only sees what went through it; work done outside it leaves no trace here."
        : undefined,
  };
}
