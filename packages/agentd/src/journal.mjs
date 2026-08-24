import fs from "node:fs";
import crypto from "node:crypto";
import { JOURNAL_FILE, ensureHome } from "./paths.mjs";

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

export function append(entry) {
  ensureHome();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(JOURNAL_FILE, line + "\n");
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
