// The pager, on an in-memory window: rank, stub, evict, fold, fetch.
//
// No HTTP, no model loop — just a session object and the four decisions,
// so each claim is about the decision and nothing else. The local model is a
// stub server so the "gist(local)" path is real, and the recall is a function
// so a fold's packet has something true to say.
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// A local model that answers every gist the same way — enough to prove the
// stub is labelled and the count is kept.
const localModel = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const { messages } = JSON.parse(b);
    assert.match(messages[0].content, /One line, at most 120 characters/, "the gist prompt is the one we wrote");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "monthly totals per category, June to August\nsecond line ignored" } }] }));
  });
});
await new Promise((r) => localModel.listen(0, "127.0.0.1", r));
process.env.NEFERTARI_LOCAL_DRIVER = "openai";
process.env.NEFERTARI_LOCAL_ENDPOINT = `http://127.0.0.1:${localModel.address().port}/v1`;
process.env.NEFERTARI_CHAT_KEEP = "2";
process.env.NEFERTARI_CHAT_FOLD_AFTER = "99"; // no fold yet: rank and stub are inspected first

const pager = await import("../src/pager.mjs");
const ok = (m) => console.log("  ok — " + m);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nef-pager-"));
const logged = [], emitted = [];
const ctx = { dir, log: (e) => logged.push(e), emit: (e) => emitted.push(e), recall: async () => "goal: test · 3 files touched · nothing pending" };

// ---- a window with a story in it ----
const tc = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const s = { id: "chat_test", dir, stats: { turns: 20, evicted: 0, evicted_bytes: 0, faults: 0, stub_local: 0, folds: 0 }, evictions: [], messages: [] };
const M = s.messages;
M.push({ role: "system", content: "system prompt ".repeat(20), turn: 0 });
M.push({ role: "user", content: "riordina le spese e scrivi report.md", turn: 0 });
// 1: a big, plain, old listing — the obvious first to go
M.push({ role: "assistant", content: "", tool_calls: [tc("c1", "shell", { command: "ls -laR", cwd: dir })], turn: 1 });
M.push({ role: "tool", tool_call_id: "c1", name: "shell", args_brief: "ls -laR", content: JSON.stringify({ exitCode: 0, stdout: "file\n".repeat(400) }), turn: 1 });
// 2: an error — trouble is worth keeping
M.push({ role: "assistant", content: "", tool_calls: [tc("c2", "shell", { command: "node build.mjs", cwd: dir })], turn: 2 });
M.push({ role: "tool", tool_call_id: "c2", name: "shell", args_brief: "node build.mjs", content: JSON.stringify({ exitCode: 1, stderr: "boom: cannot find module" }), turn: 2 });
// 3: a result still being talked about later
M.push({ role: "assistant", content: "", tool_calls: [tc("c3", "fs_write", { path: dir + "/report.md", content: "x" })], turn: 3 });
M.push({ role: "tool", tool_call_id: "c3", name: "fs_write", args_brief: "report.md", content: JSON.stringify({ status: "written", path: "report.md", snapshot_id: "snap_1" }), turn: 3 });
// 4: a long reply from the assistant, with a tool call attached
M.push({ role: "assistant", content: "Ho aggiornato report.md con i totali. " + "Dettagli, dettagli. ".repeat(40), tool_calls: [tc("c4", "fs_read", { path: dir + "/report.md" })], turn: 4 });
M.push({ role: "tool", tool_call_id: "c4", name: "fs_read", args_brief: "report.md", content: "# Spese\n\ntotale 10051,97 €", turn: 4 });
// recent, protected by KEEP
M.push({ role: "assistant", content: "Vuoi che tolga i doppioni?", turn: 19 });
M.push({ role: "user", content: "sì", turn: 20 });
const before = pager.total(s);
const byId = (id) => M.find((m) => m.tool_call_id === id);
const reply = M.find((m) => m.role === "assistant" && m.tool_calls?.[0]?.id === "c4");

// ---- rank: not FIFO ----
// A budget that only ONE candidate needs to leave to meet: the ranker decides which.
process.env.NEFERTARI_CHAT_BUDGET = String(before - pager.est(byId("c1").content) + 120);
let after = await pager.pageWindow(s, ctx);
assert.ok(byId("c1").evicted, "the big plain listing left first");
assert.ok(!byId("c2").evicted && !byId("c3").evicted && !reply.evicted, "nothing else did: one eviction was enough");
// Tighten again: the next to go is the long reply, not the error, not the referenced result.
process.env.NEFERTARI_CHAT_BUDGET = String(pager.total(s) - pager.est(reply.content) + 120);
after = await pager.pageWindow(s, ctx);
assert.ok(reply.evicted, "the long reply left second");
assert.equal(reply.tool_calls[0].id, "c4", "…but kept its tool_calls: the transcript stays valid");
assert.ok(!byId("c2").evicted, "the error stayed: trouble is worth keeping");
assert.ok(!byId("c3").evicted, "the result about report.md stayed: it is still being talked about");
assert.ok(after < before, "and the window shrank: " + before + " → " + after);
ok("rank: big/old/plain first; errors, referenced results and the recent KEEP stay; a reply loses its text, not its tool_calls");

