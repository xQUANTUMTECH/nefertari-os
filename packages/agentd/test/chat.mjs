// The conversation, driven end to end against a scripted model.
//
// The model is a stub that answers /chat/completions by looking at what it was
// sent — a small script, not intelligence — so every claim here is about the
// loop, the gate in the conversation, and the pager: what was delivered, what
// left the window, what came back on demand, and that the record says so.
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-chat-home-"));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nef-chat-ws-"));
fs.writeFileSync(path.join(ws, "a.txt"), "small\n");
// A file too large for the window (above the client's MAX_RESULT) but below the daemon's own 8 KB paging threshold, so it is THIS pager that acts. One line is worth finding.
const lines = [];
for (let i = 1; i <= 150; i++) lines.push(i === 137 ? "line 137: NEEDLE 42 is here" : `line ${i}: ${"x".repeat(24)}`);
fs.writeFileSync(path.join(ws, "big.txt"), lines.join("\n") + "\n");

// ---- the scripted model ----
let calls = 0;
const model = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const { messages, tools } = JSON.parse(b);
    calls++;
    assert.ok(tools.some((t) => t.function.name === "window_fetch"), "the model is offered window_fetch");
    assert.ok(tools.some((t) => t.function.name === "plan_run"), "…and the daemon's own tools");
    const last = messages[messages.length - 1];
    const toolMsgs = messages.filter((m) => m.role === "tool");
    let reply;
    const tc = (id, name, args) => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    if (calls === 1) reply = tc("c1", "fs_read", { path: path.join(ws, "big.txt") });
    else if (calls === 2) {
      // The big result must have arrived as a stub, not as 9 KB.
      const m = /\[evicted → (win_[0-9a-f]+)\]/.exec(last.content);
      assert.ok(m, "a large result reaches the model as a stub with a handle: " + String(last.content).slice(0, 80));
      assert.ok(last.content.length < 300, "the stub is small");
      reply = tc("c2", "window_fetch", { handle: m[1], grep: "NEEDLE" });
    } else if (calls === 3) {
      const j = JSON.parse(last.content);
      assert.equal(j.matches, 1); assert.match(j.hits[0].text, /NEEDLE 42/);
      reply = tc("c3", "shell", { command: "rm a.txt && echo removed", cwd: ws });
    } else if (calls === 4) {
      const j = JSON.parse(last.content);
      assert.equal(j.exitCode, 0, "after approval the retried call ran: " + last.content.slice(0, 120));
      assert.ok(toolMsgs.some((m) => m.content.startsWith("[evicted →")), "older results are stubs by now");
      reply = { role: "assistant", content: "Fatto: ho letto big.txt, trovato NEEDLE 42 alla riga 137, e rimosso a.txt." };
    } else reply = { role: "assistant", content: "nothing more" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: reply }] }));
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));

