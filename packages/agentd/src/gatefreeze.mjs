// H4 — gate-freeze: what a goal waiting for a human should cost.
//
// An irreversible action stops at the human gate. Today the daemon answers
// `pending_approval` and the agent goes on being an agent: it reasons about
// having been blocked, polls to see whether the human came back, explains the
// situation to itself again after a compaction. Every one of those turns is
// tokens, and whatever the agent left running — a build, a subagent, a watcher
// — keeps burning CPU for a decision that has not been made yet.
//
// So the gate holds the reply instead. The agent's process tree is FROZEN
// (`cgroup.freeze`: zero CPU, memory untouched, resumable in milliseconds), the
// daemon waits for the human, and when the approval arrives the tree is thawed
// and the action runs. From the agent's side nothing happened except that a
// tool call took a while — which is the point. A suspended process costs
// nothing and forgets nothing; a "blocked" agent that keeps thinking costs both.
//
// WHY FREEZING ADDS SOMETHING OVER JUST WAITING, because it is a fair question.
// An agent waiting on a tool result is already blocked on a read and already
// near zero CPU. Two things it does not cover, and they are the reasons this
// exists: the agent's CHILDREN keep running — a build, a test run, a subagent
// mid-flight — and a harness is free to do whatever it likes while a call is
// outstanding, including polling. Freezing the tree makes zero a property of
// the machine rather than a hope about the harness. The test proves exactly
// that distinction with a child that spins.
//
// THIS IS OPT-IN, and default off. Holding a tool reply changes what an agent
// observes, and an MCP client with its own timeout would see a hang rather than
// a gate. `NEFERTARI_GATE_WAIT_MS` names how long the daemon is willing to hold
// it; unset, the gate answers `pending_approval` exactly as before. On timeout
// it thaws and answers `pending_approval` too: the human took too long, but the
// agent must not be left frozen because of it.
//
// The freeze itself is best-effort by design. It needs cgroup v2 and an agent
// started under `nefertari run`, and where either is missing the wait still
// works — it is simply a wait. Refusing to gate because the kernel is old would
// trade a real guarantee for a nice-to-have.

import fs from "node:fs";
import path from "node:path";
import * as cgroups from "./cgroups.mjs";
import { HOME, ensureHome } from "./paths.mjs";

// Where `nefertari run` leaves the name of the cgroup holding the agent, so a
// daemon that is deliberately NOT the agent's parent can still find its tree.
// A file rather than an env var for the same reason: the daemon is usually
// older than the agent, and was started without knowing one was coming.
const AGENT_FILE = () => path.join(HOME, "agent.json");

const WAIT_MS = Number(process.env.NEFERTARI_GATE_WAIT_MS) || 0;
// How often the daemon looks for the human's answer. The daemon is not the one
// frozen, so this costs a stat() every 50ms of human thinking time — and it
// buys a resume that is imperceptible, which is the whole claim.
const POLL_MS = Number(process.env.NEFERTARI_GATE_POLL_MS) || 50;

/** Called by `run`: this is the tree to freeze when a human is asked. */
export function registerAgent({ cgroup, pid, command }) {
  ensureHome();
  fs.writeFileSync(AGENT_FILE(), JSON.stringify({ cgroup, pid, command, at: new Date().toISOString() }, null, 2));
}

/** Called when the agent exits: a stale name would freeze somebody else's tree. */
export function clearAgent() {
  try {
    fs.rmSync(AGENT_FILE(), { force: true });
  } catch {
    /* nothing to clear */
  }
}

export function agent() {
  try {
    const a = JSON.parse(fs.readFileSync(AGENT_FILE(), "utf8"));
    // A pid that no longer exists means the file outlived the agent. Freezing
    // by a recycled name is the one way this could touch a process it has no
    // business touching, so it is checked rather than assumed.
    if (a.pid && !alive(a.pid)) return null;
    return a;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, not ours
  }
}

export const enabled = () => WAIT_MS > 0;

/**
 * Hold the gate while a human decides.
 *
 * `isResolved()` is supplied by the caller rather than read here: whether an
 * action has been approved is the approvals module's question, and duplicating
 * its answer is how two sources of truth start disagreeing.
 *
 * Returns { resolved, waitedMs, froze, reason } — `froze` saying whether the
 * tree was actually stopped, never assuming it was.
 */
export async function hold(isResolved, { waitMs = WAIT_MS, pollMs = POLL_MS } = {}) {
  if (waitMs <= 0) return { resolved: false, waitedMs: 0, froze: false, reason: "gate-wait disabled" };

  const a = agent();
  let froze = false;
  let reason = a ? null : "no agent registered (not started under `nefertari run`)";
  if (a?.cgroup) {
    const f = cgroups.freeze(a.cgroup);
    froze = f.ok === true;
    if (!froze) reason = f.reason;
  }

  const t0 = Date.now();
  try {
    for (;;) {
      if (isResolved()) return { resolved: true, waitedMs: Date.now() - t0, froze, reason };
      if (Date.now() - t0 >= waitMs) return { resolved: false, waitedMs: Date.now() - t0, froze, reason: reason ?? "timed out" };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    // Thawed on EVERY path, including the one where the human never answers and
    // the one where isResolved throws. An agent left frozen by a bug here would
    // look exactly like a hung machine, and the freeze is worth nothing if
    // getting out of it depends on the happy path.
    if (froze && a?.cgroup) cgroups.thaw(a.cgroup);
  }
}
