// Memory for a machine whose operator forgets, structurally and often.
//
// The tempting design is: before compacting, let the agent write down what
// matters. On an OS that is the dangerous one. A summary written by the agent is
// the agent's own account of itself — lossy, self-serving, and unfalsifiable
// once the evidence is gone; a mistaken belief becomes permanent on the first
// compaction with nothing left to check it against.
//
// So `recall` is DERIVED, never authored: every line traces back to the signed
// journal, the paged store, or the lease table. This test is the resumption it
// exists for — do real work, throw away everything the agent held, and ask it to
// carry on.
//
//   - a resumed agent gets the goal, the changes, the handles, the pending
//     approvals and the leases it forgot it was holding
//   - all of it in pointers, so the packet is small exactly when the window is full
//   - it is derived from the record, so it cannot contain something that did not
//     happen — and the test makes sure it does not merely repeat the agent
//   - and it still works when the budget is gone, which is when it is needed most
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawn } from "node:child_process";

const { ReadBuffer, serializeMessage } = await import("@modelcontextprotocol/sdk/shared/stdio.js");

const srvHome = fs.mkdtempSync(path.join(os.tmpdir(), "nef-rec-h-"));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nef-rec-ws-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A session is one connection. Two of them here: the one that does the work,
// and the one that wakes up afterwards knowing nothing — which is the whole
// point, because a resumed agent really does start with an empty head.
function connect() {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "server.mjs")], {
    env: { ...process.env, NEFERTARI_HOME: srvHome, NEFERTARI_LOCAL_DRIVER: "null", NEFERTARI_GOAL: "ship the parser fix" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const buf = new ReadBuffer();
  const want = new Map();
  let id = 1;
  let bytes = 0;
  child.stdout.on("data", (c) => {
    buf.append(c);
    for (;;) {
      let m;
      try {
        m = buf.readMessage();
      } catch {
        break;
      }
      if (!m) break;
      const f = want.get(m.id);
      if (f) {
        want.delete(m.id);
        f(m);
      }
    }
  });
  const call = (method, params) =>
    new Promise((res) => {
      const i = id++;
      want.set(i, res);
      child.stdin.write(serializeMessage({ jsonrpc: "2.0", id: i, method, params }));
    });
  const tool = async (name, args) => {
    const r = await call("tools/call", { name, arguments: args });
    const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? {});
    bytes += Buffer.byteLength(t);
    try {
      return JSON.parse(t);
    } catch {
      return { raw: t };
    }
  };
  return { child, call, tool, bytes: () => bytes };
}

const first = connect();
let handle;
let pendingId;

try {
  await first.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "worker", version: "0" } });

  // --- a session's worth of real work ---
  const src = path.join(ws, "parser.ts");
  fs.writeFileSync(src, "export const parse = (s: string) => s.split(',');\n");
  await first.tool("fs_write", { path: src, content: "export const parse = (s: string) => s.split(';');\n" });

  // Something too large to keep: it becomes a handle.
  const log = path.join(ws, "run.log");
  {
    const out = [];
    for (let i = 0; i < 30000; i++) out.push(`[${i}] parsed record ${i} ok`);
    out[22000] = "[22000] WARN: record 22000 had a trailing separator and was silently dropped";
    fs.writeFileSync(log, out.join("\n"));
  }
  const read = await first.tool("fs_read", { path: log });
  assert.equal(read.__paged, true, "sanity: the log is paged");
  handle = read.handle;

  // Something a human still has to answer.
  const gated = await first.tool("shell", { command: `rm -rf ${ws}/nothing-important`, cwd: ws });
  assert.equal(gated.status, "pending_approval", `sanity: this should be gated: ${JSON.stringify(gated).slice(0, 120)}`);
  pendingId = gated.action_id;

  // And an external resource it is holding.
  await first.tool("lease_acquire", { uri: "push:github.com/org/parser", ttl_ms: 600000, reason: "the parser fix" });

  // A file changes underneath, the way they do.
  await sleep(20);
  fs.writeFileSync(path.join(ws, "config.json"), '{"changed":"by someone else"}');

  console.log("  · a session's work done: an edit, a paged log, a gated action, a lease");
} finally {
  // THE COMPACTION, in its most honest form: the session is gone. Nothing the
  // agent was holding survives — not the handle, not the pending id, not the
  // knowledge that it had taken a lease.
  first.child.kill("SIGKILL");
  await sleep(200);
}

