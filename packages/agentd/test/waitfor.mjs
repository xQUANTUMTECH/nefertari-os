// wait_for — wake on an event, not on a clock.
//
// The value is a turn count, not a wall-clock: an agent that polls for a
// ten-minute build spends ten round trips learning nothing, and one that waits
// spends zero. So the end-to-end test counts CALLS, which is the thing being
// saved.
//
// The rest of it is the two ways this can be got wrong:
//
//   - a condition with EFFECTS would be run once per poll — a hundred times
//     over a long wait — so a command condition must be read-only, and is
//     refused by name when it is not
//   - freezing the agent's tree is right at the human gate and WRONG here: the
//     thing being waited for is very often a child of the agent, and freezing
//     the producer is a deadlock wearing a timeout's clothes. The test builds
//     exactly that deadlock to show the rule is not theoretical.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawn } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-wf-"));
process.env.NEFERTARI_HOME = home;

const { compile, waitFor, freezeDecision } = await import("../src/waitfor.mjs");
const gatefreeze = await import("../src/gatefreeze.mjs");
const cgroups = await import("../src/cgroups.mjs");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nef-wf-ws-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a condition with effects is refused, and told why ---
{
  const bad = compile({ type: "command_succeeds", command: "rm -rf /tmp/whatever" });
  assert.equal(bad.ok, false, "a destructive condition must not be accepted");
  assert.match(bad.reason, /evaluated on every poll/, "and the reason must be the one that matters");

  const alsoBad = compile({ type: "command_succeeds", command: "npm install" });
  assert.equal(alsoBad.ok, false, "state-changing is enough: it need not be destructive to be wrong");

  const good = compile({ type: "command_succeeds", command: "test -f /etc/hostname" });
  assert.equal(good.ok, true, "a read-only command is exactly what a condition should be");
  console.log("  ok — a condition that would change something is refused, not run 100 times");
}

// --- unknown conditions do not silently never come true ---
{
  const r = await waitFor({ type: "vibes" });
  assert.match(r.error, /unknown condition type/);
  assert.match(r.error, /path_exists/, "and the answer names what IS possible");
  console.log("  ok — an unknown condition is an error, not an eternal wait");
}

// --- path_changed means changed since the CALL, not at some point ever ---
{
  const f = path.join(ws, "settled.txt");
  fs.writeFileSync(f, "old");
  await sleep(20);
  const c = compile({ type: "path_changed", path: f });
  assert.equal(await c.test(), false, "a file written BEFORE the call has not changed since it");
  fs.writeFileSync(f, "new");
  assert.equal(await c.test(), true, "and one written after it has");
  console.log("  ok — path_changed is measured from the moment you asked");
}

// --- the thing it is for: waiting on work that finishes later ---
{
  const log = path.join(ws, "build.log");
  fs.writeFileSync(log, "compiling…\n");
  const worker = setTimeout(() => fs.appendFileSync(log, "BUILD SUCCESS\n"), 400);

  const t0 = Date.now();
  const r = await waitFor({ type: "file_contains", path: log, pattern: "BUILD SUCCESS" }, { timeoutMs: 5000, pollMs: 50 });
  clearTimeout(worker);

  assert.equal(r.satisfied, true, "the wait must end when the line appears");
  assert.ok(r.waited_ms >= 350 && r.waited_ms < 3000, `and end near when it appeared, not later (${r.waited_ms}ms)`);
  assert.ok(r.polls > 1, "sanity: it actually looked more than once");
  console.log(`  ok — waited ${r.waited_ms}ms for a log line, across ${r.polls} polls the agent never saw`);
}

// --- and not happening is an answer, not an exception ---
{
  const r = await waitFor({ type: "path_exists", path: path.join(ws, "never") }, { timeoutMs: 300, pollMs: 50 });
  assert.equal(r.satisfied, false);
  assert.equal(r.timed_out, true);
  assert.match(r.hint, /may be wrong/, "an agent needs to know the two cases it cannot tell apart");
  console.log("  ok — a condition that never holds times out with an explanation");
}