process.env.NEFERTARI_HOME = home;
process.env.NEFERTARI_TOKEN = "t-test";
process.env.NEFERTARI_CHAT_URL = `http://127.0.0.1:${model.address().port}/v1`;
process.env.NEFERTARI_CHAT_MODEL = "scripted";
process.env.NEFERTARI_CHAT_MAX_RESULT = "2000"; // big.txt is ~9 KB: paged on arrival
process.env.NEFERTARI_CHAT_BUDGET = "400"; // below what the system prompt alone costs: every evictable result must go
process.env.NEFERTARI_CHAT_KEEP = "2";
delete process.env.NEFERTARI_ENFORCE_DRIVER; // no sandbox here: `rm` must reach the gate
const { createServer } = await import("../src/http.mjs");
const srv = createServer({ token: "t-test" });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const H = { authorization: "Bearer t-test", "content-type": "application/json" };
const j = async (p, opts) => (await fetch(base + p, { headers: H, ...opts })).json();
const ok = (m) => console.log("  ok — " + m);
const until = async (id, state, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await j(`/chat/sessions/${id}`);
    if (v.state === state) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${state}; now ${v.state}: ${JSON.stringify(v.messages.slice(-2))}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

// -- the page and the door --
const page = await (await fetch(base + "/chat")).text();
assert.match(page, /<title>Nefertari<\/title>/, "the page is served without a token");
// The page lives in a template literal; compile its script so a quoting slip cannot ship.
new (await import("node:vm")).Script(/<script>([\s\S]*)<\/script>/.exec(page)[1], { filename: "chatpage.js" });
assert.equal((await fetch(base + "/chat/sessions")).status, 401, "the API is not");
ok("page open, API behind the token");

// -- a goal starts the loop; the big read is paged on arrival; the fault comes back; the gate stops it --
const s = await j("/chat/sessions", { method: "POST", body: JSON.stringify({ goal: "leggi big.txt, trova NEEDLE, poi rimuovi a.txt", dir: ws }) });
assert.match(s.id, /^chat_/);
const w = await until(s.id, "waiting_for_you");
assert.equal(w.pending.tool, "shell");
assert.match(w.pending.args.command, /rm a\.txt/);
assert.ok(fs.existsSync(path.join(ws, "a.txt")), "nothing was removed yet");
assert.ok(w.stats.evicted >= 1 && w.stats.faults >= 1, JSON.stringify(w.stats));
ok("read → paged on arrival → window_fetch grep found the needle → rm waits at the gate");

// -- the person decides in the conversation --
const d = await j(`/chat/sessions/${s.id}/gate/${w.pending.action_id}/approve`, { method: "POST" });
assert.equal(d.ok, true);
const done = await until(s.id, "idle");
assert.ok(!fs.existsSync(path.join(ws, "a.txt")), "after approval the exact call ran");
const finalMsg = done.messages.filter((m) => m.role === "assistant" && m.content).pop();
assert.match(finalMsg.content, /NEEDLE 42/, "the model finished with what it found");
assert.equal(calls, 4, "four model calls: read, fault, rm, done");
ok("approve in the conversation → the retried call ran → the model finished");

// -- the meter and the record --
assert.ok(done.stats.evicted >= 2, "at least the size eviction and one budget eviction: " + JSON.stringify(done.evictions));
assert.ok(done.evictions.some((e) => e.why === "size") && done.evictions.some((e) => e.why === "budget"), "both reasons on record");
assert.ok(done.stats.last_delivered <= 400 + 600, "delivery stays near the budget (what cannot be evicted — system, user, KEEP — may exceed it): " + done.stats.last_delivered);
for (const e of done.evictions) assert.ok(fs.existsSync(path.join(home, "chat", s.id, "evicted", e.handle + ".txt")), "every evicted body is on disk");
const log = await j(`/chat/sessions/${s.id}/window`);
const kinds = new Set(log.map((e) => e.type));
assert.ok(kinds.has("deliver") && kinds.has("evict") && kinds.has("fault"), "the window's own record: " + [...kinds].join(","));
const jl = fs.readFileSync(path.join(home, "journal.jsonl"), "utf8");
assert.match(jl, /"human_approved"[^\n]*"via":"chat"/, "the approval is in the daemon's journal, marked as decided in the chat");
ok("every eviction is a file, every delivery/eviction/fault is a log line, the approval is in the journal");

// -- documents and timeline through the same door --
const files = await j(`/chat/sessions/${s.id}/files`);
assert.ok(files.some((f) => f.name === "big.txt") && !files.some((f) => f.name === "a.txt"));
const big = await j(`/chat/sessions/${s.id}/file?path=big.txt`);
assert.match(big.text, /NEEDLE 42/, "a document is read through the daemon (below its 8 KB threshold it comes back whole; above, as a handle)");
assert.equal((await j(`/chat/sessions/${s.id}/file?path=../escape`)).error, "outside the workspace");
ok("documents: listed locally, read through the daemon, never outside the folder");

// -- talking again while idle continues the same window --
await j(`/chat/sessions/${s.id}/say`, { method: "POST", body: JSON.stringify({ text: "grazie" }) });
const again = await until(s.id, "idle");
assert.equal(again.messages.filter((m) => m.role === "user").length, 2);
ok("a second message continues the conversation");

srv.close(); model.close();
fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true });
console.log("CHAT TESTS PASSED");
process.exit(0);
