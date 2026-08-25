// The scarce resource is not CPU. It is the model bill.
//
// A scheduler written in kernel terms — CPU shares, IO weights — aims at the
// wrong target. For N agents on one host the real ceiling is tokens per minute
// and euros per day at the model endpoint, plus the rate limits of whatever
// external APIs they touch. The kernel cannot see any of that. The broker can,
// because every action passes through it.
//
// WHAT THIS METERS ITSELF, AND WHAT IT HAS TO BE TOLD.
//
// Most "token budget" designs depend entirely on the client reporting its own
// usage, which makes the budget a suggestion. There is one large component the
// daemon owns outright, and it is the one nobody counts: THE BYTES IT HANDS
// BACK. Every byte of a tool result becomes input tokens on the agent's next
// turn — and on the turn after that, and the one after that, for as long as it
// stays in the window. A 200KB file read is not a one-off 50k tokens; it is 50k
// tokens re-paid on every subsequent turn of that session.
//
// So this meters two different things and never mixes them up:
//
//   observed  — calls served, bytes issued into the context, and the carry cost
//               those bytes imply. Counted here, needs nobody's cooperation.
//   reported  — actual token usage from the client, if it chooses to say. More
//               accurate when present, absent by default, and never assumed.
//
// A client that reports nothing still has a meter running. That is the point:
// "unmetered" should be visible rather than silent.
//
// THE AGENT CANNOT RAISE ITS OWN BUDGET. There is no tool for it, deliberately.
// The budget comes from the environment, set by whoever is paying, and the agent
// can read it and report into it and nothing else. A spending limit an agent can
// edit is a spending limit in the same sense that a lock on the inside of a door
// is a lock.
//
// WHAT HAPPENS WHEN IT RUNS OUT is not "refuse everything". An agent that cannot
// call anything cannot release its leases, cannot say what it was doing, and
// cannot be understood afterwards. Winding down is allowed; starting new work is
// not.

import { HOME } from "./paths.mjs";

// Rough and labelled as such. Four bytes per token is the usual approximation
// for English text and code; it is wrong for both in opposite directions, which
// is why every number derived from it is called an estimate and the raw byte
// count is reported alongside.
const BYTES_PER_TOKEN = Number(process.env.NEFERTARI_BYTES_PER_TOKEN) || 4;

const LIMITS = {
  tokens: Number(process.env.NEFERTARI_BUDGET_TOKENS) || 0,
  calls: Number(process.env.NEFERTARI_BUDGET_CALLS) || 0,
  usd: Number(process.env.NEFERTARI_BUDGET_USD) || 0,
};

// Tools an agent may still use after the budget is gone. Everything here either
// explains the situation or gives something back; none of it starts new work.
// Leaving lease_release out would strand external resources behind an agent
// that ran out of money, which is a worse outcome than the overspend.
const WIND_DOWN = new Set([
  "budget_status",
  "journal_tail",
  "journal_verify",
  "pending_list",
  "lease_list",
  "lease_release",
  "working_set",
  "sys_status",
]);

const observed = {
  calls: 0,
  context_bytes: 0,
  // Bytes weighted by how many turns they will have been re-sent for. Updated
  // as turns pass, which is why it is a running total rather than a sum taken
  // at the end.
  carried_bytes: 0,
  by_tool: {},
};

const reported = { turns: 0, input_tokens: 0, output_tokens: 0, usd: 0, models: {} };

// Every chunk still assumed to be in the window, so the carry cost can be
// advanced one turn at a time. Trimmed at a bound: a session long enough to
// overflow this has been compacted several times over, and holding every chunk
// forever to be precise about a figure that is already an estimate would be
// the wrong trade.
let issued = [];
const MAX_TRACKED = 500;

export const limits = () => ({ ...LIMITS, bytes_per_token: BYTES_PER_TOKEN, home: HOME });

export const estTokens = (bytes) => Math.round(bytes / BYTES_PER_TOKEN);

