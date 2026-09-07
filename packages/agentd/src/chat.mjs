// The first client that owns both sides of the window.
//
// Every other client of this daemon — Claude Code, Hermes, a custom loop — owns
// its own context window, and the daemon can only govern what it hands over
// (context.mjs: a handle instead of a body when the body is large). This client
// owns the window too, so the other half of the virtual-context idea becomes
// possible here and nowhere else: EVICTION. Nothing is delivered to the model
// beyond a budget; what leaves the window stays on disk under a handle and
// comes back on demand; every eviction and every fault is on the record, so
// what was resident at turn N is reconstructible. Measured per turn, because a
// pager nobody can measure is a pager nobody believes.
//
// The brain is whatever answers an OpenAI-compatible /chat/completions with
// tools — NEFERTARI_CHAT_URL / _KEY / _MODEL — on the same contract as
// localmodel.mjs: a driver, never a dependency. The body is agentd, reached
// over MCP exactly as any other agent reaches it, so the broker, the gate and
// the journal apply unchanged — and an action parked at the gate shows up in
// the conversation as a card, not as a dead end.
//
// Deliberately NOT here: a vector store (retrieval.mjs is the hook, as a
// driver), a graph to browse, a summary written by the model of its own work.
// The stub left in the window for an evicted result is deterministic — tool,
// arguments, size, first line — so the record never depends on the agent's
// account of itself.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HOME, ensureHome } from "./paths.mjs";
import * as approvals from "./approvals.mjs";
import * as journal from "./journal.mjs";
import * as pager from "./pager.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HOME, "chat");

// --- the brain: any OpenAI-compatible endpoint, from the environment ---------
const MODEL = () => ({
  url: (process.env.NEFERTARI_CHAT_URL || "http://127.0.0.1:8080/v1").replace(/\/$/, ""),
  key: process.env.NEFERTARI_CHAT_KEY || "",
  model: process.env.NEFERTARI_CHAT_MODEL || "default",
});
const { BUDGET, MAX_RESULT, est } = pager;
const MAX_STEPS = 40;

// --- the body: agentd over MCP, one connection, lazily --------------------------
let mcp = null, mcpTools = null;
async function body() {
  if (mcp) return mcp;
  const c = new Client({ name: "nefertari-chat", version: "0.1.0" });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(HERE, "server.mjs")],
      env: { ...process.env },
    })
  );
  mcpTools = (await c.listTools()).tools;
  mcp = c;
  return c;
}
async function callTool(name, args) {
  const r = await (await body()).callTool({ name, arguments: args });
  return r.content.map((c) => c.text || "").join("\n");
}
const parse = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

// The one tool this client answers itself: faulting an evicted result back in.
const WINDOW_FETCH = {
  type: "function",
  function: {
    name: "window_fetch",
    description:
      "Bring back part of a result that was evicted from your window to stay under budget. It was NOT lost: the full text is on disk under the handle shown in the [evicted → win_…] stub. grep searches it without loading it; offset/limit read a region.",
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string", description: "win_… from the stub" },
        grep: { type: "string", description: "regular expression; returns matching lines with numbers" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 4000 },
      },
      required: ["handle"],
    },
  },
};

async function toolsForModel() {
  await body();
  return [
    ...mcpTools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: "object", properties: {} } },
    })),
    WINDOW_FETCH,
  ];
}

// --- sessions --------------------------------------------------------------------
const sessions = new Map();
const listeners = new Map(); // id -> Set<res>

