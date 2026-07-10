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