/**
 * Record what a call cost, in the one currency the daemon issues: bytes into
 * the agent's context.
 *
 * Called after the result is built and before it is returned, so the number is
 * what actually goes out rather than what was intended.
 */
export function charge(tool, bytes) {
  observed.calls += 1;
  observed.context_bytes += bytes;
  observed.by_tool[tool] = (observed.by_tool[tool] || 0) + bytes;

  // A turn has passed for everything already in the window: each of those
  // chunks is about to be re-sent one more time.
  for (const c of issued) c.turns += 1;
  observed.carried_bytes = issued.reduce((n, c) => n + c.bytes * c.turns, 0) + bytes;

  issued.push({ bytes, turns: 1 });
  if (issued.length > MAX_TRACKED) issued = issued.slice(-MAX_TRACKED);
}

/**
 * What the client says it actually spent. Optional, and more accurate than any
 * estimate when it arrives — but it arrives from the thing being metered, so it
 * is recorded next to the observed figures rather than replacing them.
 */
export function report({ input_tokens = 0, output_tokens = 0, usd = 0, model = "" } = {}) {
  reported.turns += 1;
  reported.input_tokens += input_tokens;
  reported.output_tokens += output_tokens;
  reported.usd += usd;
  if (model) reported.models[model] = (reported.models[model] || 0) + input_tokens + output_tokens;
  return status();
}

export function status() {
  const observedTokens = estTokens(observed.context_bytes);
  const carriedTokens = estTokens(observed.carried_bytes);
  const usedTokens = reported.input_tokens + reported.output_tokens || carriedTokens;

  const remaining = {
    tokens: LIMITS.tokens ? Math.max(0, LIMITS.tokens - usedTokens) : null,
    calls: LIMITS.calls ? Math.max(0, LIMITS.calls - observed.calls) : null,
    usd: LIMITS.usd ? Math.round((LIMITS.usd - reported.usd) * 10000) / 10000 : null,
  };

  return {
    limits: LIMITS.tokens || LIMITS.calls || LIMITS.usd ? LIMITS : null,
    observed: {
      ...observed,
      est_tokens_issued: observedTokens,
      // The number worth putting in front of anyone deciding what a tool should
      // return: bytes handed back are re-sent every turn, so their real cost is
      // this rather than the first figure.
      est_tokens_carried: carriedTokens,
      carry_multiple: observedTokens > 0 ? Math.round((carriedTokens / observedTokens) * 10) / 10 : null,
    },
    reported: reported.turns ? reported : null,
    remaining,
    // Said out loud so a run with no client cooperation does not read as a run
    // that cost nothing.
    metering: reported.turns
      ? "client-reported token usage, cross-checked against bytes issued"
      : "no client-reported usage: figures are the daemon's own estimate from bytes issued",
    exhausted: exceeded(),
  };
}

/** Which limit, if any, is gone. Null when there is room, or no limit at all. */
export function exceeded() {
  const s = {
    tokens: LIMITS.tokens && (reported.input_tokens + reported.output_tokens || estTokens(observed.carried_bytes)) >= LIMITS.tokens,
    calls: LIMITS.calls && observed.calls >= LIMITS.calls,
    usd: LIMITS.usd && reported.usd >= LIMITS.usd,
  };
  const hit = Object.keys(s).filter((k) => s[k]);
  return hit.length ? hit : null;
}

/** May this tool still run? Winding down is allowed; new work is not. */
export function allowed(tool) {
  if (!exceeded()) return true;
  return WIND_DOWN.has(tool);
}

export function windDownTools() {
  return [...WIND_DOWN];
}

/** Test seam. */
export function reset(overrides = {}) {
  observed.calls = 0;
  observed.context_bytes = 0;
  observed.carried_bytes = 0;
  observed.by_tool = {};
  issued = [];
  reported.turns = 0;
  reported.input_tokens = 0;
  reported.output_tokens = 0;
  reported.usd = 0;
  reported.models = {};
  Object.assign(LIMITS, { tokens: 0, calls: 0, usd: 0 }, overrides);
}
