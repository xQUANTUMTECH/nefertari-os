// Plan executor: execution at the level of intent, not keystrokes.
//
// The agent submits a whole plan (an ordered list of tool steps); agentd runs it
// in ONE shot inside a timeline checkpoint and returns one consolidated result —
// a 30-step procedure costs 1 model turn instead of 30. If any step fails, the
// working dir is restored to the checkpoint (the failed state is itself
// auto-checkpointed first, so it stays available for forensics).
//
// Gating composes up front: the plan's class is the WORST class of its steps,
// so a plan containing one irreversible step parks at the human gate before
// step 1 runs — no partial execution up to a wall.
//
// Transaction boundary = the plan's dir (tree-level restore). fs_write/fs_delete
// steps are additionally per-file snapshotted by ops, wherever they point.

import path from "node:path";
import { classifyPlan, CLASS } from "./broker.mjs";
import * as timeline from "./timeline.mjs";
import * as ops from "./ops.mjs";
import { newId, append } from "./journal.mjs";

// Relative fs paths resolve against the plan dir and MUST stay inside it.
// This is what makes plans fork-portable (trajectories: the caller cannot know
// a fork's path before the fork exists) — and confinement to the transaction
// boundary is exactly the scope the checkpoint can restore. Escapes throw,
// which rolls the plan back. Absolute paths pass through and are classified
// as usual (sensitive-path checks apply to them up front).
function resolveInside(dir, p) {
  if (typeof p !== "string" || !p) throw new Error("step is missing a path");
  if (path.isAbsolute(p)) return p;
  const abs = path.resolve(dir, p);
  if (abs !== dir && !abs.startsWith(dir + path.sep))
    throw new Error(`relative path escapes the plan dir: ${p}`);
  return abs;
}

async function execStep(step, cls, dir) {
  const args = step.args || {};
  switch (step.tool) {
    case "fs_read":
      return ops.opFsRead({ ...args, path: resolveInside(dir, args.path) });
    case "fs_write":
      return ops.opFsWrite({ ...args, path: resolveInside(dir, args.path) });
    case "fs_delete":
      return ops.opFsDelete({ ...args, path: resolveInside(dir, args.path) });
    case "shell":
      // Shell steps default to the plan's dir, so enforcement confines their
      // writes to the transaction boundary.
      return ops.opShell({ command: args.command, cwd: args.cwd || dir }, cls);
    default:
      throw new Error(`tool not allowed inside a plan: ${step.tool}`);
  }
}

function rollback(ck, dir, planId, results) {
  const r = timeline.restoreTo(ck.id, dir);
  append({
    tool: "plan_run",
    class: CLASS.NOISY,
    decision: "rolled_back",
    plan: planId,
    checkpoint: ck.id,
    failedState: r.safety_checkpoint,
  });
  return {
    status: "rolled_back",
    plan_id: planId,
    restored_to: ck.id,
    failed_state_checkpoint: r.safety_checkpoint,
    steps: results,
  };
}

// Caller must have gated the plan already (classifyPlan is wired into the
// broker's classify("plan_run", …), so the standard gate() covers it).
export async function runPlan(dir, steps, { label = "" } = {}) {
  const planId = newId("plan");
  const { per } = classifyPlan(steps);
  const ck = timeline.checkpoint(dir, { label: label || `plan ${planId}`, meta: { plan: planId } });
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    // per is full-length by contract, but a hole here must fail the step,
    // not crash the whole plan_run call outside the transaction.
    const stepClass = per[i]?.class ?? CLASS.IRREVERSIBLE;
    let r;
    try {
      r = await execStep(s, stepClass, dir);
    } catch (e) {
      append({ tool: s.tool, args: s.args, class: stepClass, decision: "error", outcome: String(e.message), plan: planId, step: i });
      results.push({ step: i, tool: s.tool, ok: false, error: String(e.message) });
      return rollback(ck, dir, planId, results);
    }
    const ok = !(s.tool === "shell" && r.output.exitCode !== 0);
    append({
      tool: s.tool,
      args: s.args,
      class: stepClass,
      decision: "executed",
      outcome: ok ? "ok" : `exit ${r.output.exitCode}`,
      plan: planId,
      step: i,
      ...(r.meta || {}),
    });
    results.push({ step: i, tool: s.tool, ok, output: r.output });
    if (!ok) return rollback(ck, dir, planId, results);
  }
  return { status: "completed", plan_id: planId, checkpoint_id: ck.id, steps: results };
}
