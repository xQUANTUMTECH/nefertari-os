#!/usr/bin/env node
// agentd — Nefertari OS system daemon. MCP server over stdio.
// Every tool call flows through the permission broker; every action is journaled;
// every write is snapshotted; irreversible actions wait for the human gate.

import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { classify, CLASS, PLAN_TOOLS } from "./broker.mjs";
import * as journal from "./journal.mjs";
import * as snapshots from "./snapshots.mjs";
import * as timeline from "./timeline.mjs";
import * as ops from "./ops.mjs";
import { runPlan } from "./plan.mjs";
import { runTrajectories } from "./trajectories.mjs";
import * as approvals from "./approvals.mjs";
import { HOME, ensureHome } from "./paths.mjs";

ensureHome();

const server = new McpServer({ name: "nefertari-agentd", version: "0.1.0" });

function text(s) {
  return { content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] };
}

// Cap on how many irreversible actions can sit unresolved at once. Without it,
// a runaway or hostile agent can flood the human with approval requests until
// they rubber-stamp one (approval fatigue). At the cap, new distinct
// irreversible actions are refused outright until the queue drains.
const MAX_PENDING = Number(process.env.NEFERTARI_MAX_PENDING) || 25;

// Broker front door: classify, gate, journal. Returns null to proceed,
// or a pending_approval response the tool must return as-is.
function gate(tool, args) {
  const { class: cls, reason } = classify(tool, args);
  if (cls === CLASS.IRREVERSIBLE) {
    if (!approvals.consumeApproval(tool, args)) {
      const pend = approvals.listPending();
      const alreadyQueued = pend.some((p) => p.hash === approvals.actionHash(tool, args));
      if (!alreadyQueued && pend.length >= MAX_PENDING) {
        journal.append({ tool, args, class: cls, decision: "rate_limited", reason, pending: pend.length });
        return {
          gated: true,
          response: text({
            status: "rate_limited",
            reason: `approval queue is full (${pend.length}/${MAX_PENDING}). A human must resolve pending actions before new irreversible ones are accepted.`,
            pending: pend.length,
          }),
        };
      }
      const entry = approvals.registerPending(tool, args, reason);
      journal.append({ id: entry.id, tool, args, class: cls, decision: "pending_approval", reason });
      return {
        gated: true,
        response: text({
          status: "pending_approval",
          action_id: entry.id,
          class: cls,
          reason,
          how_to_approve: `The human must run: nefertari approve ${entry.id} (or: node src/cli.mjs approve ${entry.id}). Then retry this exact call.`,
        }),
      };
    }
    journal.append({ tool, args, class: cls, decision: "approved_by_human", reason });
    return { gated: false, cls, reason };
  }
  return { gated: false, cls, reason };
}

function record(tool, args, cls, outcome, extra = {}) {
  journal.append({ tool, args, class: cls, decision: "executed", outcome, ...extra });
}

// ---------- tools ----------

server.tool(
  "fs_read",
  "Read a file from the host filesystem.",
  { path: z.string().describe("Absolute path to read") },
  async ({ path: p }) => {
    const g = gate("fs_read", { path: p });
    if (g.gated) return g.response;
    const r = ops.opFsRead({ path: p });
    record("fs_read", { path: p }, g.cls, "ok", r.meta);
    return text(r.output);
  }
);

server.tool(
  "fs_write",
  "Write a file on the host. The previous content is snapshotted automatically; the result includes the snapshot_id for undo.",
  { path: z.string(), content: z.string() },
  async ({ path: p, content }) => {
    const g = gate("fs_write", { path: p });
    if (g.gated) return g.response;
    const r = ops.opFsWrite({ path: p, content });
    record("fs_write", { path: p }, g.cls, "ok", r.meta);
    return text(r.output);
  }
);

server.tool(
  "fs_delete",
  "Delete a single file on the host. The file is snapshotted first so the deletion is undoable.",
  { path: z.string() },
  async ({ path: p }) => {
    const g = gate("fs_delete", { path: p });
    if (g.gated) return g.response;
    const r = ops.opFsDelete({ path: p });
    if (r.meta) record("fs_delete", { path: p }, g.cls, "ok", r.meta);
    return text(r.output);
  }
);

