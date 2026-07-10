// Speculative trajectories: the team superpower.
//
// fork ×K from one checkpoint + one plan per fork, run CONCURRENTLY, then an
// optional eval command scores each fork. The caller (agent, or each member of
// an AI team) inspects the results and promotes the winning fork; the losers
// cost nothing to throw away. Exploration stops being sequential.
//
// Composition, not new machinery:
//   - each trajectory = runPlan() on its own fork dir (so each is transactional:
//     a failing trajectory rolls back to the checkpoint content and is reported,
//     it never poisons the others);
//   - shell steps default cwd = the fork dir, so kernel enforcement confines
//     each trajectory's writes to its own fork — parallel agents cannot trample
//     each other even if a command misbehaves;
//   - classification composes worst-wins across ALL trajectories + the eval
//     command, so one irreversible step anywhere parks the whole call at the
//     human gate before any fork is created.

import { fork as tlFork } from "./timeline.mjs";
import { runPlan } from "./plan.mjs";
import * as ops from "./ops.mjs";
import { classifyShell, classifyPlan } from "./broker.mjs";
import { append } from "./journal.mjs";

export async function runTrajectories(checkpointId, trajectories, { evalCmd = "" } = {}) {
  const forks = tlFork(checkpointId, trajectories.length);
  const results = await Promise.all(
    trajectories.map(async (t, i) => {
      const f = forks[i];
      const label = t.label || `trajectory ${i}`;
      const plan = await runPlan(f.path, t.steps, { label });
      let evalResult = null;
      if (evalCmd && plan.status === "completed") {
        const r = await ops.opShell({ command: evalCmd, cwd: f.path }, classifyShell(evalCmd));
        evalResult = r.output;
      }
      append({
        tool: "trajectories_run",
        class: classifyPlan(t.steps).class,
        decision: "trajectory_done",
        checkpoint: checkpointId,
        fork: f.id,
        label,
        plan: plan.plan_id,
        outcome: plan.status,
        eval: evalResult ? `exit ${evalResult.exitCode}` : null,
      });
      return { index: i, label, fork_id: f.id, path: f.path, plan, eval: evalResult };
    })
  );
  // Recommendation only — the caller is free to promote any fork it prefers.
  const winner = evalCmd
    ? (results.find((r) => r.plan.status === "completed" && r.eval && r.eval.exitCode === 0) ?? null)
    : null;
  return {
    checkpoint_id: checkpointId,
    trajectories: results,
    winner: winner ? { fork_id: winner.fork_id, label: winner.label } : null,
    next: winner
      ? `timeline_promote { fork_id: "${winner.fork_id}" } to adopt the winner`
      : "inspect the forks, then timeline_promote the one you want (or none)",
  };
}
