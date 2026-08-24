// The journal as a witness: hash-chained, so tampering is visible.
//   - a clean chain verifies
//   - editing a past entry is caught, and the line is named
//   - deleting an entry is caught
//   - inserting a forged entry is caught
//   - re-hashing the edited line alone is NOT enough — the break moves, it does
//     not disappear
//   - entries written before chaining are counted, not reported as tampering
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-chain-"));
process.env.NEFERTARI_HOME = home;
const journal = await import("../src/journal.mjs");
const { JOURNAL_FILE } = await import("../src/paths.mjs");

const write = (n) => {
  for (let i = 0; i < n; i++) journal.append({ tool: "fs_write", args: { path: `/w/f${i}` }, decision: "executed" });
};
const lines = () => fs.readFileSync(JOURNAL_FILE, "utf8").trim().split("\n");
const put = (ls) => fs.writeFileSync(JOURNAL_FILE, ls.join("\n") + "\n");
const fresh = () => {
  fs.rmSync(JOURNAL_FILE, { force: true });
  journal.resetChain();
};

// --- a chain nobody touched ---
write(5);
{
  const v = journal.verify();
  assert.ok(v.ok, `a clean chain must verify: ${JSON.stringify(v.broken)}`);
  assert.equal(v.checked, 5);
  assert.equal(v.unchained, 0);
  console.log("  ok — an untouched chain verifies");
}

// --- someone edits what an action did ---
{
  const ls = lines();
  ls[2] = ls[2].replace("/w/f2", "/w/INNOCENT");
  put(ls);
  const v = journal.verify();
  assert.equal(v.ok, false, "an edited entry must be caught");
  assert.equal(v.broken.line, 3, "and the line must be named");
  assert.match(v.broken.reason, /modified after it was written/);
  console.log("  ok — editing an entry is caught, with the line number");
}

// --- someone rewrites the hash too, hoping that is enough ---
{
  // The edited line is made self-consistent, exactly as an attacker who read
  // the source would do. The break must not vanish: it moves to the NEXT entry,
  // whose `prev` still points at the hash the line used to have.
  const crypto = await import("node:crypto");
  const ls = lines();
  const body = ls[2].replace(/,"hash":"[0-9a-f]+"\}$/, "}");
  const rehashed = crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 32);
  ls[2] = `${body.slice(0, -1)},"hash":"${rehashed}"}`;
  put(ls);
  const v = journal.verify();
  assert.equal(v.ok, false, "a self-consistent forgery must still break the chain");
  assert.equal(v.broken.line, 4, "the break moves to the entry that pointed at the old hash");
  assert.match(v.broken.reason, /different predecessor/);
  console.log("  ok — re-hashing the edited line alone only moves the break");
}

// --- someone removes an entry they would rather nobody saw ---
{
  fresh();
  write(5);
  const ls = lines();
  ls.splice(2, 1);
  put(ls);
  const v = journal.verify();
  assert.equal(v.ok, false, "a deletion must be caught");
  assert.equal(v.broken.line, 3, "at the entry that used to follow the deleted one");
  console.log("  ok — deleting an entry is caught");
}

// --- someone adds an approval that never happened ---
{
  fresh();
  write(3);
  const ls = lines();
  ls.splice(2, 0, JSON.stringify({ ts: new Date().toISOString(), tool: "shell", decision: "approved_by_human", prev: null, hash: "0".repeat(32) }));
  put(ls);
  const v = journal.verify();
  assert.equal(v.ok, false, "an inserted entry must be caught");
  assert.equal(v.broken.line, 3);
  console.log("  ok — inserting a forged approval is caught");
}

// --- a journal from before chaining is old, not forged ---
{
  fresh();
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify({ ts: new Date().toISOString(), tool: "fs_read", decision: "executed" }) + "\n");
  journal.resetChain();
  write(2);
  const v = journal.verify();
  assert.ok(v.ok, `an older unchained line must not read as tampering: ${JSON.stringify(v.broken)}`);
  assert.equal(v.unchained, 1, "it is counted and reported as unchained");
  assert.equal(v.checked, 2);
  console.log("  ok — pre-chain entries are counted, not cried wolf about");
}

// --- a second process continues the chain rather than starting a new one ---
{
  fresh();
  write(2);
  const headBefore = JSON.parse(lines().at(-1).replace(/,"hash":"([0-9a-f]+)"\}$/, "}")).prev;
  journal.resetChain(); // as a fresh process would begin
  journal.append({ tool: "fs_read", decision: "executed" });
  const v = journal.verify();
  assert.ok(v.ok, `a restarted process must continue the chain: ${JSON.stringify(v.broken)}`);
  assert.equal(v.checked, 3);
  assert.ok(headBefore !== undefined, "sanity: entries carry prev");
  console.log("  ok — a restarted daemon continues the chain, never forks it");
}

fs.rmSync(home, { recursive: true, force: true });
console.log("JOURNAL CHAIN TESTS PASSED");
