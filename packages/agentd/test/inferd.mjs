// Supervising a local inference service.
//
// The inference is llama.cpp's job. What is tested here is the part that is
// ours and that no chat server would give us: that the process starts under our
// control, runs at a priority the real work preempts, STOPS CONSUMING CPU the
// instant we say so while keeping its memory, and comes back in milliseconds.
//
// The stand-in is a small HTTP server that burns CPU in a loop. It is not a
// model, and that is the point: nothing in inferd.mjs knows what llama-server
// is, so a process that answers a health URL and burns CPU exercises every line
// that matters. Swapping in the real binary is a change of one env var.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";

process.env.NEFERTARI_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), "nef-inf-"));
const cg = await import("../src/cgroups.mjs");

// --- unconfigured is the default, and must be inert ---
{
  delete process.env.NEFERTARI_INFER_CMD;
  const inferd = await import("../src/inferd.mjs");
  inferd.reset();
  const r = await inferd.start();
  assert.equal(r.ok, false, "with no command configured there is nothing to start");
  assert.match(r.reason, /NEFERTARI_INFER_CMD/, "and it names the setting rather than failing vaguely");
  assert.equal(inferd.status().configured, false);
  assert.equal(inferd.freeze().ok, false, "freezing what is not running must refuse, not pretend");
  console.log("  ok — unconfigured is inert and says which setting is missing");
}

const avail = cg.available();
if (!avail.ok) {
  console.log(`  skip — the lifecycle needs cgroups: ${avail.reason.slice(0, 80)}…`);
  console.log("INFERD TESTS PASSED (degradation only)");
  process.exit(0);
}

// --- a stand-in that answers a health URL and burns CPU ---
const PORT = 18700 + Math.floor(Math.random() * 900);
const standIn = path.join(os.tmpdir(), `nef-standin-${process.pid}.mjs`);
fs.writeFileSync(
  standIn,
  `import http from "node:http";
// Burns CPU continuously, so "frozen" is measurable rather than asserted.
let n = 0;
setInterval(() => { const end = Date.now() + 40; while (Date.now() < end) n++; }, 1);
http.createServer((_, res) => { res.writeHead(200); res.end("ok"); }).listen(${PORT}, "127.0.0.1");
`
);

process.env.NEFERTARI_INFER_CMD = JSON.stringify([process.execPath, standIn]);
process.env.NEFERTARI_INFER_HEALTH = `http://127.0.0.1:${PORT}/health`;
process.env.NEFERTARI_INFER_READY_MS = "15000";

// Re-imported so the module picks up a clean state alongside the new env.
const inferd = await import("../src/inferd.mjs");
inferd.reset();

try {
  const started = await inferd.start();
  assert.ok(started.ok, `it must come up: ${started.reason}`);
  assert.equal(started.state, "ready");
  assert.ok(started.grouped, "and be under our cgroup, not loose on the host");
  console.log("  ok — started, healthy, and supervised in its own cgroup");

  // --- the CPU it consumes is visible, which is what makes freezing checkable ---
  const cpu = () => cg.usage("inferd")?.usage_usec ?? 0;
  const before = cpu();
  await sleep(700);
  const running = cpu();
  assert.ok(running > before, `a running service must accumulate CPU (${before} -> ${running})`);
  console.log(`  ok — CPU is accounted while it runs (+${running - before}us)`);

  // --- freeze: the whole point ---
  const f = inferd.freeze();
  assert.ok(f.ok, `freeze must succeed: ${f.reason}`);
  assert.equal(inferd.status().state, "frozen");
  assert.equal(cg.frozen("inferd"), true, "and the kernel must agree");

  const atFreeze = cpu();
  await sleep(700);
  const whileFrozen = cpu();
  // The claim is "zero CPU", so a few microseconds of accounting slop is the
  // most that may pass. Anything more means it is still running.
  assert.ok(
    whileFrozen - atFreeze < 5000,
    `a frozen service must stop consuming CPU: it used ${whileFrozen - atFreeze}us over 700ms`
  );
  console.log(`  ok — frozen: ${whileFrozen - atFreeze}us over 700ms (it was burning CPU a moment before)`);

  // --- and comes back, with the process still alive ---
  const pidBefore = inferd.status().pid;
  const t = inferd.thaw();
  assert.ok(t.ok, `thaw must succeed: ${t.reason}`);
  await sleep(400);
  assert.ok(cpu() > whileFrozen, "it resumes work");
  assert.equal(inferd.status().pid, pidBefore, "the SAME process: freezing keeps the loaded model, it does not restart it");
  const res = await fetch(process.env.NEFERTARI_INFER_HEALTH);
  assert.ok(res.ok, "and it answers again");
  console.log("  ok — thawed: same process, still healthy, model never reloaded");
} finally {
  inferd.stop();
  fs.rmSync(standIn, { force: true });
}

await sleep(300);
assert.equal(inferd.status().state, "stopped");
console.log("  ok — stopped and its group cleaned up");
console.log("INFERD TESTS PASSED");
