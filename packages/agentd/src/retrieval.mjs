// Memory by meaning — as an optional driver, never as a dependency.
//
// `journal_query` answers by filter and by count, which is enough for "what
// happened at 14:02" and "how many times was I gated". It is not enough for
// "what did we decide about the parser". That is retrieval, and retrieval needs
// an engine: an index, embeddings, something that scores. Building one into a
// system layer would be the wrong shape — the layer would carry a vector store
// nobody asked for, and everyone would inherit its opinions.
//
// So it is a driver, on the same contract as enforce.mjs and localmodel.mjs:
// **the core stays neutral, and without a driver nothing changes**. No engine
// means questions are still answered by filters, exactly as before.
//
// WHAT THIS FILE IS FOR IS THE POLICY, NOT THE SEARCH. The engine finds things;
// this decides what it is allowed to be sent and what has to come back with the
// answer. Two rules, and both belong on this side of the seam precisely because
// a driver could be anyone's:
//
//   1. THE ENDPOINT MUST BE LOCAL. Indexing the journal means embedding the
//      journal. If the engine is remote, indexing IS exfiltration — of the one
//      record the whole design treats as primary — and it would happen quietly,
//      as a side effect of a feature that reads like a search box. The context
//      pager and the egress boundary are the same boundary, and this is where
//      that stops being a slogan. A non-local endpoint is refused.
//
//      Not forbidden outright: someone with a private VPC and a reason may
//      genuinely want a remote engine, and a layer that refuses to be overridden
//      gets forked rather than corrected. But the override is explicit, and the
//      decision is journalled, so nobody discovers it later by accident.
//
//   2. PROVENANCE SURVIVES RETRIEVAL, or retrieval becomes a laundering
//      machine. A hostile line inside a fetched web page gets found by meaning,
//      lifted out of its surroundings, and handed back as "recovered knowledge"
//      with the untrusted label left behind in the store. Every result is
//      re-labelled here, from the store's own record rather than from whatever
//      the engine chose to return — an engine that forgets the field, or an
//      engine that lies about it, changes nothing.
//
// The engine itself is deliberately out of scope, out of this repository, and
// free to be commercial. What is open is the seam: the contract below, the
// policy around it, and the null driver that makes the whole thing optional.

import * as vctx from "./context.mjs";
import * as prov from "./provenance.mjs";
import fs from "node:fs";
import path from "node:path";
import { HOME } from "./paths.mjs";

const DRIVER = (process.env.NEFERTARI_RETRIEVAL_DRIVER || "none").toLowerCase();
const ENDPOINT = process.env.NEFERTARI_RETRIEVAL_URL || "";
const TIMEOUT_MS = Number(process.env.NEFERTARI_RETRIEVAL_TIMEOUT_MS) || 6000;
const ALLOW_REMOTE = process.env.NEFERTARI_RETRIEVAL_ALLOW_REMOTE === "1";
// Bodies larger than this are sent head-first and truncated for the index. A
// cap has to exist somewhere, and a body that needs more than this to be
// findable is better served by journal_query with a pattern.
const MAX_INDEX_BYTES = Number(process.env.NEFERTARI_RETRIEVAL_MAX_INDEX_BYTES) || 4 * 1024 * 1024;

// Which handles this daemon has already handed to the engine. Kept so a
// search does not re-ship the whole store every time it is called.
// Kept OUTSIDE the context directory on purpose: that directory is scanned
// for handle metadata, and a state file living in it was read back as a
// phantom handle — which the test caught as a re-index that should not have
// happened. A store directory should hold exactly one kind of thing.
const INDEXED = () => path.join(HOME, "retrieval-indexed.json");

// Loopback and unix sockets only. Deliberately a small list rather than a
// clever check: "is this host really local" has enough edge cases (DNS that
// resolves to 127.0.0.1 today and elsewhere tomorrow, IPv6 mapped addresses,
// a /etc/hosts entry) that a permissive test would eventually be wrong in the
// direction that matters.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

