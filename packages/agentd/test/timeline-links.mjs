// Timeline, symlinks and excluded dirs.
//   - a symlink survives checkpoint -> fork -> promote AS a symlink
//   - pnpm/bun layouts (a node_modules of links) still resolve after a round trip
//   - a fork reaches the excluded dirs it needs to run the real test suite
//   - that link never travels back on promote and replaces the original
//
// Symlink creation on Windows needs developer mode or an admin; where it is
// refused the link cases are skipped rather than failed, because the production
// path for enforcement is Linux anyway.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

process.env.NEFERTARI_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), "nef-home-"));
const { checkpoint, fork, promote } = await import("../src/timeline.mjs");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "nef-lk-"));
const at = (p) => path.join(work, p);
const w = (p, c) => {
  fs.mkdirSync(path.dirname(at(p)), { recursive: true });
  fs.writeFileSync(at(p), c);
};

let canLink = true;
try {
  w("real/dep.js", "module.exports = 42;\n");
  fs.symlinkSync(at("real/dep.js"), at("probe"));
  fs.rmSync(at("probe"));
} catch {
  canLink = false;
  console.log("  skip — this host refuses symlinks (Windows without developer mode)");
}

// A pnpm-shaped tree: node_modules is a farm of links into a store.
w("src/index.js", "require('dep');\n");
w("store/dep/index.js", "module.exports = 'from the store';\n");
if (canLink) {
  fs.mkdirSync(at("node_modules"), { recursive: true });
  fs.symlinkSync(at("store/dep"), at("node_modules/dep"), "junction");
  fs.symlinkSync(at("store/dep/index.js"), at("src/linked.js"));
}

const t0 = checkpoint(work, { label: "pnpm-shaped" });

if (canLink) {
  assert.equal(t0.links, 1, "the in-tree link is recorded, the one under node_modules is excluded");
  const stored = path.join(process.env.NEFERTARI_HOME, "timeline", "checkpoints", t0.id, "tree", "src", "linked.js");
  assert.ok(fs.lstatSync(stored).isSymbolicLink(), "checkpoint stored it as a link, not as a copy of its target");
  console.log("  ok — a symlink is checkpointed as a symlink");
}

const [f1] = fork(t0.id, 1);

if (canLink) {
  assert.ok(fs.lstatSync(path.join(f1.path, "src", "linked.js")).isSymbolicLink(), "fork kept the link");
  assert.deepEqual(f1.linked, ["node_modules"], "fork linked the excluded dir back at the original");
  const nm = path.join(f1.path, "node_modules");
  assert.ok(fs.lstatSync(nm).isSymbolicLink(), "node_modules in the fork is a link, not a copy");
  assert.ok(fs.existsSync(path.join(nm, "dep")), "the fork resolves its dependencies — npm test can run here");
  console.log("  ok — a fork reaches its dependencies at zero copy cost");
}

// The winner changes a source file; promote must carry that back without
// touching the real node_modules.
fs.writeFileSync(path.join(f1.path, "src", "index.js"), "require('dep'); // winner\n");
const before = canLink ? fs.readlinkSync(at("node_modules/dep")) : null;
promote(f1.id, work);

assert.match(fs.readFileSync(at("src/index.js"), "utf8"), /winner/, "the winner's edit landed");
if (canLink) {
  assert.ok(fs.lstatSync(at("node_modules")).isDirectory(), "node_modules is still the real directory");
  assert.ok(!fs.lstatSync(at("node_modules")).isSymbolicLink(), "promote did not replace it with a link to itself");
  assert.equal(fs.readlinkSync(at("node_modules/dep")), before, "the store link is untouched");
  assert.ok(fs.lstatSync(at("src/linked.js")).isSymbolicLink(), "the in-tree link survived the round trip");
  console.log("  ok — promote carries the edit and leaves the excluded dir alone");
}

fs.rmSync(work, { recursive: true, force: true });
console.log("TIMELINE LINK TESTS PASSED");