// ---- stub: deterministic first, local gist labelled ----
assert.match(byId("c1").content, /^\[evicted → win_[0-9a-f]+\] shell · ls -laR · \d+ B · /, "deterministic head: tool, args, size, first line");
assert.match(byId("c1").content, /gist\(local\): monthly totals per category, June to August$/, "the local model's one line, labelled as local, first line only");
assert.equal(s.stats.stub_local, 2, "both stubs counted as local");
assert.ok(fs.existsSync(path.join(dir, "evicted", byId("c1").handle + ".txt")), "the body is on disk under the handle");
assert.ok(logged.some((e) => e.type === "evict" && e.gist === true), "the log says a gist was used");
ok("stub: deterministic head + gist(local) from the local tier, counted and logged");
const h1 = byId("c1").handle;

// ---- fold: the old turns become one packet, on disk and searchable ----
// pageWindow folds when stubs outside KEEP reach FOLD_AFTER; two are there now.
process.env.NEFERTARI_CHAT_FOLD_AFTER = "2";
const folded = await pager.fold(s, ctx);
assert.ok(folded, "fold happens once enough stubs sit outside KEEP");
const packet = M.find((m) => m.fold);
assert.ok(packet, "a fold packet is in the window: " + M.map((m) => m.role).join(","));
assert.equal(packet.role, "system");
assert.match(packet.content, /^\[folded → fold_[0-9a-f]+\] \d+ earlier messages \(turns 1–4\)/, "it says what it folded");
assert.match(packet.content, /assistant: \(shell\)/, "one line per message: a tool-calling reply by its calls");
assert.match(packet.content, /shell · node build.mjs → \{"exitCode":1/, "…a small result by its first line");
assert.match(packet.content, /Where you are now, from the record:\ngoal: test/, "…and where things stand, from recall");
assert.equal(M[0].role, "system"); assert.equal(M[1].role, "user", "system prompt and opening goal are never folded");
assert.equal(M[M.length - 1].content, "sì", "the recent KEEP is untouched");
assert.ok(M.length < 12, "the window is shorter: " + M.length);
const foldFile = path.join(dir, "evicted", packet.fold.handle + ".jsonl");
assert.equal(fs.readFileSync(foldFile, "utf8").trim().split("\n").length, packet.fold.messages, "every folded message is on disk, verbatim");
assert.ok(logged.some((e) => e.type === "fold" && e.tokens_after < e.tokens_before), "the fold is logged with before/after");
ok("fold: turns 1–4 became one packet with recall; originals on disk; system, goal and KEEP untouched");

// ---- fetch: both kinds of handle, the fault on record ----
// The evicted body is the tool's JSON text as it was: one line, newlines escaped inside it.
const f1 = pager.windowFetch(s, { handle: h1, grep: '"stdout":"file' }, ctx);
assert.equal(f1.matches, 1, "grep over the evicted body");
assert.ok(f1.hits[0].text.length <= 300, "hits are clipped, the body is not loaded into the window");
const f2 = pager.windowFetch(s, { handle: packet.fold.handle, grep: "boom" }, ctx);
assert.equal(f2.matches, 1, "grep inside a fold finds the folded error");
assert.match(f2.hits[0].text, /cannot find module/);
assert.equal(pager.windowFetch(s, { handle: "win_nope" }, ctx).error, "no such handle in this window: win_nope");
assert.equal(s.stats.faults, 2, "faults counted");
ok("fetch: win_ and fold_ handles both searchable; the fault is on record");

// ---- a custom ranker plugs in without a rewrite ----
const seen = [];
pager.setRanker(Object.assign((s, c) => { seen.push(c.length); return c.slice().reverse(); }, { rankerName: "test-reverse" }));
assert.equal(pager.rankerName(), "test-reverse");
pager.setRanker(null);
assert.equal(pager.rankerName(), "heuristic");
ok("setRanker: a plastic index can take over the eviction order");

localModel.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log("PAGER TESTS PASSED");
