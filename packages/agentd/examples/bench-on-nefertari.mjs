// REAL benchmark: measure the taxes the performance track claims to kill,
// with a real model driving Nefertari over MCP. No synthetic numbers — every
// datapoint is model turns / API-reported tokens / wall-clock / a PHYSICAL
// success check on disk.
//
//   Bench A (round-trip tax): create 6 exact files.
//     mode "single" = one fs_write per file (plan_run hidden from the model)
//     mode "plan"   = the whole thing in ONE plan_run
//   Bench B (single-path tax): pick the tagline that passes an acceptance grep.
//     mode "seq"  = try candidates one at a time (write, grep, backtrack)
//     mode "traj" = ONE trajectories_run ×3 + promote the winner
//
// Usage: node examples/bench-on-nefertari.mjs [benchFilter] — provider from env
// (same resolution as the other examples); results appended as JSON to
// $BENCH_OUT (default: bench-results.json next to this file).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function loadEnvFile(p) {
  try {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
for (const p of (process.env.ANIA_ENV_FILES || "").split(path.delimiter).filter(Boolean)) loadEnvFile(p);

const P = {
  base: process.env.NEFERTARI_LLM_BASE_URL,
  key: process.env.NEFERTARI_LLM_API_KEY,
  model: process.env.NEFERTARI_LLM_MODEL,
};
if (!P.base || !P.model) throw new Error("set NEFERTARI_LLM_BASE_URL / _API_KEY / _MODEL");
const mask = (k) => (k ? k.slice(0, 5) + "…" + k.slice(-3) : "ABSENT");
console.log(`bench model: ${P.model} @ ${P.base} (key ${mask(P.key)})\n`);

// ---------- fixed workloads ----------
const FILES = {
  "src/index.html": "<h1>Cellnovis</h1>",
  "src/styles.css": "body{color:#0E4D64}",
  "src/app.js": "console.log('cellnovis')",
  "docs/README.md": "# Cellnovis site",
  "docs/DEPLOY.md": "deploy: cloudflare pages",
  "data/products.csv": "sku,name\ncn-derm,CN-Derm",
};
const fileSpec = Object.entries(FILES)
  .map(([f, c]) => `- "${f}" containing EXACTLY (no extra whitespace):\n${c}`)
  .join("\n");

const CANDIDATES = [
  "La rivoluzione della diagnostica è arrivata",
  "Tecnologia medicale che stupisce il mercato",
  "Diagnostica di cui i clinici si fidano, ogni giorno",
];
const candSpec = CANDIDATES.map((c, i) => `${i + 1}. ${c}`).join("\n");

const BASE_RULES = `You are an autonomous executor operating a Linux host through the Nefertari tool layer. Every action goes through a permission broker; irreversible actions return "pending_approval" (expected — never bypass). When the task is done, reply with a ONE-LINE summary and NO tool call.`;

const RUNS = [
  {
    bench: "A-files",
    mode: "single",
    hide: ["plan_run", "trajectories_run"],
    maxTurns: 24,
    task: (ws) =>
      `In the directory ${ws} create these 6 files, one fs_write call per file (absolute paths). Do not verify afterwards; finish as soon as the last file is written.\n${fileSpec}`,
    verify: (ws) => Object.entries(FILES).every(([f, c]) => {
      try { return fs.readFileSync(path.join(ws, f), "utf8").trim() === c.trim(); } catch { return false; }
    }),
  },
  {
    bench: "A-files",
    mode: "plan",
    hide: ["trajectories_run"],
    maxTurns: 12,
    task: (ws) =>
      `In the directory ${ws} create these 6 files using ONE single plan_run call (dir = ${ws}, one fs_write step per file, RELATIVE paths). Do not verify afterwards; finish right after the plan completes.\n${fileSpec}`,
    verify: (ws) => Object.entries(FILES).every(([f, c]) => {
      try { return fs.readFileSync(path.join(ws, f), "utf8").trim() === c.trim(); } catch { return false; }
    }),
  },
  {
    bench: "B-tagline",
    mode: "seq",
    hide: ["plan_run", "trajectories_run", "timeline_checkpoint", "timeline_fork", "timeline_promote", "timeline_restore"],
    maxTurns: 24,
    task: (ws) =>
      `In the directory ${ws}: find which of these 3 candidate taglines passes the acceptance test, trying them ONE AT A TIME in order: write the candidate into ${ws}/hero.md with fs_write, then run the acceptance test with shell: grep -qi fidano hero.md (cwd ${ws}). Exit 0 = pass. If it fails, overwrite hero.md with the next candidate and test again. Stop as soon as one passes and report which.\nCandidates:\n${candSpec}`,
    verify: (ws) => { try { return /fidano/i.test(fs.readFileSync(path.join(ws, "hero.md"), "utf8")); } catch { return false; } },
  },
  {
    bench: "B-tagline",
    mode: "traj",
    hide: ["plan_run"],
    maxTurns: 12,
    task: (ws) =>
      `In the directory ${ws}: find which of these 3 candidate taglines passes the acceptance test "grep -qi fidano hero.md" — race them in PARALLEL: timeline_checkpoint the directory, then ONE trajectories_run call with 3 trajectories (each a single fs_write of hero.md — RELATIVE path — with one candidate) and eval_cmd "grep -qi fidano hero.md". Then timeline_promote the winner into ${ws} and report which candidate won.\nCandidates:\n${candSpec}`,
    verify: (ws) => { try { return /fidano/i.test(fs.readFileSync(path.join(ws, "hero.md"), "utf8")); } catch { return false; } },
  },
];

// ---------- executor ----------
async function runOne(run) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `nef-bench-${run.bench}-${run.mode}-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-bench-home-"));
  const mcp = new Client({ name: "bench", version: "0.1.0" });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, "..", "src", "server.mjs")],
    env: { ...process.env, NEFERTARI_HOME: home },
  }));
  const { tools: mcpTools } = await mcp.listTools();
  const visible = mcpTools.filter((t) => !run.hide.includes(t.name));
  const oaiTools = visible.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: "object", properties: {} } },
  }));

  const messages = [
    { role: "system", content: BASE_RULES },
    { role: "user", content: run.task(ws) },
  ];
  const stat = { turns: 0, toolCalls: 0, promptTok: 0, complTok: 0, errors: 0 };
  const t0 = Date.now();

  for (let turn = 1; turn <= run.maxTurns; turn++) {
    const res = await fetch(`${P.base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${P.key}`, "X-Title": "Nefertari bench" },
      body: JSON.stringify({ model: P.model, messages, tools: oaiTools, tool_choice: "auto", temperature: 0.1 }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    stat.turns++;
    stat.promptTok += j.usage?.prompt_tokens || 0;
    stat.complTok += j.usage?.completion_tokens || 0;
    const m = j.choices[0].message;
    messages.push(m);
    const calls = m.tool_calls || [];
    if (!calls.length) break;
    for (const c of calls) {
      stat.toolCalls++;
      let args = {};
      try { args = JSON.parse(c.function.arguments || "{}"); } catch {}
      let out;
      if (run.hide.includes(c.function.name)) {
        out = JSON.stringify({ error: `tool ${c.function.name} is not available in this mode` });
        stat.errors++;
      } else {
        try {
          const r = await mcp.callTool({ name: c.function.name, arguments: args });
          out = r.content?.[0]?.text ?? "";
        } catch (e) {
          out = JSON.stringify({ error: String(e.message || e) });
          stat.errors++;
        }
      }
      if (process.env.BENCH_VERBOSE) {
        let v = "ok";
        try { const p = JSON.parse(out); v = p.error ? `ERR ${String(p.error).slice(0, 80)}` : p.status || (p.winner ? `winner ${p.winner.label || p.winner.fork_id}` : p.exitCode !== undefined ? `exit ${p.exitCode}` : "ok"); } catch {}
        console.log(`    [t${turn}] ${c.function.name}(${JSON.stringify(args).slice(0, 90)}) → ${v}`);
      }
      messages.push({ role: "tool", tool_call_id: c.id, content: out.slice(0, 4000) });
    }
  }

  const wallMs = Date.now() - t0;
  const success = run.verify(ws);
  await mcp.close();
  fs.rmSync(ws, { recursive: true, force: true });
  return {
    model: P.model, bench: run.bench, mode: run.mode, success,
    turns: stat.turns, toolCalls: stat.toolCalls,
    promptTok: stat.promptTok, complTok: stat.complTok,
    totalTok: stat.promptTok + stat.complTok,
    wallS: Math.round(wallMs / 100) / 10, errors: stat.errors,
  };
}

const filter = process.argv[2] || "";
const results = [];
for (const run of RUNS.filter((r) => !filter || r.bench.startsWith(filter))) {
  process.stdout.write(`▶ ${run.bench} / ${run.mode} … `);
  try {
    const r = await runOne(run);
    results.push(r);
    console.log(`${r.success ? "OK" : "FAIL"}  turns=${r.turns} calls=${r.toolCalls} tok=${r.totalTok} wall=${r.wallS}s${r.errors ? ` errs=${r.errors}` : ""}`);
  } catch (e) {
    console.log(`ERROR: ${String(e.message).slice(0, 200)}`);
    results.push({ model: P.model, bench: run.bench, mode: run.mode, success: false, error: String(e.message).slice(0, 200) });
  }
}

const OUT = process.env.BENCH_OUT || path.join(import.meta.dirname, "bench-results.json");
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
fs.writeFileSync(OUT, JSON.stringify([...prev, ...results], null, 2));
console.log(`\nresults appended to ${OUT}`);
