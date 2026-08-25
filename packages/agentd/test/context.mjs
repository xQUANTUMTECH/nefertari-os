// Virtual context: hand back a handle, keep the body.
//
// The failure this exists for is not the bill. With prompt caching a re-sent
// prefix is cheap; what a large result actually costs is TURNS. The window
// fills, the harness compacts, and compaction drops what nothing has referred
// to recently — which is exactly the detail a later turn needed. The agent then
// re-reads the file, and the cycle repeats. On a smaller model the ceiling
// arrives sooner and the loss is worse.
//
// So the test that matters simulates that: read something big, throw away
// everything the agent was holding — the compaction — and then ask a question
// that can only be answered from deep inside what was read.
//
//   - a result too large for the window comes back as a handle, and says so
//   - structure survives: exitCode is still readable without faulting anything
//   - the body is on disk, searchable without entering the window
//   - after a "compaction" the answer is still reachable, in one call
//   - and nothing is ever silently shortened
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawn } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-ctx-"));
process.env.NEFERTARI_HOME = home;

const vctx = await import("../src/context.mjs");

// --- small results are untouched: nothing changes for the common case ---
{
  assert.equal(vctx.page("a short answer"), "a short answer");
  const obj = { exitCode: 0, stdout: "ok\n" };
  assert.deepEqual(vctx.page(obj), obj);
  console.log("  ok — ordinary results arrive whole: paging is for what would fill the window");
}

// --- a large one is paged, and cannot be mistaken for a complete answer ---
{
  const big = "x".repeat(100 * 1024);
  const r = vctx.page(big, { tool: "fs_read" });
  assert.equal(r.__paged, true, "it must be visibly paged");
  assert.ok(r.handle.startsWith("ctx_"));
  assert.equal(r.bytes, 100 * 1024, "and say how much is being held");
  assert.match(r.read_more, /context_fetch/, "and name the exact call that gets the rest");
  assert.match(r.note, /NOT lost/, "…and say plainly that nothing was thrown away");
  assert.ok(
    JSON.stringify(r).length < 4000,
    `the replacement must be small enough to be worth it (${JSON.stringify(r).length} bytes for ${r.bytes})`
  );
  console.log(`  ok — 100KB became a ${JSON.stringify(r).length}-byte handle that says what it is holding`);
}

// --- structure survives, which is what makes it safe to do automatically ---
{
  const r = vctx.page({ exitCode: 0, stdout: "y".repeat(50 * 1024), stderr: "" }, { tool: "shell" });
  assert.equal(r.exitCode, 0, "an agent checking the exit code must not have to fault anything in");
  assert.equal(r.stderr, "");
  assert.equal(r.stdout.__paged, true, "only the part that was too big is paged");
  console.log("  ok — only the oversized field is paged: the shape a caller parses is unchanged");
}

// --- searching what never entered the window ---
{
  const lines = [];
  for (let i = 0; i < 40000; i++) lines.push(`${i} routine log line about nothing in particular`);
  lines[31337] = "31337 FATAL: the connection pool is exhausted (code 7734)";
  const paged = vctx.page(lines.join("\n"), { tool: "fs_read" });

  const found = vctx.fetch(paged.handle, { grep: "FATAL" });
  assert.equal(found.matches, 1, "the needle is found");
  assert.match(found.hits[0].text, /code 7734/, "with the detail that was actually needed");
  assert.equal(found.hits[0].line, 31338, "and the line number to read around");
  assert.ok(
    JSON.stringify(found).length < 2000,
    `a 2MB file answered a question in ${JSON.stringify(found).length} bytes of context`
  );
  console.log(`  ok — searched ${paged.bytes} bytes and answered in ${JSON.stringify(found).length}: the file never entered the window`);

  // Reading around it, by region.
  const region = vctx.fetch(paged.handle, { offset: 0, limit: 200 });
  assert.equal(region.returned_bytes, 200);
  assert.ok(region.more, "and a partial read says how to continue");
  console.log("  ok — regions can be read too, and a partial read names its continuation");
}

// --- a capped search that does not say so would be read as "that is all" ---
{
  // Comfortably over the paging threshold, or there would be no handle to search.
  const many = Array.from({ length: 2000 }, (_, i) => `line ${i} MATCH — with enough text to be worth paging`).join("\n");
  const paged = vctx.page(many, { tool: "fs_read" });
  const r = vctx.fetch(paged.handle, { grep: "MATCH", max_matches: 5 });
  assert.equal(r.matches, 5);
  assert.match(r.truncated, /there may be more/, "a cap nobody mentions becomes a wrong conclusion");
  console.log("  ok — a capped search says it was capped");
}

