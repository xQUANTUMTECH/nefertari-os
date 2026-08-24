#!/usr/bin/env node
// agentd — Nefertari OS system daemon. MCP server over stdio.
// Every tool call flows through the permission broker; every action is journaled;
// every write is snapshotted; irreversible actions wait for the human gate.

import fs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { classify, CLASS, PLAN_TOOLS } from "./broker.mjs";
import { normalizeSteps, normalizeTrajectories } from "./planshape.mjs";
import { workingSet } from "./workingset.mjs";
import * as egress from "./egress.mjs";
import * as localmodel from "./localmodel.mjs";
import * as idle from "./idle.mjs";
import * as speculate from "./speculate.mjs";
import * as journal from "./journal.mjs";
import * as snapshots from "./snapshots.mjs";
import * as timeline from "./timeline.mjs";
import * as ops from "./ops.mjs";
import { runPlan } from "./plan.mjs";
import { parseOcs, runOcs } from "./ocs.mjs";
import { runTrajectories } from "./trajectories.mjs";
import * as approvals from "./approvals.mjs";
import { HOME, ensureHome } from "./paths.mjs";

// Wire shapes for plan steps: flat, nested, or a JSON string of either. The
// widening — and the reason for it — lives in src/planshape.mjs.
const StepShape = z.object({
  tool: z.enum(PLAN_TOOLS),
  args: z.record(z.any()).optional().describe("Older nested form; flat fields below are simpler"),
  path: z.string().optional(),
  content: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
});
const StepsInput = z.union([z.array(StepShape).min(1).max(50), z.string()]);
const TrajectoriesInput = z.union([
  z.array(z.object({ label: z.string().optional(), steps: StepsInput })).min(1).max(8),
  z.string(),
]);

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
  idle.enter();
  // Real work has arrived: whatever was being prepared stops now. Speculation
  // that competed with the call it was preparing for would be worse than none.
  speculate.windowClose();
  const { class: cls, reason } = classify(tool, args);
  if (cls === CLASS.IRREVERSIBLE) {
    if (!approvals.consumeApproval(tool, args)) {
      const pend = approvals.listPending();
      const alreadyQueued = pend.some((p) => p.hash === approvals.actionHash(tool, args));
      if (!alreadyQueued && pend.length >= MAX_PENDING) {
        journal.append({ tool, args, class: cls, decision: "rate_limited", reason, pending: pend.length, ...idle.exit() });
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
      journal.append({ id: entry.id, tool, args, class: cls, decision: "pending_approval", reason, ...idle.exit() });
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
  // idle_ms is the inference window that preceded this call: the seconds the
  // machine had nothing to do while the model thought. Recorded per entry
  // because the journal is where anything richer can be computed from later,
  // and because a share nobody can recompute is a share nobody believes.
  journal.append({ tool, args, class: cls, decision: "executed", outcome, ...extra, ...idle.exit() });
  // The window opens here. The directory worth preparing is the one this action
  // just touched: the next expensive thing an agent does to a tree is almost
  // always to a tree it is already working in.
  const hint = args?.dir || args?.cwd || (typeof args?.path === "string" ? nodePath.dirname(args.path) : null);
  if (hint) speculate.windowOpen(hint);
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
    steps: StepsInput.describe(
      'Steps, flat: [{"tool":"fs_write","path":"a.txt","content":"hi"},{"tool":"shell","command":"npm test"}]. ' +
        'A JSON string of that array works too, as does the older {"tool":..,"args":{..}} form.'
    ),
    label: z.string().optional(),
  },
  async ({ dir, steps, label }) => {
    try {
      steps = normalizeSteps(steps);
    } catch (e) {
      return text({ status: "invalid", error: String(e.message || e) });
    }
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
  "ocs_run",
  "Run an OCS v0 document (ensure_dir/ensure_file/run/assert_*/read). dry_run returns the expanded plan without side effects. Returns OcsReport { status, asserts, steps_run, error?, expanded? }.",
  {
    document: z.union([z.string(), z.record(z.any())]).describe("OCS v0 document as object or JSON string"),
    dry_run: z.boolean().optional().describe("If true, compile only (no side effects)"),
    project_root: z.string().optional().describe("Override meta.project as cwd root"),
  },
  async ({ document, dry_run, project_root }) => {
    // Parse up front so invalid docs fail without gating/journal noise.
    try {
      parseOcs(document);
    } catch (e) {
      return text({ status: "failed", asserts: [], steps_run: 0, error: String(e.message || e) });
    }
    const report = await runOcs(document, {
      dry_run,
      projectRoot: project_root,
    });
    record("ocs_run", { dry_run: !!dry_run, project_root }, CLASS.REVERSIBLE, report.status, {
      steps_run: report.steps_run,
      notify: report.status === "failed",
    });
    return text(report);
  }
);
server.tool(
  "trajectories_run",
  "Run up to 8 ALTERNATIVE plans in parallel, each in its own isolated fork of a checkpoint — try K strategies at once instead of try/fail/backtrack. Each trajectory is transactional (a failing one rolls back to the checkpoint content and never touches the others). An optional eval_cmd runs in each successful fork (exit 0 = pass); the first passing trajectory is recommended as winner — adopt it with timeline_promote. fs step paths should be RELATIVE (resolved inside each fork); shell steps run with cwd = the fork. The call is classified as the worst step across ALL trajectories + the eval command.",
  {
    checkpoint_id: z.string().describe("Checkpoint to fork from (timeline_checkpoint first)"),
    trajectories: TrajectoriesInput.describe(
      'Alternatives to try: [{"label":"a","steps":[{"tool":"fs_write","path":"x","content":"1"}]}]. ' +
        "Steps take the same flat form as plan_run; a JSON string of the whole array is accepted."
    ),
    eval_cmd: z.string().optional().describe("Shell command scored per fork (cwd = fork). Exit 0 = pass."),
  },
  async ({ checkpoint_id, trajectories, eval_cmd }) => {
    try {
      trajectories = normalizeTrajectories(trajectories);
    } catch (e) {
      return text({ status: "invalid", error: String(e.message || e) });
    }
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
  "egress_check",
  "Ask whether content is safe to bring into your context BEFORE you read it. Everything you read is sent to a third-party model API on your next turn, so a secret you read is a secret you have forwarded. Give a path (the file is examined here and its contents are NOT returned) or inline content. Returns credential-shaped matches found by pattern, plus — when this host runs a local model — a judgement on the sensitivity patterns cannot see (personal data, customer names, internal hostnames, unreleased business information). That judgement is made ON THIS MACHINE: asking a remote model whether something may leave would be sending it.",
  {
    path: z.string().optional().describe("File to examine; its contents are never returned"),
    content: z.string().optional().describe("Inline content to examine instead of a path"),
    question: z.string().optional().describe("What you intend to do with it, to sharpen the judgement"),
  },
  async ({ path: p, content, question }) => {
    const g = gate("egress_check", { path: p });
    if (g.gated) return g.response;
    let subject = content;
    if (subject === undefined) {
      if (!p) return text({ status: "invalid", error: "give either path or content" });
      try {
        subject = fs.readFileSync(p, "utf8");
      } catch (e) {
        return text({ status: "invalid", error: String(e.message) });
      }
    }
    // Screened with masking forced on, whatever the deployment mode: this tool
    // reports on content, it never becomes a way to print it.
    const prevMode = process.env.NEFERTARI_EGRESS;
    process.env.NEFERTARI_EGRESS = "redact";
    let scan;
    try {
      scan = egress.screen(subject, { source: "egress_check", path: p || null });
    } finally {
      if (prevMode === undefined) delete process.env.NEFERTARI_EGRESS;
      else process.env.NEFERTARI_EGRESS = prevMode;
    }
    const judgement = await egress.judge(subject, { question });
    const model = await localmodel.info();
    const result = {
      path: p || null,
      bytes: subject.length,
      credential_patterns: scan.findings,
      judgement,
      local_model: model.driver,
      // Said plainly, because "no findings" and "nothing looked" must never
      // read the same way to a model deciding whether to open a file.
      note:
        judgement === null
          ? "No local model on this host: only credential PATTERNS were checked. Sensitivity beyond those shapes was not assessed."
          : undefined,
    };
    record("egress_check", { path: p }, g.cls, `${scan.findings.length} pattern(s), judgement ${judgement ? (judgement.sensitive ? "SENSITIVE" : "SAFE") : "none"}`);
    return text(result);
  }
);

server.tool(
  "journal_verify",
  "Check that the audit trail has not been altered. Every entry carries the hash of the one before it, so editing, deleting, reordering or inserting an entry breaks the chain at a line this names. Tamper-EVIDENT, not tamper-proof: whoever owns the file can still rewrite the chain from the edit onward — a signature and an external anchor are what close that, and both build on this.",
  {},
  async () => {
    const g = gate("journal_verify", {});
    if (g.gated) return g.response;
    const v = journal.verify();
    record("journal_verify", {}, g.cls, v.ok ? `intact (${v.checked} entries)` : `BROKEN at line ${v.broken.line}`);
    return text(v);
  }
);

server.tool(
  "working_set",
  "What THIS workspace has already been through, replayed from the journal: the files read, written and deleted, the commands run, and — the part worth the call — which of those files CHANGED underneath since the last action recorded against them. Call it first in a resumed session instead of re-exploring with ls/find/cat: one call in place of the probe commands, and it names where a stale assumption is about to cost a wrong edit. Only records what went through Nefertari; work done outside it leaves no trace and the answer says so.",
  {
    dir: z.string().optional().describe("Restrict to paths under this directory"),
    since: z.string().optional().describe("ISO timestamp; ignore anything older"),
    limit: z.number().int().min(1).max(200).optional().describe("Max files returned (default 40)"),
  },
  async ({ dir, since, limit }) => {
    const g = gate("working_set", { dir });
    if (g.gated) return g.response;
    const result = workingSet({ dir, since, limit });
    record("working_set", { dir, since }, g.cls, `${result.files.length} files, ${result.changed_since_last_action.length} changed`);
    return text(result);
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
      idle: idle.stats(),
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
