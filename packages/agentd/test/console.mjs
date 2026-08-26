// The operator's view — the thing that makes "give an AI full control" a
// defensible sentence rather than a brave one.
//
// Watching has to mean something better than tailing a log, and it has to be
// reachable from outside the machine the agent is on. So:
//
//   - one call answers what is enforced, what is waiting, what it has done,
//     how full the window is, what it holds
//   - it is derived from the record, never from the agent's account of itself
//   - it carries NO secret values — this is the endpoint most likely to end up
//     behind a URL someone pastes into a chat
//   - the page is served without auth and the data is not, so the URL is safe
//     to bookmark
//   - and binding it publicly with a token nobody outside can read is refused,
//     because a locked door with the key inside is worse than no door
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { execFileSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-con-"));
process.env.NEFERTARI_HOME = home;

const { createServer } = await import("../src/http.mjs");
const journal = await import("../src/journal.mjs");
const approvals = await import("../src/approvals.mjs");
const vctx = await import("../src/context.mjs");
const leases = await import("../src/leases.mjs");

const TOKEN = "test-token-0123456789";
const SECRET = "ghp_aCredentialThatMustNotAppearInTheConsole";

// A session's worth of state, so the view has something real to describe.
{
  execFileSync(
    process.execPath,
    [path.join(import.meta.dirname, "..", "src", "cli.mjs"), "secret", "add", "gh", "--host", "github.com"],
    { input: SECRET, env: { ...process.env, NEFERTARI_HOME: home }, stdio: ["pipe", "pipe", "pipe"] }
  );
  journal.append({ tool: "fs_write", args: { path: "/w/a.ts" }, decision: "executed", outcome: "ok" });
  journal.append({ tool: "shell", args: { command: "rm -rf /w/old" }, decision: "pending_approval", reason: "not allowlisted" });
  approvals.registerPending("shell", { command: "rm -rf /w/old" }, "not allowlisted");
  vctx.page("y".repeat(30000), { tool: "shell", args: { command: "curl https://status.example.com" } });
  leases.acquire("push:github.com/org/repo", { ttlMs: 300000, reason: "the release" });
}

const server = createServer({ token: TOKEN });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (p, tok = TOKEN) => fetch(base + p, { headers: { authorization: "Bearer " + tok } });

try {
  // --- the page is public; the data is not ---
  {
    const page = await fetch(base + "/");
    assert.equal(page.status, 200, "the page must load without a token, or nobody can get in to type one");
    const html = await page.text();
    assert.match(html, /<title>Nefertari/);
    assert.ok(!html.includes(TOKEN) && !html.includes(SECRET), "and it must ship no credential of any kind");

    assert.equal((await fetch(base + "/status")).status, 401, "the data behind it is still token-gated");
    console.log("  ok — the page loads without a token and the data behind it does not");
  }

  // --- one call, and it describes the machine rather than the agent's story ---
  const s = await (await get("/status")).json();
  {
    assert.equal(typeof s.enforcement.landlock, "boolean", "what is actually enforced here, not what is claimed");
    assert.equal(s.enforcement.journal_signed, true);
    assert.ok(s.enforcement.journal_entries >= 2);

    assert.equal(s.waiting_for_you.length, 1, "the number an operator watches when they walk away");
    assert.match(s.waiting_for_you[0].reason, /not allowlisted/);

    assert.equal(s.store.held, 1);
    assert.equal(s.store.untrusted, 1, "and it says how much of what is held came from outside");
    assert.equal(s.leases.length, 1);
    assert.equal(s.activity.by_decision.pending_approval, 1, "counts, not a wall of entries");
    console.log(`  ok — one call: ${s.waiting_for_you.length} gated, ${s.store.held} held, ${s.leases.length} lease, signature ${s.enforcement.journal_signed}`);
  }

  // --- THE ASSERTION THIS ENDPOINT EXISTS TO SURVIVE ---
  {
    const whole = JSON.stringify(s);
    assert.ok(!whole.includes(SECRET), "no credential value, anywhere in the status");
    assert.ok(!whole.includes(TOKEN), "and not the API token either");
    assert.deepEqual(s.identities, [{ name: "gh", hosts: ["github.com"], expires_in_ms: null }], "names and scopes only");
    console.log("  ok — the whole status carries zero credential values: names and scopes only");
  }

  // --- the record, queried rather than dumped ---
  {
    const q = await (await get("/journal?decision=pending_approval")).json();
    assert.equal(q.matched, 1, "the question an operator actually has");
    assert.match(q.entries[0].args.command, /rm -rf/);

    const counts = await (await get("/journal?count=1")).json();
    assert.ok(counts.by_tool.shell >= 1);
    assert.equal(counts.entries, undefined, "counting returns a shape, not a list");
    console.log(`  ok — /journal answers by filter and by count: ${counts.matched} entries summarised`);
  }

  // --- approving from outside works, and lands on the record as such ---
  {
    const id = s.waiting_for_you[0].id;
    const r = await fetch(`${base}/pending/${id}/approve`, { method: "POST", headers: { authorization: "Bearer " + TOKEN } });
    assert.equal(r.status, 200);
    const after = await (await get("/status")).json();
    assert.equal(after.waiting_for_you[0].approved, true, "approved, and still visible until the agent consumes it");
    const viaHttp = journal.query({ decision: "human_approved" });
    assert.equal(viaHttp.matched, 1, "and the approval is on the record like every other decision");
    console.log("  ok — a human can approve from outside the machine, and it is recorded as such");
  }
} finally {
  server.close();
}

// --- a public bind with an unreadable token is refused, not started ---
{
  const out = (() => {
    try {
      execFileSync(process.execPath, ["-e", 'import("./src/http.mjs").then(m => m.serve())'], {
        cwd: path.join(import.meta.dirname, ".."),
        env: { ...process.env, NEFERTARI_HOME: home, NEFERTARI_HTTP_HOST: "0.0.0.0", NEFERTARI_HTTP_PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      });
      return { code: 0, err: "" };
    } catch (e) {
      return { code: e.status, err: String(e.stderr || "") };
    }
  })();
  assert.equal(out.code, 2, "it must refuse rather than start");
  assert.match(out.err, /nobody outside could read it/, "and explain why, since the fix is one variable away");
  console.log("  ok — binding publicly with a generated token is refused: a locked door with the key inside");
}

fs.rmSync(home, { recursive: true, force: true });
console.log("CONSOLE TESTS PASSED");
