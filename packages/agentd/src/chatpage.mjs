// The conversation page: a person, an agent, and the window between them.
//
// Same rules as console.mjs: no dependencies, no build step, no external
// request, token in a header and never in the URL (events are streamed with
// fetch rather than EventSource for exactly that reason). The page shows the
// window as it is — stubs for what was paged out, a chip for every fault back
// in, the meter per turn — because the pager is only worth having if the
// person can see it work. The markup avoids backslashes: it lives in a
// template literal and they would be eaten before the browser saw them.
export const CHAT_PAGE = `<!doctype html>
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
  .sky{position:fixed;inset:0;z-index:-1;background:
      radial-gradient(1100px 600px at 80% -10%, rgba(238,122,134,.10), transparent 60%),
      radial-gradient(900px 600px at 10% 10%, rgba(70,105,180,.20), transparent 60%),
      radial-gradient(1400px 900px at 50% 125%, rgba(28,40,64,.55), transparent 60%),
      linear-gradient(180deg,#0a0e16 0%,#07090e 60%,#04060a 100%)}
  .card{background:var(--card);backdrop-filter:blur(18px) saturate(130%);-webkit-backdrop-filter:blur(18px) saturate(130%);
      border:1px solid var(--line);border-radius:var(--r);box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 18px 50px rgba(0,0,0,.35)}

  .rail{position:fixed;left:18px;top:18px;bottom:18px;width:56px;z-index:6;display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 0}
  .rail a,.rail button{width:40px;height:40px;display:grid;place-items:center;border-radius:12px;color:var(--ink-2);background:transparent;border:0;cursor:pointer;padding:0}
  .rail a:hover,.rail button:hover,.rail a.on{background:var(--inner-2);color:var(--ink)}
  .rail svg{width:19px;height:19px}
  .rail .grow{flex:1}

  .app{padding:18px 22px 18px calc(22px + 74px);min-height:100vh;display:flex;flex-direction:column;gap:14px}
  .top{display:flex;align-items:center;gap:10px}
  .chip{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:12px;font-size:13px;color:var(--ink-2);max-width:40vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .chip.st,.chip#modelchip{flex:none;max-width:none}
  .chip b{color:var(--ink);font-weight:500}
  .grow{flex:1}
  .st{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-2)}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--dim)}
  .dot.idle{background:var(--good)} .dot.thinking{background:var(--blue);animation:pulse 1.2s infinite} .dot.waiting_for_you{background:var(--accent)}
  @keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
  .pill{font:500 12px var(--sans);color:var(--ink-2);background:var(--inner-2);border:0;border-radius:8px;padding:5px 10px;cursor:pointer;white-space:nowrap}
  .pill:hover{color:var(--ink);background:rgba(255,255,255,.11)}
  .pill.q{cursor:default}

  .cols{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:14px;flex:1;min-height:0}
  .chat{display:flex;flex-direction:column;min-height:60vh;max-height:calc(100vh - 110px)}
  .msgs{flex:1;overflow:auto;padding:18px 18px 6px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}
  .m{max-width:78%;padding:10px 14px;border-radius:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  .m.user{align-self:flex-end;background:rgba(238,122,134,.16);border:1px solid rgba(238,122,134,.25)}
  .m.assistant{align-self:flex-start;background:var(--inner);border:1px solid var(--line)}
  .m.sys{align-self:center;color:var(--dim);font-size:12.5px;background:transparent}
  .tool{align-self:flex-start;max-width:78%;font:12.5px var(--mono);color:var(--ink-2);background:rgba(0,0,0,.28);border:1px solid var(--line);border-radius:10px;padding:6px 10px;cursor:pointer}
  .tool b{color:var(--ink);font-weight:500}
  .tool .s{margin-left:8px;color:var(--dim)} .tool .s.ok{color:var(--good)} .tool .s.warn{color:var(--warn)} .tool .s.bad{color:var(--bad)} .tool .s.gate{color:var(--accent)}
  .tool pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-all;color:var(--ink-2);max-height:220px;overflow:auto;font-size:12px}
  .tool.ev{border-style:dashed;color:var(--dim)}
  .gate{align-self:stretch;padding:14px 16px;border:1px solid rgba(238,122,134,.35);border-radius:14px;background:rgba(238,122,134,.08)}
  .gate .why{font-weight:500;margin-bottom:6px}
  .gate code{display:block;font:12.5px var(--mono);color:#f3c9b8;background:rgba(0,0,0,.35);border-radius:8px;padding:8px 10px;margin:6px 0 10px;white-space:pre-wrap;word-break:break-all}
  .gate .act{display:flex;gap:8px}
  .gate button{font:500 13px var(--sans);border-radius:10px;padding:8px 14px;cursor:pointer;border:1px solid var(--line-2);background:var(--inner);color:var(--ink)}
  .gate button.ok{background:var(--accent);border-color:transparent;color:#1a0a0d}
  .gate button[disabled]{opacity:.5;cursor:default}
  .gate.done{opacity:.6}
  .compose{display:flex;gap:10px;padding:12px 14px;border-top:1px solid var(--line)}
  .compose textarea{flex:1;resize:none;min-height:44px;max-height:160px;font:14px var(--sans);color:var(--ink);background:rgba(0,0,0,.3);border:1px solid var(--line-2);border-radius:12px;padding:11px 13px;outline:none}
  .compose textarea:focus{border-color:var(--blue)}
  .compose button{font:500 14px var(--sans);border-radius:12px;padding:0 18px;border:0;background:var(--accent);color:#1a0a0d;cursor:pointer}
  .compose button[disabled]{opacity:.5;cursor:default}

  .side{display:flex;flex-direction:column;gap:14px;overflow:auto;max-height:calc(100vh - 110px)}
  .w{padding:14px 16px}
  .w h2{margin:0 0 10px;font-size:13.5px;font-weight:600;display:flex;justify-content:space-between;align-items:center;gap:8px}
  .bar{height:6px;border-radius:99px;background:var(--inner-2);overflow:hidden;margin:6px 0 8px}
  .bar i{display:block;height:100%;background:var(--blue);border-radius:99px}
  .bar i.hot{background:var(--accent)}
  .kv{display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--line);font-size:12.5px}
  .kv:last-child{border-bottom:none}
  .kv span:first-child{color:var(--ink-2)} .kv span:last-child{font-variant-numeric:tabular-nums;font-weight:500}
  .list{display:flex;flex-direction:column;gap:5px}
  .row{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:9px;background:var(--inner);font-size:12.5px;cursor:pointer;min-width:0}
  .row:hover{background:var(--inner-2)}
  .row .n{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .row .r{color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap}
  .row.dir .n{color:var(--blue)}
  .row button{font:500 11.5px var(--sans);border:0;border-radius:7px;padding:4px 8px;background:var(--inner-2);color:var(--ink-2);cursor:pointer}
  .row button:hover{color:var(--ink)}
  .viewer pre{margin:0;font:12px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;background:rgba(0,0,0,.3);border-radius:9px;padding:10px}
  .empty{color:var(--dim);font-style:italic;font-size:12.5px;margin:4px 0}

  #start{display:grid;place-items:center;min-height:calc(100vh - 36px)}
  #start .card{width:min(560px,100%);padding:26px}
  #start h1{margin:0 0 4px;font-size:22px;font-weight:500}
  #start p{margin:0 0 14px;color:var(--ink-2);font-size:13.5px}
  #start label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px;letter-spacing:.06em;text-transform:uppercase}
  #start input,#start textarea{width:100%;font:14px var(--sans);color:var(--ink);background:rgba(0,0,0,.3);border:1px solid var(--line-2);border-radius:11px;padding:10px 12px;outline:none}
  #start textarea{min-height:80px;resize:vertical}
  #start button{margin-top:14px;font:500 14px var(--sans);border-radius:11px;padding:11px 18px;border:0;background:var(--accent);color:#1a0a0d;cursor:pointer}
  #start .prev{margin-top:18px}
  #start .err{color:var(--bad);font-size:13px;min-height:18px;margin-top:8px}
  #login{min-height:100vh;display:grid;place-items:center;padding:20px}
  #login .card{width:min(420px,100%);padding:26px}
  #login input{width:100%;font:14px var(--sans);padding:11px 13px;border-radius:11px;border:1px solid var(--line-2);background:rgba(0,0,0,.35);color:var(--ink);outline:none;margin:8px 0}
  #login button{width:100%;font:500 14px var(--sans);border-radius:11px;padding:11px;border:0;background:var(--accent);color:#1a0a0d;cursor:pointer}
  @media (max-width:980px){.cols{grid-template-columns:1fr}.side{max-height:none}.rail{display:none}.app{padding:14px}}
</style>
<div class="sky" aria-hidden="true"></div>

<div id="login" hidden>
  <div class="card">
    <h1 style="margin:0 0 6px;font-size:20px;font-weight:500">Nefertari</h1>
    <p style="color:var(--ink-2);font-size:13.5px;margin:0 0 6px">Paste the bearer token — <code>NEFERTARI_TOKEN</code>, or <code>~/.nefertari/token</code> on the host.</p>
    <form onsubmit="saveTok(event)"><input id="tok" type="password" placeholder="token" autocomplete="off"><button type="submit">Enter</button></form>
    <p class="err" id="lerr" style="color:var(--bad);font-size:13px;min-height:18px"></p>
  </div>
</div>

<div id="shell" hidden>
  <nav class="rail card" aria-label="Sections">
    <a href="#" class="on" title="Conversation" id="nav-chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H8l-4 4z"/></svg></a>
    <a href="#docs" title="Documents" id="nav-docs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg></a>
    <a href="#window" title="Window" id="nav-window"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/></svg></a>
    <a href="/" title="Operator console"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12l2 2 4-4"/></svg></a>
    <div class="grow"></div>
    <button id="new" title="New conversation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
  </nav>

  <div id="start" hidden>
    <div class="card">
      <h1>What should be done?</h1>
      <p>Say it as you would to a person. The agent works in the folder below; anything it changes can be undone.</p>
      <label>Goal</label><textarea id="goal" placeholder="e.g. tidy up this folder: group by type, find duplicates, do not delete anything without asking me"></textarea>
      <label>Folder</label><input id="dir" placeholder="/home/me/Downloads">
      <button id="go">Start</button>
      <div class="err" id="serr"></div>
      <div class="prev" id="prev"></div>
    </div>
  </div>

  <div id="app" class="app" hidden>
    <div class="top">
      <span class="chip card" id="goalchip"></span>
      <span class="chip card" id="dirchip"></span>
      <div class="grow"></div>
      <span class="chip card" id="modelchip"></span>
      <span class="chip card st"><i class="dot" id="dot"></i><span id="state">idle</span></span>
    </div>
    <div class="cols">
      <section class="card chat">
        <div class="msgs" id="msgs"></div>
        <form class="compose" id="compose">
          <textarea id="text" placeholder="Write to the agent… (Enter sends, Shift+Enter for a new line)"></textarea>
          <button type="submit" id="send">Send</button>
        </form>
      </section>
      <aside class="side">
        <section class="card w" id="window">
          <h2>Window <span class="pill q" id="wbudget"></span></h2>
          <div class="bar"><i id="wbar" style="width:0%"></i></div>
          <div id="wstats"></div>
        </section>
        <section class="card w" id="docs">
          <h2>Documents <button class="pill" id="docs-back" hidden>Back</button></h2>
          <div id="files" class="list"></div>
          <div id="viewer" class="viewer" hidden></div>
        </section>
        <section class="card w" id="tl">
          <h2>Timeline <button class="pill" id="tl-refresh">Refresh</button></h2>
          <div id="ckpts" class="list"></div>
        </section>
      </aside>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const NL = String.fromCharCode(10);
let TOK = sessionStorage.getItem("nef") || "";
let SID = sessionStorage.getItem("nef-chat") || "";
let S = null, streamAbort = null, curDir = "";
const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;" }[c]));
const kb = (n) => n > 1048576 ? (n/1048576).toFixed(1)+" MB" : n > 1024 ? Math.round(n/1024)+" KB" : n+" B";
const H = () => ({ authorization: "Bearer " + TOK, "content-type": "application/json" });
async function api(p, opts){ const r = await fetch(p, Object.assign({ headers: H() }, opts)); if (r.status === 401) throw new Error("token refused"); return r.json(); }

function saveTok(ev){ if (ev) ev.preventDefault(); TOK = $("tok").value.trim(); sessionStorage.setItem("nef", TOK); boot(); }
async function boot(){
  if (!TOK) { $("login").hidden = false; return; }
  try { await api("/chat/sessions"); } catch (e) { $("login").hidden = false; $("lerr").textContent = e.message; return; }
  $("login").hidden = true; $("shell").hidden = false;
  if (SID) { try { await open(SID); return; } catch (e) {} }
  showStart();
}
async function showStart(){
  $("app").hidden = true; $("start").hidden = false;
  const prev = await api("/chat/sessions");
  $("prev").innerHTML = prev.length ? '<label>Earlier</label><div class="list">' + prev.slice(0, 8).map((p) => '<div class="row" data-open="' + p.id + '"><span class="n">' + esc(p.goal || "(no goal)") + '</span><span class="r">' + esc(p.state) + " · " + p.turns + " turns</span></div>").join("") + "</div>" : "";
  $("prev").querySelectorAll("[data-open]").forEach((el) => el.onclick = () => open(el.dataset.open));
}
$("new").onclick = () => { if (streamAbort) streamAbort.abort(); SID = ""; sessionStorage.removeItem("nef-chat"); showStart(); };
$("go").onclick = async () => {
  $("serr").textContent = "";
  try {
    const s = await api("/chat/sessions", { method: "POST", body: JSON.stringify({ goal: $("goal").value.trim(), dir: $("dir").value.trim() }) });
    if (s.error) throw new Error(s.error);
    await open(s.id);
  } catch (e) { $("serr").textContent = e.message; }
};

async function open(id){
  const s = await api("/chat/sessions/" + id);
  if (s.error) throw new Error(s.error);
  S = s; SID = id; sessionStorage.setItem("nef-chat", id);
  $("start").hidden = true; $("app").hidden = false;
  $("goalchip").innerHTML = "<b>goal</b> " + esc(s.goal || "(none)"); $("dirchip").innerHTML = "<b>in</b> " + esc(s.dir); $("modelchip").innerHTML = "<b>model</b> " + esc(s.model);
  $("msgs").innerHTML = ""; renderHistory(s); setState(s.state, s.pending); renderStats(s.stats);
  loadFiles(""); loadTimeline();
  stream(id);
}

// ---- messages ----
const add = (html) => { const d = document.createElement("div"); d.innerHTML = html; const el = d.firstElementChild; $("msgs").appendChild(el); $("msgs").scrollTop = $("msgs").scrollHeight; return el; };
const toneOf = (st) => st === "pending_approval" ? "gate" : /^exit [1-9]|error|denied/.test(st || "") ? "bad" : /pending|rolled/.test(st || "") ? "warn" : "ok";
function toolChip(t){
  const id = "t-" + (t.id || Math.random().toString(36).slice(2));
  let el = document.getElementById(id);
  const inner = "<b>" + esc(t.name) + "</b> " + esc(t.args_brief || "") + (t.status ? '<span class="s ' + toneOf(t.status) + '">' + esc(t.status) + "</span>" : '<span class="s">…</span>') +
    (t.handle ? '<span class="s">paged → ' + esc(t.handle) + "</span>" : "") + (t.checkpoint_id ? '<span class="s">undo: ' + esc(t.checkpoint_id) + "</span>" : "") +
    (t.preview ? "<pre hidden>" + esc(t.preview) + "</pre>" : "");
  if (!el) { el = add('<div class="tool" id="' + id + '">' + inner + "</div>"); el.onclick = () => { const p = el.querySelector("pre"); if (p) p.hidden = !p.hidden; }; }
  else el.innerHTML = inner;
  if (t.handle) el.classList.add("ev");
}
function gateCard(p){
  const id = "g-" + p.action_id;
  if (document.getElementById(id)) return;
  const a = p.args || {};
  const cmd = typeof a.command === "string" ? "$ " + a.command : typeof a.path === "string" ? a.path : JSON.stringify(a);
  const el = add('<div class="gate" id="' + id + '"><div class="why">Waiting for you — ' + esc(p.tool) + '</div><div style="color:var(--ink-2);font-size:13px">' + esc(p.reason || "") + "</div><code>" + esc(cmd) + '</code><div class="act"><button class="ok" data-w="approve">Approve</button><button data-w="deny">Deny</button></div></div>');
  el.querySelectorAll("button").forEach((b) => b.onclick = async () => { el.querySelectorAll("button").forEach((x) => x.disabled = true); await api("/chat/sessions/" + SID + "/gate/" + p.action_id + "/" + b.dataset.w, { method: "POST" }); el.classList.add("done"); });
}
function renderHistory(s){
  const briefs = {};
  for (const m of s.messages) {
    if (m.role === "user") add('<div class="m user">' + esc(m.content) + "</div>");
    else if (m.role === "assistant") { if (m.content) add('<div class="m assistant">' + esc(m.content) + "</div>"); for (const c of m.tool_calls || []) { let a = {}; try { a = JSON.parse(c.arguments || "{}"); } catch {} briefs[c.id] = a.command ? a.command.slice(0, 80) : a.path ? a.path.split("/").pop() : ""; toolChip({ id: c.id, name: c.name, args_brief: briefs[c.id] }); } }
    else if (m.role === "tool") { let j = null; try { j = JSON.parse(m.content); } catch {} toolChip({ id: m.tool_call_id, name: m.name, args_brief: briefs[m.tool_call_id] || "", status: m.evicted ? "paged out" : j && j.status ? j.status : j && j.exitCode != null ? "exit " + j.exitCode : "ok", handle: m.handle, preview: m.evicted ? m.content : m.content.slice(0, 400), checkpoint_id: j && j.checkpoint_id }); }
  }
  if (s.pending) gateCard(s.pending);
}
function setState(st, pending){
  $("dot").className = "dot " + st; $("state").textContent = st === "waiting_for_you" ? "waiting for you" : st;
  $("send").disabled = st !== "idle"; $("text").disabled = st !== "idle";
  if (pending) gateCard(pending);
}
function renderStats(st){
  if (!st) return;
  const pct = Math.min(100, Math.round(100 * (st.resident || 0) / (st.budget || 1)));
  $("wbudget").textContent = (st.resident || 0) + " / " + st.budget + " tok";
  $("wbar").style.width = pct + "%"; $("wbar").className = pct > 85 ? "hot" : "";
  $("wstats").innerHTML = [["turns", st.turns], ["model calls", st.model_calls], ["tool calls", st.tool_calls], ["delivered, total", st.delivered + " tok"], ["evicted", st.evicted + " results · " + kb(st.evicted_bytes || 0)], ["faulted back in", st.faults], ["gates", st.gates]]
    .map(([k, v]) => '<div class="kv"><span>' + k + "</span><span>" + v + "</span></div>").join("");
}

// ---- live events: fetch-streamed SSE, so the token travels in a header and never in the URL ----
async function stream(id){
  if (streamAbort) streamAbort.abort();
  streamAbort = new AbortController();
  const seen = $("msgs").children.length;
  let res;
  try { res = await fetch("/chat/sessions/" + id + "/events", { headers: H(), signal: streamAbort.signal }); } catch { return; }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ""; let replayed = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf(NL + NL)) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split(NL).find((l) => l.startsWith("data: ")); if (!line) continue;
      let e; try { e = JSON.parse(line.slice(6)); } catch { continue; }
      // History was rendered from the session; skip the replayed events that predate the last render.
      if (replayed < S.events_seen) { replayed++; continue; }
      onEvent(e);
    }
  }
}
function onEvent(e){
  if (e.type === "user") add('<div class="m user">' + esc(e.content) + "</div>");
  else if (e.type === "assistant") add('<div class="m assistant">' + esc(e.content) + "</div>");
  else if (e.type === "tool") toolChip(e);
  else if (e.type === "state") { setState(e.state, e.pending); if (e.error) add('<div class="m sys">error: ' + esc(e.error) + "</div>"); if (e.state === "idle") { loadFiles(curDir); loadTimeline(); } }
  else if (e.type === "stats") renderStats(e.stats);
  else if (e.type === "evict") add('<div class="tool ev">paged out → <b>' + esc(e.handle) + "</b> " + esc(e.tool || "") + " · " + kb(e.bytes) + " · " + esc(e.why) + "</div>");
  else if (e.type === "fault") add('<div class="tool ev">faulted back ← <b>' + esc(e.handle) + "</b>" + (e.grep ? " · grep " + esc(e.grep) : "") + "</div>");
  else if (e.type === "decision") { const g = document.getElementById("g-" + e.action_id); if (g) { g.classList.add("done"); g.querySelectorAll("button").forEach((b) => b.disabled = true); } }
  else if (e.type === "restore") { add('<div class="m sys">restored ' + esc(e.checkpoint_id) + "</div>"); loadFiles(curDir); loadTimeline(); }
  else if (e.type === "error") add('<div class="m sys">error: ' + esc(e.message) + "</div>");
}

// ---- compose ----
$("compose").onsubmit = async (ev) => { ev.preventDefault(); const t = $("text").value.trim(); if (!t) return; $("text").value = ""; try { const r = await api("/chat/sessions/" + SID + "/say", { method: "POST", body: JSON.stringify({ text: t }) }); if (r.error) add('<div class="m sys">' + esc(r.error) + "</div>"); } catch (e) { add('<div class="m sys">' + esc(e.message) + "</div>"); } };
$("text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("compose").requestSubmit(); } });

// ---- documents ----
async function loadFiles(rel){
  curDir = rel || "";
  const files = await api("/chat/sessions/" + SID + "/files?path=" + encodeURIComponent(curDir));
  $("viewer").hidden = true; $("files").hidden = false; $("docs-back").hidden = !curDir;
  $("files").innerHTML = (Array.isArray(files) && files.length) ? files.map((f) => '<div class="row' + (f.dir ? " dir" : "") + '" data-p="' + esc(f.path) + '" data-d="' + (f.dir ? 1 : 0) + '"><span class="n">' + esc(f.name) + (f.dir ? "/" : "") + '</span><span class="r">' + (f.dir ? "" : kb(f.bytes)) + "</span></div>").join("") : '<p class="empty">empty folder</p>';
  $("files").querySelectorAll(".row").forEach((el) => el.onclick = () => el.dataset.d === "1" ? loadFiles(el.dataset.p) : openFile(el.dataset.p));
}
$("docs-back").onclick = () => { if ($("viewer").hidden) loadFiles(curDir.split("/").slice(0, -1).join("/")); else loadFiles(curDir); };
async function openFile(rel){
  const r = await api("/chat/sessions/" + SID + "/file?path=" + encodeURIComponent(rel));
  $("files").hidden = true; $("viewer").hidden = false; $("docs-back").hidden = false;
  const body = r.__paged ? "(large file: " + kb(r.bytes) + ", handle " + r.handle + ")" + NL + NL + (r.preview || "") : (r.text != null ? r.text : JSON.stringify(r, null, 1));
  $("viewer").innerHTML = '<div style="font-size:12.5px;color:var(--ink-2);margin-bottom:6px">' + esc(rel) + "</div><pre>" + esc(body) + "</pre>";
}

// ---- timeline ----
async function loadTimeline(){
  const cks = await api("/chat/sessions/" + SID + "/timeline");
  $("ckpts").innerHTML = (Array.isArray(cks) && cks.length) ? cks.map((c) => '<div class="row" title="' + esc(c.id) + '"><span class="n">' + esc(c.label || c.id) + '</span><span class="r">' + new Date(c.createdAt).toLocaleTimeString([], { hour12: false }) + " · " + c.files + ' files</span><button data-ck="' + esc(c.id) + '">Restore</button></div>').join("") : '<p class="empty">nothing checkpointed yet</p>';
  $("ckpts").querySelectorAll("button").forEach((b) => b.onclick = async (ev) => { ev.stopPropagation(); if (!confirm("Put the folder back as it was at this point? (this is itself undoable)")) return; b.disabled = true; await api("/chat/sessions/" + SID + "/restore", { method: "POST", body: JSON.stringify({ checkpoint_id: b.dataset.ck }) }); });
}
$("tl-refresh").onclick = loadTimeline;
document.querySelectorAll(".rail a[href^='#']").forEach((a) => a.onclick = (e) => { e.preventDefault(); const t = a.getAttribute("href").slice(1); if (t) { const el = document.getElementById(t); if (el) el.scrollIntoView({ behavior: "smooth" }); } });
boot();
</script>`;
