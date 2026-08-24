// OCS v0 smoke: dry_run + real ensure_dir/ensure_file/assert_path_exists in tmpdir.
// Run from packages/agentd:  node test/ocs.mjs

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NEFERTARI_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), "nef-ocs-home-"));

const { parseOcs, compileOcs, runOcs } = await import("../src/ocs.mjs");

function ok(name) {
  console.log(`  ok — ${name}`);
}

// --- parse ---
const sample = {
  ocs: "0",
  meta: { project: ".", dry_run: true },
  steps: [
    { op: "ensure_dir", path: "tmp-ocs-demo" },
    {
      op: "ensure_file",
      path: "tmp-ocs-demo/hello.txt",
      content: "hi\n",
      if_exists: "overwrite",
    },
    { op: "run", cmd: "echo ok", cwd: "tmp-ocs-demo" },
    { op: "assert_path_exists", path: "tmp-ocs-demo/hello.txt" },
  ],
};

const parsed = parseOcs(sample);
assert.equal(parsed.ocs, "0");
assert.equal(parsed.steps.length, 4);
assert.throws(() => parseOcs({ ocs: "1", steps: [] }), /ocs must be "0"/);
assert.throws(() => parseOcs('{"ocs":"0"}'), /steps must be an array/);
assert.throws(
  () => parseOcs({ ocs: "0", steps: [{ op: "fork", path: "x" }] }),
  /unknown or missing op/
);
ok("parseOcs validates ocs===\"0\" and steps");

// --- compile ---
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-compile-"));
const compiled = compileOcs(sample, { projectRoot: root });
assert.ok(Array.isArray(compiled.steps));
assert.ok(compiled.steps.length >= 3, "asserts not lowered; ensure/run/file are");
assert.equal(compiled.steps[0].tool, "shell");
assert.match(compiled.steps[0].args.command, /mkdirSync/);
assert.equal(compiled.steps[1].tool, "fs_write");
assert.equal(compiled.steps[2].tool, "shell");
assert.equal(compiled.steps[2].args.command, "echo ok");
// assert_path_exists must not appear as a plan step
assert.ok(compiled.steps.every((s) => s.tool === "shell" || s.tool === "fs_write" || s.tool === "fs_read"));
ok("compileOcs lowers ensure/run; asserts stay out of plan");

// --- dry_run ---
const dry = await runOcs(sample);
assert.equal(dry.status, "dry_run");
assert.equal(dry.steps_run, 0);
assert.deepEqual(dry.asserts, []);
assert.ok(Array.isArray(dry.expanded));
assert.ok(dry.expanded.length >= 3);
ok("dry_run returns expanded plan, steps_run=0");

// JSON string input
const dryJson = await runOcs(JSON.stringify({ ...sample, meta: { dry_run: true } }));
assert.equal(dryJson.status, "dry_run");
ok("parse accepts JSON string");

// --- real run in os.tmpdir() ---
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-run-"));
const realDoc = {
  ocs: "0",
  meta: { project: work },
  steps: [
    { op: "ensure_dir", path: "demo" },
    {
      op: "ensure_file",
      path: "demo/hello.txt",
      content: "hi\n",
      if_exists: "overwrite",
    },
    { op: "assert_path_exists", path: "demo/hello.txt" },
  ],
};

const report = await runOcs(realDoc);
assert.equal(report.status, "ok", report.error || JSON.stringify(report));
assert.equal(report.steps_run, 2);
assert.equal(report.asserts.length, 1);
assert.ok(report.asserts[0].ok);
const hello = path.join(work, "demo", "hello.txt");
assert.ok(fs.existsSync(hello));
assert.equal(fs.readFileSync(hello, "utf8"), "hi\n");
ok("real run ensure_dir + ensure_file + assert_path_exists");

// ensure_file skip leaves existing content
fs.writeFileSync(hello, "KEEP\n");
const skipDoc = {
  ocs: "0",
  meta: { project: work },
  steps: [
    {
      op: "ensure_file",
      path: "demo/hello.txt",
      content: "NEW\n",
      if_exists: "skip",
    },
    { op: "assert_path_exists", path: "demo/hello.txt" },
  ],
};
const skipReport = await runOcs(skipDoc);
assert.equal(skipReport.status, "ok", skipReport.error);
assert.equal(fs.readFileSync(hello, "utf8"), "KEEP\n");
ok("ensure_file if_exists=skip preserves existing file");

// assert failure
const failDoc = {
  ocs: "0",
  meta: { project: work },
  steps: [{ op: "assert_path_exists", path: "demo/missing.txt" }],
};
const failed = await runOcs(failDoc);
assert.equal(failed.status, "failed");
assert.ok(failed.asserts.some((a) => !a.ok));
ok("assert_path_exists failure => status failed");

fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log("OCS TESTS PASSED");
