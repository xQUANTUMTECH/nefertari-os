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
      .entries.map((e) => ({ ts: e.ts, tool: e.tool, class: e.class, decision: e.decision, outcome: e.outcome })),

    // TWO KINDS OF NUMBER, and mixing them was a real bug found by running
    // this in a container: the console is one process and the agent talks to
    // a DIFFERENT daemon process over its own stdio pipe. Anything held in
    // memory here describes the console, not the agent — so it read `calls: 0`
    // beside `executed: 6`, which is the observability surface contradicting
    // itself in the one place that has to be trustworthy.
    //
    // What is on disk is shared and therefore true of the whole machine. What
    // is in memory is true of whoever answered. They are now labelled as such
    // rather than presented as one figure.
    activity_on_record: {
      tool_calls: journal.query({ count: true }).matched,
      note: "from the journal on disk: every process that touched this home",
    },
    window_this_process: {
      calls: b.observed.calls,
      est_tokens_carried: b.observed.est_tokens_carried,
      means: b.observed.carried_means,
      limits: b.limits,
      remaining: b.remaining,
      exhausted: b.exhausted,
      note:
        b.observed.calls === 0
          ? "zero because the agent runs in its own daemon process — its window pressure is not visible from here"
          : undefined,
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
// is enough to watch an agent — which is the situation this exists for. The
// night sky is CSS gradients rather than an image for the same reason: an image
// is bytes inside a daemon and a fetch the page must never make.
//
// The layout is a dashboard, in the sense a browser start page is one: a
// clock and a search box in the middle, a small card top-right for the one
// number worth glancing at (here: actions waiting at the gate, where a start
// page shows the weather), and a grid of widgets below, each with a title and
// one action. The search box is real — it is the /journal route with the
// operator's filters (text, tool:, decision:) — and the gate is a checklist
// whose rows approve or deny in place. Everything is drawn from status(); no
// widget shows anything that is not on the record.
//
// Two provenances stay visibly apart inside the "Window" card: "on record"
// comes from the journal on disk and is true of the whole machine; "this
// process" is in memory and true only of whoever answered. They were once one
// figure and contradicted each other — see status() above.
//
// The token is asked for once and kept in the tab. It is deliberately NOT put
// in the URL: a URL gets pasted into a chat, and a token in a query string ends
// up in logs, in referrers, and in somebody's history.
export const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Nefertari</title>
<style>
  :root{
    --bg:#07090e;--ink:#eef1f5;--ink-2:#aab3bf;--dim:#6d7684;--line:rgba(255,255,255,.08);--line-2:rgba(255,255,255,.14);
    --card:rgba(17,19,25,.62);--inner:rgba(255,255,255,.045);--inner-2:rgba(255,255,255,.07);
    --accent:#ee7a86;--accent-2:#f6a1aa;--good:#7fd0a0;--warn:#e9bd6a;--bad:#ef7f78;--blue:#8fb8ea;
    --r:16px;--r-sm:10px;
    --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  }
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  html{background:var(--bg)}
  body{margin:0;min-height:100vh;color:var(--ink);font:14px/1.45 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
  a{color:inherit;text-decoration:none}
  svg{display:block}

  /* The night. Gradients, no image: an image is bytes in a daemon and a fetch
     this page must never make. */
  .sky{position:fixed;inset:0;z-index:-1;background:
      radial-gradient(1100px 600px at 80% -10%, rgba(238,122,134,.10), transparent 60%),
      radial-gradient(900px 600px at 10% 10%, rgba(70,105,180,.20), transparent 60%),
      radial-gradient(1400px 900px at 50% 125%, rgba(28,40,64,.55), transparent 60%),
      linear-gradient(180deg,#0a0e16 0%,#07090e 60%,#04060a 100%)}
  .sky::before{content:"";position:absolute;inset:0;opacity:.5;background-image:
      radial-gradient(1px 1px at 12% 22%, #fff 50%, transparent 51%),radial-gradient(1px 1px at 33% 9%, #fff 50%, transparent 51%),
      radial-gradient(1.5px 1.5px at 57% 31%, #fff 50%, transparent 51%),radial-gradient(1px 1px at 71% 14%, #fff 50%, transparent 51%),
      radial-gradient(1px 1px at 88% 41%, #fff 50%, transparent 51%),radial-gradient(1px 1px at 23% 63%, #fff 50%, transparent 51%),
      radial-gradient(1.5px 1.5px at 44% 78%, #fff 50%, transparent 51%),radial-gradient(1px 1px at 66% 58%, #fff 50%, transparent 51%),
      radial-gradient(1px 1px at 92% 74%, #fff 50%, transparent 51%),radial-gradient(1px 1px at 8% 86%, #fff 50%, transparent 51%),
      radial-gradient(1px 1px at 51% 5%, #fff 50%, transparent 51%),radial-gradient(1px 1px at 80% 88%, #fff 50%, transparent 51%)}

  .card{background:var(--card);backdrop-filter:blur(18px) saturate(130%);-webkit-backdrop-filter:blur(18px) saturate(130%);
      border:1px solid var(--line);border-radius:var(--r);box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 18px 50px rgba(0,0,0,.35)}

  /* ---------- frame: rail + top ---------- */
  .rail{position:fixed;left:18px;top:18px;bottom:18px;width:56px;z-index:6;display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 0}
  .rail a,.rail button{width:40px;height:40px;display:grid;place-items:center;border-radius:12px;color:var(--ink-2);background:transparent;border:0;cursor:pointer;padding:0}
  .rail a:hover,.rail button:hover{background:var(--inner-2);color:var(--ink)}
  .rail a.on{background:var(--inner-2);color:var(--ink)}
  .rail svg{width:19px;height:19px}
  .rail .sep{width:28px;height:1px;background:var(--line-2);margin:6px 0}
  .rail .grow{flex:1}

  .top{display:flex;align-items:center;gap:10px;padding:26px 24px 0 24px}
  .greet{padding:8px 14px;border-radius:12px;font-size:13px;color:var(--ink-2)}
  .greet b{color:var(--ink);font-weight:500}
  .grow{flex:1}
  .tools{display:flex;gap:4px;padding:4px;border-radius:14px}
  .tools button{width:36px;height:36px;display:grid;place-items:center;border-radius:10px;border:0;background:transparent;color:var(--ink-2);cursor:pointer;padding:0}
  .tools button:hover{background:var(--inner-2);color:var(--ink)}
  .tools svg{width:17px;height:17px}

  /* ---------- hero: clock, search, gate ---------- */
  main{max-width:1240px;margin:0 auto;padding:0 24px 40px}
  .with-rail main{padding-left:calc(24px + 74px)}
  .with-rail .top{padding-left:calc(24px + 74px)}
  .hero-row{display:grid;grid-template-columns:1fr 250px;gap:18px;align-items:start;margin-top:10px}
  .hero{text-align:center;padding:26px 10px 8px}
  .clock{font-size:clamp(64px,9vw,96px);font-weight:200;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
  .clock small{font-size:.32em;font-weight:400;color:var(--ink-2);margin-left:.18em;vertical-align:baseline}
  .date{margin-top:10px;font-size:15px;color:var(--ink-2)}
  .search{margin:26px auto 0;max-width:560px;display:flex;align-items:center;gap:10px;padding:0 14px;height:48px;border-radius:14px;
      border:1px solid var(--line);background:var(--card);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
  .search svg{width:17px;height:17px;color:var(--dim);flex:none}
  .search input{flex:1;background:transparent;border:0;outline:0;color:var(--ink);font:14px var(--sans);min-width:0}
  .search input::placeholder{color:var(--dim)}
  .search kbd{font:11px var(--sans);color:var(--dim);border:1px solid var(--line-2);border-radius:6px;padding:2px 6px}
  .search .x{width:22px;height:22px;display:grid;place-items:center;border-radius:6px;color:var(--dim);cursor:pointer;border:0;background:transparent}
  .search .x:hover{background:var(--inner-2);color:var(--ink)}

  .gate-widget{padding:18px 18px 16px;margin-top:26px}
  .gate-widget .head{display:flex;align-items:center;gap:12px}
  .gate-widget .moon{width:40px;height:40px;flex:none}
  .gate-widget .moon svg{width:40px;height:40px}
  .gate-widget .big{font-size:30px;font-weight:300;line-height:1;letter-spacing:-.02em}
  .gate-widget .big i{font-style:normal;font-size:14px;color:var(--ink-2);margin-left:6px;font-weight:400}
  .gate-widget .sub{margin-top:10px;color:var(--ink);font-size:13.5px}
  .gate-widget .loc{margin-top:2px;color:var(--dim);font-size:12.5px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .gate-widget.hot{border-color:rgba(238,122,134,.35)}
  .gate-widget.hot .big{color:var(--accent-2)}

  /* ---------- grid ---------- */
  .grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px;margin-top:20px}
  .c2{grid-column:span 2}.c3{grid-column:span 3}.c4{grid-column:span 4}.c6{grid-column:span 6}.c12{grid-column:span 12}
  .tall{grid-row:span 2}
  .w{padding:16px 18px 16px;display:flex;flex-direction:column;min-width:0}
  .w h2{margin:0 0 12px;font-size:14px;font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:10px}
  .pill{font:500 12px var(--sans);color:var(--ink-2);background:var(--inner-2);border:0;border-radius:8px;padding:5px 10px;cursor:pointer;white-space:nowrap}
  .pill:hover{color:var(--ink);background:rgba(255,255,255,.11)}
  .pill.q{cursor:default}
  .pill.q:hover{color:var(--ink-2);background:var(--inner-2)}
  .empty{color:var(--dim);font-style:italic;margin:4px 0;font-size:13px}

  /* list rows (identities, journal) */
  .list{display:flex;flex-direction:column;gap:6px}
  .row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--r-sm);background:var(--inner);min-width:0}
  .row:hover{background:var(--inner-2)}
  .ic{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;flex:none;background:rgba(255,255,255,.06);color:var(--ink-2)}
  .ic svg{width:14px;height:14px}
  .ic.good{color:var(--good)} .ic.warn{color:var(--warn)} .ic.bad{color:var(--bad)} .ic.accent{color:var(--accent)} .ic.dim{color:var(--dim)} .ic.blue{color:var(--blue)}
  .row .t{flex:1;min-width:0}
  .row .t b{display:block;font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .row .t span{display:block;font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .row .r{font-size:12px;color:var(--dim);white-space:nowrap;font-variant-numeric:tabular-nums}
  .row .chev{color:var(--dim);width:14px;height:14px;flex:none}

  /* tiles (enforced here) */
  .tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
  .tile{min-width:0;aspect-ratio:1;border-radius:14px;background:var(--inner);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;position:relative;padding:6px;text-align:center}
  .tile:hover{background:var(--inner-2)}
  .tile svg{width:22px;height:22px;color:var(--ink)}
  .tile span{font-size:11px;color:var(--ink-2);line-height:1.15;max-width:100%}
  .tile em{font-style:normal;font-size:10.5px;color:var(--dim);max-width:100%;line-height:1.2;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .tile i{position:absolute;top:8px;right:8px;width:7px;height:7px;border-radius:50%;background:var(--dim)}
  .tile i.on{background:var(--good);box-shadow:0 0 8px rgba(127,208,160,.6)} .tile i.bad{background:var(--bad);box-shadow:0 0 8px rgba(239,127,120,.6)} .tile i.warn{background:var(--warn)}
  .tile.off svg{color:var(--dim)}

  /* to-do → the gate */
  .todo{display:flex;flex-direction:column;gap:6px}
  .task{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border-radius:var(--r-sm);background:var(--inner);cursor:pointer}
  .task:hover{background:var(--inner-2)}
  .task .o{width:16px;height:16px;border-radius:50%;border:1.5px solid var(--dim);flex:none;margin-top:2px}
  .task .t{flex:1;min-width:0}
  .task .t b{display:block;font-weight:500;font-size:13px;line-height:1.3}
  .task .t code{display:block;margin-top:3px;font:11.5px/1.4 var(--mono);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .task.open .t code{white-space:pre-wrap;word-break:break-all;color:var(--ink-2)}
  .task .act{display:none;gap:4px;flex:none}
  .task.open .act,.task:hover .act{display:flex}
  .task .act button{width:28px;height:28px;border-radius:8px;border:0;display:grid;place-items:center;cursor:pointer;background:var(--inner-2);color:var(--ink-2);padding:0}
  .task .act button svg{width:14px;height:14px}
  .task .act button.ok{color:var(--good)} .task .act button.ok:hover{background:rgba(127,208,160,.18)}
  .task .act button.no{color:var(--bad)} .task .act button.no:hover{background:rgba(239,127,120,.18)}
  .task .act button[disabled]{opacity:.4;cursor:default}
  .prog{margin-top:auto;padding-top:12px;display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dim)}
  .prog .bar{flex:1;height:4px;border-radius:99px;background:var(--inner-2);overflow:hidden}
  .prog .bar i{display:block;height:100%;background:var(--accent);border-radius:99px}

  /* tall card → the window */
  .tallw{padding:0;overflow:hidden;position:relative;min-height:340px}
  .tallw .art{position:absolute;inset:0;background:
      radial-gradient(90px 90px at 72% 18%, rgba(246,231,201,.28), transparent 60%),
      radial-gradient(600px 300px at 50% 120%, rgba(238,122,134,.14), transparent 60%),
      linear-gradient(180deg,#1a2740 0%,#0e1526 45%,#0a0f1a 100%)}
  .tallw .art::before{content:"";position:absolute;right:22%;top:9%;width:34px;height:34px;border-radius:50%;
      background:radial-gradient(circle at 34% 36%, transparent 0 13px, #f6e7c9 14px);filter:drop-shadow(0 0 14px rgba(246,231,201,.35))}
  .tallw .art::after{content:"";position:absolute;left:-10%;right:-10%;bottom:38%;height:60px;
      background:linear-gradient(180deg,transparent,rgba(5,8,14,.75));clip-path:polygon(0 100%,0 70%,14% 40%,26% 62%,40% 22%,55% 55%,68% 30%,82% 58%,100% 35%,100% 100%)}
  .tallw .body{position:absolute;left:0;right:0;bottom:0;padding:16px 16px 14px;background:linear-gradient(180deg,transparent,rgba(5,8,14,.85) 40%)}
  .tallw h2{margin:0;font-size:14px}
  .tallw .sub{font-size:12px;color:var(--ink-2);margin-top:2px}
  .tallw .stats{margin-top:10px;display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--ink-2)}
  .tallw .stats div{display:flex;justify-content:space-between;gap:8px}
  .tallw .stats b{color:var(--ink);font-weight:500;font-variant-numeric:tabular-nums}
  .tallw .stats small{display:block;color:var(--dim);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;margin-top:4px}
  .tallw .bar{margin-top:10px;height:4px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden}
  .tallw .bar i{display:block;height:100%;background:var(--accent);border-radius:99px}
  .tallw .note{font-size:11px;color:var(--dim);margin-top:8px;line-height:1.35}

  /* notes → held off-window */
  .note-box{background:var(--inner);border-radius:var(--r-sm);padding:12px 12px 10px;font-size:13px;line-height:1.5}
  .note-box b{font-weight:500}
  .note-box .when{margin-top:8px;font-size:11.5px;color:var(--dim)}

  /* quote */
  .quote{justify-content:center;gap:10px}
  .quote .q{font-size:30px;line-height:.6;color:var(--accent);font-family:Georgia,serif}
  .quote p{margin:0;font-size:14.5px;line-height:1.5;color:var(--ink)}
  .quote small{color:var(--dim);font-size:12px}

  footer{display:flex;justify-content:center;margin-top:26px}
  footer span.card{display:inline-flex;align-items:center;gap:8px;padding:9px 16px;border-radius:12px;font-size:12.5px;color:var(--ink-2)}
  footer svg{width:14px;height:14px;color:var(--accent)}

  /* ---------- login ---------- */
  #login{min-height:100vh;display:grid;place-items:center;padding:20px}
  #login .card{width:min(440px,100%);padding:28px 28px 24px}
  #login h1{margin:0 0 6px;font-size:20px;font-weight:500}
  #login p{margin:0 0 16px;color:var(--ink-2);font-size:13.5px;line-height:1.5}
  #login code{font:12px var(--mono);color:var(--ink);background:var(--inner-2);padding:2px 6px;border-radius:6px}
  #login form{display:flex;gap:8px;flex-direction:column}
  #login input{font:14px var(--sans);width:100%;padding:11px 13px;border-radius:11px;border:1px solid var(--line-2);background:rgba(0,0,0,.35);color:var(--ink);outline:none}
  #login input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(143,184,234,.18)}
  #login button{font:500 14px var(--sans);border-radius:11px;padding:11px;border:0;background:var(--accent);color:#1a0a0d;cursor:pointer}
  #login .err{min-height:18px;margin:8px 0 0;color:var(--bad);font-size:13px}

  .dot{width:7px;height:7px;border-radius:50%;background:var(--good);display:inline-block;margin-right:6px;vertical-align:middle}
  .dot.stale{background:var(--warn)}

  /* ---------- responsive ---------- */
  @media (max-width:1100px){
    .c2,.c3,.c4{grid-column:span 6} .tall{grid-row:auto} .tallw{min-height:280px}
  }
  @media (max-width:900px){
    .rail{display:none}
    .with-rail main,.with-rail .top{padding-left:24px}
    .hero-row{grid-template-columns:1fr}
    .gate-widget{margin-top:6px}
  }
  @media (max-width:640px){
    .top{padding:18px 14px 0} main{padding:0 14px 30px}
    .with-rail main,.with-rail .top{padding-left:14px}
    .c2,.c3,.c4,.c6{grid-column:span 12}
    .hero{padding-top:14px}
    .task .act{display:flex}
  }
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
<div class="sky" aria-hidden="true"></div>

<div id="login">
  <div class="card">
    <h1>Watch the machine</h1>
    <p>Paste the bearer token — the one in <code>NEFERTARI_TOKEN</code>, or in <code>~/.nefertari/token</code> on the host. It stays in this tab and never enters the URL.</p>
    <form onsubmit="save(event)">
      <input id="tok" type="password" placeholder="token" autocomplete="off" autofocus>
      <button type="submit">Open console</button>
    </form>
    <p class="err" id="err"></p>
  </div>
</div>

<div id="shell" class="with-rail" hidden>
  <nav class="rail card" aria-label="Sections">
    <a href="#top" class="on" title="Overview" data-nav="top"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z"/></svg></a>
    <a href="#gate" title="Waiting for you" data-nav="gate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg></a>
    <a href="#journal" title="Journal" data-nav="journal"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></a>
    <a href="#enforced" title="Enforced here" data-nav="enforced"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12l2 2 4-4"/></svg></a>
    <a href="#store" title="Held off-window" data-nav="store"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l8-4 8 4v10l-8 4-8-4z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg></a>
    <a href="#identities" title="Identities and leases" data-nav="identities"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M15 12v2"/></svg></a>
    <div class="sep"></div>
    <a href="#window" title="Window" data-nav="window"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/></svg></a>
    <div class="grow"></div>
    <button id="lock" title="Forget the token in this tab"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></button>
  </nav>

  <header class="top" id="top">
    <div class="greet card"><span id="greet">Good evening</span>, <b>operator</b> 👋</div>
    <div class="grow"></div>
    <div class="tools card">
      <button id="btn-search" title="Search the journal (⌘K)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg></button>
      <button id="btn-refresh" title="Refresh now"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg></button>
      <button id="btn-lock" title="Forget the token"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></button>
    </div>
  </header>

  <main>
    <section class="hero-row">
      <div class="hero">
        <div class="clock" id="clock">--:--</div>
        <div class="date" id="date"></div>
        <form class="search" onsubmit="event.preventDefault()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
          <input id="q" placeholder="Search the journal — text, tool:shell, decision:human_denied" autocomplete="off">
          <button type="button" class="x" id="qx" title="Clear" hidden>&#10005;</button>
          <kbd>⌘K</kbd>
        </form>
      </div>
      <aside class="card gate-widget" id="gatew"></aside>
    </section>

    <section class="grid">
      <section class="card w c3" id="identities"></section>
      <section class="card w c4" id="enforced"></section>
      <section class="card w c3" id="gate"></section>
      <section class="card tallw c2 tall" id="window"></section>
      <section class="card w c3" id="store"></section>
      <section class="card w quote c3">
        <div class="q">&#8220;</div>
        <p>Unknown is irreversible. The safe default is not “trust the AI” — it is “prove reversibility, or ask”.</p>
        <small>— the broker, README</small>
      </section>
      <section class="card w c4" id="journal"></section>
    </section>

    <footer><span class="card"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.3L21 10l-6.8 1.7L12 18l-2.2-6.3L3 10l6.8-1.7z"/></svg><span id="foot">Nothing here is the agent’s account of itself.</span></span></footer>
  </main>
</div>

<script>
const $ = (id) => document.getElementById(id);
let TOK = sessionStorage.getItem("nef") || "";
let LAST = null, lastOk = 0, openTask = null;

function save(ev){ if (ev) ev.preventDefault(); TOK = $("tok").value.trim(); sessionStorage.setItem("nef", TOK); poll(); }
function forget(){ TOK = ""; sessionStorage.removeItem("nef"); $("shell").hidden = true; $("login").hidden = false; $("tok").value = ""; $("tok").focus(); }
$("lock").onclick = forget; $("btn-lock").onclick = forget;
$("btn-refresh").onclick = () => poll();
$("btn-search").onclick = () => $("q").focus();
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("q").focus(); $("q").select(); } });

const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;" }[c]));
const kb = (n) => n > 1048576 ? (n/1048576).toFixed(1)+" MB" : n > 1024 ? Math.round(n/1024)+" KB" : n+" B";
const ago = (iso) => { const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000)); return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s/60) + "m ago" : s < 86400 ? Math.round(s/3600) + "h ago" : Math.round(s/86400) + "d ago"; };

// What a colour means, written once. Classes are the broker's verdict on the
// action; decisions are what then happened to it. Unknown values stay neutral.
const TONE = {
  reversible: "good", noisy: "warn", irreversible: "bad",
  executed: "good", trajectory_done: "good",
  pending_approval: "warn", rate_limited: "warn", duplicate_suppressed: "dim",
  human_approved: "accent", approved_by_human: "accent",
  human_denied: "bad", gate_timeout: "bad", rolled_back: "bad", error: "bad", budget_exhausted: "bad", lease_conflict: "bad",
};
const tone = (k) => TONE[k] || "blue";

// Tiny icon set, inline: a page that must not fetch cannot use an icon font.
const I = {
  shell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  net: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  time: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12M18 9a3 3 0 0 1-3 3H9a3 3 0 0 0-3 3"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/></svg>',
  dot: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M15 12v2"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>',
  no: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.5 2.5a9.5 9.5 0 1 0 7 14.9A8 8 0 0 1 14.5 2.5Z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  cg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  sig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17c3-6 5-6 6 0s3 6 6 0M4 21h16"/></svg>',
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M8 11h6M11 8v6"/></svg>',
  idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>',
  budget: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/></svg>',
};
const toolIcon = (t) => /shell|run|exec/.test(t) ? I.shell : /fs_|file|read|write/.test(t) ? I.file : /http|fetch|net/.test(t) ? I.net : /timeline|snapshot|checkpoint|fork|plan|traject/.test(t) ? I.time : I.dot;

async function api(p, opts){
  const res = await fetch(p, Object.assign({}, opts, { headers: { authorization: "Bearer " + TOK } }));
  if (res.status === 401) throw new Error("token refused");
  return res.json();
}

// ---------- clock: the operator's local time, ticking on its own ----------
function tickClock(){
  const d = new Date();
  let h = d.getHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  $("clock").innerHTML = h + ":" + String(d.getMinutes()).padStart(2, "0") + "<small>" + ap + "</small>";
  $("date").textContent = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  $("greet").textContent = d.getHours() < 5 ? "Good night" : d.getHours() < 12 ? "Good morning" : d.getHours() < 18 ? "Good afternoon" : "Good evening";
}
setInterval(tickClock, 1000); tickClock();

// ---------- the gate: approve / deny straight from the list ----------
async function act(btn){
  const id = btn.dataset.id, what = btn.dataset.act;
  btn.closest(".task").querySelectorAll("button").forEach((b) => b.disabled = true);
  try { await api("/pending/" + id + "/" + what, { method: "POST" }); } finally { poll(); }
}
$("gate").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]"); if (b) { e.stopPropagation(); act(b); return; }
  const t = e.target.closest(".task"); if (t) { openTask = openTask === t.dataset.id ? null : t.dataset.id; if (LAST) renderGate(LAST); }
});

const argsView = (a) => a && typeof a.command === "string" ? "$ " + a.command : a && typeof a.path === "string" ? a.path : JSON.stringify(a);
const pill = (t, id, cls) => '<button class="pill ' + (cls || "") + '"' + (id ? ' id="' + id + '"' : "") + ">" + t + "</button>";
const head = (t, right) => "<h2><span>" + t + "</span>" + (right || "") + "</h2>";

function renderGate(s){
  const list = s.waiting_for_you, n = list.length, by = s.activity.by_decision || {};
  const decided = (by.human_approved || 0) + (by.approved_by_human || 0) + (by.human_denied || 0);
  const total = decided + n;
  $("gate").innerHTML = head("Waiting for you", pill(n ? n + " pending" : "clear", null, "q")) +
    '<div class="todo">' + (n ? list.map((g) =>
      '<div class="task' + (openTask === g.id ? " open" : "") + '" data-id="' + esc(g.id) + '">' +
        '<div class="o"></div>' +
        '<div class="t"><b>' + esc(g.reason) + "</b><code>" + esc(argsView(g.args)) + "</code></div>" +
        '<div class="act"><button class="ok" title="Approve" data-act="approve" data-id="' + esc(g.id) + '">' + I.ok + "</button>" +
        '<button class="no" title="Deny" data-act="deny" data-id="' + esc(g.id) + '">' + I.no + "</button></div>" +
      "</div>").join("") : '<p class="empty">nothing is waiting — the agent is not blocked on you</p>') + "</div>" +
    '<div class="prog"><span>Decided ' + decided + " / " + total + '</span><div class="bar"><i style="width:' + (total ? Math.round(100 * decided / total) : 0) + '%"></i></div></div>';
}

function renderGateWidget(s){
  const n = s.waiting_for_you.length;
  const w = $("gatew"); w.className = "card gate-widget" + (n ? " hot" : "");
  w.innerHTML =
    '<div class="head"><div class="moon" style="color:' + (n ? "var(--accent-2)" : "#f6e7c9") + '">' + (n ? I.sun : I.moon) + "</div>" +
      '<div class="big">' + n + "<i>" + (n === 1 ? "action" : "actions") + "</i></div></div>" +
    '<div class="sub">' + (n ? "Waiting for you" : "Nothing waiting") + "</div>" +
    '<div class="loc" title="' + esc(s.goal || "") + '">' + (s.goal ? esc(s.goal) : "no goal declared") + "</div>";
}

function renderEnforced(s){
  const e = s.enforcement, w = s.window_this_process, ms = s.memory_search, idle = s.idle || {};
  const tile = (icon, label, on, val, bad) =>
    '<div class="tile' + (on ? "" : " off") + '"><i class="' + (on ? "on" : bad ? "bad" : "") + '"></i>' + icon + "<span>" + label + "</span>" + (val != null ? "<em>" + esc(val) + "</em>" : "") + "</div>";
  $("enforced").innerHTML = head("Enforced here", pill("live", null, "q")) + '<div class="tiles">' +
    tile(I.lock, "Landlock", e.landlock, e.landlock ? "active" : "unavailable") +
    tile(I.cg, "cgroups", e.cgroups, e.cgroups ? "delegated" : "not delegated") +
    tile(I.sig, "Signed journal", e.journal_signed, e.journal_signed ? e.journal_entries + " entries" : "BROKEN", !e.journal_signed) +
    tile(I.brain, "Memory search", Boolean(ms.engine), ms.engine || "off") +
    tile(I.idle, "Idle window", idle.idle_share != null, idle.idle_share != null ? Math.round(idle.idle_share * 100) + "% idle" : "unmeasured") +
    tile(I.budget, "Budget", Boolean(w.limits), w.exhausted ? "exhausted" : w.limits ? "set" : "none", Boolean(w.exhausted)) +
    tile(I.key, "Identities", s.identities.length > 0, s.identities.length + " stored") +
    tile(I.link, "Leases", s.leases.length > 0, s.leases.length + " held") +
  "</div>";
}

function renderIdentities(s){
  const rows = s.identities.map((i) => '<div class="row"><div class="ic accent">' + I.key + '</div><div class="t"><b>' + esc(i.name) + "</b><span>" + esc(i.hosts.join(", ")) + "</span></div>" + I.chev + "</div>")
    .concat(s.leases.map((l) => '<div class="row"><div class="ic blue">' + I.link + '</div><div class="t"><b>' + esc(l.uri) + '</b><span>lease · ' + Math.round(l.expires_in_ms / 1000) + "s left</span></div>" + I.chev + "</div>"));
  $("identities").innerHTML = head("Identities & leases", pill("names only", null, "q")) +
    '<div class="list">' + (rows.length ? rows.join("") : '<p class="empty">no identities stored — names and scopes, never values</p>') + "</div>";
}

function renderStore(s){
  const st = s.store, ms = s.memory_search;
  $("store").innerHTML = head("Held off-window", pill(kb(st.bytes), null, "q")) +
    '<div class="note-box"><b>' + st.held + "</b> paged " + (st.held === 1 ? "result" : "results") + " kept out of the prompt<br>" +
      "<b>" + kb(st.bytes) + "</b> the model never had to carry<br>" +
      (st.untrusted ? '<b style="color:var(--warn)">' + st.untrusted + "</b> from untrusted sources" : "<b>0</b> from untrusted sources") +
      '<div class="when">memory by meaning · ' + (ms.engine ? esc(ms.engine) : "off") + "</div></div>";
}

function renderWindow(s){
  const w = s.window_this_process, rec = s.activity_on_record;
  const lim = w.limits && w.limits.calls, used = lim ? Math.min(100, Math.round(100 * w.calls / lim)) : null;
  $("window").innerHTML = '<div class="art"></div><div class="body">' +
    "<h2>Window</h2>" + '<div class="sub">' + (used != null ? used + "% of the call budget" : "no budget set") + "</div>" +
    '<div class="stats">' +
      "<small>On record · journal on disk</small><div><span>tool calls</span><b>" + rec.tool_calls + "</b></div>" +
      "<small>This process · in memory</small><div><span>calls</span><b>" + w.calls + "</b></div><div><span>tokens carried</span><b>" + w.est_tokens_carried + "</b></div>" +
    "</div>" +
    '<div class="bar"><i style="width:' + (used != null ? used : 0) + '%"></i></div>' +
    (w.note ? '<div class="note">' + esc(w.note) + "</div>" : "") +
    "</div>";
}

function journalRow(r){
  const cls = r.class || r.decision;
  const cmd = r.args && typeof r.args.command === "string" ? r.args.command : r.args && typeof r.args.path === "string" ? r.args.path : "";
  return '<div class="row"><div class="ic ' + tone(cls) + '" title="' + esc(cls || "") + '">' + toolIcon(r.tool || "") + '</div>' +
    '<div class="t"><b>' + esc(r.tool) + "</b><span>" + esc(r.decision) + (cmd ? " · " + esc(cmd) : r.class ? " · " + esc(r.class) : "") + "</span></div>" +
    '<div class="r" title="' + esc(r.ts) + '">' + ago(r.ts) + "</div></div>";
}
function renderJournal(s, found){
  if (found) {
    $("journal").innerHTML = head("Search · " + found.matched + (found.matched === 1 ? " match" : " matches"), pill("Clear", "clear-q")) +
      '<div class="list">' + (found.entries.length ? found.entries.map(journalRow).join("") : '<p class="empty">nothing in the journal matches</p>') + "</div>";
    $("clear-q").onclick = clearSearch;
    return;
  }
  const rows = ALL ? ALL : s.recent.slice(0, 6);
  $("journal").innerHTML = head(ALL ? "Journal · last " + ALL.length : "Just now", pill(ALL ? "Less" : "View all", "more-j")) +
    '<div class="list">' + (rows.length ? rows.map(journalRow).join("") : '<p class="empty">nothing yet</p>') + "</div>";
  $("more-j").onclick = async () => {
    if (ALL) { ALL = null; return renderJournal(LAST, null); }
    try { const r = await api("/journal?n=50"); ALL = (Array.isArray(r) ? r : r.entries || []).slice().reverse(); renderJournal(LAST, null); } catch (e) {}
  };
}

// ---------- search: the same route the CLI uses, with the operator's filters ----------
let qTimer = null, FOUND = null, ALL = null;
$("q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 220); });
$("qx").onclick = clearSearch;
function clearSearch(){ $("q").value = ""; FOUND = null; $("qx").hidden = true; if (LAST) renderJournal(LAST, null); }
async function runSearch(){
  const q = $("q").value.trim(); $("qx").hidden = !q;
  if (!q) return clearSearch();
  const p = new URLSearchParams({ n: "50" });
  const m = q.match(/^(tool|decision):([^ ]+) *(.*)$/);
  if (m) { p.set(m[1], m[2]); if (m[3]) p.set("contains", m[3]); } else p.set("contains", q);
  try { FOUND = await api("/journal?" + p.toString()); if (LAST) renderJournal(LAST, FOUND); } catch (e) {}
}

function render(s){
  LAST = s;
  renderGateWidget(s); renderGate(s); renderEnforced(s); renderIdentities(s); renderStore(s); renderWindow(s); renderJournal(s, FOUND);
  $("foot").innerHTML = '<span class="dot' + (Date.now() - lastOk > 6000 ? " stale" : "") + '"></span>Nothing here is the agent’s account of itself · as of ' + new Date(s.at).toLocaleTimeString([], { hour12: false });
}

// rail: highlight the section in view
const navs = Array.from(document.querySelectorAll(".rail a[data-nav]"));
const io = new IntersectionObserver((es) => { es.forEach((e) => { if (e.isIntersecting) navs.forEach((a) => a.classList.toggle("on", a.dataset.nav === e.target.id)); }); }, { rootMargin: "-40% 0px -50% 0px" });
["top","gate","journal","enforced","store","identities","window"].forEach((id) => { const el = $(id); if (el) io.observe(el); });

async function poll(){
  if (!TOK) return;
  try {
    const s = await api("/status");
    $("login").hidden = true; $("shell").hidden = false; $("err").textContent = "";
    lastOk = Date.now();
    render(s);
  } catch (err) {
    if (err.message === "token refused") { $("err").textContent = "That token was refused."; forget(); return; }
    // The daemon may be restarting; keep the last picture and mark it stale.
    if (LAST) render(LAST); else $("err").textContent = err.message;
  }
}
poll();
setInterval(poll, 2500);
</script>`;
