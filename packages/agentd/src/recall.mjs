// Memory for a machine whose operator forgets everything, on purpose, often.
//
// An OS run by an AI has a problem no OS has had before: the thing making the
// decisions has amnesia. Not occasionally — structurally, every session, and
// mid-session too whenever the harness compacts. Any design that treats the
// conversation as the system's memory has put the system's memory in the one
// place guaranteed to lose it.
//
// So context and memory are separated, and kept in tiers with one rule between
// them:
//
//   DERIVED MEMORY MUST ALWAYS BE RE-DERIVABLE FROM A PRIMARY RECORD THE AGENT
//   CANNOT EDIT.
//
// That rule is the whole design, and it exists because the obvious alternative
// is catastrophic here. The obvious alternative is: before compacting, the agent
// writes a summary of what matters. But a summary written by the agent is the
// agent's own account of itself — lossy, self-serving, and unfalsifiable once
// the evidence is gone. Do that on an OS and a mistaken belief becomes permanent
// on the first compaction, with nothing left to check it against. Whoever reads
// it later, human or model, has no way to tell a remembered fact from a
// remembered guess.
//
// The tiers, then:
//
//   0  the window        volatile, small, lossy. NEVER the source of truth.
//   1  the journal       what happened. Append-only, hash-chained, signed —
//                        facts the agent cannot revise after the fact.
//   2  the store         the bytes themselves: everything paged out, kept whole
//                        on disk (context.mjs).
//   3  derived views     this file. working set, handles, leases, pressure —
//                        recomputed on demand, authoritative about nothing,
//                        cheap to throw away and rebuild.
//   4  durable knowledge across runs. NOT BUILT, and deliberately not built by
//                        letting the agent write to it: a fact survives a run
//                        only if a human or a re-runnable check promotes it.
//
// Every line in tier 3 carries provenance back to tier 1 or 2 — a journal entry,
// a handle, a lease — so a resumed agent can tell what it KNOWS from what it
// would merely be assuming. `recall()` returns pointers, not content: it is the
// index that lets a small window reach a large memory, and it is sized to be
// affordable at the exact moment the window is under most pressure.

import * as journal from "./journal.mjs";
import * as vctx from "./context.mjs";
import * as leases from "./leases.mjs";
import * as budget from "./budget.mjs";
import * as approvals from "./approvals.mjs";
import { workingSet } from "./workingset.mjs";

/**
 * Everything a session needs to carry on after losing its own memory of it.
 *
 * Deliberately made of POINTERS. A resume packet that inlined what it refers to
 * would be largest exactly when the window is fullest, which is when it is
 * needed — so files are named rather than read, and paged bodies are named by
 * handle rather than faulted in. The agent pulls what it turns out to need.
 */
export function recall({ dir, limit = 12 } = {}) {
  const entries = journal.readAll();

  // What was decided, rather than what was done: an agent resuming needs to
  // know it is mid-approval or was refused, and those never appear in a file
  // listing. Executed reads are the bulk of any journal and the least useful
  // thing to re-read here, so they are counted rather than listed.
  const decisions = entries
    .filter((e) => e.decision && e.decision !== "executed")
    .slice(-limit)
    .map((e) => ({ at: e.ts, tool: e.tool, decision: e.decision, reason: e.reason, id: e.id }));

  const ws = (() => {
    try {
      return workingSet({ dir, limit });
    } catch (e) {
      // A working set that cannot be computed must not take the rest of the
      // packet down with it: the point of this call is to work when things
      // have already gone wrong.
      return { error: String(e.message) };
    }
  })();

  const held = vctx.list(limit).map((h) => ({
    handle: h.id,
    from_tool: h.tool,
    bytes: h.bytes,
    lines: h.lines,
    at: h.at,
    // Named so an agent does not have to work out the call from the shape.
    search: `context_fetch({ handle: "${h.id}", grep: "..." })`,
  }));

  const pending = approvals.listPending().map((p) => ({ id: p.id, tool: p.tool, approved: p.approved, reason: p.reason }));
  const mine = leases.list().filter((l) => l.mine);
  const b = budget.status();

  return {
    // Set by whoever started the agent. Absent is honest: an agent that invents
    // its own goal on resume is the failure this is meant to prevent.
    goal: process.env.NEFERTARI_GOAL || null,
    journal: {
      entries: entries.length,
      // The chain head, so a packet can be tied to the exact record it was
      // derived from. Two packets with different heads describe different
      // histories, and that is worth being able to notice.
      verified: journal.verify().ok,
      recent_decisions: decisions,
    },
    working_set: ws,
    held_in_store: held,
    pending_approvals: pending,
    leases_held: mine,
    window: {
      calls: b.observed.calls,
      est_tokens_carried: b.observed.est_tokens_carried,
      means: b.observed.carried_means,
      remaining: b.remaining,
    },
    provenance:
      "Every line here is derived from the signed journal, the paged store, or the lease table — none of it " +
      "is this agent's account of itself. Nothing was summarised: what is named can be fetched in full.",
    next:
      "Fetch only what you actually need: context_fetch for a handle, fs_read for a file named in working_set, " +
      "journal_tail for the full record. Do not re-explore the tree — this IS the re-orientation.",
  };
}
