// The inference window: the machine's idle time between one tool call
// returning and the next arriving.
//   - the first call has no window before it, and must not invent one
//   - the gap between calls is measured, the work inside them is not
//   - the share is computed between first and last call, so start-up does not
//     inflate it
//   - a gated call still closes its window, or the whole gap lands on whatever
//     runs next
import assert from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";
import * as idle from "../src/idle.mjs";

idle.reset();

// --- the first call cannot have been preceded by idle we witnessed ---
{
  const gap = idle.enter();
  assert.equal(gap, 0, "the first call reports no window: wall-clock since boot would be a lie");
  const r = idle.exit();
  assert.equal(r.idle_ms, 0);
  assert.ok(r.busy_ms >= 0);
  console.log("  ok — the first call reports no window rather than inventing one");
}

// --- the gap between calls is the window ---
{
  await sleep(120); // the model "thinking"
  const gap = idle.enter();
  assert.ok(gap >= 100, `the window must be measured, got ${gap}ms`);
  await sleep(40); // the tool working
  const r = idle.exit();
  assert.ok(r.idle_ms >= 100, "idle is the gap BEFORE the call");
  assert.ok(r.busy_ms >= 30 && r.busy_ms < 100, `busy is the work INSIDE it, got ${r.busy_ms}ms`);
  console.log("  ok — idle is the gap before a call, busy is the work inside it");
}

// --- the share ---
{
  const s = idle.stats();
  assert.equal(s.calls, 2);
  assert.ok(s.idle_ms >= 100);
  assert.ok(s.idle_share > 0 && s.idle_share <= 1, `share must be a fraction, got ${s.idle_share}`);
  assert.ok(s.max_idle_ms >= 100);
  assert.equal(s.windows, 1, "two calls give one window between them");
  assert.equal(s.mean_idle_ms, Math.round(s.idle_ms / s.windows));
  console.log(`  ok — share computed between first and last call (${Math.round(s.idle_share * 100)}% here)`);
}

// --- a call that never runs still closes its window ---
{
  idle.reset();
  idle.enter();
  idle.exit(); // first call, no window
  await sleep(80);
  idle.enter();
  idle.exit(); // as a gate() rejection does, without reaching record()
  await sleep(80);
  idle.enter();
  const r = idle.exit();
  assert.ok(r.idle_ms >= 60 && r.idle_ms < 140, `each window stands alone, got ${r.idle_ms}ms`);
  console.log("  ok — a gated call closes its own window, so the gap is not double-counted");
}

// --- exit without enter must not attribute a whole session to one call ---
{
  idle.reset();
  const r = idle.exit();
  assert.equal(r.busy_ms, 0, "no enter means no measured work, not a session's worth");
  assert.equal(r.idle_ms, 0);
  console.log("  ok — an unmatched exit measures nothing rather than everything");
}

// --- one call: nothing to measure, and it must SAY so ---
{
  idle.reset();
  idle.enter();
  idle.exit();
  const s = idle.stats();
  assert.equal(s.windows, 0, "one call means no window between calls");
  assert.equal(s.idle_share, null, "a share of 0 here would read as 'the machine was busy'");
  assert.match(s.note, /no inter-call window/, "and the reason is spelled out, not left as a null");
  console.log("  ok — a single call reports 'unmeasurable', never 0%");
}

console.log("IDLE TESTS PASSED");
