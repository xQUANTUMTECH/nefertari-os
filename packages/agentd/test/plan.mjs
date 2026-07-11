// Plan executor: transactional intent.
//   - classification composes worst-wins (one irreversible step gates the whole plan up front)
//   - happy path: N steps, one call, one consolidated result
//   - failing step (shell exit != 0) => atomic restore to the pre-plan checkpoint
//   - throwing step (fs_read on missing file) => same rollback
//   - the failed state is auto-checkpointed, so it can be inspected/recovered
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

process.env.NEFERTARI_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), "nef-home-"));
const { classifyPlan, classify, CLASS } = await import("../src/broker.mjs");
const { runPlan } = await import("../src/plan.mjs");
const { restoreTo } = await import("../src/timeline.mjs");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "nef-plan-"));
const P = (p) => path.join(work, p);
fs.writeFileSync(P("base.txt"), "BASE");

// -- classification composes worst-wins --
assert.equal(classifyPlan([{ tool: "fs_read", args: { path: "/x" } }]).class, CLASS.REVERSIBLE);
assert.equal(
  classifyPlan([
    { tool: "fs_read", args: { path: "/x" } },
    { tool: "shell", args: { command: "apt-get install jq" } },
  ]).class,
  CLASS.NOISY
);
const bad = classifyPlan([
  { tool: "fs_write", args: { path: "/x" } },
  { tool: "shell", args: { command: "rm -rf /data" } },
]);
assert.equal(bad.class, CLASS.IRREVERSIBLE);
assert.match(bad.reason, /step 1 \(shell\)/, "reason names the offending step");
// per must cover EVERY step even when an early step is irreversible — the
// executor reads per[i].class after the human approves the whole plan.
const partial = classifyPlan([
  { tool: "shell", args: { command: "git config user.name 'X'" } },
  { tool: "shell", args: { command: "git add -A" } },
  { tool: "fs_write", args: { path: "/x" } },
]);
assert.equal(partial.class, CLASS.IRREVERSIBLE);
assert.equal(partial.per.length, 3, "per is full-length past the first irreversible step");
assert.ok(partial.per.every((p) => p && p.class), "every per entry is classified");
assert.equal(classifyPlan([]).class, CLASS.IRREVERSIBLE, "empty plan gated");
assert.equal(classifyPlan([{ tool: "undo", args: {} }]).class, CLASS.IRREVERSIBLE, "undo not allowed in a plan");
assert.equal(classifyPlan([{ tool: "plan_run", args: {} }]).class, CLASS.IRREVERSIBLE, "no plan nesting");
assert.equal(classify("plan_run", { steps: [{ tool: "fs_read", args: { path: "/x" } }] }).class, CLASS.REVERSIBLE, "broker routes plan_run through classifyPlan");
console.log("  ok — plan class = worst of its steps; disallowed tools and empty plans gate");

// -- happy path: multi-step plan, one consolidated result --
const good = await runPlan(work, [
  { tool: "fs_write", args: { path: P("a.txt"), content: "A" } },
  { tool: "fs_read", args: { path: P("a.txt") } },
  { tool: "shell", args: { command: "cat a.txt" } }, // cwd defaults to the plan dir
  { tool: "fs_write", args: { path: P("b.txt"), content: "B" } },
]);
assert.equal(good.status, "completed");
assert.equal(good.steps.length, 4);
assert.ok(good.steps.every((s) => s.ok));
assert.equal(good.steps[1].output, "A");
assert.equal(good.steps[2].output.stdout, "A", "shell step ran in the plan dir");
assert.equal(fs.readFileSync(P("b.txt"), "utf8"), "B");
assert.ok(good.checkpoint_id, "plan ran inside a checkpoint");
console.log("  ok — 4 steps, 1 call, completed (shell cwd = plan dir)");

// -- failing shell step => atomic rollback --
const failed = await runPlan(work, [
  { tool: "fs_write", args: { path: P("partial.txt"), content: "HALF-DONE" } },
  { tool: "shell", args: { command: "false" } },
  { tool: "fs_write", args: { path: P("never.txt"), content: "NO" } },
]);
assert.equal(failed.status, "rolled_back");
assert.equal(failed.steps.length, 2, "step after the failure never ran");
assert.ok(!fs.existsSync(P("partial.txt")), "partial write rolled back");
assert.ok(!fs.existsSync(P("never.txt")));
assert.equal(fs.readFileSync(P("base.txt"), "utf8"), "BASE", "pre-plan state intact");
console.log("  ok — failing step: partial work rolled back atomically");

// -- the failed state is itself recoverable (forensics) --
restoreTo(failed.failed_state_checkpoint, work);
assert.equal(fs.readFileSync(P("partial.txt"), "utf8"), "HALF-DONE", "failed state recoverable from its checkpoint");
restoreTo(failed.restored_to, work); // back to clean
assert.ok(!fs.existsSync(P("partial.txt")));
console.log("  ok — failed state preserved in a checkpoint, recoverable, then dropped again");

// -- throwing step (read of a missing file) => same rollback --
const thrown = await runPlan(work, [
  { tool: "fs_write", args: { path: P("x.txt"), content: "X" } },
  { tool: "fs_read", args: { path: P("does-not-exist.txt") } },
]);
assert.equal(thrown.status, "rolled_back");
assert.ok(thrown.steps[1].error, "error surfaced in the step result");
assert.ok(!fs.existsSync(P("x.txt")));
console.log("  ok — throwing step: rolled back, error reported");

fs.rmSync(work, { recursive: true, force: true });
console.log("PLAN TESTS PASSED");
