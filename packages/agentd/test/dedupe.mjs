// Idempotence by action hash: the same effect, asked for twice, happens once.
//
// The test that matters is not "a repeat is suppressed" — that is easy and, done
// naively, wrong. It is that the rule tells a RETRY apart from a DELIBERATE
// REPEAT, because the loop it must not break is the most common loop there is:
// edit, run the tests, edit, run the same tests. So:
//
//   - the same action twice in a row is suppressed, and says so
//   - the same action with a CHANGE in between runs again — the fix loop lives
//   - reads are never suppressed: an agent re-reads to learn the world moved
//   - the suppression is on the record, with the reason
//   - and it is end-to-end, through the real broker, not just the module
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-dedupe-"));
process.env.NEFERTARI_HOME = home;

const dedupe = await import("../src/dedupe.mjs");
const { CLASS } = await import("../src/broker.mjs");

const W = { path: "/w/a.txt", content: "x" };

// --- the same action twice in a row is the one case that is a duplicate ---
{
  dedupe.reset();
  assert.equal(dedupe.check("fs_write", W, CLASS.NOISY), null, "the first time, nothing has happened yet");
  dedupe.remember("fs_write", W, CLASS.NOISY, "ok", { bytes: 1, snapshot_id: "snap_1" });

  const dup = dedupe.check("fs_write", W, CLASS.NOISY);
  assert.ok(dup, "the identical call, immediately after, is a duplicate");
  assert.equal(dup.status, "duplicate_suppressed");
  assert.equal(dup.original_outcome, "ok");
  assert.equal(dup.snapshot_id, "snap_1", "the original result is handed back, or the agent cannot proceed");
  assert.match(dup.reason, /nothing in between/, "and it says WHY, so the agent can tell this from a failure");
  assert.match(dup.reason, /do something else first/, "…including how to run it anyway, if it meant to");
  console.log("  ok — the identical call, immediately after, is suppressed and explained");
}

// --- but the fix loop must survive: something in between makes it deliberate ---
{
  dedupe.reset();
  const test = { command: "npm test" };
  dedupe.remember("shell", test, CLASS.NOISY, "1 failing");
  assert.ok(dedupe.check("shell", test, CLASS.NOISY), "sanity: back to back it would be a duplicate");

  // The edit that the failing test provoked.
  dedupe.remember("fs_write", { path: "/w/src.js", content: "fixed" }, CLASS.NOISY, "ok");
  assert.equal(
    dedupe.check("shell", test, CLASS.NOISY),
    null,
    "running the same tests AFTER an edit is the whole job, and must not be suppressed"
  );
  console.log("  ok — the same command after an edit runs again: the fix loop is untouched");
}

// --- and "changed something" is not the same question as "is it reversible" ---
{
  // fs_write is classified REVERSIBLE — it is snapshotted, so undo can take it
  // back. It still changed the file. Reading the class as "had no effect" is
  // the bug that made the fix loop suppress its own second test run: the write
  // between the two runs was invisible to the rule.
  dedupe.reset();
  const test = { command: "npm test" };
  dedupe.remember("shell", test, CLASS.NOISY, "1 failing");
  dedupe.remember("fs_write", { path: "/w/src.js", content: "fixed" }, CLASS.REVERSIBLE, "ok");
  assert.equal(
    dedupe.check("shell", test, CLASS.NOISY),
    null,
    "a reversible write is still a change, and still makes the next identical command deliberate"
  );
  console.log("  ok — a REVERSIBLE write still counts as something in between");
}

// --- a read in between is not a change of mind ---
{
  dedupe.reset();
  dedupe.remember("fs_write", W, CLASS.NOISY, "ok");
  dedupe.remember("fs_read", { path: "/w/a.txt" }, CLASS.REVERSIBLE, "x");
  assert.ok(
    dedupe.check("fs_write", W, CLASS.NOISY),
    "an agent reading back the file it just wrote has not decided to write it again"
  );
  console.log("  ok — a read between the twins does not make the second one deliberate");
}

// --- reads themselves are never suppressed ---
{
  dedupe.reset();
  const R = { path: "/w/a.txt" };
  dedupe.remember("fs_read", R, CLASS.REVERSIBLE, "old content");
  assert.equal(
    dedupe.check("fs_read", R, CLASS.REVERSIBLE),
    null,
    "re-reading is how an agent learns the world changed; a cached answer would be a lie about the present"
  );
  console.log("  ok — reads are never suppressed, however often they repeat");
}

