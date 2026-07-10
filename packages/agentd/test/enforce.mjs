// Enforcer wiring + driver selection + live Landlock proof.
//   - the wrapping DECISION needs no kernel (runs anywhere)
//   - driver selection is pluggable and vendor-neutral
//   - if NEFERTARI_ENFORCE_BIN points at a built binary on a Landlock kernel,
//     we prove the kernel denies a write outside the working dir.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enforceWrap } from "../src/enforce.mjs";
import { CLASS } from "../src/broker.mjs";

// Noisy/system commands always run unconfined, whatever the driver.
assert.equal(enforceWrap("mkdir /tmp/x", { cls: CLASS.NOISY, cwd: "/tmp" }).file, "bash");
console.log("  ok — noisy commands run unconfined");

// The "null" driver is an explicit opt-out: reversible commands run plain.
{
  const prev = process.env.NEFERTARI_ENFORCE_DRIVER;
  process.env.NEFERTARI_ENFORCE_DRIVER = "null";
  const r = enforceWrap("ls", { cls: CLASS.REVERSIBLE, cwd: "/tmp" });
  assert.equal(r.file, "bash");
  assert.equal(r.enforced, false);
  assert.equal(r.driver, "null");
  if (prev === undefined) delete process.env.NEFERTARI_ENFORCE_DRIVER;
  else process.env.NEFERTARI_ENFORCE_DRIVER = prev;
  console.log("  ok — 'null' driver opts out (plain bash)");
}

// The "custom" driver wires an arbitrary sandboxer purely from env — proof that
// enforcement is vendor-neutral. We point it at `env` (always on PATH) so no
// real sandbox is needed to verify the argv is assembled correctly.
{
  const saved = { ...process.env };
  process.env.NEFERTARI_ENFORCE_DRIVER = "custom";
  process.env.NEFERTARI_ENFORCE_CUSTOM_BIN = "env";
  process.env.NEFERTARI_ENFORCE_CUSTOM_PREARGS = JSON.stringify(["-i"]);
  process.env.NEFERTARI_ENFORCE_CUSTOM_WRITE_FLAG = "--allow-write";
  process.env.NEFERTARI_ENFORCE_CUSTOM_SEP = "--";
  const r = enforceWrap("echo hi", { cls: CLASS.REVERSIBLE, cwd: "/work" });
  assert.ok(r.file.endsWith("/env") || r.file === "env", "custom bin resolved on PATH");
  assert.equal(r.driver, "custom");
  assert.deepEqual(r.args, ["-i", "--allow-write", "/work", "--allow-write", "/tmp", "--", "bash", "-lc", "echo hi"]);
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  console.log("  ok — 'custom' driver wires any sandboxer from env (vendor-neutral)");
}

// The default (landlock) driver + live kernel proof when the binary is present.
const bin = process.env.NEFERTARI_ENFORCE_BIN;
const rev = enforceWrap("ls", { cls: CLASS.REVERSIBLE, cwd: "/tmp" });

if (bin && fs.existsSync(bin)) {
  assert.equal(rev.file, bin, "reversible commands run under the enforcer when present");
  assert.equal(rev.driver, "landlock");
  assert.ok(rev.args.includes("--allow-write"), "enforcer gets a writable allowlist");
  console.log("  ok — default 'landlock' driver wraps reversible commands");

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
