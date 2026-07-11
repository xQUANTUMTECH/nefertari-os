// A Fortuna BRAND/MARKETING executor (real LLM brain) driving Nefertari OS —
// the first live-model exercise of the PERFORMANCE primitives (T1–T3):
//
//   1. ground: read the brand workspace (fs_read, reversible)
//   2. SPECULATE: timeline_checkpoint + trajectories_run ×3 — three alternative
//      hero taglines raced in parallel forks, eval_cmd as the acceptance test,
//      timeline_promote adopts the winner (this is the Fortuna Team AI pattern:
//      one fork per strategy, promote = merge review)
//   3. EXECUTE AT INTENT: the whole supporting kit (2 social posts + brand.json
//      update) in ONE plan_run call — 1 model turn instead of 4
//   4. publish to the network → curl POST = IRREVERSIBLE → pending_approval.
//      Publishing stays behind the human gate, exactly like Fortuna's own
//      publishing pipeline (the agent stops at "ready", a human publishes).
//
// Provider + secrets handling identical to the other examples: key comes from
// env/.env files, only ever printed masked.

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

function resolveProvider() {
  if (process.env.NEFERTARI_LLM_BASE_URL && process.env.NEFERTARI_LLM_MODEL) {
    return { base: process.env.NEFERTARI_LLM_BASE_URL, key: process.env.NEFERTARI_LLM_API_KEY, model: process.env.NEFERTARI_LLM_MODEL, label: "custom (Atlas?)" };
  }
  if ((process.env.ENGINE_PROVIDER || "").toLowerCase() === "openrouter" && process.env.OPENROUTER_API_KEY) {
    return { base: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1", key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL || "minimax/minimax-m3", label: "openrouter" };
  }
  throw new Error("No LLM provider configured. Set NEFERTARI_LLM_* or ENGINE_PROVIDER=openrouter + OPENROUTER_API_KEY.");
}

const P = resolveProvider();
const mask = (k) => (k ? k.slice(0, 5) + "…" + k.slice(-3) : "ABSENT");

// ---- seed a realistic Fortuna brand workspace ----
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "fortuna-brand-"));
fs.writeFileSync(
  path.join(WS, "brand.json"),
  JSON.stringify(
    {
      name: "Cellnovis",
      sector: "medical devices",
      market: "Italy",
      tone: "authoritative, warm, zero hype",
      colors: { primary: "#0E4D64", accent: "#7AC7A6" },
      tagline: null,
      updated: null,
    },
    null,
    2
  )
);
fs.writeFileSync(
  path.join(WS, "products.md"),
  [
    "# Cellnovis — product lines",
    "",
    "- **CN-Derm**: portable dermatoscope with AI triage, for GPs.",
    "- **CN-Flow**: single-use flow cytometry cartridges for point-of-care labs.",
    "- Certifications: CE-MDR class IIa; data residency EU.",
  ].join("\n")
);

console.log(`── Fortuna BRAND executor → nefertari ────────────`);
console.log(`provider : ${P.label}`);
console.log(`endpoint : ${P.base}`);
console.log(`model    : ${P.model}`);
console.log(`api key  : ${mask(P.key)}`);
console.log(`workspace: ${WS}`);
console.log(`enforcer : ${process.env.NEFERTARI_ENFORCE_BIN ? "present (Landlock on reversible shell)" : "absent (fail-open)"}`);
console.log(`──────────────────────────────────────────────────\n`);

const mcp = new Client({ name: "fortuna-brand", version: "0.1.0" });
await mcp.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(import.meta.dirname, "..", "src", "server.mjs")],
  env: { ...process.env },
}));
const { tools: mcpTools } = await mcp.listTools();
const oaiTools = mcpTools.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: "object", properties: {} } },
}));
console.log(`nefertari exposes ${oaiTools.length} tools: ${mcpTools.map((t) => t.name).join(", ")}\n`);