// --- the hash covers what the action does, not what the journal records ---
{
  // fs_write hands the broker only the path: file content has no business in an
  // audit log. But two writes of different content to the same path are
  // different actions, and hashing the journalled arguments alone made them
  // identical — the second write was suppressed and the file kept the first
  // version. The content is passed separately, hashed and discarded.
  dedupe.reset();
  const at = { path: "/w/hello.txt" };
  dedupe.remember("fs_write", at, CLASS.REVERSIBLE, "ok", {}, { content: "v1" });
  assert.equal(
    dedupe.check("fs_write", at, CLASS.REVERSIBLE, { content: "v2" }),
    null,
    "writing DIFFERENT content to the same path is a different action, and must not be suppressed"
  );
  assert.ok(
    dedupe.check("fs_write", at, CLASS.REVERSIBLE, { content: "v1" }),
    "…while writing the same content again is the duplicate it looks like"
  );
  console.log("  ok — the action hash covers the content, which the journal never sees");
}

// --- a different action is not a duplicate, however similar ---
{
  dedupe.reset();
  dedupe.remember("fs_write", W, CLASS.NOISY, "ok");
  assert.equal(dedupe.check("fs_write", { ...W, content: "y" }, CLASS.NOISY), null, "different content, different action");
  console.log("  ok — same tool, different arguments: not a duplicate");
}

// --- repeated duplicates keep being suppressed, and are counted ---
{
  dedupe.reset();
  dedupe.remember("shell", { command: "git push" }, CLASS.IRREVERSIBLE, "pushed");
  const a = dedupe.check("shell", { command: "git push" }, CLASS.IRREVERSIBLE);
  const b = dedupe.check("shell", { command: "git push" }, CLASS.IRREVERSIBLE);
  assert.equal(a.times_suppressed, 1);
  assert.equal(b.times_suppressed, 2, "a model stuck in a loop must not push twice on the third try either");
  console.log("  ok — a stuck model is suppressed every time, and the count is visible");
}

// --- END TO END: through the real broker, over the real transport ---
{
  const { ReadBuffer, serializeMessage } = await import("@modelcontextprotocol/sdk/shared/stdio.js");
  const { spawn } = await import("node:child_process");

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nef-dedupe-ws-"));
  const target = path.join(ws, "counter.txt");
  const srvHome = fs.mkdtempSync(path.join(os.tmpdir(), "nef-dedupe-h-"));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "server.mjs")], {
    env: { ...process.env, NEFERTARI_HOME: srvHome, NEFERTARI_LOCAL_DRIVER: "null" },
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

  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });

    // An append: the one shape where running twice is visibly wrong. `>>` is
    // classified irreversible, so this also proves the suppression happens
    // BEFORE the approval is spent — a human's approval must not be burned on a
    // duplicate.
    const cmd = { command: `echo tick >> ${target}` };
    const first = await call("tools/call", { name: "shell", arguments: cmd });
    const firstText = first.result.content[0].text;
    // Irreversible: the first call queues for a human. Approve it out of band,
    // exactly as the human would, then let the agent retry.
    // Approved the way a human does it: through the CLI, in the daemon home.
    // Importing approvals here would read a different home — paths resolve at
    // import time, and this process has its own.
    if (/pending_approval/.test(firstText)) {
      const pend = JSON.parse(firstText);
      const { execFileSync } = await import("node:child_process");
      execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "src", "cli.mjs"), "approve", pend.action_id], {
        env: { ...process.env, NEFERTARI_HOME: srvHome },
        stdio: "pipe",
      });
      await call("tools/call", { name: "shell", arguments: cmd });
    }
    assert.equal(fs.readFileSync(target, "utf8"), "tick\n", "sanity: it ran once");

    // The model re-emits the identical call.
    const again = await call("tools/call", { name: "shell", arguments: cmd });
    const body = JSON.parse(again.result.content[0].text);
    assert.equal(body.status, "duplicate_suppressed", `the repeat must not run: ${again.result.content[0].text}`);
    assert.equal(fs.readFileSync(target, "utf8"), "tick\n", "PHYSICAL: the file must still hold one line");
    console.log("  ok — end to end: the duplicated append did not happen twice");

    // And the refusal is on the record, like every other decision.
    const entries = fs
      .readFileSync(path.join(srvHome, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const sup = entries.filter((e) => e.decision === "duplicate_suppressed");
    assert.equal(sup.length, 1, "the suppression is journalled, because a decision nobody can see is not auditable");
    assert.match(sup[0].reason, /same action/);
    console.log("  ok — and the suppression is in the journal, with its reason");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(srvHome, { recursive: true, force: true });
  }
}

fs.rmSync(home, { recursive: true, force: true });
console.log("DEDUPE TESTS PASSED");
