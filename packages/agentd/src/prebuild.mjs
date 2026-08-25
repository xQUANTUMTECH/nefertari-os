// The speculative copy, as a process of its own.
//
// This used to run inside the daemon, yielding to the event loop between files.
// That is fine until one of the files is large: `copyFileSync` does not yield,
// so a single 64MB file blocks the daemon — and the daemon is what every tool
// call goes through. Speculation that can stall a real call is worse than no
// speculation, because the cost lands on the one path that was supposed to be
// getting faster.
//
// So it runs here instead, in a child the daemon can put under `cpu.idle` (runs
// only when nothing else wants the CPU) and kill outright the moment a tool
// call arrives. Killing a process is instant and total; abandoning a loop is
// neither.
//
// The correctness rule is unchanged and lives here now, because the stamp must
// be taken by whoever does the reading:
//
//   the manifest records `startedAt` BEFORE anything is read, and a file may be
//   adopted later only if its mtime is strictly older than that instant.
//
// A file written in the same millisecond as the stamp is therefore never
// adopted. That is stricter than the mtime-and-size comparison build systems
// settle for, deliberately: here the cost of a false "unchanged" is a
// checkpoint that disagrees with the tree it claims to copy, which is a restore
// that quietly loses work.
//
// Output: <out>/tree/… and <out>/manifest.json. The manifest is written LAST
// and renamed into place, so the parent can treat its presence as proof the
// copy finished. A partial tree with no manifest is simply ignored and swept.

import fs from "node:fs";
import path from "node:path";

const [, , dir, out, ...exclude] = process.argv;

if (!dir || !out) {
  console.error("usage: prebuild.mjs <dir> <out> [exclude...]");
  process.exit(2);
}

function walk(root, ex, rel = "", acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if ((e.isDirectory() || e.isSymbolicLink()) && ex.includes(e.name)) continue;
    if (e.isSymbolicLink()) acc.push({ rel: r, type: "link" });
    else if (e.isDirectory()) walk(root, ex, r, acc);
    else if (e.isFile()) acc.push({ rel: r, type: "file" });
  }
  return acc;
}

const tree = path.join(out, "tree");
fs.mkdirSync(tree, { recursive: true });

// Before any read. See the rule above.
const startedAt = Date.now();
const files = {};

for (const e of walk(dir, exclude)) {
  const src = path.join(dir, e.rel);
  const dst = path.join(tree, e.rel);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (e.type === "link") {
      fs.symlinkSync(fs.readlinkSync(src), dst);
      files[e.rel] = { type: "link", mtimeMs: fs.lstatSync(src).mtimeMs };
    } else {
      const st = fs.statSync(src);
      // FICLONE where the filesystem supports it: a reflink is a metadata
      // operation, so most of this copy costs nothing at all.
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
      files[e.rel] = { type: "file", mtimeMs: st.mtimeMs, size: st.size };
    }
  } catch {
    // Vanished or unreadable mid-copy: not part of the shadow, and checkpoint
    // will handle it for real. A speculative copy is allowed to be incomplete;
    // it is not allowed to be wrong.
  }
}

const tmp = path.join(out, "manifest.tmp");
fs.writeFileSync(tmp, JSON.stringify({ dir: path.resolve(dir), startedAt, files }));
// Rename last: the manifest existing IS the signal that the copy is complete,
// and a half-written one would make a partial tree look finished.
fs.renameSync(tmp, path.join(out, "manifest.json"));