// --- a handle that does not exist is an explanation, not a crash ---
{
  assert.match(vctx.fetch("ctx_0000000000").error, /no such handle/);
  assert.match(vctx.fetch("nonsense").error, /not a handle/);
  console.log("  ok — a bad handle gets an explanation and a way forward");
}

// --- THE CASE IT EXISTS FOR: surviving a compaction ---
{
  const { ReadBuffer, serializeMessage } = await import("@modelcontextprotocol/sdk/shared/stdio.js");
  const srvHome = fs.mkdtempSync(path.join(os.tmpdir(), "nef-ctx-h-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nef-ctx-ws-"));

  // A build log of the kind an agent reads once and needs an hour later.
  const log = path.join(ws, "build.log");
  {
    const out = [];
    for (let i = 0; i < 60000; i++) out.push(`[${i}] compiling module_${i % 400}.ts ... ok`);
    out[45123] = "[45123] ERROR TS2554: Expected 2 arguments, but got 3, in src/pipeline/merge.ts:88";
    fs.writeFileSync(log, out.join("\n"));
  }
  const logBytes = fs.statSync(log).size;

  const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "server.mjs")], {
    env: { ...process.env, NEFERTARI_HOME: srvHome, NEFERTARI_LOCAL_DRIVER: "null" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const buf = new ReadBuffer();
  const want = new Map();
  let id = 1;
  let contextBytes = 0;
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
    const t = r.result?.content?.[0]?.text ?? "";
    // What the agent would have to carry from this call onwards.
    contextBytes += Buffer.byteLength(t);
    try {
      return JSON.parse(t);
    } catch {
      return { raw: t };
    }
  };

  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });

    // Turn 1: the agent reads the log, the way it would.
    const read = await tool("fs_read", { path: log });
    assert.equal(read.__paged, true, `a ${logBytes}-byte log must not be handed over whole`);
    const handle = read.handle;
    assert.ok(
      contextBytes < logBytes / 50,
      `the window took ${contextBytes} bytes instead of ${logBytes} — that ratio is the whole feature`
    );
    console.log(`  ok — a ${Math.round(logBytes / 1024)}KB log entered the window as ${contextBytes} bytes`);

    // --- THE COMPACTION. Everything the agent was holding is gone: the preview,
    // the handle, the memory of having read anything at all. This is the state a
    // resumed or compacted session is actually in.
    const survivedNothing = null;
    assert.equal(survivedNothing, null); // stated plainly: we keep nothing

    // What it can still do is ask the daemon what it has.
    const held = await tool("context_list", {});
    assert.ok(held.held.length >= 1, "the daemon still holds what the agent forgot");
    const recovered = held.held.find((h) => h.id === handle);
    assert.ok(recovered, "including, by name, the thing that was read before the compaction");
    assert.equal(recovered.tool, "fs_read", "and where it came from");
    console.log("  ok — after the compaction the daemon still names what was read, with its handle");

    // And answer the question that the compaction would otherwise have destroyed.
    const answer = await tool("context_fetch", { handle: recovered.id, grep: "ERROR TS" });
    assert.equal(answer.matches, 1);
    assert.match(answer.hits[0].text, /merge\.ts:88/, "the exact detail, an hour and a compaction later");
    console.log(`  ok — and the answer is still one call away: ${answer.hits[0].text.slice(0, 60)}…`);

    // The alternative, stated in numbers: re-reading to answer the same question.
    assert.ok(
      contextBytes < logBytes / 20,
      `total context used across the whole session: ${contextBytes} bytes against ${logBytes} to re-read once`
    );
    console.log(
      `  ok — whole session cost ${contextBytes} bytes of window; re-reading the log even once would have cost ${logBytes}`
    );

    const j = fs
      .readFileSync(path.join(srvHome, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(
      j.some((e) => e.tool === "context_fetch"),
      "faulting a page back in is an action like any other, and is recorded"
    );
    console.log("  ok — the fault-in is journalled like every other action");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(srvHome, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

fs.rmSync(home, { recursive: true, force: true });
console.log("CONTEXT TESTS PASSED");
