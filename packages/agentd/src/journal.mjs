// The append-only journal — and the reason it is hash-chained.
//
// When the caller is a human, the record of what happened is corroborated by the
// human: they testify. An agent cannot testify. So the journal is not a
// convenience log, it is the only witness to "this goal took this action, and a
// human had approved it" — and a witness that anyone can edit afterwards is not
// a witness at all.
//
// Every entry therefore carries the hash of the one before it, and its own hash
// over that link plus its body. Editing a past entry, deleting one, or slipping
// one in changes every hash after it, and verify() names the first line where
// the chain parts. This is tamper-EVIDENT, not tamper-proof: whoever owns the
// file can still rewrite the whole chain from the edit onward. What closes that
// gap is a signature the rewriter cannot forge and an anchor they cannot
// backdate — the daemon's Ed25519 key, and periodic anchoring to a TPM or a
// timestamp authority. Both build on this; neither works without it.
//
// The hash covers the entry EXACTLY as written, byte for byte. That is why the
// line is assembled by splicing "hash" in before the closing brace rather than
// by re-serialising the object: JSON.parse followed by JSON.stringify is not
// guaranteed to give back the same bytes, and a chain that disagrees with itself
// about whitespace or key order would report tampering that never happened.

import fs from "node:fs";
import crypto from "node:crypto";
import { JOURNAL_FILE, ensureHome } from "./paths.mjs";

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

// 128 bits, hex. Full SHA-256 doubles the size of a short entry for no gain
// anyone can use: forging a collision at 128 bits is not the attack that
// threatens an audit trail — editing it in place is, and any length catches that.
const HASH_LEN = 32;

const digest = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, HASH_LEN);

// Split a stored line back into the bytes that were hashed and the hash itself.
// Anchored at the end so an entry whose own content happens to contain the same
// text cannot confuse it.
const LINE = /^(.*),"hash":"([0-9a-f]+)"\}$/;

function splitLine(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  return { body: m[1] + "}", hash: m[2] };
}

// undefined = not read yet; null = genesis (empty journal). The distinction
// matters: treating "not read yet" as genesis would silently start a second
// chain in an existing file, which is exactly the tampering this file exists to
// make visible.
let lastHash;

function loadLastHash() {
  if (!fs.existsSync(JOURNAL_FILE)) return null;
  const size = fs.statSync(JOURNAL_FILE).size;
  if (size === 0) return null;
  // Only the tail is needed, and reading a long-lived journal in full on every
  // process start is the kind of cost that gets a feature switched off.
  const window = Math.min(size, 64 * 1024);
  const buf = Buffer.alloc(window);
  const fd = fs.openSync(JOURNAL_FILE, "r");
  try {
    fs.readSync(fd, buf, 0, window, size - window);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString("utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const parts = splitLine(lines[i]);
    if (parts) return parts.hash;
  }
  // A journal written before chaining existed, or a truncated tail. Start the
  // chain here rather than refusing to run; verify() reports the seam.
  return null;
}

export function append(entry) {
  ensureHome();
  if (lastHash === undefined) lastHash = loadLastHash();
  const body = JSON.stringify({ ts: new Date().toISOString(), ...entry, prev: lastHash });
  const hash = digest(body);
  // Splice rather than re-serialise: the bytes hashed are the bytes stored.
  fs.appendFileSync(JOURNAL_FILE, `${body.slice(0, -1)},"hash":"${hash}"}\n`);
  lastHash = hash;
  return hash;
}

/** Test seam: forget the in-memory chain head, forcing a re-read. */
export function resetChain() {
  lastHash = undefined;
}

export function tail(n = 20) {
  if (!fs.existsSync(JOURNAL_FILE)) return [];
  const lines = fs.readFileSync(JOURNAL_FILE, "utf8").trim().split("\n");
  return lines.slice(-n).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { raw: l };
    }
  });
}

// The whole journal, oldest first. tail() answers "what just happened"; this
// answers "what has this workspace been through", which is what a session
// resuming with no memory of it needs. Capped so a long-lived home cannot turn
// one question into an unbounded read.
export function readAll(max = 20000) {
  if (!fs.existsSync(JOURNAL_FILE)) return [];
  const body = fs.readFileSync(JOURNAL_FILE, "utf8").trim();
  if (!body) return [];
  const lines = body.split("\n");
  return (lines.length > max ? lines.slice(-max) : lines).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { raw: l };
    }
  });
}

/**
 * Walk the chain and report where, if anywhere, it parts.
 *
 * Returns { ok, entries, checked, broken } — `broken` naming the 1-based line,
 * what is wrong with it, and the hashes involved, because "the audit trail is
 * invalid" is not an answer anybody can act on.
 *
 * Lines written before chaining are counted as `unchained` and skipped rather
 * than reported as tampering: an older journal is not a forged one, and crying
 * wolf about it would train whoever reads this to ignore it.
 */
export function verify() {
  if (!fs.existsSync(JOURNAL_FILE)) return { ok: true, entries: 0, checked: 0, unchained: 0, broken: null };
  const raw = fs.readFileSync(JOURNAL_FILE, "utf8").trim();
  if (!raw) return { ok: true, entries: 0, checked: 0, unchained: 0, broken: null };

  const lines = raw.split("\n");
  let expectedPrev = null;
  let checked = 0;
  let unchained = 0;

  for (let i = 0; i < lines.length; i++) {
    const parts = splitLine(lines[i]);
    if (!parts) {
      unchained++;
      continue;
    }
    const actual = digest(parts.body);
    if (actual !== parts.hash) {
      return {
        ok: false,
        entries: lines.length,
        checked,
        unchained,
        broken: {
          line: i + 1,
          reason: "entry was modified after it was written: its content no longer hashes to its own hash",
          stored_hash: parts.hash,
          computed_hash: actual,
        },
      };
    }
    let prev = null;
    try {
      prev = JSON.parse(parts.body).prev ?? null;
    } catch {
      /* the hash matched, so the body is intact; a parse failure here is ours */
    }
    if (checked > 0 && prev !== expectedPrev) {
      return {
        ok: false,
        entries: lines.length,
        checked,
        unchained,
        broken: {
          line: i + 1,
          reason:
            prev === null
              ? "entry does not link to anything: an entry before it was removed, or this one was inserted"
              : "entry links to a different predecessor: an entry was removed or reordered here",
          expected_prev: expectedPrev,
          found_prev: prev,
        },
      };
    }
    expectedPrev = parts.hash;
    checked++;
  }

  return { ok: true, entries: lines.length, checked, unchained, broken: null };
}
