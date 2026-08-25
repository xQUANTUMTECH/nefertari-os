// wait_for — wake on an event, not on a clock.
//
// An agent waiting for something that takes minutes has exactly one move today:
// poll. Sleep, look, reason about what it saw, sleep again. Every one of those
// cycles is a full round trip — the whole context re-sent, the whole answer
// re-generated — to learn that the CI is still running. Ten minutes of CI at a
// turn a minute is ten turns billed to observe nothing.
//
// The daemon can watch instead. It already sits between the agent and the
// machine, it is not the thing being billed, and a stat() every few hundred
// milliseconds costs nothing. So the agent asks once, the call does not return
// until the condition holds, and the agent spends ZERO turns waiting.
//
// A CONDITION MUST NOT HAVE EFFECTS. It is evaluated over and over, so anything
// that changes the world would change it once per poll — a hundred times over a
// long wait. Command conditions are therefore classified by the same broker
// that classifies everything else, and only a read-only command qualifies.
// Refusing here is not caution, it is the difference between watching a build
// and running it repeatedly.
//
// WHETHER TO FREEZE THE AGENT IS NOT THE SAME QUESTION AS AT THE GATE, and
// getting the two confused deadlocks the agent.
//
// At the human gate, freezing the agent's whole tree is always right: the thing
// being waited for is a person, who is outside the tree by definition, so
// nothing in it can help.
//
// Here the opposite is usually true. `npm test &` then `wait_for` on the log is
// the natural shape, and the test run is a CHILD of the agent — inside the
// tree. Freezing it would stop the very process that produces the condition,
// and the wait would time out having caused the thing it was waiting for not to
// happen. So the tree is frozen ONLY when it holds nothing but the agent
// itself. Anything else in there might be the producer, and the response says
// which case it took rather than leaving it to be guessed.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import * as cgroups from "./cgroups.mjs";
import * as gatefreeze from "./gatefreeze.mjs";
import { classifyShell, CLASS } from "./broker.mjs";

// A wait is a held connection, so it cannot be unbounded: an MCP client with
// its own timeout would give up first, and the daemon would be watching for
// nobody. The cap is generous because the cases worth waiting on are slow.
const MAX_MS = Number(process.env.NEFERTARI_WAIT_MAX_MS) || 30 * 60 * 1000;
const DEFAULT_MS = Number(process.env.NEFERTARI_WAIT_DEFAULT_MS) || 5 * 60 * 1000;
const MIN_POLL_MS = 100;

/**
 * Turn a condition into a function that answers true/false, or explain why it
 * cannot be one. Returns { ok, test, describe } or { ok: false, reason }.
 *
 * `baseline` is captured HERE, at the moment of the call, so `path_changed`
 * means "changed since you asked" rather than "changed at some point" — the
 * second is almost never the question, and answering it immediately would make
 * the tool useless for the loop it exists for.
 */
