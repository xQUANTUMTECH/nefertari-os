// The same two workloads on whole agent harnesses, for a like-for-like number
// against Nefertari.
//
// dsh has its own runner (bench-dsh.mjs) because its metrics live in a
// compressed append-only session log. These two hand them back on stdout, which
// makes them cheap to measure and expensive to argue with: turns, tokens and
// the vendor's own cost figure come from the harness itself.
//
//   node examples/bench-harness.mjs grok
//   BENCH_RUNS=3 node examples/bench-harness.mjs claude grok
//
// WHAT THIS COMPARISON IS. Two whole stacks on one task, not two
// implementations of the same thing. A harness carries a system prompt, a tool
// catalogue, context management and its own reasoning budget, and pays for all
// of it on every task; Nefertari is a system layer under a bare loop and
// carries none of it. Someone deciding what to run cares about the end-to-end
// number, which is why it is measured — but reading it as "our agent beats
// their agent" reads it wrong.
//
// Both are subscription products, so `total_cost_usd` is what the vendor says
// the tokens would have cost rather than what this run was billed. It is
// reported because it is the only cost figure either of them offers, and
// labelled because it is not an invoice.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileSpec, candSpec, ACCEPTANCE, verifyFiles, verifyTagline } from "./bench-workloads.mjs";

const N = Math.max(1, Number(process.env.BENCH_RUNS) || 1);

const HARNESSES = {
  claude: {
    bin: process.env.CLAUDE_BIN || "claude",
    argv: (prompt) => ["-p", prompt, "--output-format", "json", "--permission-mode", "bypassPermissions"],
  },
  grok: {
    bin: process.env.GROK_BIN || path.join(os.homedir(), ".grok", "bin", "grok"),
    argv: (prompt) => ["-p", prompt, "--output-format", "json", "--yolo"],
  },
};

// Both print one JSON object, but a harness is free to put a banner or a
// warning around it. Take the outermost object rather than assuming the whole
// of stdout parses — a benchmark that dies on a deprecation notice is a
// benchmark nobody runs twice.
function parseReport(stdout) {
  const s = stdout.indexOf("{");
  const e = stdout.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try {
    return JSON.parse(stdout.slice(s, e + 1));
  } catch {
    return null;
  }
}

function statsFrom(report) {
  if (!report) return { turns: null, totalTok: null, costUsd: null };
  const u = report.usage || {};
  const totalTok =
    u.total_tokens ??
    (u.input_tokens ?? 0) +
      (u.output_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
  return {
    turns: report.num_turns ?? null,
    totalTok: totalTok || null,
    // Reported for context, never as an invoice: these are subscription
    // products and this is the vendor's list price for the tokens.
    costUsd: report.total_cost_usd ?? null,
  };
}

const RUNS = [
  {
    bench: "A-files",
    verify: verifyFiles,
    task: () =>
      `In the current directory create these 6 files. Content must match EXACTLY (no extra whitespace). Do not verify afterwards; finish as soon as the last file is written.\n${fileSpec}`,
  },
  {
    bench: "B-tagline",
    verify: verifyTagline,
    task: () =>
      `In the current directory, find which of these 3 candidate taglines passes the acceptance test. Write a candidate into hero.md, then run "${ACCEPTANCE}" (exit 0 = pass). If it fails, overwrite hero.md with the next candidate and test again. Stop as soon as one passes and report which.\nCandidates:\n${candSpec}`,
  },
];

function runHarness(h, ws, prompt) {
  return new Promise((resolve) => {
    execFile(
      h.bin,
      h.argv(prompt),
      { cwd: ws, timeout: 600000, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return Math.round((a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) * 1000) / 1000;
};
const spread = (xs) => (xs.length ? `${Math.min(...xs)}–${Math.max(...xs)}` : "–");

const names = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!names.length) {
  console.error(`usage: node examples/bench-harness.mjs <${Object.keys(HARNESSES).join("|")}>...`);
  process.exit(2);
}

const results = [];
const cells = [];

for (const name of names) {
  const h = HARNESSES[name];
  if (!h) {
    console.error(`unknown harness ${name}`);
    process.exit(2);
  }
  console.log(`\n=== ${name} (${h.bin}) — ${N} run(s) per cell ===\n`);

  for (const run of RUNS) {
    const got = [];
    for (let i = 1; i <= N; i++) {
      process.stdout.write(`▶ ${run.bench} / ${name}${N > 1 ? ` [${i}/${N}]` : ""} … `);
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${name}-${run.bench}-`));
      const t0 = process.hrtime.bigint();
      const { err, stdout, stderr } = await runHarness(h, ws, run.task());
      const wallS = Math.round(Number(process.hrtime.bigint() - t0) / 1e8) / 10;
      // Read from the filesystem, never from the harness's account of itself.
      const success = run.verify(ws);
      const st = statsFrom(parseReport(stdout));

      const r = { harness: name, bench: run.bench, run: i, success, wallS, ...st };
      if (!success && err) r.error = String(err.message).slice(0, 160) || stderr.slice(0, 160);
      results.push(r);
      got.push(r);
      console.log(
        `${success ? "OK" : "FAIL"}  turns=${st.turns ?? "?"} tok=${st.totalTok ?? "?"} ` +
          `cost=$${st.costUsd?.toFixed(3) ?? "?"} wall=${wallS}s`
      );
      fs.rmSync(ws, { recursive: true, force: true });
    }

    // Only successful runs shape the medians: a failed run has no meaningful
    // turn count, and averaging it in would quietly reward giving up early.
    const ok = got.filter((r) => r.success);
    cells.push({
      harness: name,
      bench: run.bench,
      runs: N,
      successes: ok.length,
      turns_median: median(ok.map((r) => r.turns).filter((x) => x != null)),
      turns_range: spread(ok.map((r) => r.turns).filter((x) => x != null)),
      tokens_median: median(ok.map((r) => r.totalTok).filter((x) => x != null)),
      cost_usd_median: median(ok.map((r) => r.costUsd).filter((x) => x != null)),
      wall_s_median: median(ok.map((r) => r.wallS)),
      wall_s_range: spread(ok.map((r) => r.wallS)),
    });
  }
}

const OUT = process.env.BENCH_OUT || path.join(import.meta.dirname, "bench-harness-results.json");
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
fs.writeFileSync(OUT, JSON.stringify([...prev, ...results], null, 2));

const SUM = process.env.BENCH_SUMMARY || path.join(import.meta.dirname, "bench-harness-summary.json");
const prevSum = fs.existsSync(SUM) ? JSON.parse(fs.readFileSync(SUM, "utf8")) : [];
fs.writeFileSync(SUM, JSON.stringify([...prevSum, ...cells], null, 2));

console.log(`\nmedian of ${N} run(s) per cell`);
for (const c of cells) {
  console.log(
    `  ${`${c.bench}/${c.harness}`.padEnd(22)} ${c.successes}/${c.runs} ok   turns ${c.turns_median} (${c.turns_range})   ` +
      `tok ${c.tokens_median}   ~$${c.cost_usd_median}   wall ${c.wall_s_median}s (${c.wall_s_range})`
  );
}
console.log(`\nraw -> ${OUT}\nsummary -> ${SUM}`);
