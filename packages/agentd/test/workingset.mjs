// Working set: the orientation tax paid from the journal.
//   - files read/written/deleted come back, most recent first
//   - a file changed UNDER us since the last recorded action is flagged
//   - a file the agent itself just wrote is NOT flagged (clock skew)
//   - dir scopes the answer; an empty answer says why
//   - the tool is read-only, so it never reaches the human gate
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

process.env.NEFERTARI_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), "nef-home-"));
const { append } = await import("../src/journal.mjs");
const { workingSet } = await import("../src/workingset.mjs");
const { classify, CLASS } = await import("../src/broker.mjs");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "nef-ws-"));
const other = fs.mkdtempSync(path.join(os.tmpdir(), "nef-ws-out-"));
const at = (p) => path.join(work, p);

// An empty journal must not read as an empty workspace.
{
  const r = workingSet({ dir: work });
  assert.equal(r.files.length, 0);
  assert.match(r.note, /leaves no trace here/, "says what it cannot see");
  console.log("  ok — no activity is reported as no RECORD, not as no work");
}

// Three files: one the agent wrote, one it only read, one outside the scope.
fs.writeFileSync(at("kept.txt"), "v1");
fs.writeFileSync(at("read-only.txt"), "r");
fs.writeFileSync(path.join(other, "elsewhere.txt"), "x");

const past = new Date(Date.now() - 60_000).toISOString();
const stamp = (entry) => append({ ...entry, decision: "executed" });
stamp({ ts: past, tool: "fs_write", args: { path: at("kept.txt") } });
stamp({ tool: "fs_read", args: { path: at("read-only.txt") } });
stamp({ tool: "fs_read", args: { path: path.join(other, "elsewhere.txt") } });
stamp({ tool: "shell", args: { command: "npm test", cwd: work }, outcome: "ok" });
stamp({ tool: "shell", args: { command: "npm test", cwd: work }, outcome: "exit 1" });

// Something else edits the file the agent wrote a minute ago.
fs.writeFileSync(at("kept.txt"), "v2-by-someone-else");

const r = workingSet({ dir: work });

assert.deepEqual(
  r.files.map((f) => path.basename(f.path)).sort(),
  ["kept.txt", "read-only.txt"],
  "scoped to dir: the file outside it is not reported"
);
console.log("  ok — dir scopes the answer");

const kept = r.files.find((f) => f.path === at("kept.txt"));
assert.equal(kept.last_action, "wrote");
assert.equal(kept.writes, 1);
assert.ok(kept.changed_since_last_action, "a file edited under us is flagged");
assert.deepEqual(r.changed_since_last_action, [at("kept.txt")]);
console.log("  ok — a file changed underneath is named");

const ro = r.files.find((f) => f.path === at("read-only.txt"));
assert.equal(ro.last_action, "read");
assert.equal(ro.changed_since_last_action, false, "untouched since: not flagged");
console.log("  ok — a file nobody touched is not flagged");

// A write the agent just made must not come back as someone else's change.
fs.writeFileSync(at("fresh.txt"), "mine");
stamp({ tool: "fs_write", args: { path: at("fresh.txt") } });
const fresh = workingSet({ dir: work }).files.find((f) => f.path === at("fresh.txt"));
assert.equal(fresh.changed_since_last_action, false, "the agent's own write is not a change under it");
console.log("  ok — the agent's own write is not reported against it");

// Commands are deduplicated with a run count, newest outcome kept.
const cmd = r.commands.find((c) => c.command === "npm test");
assert.equal(cmd.runs, 2, "two runs collapse into one entry with a count");
assert.equal(cmd.last_outcome, "exit 1");
console.log("  ok — commands dedupe with a run count and the latest outcome");

// A deleted file that is back says so rather than looking ordinary.
fs.writeFileSync(at("ghost.txt"), "back");
stamp({ tool: "fs_delete", args: { path: at("ghost.txt") } });
const ghost = workingSet({ dir: work }).files.find((f) => f.path === at("ghost.txt"));
assert.equal(ghost.last_action, "deleted");
assert.match(ghost.note || "", /present again/);
console.log("  ok — deleted-but-present is called out");

// Reading your own history must never wait on a human.
assert.equal(classify("working_set", { dir: work }).class, CLASS.REVERSIBLE, "read-only, never gated");
console.log("  ok — classified read-only, so it never reaches the gate");

fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(other, { recursive: true, force: true });
console.log("WORKING SET TESTS PASSED");
