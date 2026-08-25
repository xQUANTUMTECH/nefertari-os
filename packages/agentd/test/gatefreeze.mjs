// H4 — gate-freeze: what a goal waiting for a human should cost.
//
// The claim is "agent at the gate = 0 CPU, resume in milliseconds", and the
// interesting half is the one that is easy to fake. An agent waiting on a tool
// reply is already blocked on a read and already near zero — so measuring the
// AGENT proves nothing about the mechanism. What the freeze adds is the rest of
// the tree: the build it started, the subagent mid-flight, a harness that polls
// while a call is outstanding. So the test puts a process that SPINS in the
// agent's group and measures that.
//
//   - a spinning child in the agent's tree burns CPU while the gate is open…
//   - …and burns none while the gate holds it
//   - it is thawed on the way out, including on timeout — nobody is left frozen
//   - resume costs milliseconds
//   - end to end: with gate-wait on, the agent's call BLOCKS and then returns
//     the executed result, never a "come back later"
//   - and with gate-wait off, the gate behaves exactly as it always did
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawn, execFileSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-gf-"));
process.env.NEFERTARI_HOME = home;
process.env.NEFERTARI_GATE_WAIT_MS = "5000";

const cgroups = await import("../src/cgroups.mjs");
const gatefreeze = await import("../src/gatefreeze.mjs");

const a = cgroups.available();
if (!a.ok) {
  console.log(`  skip — ${a.reason}; the freeze is the test`);
  console.log("GATEFREEZE TESTS PASSED (skipped: no cgroup v2)");
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(0);
}

const group = `nef-gf-${process.pid}`;
const ens = cgroups.ensure(group);
assert.ok(ens.ok, `the group must exist: ${ens.reason}`);