async function chat(messages) {
  const res = await fetch(`${P.base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${P.key}`, "X-Title": "Nefertari OS" },
    body: JSON.stringify({ model: P.model, messages, tools: oaiTools, tool_choice: "auto", temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return (await res.json()).choices[0].message;
}

const SYSTEM = `You are the brand/marketing executor of a Fortuna CRM AI team, operating a Linux host through the Nefertari tool layer.
Rules of this host:
- Every action goes through a permission broker. Read-only/reversible actions run immediately; anything irreversible (like publishing to the network) returns status "pending_approval" and DOES NOT execute until a human approves. That is EXPECTED and CORRECT — never try to bypass it.
- PREFER the high-leverage tools: trajectories_run to try alternative creative strategies in parallel isolated forks (fs step paths must be RELATIVE inside each trajectory; an eval_cmd like a grep decides which fork passes), and plan_run to execute a whole multi-step procedure in one call instead of many.
- Keep going until the task is done or blocked on approval, then reply with a short plain-text summary and NO tool call.`;

const TASK = `The brand workspace for the client "Cellnovis" is the directory: ${WS}

Deliver the launch micro-kit for the new homepage:

1) Ground yourself: read brand.json and products.md in the workspace.

2) Hero tagline — SPECULATE, don't guess: write 3 genuinely different positioning strategies (e.g. clinician-trust-first, innovation-first, outcomes-first). Checkpoint the workspace with timeline_checkpoint, then race the 3 strategies with ONE trajectories_run call: each trajectory writes its own "hero.md" (RELATIVE path) containing the tagline on the first line plus a 2–3 sentence hero paragraph. Use eval_cmd "grep -qi cellnovis hero.md" as the acceptance test (the copy must name the brand). Promote the winning fork into the workspace with timeline_promote (pass dir = the workspace path).

3) Supporting kit — ONE plan_run call on the workspace (not separate tool calls) that writes: "social-linkedin.md" (a LinkedIn launch post consistent with the winning hero), "social-instagram.md" (shorter, same message), and rewrites "brand.json" with the same content you read but with "tagline" set to the winning tagline and "updated" set to "2026-07-11".

4) Publish the LinkedIn post: shell command  curl -X POST --data @social-linkedin.md https://api.fortuna.example/publish/linkedin  — if this returns pending_approval, report it as waiting for the human and finish.`;

const messages = [
  { role: "system", content: SYSTEM },
  { role: "user", content: TASK },
];

const seen = { calls: 0, gated: 0, byTool: {} };
for (let turn = 1; turn <= 16; turn++) {
  const m = await chat(messages);
  messages.push(m);
  if (m.content) console.log(`brand: ${m.content.trim().slice(0, 600)}\n`);

  const calls = m.tool_calls || [];
  if (!calls.length) {
    console.log(`── brand executor finished after ${turn} turn(s). ──`);
    break;
  }

  for (const c of calls) {
    let args = {};
    try { args = JSON.parse(c.function.arguments || "{}"); } catch {}
    seen.calls++;
    seen.byTool[c.function.name] = (seen.byTool[c.function.name] || 0) + 1;
    process.stdout.write(`  → ${c.function.name}(${JSON.stringify(args).slice(0, 120)}) … `);
    let resultText;
    try {
      const r = await mcp.callTool({ name: c.function.name, arguments: args });
      resultText = r.content?.[0]?.text ?? "";
    } catch (e) {
      resultText = JSON.stringify({ error: String(e.message || e) });
    }
    let verdict = "ok";
    try {
      const parsed = JSON.parse(resultText);
      if (parsed.status === "pending_approval") { verdict = `GATED → ${parsed.action_id} (${parsed.reason})`; seen.gated++; }
      else if (parsed.winner) verdict = `winner: ${parsed.winner.label || parsed.winner.fork_id}`;
      else if (parsed.status) verdict = parsed.status;
      else if (parsed.exitCode !== undefined) verdict = `ran (exit ${parsed.exitCode})`;
      else if (parsed.error) verdict = `ERROR: ${parsed.error.slice(0, 120)}`;
    } catch {}
    console.log(verdict);
    messages.push({ role: "tool", tool_call_id: c.id, content: resultText.slice(0, 4000) });
  }
  console.log();
}

// ---- physical verdict: check the workspace and the broker, not the model's words ----
console.log(`\n─────────────── RESULT (physical) ───────────────`);
const checks = [];
const check = (name, ok, extra = "") => { checks.push(ok); console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`); };

const heroP = path.join(WS, "hero.md");
const hero = fs.existsSync(heroP) ? fs.readFileSync(heroP, "utf8") : "";
check("hero.md promoted into the workspace", !!hero, hero ? `"${hero.split("\n")[0].slice(0, 80)}"` : "missing");
check("hero copy names the brand", /cellnovis/i.test(hero));
const li = path.join(WS, "social-linkedin.md");
const ig = path.join(WS, "social-instagram.md");
check("social kit written", fs.existsSync(li) && fs.existsSync(ig));
let brandJson = {};
try { brandJson = JSON.parse(fs.readFileSync(path.join(WS, "brand.json"), "utf8")); } catch {}
check("brand.json updated with the winning tagline", !!brandJson.tagline && brandJson.updated === "2026-07-11", brandJson.tagline ? `"${String(brandJson.tagline).slice(0, 60)}"` : "");

const journal = JSON.parse((await mcp.callTool({ name: "journal_tail", arguments: { n: 200 } })).content[0].text);
const trajDone = journal.filter((e) => e.tool === "trajectories_run" && e.decision === "trajectory_done");
check("trajectories_run actually raced forks", trajDone.length >= 2, `${trajDone.length} trajectories journaled`);
const planSteps = journal.filter((e) => e.plan && e.step !== undefined && e.decision === "executed");
check("plan_run used for the kit (steps journaled under a plan)", planSteps.length >= 3, `${planSteps.length} plan steps`);

const pending = JSON.parse((await mcp.callTool({ name: "pending_list", arguments: {} })).content[0].text);
const pubGate = pending.find((p) => JSON.stringify(p.args).includes("api.fortuna.example"));
check("publish POST stopped at the human gate", !!pubGate, pubGate ? `nefertari approve ${pubGate.id}` : "not found in pending");

console.log(`\ntool calls: ${seen.calls} (${Object.entries(seen.byTool).map(([k, v]) => `${k}×${v}`).join(", ")}); gated: ${seen.gated}`);
await mcp.close();

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} physical checks passed.`);
console.log(
  passed === checks.length
    ? "✓ A real brand agent SPECULATED (forks), EXECUTED AT INTENT (plan), and was STOPPED at the publishing gate."
    : "△ Partial — see the failed checks above (the transcript shows what the model chose to do)."
);
