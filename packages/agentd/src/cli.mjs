#!/usr/bin/env node
// nefertari — human-gate CLI (phase 1). Phase 2 replaces this with the Windows companion UI.

import * as approvals from "./approvals.mjs";
import * as snapshots from "./snapshots.mjs";
import * as journal from "./journal.mjs";

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
