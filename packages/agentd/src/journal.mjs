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
// the chain parts. On its own that is tamper-EVIDENT and no more: whoever owns
// the file can edit an entry, recompute its hash, and recompute every hash
// after it, and the result agrees with itself at every link. So every entry is
// also SIGNED with the daemon Ed25519 key — a forger can hash, but cannot sign,
// and verify() refuses an unsigned entry that sits after a signed one.
//
// WHAT IS STILL OPEN, and it is worth naming rather than implying otherwise.
// Two attacks survive, and both are attacks on the FILE rather than on an
// entry: truncating the tail removes signed entries without forging any, and
// stripping every signature (with the key) makes the whole journal look like
// one written before signing existed. No signature can object to its own
// absence. Closing that needs an anchor the attacker cannot backdate — a
// periodic head hash in a TPM, a timestamp authority, or simply another host —
// which is not built. It builds on this; it does not replace it.
//
// The hash covers the entry EXACTLY as written, byte for byte. That is why the
// line is assembled by splicing "hash" in before the closing brace rather than
// by re-serialising the object: JSON.parse followed by JSON.stringify is not
// guaranteed to give back the same bytes, and a chain that disagrees with itself
// about whitespace or key order would report tampering that never happened.

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { JOURNAL_FILE, HOME, ensureHome } from "./paths.mjs";

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

// 128 bits, hex. Full SHA-256 doubles the size of a short entry for no gain
// anyone can use: forging a collision at 128 bits is not the attack that
// threatens an audit trail — editing it in place is, and any length catches that.
const HASH_LEN = 32;

const digest = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, HASH_LEN);

// Split a stored line back into the bytes that were hashed, the hash, and the
// signature. Anchored at the end so an entry whose own content happens to
// contain the same text cannot confuse it. The signature is optional: a journal
// written before signing existed is old, not forged.
const LINE = /^(.*),"hash":"([0-9a-f]+)"(?:,"sig":"([A-Za-z0-9+/=]+)")?\}$/;

function splitLine(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  return { body: m[1] + "}", hash: m[2], sig: m[3] || null };
}

// ---- signing ----
//
// The chain makes tampering VISIBLE; the signature is what stops it being
// rewritten from scratch. Without one, anybody who can edit the file can edit
// an entry, recompute its hash, and recompute every hash after it — the chain
// parts nowhere and the forgery is perfect.
//
// EVERY entry is signed rather than the chain head being sealed periodically.
// A periodic seal leaves everything after the last one forgeable by whoever
// holds the file; per-entry signing leaves nothing forgeable at all. The cost
// is 88 characters and about 50 microseconds an entry, which is not a reason to
// accept the weaker guarantee.
//
// What this still does NOT stop: truncation. Deleting the tail of the file
// removes signed entries without forging any, and no signature can object to
// its own absence. That is what an external anchor is for — a periodic hash
// published somewhere the daemon does not control — and it is not built.
const KEY_FILE = () => path.join(HOME, "journal.key");
const PUB_FILE = () => path.join(HOME, "journal.pub");

let keys; // { priv, pub, fp } — resolved once per process

