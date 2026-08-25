// Leases on things that are not on this machine.
//
// Almost every lock a system offers is about a local resource: a file, a
// socket, a row. An agent's effects are mostly somewhere else. Two agents that
// both push to the same branch, both deploy the same service, both charge the
// same customer are not racing over anything `flock` can see, and the loser
// finds out afterwards.
//
// So the resource is named by URI and the table lives here, in the one place
// that sees every action before it happens:
//
//   push:github.com/org/repo        deploy:railway/api        spend:stripe/acct_x
//
// ADVISORY, AND SAYING SO MATTERS. Nothing here stops a process that does not
// go through Nefertari, and pretending otherwise would be worse than not having
// it: someone would rely on it. What it does do is stop the case that actually
// happens — several agents, or several goals, on one machine, going through the
// same broker, stepping on each other with nobody noticing until later.
//
// THE URI IS INFERRED, NOT DECLARED. An agent that has to remember to take a
// lease will forget, and the run where it forgets is the run that needed it. So
// `uriFor` reads the action: `git push` in a repo with a GitHub remote is
// `push:github.com/org/repo` whether or not anybody thought about it. Inference
// is best-effort by nature — an action it cannot name holds no lease and is
// allowed through, because refusing everything unrecognised would make the
// broker useless the first time somebody used a tool it had not heard of.
//
// EXPIRY IS THE ONLY THING THAT MAKES IT SAFE. A lease held by an agent that
// crashed would block the resource forever, and the operator would learn to
// delete the file — which is learning to ignore the mechanism. Every lease
// carries a TTL, a dead holder's lease is reclaimed on sight, and both are
// visible in `lease_list`.

import fs from "node:fs";
import path from "node:path";
import { HOME, ensureHome } from "./paths.mjs";

const FILE = () => path.join(HOME, "leases.json");

const DEFAULT_TTL_MS = Number(process.env.NEFERTARI_LEASE_TTL_MS) || 10 * 60 * 1000;
const MAX_TTL_MS = Number(process.env.NEFERTARI_LEASE_MAX_TTL_MS) || 60 * 60 * 1000;

/**
 * Who holds a lease. One server process per connection means one holder per
 * agent, which is the granularity that matters: two goals inside one agent are
 * one holder and cannot deadlock each other, two agents are two holders and
 * must not collide.
 */
export function holderId() {
  return `pid:${process.pid}${process.env.NEFERTARI_GOAL ? `/${process.env.NEFERTARI_GOAL}` : ""}`;
}

