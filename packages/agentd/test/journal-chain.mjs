// The journal as a witness: hash-chained so tampering is VISIBLE, and signed so
// it cannot simply be rewritten from scratch.
//
// The chain alone catches an edit, a deletion, an insertion — but not a patient
// forger, who edits an entry, recomputes its hash, and recomputes every hash
// after it. That chain agrees with itself perfectly. What stops it is the
// signature: a forger with write access to the file still does not have the
// key, and every entry carries one.
//
//   - a clean chain verifies, and every entry is signed
//   - the signing key is not readable by anything else on the host
//   - editing a past entry is caught, and the line is named
//   - re-hashing that line alone only moves the break
//   - rewriting the WHOLE chain after the edit is caught too — by the signature
//   - tampering with a signature is caught
//   - deleting an entry is caught
//   - inserting an entry is caught
//   - entries written before signing existed are counted, not reported as fraud
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import crypto from "node:crypto";

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

// The tail a stored line carries: its hash, and its signature if it has one.
const TAIL = /,"hash":"[0-9a-f]+"(?:,"sig":"[^"]*")?\}$/;
const HASH_OF = /"hash":"([0-9a-f]+)"(?:,"sig":"[^"]*")?\}$/;
const bodyOf = (line) => line.replace(TAIL, "}");
const digest = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
// A line as a forger would produce it: correctly hashed, and unsigned, because
// that is the one part of the format they cannot reproduce.
const seal = (body) => `${body.slice(0, -1)},"hash":"${digest(body)}"}`;

// --- a chain nobody touched ---
write(5);
{
  const v = journal.verify();
  assert.ok(v.ok, `a clean chain must verify: ${JSON.stringify(v.broken)}`);
  assert.equal(v.checked, 5);
  assert.equal(v.unchained, 0);
  assert.equal(v.unsigned, 0, "every entry the daemon writes is signed");
  console.log("  ok — an untouched chain verifies, and every entry is signed");
}

// --- the key is the whole guarantee, so nothing else on the host can read it ---
{
  const pub = journal.publicKey();
  assert.match(pub.pem.toString(), /BEGIN PUBLIC KEY/, "the public half is published for verifiers");
  assert.ok(fs.existsSync(pub.path), "…as a file, so checking a journal never needs the private key");
  assert.equal(pub.fingerprint.length, 16);

  const keyFile = path.join(home, "journal.key");
  assert.ok(fs.existsSync(keyFile), "the private key lives in the daemon home");
  if (process.platform !== "win32") {
    const mode = fs.statSync(keyFile).mode & 0o777;
    assert.equal(mode, 0o600, `a key readable by anything on the host signs anything on the host (mode ${mode.toString(8)})`);
    console.log("  ok — the signing key is 0600 from the moment it exists");
  } else {
    console.log("  ok — public key published (POSIX mode check skipped on this host)");
  }
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

// --- someone rewrites that line's hash too, hoping that is enough ---
{
  // Made self-consistent, exactly as an attacker who read the source would do.
  // The break must not vanish. It cannot even reach the next entry: the line no
  // longer carries a signature, and unsigned entries do not appear in the middle
  // of a signed journal.
  fresh();
  write(5);
  const ls = lines();
  ls[2] = seal(bodyOf(ls[2]).replace("/w/f2", "/w/INNOCENT"));
  put(ls);
  const v = journal.verify();
  assert.equal(v.ok, false, "a self-consistent forgery must still be caught");
  assert.equal(v.broken.line, 3);
  assert.match(v.broken.reason, /no signature/, "and caught for the reason that actually stops it");
  console.log("  ok — re-hashing the edited line strips the signature, which is itself the tell");
}

// --- someone rewrites the ENTIRE chain after the edit: the patient forgery ---
{
  // This is the attack the hash chain alone cannot see. Edit an entry, recompute
  // its hash, then walk forward fixing every prev and every hash after it. The
  // result verifies against itself at every link — and is still refused, because
  // none of the rewritten entries can be signed.
  fresh();
  write(5);
  const ls = lines();
  let prev = HASH_OF.exec(ls[1])[1];
  for (let i = 2; i < ls.length; i++) {
    const o = JSON.parse(bodyOf(ls[i]));
    if (i === 2) o.args.path = "/w/INNOCENT";
    o.prev = prev;
    ls[i] = seal(JSON.stringify(o));
    prev = HASH_OF.exec(ls[i])[1];
  }
  put(ls);

  // Sanity: the forgery IS internally consistent. Every entry hashes to its own
  // hash and links to the one before it. Nothing about the chain is wrong.
  let p = null;
  for (const l of ls) {
    const b = bodyOf(l);
    assert.equal(digest(b), HASH_OF.exec(l)[1], "sanity: the forged chain is self-consistent");
    const o = JSON.parse(b);
    if (p) assert.equal(o.prev, p, "sanity: the forged chain links correctly");
    p = HASH_OF.exec(l)[1];
  }

  const v = journal.verify();
  assert.equal(v.ok, false, "a perfectly rewritten chain must still be refused");
  assert.equal(v.broken.line, 3, "at the first entry the forger had to write without the key");
  assert.match(v.broken.reason, /no signature/);
  console.log("  ok — rewriting the whole chain is caught: the forger can hash, but cannot sign");
}

// --- and doctoring a signature is not a way round it either ---
{
  fresh();
  write(3);
  const ls = lines();
  const sig = /"sig":"([^"]+)"/.exec(ls[1])[1];
  const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  ls[1] = ls[1].replace(sig, flipped);
  put(ls);
  const v = journal.verify();
  assert.equal(v.ok, false, "a doctored signature must be caught");
  assert.equal(v.broken.line, 2);
  assert.match(v.broken.reason, /signature does not verify/);
  console.log("  ok — a doctored signature is caught, and named as one");
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

// --- and so is a chained entry from before signing existed ---
{
  // The tolerance is a PREFIX, not a blanket: entries written before the daemon
  // had a key verify as unsigned, and the moment a signed one appears every
  // entry after it must be signed too. Otherwise stripping a signature would be
  // a way to opt out of the guarantee.
  fresh();
  const first = seal(JSON.stringify({ ts: new Date().toISOString(), tool: "fs_read", decision: "executed", prev: null }));
  fs.writeFileSync(JOURNAL_FILE, first + "\n");
  journal.resetChain();
  write(2);
  const v = journal.verify();
  assert.ok(v.ok, `a pre-signing entry is old, not forged: ${JSON.stringify(v.broken)}`);
  assert.equal(v.unsigned, 1, "and it is reported, so the gap is visible rather than assumed away");
  assert.equal(v.checked, 3);
  console.log("  ok — unsigned entries are tolerated as a prefix, and counted");
}

// --- a second process continues the chain rather than starting a new one ---
{
  fresh();
  write(2);
  journal.resetChain(); // as a fresh process would begin
  journal.append({ tool: "fs_read", decision: "executed" });
  const v = journal.verify();
  assert.ok(v.ok, `a restarted process must continue the chain: ${JSON.stringify(v.broken)}`);
  assert.equal(v.checked, 3);
  assert.equal(v.unsigned, 0, "and it signs with the key it finds, not a new one");
  console.log("  ok — a restarted daemon continues the chain, and reuses its key");
}

fs.rmSync(home, { recursive: true, force: true });
console.log("JOURNAL CHAIN TESTS PASSED");
