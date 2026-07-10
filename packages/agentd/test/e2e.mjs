// E2E: spawn agentd over stdio like a real MCP client, exercise tools end-to-end.
// Run: NEFERTARI_HOME=$(mktemp -d) node test/e2e.mjs

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

assert.ok(process.env.NEFERTARI_HOME, "set NEFERTARI_HOME to a temp dir before running");

const client = new Client({ name: "e2e", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, "..", "src", "server.mjs")],
    env: { ...process.env },
  })
);

const parse = (r) => JSON.parse(r.content[0].text);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log("tools:", names.join(", "));
assert.deepEqual(names, [
  "fs_delete",
  "fs_read",
  "fs_write",
  "journal_tail",
  "pending_list",
  "plan_run",
  "shell",
  "sys_status",
  "timeline_checkpoint",
  "timeline_fork",
  "timeline_list",
  "timeline_promote",
  "timeline_restore",
  "trajectories_run",
  "undo",
]);

// write → read → undo roundtrip
const work = fs.mkdtempSync(path.join(os.tmpdir(), "nef-e2e-"));
const f = path.join(work, "hello.txt");
const w = parse(await client.callTool({ name: "fs_write", arguments: { path: f, content: "v1" } }));
assert.equal(w.status, "written");
const w2 = parse(await client.callTool({ name: "fs_write", arguments: { path: f, content: "v2" } }));
const r1 = await client.callTool({ name: "fs_read", arguments: { path: f } });
assert.equal(r1.content[0].text, "v2");
const u = parse(await client.callTool({ name: "undo", arguments: { snapshot_id: w2.snapshot_id } }));
assert.equal(u.status, "restored");
const r2 = await client.callTool({ name: "fs_read", arguments: { path: f } });
assert.equal(r2.content[0].text, "v1");
console.log("write → read → undo roundtrip: OK");

// safe shell passes, dangerous shell is gated
const sh = parse(await client.callTool({ name: "shell", arguments: { command: "uname -sr && whoami" } }));
assert.equal(sh.exitCode, 0);
console.log("safe shell:", sh.stdout.trim().replace(/\n/g, " · "));
const danger = parse(await client.callTool({ name: "shell", arguments: { command: `rm -rf ${work}` } }));
assert.equal(danger.status, "pending_approval");
console.log(`dangerous shell correctly gated → ${danger.action_id} (waiting for: nefertari approve)`);

// plan_run over MCP: multi-step in one call; irreversible plans gate up front
const plan = parse(
  await client.callTool({
    name: "plan_run",
    arguments: {
      dir: work,
      steps: [
        { tool: "fs_write", args: { path: path.join(work, "p.txt"), content: "PLAN" } },
        { tool: "shell", args: { command: "cat p.txt" } },
      ],
    },
  })
);
assert.equal(plan.status, "completed");
assert.equal(plan.steps[1].output.stdout, "PLAN");
const gatedPlan = parse(
  await client.callTool({
    name: "plan_run",
    arguments: { dir: work, steps: [{ tool: "shell", args: { command: `rm -rf ${work}` } }] },
  })
);
assert.equal(gatedPlan.status, "pending_approval");
console.log("plan_run: 2 steps in 1 call OK; irreversible plan gated up front");

// trajectories_run over MCP: fork ×2, race strategies, promote the winner
const ckR = parse(await client.callTool({ name: "timeline_checkpoint", arguments: { dir: work, label: "e2e traj" } }));
const traj = parse(
  await client.callTool({
    name: "trajectories_run",
    arguments: {
      checkpoint_id: ckR.checkpoint_id,
      trajectories: [
        { label: "bad", steps: [{ tool: "fs_write", args: { path: "answer.txt", content: "BAD" } }] },
        { label: "good", steps: [{ tool: "fs_write", args: { path: "answer.txt", content: "GOOD" } }] },
      ],
      eval_cmd: "grep -q GOOD answer.txt",
    },
  })
);
assert.equal(traj.winner.label, "good");
assert.ok(!fs.existsSync(path.join(work, "answer.txt")), "speculation left the original untouched");
const prom = parse(await client.callTool({ name: "timeline_promote", arguments: { fork_id: traj.winner.fork_id, dir: work } }));
assert.equal(prom.status, "promoted");
assert.equal(fs.readFileSync(path.join(work, "answer.txt"), "utf8"), "GOOD");
console.log("trajectories_run: 2 strategies raced in forks, winner promoted");

// journal saw everything
const j = parse(await client.callTool({ name: "journal_tail", arguments: { n: 50 } }));
assert.ok(j.some((e) => e.decision === "pending_approval"));
assert.ok(j.filter((e) => e.tool === "fs_write").length >= 2);
console.log(`journal entries: ${j.length}`);

fs.rmSync(work, { recursive: true, force: true });
await client.close();
console.log("\nE2E PASSED");
