// Timeline: tree-level checkpoint / fork / restore / promote.
//   - restore fidelity: modified back, deleted resurrected, created removed
//   - excluded dirs (node_modules) untouched by checkpoint AND restore
//   - fork isolation: K forks never see each other's writes
//   - promote: winner becomes the working tree, auto-checkpoint makes it undoable
//   - size guard refuses oversized trees
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

process.env.NEFERTARI_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), "nef-home-"));
const { checkpoint, fork, restoreTo, promote, list } = await import("../src/timeline.mjs");
const { classify, CLASS } = await import("../src/broker.mjs");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "nef-tl-"));
const w = (p, c) => {
  fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
  fs.writeFileSync(path.join(work, p), c);
};
const r = (p) => fs.readFileSync(path.join(work, p), "utf8");

// -- checkpoint skips excluded dirs --
w("a.txt", "A1");
w("sub/b.txt", "B1");
w("node_modules/heavy.txt", "NM1");
const ck = checkpoint(work, { label: "t0" });
assert.equal(ck.files, 2, "node_modules must not be checkpointed");
console.log("  ok — checkpoint excludes node_modules");

// -- restore fidelity --
w("a.txt", "A2"); // modified
fs.rmSync(path.join(work, "sub/b.txt")); // deleted
w("created.txt", "NEW"); // created after T
w("node_modules/heavy.txt", "NM2"); // excluded, must survive restore
const res = restoreTo(ck.id);
assert.equal(r("a.txt"), "A1", "modified file restored");
assert.equal(r("sub/b.txt"), "B1", "deleted file resurrected");
assert.ok(!fs.existsSync(path.join(work, "created.txt")), "file created after T removed");
assert.equal(r("node_modules/heavy.txt"), "NM2", "excluded dir untouched by restore");
assert.ok(res.safety_checkpoint, "restore auto-checkpoints first");
console.log("  ok — restore: modified back, deleted resurrected, created removed, excluded untouched");

// -- fork isolation --
const forks = fork(ck.id, 3);
assert.equal(forks.length, 3);
for (const f of forks) assert.equal(fs.readFileSync(path.join(f.path, "a.txt"), "utf8"), "A1");
fs.writeFileSync(path.join(forks[0].path, "a.txt"), "STRAT-0");
fs.writeFileSync(path.join(forks[1].path, "a.txt"), "STRAT-1");
assert.equal(fs.readFileSync(path.join(forks[2].path, "a.txt"), "utf8"), "A1", "fork 2 unaffected by 0/1");
assert.equal(r("a.txt"), "A1", "original tree unaffected by fork writes");
console.log("  ok — 3 forks, fully isolated from each other and the original");

// -- promote the winner (and undo the promotion) --
fs.writeFileSync(path.join(forks[1].path, "winner.txt"), "W");
const prom = promote(forks[1].id);
assert.equal(r("a.txt"), "STRAT-1", "working tree now has the winner's content");
assert.equal(r("winner.txt"), "W");
restoreTo(prom.safety_checkpoint);
assert.equal(r("a.txt"), "A1", "promotion undone via its safety checkpoint");
assert.ok(!fs.existsSync(path.join(work, "winner.txt")));
console.log("  ok — promote applied the winner; safety checkpoint undid it");

// -- empty tree is a valid checkpoint (fresh workspace) --
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "nef-tl-empty-"));
const eck = checkpoint(empty, { label: "empty" });
assert.equal(eck.files, 0, "empty checkpoint has 0 files");
const eforks = fork(eck.id, 2);
fs.writeFileSync(path.join(eforks[0].path, "hero.md"), "H");
promote(eforks[0].id);
assert.equal(fs.readFileSync(path.join(empty, "hero.md"), "utf8"), "H", "promote from empty checkpoint works");
console.log("  ok — empty dir: checkpoint / fork / promote all work");

// -- size guard --
process.env.NEFERTARI_TIMELINE_MAX_MB = "1";
w("big.bin", "x".repeat(2 * 1024 * 1024));
assert.throws(() => checkpoint(work, { label: "too big" }), /guard/, "oversized tree refused");
delete process.env.NEFERTARI_TIMELINE_MAX_MB;
fs.rmSync(path.join(work, "big.bin"));
console.log("  ok — size guard refuses oversized trees");

// -- broker classes --
assert.equal(classify("timeline_checkpoint", {}).class, CLASS.REVERSIBLE);
assert.equal(classify("timeline_fork", {}).class, CLASS.REVERSIBLE);
assert.equal(classify("timeline_restore", {}).class, CLASS.NOISY);
assert.equal(classify("timeline_promote", {}).class, CLASS.NOISY);
assert.equal(classify("timeline_list", {}).class, CLASS.REVERSIBLE);
console.log("  ok — broker: checkpoint/fork/list reversible, restore/promote noisy");

// -- listing --
const all = list();
assert.ok(all.filter((m) => m.kind === "checkpoint").length >= 3, "t0 + safety checkpoints listed");
assert.equal(all.filter((m) => m.kind === "fork").length, 5); // 3 strategy forks + 2 empty-tree forks
console.log("  ok — list shows checkpoints and forks");

fs.rmSync(work, { recursive: true, force: true });
console.log("TIMELINE TESTS PASSED");
