// The inference window — the machine's idle time between one tool call
// returning and the next one arriving.
//
// For a human caller that gap is noise: unpredictable, usually short, and
// nobody's to schedule. For an agent caller it is the opposite of noise. It is
// the model thinking, it happens after EVERY action, it lasts seconds, and
// agentd is the only process on the host that knows both edges of it — the tool
// call it just answered and the one it is about to receive.
//
// That makes idle a RESOURCE rather than a symptom: work that must eventually
// happen (checkpointing the tree, materialising the K forks of a trajectory,
// warming the working set) can be moved into a window where it costs nothing,
// so the next tool call finds it already done. Nothing in this file does that
// work yet. This measures the window first, because a speed-up nobody sized is
// a guess, and because the size of the window is itself the finding: an agent
// host is idle for most of a run, and no scheduler on it knows.
//
// Overhead is two Date.now() calls per tool. Deliberately no histogram, no
// sampling, no ring buffer: the journal already stores every gap, so anything
// richer can be computed from it afterwards rather than kept here.

let lastExitAt = null; // when the previous tool call finished
let enteredAt = null; // when the current one started
let pendingIdleMs = 0; // gap measured by enter(), consumed by exit()

// snake_case throughout, matching the fields written to the journal: one name
// per thing, so a share read from sys_status and a gap read from the journal are
// obviously the same measurement.
const totals = { calls: 0, idle_ms: 0, busy_ms: 0, max_idle_ms: 0, since: new Date().toISOString() };

/**
 * A tool call has arrived: the idle window just closed. Returns its length in
 * ms — 0 for the first call of the process, where there is no previous exit to
 * measure from and a wall-clock-since-boot figure would be a lie.
 */
export function enter() {
  enteredAt = Date.now();
  pendingIdleMs = lastExitAt === null ? 0 : enteredAt - lastExitAt;
  return pendingIdleMs;
}

/**
 * The tool call is done: the next idle window opens now. Returns
 * { idle_ms, busy_ms } for the call that just ended, for the journal.
 *
 * Safe to call without a matching enter() — a caller that gates before
 * measuring still needs the clock to move on rather than attribute the whole
 * gap to whatever runs next.
 */
export function exit() {
  const now = Date.now();
  const busyMs = enteredAt === null ? 0 : now - enteredAt;
  const idleMs = pendingIdleMs;

  lastExitAt = now;
  enteredAt = null;
  pendingIdleMs = 0;

  totals.calls += 1;
  totals.idle_ms += idleMs;
  totals.busy_ms += busyMs;
  if (idleMs > totals.max_idle_ms) totals.max_idle_ms = idleMs;

  return { idle_ms: idleMs, busy_ms: busyMs };
}

/**
 * How much of this process's life has been spent waiting for the next
 * instruction. `idle_share` is the headline: on an agent host it is the
 * fraction of the run during which the machine had nothing to do and every
 * scheduler on it believed the same.
 *
 * Measured between the first and last tool call, so start-up and shutdown do
 * not inflate it.
 */
export function stats() {
  // A window exists BETWEEN two calls, so N calls give N-1 of them. Reporting
  // this matters more than it looks: a run with a single tool call has no
  // window to observe, and a share of 0 there would read as "the machine was
  // busy" when it means "nothing was measurable". That case is not a corner —
  // it is exactly what plan_run produces when it collapses six round-trips into
  // one, which is the whole point of it.
  const windows = Math.max(0, totals.calls - 1);
  const span = totals.idle_ms + totals.busy_ms;
  return {
    ...totals,
    windows,
    idle_share: windows > 0 && span > 0 ? Math.round((totals.idle_ms / span) * 1000) / 1000 : null,
    mean_idle_ms: windows > 0 ? Math.round(totals.idle_ms / windows) : null,
    // Said in words, because a null in a JSON blob gets read as zero by whoever
    // is in a hurry.
    note: windows === 0 ? "single tool call: no inter-call window exists to measure" : undefined,
  };
}

/** Test seam: forget everything measured so far. */
export function reset() {
  lastExitAt = null;
  enteredAt = null;
  pendingIdleMs = 0;
  Object.assign(totals, { calls: 0, idle_ms: 0, busy_ms: 0, max_idle_ms: 0, since: new Date().toISOString() });
}
