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
  fs.writeFileSync(PENDING_FILE, JSON.stringify(items, null, 2));
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
    save(items);
    return false;
  }
  items.splice(idx, 1);
  save(items);
  return true;
}

export function listPending() {
  const items = prune(load());
  save(items);
  return items;
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