function loadKeys() {
  if (keys) return keys;
  ensureHome();
  const kf = KEY_FILE();
  let priv;
  if (fs.existsSync(kf)) {
    priv = crypto.createPrivateKey(fs.readFileSync(kf, "utf8"));
  } else {
    const pair = crypto.generateKeyPairSync("ed25519");
    priv = pair.privateKey;
    // 0600 from the moment it exists: a signing key readable by anything on the
    // host signs anything on the host. Written with mode rather than chmodded
    // after, so there is no window in which it is world-readable.
    fs.writeFileSync(kf, priv.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const pub = crypto.createPublicKey(priv);
  const pem = pub.export({ type: "spki", format: "pem" });
  // The public key is written out so a verifier never needs the private one.
  try {
    fs.writeFileSync(PUB_FILE(), pem);
  } catch {
    /* a read-only home can still sign; it just cannot publish */
  }
  keys = { priv, pub, fp: crypto.createHash("sha256").update(pem).digest("hex").slice(0, 16) };
  return keys;
}

/** The public half, for anyone checking the trail without the ability to write it. */
export function publicKey() {
  const k = loadKeys();
  return { pem: k.pub.export({ type: "spki", format: "pem" }), fingerprint: k.fp, path: PUB_FILE() };
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
  // Signing the hash rather than the body covers both transitively: the hash
  // already commits to the content and to the link to the entry before it.
  let sig = "";
  try {
    sig = `,"sig":"${crypto.sign(null, Buffer.from(hash, "utf8"), loadKeys().priv).toString("base64")}"`;
  } catch {
    // An unsignable entry is still worth recording. It verifies as unsigned,
    // which is a visible gap rather than a silent one.
  }
  // Splice rather than re-serialise: the bytes hashed are the bytes stored.
  fs.appendFileSync(JOURNAL_FILE, `${body.slice(0, -1)},"hash":"${hash}"${sig}}\n`);
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
  if (!fs.existsSync(JOURNAL_FILE)) return { ok: true, entries: 0, checked: 0, unchained: 0, unsigned: 0, broken: null };
  const raw = fs.readFileSync(JOURNAL_FILE, "utf8").trim();
  if (!raw) return { ok: true, entries: 0, checked: 0, unchained: 0, unsigned: 0, broken: null };

  const lines = raw.split("\n");
  let expectedPrev = null;
  let checked = 0;
  let unchained = 0;
  let unsigned = 0;
  // Whether a signature has been seen yet in THIS file. Unsigned entries are
  // tolerated only as a prefix — see the rejection below.
  let sawSigned = false;
  // Resolved once. A verifier that has only the public key still works: it is
  // written next to the journal precisely so checking never needs the ability
  // to write it.
  let pub = null;
  try {
    pub = loadKeys().pub;
  } catch {
    /* no key: signatures cannot be checked, and that is reported, not assumed away */
  }

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
        unsigned,
        broken: {
          line: i + 1,
          reason: "entry was modified after it was written: its content no longer hashes to its own hash",
          stored_hash: parts.hash,
          computed_hash: actual,
        },
      };
    }
    // The hash proves the entry has not changed since it was written. The
    // signature proves WHO wrote it — without one, anybody who can edit the
    // file can edit an entry, recompute its hash, and recompute every hash
    // after it, and the chain parts nowhere.
    if (!parts.sig) {
      // An unsigned entry is legacy or forgery depending on WHERE it sits. A
      // journal written before signing existed is old, not forged — but once a
      // signed entry has appeared the daemon has a key, and every entry after
      // it is signed. An unsigned line there is the one forgery the hash chain
      // alone cannot see: strip the signature, edit the body, recompute this
      // hash and every hash after it, and the chain agrees with itself
      // perfectly. It is rejected precisely because a forger can do everything
      // except sign.
      if (sawSigned) {
        return {
          ok: false,
          entries: lines.length,
          checked,
          unchained,
          unsigned,
          broken: {
            line: i + 1,
            reason:
              "entry carries no signature, but earlier entries in this journal are signed. Signing does " +
              "not stop once it starts, so this entry was written by something that could edit the file " +
              "but could not sign — which is what forging a chain looks like.",
          },
        };
      }
      unsigned++;
    } else if (pub) {
      sawSigned = true;
      let good = false;
      try {
        good = crypto.verify(null, Buffer.from(parts.hash, "utf8"), pub, Buffer.from(parts.sig, "base64"));
      } catch {
        good = false;
      }
      if (!good) {
        return {
          ok: false,
          entries: lines.length,
          checked,
          unchained,
          unsigned,
          broken: {
            line: i + 1,
            reason:
              "signature does not verify: this entry was not written by the key in this home. Either it " +
              "was forged, or the signing key was replaced — and a replaced key cannot re-sign what the " +
              "old one signed, which is why both look the same from here and both are worth investigating.",
          },
        };
      }
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
        unsigned,
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

  return { ok: true, entries: lines.length, checked, unchained, unsigned, broken: null };
}
