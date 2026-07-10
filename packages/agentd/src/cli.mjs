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
  default:
    print(`nefertari — human gate CLI

Usage:
  nefertari pending           list actions waiting for approval
  nefertari approve <id>      approve a pending action (single-use)
  nefertari deny <id>         deny and remove a pending action
  nefertari journal [n]       tail the action journal
  nefertari snapshots         list snapshots
  nefertari undo <snap_id>    restore a snapshot
  nefertari serve             headless approval API over HTTP (containers/Railway)`);
}
