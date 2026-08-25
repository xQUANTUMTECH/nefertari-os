// Human gate: irreversible actions wait here until approved via CLI (phase 2: companion UI).
// Approval is keyed by a stable hash of (tool, args) — single-use, expiring — so an approval
// authorizes exactly the action the human saw, exactly once.

import fs from "node:fs";
import crypto from "node:crypto";
import { PENDING_FILE, ensureHome } from "./paths.mjs";
import { newId } from "./journal.mjs";

const TTL_MS = 15 * 60 * 1000;

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  }
  return v;
}

export function actionHash(tool, args) {
  const canonical = JSON.stringify({ tool, args: canon(args) });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function load() {
  ensureHome();
  if (!fs.existsSync(PENDING_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
  } catch {
    return [];
  }
}

function save(items) {
  ensureHome();
  // Written to a sibling and renamed. Two processes touch this file — the
  // daemon and whatever the human approves from — and a reader that caught a
  // half-written table would conclude there was nothing pending, which is the
  // one wrong answer an approval queue must never give.
  const tmp = `${PENDING_FILE}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, PENDING_FILE);
}

function prune(items) {
  const now = Date.now();
  return items.filter((i) => now - Date.parse(i.createdAt) < TTL_MS);
}

// Register an action as pending. Returns the pending entry (existing one if already registered).
export function registerPending(tool, args, reason) {
  const hash = actionHash(tool, args);
  let items = prune(load());
  let entry = items.find((i) => i.hash === hash);
  if (!entry) {
    entry = {
      id: newId("act"),
      hash,
      tool,
      args,
      reason,
      approved: false,
      createdAt: new Date().toISOString(),
    };
    items.push(entry);
    save(items);
  }
  return entry;
}

// If an approved entry matches, CONSUME it (single-use) and return true.
export function consumeApproval(tool, args) {
  const hash = actionHash(tool, args);
  const items = prune(load());
  const idx = items.findIndex((i) => i.hash === hash && i.approved);
  if (idx === -1) {
    // Nothing consumed, so nothing to write. This runs on every irreversible
    // action, most of which are NOT approved yet — writing here was the same
    // lost-update hazard as the poll, on an even hotter path.
    return false;
  }
  items.splice(idx, 1);
  save(items);
  return true;
}

/**
 * What is waiting, with anything expired dropped.
 *
 * Writes back ONLY when something actually expired. It used to write every
 * time, which was a lost update waiting to happen: the gate polls this while
 * a human approves, so the daemon could read the queue, the human could
 * approve, and the daemon could then write its own stale copy back over the
 * approval. The human saw it accepted and the agent went on waiting until it
 * timed out. Found by the gate-freeze test failing about one run in three —
 * exactly the shape of bug that gets called flakiness and left alone.
 */
export function listPending() {
  const items = prune(load());
  if (items.length !== load().length) save(items);
  return items;
}

/**
 * The same answer, guaranteed not to write. This is what a poll should use:
 * reading something every 50ms must never be able to change it.
 */
export function peekPending() {
  return prune(load());
}

export function approve(id) {
  const items = prune(load());
  const entry = items.find((i) => i.id === id);
  if (!entry) throw new Error(`pending action not found (or expired): ${id}`);
  entry.approved = true;
  entry.approvedAt = new Date().toISOString();
  save(items);
  return entry;
}

export function deny(id) {
  let items = prune(load());
  const entry = items.find((i) => i.id === id);
  if (!entry) throw new Error(`pending action not found (or expired): ${id}`);
  items = items.filter((i) => i.id !== id);
  save(items);
  return entry;
}
