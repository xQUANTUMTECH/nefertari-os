// Metering the part of the window the daemon itself fills.
//
// Most token-budget designs depend entirely on the client reporting its own
// usage, which makes the budget a suggestion. One component the daemon owns
// outright: THE BYTES IT HANDS BACK, counted at the point they leave and after
// the pager has had its say.
//
// The carried figure is window PRESSURE, not an invoice — prompt caching makes
// re-sending a prefix cheap, while nothing makes the window bigger. It is the
// number that says how soon a compaction will take something.
//
//   - bytes issued are metered without anyone's cooperation
//   - and their CARRY cost is the number that matters: issued once, paid per turn
//   - a client that reports nothing still has a meter running, and says so
//   - a client that does report is recorded ALONGSIDE, never instead
//   - running out stops new work and still allows winding down
//   - and there is no tool an agent can use to raise its own limit
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawn } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-bud-"));
process.env.NEFERTARI_HOME = home;

const budget = await import("../src/budget.mjs");

// --- what the daemon knows without being told ---
{
  budget.reset();
  budget.charge("fs_read", 4000);
  const s = budget.status();
  assert.equal(s.observed.calls, 1);
  assert.equal(s.observed.context_bytes, 4000);
  assert.equal(s.observed.est_tokens_issued, 1000, "4 bytes to a token, and labelled an estimate everywhere");
  assert.match(s.metering, /no client-reported usage/, "a run nobody reported must not read as a run that cost nothing");
  console.log("  ok — bytes handed back are metered with nobody's cooperation");
}

// --- and the number nobody counts: the same bytes, paid again every turn ---
{
  budget.reset();
  // One big read, then nine ordinary turns. The big result does not cost 50k
  // tokens; it costs 50k tokens ten times, because it is still in the window.
  budget.charge("fs_read", 200 * 1024);
  for (let i = 0; i < 9; i++) budget.charge("shell", 100);

  const s = budget.status();
  assert.ok(s.observed.carry_multiple > 5, `issued once, paid many times (${s.observed.carry_multiple}×)`);
  assert.ok(
    s.observed.est_tokens_carried > s.observed.est_tokens_issued * 5,
    `the carried cost must dominate: issued ~${s.observed.est_tokens_issued}, carried ~${s.observed.est_tokens_carried}`
  );
  console.log(
    `  ok — a 200KB result costs ~${s.observed.est_tokens_issued} tokens once and ~${s.observed.est_tokens_carried} ` +
      `across ten turns (${s.observed.carry_multiple}×)`
  );
}

// --- a client that does report is recorded next to the measurement, not over it ---
{
  budget.reset();
  budget.charge("fs_read", 40000);
  const s = budget.report({ input_tokens: 12000, output_tokens: 800, usd: 0.04, model: "some-model" });
  assert.equal(s.reported.input_tokens, 12000);
  assert.ok(s.observed.est_tokens_issued > 0, "the daemon's own figure is still there to compare against");
  assert.match(s.metering, /cross-checked/, "…which is the point of keeping both");
  console.log("  ok — reported usage is recorded alongside the measured figure, never in place of it");
}

// --- limits ---
{
  budget.reset({ calls: 3 });
  assert.equal(budget.allowed("shell"), true);
  budget.charge("shell", 10);
  budget.charge("shell", 10);
  assert.equal(budget.exceeded(), null, "two of three is not three");
  budget.charge("shell", 10);
  assert.deepEqual(budget.exceeded(), ["calls"], "and the limit that went is named");
  console.log("  ok — a limit is reached exactly when it is reached, and says which one");
}

// --- out of budget stops new work and still allows winding down ---
{
  budget.reset({ calls: 1 });
  budget.charge("shell", 10);
  assert.equal(budget.allowed("shell"), false, "new work stops");
  assert.equal(budget.allowed("fs_write"), false);
  for (const t of ["budget_status", "journal_tail", "lease_release", "lease_list", "working_set"]) {
    assert.equal(budget.allowed(t), true, `${t} must stay available: an agent that can call nothing cannot wind down`);
  }
  console.log("  ok — out of budget: new work refused, explaining and giving back still allowed");
}

