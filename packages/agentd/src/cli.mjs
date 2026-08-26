#!/usr/bin/env node
// nefertari — human-gate CLI (phase 1). Phase 2 replaces this with the Windows companion UI.

import * as approvals from "./approvals.mjs";
import * as snapshots from "./snapshots.mjs";
import * as journal from "./journal.mjs";
import * as secrets from "./secrets.mjs";
import fs from "node:fs";

const [, , cmd, ...rest] = process.argv;

function print(x) {
  console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));
}

switch (cmd) {
  case "pending": {
    const items = approvals.listPending();
    if (!items.length) print("No pending actions.");
    for (const i of items) {
      print(`\n[${i.id}] ${i.approved ? "APPROVED (unconsumed)" : "WAITING"} — ${i.tool}`);
      print(`  reason: ${i.reason}`);
      print(`  args:   ${JSON.stringify(i.args)}`);
      print(`  since:  ${i.createdAt}`);
    }
    break;
  }
  // Identities live here and nowhere else. Reading the value from stdin is
  // not fussiness: a command line lands in shell history, in `ps` output,
  // and in this daemon's own record of what commands ran.
  case "secret": {
    const [sub, name, ...opts] = rest;
    if (sub === "add") {
      const hosts = [];
      let ttlMs = null;
      let header = "Authorization";
      let scheme = "Bearer";
      let note = "";
      for (let i = 0; i < opts.length; i++) {
        if (opts[i] === "--host") hosts.push(opts[++i]);
        else if (opts[i] === "--ttl-hours") ttlMs = Number(opts[++i]) * 3600000;
        else if (opts[i] === "--header") header = opts[++i];
        else if (opts[i] === "--scheme") scheme = opts[++i];
        else if (opts[i] === "--note") note = opts[++i];
      }
      const value = fs.readFileSync(0, "utf8").trim();
      const r = secrets.put({ name, value, hosts, header, scheme, ttlMs, note });
      if (!r.ok) {
        print(`refused: ${r.reason}`);
        process.exitCode = 1;
        break;
      }
      print(`identity ${r.name} stored for ${r.hosts.join(", ")}${r.expires_at ? `, expires ${r.expires_at}` : ""}`);
      print("the value is not printed, not journalled, and no tool can read it back.");
      break;
    }
    if (sub === "rm") {
      const r = secrets.remove(name);
      print(r.ok ? `removed ${r.removed}` : r.reason);
      break;
    }
    const all = secrets.list();
    if (!all.length) print("No identities stored.");
    for (const i of all) {
      print(`\n${i.name} → ${i.hosts.join(", ")}`);
      print(`  header: ${i.header}${i.note ? ` · ${i.note}` : ""}`);
      print(`  since:  ${i.added_at}${i.expires_at ? ` · expires ${i.expires_at}` : ""}`);
    }
    break;
  }
  case "approve": {
    const entry = approvals.approve(rest[0]);
    journal.append({ id: entry.id, tool: entry.tool, args: entry.args, decision: "human_approved" });
    print(`Approved ${entry.id} (${entry.tool}). The agent can now retry the exact same call once.`);
    break;
  }
  case "deny": {
    const entry = approvals.deny(rest[0]);
    journal.append({ id: entry.id, tool: entry.tool, args: entry.args, decision: "human_denied" });
    print(`Denied and removed ${entry.id} (${entry.tool}).`);
    break;
  }
  case "journal": {
    print(journal.tail(Number(rest[0]) || 20));
    break;
  }
  case "snapshots": {
    print(snapshots.list().map((s) => ({ id: s.id, createdAt: s.createdAt, meta: s.meta, files: s.entries.length })));
    break;
  }
  case "undo": {
    print(snapshots.restore(rest[0]));
    break;
  }
  case "serve": {
    const { serve } = await import("./http.mjs");
    serve();
    break;
  }
  case "run": {
    const { run } = await import("./run.mjs");
    try {
      const r = await run(rest);
      if (!r.spawned) {
        print(r.error ? `failed to start: ${r.error}` : { confined: r.workspace, writable: r.writable, argv: [r.file, ...r.args] });
        process.exit(r.error ? 1 : 0);
      }
      process.exit(r.code ?? 1);
    } catch (e) {
      print(String(e.message));
      process.exit(2);
    }
  }
  case "mcp-socket": {
    const sock = rest[0];
    if (!sock) {
      print("usage: nefertari mcp-socket <path>");
      process.exit(2);
    }
    const { listen } = await import("./mcpsocket.mjs");
    await listen(sock);
    print(`agentd listening on ${sock} (0600). One agent at a time; the daemon outlives its client.`);
    break;
  }
  default:
    print(`nefertari — human gate CLI

Usage:
  nefertari pending           list actions waiting for approval
  nefertari approve <id>      approve a pending action (single-use)
  nefertari deny <id>         deny and remove a pending action
  nefertari journal [n]       tail the action journal
  nefertari snapshots         list snapshots
  nefertari undo <snap_id>    restore a snapshot
  nefertari serve             headless approval API over HTTP (containers/Railway)
  nefertari run [-w dir] [--allow p]... [--deny-read p]... -- <agent cmd>
                              run the agent with the workspace READ-ONLY, so its
                              only way to change it is through the daemon.
                              --deny-read makes a path unreadable: an agent that
                              cannot read a credential cannot forward it to a
                              model. Usual suspects: ~/.aws ~/.ssh ~/.config/gh
                              ~/.docker ~/.kube ~/.netrc
                              (--dry-run shows the sandbox without starting it)
  nefertari mcp-socket <p>    serve MCP on a local socket, so the agent connects
                              instead of owning the daemon (required before the
                              agent itself can be confined)`);
}