// A process that does nothing but burn CPU, placed in the group by itself
// before exec — moving it afterwards is a race the mover usually loses.
const spinner = spawn("/bin/sh", ["-c", `echo $$ > ${cgroups.procsPath(group)}; exec /bin/sh -c 'while :; do :; done'`], {
  stdio: "ignore",
});
gatefreeze.registerAgent({ cgroup: group, pid: spinner.pid, command: "spinner" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cpu = () => cgroups.usage(group)?.usage_usec ?? null;

try {
  await sleep(300);
  assert.ok(cpu() !== null, "cpu accounting must be readable, or the measurement below means nothing");

  // --- the gate is open: the tree costs what it costs ---
  const before = cpu();
  await sleep(400);
  const spentRunning = cpu() - before;
  assert.ok(spentRunning > 50000, `sanity: a spinning child must burn CPU (got ${spentRunning}µs in 400ms)`);
  console.log(`  ok — with the gate open, the agent's child burns ${Math.round(spentRunning / 1000)}ms of CPU per 400ms`);

  // --- the gate holds: the same tree costs nothing ---
  // Resolved after 400ms, exactly as a human coming back would.
  let approved = false;
  setTimeout(() => {
    approved = true;
  }, 400);

  const atFreeze = cpu();
  const t0 = process.hrtime.bigint();
  const held = await gatefreeze.hold(() => approved, { waitMs: 5000, pollMs: 20 });
  const heldMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const spentFrozen = cpu() - atFreeze;

  assert.ok(held.resolved, "the hold must end when the human answers");
  assert.ok(held.froze, `the tree must actually be frozen, not merely waited on: ${held.reason}`);
  assert.ok(heldMs >= 380, `sanity: it really waited (${Math.round(heldMs)}ms)`);
  assert.ok(
    spentFrozen < spentRunning / 10,
    `frozen must cost an order of magnitude less: ${spentFrozen}µs frozen vs ${spentRunning}µs running`
  );
  console.log(
    `  ok — while the gate holds, the same child burns ${spentFrozen}µs over ${Math.round(heldMs)}ms ` +
      `(${Math.round(spentRunning / Math.max(spentFrozen, 1))}× less)`
  );

  // --- and it is running again afterwards: a freeze you cannot leave is a hang ---
  assert.equal(cgroups.frozen(group), false, "the tree must be thawed when the hold returns");
  const afterThaw = cpu();
  await sleep(200);
  assert.ok(cpu() - afterThaw > 20000, "PHYSICAL: the child must be burning CPU again, not merely marked thawed");
  console.log("  ok — thawed on the way out: the child is running again");

  // --- the human who never comes back must not leave anyone frozen ---
  {
    const t = process.hrtime.bigint();
    const timedOut = await gatefreeze.hold(() => false, { waitMs: 300, pollMs: 20 });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.equal(timedOut.resolved, false);
    assert.ok(ms >= 280 && ms < 2000, `it must give up on time (${Math.round(ms)}ms)`);
    assert.equal(cgroups.frozen(group), false, "TIMEOUT MUST THAW: an agent frozen by a bug here looks like a hung machine");
    console.log("  ok — on timeout the gate gives up and thaws, rather than stranding the tree");
  }

  // --- a registration whose process is gone must not freeze a recycled pid ---
  {
    const stale = path.join(home, "agent.json");
    const saved = fs.readFileSync(stale, "utf8");
    fs.writeFileSync(stale, JSON.stringify({ cgroup: group, pid: 0x7ffffff0, command: "long gone" }));
    assert.equal(gatefreeze.agent(), null, "a dead pid means the file outlived the agent, and names nothing safe to freeze");
    fs.writeFileSync(stale, saved);
    console.log("  ok — a stale registration is ignored, not acted on");
  }
} finally {
  spinner.kill("SIGKILL");
  await sleep(150);
  cgroups.destroy(group);
  gatefreeze.clearAgent();
}

// --- END TO END: the agent's call blocks, then returns the executed result ---
{
  const { ReadBuffer, serializeMessage } = await import("@modelcontextprotocol/sdk/shared/stdio.js");

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nef-gf-ws-"));
  const target = path.join(ws, "out.txt");
  const srvHome = fs.mkdtempSync(path.join(os.tmpdir(), "nef-gf-h-"));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "server.mjs")], {
    env: { ...process.env, NEFERTARI_HOME: srvHome, NEFERTARI_LOCAL_DRIVER: "null", NEFERTARI_GATE_WAIT_MS: "8000" },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const buf = new ReadBuffer();
  const want = new Map();
  let id = 1;
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

  const cli = path.join(import.meta.dirname, "..", "src", "cli.mjs");
  const inHome = (args) => execFileSync(process.execPath, [cli, ...args], { env: { ...process.env, NEFERTARI_HOME: srvHome }, stdio: "pipe" }).toString();

  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });

    const cmd = { command: `echo done >> ${target}` };
    const t0 = process.hrtime.bigint();
    const pending = call("tools/call", { name: "shell", arguments: cmd });

    // The agent is waiting. The human takes a moment, then approves — out of
    // band, at the CLI, which is the only way an approval is ever given.
    let seen = null;
    for (let i = 0; i < 100 && !seen; i++) {
      await sleep(50);
      // Read from the daemon home directly: the CLI prints for a human, and a
      // test that scrapes prose breaks the day the prose improves.
      const pf = path.join(srvHome, "pending.json");
      const list = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, "utf8")) : [];
      seen = list[0]?.id ?? null;
    }
    assert.ok(seen, "the action must be queued for a human while the call is held");
    assert.ok(!fs.existsSync(target), "GATE MUST BE PHYSICAL: nothing may happen before the human answers");
    inHome(["approve", seen]);

    const res = await pending;
    const waitedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const body = JSON.parse(res.result.content[0].text);
    assert.equal(body.exitCode, 0, `the held call must come back EXECUTED, not "come back later": ${JSON.stringify(body).slice(0, 200)}`);
    assert.equal(fs.readFileSync(target, "utf8"), "done\n", "PHYSICAL: and the action actually happened, once");
    console.log(`  ok — end to end: the call blocked ${Math.round(waitedMs)}ms at the gate and returned the executed result`);

    const j = fs
      .readFileSync(path.join(srvHome, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const approvedEntry = j.find((e) => e.decision === "approved_by_human" && e.waited_ms !== undefined);
    assert.ok(approvedEntry, "the wait is journalled: how long a human took is part of the record");
    assert.ok("frozen" in approvedEntry, "and whether the tree was ACTUALLY frozen is said, never implied");
    console.log(`  ok — journalled: waited ${approvedEntry.waited_ms}ms, frozen=${approvedEntry.frozen}`);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(srvHome, { recursive: true, force: true });
  }
}

// --- unset, the gate is exactly the gate it always was ---
{
  delete process.env.NEFERTARI_GATE_WAIT_MS;
  const fresh = await import(`../src/gatefreeze.mjs?nocache=${Date.now()}`);
  assert.equal(fresh.enabled(), false, "default off: holding a tool reply changes what an agent observes");
  const r = await fresh.hold(() => true, { waitMs: 0 });
  assert.equal(r.resolved, false);
  assert.equal(r.froze, false);
  console.log("  ok — with NEFERTARI_GATE_WAIT_MS unset, nothing is held and nothing is frozen");
}

fs.rmSync(home, { recursive: true, force: true });
console.log("GATEFREEZE TESTS PASSED");