const dirOf = (id) => path.join(ROOT, id);
function persist(s) {
  fs.mkdirSync(dirOf(s.id), { recursive: true });
  fs.writeFileSync(path.join(dirOf(s.id), "session.json"), JSON.stringify(s, null, 1));
}
function log(s, entry) {
  fs.appendFileSync(path.join(dirOf(s.id), "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), turn: s.stats.turns, ...entry }) + "\n");
}
function emit(s, ev) {
  const e = { t: Date.now(), ...ev };
  s.events.push(e);
  if (s.events.length > 2000) s.events.splice(0, s.events.length - 2000);
  for (const res of listeners.get(s.id) || []) res.write(`data: ${JSON.stringify(e)}\n\n`);
}
function setState(s, state, extra = {}) {
  s.state = state;
  emit(s, { type: "state", state, ...extra });
  persist(s);
}

const SYSTEM = (s, recall) => `You are the agent of a person who is not a developer. You operate their machine through Nefertari, a layer where every action is classified, snapshotted and recorded.
Working directory: ${s.dir}
Rules of this host:
- ALWAYS pass cwd: "${s.dir}" to shell, and absolute paths under it to fs_* tools. Prefer plan_run for anything with more than two steps: one transaction, one record, one undo.
- A tool may answer status "pending_approval". That is expected and correct: the person is being asked. Do not work around it. Say in one short sentence what is waiting and why, then stop and wait — the person will approve or deny in this conversation and you will get the result.
- Everything you do is undoable: fs_write/fs_delete return a snapshot_id (undo), shell and plan_run return a checkpoint_id (timeline_restore). If the person asks to go back, use them.
- Some earlier results in this conversation appear as "[evicted → win_…]": they left your window to stay under budget and are on disk in full. Use window_fetch(handle, grep) when you need them; do not re-run the tool.
- Talk to the person plainly, in their language, about outcomes — not about tools. Never paste large outputs; say what they contain.
Where you are, from the record:
${recall}`;

export async function create({ goal, dir }) {
  ensureHome();
  const id = "chat_" + crypto.randomBytes(5).toString("hex");
  const s = {
    id,
    goal: goal || "",
    dir: path.resolve(dir || process.cwd()),
    createdAt: new Date().toISOString(),
    model: MODEL().model,
    state: "idle",
    pending: null,
    messages: [],
    events: [],
    evictions: [],
    stats: { turns: 0, model_calls: 0, tool_calls: 0, delivered: 0, last_delivered: 0, evicted: 0, evicted_bytes: 0, stub_local: 0, folds: 0, faults: 0, gates: 0 },
  };
  let recall = "(recall unavailable)";
  try {
    recall = await callTool("recall", { dir: s.dir, limit: 8 });
  } catch (e) {
    recall = `(recall failed: ${e.message})`;
  }
  s.messages.push({ role: "system", content: SYSTEM(s, recall), turn: 0 });
  if (s.goal) s.messages.push({ role: "user", content: s.goal, turn: 0 });
  sessions.set(id, s);
  fs.mkdirSync(path.join(dirOf(id), "evicted"), { recursive: true });
  persist(s);
  log(s, { type: "session", goal: s.goal, dir: s.dir, model: s.model });
  return s;
}

export function get(id) {
  if (sessions.has(id)) return sessions.get(id);
  const f = path.join(dirOf(id), "session.json");
  if (!fs.existsSync(f)) return null;
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  if (s.state === "thinking") s.state = "idle"; // a restart interrupted it
  sessions.set(id, s);
  return s;
}

export function list() {
  if (!fs.existsSync(ROOT)) return [];
  return fs
    .readdirSync(ROOT)
    .map((id) => get(id))
    .filter(Boolean)
    .map((s) => ({ id: s.id, goal: s.goal, dir: s.dir, state: s.state, createdAt: s.createdAt, turns: s.stats.turns }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// What the person and the page see: the window as it is, plus the meter.
export function view(s) {
  return {
    id: s.id,
    goal: s.goal,
    dir: s.dir,
    model: s.model,
    state: s.state,
    pending: s.pending && { action_id: s.pending.action_id, tool: s.pending.tool, args: s.pending.args, reason: s.pending.reason },
    stats: { ...s.stats, budget: BUDGET(), resident: pager.total(s), ranker: pager.rankerName() },
    // How many events this view already accounts for, so a page that renders
    // history from here can skip that many when the stream replays them.
    events_seen: s.events.length,
    evictions: s.evictions,
    messages: s.messages.filter((m) => m.role !== "system" || m.fold).map((m) => ({
      role: m.role,
      fold: m.fold,
      turn: m.turn,
      content: m.content,
      name: m.name,
      tool_call_id: m.tool_call_id,
      tool_calls: m.tool_calls?.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
      evicted: m.evicted || undefined,
      handle: m.handle,
    })),
  };
}

// --- the pager lives in pager.mjs; this is what it needs from a session ---
const ctx = (s) => ({
  dir: dirOf(s.id),
  log: (e) => log(s, e),
  emit: (e) => emit(s, e),
  recall: () => callTool("recall", { dir: s.dir, limit: 8 }),
});

// --- the loop ---------------------------------------------------------------------
async function complete(s, messages, tools) {
  const M = MODEL();
  const res = await fetch(`${M.url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(M.key ? { authorization: `Bearer ${M.key}` } : {}) },
    body: JSON.stringify({ model: M.model, messages, tools, tool_choice: "auto", temperature: 0.2 }),
  });
  if (!res.ok) throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const m = j.choices?.[0]?.message;
  if (!m) throw new Error("model returned no message");
  return m;
}

const briefArgs = (a) =>
  a && typeof a.command === "string" ? a.command.slice(0, 80) : a && typeof a.path === "string" ? path.basename(a.path) : JSON.stringify(a || {}).slice(0, 80);

// Run one tool call from the model. Returns { text, gated }.
async function runCall(s, call) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {}
  const name = call.function.name;
  s.stats.tool_calls++;
  emit(s, { type: "tool", id: call.id, name, args_brief: briefArgs(args), phase: "start" });
  let text;
  if (name === "window_fetch") {
    text = JSON.stringify(pager.windowFetch(s, args, ctx(s)));
  } else {
    try {
      text = await callTool(name, args);
    } catch (e) {
      text = JSON.stringify({ error: String(e.message || e) });
    }
  }
  const j = parse(text);
  const gated = j && j.status === "pending_approval";
  const msg = { role: "tool", tool_call_id: call.id, name, content: text, args_brief: briefArgs(args), turn: s.stats.turns };
  s.messages.push(msg);
  // A large result is paged on arrival: the model gets the stub and the
  // handle; nothing that big needs to sit in the window to be findable.
  if (!gated && text.length > MAX_RESULT()) await pager.evict(s, msg, "size", ctx(s));
  emit(s, {
    type: "tool",
    id: call.id,
    name,
    args_brief: briefArgs(args),
    phase: "done",
    status: gated ? "pending_approval" : j?.status || (j?.exitCode != null ? `exit ${j.exitCode}` : "ok"),
    bytes: text.length,
    handle: msg.handle,
    checkpoint_id: j?.checkpoint_id,
    snapshot_id: j?.snapshot_id,
    preview: text.slice(0, 400),
  });
  if (gated) {
    s.stats.gates++;
    s.pending = { call, tool: name, args, action_id: j.action_id, reason: j.reason, msgIndex: s.messages.length - 1 };
  }
  return { text, gated };
}

export async function say(s, text) {
  if (s.state === "thinking") throw new Error("still thinking");
  if (s.state === "waiting_for_you") throw new Error("an action is waiting for your decision first");
  s.messages.push({ role: "user", content: text, turn: s.stats.turns });
  emit(s, { type: "user", content: text });
  persist(s);
  run(s); // not awaited: the page follows over events
}

async function run(s, resumeCalls = null) {
  setState(s, "thinking");
  try {
    let pendingCalls = resumeCalls;
    for (let step = 0; step < MAX_STEPS; step++) {
      if (!pendingCalls) {
        s.stats.turns++;
        const resident = await pager.pageWindow(s, ctx(s));
        const tools = await toolsForModel();
        const toSend = s.messages.map(({ role, content, tool_calls, tool_call_id, name }) => ({ role, content, ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}), ...(name && role === "tool" ? { name } : {}) }));
        s.stats.model_calls++;
        s.stats.last_delivered = resident;
        s.stats.delivered += resident;
        log(s, { type: "deliver", est_tokens: resident, messages: toSend.length });
        emit(s, { type: "stats", stats: { ...s.stats, budget: BUDGET(), resident } });
        const m = await complete(s, toSend, tools);
        s.messages.push({ role: "assistant", content: m.content || "", tool_calls: m.tool_calls || undefined, turn: s.stats.turns });
        if (m.content) emit(s, { type: "assistant", content: m.content });
        pendingCalls = (m.tool_calls || []).slice();
        if (!pendingCalls.length) {
          setState(s, "idle");
          return;
        }
      }
      while (pendingCalls.length) {
        const call = pendingCalls.shift();
        const { gated } = await runCall(s, call);
        if (gated) {
          s.pending.remaining = pendingCalls;
          setState(s, "waiting_for_you", { pending: view(s).pending });
          return;
        }
      }
      pendingCalls = null;
      persist(s);
    }
    emit(s, { type: "assistant", content: "(stopped: too many steps in one turn)" });
    setState(s, "idle");
  } catch (e) {
    emit(s, { type: "error", message: String(e.message || e) });
    setState(s, "idle", { error: String(e.message || e) });
  }
}

// The person decides, in the conversation. Approve = the same gate every
// client uses (approvals + journal, in this process), then the exact call is
// retried; deny = the model is told, in the tool's own voice, and continues.
export async function decide(s, actionId, what) {
  if (!s.pending || s.pending.action_id !== actionId) throw new Error("that action is not waiting in this conversation");
  const p = s.pending;
  s.pending = null;
  const entry = what === "approve" ? approvals.approve(actionId) : approvals.deny(actionId);
  journal.append({ id: entry.id, tool: entry.tool, args: entry.args, decision: what === "approve" ? "human_approved" : "human_denied", via: "chat" });
  emit(s, { type: "decision", action_id: actionId, what });
  const msg = s.messages[p.msgIndex];
  if (what === "approve") {
    setState(s, "thinking");
    let text;
    try {
      text = await callTool(p.tool, p.args);
    } catch (e) {
      text = JSON.stringify({ error: String(e.message || e) });
    }
    msg.content = text;
    const j = parse(text);
    emit(s, { type: "tool", id: p.call.id, name: p.tool, args_brief: briefArgs(p.args), phase: "done", status: j?.status || (j?.exitCode != null ? `exit ${j.exitCode}` : "ok"), bytes: text.length, checkpoint_id: j?.checkpoint_id, snapshot_id: j?.snapshot_id, preview: text.slice(0, 400) });
    if (text.length > MAX_RESULT()) await pager.evict(s, msg, "size", ctx(s));
  } else {
    msg.content = JSON.stringify({ status: "denied_by_human", action_id: actionId, advice: "the person said no to this action; do not retry it, explain and ask what they prefer" });
  }
  run(s, p.remaining || []);
}

// --- documents: the workspace as the person sees it ---------------------------------
export function files(s, rel = "") {
  const base = path.resolve(s.dir, rel);
  if (!base.startsWith(s.dir)) throw new Error("outside the workspace");
  const out = [];
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(base, e.name);
    let st = null;
    try {
      st = fs.statSync(p);
    } catch {}
    out.push({ name: e.name, path: path.relative(s.dir, p), dir: e.isDirectory(), bytes: st?.size ?? 0, mtime: st?.mtime?.toISOString() });
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}
export async function readFile(s, rel) {
  const p = path.resolve(s.dir, rel);
  if (!p.startsWith(s.dir)) throw new Error("outside the workspace");
  return parse(await callTool("fs_read", { path: p })) ?? { text: await callTool("fs_read", { path: p }) };
}
export async function timeline(s) {
  const all = parse(await callTool("timeline_list", {})) || [];
  return all.filter((c) => c.kind === "checkpoint" && path.resolve(c.dir) === s.dir).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
}
export async function restore(s, checkpointId) {
  const r = parse(await callTool("timeline_restore", { checkpoint_id: checkpointId, dir: s.dir }));
  emit(s, { type: "restore", checkpoint_id: checkpointId, result: r });
  return r;
}

// --- HTTP: routes under /chat, mounted by http.mjs --------------------------------------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export async function handle(req, res, url, parts) {
  try {
    // /chat/sessions[/:id[/action]]
    if (parts[1] !== "sessions") return json(res, 404, { error: "not found" });
    const id = parts[2], action = parts[3];
    if (!id) {
      if (req.method === "GET") return json(res, 200, list());
      if (req.method === "POST") {
        const b = await readJson(req);
        const s = await create({ goal: b.goal, dir: b.dir });
        if (s.goal) run(s);
        return json(res, 200, view(s));
      }
    }
    const s = get(id);
    if (!s) return json(res, 404, { error: "no such session" });
    if (!action && req.method === "GET") return json(res, 200, view(s));
    if (action === "events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const e of s.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(res);
      req.on("close", () => listeners.get(id)?.delete(res));
      return;
    }
    if (action === "say" && req.method === "POST") {
      const b = await readJson(req);
      await say(s, String(b.text || "").trim());
      return json(res, 200, { ok: true });
    }
    if (action === "gate" && req.method === "POST") {
      const [, , , , actionId, what] = parts;
      if (!["approve", "deny"].includes(what)) return json(res, 400, { error: "approve or deny" });
      await decide(s, actionId, what);
      return json(res, 200, { ok: true });
    }
    if (action === "files" && req.method === "GET") return json(res, 200, files(s, url.searchParams.get("path") || ""));
    if (action === "file" && req.method === "GET") return json(res, 200, await readFile(s, url.searchParams.get("path") || ""));
    if (action === "timeline" && req.method === "GET") return json(res, 200, await timeline(s));
    if (action === "restore" && req.method === "POST") {
      const b = await readJson(req);
      return json(res, 200, await restore(s, String(b.checkpoint_id || "")));
    }
    if (action === "fold" && req.method === "POST") {
      // The person asks for the old turns to fold now, budget or not.
      const p = await pager.fold(s, ctx(s), { force: true });
      persist(s);
      return json(res, 200, p ? { ok: true, fold: p.fold } : { ok: false, reason: "nothing to fold yet: too few messages outside the recent ones" });
    }
    if (action === "window" && req.method === "GET") {
      // The record of the window itself: every delivery, eviction and fault.
      const f = path.join(dirOf(id), "log.jsonl");
      return json(res, 200, fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 400, { error: String(e.message || e) });
  }
}
