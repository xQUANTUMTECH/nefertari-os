// Enforcer wiring + live Landlock proof.
//   - wrapping decision needs no kernel (runs anywhere)
//   - if NEFERTARI_ENFORCE_BIN points at a built binary on a Landlock kernel,
//     we prove the kernel denies a write outside the working dir.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enforceWrap } from "../src/enforce.mjs";
import { CLASS } from "../src/broker.mjs";

// Noisy/system commands always run unconfined.
assert.equal(enforceWrap("mkdir /tmp/x", { cls: CLASS.NOISY, cwd: "/tmp" }).file, "bash");
console.log("  ok — noisy commands run unconfined");

const bin = process.env.NEFERTARI_ENFORCE_BIN;
const rev = enforceWrap("ls", { cls: CLASS.REVERSIBLE, cwd: "/tmp" });

if (bin && fs.existsSync(bin)) {
  assert.equal(rev.file, bin, "reversible commands run under the enforcer when present");
  assert.ok(rev.args.includes("--allow-write"), "enforcer gets a writable allowlist");
  console.log("  ok — reversible commands wrapped under the enforcer");

  const sbx = fs.mkdtempSync(path.join(os.tmpdir(), "nef-enf-"));
  // "outside" must be outside BOTH cwd and /tmp (the enforcer grants /tmp as
  // scratch), so put it under $HOME.
  const outside = fs.mkdtempSync(path.join(os.homedir(), "nef-out-"));

  const bad = enforceWrap(`echo x > ${outside}/hole.txt`, { cls: CLASS.REVERSIBLE, cwd: sbx });
  let blocked = false;
  try {
    execFileSync(bad.file, bad.args, { stdio: "pipe" });
  } catch {
    blocked = true;
  }
  assert.ok(blocked, "a write outside the working dir must be denied by the kernel");
  assert.ok(!fs.existsSync(`${outside}/hole.txt`), "the outside file must not exist");

  const good = enforceWrap(`echo x > ${sbx}/ok.txt`, { cls: CLASS.REVERSIBLE, cwd: sbx });
  execFileSync(good.file, good.args, { stdio: "pipe" });
  assert.ok(fs.existsSync(`${sbx}/ok.txt`), "a write inside the working dir must succeed");

  fs.rmSync(sbx, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  console.log("  ok — LANDLOCK PROOF: kernel denied write outside cwd, allowed inside");
} else {
  assert.equal(rev.file, "bash", "without the binary, fail-open to plain bash");
  console.log("  ok — enforcer absent: fail-open to plain bash (set NEFERTARI_ENFORCE_BIN to prove kernel enforcement)");
}
console.log("ENFORCE TESTS PASSED");
