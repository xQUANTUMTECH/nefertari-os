// HARD E2E — a realistic sysadmin ordeal driven entirely through the MCP wire,
// asserting the safety guarantees hold end-to-end (not just in unit classification):
//
//   1. read a config, deploy a BROKEN version (snapshotted)
//   2. validate → fails → ROLL BACK to the working version, prove it's restored
//   3. agent attempts a destructive cleanup (rm -rf) → GATED.
//      Prove it is *physical*: the data is STILL ON DISK after the gated call.
//   4. human approves out-of-band → agent retries → executes exactly ONCE.
//   5. retry again → gated again (single-use). No double execution.
//   6. the journal is a complete, auditable trail of all of it.
//
// Exit 0 only if every guarantee holds.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as approvals from "../src/approvals.mjs"; // stands in for the human at the CLI

assert.ok(process.env.NEFERTARI_HOME, "set NEFERTARI_HOME to a temp dir");

// --- build a fake "system" to operate on ---
const sys = fs.mkdtempSync(path.join(os.tmpdir(), "nef-sys-"));
const conf = path.join(sys, "app.conf");
const dataDir = path.join(sys, "cache");
fs.mkdirSync(dataDir);
fs.writeFileSync(conf, "workers=4\nport=8080\n"); // known-good config
fs.writeFileSync(path.join(dataDir, "blob1.bin"), "x".repeat(1000));
fs.writeFileSync(path.join(dataDir, "blob2.bin"), "y".repeat(1000));

const client = new Client({ name: "hard-e2e", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, "..", "src", "server.mjs")],
    env: { ...process.env },
  })
);
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const readRaw = async (p) => (await client.callTool({ name: "fs_read", arguments: { path: p } })).content[0].text;

let step = 0;
const done = (m) => console.log(`  ✓ [${++step}] ${m}`);

// 1. deploy a broken config, snapshotted
const good = await readRaw(conf);
assert.match(good, /port=8080/);
const w = await call("fs_write", { path: conf, content: "workers=oops\nport=NOTANUMBER\n" });
assert.equal(w.status, "written");
assert.ok(w.snapshot_id, "write must return a snapshot id");
done("deployed a broken config (snapshot captured)");

// 2. validate → fail → roll back
const validate = await call("shell", {
  command: `grep -Eq '^port=[0-9]+$' ${conf} && echo VALID || echo INVALID`,
});
assert.match(validate.stdout, /INVALID/, "broken config must fail validation");
done("validation correctly reports the config broken");

const undo = await call("undo", { snapshot_id: w.snapshot_id });
assert.equal(undo.status, "restored");
const afterUndo = await readRaw(conf);
assert.equal(afterUndo, good, "rollback must restore the exact working config");
const revalidate = await call("shell", {
  command: `grep -Eq '^port=[0-9]+$' ${conf} && echo VALID || echo INVALID`,
});
assert.match(revalidate.stdout, /VALID/, "restored config must pass validation");
done("rolled back to the working config and re-validated");

// 3. destructive cleanup MUST be gated — and physically blocked
const nuke = { command: `rm -rf ${dataDir}` };
const gated = await call("shell", nuke);
assert.equal(gated.status, "pending_approval", "rm -rf must be gated, not executed");
assert.ok(fs.existsSync(dataDir), "GATE MUST BE PHYSICAL: data dir must still exist");
assert.equal(fs.readdirSync(dataDir).length, 2, "no files may be touched before approval");
done(`destructive cleanup gated (${gated.action_id}) — data untouched on disk`);

// 4. human approves out-of-band, then the agent retries the exact same call
const pending = approvals.listPending();
assert.equal(pending.length, 1);
approvals.approve(pending[0].id); // == `nefertari approve <id>` at the CLI
const executed = await call("shell", nuke);
assert.equal(executed.exitCode, 0, "after approval the command runs");
assert.ok(!fs.existsSync(dataDir), "after approval the cleanup actually happened");
done("human approved → retry executed exactly once → data removed");

// 5. single-use: replaying the approved call must be gated again
const replay = await call("shell", nuke);
assert.equal(replay.status, "pending_approval", "approval must not be reusable");
done("replay of the approved command is gated again (single-use)");

// 6. the journal is a complete audit trail
const j = await call("journal_tail", { n: 100 });
const decisions = j.map((e) => e.decision);
assert.ok(decisions.includes("pending_approval"), "gate is journaled");
assert.ok(decisions.includes("approved_by_human"), "approved execution is journaled");
assert.ok(j.some((e) => e.tool === "undo" && e.outcome === "ok"), "rollback is journaled");
assert.ok(j.filter((e) => e.tool === "fs_write").length >= 1, "writes are journaled");
done(`journal holds a complete auditable trail (${j.length} entries)`);

fs.rmSync(sys, { recursive: true, force: true });
await client.close();
console.log("\nHARD E2E PASSED — every safety guarantee held end-to-end.");
