// Virtual context: hand back a handle, keep the body.
//
// The context window is physical memory and nobody paged it. An agent reads a
// 4MB log, the whole thing lands in the window, and from then on every turn
// carries it. Twenty turns later the harness compacts — and compaction is lossy
// in the worst possible way: it drops what nothing has referred to recently,
// which is exactly the detail a later turn was going to need. The agent then
// re-reads the file, and the cycle starts again. On a smaller model the ceiling
// arrives sooner and the loss is worse.
//
// THE BILL IS NOT THE POINT, and it is worth being straight about that. With
// prompt caching a re-sent prefix is cheap, so carrying a large result costs
// much less money than a naive token count suggests. What it costs is TURNS: the
// window fills, the compaction comes early, and the thing that was lost is
// unrecoverable from inside the agent.
//
// So the fix is not a smaller budget, it is a pager. The daemon already has the
// bytes on disk, where they are large, durable and free. It hands back a handle
// and a preview, keeps the body, and lets the agent fault in the part it turns
// out to need — by range, or by searching inside it without loading it.
//
// WHICH MAKES COMPACTION SURVIVABLE RATHER THAN JUST LATER. A handle is a few
// dozen bytes, so it survives compaction where the body would not; and even if
// the handle itself is compacted away, the store is still on disk and
// `context_list` names what this session has read. The data stops living only
// in the conversation.
//
// NOTHING IS EVER SILENTLY TRUNCATED. A result that has been paged says so, says
// how much is being held, and says how to get the rest. An agent that receives
// a quietly shortened answer has no way to tell it from a complete one, and will
// answer confidently from half a file — which is a worse failure than any cost.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HOME, ensureHome } from "./paths.mjs";

const DIR = () => path.join(HOME, "context");

// Above this, a string is paged rather than delivered. 8KB is about 2k tokens:
// small enough that a window holds many of them, large enough that ordinary
// results — a file an agent is editing, a command's output — arrive whole and
// nothing changes for the common case.
const THRESHOLD = Number(process.env.NEFERTARI_CONTEXT_THRESHOLD || 8 * 1024);

// How much of the body comes back inline with the handle. Enough to recognise
// what it is and decide what to fetch; not enough to be worth carrying.
const PREVIEW = Number(process.env.NEFERTARI_CONTEXT_PREVIEW || 1200);

const MAX_FETCH = Number(process.env.NEFERTARI_CONTEXT_MAX_FETCH || 64 * 1024);

export const limits = () => ({ threshold: THRESHOLD, preview: PREVIEW, max_fetch: MAX_FETCH });

const stats = { paged: 0, bytes_held: 0, bytes_delivered: 0, fetches: 0 };
export const pagerStats = () => ({ ...stats, ...limits() });

function store(body, meta) {
  ensureHome();
  fs.mkdirSync(DIR(), { recursive: true });
  const id = `ctx_${crypto.randomBytes(5).toString("hex")}`;
  fs.writeFileSync(path.join(DIR(), `${id}.txt`), body);
  fs.writeFileSync(
    path.join(DIR(), `${id}.json`),
    JSON.stringify({ id, at: new Date().toISOString(), bytes: Buffer.byteLength(body), lines: countLines(body), ...meta })
  );
  return id;
}

const countLines = (s) => {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
};

/**
 * Page one oversized string: store it, return what goes in the window instead.
 *
 * The replacement is deliberately verbose. An agent has to be able to tell a
 * paged result from a complete one at a glance, and has to be told the exact
 * call that gets the rest — a handle it cannot work out how to use is a
 * truncation with extra steps.
 */