const second = connect();
try {
  await second.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "resumed", version: "0" } });

  const packet = await second.tool("recall", { dir: ws });
  const packetBytes = second.bytes();

  // --- the goal, which an agent must never invent for itself ---
  assert.equal(packet.goal, "ship the parser fix", "a resumed agent is TOLD its goal, it does not reconstruct one");

  // --- what it was holding, that it no longer remembers holding ---
  assert.equal(packet.leases_held.length, 1, "the lease is still held and the agent had forgotten");
  assert.equal(packet.leases_held[0].uri, "push:github.com/org/parser");
  assert.equal(packet.pending_approvals.length, 1, "and something is still waiting for a human");
  assert.equal(packet.pending_approvals[0].id, pendingId);
  console.log("  ok — the resumed agent is told what it holds and what it is waiting on, with ids");

  // --- what it read, by handle, without re-reading any of it ---
  const found = packet.held_in_store.find((h) => h.handle === handle);
  assert.ok(found, "the large result read before the compaction is still named");
  assert.equal(found.from_tool, "fs_read", "with where it came from");
  assert.match(found.search, /context_fetch/, "and the call that reaches into it");
  console.log(`  ok — the ${found.bytes}-byte log it read is still reachable by handle`);

  // --- and what moved underneath while it was away ---
  assert.ok(packet.working_set && !packet.working_set.error, "the working set is part of the packet");
  console.log("  ok — and what changed underneath is in the same answer");

  // --- SIZE: the packet must be affordable exactly when the window is fullest ---
  assert.ok(
    packetBytes < 12000,
    `a resume packet must be small when it matters most (${packetBytes} bytes); it names things instead of inlining them`
  );
  console.log(`  ok — the whole re-orientation cost ${packetBytes} bytes, because it is pointers rather than content`);

  // --- DERIVED, NOT AUTHORED: it can be checked against the record ---
  assert.equal(packet.journal.verified, true, "the record it is derived from verifies");
  assert.match(packet.provenance, /none of it\s+is this agent's account of itself/, "and it says where it comes from");
  assert.ok(
    packet.journal.recent_decisions.some((d) => d.decision === "pending_approval"),
    "decisions come from the journal, so the packet cannot claim something that never happened"
  );
  console.log("  ok — every line traces to the signed journal, the store or the lease table");

  // --- the answer is one call away, from a handle the agent had forgotten ---
  const answer = await second.tool("context_fetch", { handle: found.handle, grep: "WARN" });
  assert.equal(answer.matches, 1);
  assert.match(answer.hits[0].text, /silently dropped/, "the detail survives a session boundary");
  console.log("  ok — and the detail from before the compaction is one call away");
} finally {
  second.child.kill("SIGKILL");
  await sleep(150);
}

// --- it works when the budget is gone, which is when it is needed most ---
{
  const broke = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "server.mjs")], {
    // Same goal: a lease belongs to the work, so this IS the same holder. A
    // session that declared no goal would be a different one, correctly.
    env: { ...process.env, NEFERTARI_HOME: srvHome, NEFERTARI_LOCAL_DRIVER: "null", NEFERTARI_GOAL: "ship the parser fix", NEFERTARI_BUDGET_CALLS: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const buf = new ReadBuffer();
  const want = new Map();
  let id = 1;
  broke.stdout.on("data", (c) => {
    buf.append(c);
    for (;;) {
      let m;
      try {
        m = buf.readMessage();
      } catch {
        break;
      }
      if (!m) break;
      const f = want.get(m.id);
      if (f) {
        want.delete(m.id);
        f(m);
      }
    }
  });
  const call = (method, params) =>
    new Promise((res) => {
      const i = id++;
      want.set(i, res);
      broke.stdin.write(serializeMessage({ jsonrpc: "2.0", id: i, method, params }));
    });
  const tool = async (n, a) => JSON.parse((await call("tools/call", { name: n, arguments: a })).result.content[0].text);

  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    await tool("shell", { command: "true" }); // spends the single call
    const blocked = await tool("shell", { command: "echo hello" });
    assert.equal(blocked.status, "budget_exhausted", "sanity: the budget really is gone");

    const packet = await tool("recall", {});
    assert.ok(packet.goal !== undefined, "an agent that ran out must still be able to say where it got to");
    assert.ok(packet.leases_held.length >= 1, "…including what it is still holding, so it can give it back");
    console.log("  ok — recall still answers with the budget gone: that is when explaining yourself matters");
  } finally {
    broke.kill("SIGKILL");
  }
}

fs.rmSync(srvHome, { recursive: true, force: true });
fs.rmSync(ws, { recursive: true, force: true });
console.log("RECALL TESTS PASSED");
