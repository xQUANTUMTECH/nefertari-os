// The same two workloads, run on DeepSeek Harness (dsh), for a like-for-like
// number against Nefertari.
//
// Why this file exists: claiming to beat a harness you have never run is a claim
// anyone can check in ten minutes, and dsh is public. So it gets run — same
// model, same tasks, same physical verdict on disk, and its metrics read out of
// its OWN append-only session log rather than estimated.
//
// What the comparison is, and is not. dsh is a full agent harness: it carries a
// system prompt, a tool catalogue, context management and a title-generation
// call, and it pays for all of that on every task. Nefertari is a system layer
// under a bare loop. So this measures TWO STACKS end to end on one task, not two
// implementations of the same thing — the honest framing, and still the number
// that matters to somebody deciding what to run.
//
// dsh has no trajectories primitive, so on the tagline race it can only go one
// candidate at a time. That IS the finding, not a handicap imposed on it.
//
//   ATLASCLOUD_API_KEY=... node examples/bench-dsh.mjs [A|B]
//   BENCH_RUNS=5 node examples/bench-dsh.mjs
//
// Requires a dsh checkout, built. Point DSH_BIN at apps/cli/lib/bin.js.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { fileSpec, candSpec, ACCEPTANCE, verifyFiles, verifyTagline } from "./bench-workloads.mjs";

const DSH_BIN =
  process.env.DSH_BIN || path.join(os.homedir(), "Desktop", "dev", "deepseek-harness", "apps", "cli", "lib", "bin.js");
const MODEL = process.env.NEFERTARI_LLM_MODEL || "deepseek-ai/deepseek-v4-flash";
const N = Math.max(1, Number(process.env.BENCH_RUNS) || 1);
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");

if (!fs.existsSync(DSH_BIN)) throw new Error(`dsh not found at ${DSH_BIN} — set DSH_BIN (build it with: pnpm run build)`);

// dsh names a session directory after the cwd, mangling separators. Rather than
// reimplement that mangling — which would break the day it changes — take the
// session directory that appeared after this run started.
function newestSessionAfter(tStart) {
  const root = path.join(DSH_HOME, "sessions");
  let best = null;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".zstd")) {
        const st = fs.statSync(p);
        if (st.mtimeMs >= tStart && (!best || st.mtimeMs > best.mtimeMs)) best = { path: p, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(root);
  return best?.path || null;
}

// The log is append-only: one zstd FRAME per event, concatenated. Both the
// sync helper and the stream stop after the first frame, so the frames are cut
// apart on the magic number and decoded one by one.
function readSessionEvents(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  let text = "";
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString("utf8");
    } catch {
      /* a partially written trailing frame is not worth failing the run over */
    }
  }
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function statsFrom(events) {
  let turns = 0;
  let toolCalls = 0;
  let promptTok = 0;
  let complTok = 0;
  for (const e of events) {
    if (e.type === "step/start") turns++;
    else if (e.type === "tool/call") toolCalls++;
    else if (e.type === "assistant/message" && e.data?.usage) {
      promptTok += e.data.usage.inputTokens || 0;
      complTok += e.data.usage.outputTokens || 0;
    }
  }
  return { turns, toolCalls, promptTok, complTok, totalTok: promptTok + complTok };
}

const RUNS = [
  {
    bench: "A-files",
    mode: "dsh",
    verify: verifyFiles,
    task: () =>
      `In the current directory create these 6 files. Content must match EXACTLY (no extra whitespace). Do not verify afterwards; finish as soon as the last file is written.\n${fileSpec}`,
  },
  {
    bench: "B-tagline",
    mode: "dsh",
    verify: verifyTagline,
    task: () =>
      `In the current directory, find which of these 3 candidate taglines passes the acceptance test. Write a candidate into hero.md, then run "${ACCEPTANCE}" (exit 0 = pass). If it fails, overwrite hero.md with the next candidate and test again. Stop as soon as one passes and report which.\nCandidates:\n${candSpec}`,
  },
];