function alive(holder) {
  const m = /^pid:(\d+)/.exec(holder || "");
  if (!m) return true; // not ours to judge
  try {
    process.kill(Number(m[1]), 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function load() {
  try {
    const all = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

function save(items) {
  ensureHome();
  // Written to a sibling and renamed: a reader that catches the file mid-write
  // would see a truncated table and conclude the resource is free, which is the
  // one wrong answer this must never give.
  const tmp = `${FILE()}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, FILE());
}

/** Drop what has expired or whose holder is gone. Returns the live ones. */
function live(items, now = Date.now()) {
  return items.filter((l) => now < Date.parse(l.expiresAt) && alive(l.holder));
}

/**
 * Take the lease, or report who has it.
 *
 * Re-acquiring a lease you already hold EXTENDS it rather than failing: an
 * agent doing ten pushes to the same repo should not have to track whether it
 * is already holding something, and a mechanism that punishes asking twice is
 * one that gets worked around.
 */
export function acquire(uri, { ttlMs = DEFAULT_TTL_MS, reason = "", holder = holderId() } = {}) {
  if (!uri) return { ok: false, reason: "a lease needs a URI" };
  const ttl = Math.min(Math.max(1000, ttlMs), MAX_TTL_MS);
  const items = live(load());
  const held = items.find((l) => l.uri === uri);

  if (held && held.holder !== holder) {
    return {
      ok: false,
      uri,
      held_by: held.holder,
      reason: held.reason || null,
      expires_at: held.expiresAt,
      // The wait is the useful part of the answer: "someone has it" leaves an
      // agent with nothing to do, "someone has it for another 4 minutes" lets
      // it wait, work on something else, or tell a human.
      expires_in_ms: Math.max(0, Date.parse(held.expiresAt) - Date.now()),
    };
  }

  const now = Date.now();
  const entry = {
    uri,
    holder,
    reason,
    acquiredAt: held?.acquiredAt || new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    renewals: held ? (held.renewals || 0) + 1 : 0,
  };
  save([...items.filter((l) => l.uri !== uri), entry]);
  return { ok: true, ...entry, extended: Boolean(held) };
}

export function release(uri, holder = holderId()) {
  const items = live(load());
  const held = items.find((l) => l.uri === uri);
  if (!held) return { ok: true, released: false, reason: "no live lease on that URI" };
  if (held.holder !== holder) {
    // Releasing somebody else's lease is how a well-meaning cleanup turns into
    // two agents in the same resource. It is refused, not silently ignored.
    return { ok: false, reason: `held by ${held.holder}, not by you`, held_by: held.holder };
  }
  save(items.filter((l) => l.uri !== uri));
  return { ok: true, released: true, uri };
}

/** Everything currently held, with what has been reclaimed pruned out. */
export function list() {
  const items = load();
  const alive_ = live(items);
  if (alive_.length !== items.length) save(alive_);
  return alive_.map((l) => ({ ...l, mine: l.holder === holderId(), expires_in_ms: Math.max(0, Date.parse(l.expiresAt) - Date.now()) }));
}

/**
 * Would this action collide with a lease somebody else holds?
 *
 * Returns null when it is fine to proceed — including when the action names no
 * resource we recognise, which is most of them.
 */
export function conflict(tool, args, holder = holderId()) {
  const uri = uriFor(tool, args);
  if (!uri) return null;
  const held = live(load()).find((l) => l.uri === uri);
  if (!held || held.holder === holder) return null;
  return {
    uri,
    held_by: held.holder,
    reason: held.reason || null,
    expires_at: held.expiresAt,
    expires_in_ms: Math.max(0, Date.parse(held.expiresAt) - Date.now()),
  };
}

// ---- naming the resource ----
//
// Deliberately small and deliberately conservative. Every rule here is a claim
// that two actions matching it touch the same thing, and a wrong claim blocks
// work that was never in conflict — which is a worse failure than missing a
// collision, because it is the one people notice and route around.

const GIT_REMOTE = /(?:https?:\/\/|git@)([^/:]+)[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?(?:\s|$)/;

function gitRemoteUri(cwd, verb) {
  // Read the remote from the repo rather than guessing from the command: a push
  // with no remote named goes wherever the branch tracks, and the command line
  // does not say where that is.
  try {
    const cfg = fs.readFileSync(path.join(cwd || process.cwd(), ".git", "config"), "utf8");
    const m = GIT_REMOTE.exec(cfg);
    if (m) return `${verb}:${m[1]}/${m[2]}`;
  } catch {
    /* not a repo, or a worktree whose config lives elsewhere */
  }
  return null;
}

/**
 * The resource an action touches, or null.
 *
 * `null` is the common and correct answer. Reads, local edits, builds and
 * anything unrecognised name nothing — a lease table that tried to cover
 * everything would be a lock on the whole machine.
 */
export function uriFor(tool, args = {}) {
  if (tool !== "shell") return null;
  const cmd = (args.command || "").trim();
  if (!cmd) return null;

  // git push / git tag --push: the branch's remote, whether or not it is named.
  if (/^git\s+(?:-C\s+\S+\s+)?push\b/.test(cmd)) return gitRemoteUri(args.cwd, "push");

  // gh: the repo it acts on, which for anything that WRITES is the same
  // resource a push touches — a PR merged under a push in flight is the same
  // collision by another route.
  if (/^gh\s+(pr|release|repo|workflow)\s+(create|merge|edit|delete|run|upload)\b/.test(cmd)) {
    const explicit = /--repo[= ]([^\s]+)/.exec(cmd);
    if (explicit) return `push:github.com/${explicit[1]}`;
    return gitRemoteUri(args.cwd, "push");
  }

  // Publishing: the package name is the resource, and a second publish of the
  // same version is the failure this prevents.
  if (/^npm\s+publish\b/.test(cmd) || /^pnpm\s+publish\b/.test(cmd)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(args.cwd || process.cwd(), "package.json"), "utf8"));
      if (pkg.name) return `publish:npm/${pkg.name}`;
    } catch {
      /* no manifest here */
    }
    return null;
  }

  if (/^docker\s+push\s+(\S+)/.test(cmd)) {
    return `push:docker/${/^docker\s+push\s+(\S+)/.exec(cmd)[1]}`;
  }

  // Deploys: one service at a time, whoever is deploying it.
  const deploy = /^(railway|fly|vercel|wrangler)\s+(?:deploy|up|publish)\b/.exec(cmd);
  if (deploy) {
    const svc = /--(?:service|name|app)[= ]([^\s]+)/.exec(cmd);
    return `deploy:${deploy[1]}/${svc ? svc[1] : path.basename(args.cwd || process.cwd())}`;
  }

  return null;
}

export const limits = { DEFAULT_TTL_MS, MAX_TTL_MS };