function pageOut(body, meta) {
  const bytes = Buffer.byteLength(body);
  const id = store(body, meta);
  stats.paged += 1;
  stats.bytes_held += bytes;
  const head = body.slice(0, PREVIEW);
  return {
    __paged: true,
    handle: id,
    bytes,
    lines: countLines(body),
    preview: head,
    preview_is: `the first ${Buffer.byteLength(head)} bytes of ${bytes}`,
    // Named rather than described: the next call should not require guessing.
    read_more: `context_fetch({ handle: "${id}", offset, limit })`,
    search_inside: `context_fetch({ handle: "${id}", grep: "pattern" }) — searches the whole thing without loading it`,
    note:
      "The full text is held on disk by the daemon, NOT lost. It survives this conversation being " +
      "compacted, and context_list() names everything held for this session.",
  };
}

/**
 * Walk a result and page every oversized string inside it.
 *
 * Structure is preserved on purpose. A shell result whose stdout is 4MB still
 * comes back as `{ exitCode, stdout: <handle>, stderr }` — an agent checking
 * exitCode must not have to fault anything in to do it, and a caller that
 * parses the shape must not break because the output happened to be large.
 */
export function page(value, meta = {}) {
  if (typeof value === "string") {
    return Buffer.byteLength(value) > THRESHOLD ? pageOut(value, meta) : value;
  }
  if (Array.isArray(value)) return value.map((v, i) => page(v, { ...meta, at: `${meta.at ?? ""}[${i}]` }));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = page(v, { ...meta, field: k });
    return out;
  }
  return value;
}

function load(handle) {
  if (!/^ctx_[0-9a-f]{10}$/.test(handle || "")) return { error: `not a handle: ${JSON.stringify(handle)}` };
  const f = path.join(DIR(), `${handle}.txt`);
  if (!fs.existsSync(f)) {
    return {
      error:
        `no such handle: ${handle}. Handles live in this daemon's home and are removed when it is cleaned. ` +
        `context_list() shows what is still held.`,
    };
  }
  return { body: fs.readFileSync(f, "utf8") };
}

/**
 * Fault in part of a held body.
 *
 * `grep` is the one that matters. Reading a 4MB log by 64KB slices is sixty
 * round trips; searching it costs one, and the agent gets the six lines it
 * actually needed with the line numbers to fetch around them. The search runs
 * here, over bytes that never enter the window.
 */
export function fetch(handle, { offset = 0, limit = MAX_FETCH, grep = "", context: ctx = 2, max_matches = 40 } = {}) {
  const l = load(handle);
  if (l.error) return { error: l.error };
  stats.fetches += 1;
  const body = l.body;
  const bytes = Buffer.byteLength(body);

  if (grep) {
    let re;
    try {
      re = new RegExp(grep, "m");
    } catch (e) {
      return { error: `pattern is not a valid regular expression: ${e.message}` };
    }
    const lines = body.split("\n");
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < max_matches; i++) {
      if (!re.test(lines[i])) continue;
      const from = Math.max(0, i - ctx);
      const to = Math.min(lines.length - 1, i + ctx);
      hits.push({ line: i + 1, text: lines.slice(from, to + 1).join("\n"), from_line: from + 1 });
    }
    const out = {
      handle,
      grep,
      matches: hits.length,
      total_lines: lines.length,
      hits,
      // A capped search that does not say it was capped reads as "there were
      // only six", which is the wrong conclusion to hand anybody.
      truncated: hits.length >= max_matches ? `stopped at ${max_matches} matches; there may be more` : undefined,
    };
    stats.bytes_delivered += Buffer.byteLength(JSON.stringify(out));
    return out;
  }

  const take = Math.min(Math.max(1, limit), MAX_FETCH);
  const slice = body.slice(offset, offset + take);
  stats.bytes_delivered += Buffer.byteLength(slice);
  return {
    handle,
    offset,
    returned_bytes: Buffer.byteLength(slice),
    total_bytes: bytes,
    more: offset + take < body.length ? `context_fetch({ handle: "${handle}", offset: ${offset + take} })` : null,
    text: slice,
  };
}

/** What this daemon is still holding for the session — the part compaction cannot take. */
export function list(max = 50) {
  try {
    const files = fs
      .readdirSync(DIR())
      .filter((f) => f.endsWith(".json"))
      .slice(-max);
    return files
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(DIR(), f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  } catch {
    return [];
  }
}
