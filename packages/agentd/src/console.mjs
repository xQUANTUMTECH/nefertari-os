// The operator's view: what the agent is doing, from outside the agent.
//
// Handing an AI full control of a host is only defensible if somebody can watch
// it — and "watch" has to mean something better than tailing a log. The daemon
// already knows everything worth knowing: what it classified, what it refused,
// what is waiting for a human, what identities were used, how full the window
// is, what external resources are held. None of that was reachable from outside
// the machine it runs on.
//
// So this composes it into one answer, and serves a page that polls it. Two
// rules shape what goes in:
//
//   NOTHING HERE IS THE AGENT'S ACCOUNT OF ITSELF. Every field is derived from
//   the signed journal, the broker's own decisions, or the stores — the same
//   discipline as `recall`. An operator reading this is reading the record, not
//   a report written by the thing being watched.
//
//   AND NOTHING HERE IS A SECRET. Identity NAMES and scopes, never values;
//   journal decisions, never paged bodies. This endpoint is the one most likely
//   to end up behind a URL somebody pastes into a chat.

import * as journal from "./journal.mjs";
import * as approvals from "./approvals.mjs";
import * as leases from "./leases.mjs";
import * as budget from "./budget.mjs";
import * as vctx from "./context.mjs";
import * as secrets from "./secrets.mjs";
import * as retrieval from "./retrieval.mjs";
import * as idle from "./idle.mjs";
import { speculationStats } from "./speculate.mjs";
import * as cgroups from "./cgroups.mjs";
import { enforcerPath } from "./enforce.mjs";

/**
 * One answer describing the state of the machine and the agent on it.
 *
 * Deliberately cheap: counts and pointers, no bodies. It is polled every couple
 * of seconds by a page that may be open for hours, and an expensive status
 * endpoint is one that gets polled less often and therefore sees less.
 */
export function status() {
  const held = vctx.list(200);
  const b = budget.status();
  const r = retrieval.status();

  return {
    at: new Date().toISOString(),
    goal: process.env.NEFERTARI_GOAL || null,

    // What the machine can actually enforce here, said plainly. On a platform
    // that does not delegate cgroups, half of this is unavailable — and an
    // operator needs to know which half rather than assume all of it.
    enforcement: {
      landlock: Boolean(enforcerPath()),
      cgroups: cgroups.available().ok,
      journal_signed: journal.verify().ok,
      journal_entries: journal.query({ count: true }).matched,
    },

    // The gate. The number an operator watches when they walk away.
    waiting_for_you: approvals.listPending().map((p) => ({
      id: p.id,
      tool: p.tool,
      reason: p.reason,
      args: p.args,
      approved: p.approved,
      since: p.createdAt,
    })),

    // What it has been doing, as counts rather than a wall of entries.
    activity: journal.query({ count: true }),
    recent: journal
      .query({ limit: 12 })
      .entries.map((e) => ({ ts: e.ts, tool: e.tool, decision: e.decision, outcome: e.outcome })),

    window: {
      calls: b.observed.calls,
      est_tokens_carried: b.observed.est_tokens_carried,
      means: b.observed.carried_means,
      limits: b.limits,
      remaining: b.remaining,
      exhausted: b.exhausted,
    },

    store: {
      held: held.length,
      bytes: held.reduce((n, h) => n + (h.bytes || 0), 0),
      untrusted: held.filter((h) => h.source && h.source !== "local").length,
      ...speculationStats(),
    },

    // Names and scopes. Never values — see the header.
    identities: secrets.list().map((i) => ({ name: i.name, hosts: i.hosts, expires_in_ms: i.expires_in_ms })),
    leases: leases.list(),
    memory_search: r.enabled ? { engine: r.driver, local: r.local } : { available: false, reason: r.reason },
    idle: idle.stats(),
  };
}

