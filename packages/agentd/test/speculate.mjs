// Doing the checkpoint's copy early, in the window where the machine is idle.
//
// The speed-up is the easy half. The half that matters is that a speculative
// copy can never produce a WRONG checkpoint — only a useless one. Every test
// below is about the second half; the first is one line at the end.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";

process.env.NEFERTARI_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), "nef-home-"));
process.env.NEFERTARI_SPECULATE_DELAY_MS = "10"; // no reason to wait in a test

const speculate = await import("../src/speculate.mjs");
const timeline = await import("../src/timeline.mjs");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "nef-spec-"));
const at = (p) => path.join(work, p);
const w = (p, c) => {
  fs.mkdirSync(path.dirname(at(p)), { recursive: true });
  fs.writeFileSync(at(p), c);
};
const treeOf = (ck) => path.join(process.env.NEFERTARI_HOME, "timeline", "checkpoints", ck.id, "tree");
const readIn = (ck, rel) => fs.readFileSync(path.join(treeOf(ck), rel), "utf8");

// Wait for the background build to finish. Polling a state flag beats a fixed
// sleep: a slow CI box would otherwise make this test flaky rather than failing.
async function untilReady(ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (speculate.speculationStats().ready) return true;
    await sleep(20);
  }
  return false;
}

w("a.txt", "one");
w("src/b.js", "two");
w("docs/c.md", "three");

// --- nothing prepared: checkpoint behaves exactly as it always did ---
{
  speculate.reset();
  const ck = timeline.checkpoint(work);
  assert.equal(readIn(ck, "a.txt"), "one");
  assert.equal(ck.speculated, undefined, "no claim, no speculation recorded");
  console.log("  ok — with nothing prepared, a checkpoint is unchanged");
}

// --- prepared and untouched: the copy is adopted ---
{
  speculate.reset();
  speculate.windowOpen(work);
  assert.ok(await untilReady(), "the background build must finish");
  const ck = timeline.checkpoint(work);
  assert.equal(ck.speculated, 3, "all three files were provably untouched");
  assert.equal(ck.copied, 0);
  assert.equal(readIn(ck, "src/b.js"), "two", "and the content is right");
  console.log("  ok — an untouched tree is adopted whole (3 files reused, 0 copied)");
}

// --- THE ONE THAT MATTERS: touched after the pre-build, never adopted stale ---
{
  speculate.reset();
  speculate.windowOpen(work);
  assert.ok(await untilReady());

  // The agent keeps working while the model thinks — which is the normal case,
  // not the corner case.
  await sleep(20);
  w("a.txt", "CHANGED AFTER THE PRE-BUILD");

  const ck = timeline.checkpoint(work);
  assert.equal(
    readIn(ck, "a.txt"),
    "CHANGED AFTER THE PRE-BUILD",
    "the checkpoint must hold what the tree ACTUALLY held, not what the shadow copied"
  );
  assert.ok(ck.copied >= 1, "the changed file must be re-copied rather than reused");
  assert.equal(readIn(ck, "src/b.js"), "two", "while the untouched files are still reused");
  console.log(`  ok — a file changed after the pre-build is re-copied, never adopted (${ck.speculated} reused, ${ck.copied} copied)`);
}

// --- a file DELETED after the pre-build must not reappear ---
{
  w("ghost.txt", "here for now");
  speculate.reset();
  speculate.windowOpen(work);
  assert.ok(await untilReady());
  await sleep(20);
  fs.rmSync(at("ghost.txt"));

  const ck = timeline.checkpoint(work);
  assert.ok(
    !fs.existsSync(path.join(treeOf(ck), "ghost.txt")),
    "a shadow holds files the tree has since lost; they must be swept, not checkpointed as present"
  );
  console.log("  ok — a file deleted after the pre-build does not come back");
}

// --- a new file created after the pre-build must be included ---
{
  speculate.reset();
  speculate.windowOpen(work);
  assert.ok(await untilReady());
  await sleep(20);
  w("late.txt", "arrived late");

  const ck = timeline.checkpoint(work);
  assert.equal(readIn(ck, "late.txt"), "arrived late", "a file the shadow never saw must still be captured");
  console.log("  ok — a file created after the pre-build is captured");
}

// --- a prepared copy of a DIFFERENT directory is never used here ---
{
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "nef-other-"));
  fs.writeFileSync(path.join(other, "a.txt"), "SOMEONE ELSE'S FILE");
  speculate.reset();
  speculate.windowOpen(other);
  assert.ok(await untilReady());

  const ck = timeline.checkpoint(work);
  assert.equal(ck.speculated, undefined, "a shadow of another tree must be refused outright");
  assert.notEqual(readIn(ck, "a.txt"), "SOMEONE ELSE'S FILE");
  assert.equal(speculate.speculationStats().rejected, 1);
  fs.rmSync(other, { recursive: true, force: true });
  console.log("  ok — a shadow of a different directory is refused");
}

// --- real work arriving abandons the preparation ---
{
  speculate.reset();
  speculate.windowOpen(work);
  speculate.windowClose(); // a tool call arrived immediately
  await sleep(200);
  assert.equal(speculate.speculationStats().ready, false, "nothing may be left prepared");
  const ck = timeline.checkpoint(work);
  assert.equal(ck.speculated, undefined);
  assert.equal(readIn(ck, "src/b.js"), "two", "and the checkpoint is correct anyway");
  console.log("  ok — a tool call abandons the preparation, correctness untouched");
}

// --- and only then, the point of it all ---
{
  for (let i = 0; i < 60; i++) w(`bulk/f${i}.txt`, "x".repeat(20000));
  speculate.reset();
  const cold = Date.now();
  timeline.checkpoint(work);
  const coldMs = Date.now() - cold;

  speculate.reset();
  speculate.windowOpen(work);
  assert.ok(await untilReady(8000));
  const warm = Date.now();
  const ck = timeline.checkpoint(work);
  const warmMs = Date.now() - warm;

  assert.ok(ck.speculated > 50, "the bulk must have been reused");
  console.log(`  ok — checkpoint ${coldMs}ms cold vs ${warmMs}ms after preparation (${ck.speculated} files reused)`);
}

fs.rmSync(work, { recursive: true, force: true });
console.log("SPECULATE TESTS PASSED");
