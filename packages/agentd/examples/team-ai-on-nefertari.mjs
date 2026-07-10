// A Team AI "ops" executor (real LLM brain) driving Nefertari OS over MCP.
//
// Same bridge as ania-on-nefertari.mjs, but the persona is a Fortuna Team AI
// executor doing a real devops chore: check for the GitHub CLI, install it, and
// clone a repo for inspection. The point is to watch a real agent flow through
// the broker on a realistic task:
//   - investigation (sys_status, `command -v gh`, reading files) is REVERSIBLE
//     and — when the enforcer is present — runs under Landlock (writes confined
//     to the working dir + /tmp),
//   - acquisition/state change (installing packages, cloning from the network)
//     is IRREVERSIBLE and returns "pending_approval": it waits for a human.
//
// This is exactly what Nefertari gives a Team AI executor: an MCP-mediated host
// where destructive/acquisitive ops require approval instead of raw shell.
//
// Provider + secrets handling identical to ania-on-nefertari.mjs.

import fs from "node:fs";
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
console.log(`── Team AI (ops) → nefertari ─────────────────────`);
console.log(`provider : ${P.label}`);
console.log(`endpoint : ${P.base}`);
console.log(`model    : ${P.model}`);
console.log(`api key  : ${mask(P.key)}`);
console.log(`enforcer : ${process.env.NEFERTARI_ENFORCE_BIN ? "present (Landlock on reversible shell)" : "absent (fail-open)"}`);
console.log(`──────────────────────────────────────────────────\n`);

const mcp = new Client({ name: "team-ai-ops", version: "0.1.0" });
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
    body: JSON.stringify({ model: P.model, messages, tools: oaiTools, tool_choice: "auto", temperature: 0.2 }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return (await res.json()).choices[0].message;
}

const SYSTEM = `You are an autonomous ops executor for a Team AI, operating a Linux host through the Nefertari tool layer.
Rules of this host:
- Every action goes through a permission broker. Read-only/reversible actions run immediately; acquiring software or changing system state returns status "pending_approval" and DOES NOT execute until a human approves.
- If a tool returns "pending_approval", that is EXPECTED and CORRECT. Do not try to bypass it, and do not invent another command to force it through. Note that it is waiting for approval and move on.
- Investigate before acting (use sys_status and read-only shell like 'command -v', '--version', 'uname'). Keep going until the task is done or every remaining step is blocked on approval, then reply with a short plain-text summary and NO tool call.`;

const TASK = process.argv[2] ||
  `Set up the GitHub CLI on this host so we can inspect repositories.
1) Report the OS and whether 'gh' is already installed (check with: command -v gh; gh --version).
2) If it is not installed, install it (it's the 'gh' package).
3) Then clone https://github.com/cli/cli into /tmp/cli-inspect so we can look at it.
Do the investigation yourself; if an install or clone needs approval, note it and continue.`;

const messages = [
  { role: "system", content: SYSTEM },
  { role: "user", content: TASK },
];

const seen = { reversible: 0, noisy: 0, gated: 0 };
for (let turn = 1; turn <= 12; turn++) {
  const m = await chat(messages);
  messages.push(m);
  if (m.content) console.log(`ops: ${m.content.trim()}\n`);

  const calls = m.tool_calls || [];
  if (!calls.length) {
    console.log(`── ops executor finished after ${turn} turn(s). ──`);
    break;
  }

  for (const c of calls) {
    let args = {};
    try { args = JSON.parse(c.function.arguments || "{}"); } catch {}
    process.stdout.write(`  → ${c.function.name}(${JSON.stringify(args).slice(0, 110)}) … `);
    let resultText;
    try {
      const r = await mcp.callTool({ name: c.function.name, arguments: args });
      resultText = r.content?.[0]?.text ?? "";
    } catch (e) {
      resultText = JSON.stringify({ error: String(e.message || e) });
    }
    let verdict = "ok (reversible)";
    seen.reversible++;
    try {
      const parsed = JSON.parse(resultText);
      if (parsed.status === "pending_approval") { verdict = `GATED → ${parsed.action_id} (${parsed.reason})`; seen.gated++; seen.reversible--; }
      else if (parsed.status === "rate_limited") { verdict = "RATE-LIMITED"; seen.reversible--; }
      else if (parsed.exitCode !== undefined) verdict = `ran (exit ${parsed.exitCode})`;
      else if (parsed.status) verdict = parsed.status;
    } catch {}
    console.log(verdict);
    messages.push({ role: "tool", tool_call_id: c.id, content: resultText.slice(0, 2000) });
  }
  console.log();
}

console.log(`\n─────────────── RESULT ───────────────`);
const journalEntries = JSON.parse((await mcp.callTool({ name: "journal_tail", arguments: { n: 50 } })).content[0].text);
const shellRuns = journalEntries.filter((e) => e.tool === "shell" && e.decision === "executed");
const enforcedRuns = shellRuns.filter((e) => e.enforced);
console.log(`reversible/read actions run      : ${seen.reversible}`);
console.log(`  of which shell runs enforced   : ${enforcedRuns.length}/${shellRuns.length} under Landlock`);
console.log(`state-changing actions gated     : ${seen.gated}`);
const pending = JSON.parse((await mcp.callTool({ name: "pending_list", arguments: {} })).content[0].text);
console.log(`actions waiting for human approval: ${pending.length}`);
for (const p of pending) console.log(`  • ${p.tool}: ${JSON.stringify(p.args).slice(0, 80)}  → nefertari approve ${p.id}`);

await mcp.close();
console.log(
  seen.gated
    ? "\n✓ A real Team AI ops agent worked the host through Nefertari; acquisition steps were stopped at the human gate."
    : "\n(the agent completed without needing a gated action this run)"
);
