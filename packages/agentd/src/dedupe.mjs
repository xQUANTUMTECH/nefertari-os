// Idempotence by action hash: the same effect, asked for twice, happens once.
//
// Models re-emit tool calls. A duplicated tool_use block, a retry after a
// timeout the model could not distinguish from a failure, a plan replayed from
// the top after a compaction — all of them arrive here as the identical call,
// and the world gets touched twice. For a write that is harmless; for
// `curl -X POST /charge` it is a second charge.
//
// THE RULE, and the reason it is this one rather than a timer. Suppressing
// every repeat inside a window would break the most common loop there is: edit,
// run the tests, edit, run the same tests. The tell that separates a retry from
// a deliberate repeat is not elapsed time, it is WHAT HAPPENED IN BETWEEN. A
// fix loop always has an edit between two runs of the test command; a duplicated
// tool call has nothing between it and its twin. So an action is suppressed only
// when it is identical to the immediately preceding effectful action — nothing
// else in between — and recent. `npm test` twice with an fs_write between them
// runs twice, as it must.
//
// WHAT COUNTS AS "SOMETHING IN BETWEEN" IS AN EFFECT, NOT A CLASS. `fs_write`
// is classified REVERSIBLE here — it is snapshotted, so `undo` can take it back
// — but it changed the file, and an agent that writes between two runs of a
// command has decided something. Keying this off the reversibility class is the
// bug that made the fix loop suppress its second test run, caught by e2e-hard.
// The question is whether the action CHANGED anything, which is a different
// question, so it has its own answer below.
//
// READS ARE NEVER SUPPRESSED. Re-reading a file is how an agent learns the
// world changed, and returning it a cached answer would make the system lie
// about the present. Only actions that CHANGE something are candidates.
//
// AND SUPPRESSION IS NEVER SILENT. The response says so, names the original,
// and says how to run it anyway. An agent told "already done, this was the
// result" can proceed; an agent whose action vanished cannot tell that from one
// that failed quietly, and will re-probe or hallucinate — which is the tax this
// exists to remove, not to relocate.
//
// The scope is one agent session: the daemon forks a server per connection, so
// this is per-agent by construction, and a restart forgets it. That is the right
// side to fail on. Forgetting a duplicate costs a repeated action; remembering
// one across a restart would suppress an action a human deliberately re-ran.

import { actionHash } from "./approvals.mjs";
import { CLASS } from "./broker.mjs";

// The tools that answer a question without touching anything. Everything else
// is treated as effectful — the same allowlist stance the broker takes, for the
// same reason: a tool nobody classified is one nobody has thought about, and
// the safe assumption about an unclassified action is that it does something.
// A new read-only tool belongs in this set; forgetting it costs a suppressed
// duplicate read, not a lost effect.
const READ_ONLY = new Set([
  "fs_read",
  "journal_tail",
  "journal_verify",
  "pending_list",
  "working_set",
  "timeline_list",
  "sys_status",
  "egress_check",
  "wait_for",
  "lease_list",
]);

// `shell` is the exception the set cannot express: whether it changed anything
// depends on the command, which is exactly what the broker already decided.
// A reversible shell command is on the read-only allowlist (ls, cat, grep).
const effectful = (tool, cls) => (tool === "shell" ? cls !== CLASS.REVERSIBLE : !READ_ONLY.has(tool));

// THE HASH MUST COVER WHAT THE ACTION ACTUALLY DOES, not what is safe to write
// in the journal. `fs_write` passes the broker only the path — file content has
// no business in an audit log, where it would bloat every entry and leak the
// secret the egress layer just refused to send. But two writes of DIFFERENT
// content to the same path are different actions, and hashing the journalled
// arguments alone made them identical: the second write was suppressed and the
// file kept the first version. Caught by the end-to-end test, which is the only
// place the two halves are visible at once.
//
// So callers pass identifying material separately. It is hashed and discarded,
// never stored and never journalled.
const keyOf = (tool, args, fp) => actionHash(tool, fp ? { ...args, ...fp } : args);

// How long a completed action stays a candidate for suppression. Generous,
// because the "nothing in between" rule is what does the discriminating: the
// window only stops a duplicate arriving after a long silence — a resumed
// session replaying its last call — from being folded into a run whose result is
// no longer true of the machine. 0 disables suppression entirely.
const WINDOW_MS = process.env.NEFERTARI_DEDUPE_MS === undefined ? 120000 : Number(process.env.NEFERTARI_DEDUPE_MS);

let last = null; // { hash, tool, at, outcome, extra, suppressed }

/** Test seam, and what a fresh connection starts with. */
export function reset() {
  last = null;
}

/**
 * Called before an action runs. Returns null to proceed, or a description of
 * the original for the caller to return instead of executing.
 *
 * The caller journals the suppression. This module deliberately does not: a
 * decision about an action belongs in the same record as the action, written by
 * whoever knows the class and the idle window.
 */
export function check(tool, args, cls, fp) {
  if (!WINDOW_MS || !effectful(tool, cls)) return null;
  if (!last) return null;
  if (last.hash !== keyOf(tool, args, fp)) return null;
  const age = Date.now() - last.at;
  if (age > WINDOW_MS) return null;
  last.suppressed++;
  return {
    status: "duplicate_suppressed",
    reason:
      `this is the same action as the one immediately before it, ${Math.round(age / 1000)}s ago, with nothing ` +
      `in between. It was not run a second time — the result below is the one it produced. If you meant to ` +
      `repeat it, do something else first, or wait ${Math.ceil((WINDOW_MS - age) / 1000)}s.`,
    original_outcome: last.outcome,
    ...last.extra,
    age_ms: age,
    times_suppressed: last.suppressed,
  };
}

/**
 * Called after an action ran. An action that changed something takes the slot,
 * which is what makes the NEXT identical call a deliberate repeat rather than a
 * duplicate. A read leaves the slot alone: an agent reading back the file it
 * just wrote has not changed its mind.
 */
export function remember(tool, args, cls, outcome, extra = {}, fp) {
  if (!effectful(tool, cls)) return;
  last = { hash: keyOf(tool, args, fp), tool, at: Date.now(), outcome, extra, suppressed: 0 };
}

/** What the last effectful action was, for tests and for `stats`. */
export function state() {
  return last ? { tool: last.tool, hash: last.hash, age_ms: Date.now() - last.at, suppressed: last.suppressed } : null;
}

export const windowMs = WINDOW_MS;
