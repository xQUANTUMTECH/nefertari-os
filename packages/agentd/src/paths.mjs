import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const HOME = process.env.NEFERTARI_HOME || path.join(os.homedir(), ".nefertari");
export const JOURNAL_FILE = path.join(HOME, "journal.jsonl");
export const PENDING_FILE = path.join(HOME, "pending.json");
export const SNAPSHOT_DIR = path.join(HOME, "snapshots");

export function ensureHome() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}
