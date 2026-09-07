// The pager: what leaves the window, what it leaves behind, and what folds.
//
// chat.mjs owns a context window; this decides what happens to it. Four
// decisions, each one a function with a name, because each is the place where
// something smarter can plug in without a rewrite:
//
//   RANK   — which resident result goes first when the budget is exceeded.
//            Not FIFO: a result still being referred to, one that reported
//            trouble, one that carries an undo handle, is worth more per token
//            than a big, old, plain listing. The default is a heuristic anyone
//            can read; setRanker() replaces it — a plastic index (NexusDB's
//            Hebbian rank, per docs/NEURAL-LAYER-NEXUSDB.md) belongs exactly
//            here: it changes what leaves and what comes back first, not how
//            much fits.
//   STUB   — the line left behind. Always deterministic first (tool, arguments,
//            size, first line); when a LOCAL model tier is configured
//            (localmodel.mjs), a one-line gist is appended and labelled as
//            such. Never the remote model: what it thinks its own result
//            contains is the one summary the record must not depend on.
//   EVICT  — any resident result or long reply outside the recent KEEP can
//            leave; its body goes to disk under a handle. An assistant reply
//            loses its text, never its tool_calls: the transcript stays valid.
//   FOLD   — when enough stubs pile up, the old turns fold into one packet:
//            what they were, one line each, plus where things stand now from
//            the record (recall). The originals go to disk under a fold_
//            handle that window_fetch can search. Folding is itself on the
//            record, so what was resident at turn N is still reconstructible.
//
// Everything here is measured and logged through the ctx the caller passes:
// a pager nobody can measure is a pager nobody believes.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as local from "./localmodel.mjs";

export const BUDGET = () => Number(process.env.NEFERTARI_CHAT_BUDGET) || 16000; // est. tokens delivered per model call
export const MAX_RESULT = () => Number(process.env.NEFERTARI_CHAT_MAX_RESULT) || 6000; // chars: larger results are paged on arrival
export const KEEP = () => Number(process.env.NEFERTARI_CHAT_KEEP) || 6; // most recent messages never evicted or folded
export const FOLD_AFTER = () => Number(process.env.NEFERTARI_CHAT_FOLD_AFTER) || 12; // stubs outside KEEP before the old turns fold
const MIN_REPLY = () => Number(process.env.NEFERTARI_CHAT_MIN_REPLY) || 300; // chars: shorter assistant replies are not worth paging

// A token estimate that is wrong the same way every turn is a fair meter.
export const est = (s) => Math.ceil(String(s ?? "").length / 4);
const parse = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
const rid = (p) => p + "_" + crypto.randomBytes(5).toString("hex");

export const total = (s) => s.messages.reduce((n, m) => n + est(m.content) + est(JSON.stringify(m.tool_calls || "")), 0);

// ---------------------------------------------------------------- rank ----
// Lower score leaves first. Worth is what a later turn might still need;
// size is what keeping it costs; age is how long it has gone unreferenced.
function heuristic(s, candidates) {
  const now = s.stats.turns;
  return candidates
    .map(({ m, i }) => {
      const age = Math.max(0, now - (m.turn ?? 0));
      const size = est(m.content);
      let worth = 0;
      // Still being talked about: its path or command head appears later on.
      const key = (m.args_brief || "").split(/\s+/).find((w) => w.length > 3);
      if (key) {
        const later = s.messages.slice(i + 1);
        worth += later.filter((x) => String(x.content || "").includes(key) || JSON.stringify(x.tool_calls || "").includes(key)).length * 4;
      }
      const j = parse(m.content);
      // Trouble is worth keeping: an error, a refusal, a non-zero exit.
      if (j && (j.error || j.status === "pending_approval" || j.status === "denied_by_human" || j.status === "rolled_back" || (j.exitCode != null && j.exitCode !== 0))) worth += 6;
      // So is the handle that undoes something.
      if (j && (j.checkpoint_id || j.snapshot_id)) worth += 2;
      if (m.role === "assistant") worth += 1;
      const score = (worth + 1) / (1 + Math.log2(1 + size)) / (1 + age * 0.5);
      return { m, i, score, worth, age, size };
    })
    .sort((a, b) => a.score - b.score);
}
heuristic.rankerName = "heuristic";
let ranker = heuristic;
export function setRanker(fn) {
  ranker = typeof fn === "function" ? fn : heuristic;
}
export const rankerName = () => ranker.rankerName || ranker.name || "custom";

// ---------------------------------------------------------------- stub ----
async function stubFor(m, ctx) {
  const body = String(m.content ?? "");
  const first = (body.split("\n").find((l) => l.trim()) || "").slice(0, 80);
  let gist = null;
  if (ctx.local !== false) {
    const what = m.role === "tool" ? `the result of ${m.name} ${m.args_brief || ""}` : "an earlier reply of the assistant";
    const out = await local.ask(
      `One line, at most 120 characters, no preamble. What does the following contain that a later step might still need? It is ${what}.\n\n${body.slice(0, 6000)}`
    );
    if (out) gist = out.split("\n")[0].trim().slice(0, 160);
  }
  return { first, gist };
}