// --- FREEZING: right at the gate, wrong here — and the difference is provable ---
const cg = cgroups.available();
if (!cg.ok) {
  console.log(`  skip — ${cg.reason}`);
} else {
  const group = `nef-wf-${process.pid}`;
  const ens = cgroups.ensure(group);
  assert.ok(ens.ok, `the group must exist: ${ens.reason}`);

  // The agent, standing in for a harness: a process that does nothing.
  const agent = spawn("/bin/sh", ["-c", `echo $$ > ${cgroups.procsPath(group)}; exec sleep 60`], { stdio: "ignore" });
  await sleep(200);
  gatefreeze.registerAgent({ cgroup: group, pid: agent.pid, command: "agent" });

  let producer;
  try {
    // With only the agent in the tree, there is nothing in it that could produce
    // a condition, so freezing is safe.
    {
      const d = freezeDecision();
      assert.equal(d.freeze, true, `an empty tree is safe to freeze: ${d.why}`);
      console.log("  ok — with only the agent in the tree, the wait may freeze it");
    }

    // Now the agent starts a build. It is a CHILD, so it is in the tree.
    const flag = path.join(ws, "child-done");
    producer = spawn(
      "/bin/sh",
      ["-c", `echo $$ > ${cgroups.procsPath(group)}; exec /bin/sh -c 'sleep 0.5; echo done > ${flag}'`],
      { stdio: "ignore" }
    );
    await sleep(150);

    const d = freezeDecision();
    assert.equal(d.freeze, false, "a tree with other work in it must NOT be frozen");
    assert.match(d.why, /may be what produces this condition/, "and the reason must be the deadlock, not a shrug");
    console.log("  ok — with work in the tree, the wait refuses to freeze it");

    // The proof that the rule is not theoretical: frozen, this wait would fail.
    // The producer is stopped by hand, the condition is watched, and it never
    // comes — which is precisely what freezing would have caused.
    cgroups.freeze(group);
    const dead = await waitFor({ type: "path_exists", path: flag }, { timeoutMs: 700, pollMs: 50 });
    assert.equal(dead.satisfied, false, "with the producer frozen the condition cannot come true — that is the deadlock");
    cgroups.thaw(group);
    console.log("  ok — and frozen, that same wait deadlocks: the rule is not theoretical");

    // Thawed, the same wait finishes: nothing was broken, only stopped.
    const alive = await waitFor({ type: "path_exists", path: flag }, { timeoutMs: 3000, pollMs: 50 });
    assert.equal(alive.satisfied, true, "thawed, the producer finishes and the condition holds");
    assert.equal(alive.frozen, false, "and the wait itself did not freeze the tree that was doing the work");
    console.log(`  ok — thawed, the same wait is satisfied in ${alive.waited_ms}ms`);
  } finally {
    agent.kill("SIGKILL");
    producer?.kill("SIGKILL");
    await sleep(200);
    cgroups.destroy(group);
    gatefreeze.clearAgent();
  }
}

// --- END TO END: what this actually saves is TURNS ---
{
  const { ReadBuffer, serializeMessage } = await import("@modelcontextprotocol/sdk/shared/stdio.js");
  const srvHome = fs.mkdtempSync(path.join(os.tmpdir(), "nef-wf-h-"));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "server.mjs")], {
    env: { ...process.env, NEFERTARI_HOME: srvHome, NEFERTARI_LOCAL_DRIVER: "null" },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const buf = new ReadBuffer();
  const want = new Map();
  let id = 1;
  let calls = 0;
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
  const call = (method, params) => {
    if (method === "tools/call") calls++;
    return new Promise((res) => {
      const i = id++;
      want.set(i, res);
      child.stdin.write(serializeMessage({ jsonrpc: "2.0", id: i, method, params }));
    });
  };

  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });

    const flag = path.join(ws, "ci-finished");
    setTimeout(() => fs.writeFileSync(flag, "green"), 600);

    const res = await call("tools/call", {
      name: "wait_for",
      arguments: { type: "path_exists", path: flag, timeout_ms: 5000, poll_ms: 100 },
    });
    const body = JSON.parse(res.result.content[0].text);
    assert.equal(body.satisfied, true, `the daemon must have waited: ${JSON.stringify(body).slice(0, 200)}`);
    assert.equal(calls, 1, "ONE tool call covered the whole wait — the polling turns are the thing being saved");
    assert.ok(body.polls >= 3, `and the daemon did the looking instead (${body.polls} polls)`);
    console.log(`  ok — end to end: 1 tool call, ${body.polls} polls by the daemon, ${body.waited_ms}ms waited`);

    // Refusal reaches the agent as an answer it can act on, not as a crash.
    const bad = await call("tools/call", {
      name: "wait_for",
      arguments: { type: "command_succeeds", command: "rm -rf /tmp/x", timeout_ms: 500 },
    });
    const badBody = JSON.parse(bad.result.content[0].text);
    assert.equal(badBody.status, "refused");
    assert.match(badBody.reason, /no effects/);
    console.log("  ok — and a condition with effects is refused through the tool, with the reason");

    const j = fs
      .readFileSync(path.join(srvHome, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(
      j.some((e) => e.tool === "wait_for" && e.waited_ms !== undefined),
      "the wait is journalled: how long an agent was blocked is part of what happened"
    );
    console.log("  ok — the wait is on the record, with how long it took");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(srvHome, { recursive: true, force: true });
  }
}

fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log("WAIT_FOR TESTS PASSED");