export function compile(cond = {}) {
  const { type } = cond;

  if (type === "path_exists" || type === "path_gone") {
    if (!cond.path) return { ok: false, reason: `${type} needs a path` };
    const p = path.resolve(cond.path);
    const want = type === "path_exists";
    return { ok: true, describe: `${type} ${p}`, test: () => fs.existsSync(p) === want };
  }

  if (type === "path_changed") {
    if (!cond.path) return { ok: false, reason: "path_changed needs a path" };
    const p = path.resolve(cond.path);
    const stamp = () => {
      try {
        const s = fs.statSync(p);
        return `${s.mtimeMs}:${s.size}`;
      } catch {
        return null; // absent is a state like any other; appearing IS a change
      }
    };
    const before = stamp();
    return { ok: true, describe: `path_changed ${p}`, test: () => stamp() !== before };
  }

  if (type === "file_contains") {
    if (!cond.path || !cond.pattern) return { ok: false, reason: "file_contains needs a path and a pattern" };
    const p = path.resolve(cond.path);
    let re;
    try {
      re = new RegExp(cond.pattern);
    } catch (e) {
      return { ok: false, reason: `pattern is not a valid regular expression: ${e.message}` };
    }
    // Only the tail is read. A build log grows without limit, and re-reading it
    // in full every poll would turn a free wait into a busy one.
    const TAIL = 64 * 1024;
    return {
      ok: true,
      describe: `file_contains ${p} =~ /${cond.pattern}/`,
      test: () => {
        let fd;
        try {
          const size = fs.statSync(p).size;
          const n = Math.min(size, TAIL);
          const buf = Buffer.alloc(n);
          fd = fs.openSync(p, "r");
          fs.readSync(fd, buf, 0, n, size - n);
          return re.test(buf.toString("utf8"));
        } catch {
          return false;
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      },
    };
  }

  if (type === "command_succeeds") {
    if (!cond.command) return { ok: false, reason: "command_succeeds needs a command" };
    // The whole safety argument for this condition type. A command that is
    // re-run every poll must not change anything, and the broker already knows
    // which commands do.
    const cls = classifyShell(cond.command);
    if (cls !== CLASS.REVERSIBLE) {
      return {
        ok: false,
        reason:
          `a condition is evaluated on every poll, so it must have no effects — and "${cond.command}" is ` +
          `classified ${cls}. Wait on something a read-only command can observe (a file, an exit marker, ` +
          `a log line) rather than on the effect itself.`,
      };
    }
    const cwd = cond.cwd ? path.resolve(cond.cwd) : process.cwd();
    return {
      ok: true,
      describe: `command_succeeds ${cond.command}`,
      // Async because a condition that blocks the event loop would also block
      // the freeze, the timeout and every other connection this daemon serves.
      test: () =>
        new Promise((resolve) => {
          execFile("/bin/sh", ["-c", cond.command], { cwd, timeout: 10000 }, (err) => resolve(!err));
        }),
    };
  }

  return {
    ok: false,
    reason: `unknown condition type ${JSON.stringify(type)}. Known: path_exists, path_gone, path_changed, file_contains, command_succeeds`,
  };
}

/**
 * Decide whether the agent's tree can safely be frozen for THIS wait.
 *
 * Safe only when the tree holds nothing but the agent itself: anything else in
 * there could be what produces the condition, and freezing the producer is a
 * deadlock dressed up as a timeout.
 */
export function freezeDecision() {
  const a = gatefreeze.agent();
  if (!a?.cgroup) return { freeze: false, why: "no agent registered (not started under `nefertari run`)" };
  let procs;
  try {
    procs = fs
      .readFileSync(cgroups.procsPath(a.cgroup), "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    return { freeze: false, why: `cannot read the agent's cgroup: ${e.code}` };
  }
  const others = procs.filter((pid) => Number(pid) !== a.pid);
  if (others.length) {
    return {
      freeze: false,
      agent: a,
      why:
        `the agent's tree holds ${others.length} other process(es), and one of them may be what produces ` +
        `this condition. Freezing it would stop the thing being waited for — so the wait is held without ` +
        `freezing.`,
    };
  }
  return { freeze: true, agent: a, why: "the tree holds only the agent, so nothing in it can produce the condition" };
}

/**
 * Wait until the condition holds, or until the timeout.
 *
 * Returns { satisfied, waited_ms, polls, frozen, freeze_note, condition }.
 * Never throws for a condition that simply does not come true: not happening is
 * an answer, and an agent that gets an exception instead of one will retry the
 * wait rather than deal with the timeout.
 */
export async function waitFor(cond, { timeoutMs = DEFAULT_MS, pollMs = 500 } = {}) {
  const c = compile(cond);
  if (!c.ok) return { error: c.reason };

  const budget = Math.min(Math.max(1, timeoutMs), MAX_MS);
  const poll = Math.max(MIN_POLL_MS, pollMs);

  const d = freezeDecision();
  let froze = false;
  if (d.freeze) {
    const f = cgroups.freeze(d.agent.cgroup);
    froze = f.ok === true;
  }

  const t0 = Date.now();
  let polls = 0;
  try {
    for (;;) {
      polls++;
      // Awaited even when the test is synchronous: a condition is allowed to be
      // either, and forcing every caller to know which is how one of them ends
      // up comparing a Promise to true.
      if (await c.test()) {
        return {
          satisfied: true,
          waited_ms: Date.now() - t0,
          polls,
          frozen: froze,
          freeze_note: d.why,
          condition: c.describe,
        };
      }
      if (Date.now() - t0 >= budget) {
        return {
          satisfied: false,
          timed_out: true,
          waited_ms: Date.now() - t0,
          polls,
          frozen: froze,
          freeze_note: d.why,
          condition: c.describe,
          // Said plainly, because the useful next move differs completely: a
          // condition that never came may be wrong, or the thing producing it
          // may have died, and the agent cannot tell those apart from silence.
          hint: "the condition did not hold within the budget. It may be wrong, or whatever produces it may have stopped.",
        };
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  } finally {
    // Thawed on every path, exactly as at the gate: a tree left frozen by a bug
    // here is indistinguishable from a hung machine.
    if (froze) cgroups.thaw(d.agent.cgroup);
  }
}

export const limits = { MAX_MS, DEFAULT_MS, MIN_POLL_MS };