// --------------------------------------------------------------- evict ----
export async function evict(s, m, why, ctx) {
  const handle = rid("win");
  const body = String(m.content ?? "");
  fs.mkdirSync(path.join(ctx.dir, "evicted"), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, "evicted", handle + ".txt"), body);
  const { first, gist } = await stubFor(m, ctx);
  const who = m.role === "tool" ? m.name : "assistant";
  m.handle = handle;
  m.evicted = { at_turn: s.stats.turns, bytes: body.length, why, gist: gist ? "local" : "none" };
  m.content = `[evicted → ${handle}] ${who}${m.args_brief ? " · " + m.args_brief : ""} · ${body.length} B · ${first}${gist ? " · gist(local): " + gist : ""}`;
  s.evictions.push({ handle, turn: s.stats.turns, tool: who, bytes: body.length, why, gist: gist ? "local" : "none" });
  s.stats.evicted++;
  s.stats.evicted_bytes += body.length;
  if (gist) s.stats.stub_local = (s.stats.stub_local || 0) + 1;
  ctx.log({ type: "evict", handle, tool: who, bytes: body.length, why, gist: Boolean(gist) });
  ctx.emit({ type: "evict", handle, tool: who, bytes: body.length, why, gist: gist || null });
  return handle;
}

// ---------------------------------------------------------------- page ----
export async function pageWindow(s, ctx) {
  const budget = BUDGET();
  const keepFrom = Math.max(0, s.messages.length - KEEP());
  const candidates = s.messages
    .map((m, i) => ({ m, i }))
    .filter(
      ({ m, i }) =>
        i < keepFrom &&
        !m.evicted &&
        !m.fold &&
        (m.role === "tool" || (m.role === "assistant" && String(m.content || "").length >= MIN_REPLY()))
    );
  if (total(s) > budget) {
    for (const c of ranker(s, candidates)) {
      if (total(s) <= budget) break;
      await evict(s, c.m, "budget", ctx);
    }
  }
  await fold(s, ctx);
  return total(s);
}

// ---------------------------------------------------------------- fold ----
// The old turns become one packet. Boundaries are respected: a fold never
// separates an assistant message from the tool results that answer it, and
// never touches the system prompt, the opening goal, or the recent KEEP.
export async function fold(s, ctx, { force = false } = {}) {
  const keepFrom = Math.max(0, s.messages.length - KEEP());
  let start = 1;
  if (s.messages[1]?.role === "user" && !s.messages[1].fold) start = 2;
  let end = keepFrom;
  while (end > start && s.messages[end]?.role === "tool") end--;
  const range = s.messages.slice(start, end);
  const stubs = range.filter((m) => m.evicted || m.fold).length;
  if (range.length < 2 || (!force && stubs < FOLD_AFTER())) return null;

  const handle = rid("fold");
  fs.mkdirSync(path.join(ctx.dir, "evicted"), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, "evicted", handle + ".jsonl"), range.map((m) => JSON.stringify(m)).join("\n") + "\n");
  const before = range.reduce((n, m) => n + est(m.content) + est(JSON.stringify(m.tool_calls || "")), 0);
  let recall = "(recall unavailable)";
  try {
    recall = String(await ctx.recall());
  } catch (e) {
    recall = `(recall failed: ${e.message})`;
  }
  const line = (m) => {
    const c = String(m.content || "");
    if (m.fold) return `folded: ${c.split("\n")[0].slice(0, 160)}`;
    if (m.role === "user") return `person: ${c.slice(0, 160)}`;
    if (m.role === "assistant") return `assistant: ${c ? c.slice(0, 160) : "(" + (m.tool_calls || []).map((t) => t.function.name).join(", ") + ")"}`;
    if (m.evicted) return c.slice(0, 200);
    return `${m.name}${m.args_brief ? " · " + m.args_brief : ""} → ${c.split("\n")[0].slice(0, 120)}`;
  };
  const lines = range.map(line).slice(0, 60);
  const turns = [range[0].turn ?? 0, range[range.length - 1].turn ?? 0];
  const packet = {
    role: "system",
    turn: s.stats.turns,
    fold: { handle, messages: range.length, turns, at_turn: s.stats.turns, tokens_before: before, forced: force },
    content:
      `[folded → ${handle}] ${range.length} earlier messages (turns ${turns[0]}–${turns[1]}) left the window; the full transcript is on disk and window_fetch("${handle}", grep) searches it. What they were, one line each:\n` +
      lines.join("\n") +
      `\nWhere you are now, from the record:\n${recall}`,
  };
  s.messages.splice(start, range.length, packet);
  s.stats.folds = (s.stats.folds || 0) + 1;
  const after = est(packet.content);
  ctx.log({ type: "fold", handle, messages: range.length, turns, tokens_before: before, tokens_after: after, forced: force });
  ctx.emit({ type: "fold", handle, messages: range.length, turns, tokens_before: before, tokens_after: after });
  return packet;
}

// --------------------------------------------------------------- fetch ----
export function windowFetch(s, { handle, grep, offset = 0, limit = 2000 }, ctx) {
  const id = String(handle || "").replace(/[^a-z0-9_]/gi, "");
  const f = ["txt", "jsonl"].map((ext) => path.join(ctx.dir, "evicted", id + "." + ext)).find((p) => fs.existsSync(p));
  if (!f) return { error: `no such handle in this window: ${handle}` };
  const text = fs.readFileSync(f, "utf8");
  s.stats.faults++;
  ctx.log({ type: "fault", handle: id, grep, offset, limit });
  ctx.emit({ type: "fault", handle: id, grep: grep || null });
  if (grep) {
    let re;
    try {
      re = new RegExp(grep, "i");
    } catch (e) {
      return { error: `bad regex: ${e.message}` };
    }
    const lines = text.split("\n");
    const hits = [];
    lines.forEach((l, i) => {
      if (re.test(l) && hits.length < 60) hits.push({ line: i + 1, text: l.slice(0, 300) });
    });
    return { handle: id, total_lines: lines.length, bytes: text.length, matches: hits.length, hits };
  }
  const lim = Math.min(Number(limit) || 2000, 4000);
  return { handle: id, bytes: text.length, offset, text: text.slice(offset, offset + lim), more: offset + lim < text.length };
}
