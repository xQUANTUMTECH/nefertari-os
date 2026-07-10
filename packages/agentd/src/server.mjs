#!/usr/bin/env node
// agentd — Nefertari OS system daemon. MCP server over stdio.
// Every tool call flows through the permission broker; every action is journaled;
// every write is snapshotted; irreversible actions wait for the human gate.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { classify, CLASS } from "./broker.mjs";
import { enforceWrap } from "./enforce.mjs";
import * as journal from "./journal.mjs";
import * as snapshots from "./snapshots.mjs";
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
    const data = fs.readFileSync(p, "utf8");
    record("fs_read", { path: p }, g.cls, "ok", { bytes: data.length });
    return text(data);
  }
);

server.tool(
  "fs_write",
  "Write a file on the host. The previous content is snapshotted automatically; the result includes the snapshot_id for undo.",
  { path: z.string(), content: z.string() },
  async ({ path: p, content }) => {
    const g = gate("fs_write", { path: p });
    if (g.gated) return g.response;
    const snapId = snapshots.snapshot([p], { tool: "fs_write" });
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
    fs.writeFileSync(p, content);
    record("fs_write", { path: p }, g.cls, "ok", { snapshotId: snapId, bytes: content.length });
    return text({ status: "written", path: p, snapshot_id: snapId });
  }
);

server.tool(
  "fs_delete",
  "Delete a single file on the host. The file is snapshotted first so the deletion is undoable.",
  { path: z.string() },
  async ({ path: p }) => {
    const g = gate("fs_delete", { path: p });
    if (g.gated) return g.response;
    if (!fs.existsSync(p)) return text({ status: "noop", reason: "file does not exist" });
    if (fs.statSync(p).isDirectory()) return text({ status: "refused", reason: "directories are not deletable in phase 1 (not snapshot-covered)" });
    const snapId = snapshots.snapshot([p], { tool: "fs_delete" });
    fs.rmSync(p);
    record("fs_delete", { path: p }, g.cls, "ok", { snapshotId: snapId });
    return text({ status: "deleted", path: p, snapshot_id: snapId });
  }
);

server.tool(
  "shell",
  "Run a shell command on the host. Read-only commands pass; known state-changing commands pass with notification; anything else requires human approval first.",
  { command: z.string(), cwd: z.string().optional() },
  async ({ command, cwd }) => {
    const g = gate("shell", { command });
    if (g.gated) return g.response;
    const workdir = cwd || os.homedir();
    // Reversible commands run under Landlock (writes confined to workdir + /tmp)
    // when the enforcer is installed; everything else runs as before.
    const { file, args: execArgs, enforced, driver } = enforceWrap(command, { cls: g.cls, cwd: workdir });
    const result = await new Promise((resolve) => {
      execFile(file, execArgs, { cwd: workdir, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ exitCode: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
    record("shell", { command }, g.cls, result.exitCode === 0 ? "ok" : `exit ${result.exitCode}`, { notify: g.cls === CLASS.NOISY, enforced: !!enforced, driver });
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
