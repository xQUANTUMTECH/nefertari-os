// Leases on things that are not on this machine.
//
// Every lock a system hands you is about a local resource. An agent's effects
// are mostly somewhere else: two agents pushing the same branch, deploying the
// same service or charging the same customer are not racing over anything
// `flock` can see, and the loser finds out afterwards.
//
// What is worth testing is not the table — a table is easy — but the four
// things that decide whether anyone can rely on it:
//
//   - the URI is INFERRED from the action, because an agent that must remember
//     to take a lease will forget on exactly the run that needed it
//   - a conflict is refused with WHO and HOW LONG, so the caller has a move
//   - a lease held by a dead process is reclaimed, or the first crash teaches
//     the operator to delete the file and ignore the mechanism
//   - two real daemons, two real agents, one repo: the second is stopped
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawn } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-lease-"));
process.env.NEFERTARI_HOME = home;

const leases = await import("../src/leases.mjs");

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nef-lease-repo-"));
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
fs.writeFileSync(
  path.join(repo, ".git", "config"),
  '[remote "origin"]\n\turl = git@github.com:xQUANTUMTECH/nefertari-os.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the URI comes from the action, not from the agent remembering ---
{
  assert.equal(
    leases.uriFor("shell", { command: "git push", cwd: repo }),
    "push:github.com/xQUANTUMTECH/nefertari-os",
    "a bare `git push` still names the remote it will reach — read from the repo, not the command line"
  );
  assert.equal(
    leases.uriFor("shell", { command: "git push origin master", cwd: repo }),
    "push:github.com/xQUANTUMTECH/nefertari-os",
    "and naming the remote explicitly reaches the same resource"
  );
  assert.equal(
    leases.uriFor("shell", { command: "gh pr merge 12", cwd: repo }),
    "push:github.com/xQUANTUMTECH/nefertari-os",
    "merging a PR touches what a push touches: the same collision by another route"
  );
  assert.equal(
    leases.uriFor("shell", { command: "docker push ghcr.io/org/img:1" }),
    "push:docker/ghcr.io/org/img:1"
  );
  console.log("  ok — the resource is inferred from the action, including where the command does not say it");
}

// --- and most actions name nothing, which is the correct answer ---
{
  for (const cmd of ["git status", "git log --oneline", "ls -la", "npm test", "cat README.md"]) {
    assert.equal(leases.uriFor("shell", { command: cmd, cwd: repo }), null, `${cmd} touches nothing shared`);
  }
  assert.equal(leases.uriFor("fs_write", { path: "/w/a.txt" }), null, "a local write is not a shared resource");
  console.log("  ok — reads, builds and local edits name nothing: this is not a lock on the machine");
}

// --- taking it, and being told who has it ---
{
  const uri = "deploy:railway/api";
  const a = leases.acquire(uri, { ttlMs: 60000, reason: "shipping the fix" });
  assert.equal(a.ok, true);

  const other = leases.acquire(uri, { holder: "pid:1/other-agent" });
  assert.equal(other.ok, false, "a second holder must not get it");
  assert.equal(other.held_by, leases.holderId());
  assert.equal(other.reason, "shipping the fix", "and must be told what the holder is doing");
  assert.ok(other.expires_in_ms > 50000, "…and how long they have left, which is the part they can act on");
  console.log("  ok — a second claimant is told who holds it, why, and for how long");

  // Asking again when you already hold it extends rather than fails: an agent
  // doing ten pushes should not have to track its own bookkeeping.
  const again = leases.acquire(uri, { ttlMs: 60000 });
  assert.equal(again.ok, true);
  assert.equal(again.extended, true);
  assert.equal(again.renewals, 1);
  console.log("  ok — re-acquiring your own lease extends it instead of failing");

  const stolen = leases.release(uri, "pid:1/other-agent");
  assert.equal(stolen.ok, false, "releasing someone else's lease is how a tidy-up becomes a collision");
  assert.equal(leases.release(uri).released, true);
  assert.equal(leases.list().length, 0);
  console.log("  ok — only the holder can release it, and releasing frees it");
}

// --- a lease outliving its holder would teach people to ignore the mechanism ---
{
  // A pid that is certainly not running. Held forever by the table's own rules,
  // which is exactly the state that makes an operator delete the file.
  fs.writeFileSync(
    path.join(home, "leases.json"),
    JSON.stringify([
      {
        uri: "push:github.com/org/dead",
        holder: "pid:2147483640",
        reason: "an agent that crashed",
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    ])
  );
  assert.equal(leases.list().length, 0, "a lease whose holder is gone is reclaimed on sight, TTL or no TTL");
  const taken = leases.acquire("push:github.com/org/dead", { ttlMs: 5000 });
  assert.equal(taken.ok, true, "and the resource is available again");
  leases.release("push:github.com/org/dead");
  console.log("  ok — a dead holder's lease is reclaimed, so a crash does not block a resource forever");
}

// --- expiry, for a holder that is alive but has moved on ---
{
  const uri = "publish:npm/thing";
  leases.acquire(uri, { ttlMs: 1000, holder: "pid:1/slow-agent" });
  assert.equal(leases.acquire(uri).ok, false, "still held");
  await sleep(1200);
  assert.equal(leases.acquire(uri).ok, true, "expired leases do not need anybody to clean them up");
  leases.release(uri);
  console.log("  ok — leases expire on their own, without a reaper and without a human");
}

// --- END TO END: two daemons, two agents, one repo ---
{
  const { ReadBuffer, serializeMessage } = await import("@modelcontextprotocol/sdk/shared/stdio.js");

  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "nef-lease-shared-"));
  const connect = (goal) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "server.mjs")], {
      env: { ...process.env, NEFERTARI_HOME: shared, NEFERTARI_LOCAL_DRIVER: "null", NEFERTARI_GOAL: goal },
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
    const tool = async (name, args) => JSON.parse((await call("tools/call", { name, arguments: args })).result.content[0].text);
    return { child, call, tool };
  };

  const one = connect("release-the-fix");
  const two = connect("update-the-docs");

  try {
    for (const c of [one, two]) {
      await c.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    }

    const uri = "push:github.com/xQUANTUMTECH/nefertari-os";
    const got = await one.tool("lease_acquire", { uri, ttl_ms: 60000, reason: "cutting a release" });
    assert.equal(got.ok, true, `the first agent takes it: ${JSON.stringify(got)}`);

    // The second agent never mentions the lease. It just tries to push, in the
    // repo, the way an agent actually would — and the daemon recognises what it
    // is about to touch.
    const blocked = await two.tool("shell", { command: "git push", cwd: repo });
    assert.equal(blocked.status, "lease_conflict", `the second agent must be stopped: ${JSON.stringify(blocked).slice(0, 200)}`);
    assert.equal(blocked.uri, uri, "and told exactly which resource");
    assert.match(blocked.advice, /Wait for it, work on something/, "with something it can actually do next");
    assert.match(blocked.reason, /cutting a release/, "and what the holder is doing, which is what a human would want to know");
    console.log("  ok — end to end: the second agent's plain `git push` is stopped by a lease it never mentioned");

    // The holder itself is not blocked by its own lease.
    const mine = await one.tool("lease_acquire", { uri, ttl_ms: 60000 });
    assert.equal(mine.ok, true, "the holder can keep working in the resource it holds");

    const seen = await two.tool("lease_list", {});
    assert.equal(seen.leases.length, 1);
    assert.equal(seen.leases[0].mine, false, "and the other agent can see whose it is");
    console.log("  ok — the holder is not blocked by itself, and the other agent can see why it was");

    // Released, the road is open — no timer to wait out.
    assert.equal((await one.tool("lease_release", { uri })).released, true);
    const after = await two.tool("shell", { command: "git status", cwd: repo });
    assert.ok(after.exitCode !== undefined, "sanity: unrelated commands were never affected");
    const nowFree = await two.tool("lease_acquire", { uri, ttl_ms: 5000 });
    assert.equal(nowFree.ok, true, "once released the resource is immediately available");
    console.log("  ok — released early, the resource is free at once rather than at the timeout");

    const j = fs
      .readFileSync(path.join(shared, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(
      j.some((e) => e.decision === "lease_conflict" && e.uri === uri && e.held_by),
      "the collision is journalled with who held it: two agents colliding is exactly what someone will want to reconstruct"
    );
    console.log("  ok — the collision is on the record, naming the holder");
  } finally {
    one.child.kill("SIGKILL");
    two.child.kill("SIGKILL");
    fs.rmSync(shared, { recursive: true, force: true });
  }
}

fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log("LEASE TESTS PASSED");