server.tool(
  "shell",
  "Run a shell command on the host. Read-only commands pass; known state-changing commands pass with notification; anything else requires human approval first.",
  { command: z.string(), cwd: z.string().optional() },
  async ({ command, cwd }) => {
    const g = gate("shell", { command });
    if (g.gated) return g.response;
    const r = await ops.opShell({ command, cwd }, g.cls);
    record("shell", { command }, g.cls, r.output.exitCode === 0 ? "ok" : `exit ${r.output.exitCode}`, { notify: g.cls === CLASS.NOISY, ...r.meta });
    return text(r.output);
  }
);

server.tool(
  "plan_run",
  "Execute a whole plan (ordered list of tool steps) in ONE call, inside a timeline transaction: the dir is checkpointed first, steps run in order, and if any step fails the dir is restored (the failed state is auto-checkpointed for forensics). The plan is classified as the WORST of its steps, so a plan containing an irreversible step waits at the human gate before step 1 runs. Allowed step tools: fs_read, fs_write, fs_delete, shell (shell cwd defaults to the plan dir). Use this instead of many single calls for multi-step procedures.",
  {
    dir: z.string().describe("Working dir = the transaction boundary (checkpointed / restored)"),
    steps: z
      .array(
        z.object({
          tool: z.enum(PLAN_TOOLS),
          args: z.record(z.any()).describe("Arguments for the step's tool"),
        })
      )
      .min(1)
      .max(50),
    label: z.string().optional(),
  },
  async ({ dir, steps, label }) => {
    const g = gate("plan_run", { dir, steps });
    if (g.gated) return g.response;
    const result = await runPlan(dir, steps, { label });
    record("plan_run", { dir, steps: steps.length, label }, g.cls, result.status, {
      planId: result.plan_id,
      notify: g.cls === CLASS.NOISY || result.status !== "completed",
    });
    return text(result);
  }
);

server.tool(
  "trajectories_run",
  "Run up to 8 ALTERNATIVE plans in parallel, each in its own isolated fork of a checkpoint — try K strategies at once instead of try/fail/backtrack. Each trajectory is transactional (a failing one rolls back to the checkpoint content and never touches the others). An optional eval_cmd runs in each successful fork (exit 0 = pass); the first passing trajectory is recommended as winner — adopt it with timeline_promote. fs step paths should be RELATIVE (resolved inside each fork); shell steps run with cwd = the fork. The call is classified as the worst step across ALL trajectories + the eval command.",
  {
    checkpoint_id: z.string().describe("Checkpoint to fork from (timeline_checkpoint first)"),
    trajectories: z
      .array(
        z.object({
          label: z.string().optional(),
          steps: z
            .array(z.object({ tool: z.enum(PLAN_TOOLS), args: z.record(z.any()) }))
            .min(1)
            .max(50),
        })
      )
      .min(1)
      .max(8),
    eval_cmd: z.string().optional().describe("Shell command scored per fork (cwd = fork). Exit 0 = pass."),
  },
  async ({ checkpoint_id, trajectories, eval_cmd }) => {
    const g = gate("trajectories_run", { checkpoint_id, trajectories, eval_cmd });
    if (g.gated) return g.response;
    const result = await runTrajectories(checkpoint_id, trajectories, { evalCmd: eval_cmd });
    record(
      "trajectories_run",
      { checkpoint_id, trajectories: trajectories.length, eval_cmd },
      g.cls,
      result.winner ? `winner ${result.winner.fork_id}` : "no winner",
      { notify: g.cls === CLASS.NOISY }
    );
    return text(result);
  }
);

server.tool(
  "undo",
  "Restore a snapshot created by a previous write/delete action.",
  { snapshot_id: z.string() },
  async ({ snapshot_id }) => {
    const g = gate("undo", { snapshot_id });
    if (g.gated) return g.response;
    const restored = snapshots.restore(snapshot_id);
    record("undo", { snapshot_id }, g.cls, "ok", { restored: restored.length });
    return text({ status: "restored", snapshot_id, files: restored });
  }
);

// ---- timeline: tree-level time the agent can branch on ----