export function isLocal(url) {
  if (!url) return false;
  if (url.startsWith("unix:") || url.startsWith("file:") || url.startsWith("/")) return true;
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Is a retrieval engine configured, and may it be used?
 *
 * Returns { enabled, driver, endpoint, reason } — `reason` populated whenever
 * it is NOT enabled, because a feature that silently does nothing is worse than
 * one that is absent.
 */
export function status() {
  if (DRIVER === "none" || !DRIVER) {
    return {
      enabled: false,
      driver: "none",
      reason: "no retrieval engine configured — questions are answered by filters and counts",
    };
  }
  if (!ENDPOINT) {
    return { enabled: false, driver: DRIVER, reason: `NEFERTARI_RETRIEVAL_DRIVER=${DRIVER} but NEFERTARI_RETRIEVAL_URL is unset` };
  }
  if (!isLocal(ENDPOINT) && !ALLOW_REMOTE) {
    return {
      enabled: false,
      driver: DRIVER,
      endpoint: ENDPOINT,
      refused: true,
      reason:
        `retrieval endpoint ${ENDPOINT} is not local. Indexing means embedding, so a remote engine would ` +
        `send the journal off this machine as a side effect of searching it. Point it at loopback or a unix ` +
        `socket, or set NEFERTARI_RETRIEVAL_ALLOW_REMOTE=1 to accept that — the choice is recorded either way.`,
    };
  }
  return {
    enabled: true,
    driver: DRIVER,
    endpoint: ENDPOINT,
    local: isLocal(ENDPOINT),
    // Said out loud on every status: an override that stops being visible stops
    // being a decision and becomes a default nobody chose.
    warning: isLocal(ENDPOINT) ? undefined : "REMOTE ENGINE: indexed content leaves this machine",
  };
}

/**
 * The driver contract, in full. Two calls, and a driver is one small server.
 *
 *   POST <endpoint>/index
 *   { "documents": [{ "id": "ctx_…", "text": "…", "source": "local|external/untrusted" }] }
 *   → 200, any body
 *
 *   POST <endpoint>/search
 *   { "query": "…", "limit": 8 }
 *   → { "hits": [{ "id": "ctx_…", "score": 0.83 }] }
 *
 * The engine gets text and returns ids. It is given no authority over
 * anything but ranking: content comes back from the store, and so does the
 * trust label, so an engine that forgets the field — or lies about it —
 * changes nothing the caller sees.
 *
 * WHOLE BODIES GO TO THE INDEX, and the first version of this file got that
 * wrong. It sent only the first 2KB of each body, out of a caution borrowed
 * from the wrong place: the pager exists to protect the CONTEXT WINDOW, not
 * the loopback interface. A local engine on the same machine can have the
 * whole thing — that is what requiring it to be local buys. Sending previews
 * made the feature look like it worked while quietly being unable to find
 * anything past the first page, which the test caught by asking for a line
 * further down.
 */
async function post(route, body) {
  const url = ENDPOINT.replace(/\/$/, "") + route;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) return { error: `retrieval engine returned ${res.status} from ${route}` };
    return { body: await res.json().catch(() => ({})) };
  } catch (e) {
    // A search that fails is not a failure of the work being done. The caller
    // falls back to filters, which is the behaviour with no engine at all.
    return { error: `retrieval engine unreachable: ${e.name === "AbortError" ? `no answer in ${TIMEOUT_MS}ms` : e.message}` };
  } finally {
    clearTimeout(t);
  }
}

function alreadyIndexed() {
  try {
    return new Set(JSON.parse(fs.readFileSync(INDEXED(), "utf8")));
  } catch {
    return new Set();
  }
}

function rememberIndexed(ids) {
  const all = alreadyIndexed();
  for (const id of ids) all.add(id);
  try {
    fs.mkdirSync(path.dirname(INDEXED()), { recursive: true });
    fs.writeFileSync(INDEXED(), JSON.stringify([...all]));
  } catch {
    /* re-indexing next time is wasteful, not wrong */
  }
}

/**
 * Ask what this daemon holds, by meaning.
 *
 * The corpus is the paged store: the bodies of everything too large to have
 * stayed in a window. That is the material worth searching semantically — the
 * journal is structured and answers better to filters, while the store is
 * prose nobody indexed.
 */
export async function byMeaning(query, { limit = 8 } = {}) {
  const s = status();
  if (!s.enabled) return { available: false, reason: s.reason, refused: s.refused };

  const held = vctx.list(500);
  if (!held.length) return { available: true, hits: [], note: "nothing is held in the store yet" };

  // Only what the engine has not seen. Re-shipping the store on every search
  // would make the second question slower than the first for no reason.
  const seen = alreadyIndexed();
  let shipped = 0;
  const fresh = held.filter((h) => !seen.has(h.id));
  if (fresh.length) {
    const documents = [];
    for (const h of fresh) {
      const slice = vctx.fetch(h.id, { offset: 0, limit: MAX_INDEX_BYTES });
      if (slice.error) continue;
      documents.push({
        id: h.id,
        text: slice.text,
        // Sent so an engine CAN honour it — filter untrusted material out of
        // a result set, say. It is not trusted back: the label the caller
        // sees is re-read from the store below.
        source: prov.badge(h.provenance),
      });
    }
    if (documents.length) {
      const ix = await post("/index", { documents });
      if (ix.error) return { available: false, reason: ix.error, fell_back: true };
      rememberIndexed(documents.map((d) => d.id));
      shipped = documents.length;
    }
  }

  const r = await post("/search", { query, limit });
  if (r.error) return { available: false, reason: r.error, fell_back: true };
  const hits = Array.isArray(r.body?.hits) ? r.body.hits : null;
  if (!hits) return { available: false, reason: "retrieval engine returned no hits array", fell_back: true };

  // Re-labelled from the store, not from the engine.
  const byId = new Map(held.map((h) => [h.id, h]));
  const out = hits
    .map((hit) => {
      const meta = byId.get(hit.id);
      if (!meta) return null; // an id we never stored: ignored, not trusted
      return {
        handle: meta.id,
        score: hit.score,
        from_tool: meta.tool,
        bytes: meta.bytes,
        at: meta.at,
        source: prov.badge(meta.provenance),
        warning: prov.warningFor(meta.provenance),
        fetch: `context_fetch({ handle: "${meta.id}", grep: "..." })`,
      };
    })
    .filter(Boolean);

  return { available: true, driver: s.driver, endpoint_is_local: s.local, query, indexed_now: shipped, hits: out };
}