function runDsh(ws, prompt) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [DSH_BIN, "--profile", "headless", prompt],
      { cwd: ws, timeout: 300000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env } },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return Math.round((a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) * 10) / 10;
};
const spread = (xs) => (xs.length ? `${Math.min(...xs)}–${Math.max(...xs)}` : "–");

const filter = process.argv[2] || "";
const results = [];
const cells = [];

console.log(`dsh bench — model ${MODEL}, ${N} run(s) per cell\nbinary: ${DSH_BIN}\n`);

for (const run of RUNS.filter((r) => !filter || r.bench.startsWith(filter))) {
  const got = [];
  for (let i = 1; i <= N; i++) {
    process.stdout.write(`▶ ${run.bench} / dsh${N > 1 ? ` [${i}/${N}]` : ""} … `);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-bench-${run.bench}-`));
    const tStart = Date.now();
    const t0 = process.hrtime.bigint();
    const { err, stderr } = await runDsh(ws, run.task());
    const wallS = Math.round(Number(process.hrtime.bigint() - t0) / 1e8) / 10;
    const success = run.verify(ws);

    let stats = { turns: null, toolCalls: null, totalTok: null };
    const log = newestSessionAfter(tStart - 2000);
    if (log) {
      try {
        stats = statsFrom(readSessionEvents(log));
      } catch {
        /* unreadable log: wall-clock and the physical verdict still stand */
      }
    }

    const r = { harness: "dsh", model: MODEL, bench: run.bench, mode: "dsh", run: i, success, wallS, ...stats };
    if (err && !success) r.error = String(err.message).slice(0, 200) || stderr.slice(0, 200);
    results.push(r);
    got.push(r);
    console.log(
      `${success ? "OK" : "FAIL"}  turns=${stats.turns ?? "?"} calls=${stats.toolCalls ?? "?"} tok=${stats.totalTok ?? "?"} wall=${wallS}s`
    );
    fs.rmSync(ws, { recursive: true, force: true });
  }

  const ok = got.filter((r) => r.success);
  cells.push({
    harness: "dsh",
    model: MODEL,
    bench: run.bench,
    mode: "dsh",
    runs: N,
    successes: ok.length,
    turns_median: median(ok.map((r) => r.turns).filter((x) => x != null)),
    turns_range: spread(ok.map((r) => r.turns).filter((x) => x != null)),
    tool_calls_median: median(ok.map((r) => r.toolCalls).filter((x) => x != null)),
    tokens_median: median(ok.map((r) => r.totalTok).filter((x) => x != null)),
    tokens_range: spread(ok.map((r) => r.totalTok).filter((x) => x != null)),
    wall_s_median: median(ok.map((r) => r.wallS)),
    wall_s_range: spread(ok.map((r) => r.wallS)),
  });
}

const OUT = process.env.BENCH_OUT || path.join(import.meta.dirname, "bench-results.json");
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
fs.writeFileSync(OUT, JSON.stringify([...prev, ...results], null, 2));

const SUM = process.env.BENCH_SUMMARY || path.join(import.meta.dirname, "bench-summary.json");
const prevSum = fs.existsSync(SUM) ? JSON.parse(fs.readFileSync(SUM, "utf8")) : [];
fs.writeFileSync(SUM, JSON.stringify([...prevSum, ...cells], null, 2));

console.log(`\ndsh — median of ${N} run(s) per cell`);
for (const c of cells) {
  console.log(
    `  ${`${c.bench}/dsh`.padEnd(20)} ${c.successes}/${c.runs} ok   turns ${c.turns_median} (${c.turns_range})   ` +
      `tok ${c.tokens_median} (${c.tokens_range})   wall ${c.wall_s_median}s (${c.wall_s_range})`
  );
}
console.log(`\nraw -> ${OUT}\nsummary -> ${SUM}`);