server.tool(
  "timeline_checkpoint",
  "Checkpoint a whole directory tree into the timeline. Returns a checkpoint_id you can fork from or restore to. Excluded dir names (default: node_modules) are skipped at any depth and left untouched by restores.",
  {
    dir: z.string().describe("Absolute path of the directory to checkpoint"),
    label: z.string().optional(),
    exclude: z.array(z.string()).optional().describe("Directory names to skip (default: ['node_modules'])"),
  },
  async ({ dir, label, exclude }) => {
    const g = gate("timeline_checkpoint", { dir });
    if (g.gated) return g.response;
    const m = timeline.checkpoint(dir, { label, ...(exclude ? { exclude } : {}) });
    record("timeline_checkpoint", { dir, label }, g.cls, "ok", { checkpointId: m.id, files: m.files, bytes: m.bytes });
    return text({ status: "checkpointed", checkpoint_id: m.id, files: m.files, bytes: m.bytes });
  }
);

server.tool(
  "timeline_fork",
  "Create N isolated working copies of a checkpoint (one per strategy or per team member). Each fork is a real directory you can point tools at; work in forks never touches the original tree or the other forks. Keep the best result with timeline_promote.",
  { checkpoint_id: z.string(), n: z.number().int().min(1).max(16).default(1) },
  async ({ checkpoint_id, n }) => {
    const g = gate("timeline_fork", { checkpoint_id, n });
    if (g.gated) return g.response;
    const forks = timeline.fork(checkpoint_id, n);
    record("timeline_fork", { checkpoint_id, n }, g.cls, "ok", { forks: forks.map((f) => f.id) });
    return text({ status: "forked", forks: forks.map((f) => ({ fork_id: f.id, path: f.path })) });
  }
);

server.tool(
  "timeline_restore",
  "Restore a directory to the state of a checkpoint. The current state is auto-checkpointed first, so the restore is itself undoable.",
  { checkpoint_id: z.string(), dir: z.string().optional().describe("Defaults to the dir the checkpoint was taken from") },
  async ({ checkpoint_id, dir }) => {
    const g = gate("timeline_restore", { checkpoint_id, dir });
    if (g.gated) return g.response;
    const r = timeline.restoreTo(checkpoint_id, dir);
    record("timeline_restore", { checkpoint_id, dir: r.dir }, g.cls, "ok", { safetyCheckpoint: r.safety_checkpoint, notify: true });
    return text({ status: "restored", ...r });
  }
);

server.tool(
  "timeline_promote",
  "Make a winning fork's content the working directory (defaults to the dir its checkpoint came from). The current state is auto-checkpointed first, so promotion is itself undoable.",
  { fork_id: z.string(), dir: z.string().optional() },
  async ({ fork_id, dir }) => {
    const g = gate("timeline_promote", { fork_id, dir });
    if (g.gated) return g.response;
    const r = timeline.promote(fork_id, dir);
    record("timeline_promote", { fork_id, dir: r.dir }, g.cls, "ok", { safetyCheckpoint: r.safety_checkpoint, notify: true });
    return text({ status: "promoted", ...r });
  }
);

server.tool(
  "timeline_list",
  "List all timeline checkpoints and forks (id, label, dir, size, created).",
  {},
  async () => {
    const g = gate("timeline_list", {});
    if (g.gated) return g.response;
    record("timeline_list", {}, g.cls, "ok");
    return text(timeline.list());
  }
);

server.tool(
  "sys_status",
  "Snapshot of host state: OS, uptime, memory, disk, recent journal entries.",
  {},
  async () => {
    const g = gate("sys_status", {});
    if (g.gated) return g.response;
    const status = {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      uptimeMin: Math.round(os.uptime() / 60),
      memory: { freeMB: Math.round(os.freemem() / 1e6), totalMB: Math.round(os.totalmem() / 1e6) },
      nefertariHome: HOME,
      snapshots: snapshots.list().length,
      pendingApprovals: approvals.listPending().length,
      recentJournal: journal.tail(5),
    };
    record("sys_status", {}, g.cls, "ok");
    return text(status);
  }
);

server.tool(
  "journal_tail",
  "Read the last N entries of the append-only action journal.",
  { n: z.number().int().min(1).max(200).default(20) },
  async ({ n }) => text(journal.tail(n))
);

server.tool(
  "pending_list",
  "List actions waiting for human approval.",
  {},
  async () => text(approvals.listPending())
);

await server.connect(new StdioServerTransport());