// --- END TO END, and the part that decides whether any of it means anything ---
{
  const { ReadBuffer, serializeMessage } = await import("@modelcontextprotocol/sdk/shared/stdio.js");
  const srvHome = fs.mkdtempSync(path.join(os.tmpdir(), "nef-bud-h-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nef-bud-ws-"));

  const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "server.mjs")], {
    env: {
      ...process.env,
      NEFERTARI_HOME: srvHome,
      NEFERTARI_LOCAL_DRIVER: "null",
      // Set by whoever is paying, in the environment. There is no tool for this.
      NEFERTARI_BUDGET_CALLS: "6",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const buf = new ReadBuffer();
  const want = new Map();
  let id = 1;
  child.stdout.on("data", (c) => {
    buf.append(c);
    for (;;) {
      let m;
      try {
        m = buf.readMessage();
      } catch {
        break;
      }
      if (!m) break;
      const f = want.get(m.id);
      if (f) {
        want.delete(m.id);
        f(m);
      }
    }
  });
  const call = (method, params) =>
    new Promise((res) => {
      const i = id++;
      want.set(i, res);
      child.stdin.write(serializeMessage({ jsonrpc: "2.0", id: i, method, params }));
    });
  const tool = async (name, args) => {
    const r = await call("tools/call", { name, arguments: args });
    const t = r.result?.content?.[0]?.text ?? "";
    try {
      return JSON.parse(t);
    } catch {
      return { raw: t };
    }
  };

  try {
    const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.ok(init.result, "sanity: the daemon is up");

    // No tool may exist for raising a limit. This is the whole security stance:
    // a spending cap an agent can edit is not a cap.
    const names = (await call("tools/list", {})).result.tools.map((t) => t.name);
    assert.ok(names.includes("budget_status") && names.includes("budget_report"), "reading and reporting are offered");
    assert.ok(
      !names.some((n) => /budget_(set|raise|extend|increase|limit)/.test(n)),
      `nothing may let the agent raise its own budget, and these exist: ${names.join(", ")}`
    );
    console.log("  ok — the agent can read and report a budget, and has no tool to raise it");

    // A real read, so the meter measures a real result rather than a fixture —
    // and one large enough that the pager takes it before the meter sees it.
    // That composition is the point: the meter records what REACHED the agent,
    // which is the number that decides how many turns are left before the
    // window fills, not the number that would flatter a report.
    const bigFile = path.join(ws, "big.json");
    fs.writeFileSync(bigFile, JSON.stringify({ rows: Array.from({ length: 4000 }, (_, i) => ({ i, v: `row ${i}` })) }));
    const onDisk = fs.statSync(bigFile).size;
    const read = await tool("fs_read", { path: bigFile });
    assert.equal(read.__paged, true, "sanity: a file this size is paged rather than delivered");

    const s = await tool("budget_status", {});
    assert.ok(
      s.observed.context_bytes < onDisk / 10,
      `the meter must record what reached the agent (${s.observed.context_bytes}), not what was on disk (${onDisk})`
    );
    assert.equal(s.remaining.calls, 6 - s.observed.calls, "and the remaining calls follow the calls actually served");
    console.log(
      `  ok — end to end: a ${Math.round(onDisk / 1024)}KB read reached the window as ` +
        `${s.observed.context_bytes} bytes, and that is what the meter counts`
    );

    // Spend the rest of the allowance on ordinary work.
    for (let i = 0; i < 6; i++) await tool("shell", { command: "true" });

    const blocked = await tool("shell", { command: "echo more work" });
    assert.equal(blocked.status, "budget_exhausted", `new work must stop: ${JSON.stringify(blocked).slice(0, 200)}`);
    assert.deepEqual(blocked.exhausted, ["calls"]);
    assert.ok(blocked.still_available.includes("lease_release"), "and the answer names what can still be done");
    assert.match(blocked.advice, /Only a human can raise the limit/, "…and who can lift it, which is not the agent");
    console.log("  ok — out of allowance, new work is refused with what was spent and what is still possible");

    // The wind-down path is not decoration: it has to actually work.
    const still = await tool("budget_status", {});
    assert.ok(still.observed.calls > 0, "an exhausted agent can still see what it spent");
    const released = await tool("lease_release", { uri: "push:example.com/none" });
    assert.equal(released.ok, true, "and can still give back what it was holding");
    console.log("  ok — and winding down really works: it can explain itself and release its leases");

    const j = fs
      .readFileSync(path.join(srvHome, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(
      j.some((e) => e.decision === "budget_exhausted"),
      "hitting the limit is journalled: an agent that stopped early must be explainable afterwards"
    );
    console.log("  ok — running out is on the record, so an agent that stopped early can be explained");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(srvHome, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

fs.rmSync(home, { recursive: true, force: true });
console.log("BUDGET TESTS PASSED");