// A page with no dependencies, no build step and no external requests. It is
// served from the same process it reports on, so a container with one port open
// is enough to watch an agent — which is the situation this exists for.
//
// The token is asked for once and kept in the tab. It is deliberately NOT put
// in the URL: a URL gets pasted into a chat, and a token in a query string ends
// up in logs, in referrers, and in somebody's history.
export const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nefertari — operator</title>
<style>
  :root{--bg:#0d1319;--panel:#141d26;--line:#22303d;--ink:#dbe4ee;--dim:#8496a8;--blue:#6fa9e8;--warn:#e0b25e;--bad:#e07a6a;--good:#7fc08a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
  header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
  h1{font-size:15px;margin:0;letter-spacing:.04em;text-transform:uppercase;color:var(--dim);font-weight:600}
  .goal{color:var(--blue)}
  main{padding:18px;display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));max-width:1400px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:3px;padding:14px 16px}
  h2{font-size:11px;margin:0 0 10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);font-weight:600}
  .kv{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px solid #1a2530}
  .kv:last-child{border-bottom:none}
  .kv span:last-child{color:var(--blue);font-variant-numeric:tabular-nums}
  .off{color:var(--dim)} .on{color:var(--good)} .warn{color:var(--warn)} .bad{color:var(--bad)}
  .gate{border-left:3px solid var(--warn);padding:10px 12px;margin-bottom:8px;background:#1a222c}
  .gate code{color:var(--warn);word-break:break-all;font-size:12.5px}
  button{font:inherit;background:#1d2c3a;color:var(--ink);border:1px solid var(--line);border-radius:2px;padding:5px 12px;cursor:pointer;margin-right:6px;margin-top:8px}
  button:hover{border-color:var(--blue)} button.deny:hover{border-color:var(--bad)}
  .row{display:flex;justify-content:space-between;gap:12px;padding:2px 0;color:var(--dim);font-size:12.5px}
  .row b{font-weight:400;color:var(--ink)}
  input{font:inherit;background:#0a1016;color:var(--ink);border:1px solid var(--line);padding:7px 10px;border-radius:2px;width:340px;max-width:100%}
  .empty{color:var(--dim);font-style:italic}
  #login{padding:40px 18px;max-width:520px}
</style>
<header>
  <h1>Nefertari</h1><span class="goal" id="goal"></span><span class="off" id="tick"></span>
</header>
<div id="login">
  <p>Bearer token — the one in <code>NEFERTARI_TOKEN</code>, or <code>~/.nefertari/token</code> on the host.</p>
  <input id="tok" type="password" placeholder="token" autocomplete="off">
  <button onclick="save()">Watch</button>
  <p class="empty" id="err"></p>
</div>
<main id="app" hidden></main>
<script>
const $ = (id) => document.getElementById(id);
let TOK = sessionStorage.getItem("nef") || "";
function save(){ TOK = $("tok").value.trim(); sessionStorage.setItem("nef", TOK); poll(); }
const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;" }[c]));
const kb = (n) => n > 1048576 ? (n/1048576).toFixed(1)+" MB" : n > 1024 ? Math.round(n/1024)+" KB" : n+" B";

async function api(p, opts){
  const res = await fetch(p, { ...opts, headers: { authorization: "Bearer " + TOK } });
  if (res.status === 401) throw new Error("token refused");
  return res.json();
}
async function act(id, what){ await api("/pending/"+id+"/"+what, { method: "POST" }); poll(); }

function render(s){
  $("goal").textContent = s.goal ? "goal: " + s.goal : "no goal declared";
  $("tick").textContent = new Date(s.at).toLocaleTimeString();
  const e = s.enforcement, w = s.window;
  const cls = (b) => b ? "on" : "off";
  $("app").innerHTML = [
    section("Waiting for you", s.waiting_for_you.length
      ? s.waiting_for_you.map(g => \`<div class="gate"><div><b>\${esc(g.tool)}</b> — \${esc(g.reason)}</div>
          <code>\${esc(JSON.stringify(g.args))}</code>
          <div><button onclick="act('\${g.id}','approve')">Approve</button>
          <button class="deny" onclick="act('\${g.id}','deny')">Deny</button></div></div>\`).join("")
      : '<p class="empty">nothing is waiting — the agent is not blocked on you</p>'),

    section("What the machine enforces", [
      kv("Landlock confinement", \`<span class="\${cls(e.landlock)}">\${e.landlock ? "active" : "unavailable"}</span>\`),
      kv("cgroup control", \`<span class="\${cls(e.cgroups)}">\${e.cgroups ? "delegated" : "not delegated"}</span>\`),
      kv("journal signature", \`<span class="\${cls(e.journal_signed)}">\${e.journal_signed ? "verified" : "BROKEN"}</span>\`),
      kv("entries on record", e.journal_entries),
    ].join("")),

    section("Window", [
      kv("tool calls", w.calls),
      kv("tokens carried (est.)", w.est_tokens_carried),
      w.limits ? kv("calls left", w.remaining.calls ?? "—") : "",
      w.exhausted ? kv("budget", '<span class="bad">exhausted: ' + w.exhausted.join(", ") + "</span>") : "",
    ].join("")),

    section("Held in store", [
      kv("paged results", s.store.held),
      kv("bytes off-window", kb(s.store.bytes)),
      kv("from untrusted sources", s.store.untrusted
        ? '<span class="warn">' + s.store.untrusted + "</span>" : 0),
      kv("memory by meaning", s.memory_search.engine
        ? '<span class="on">' + s.memory_search.engine + "</span>" : '<span class="off">off</span>'),
    ].join("")),

    section("Identities and leases", [
      s.identities.length ? s.identities.map(i => kv(esc(i.name), esc(i.hosts.join(", ")))).join("")
        : '<p class="empty">no identities stored</p>',
      s.leases.length ? s.leases.map(l => kv(esc(l.uri), Math.round(l.expires_in_ms/1000) + "s")).join("") : "",
    ].join("")),

    section("Decisions", Object.entries(s.activity.by_decision || {})
      .sort((a,b) => b[1]-a[1])
      .map(([k,v]) => kv(esc(k), v)).join("")),

    section("Just now", s.recent.length
      ? s.recent.map(r => \`<div class="row"><b>\${esc(r.tool)}</b><span>\${esc(r.decision)}</span></div>\`).join("")
      : '<p class="empty">nothing yet</p>'),
  ].join("");
}
const section = (t, inner) => "<section><h2>" + t + "</h2>" + inner + "</section>";
const kv = (k, v) => '<div class="kv"><span>' + k + "</span><span>" + v + "</span></div>";

async function poll(){
  if (!TOK) return;
  try {
    const s = await api("/status");
    $("login").hidden = true; $("app").hidden = false;
    render(s);
  } catch (err) {
    $("err").textContent = err.message;
    $("login").hidden = false; $("app").hidden = true;
  }
}
poll();
setInterval(poll, 2500);
</script>`;
