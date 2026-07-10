// Headless approval API (phase 2, block 2). For hosts with no console or
// desktop — a container on Railway, a CI runner — the human gate is served
// over HTTP so an external system (Fortuna's awaiting_approval flow, a web
// UI, a webhook) can list and resolve pending actions.
//
// Zero dependencies: node:http only. Same single source of truth: this module
// calls the exact same approvals/journal code the CLI uses.
//
// Security model:
//   - Bearer token, required on every route except /health. Generated on first
//     start into ~/.nefertari/token (0600) if NEFERTARI_TOKEN is not set.
//   - Constant-time token comparison.
//   - Binds 127.0.0.1 by default; set NEFERTARI_HTTP_HOST=0.0.0.0 only inside
//     a container where the platform provides the outer boundary.
//
// Routes:
//   GET  /health                → { ok, pending }          (no auth)
//   GET  /pending               → [ pending entries ]
//   POST /pending/:id/approve   → approved entry
//   POST /pending/:id/deny      → denied entry
//   GET  /journal?n=50          → last n journal entries

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HOME, ensureHome } from "./paths.mjs";
import * as approvals from "./approvals.mjs";
import * as journal from "./journal.mjs";

const TOKEN_FILE = path.join(HOME, "token");

export function loadOrCreateToken() {
  if (process.env.NEFERTARI_TOKEN) return process.env.NEFERTARI_TOKEN.trim();
  ensureHome();
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}

function tokenOk(req, token) {
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!got) return false;
  const a = Buffer.from(got), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, code, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(json);
}

export function createServer({ token }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, pending: approvals.listPending().length });
    }
    if (!tokenOk(req, token)) {
      return send(res, 401, { error: "missing or invalid bearer token" });
    }

    try {
      if (req.method === "GET" && url.pathname === "/pending") {
        return send(res, 200, approvals.listPending());
      }
      if (req.method === "POST" && parts[0] === "pending" && parts[2] === "approve") {
        const entry = approvals.approve(parts[1]);
        journal.append({ id: entry.id, tool: entry.tool, args: entry.args, decision: "human_approved", via: "http" });
        return send(res, 200, entry);
      }
      if (req.method === "POST" && parts[0] === "pending" && parts[2] === "deny") {
        const entry = approvals.deny(parts[1]);
        journal.append({ id: entry.id, tool: entry.tool, args: entry.args, decision: "human_denied", via: "http" });
        return send(res, 200, entry);
      }
      if (req.method === "GET" && url.pathname === "/journal") {
        const n = Math.min(Number(url.searchParams.get("n")) || 50, 500);
        return send(res, 200, journal.tail(n));
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 404, { error: String(e.message || e) });
    }
  });
}

export function serve() {
  const token = loadOrCreateToken();
  const host = process.env.NEFERTARI_HTTP_HOST || "127.0.0.1";
  const port = Number(process.env.NEFERTARI_HTTP_PORT) || 7343;
  createServer({ token }).listen(port, host, () => {
    console.log(`nefertari approval API on http://${host}:${port}`);
    console.log(process.env.NEFERTARI_TOKEN ? "token: from NEFERTARI_TOKEN" : `token: ${TOKEN_FILE}`);
  });
}
