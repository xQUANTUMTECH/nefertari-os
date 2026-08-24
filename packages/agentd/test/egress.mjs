// The context boundary: what an agent is allowed to know.
//   - credential shapes are masked before they reach the context
//   - prose that merely TALKS about keys is left alone
//   - the audit trail never contains the secret it is reporting
//   - warn / refuse / off behave as documented
//   - fs_read and shell output go through the same boundary
//   - with no local model the second tier says so instead of approving
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

process.env.NEFERTARI_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), "nef-home-"));
// No probing of localhost inference servers from a unit test.
process.env.NEFERTARI_LOCAL_DRIVER = "null";

const egress = await import("../src/egress.mjs");
const ops = await import("../src/ops.mjs");
const { classify, CLASS } = await import("../src/broker.mjs");

const withMode = (m, fn) => {
  const prev = process.env.NEFERTARI_EGRESS;
  process.env.NEFERTARI_EGRESS = m;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.NEFERTARI_EGRESS;
    else process.env.NEFERTARI_EGRESS = prev;
  }
};

// --- the shapes that are credentials by construction ---
const SECRETS = {
  "aws-access-key": "AKIAIOSFODNN7EXAMPLE",
  "github-token": "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  "anthropic-key": "sk-ant-" + "api03-abcdefghijklmnopqrstuvwx",
  "openai-key": "sk-" + "proj0123456789abcdefghijklmno",
  "google-api-key": "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
  "stripe-key": "sk_live_" + "51H8xYzAbCdEfGhIjKlMnOp",
  "atlas-key": "apikey-" + "85b183b1a5c043e89cfb9099be45",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
};

for (const [kind, secret] of Object.entries(SECRETS)) {
  const r = withMode("redact", () => egress.screen(`config value here: ${secret} and more text`));
  assert.equal(r.verdict, "redacted", `${kind} must be caught`);
  assert.ok(!r.content.includes(secret), `${kind} must not survive into the context`);
  assert.ok(r.findings.some((f) => f.kind === kind), `${kind} must be reported as ${kind}, got ${JSON.stringify(r.findings.map((f) => f.kind))}`);
}
console.log(`  ok — ${Object.keys(SECRETS).length} credential shapes masked before reaching the context`);

// A PEM block goes whole, not line by line.
{
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmUAAAAEbm9uZQ==\n-----END OPENSSH PRIVATE KEY-----";
  const r = withMode("redact", () => egress.screen(`key follows\n${pem}\ndone`));
  assert.ok(!r.content.includes("b3BlbnNzaC1rZXktdjEA"), "no part of the key body survives");
  assert.equal(r.findings.filter((f) => f.kind === "private-key").length, 1, "reported once, not per line");
  assert.match(r.content, /done/, "the surrounding text is untouched");
  console.log("  ok — a private key is masked as one finding, not forty");
}

// --- and the false positives that would make it unusable ---
{
  const prose = "The API key is stored in the vault; ask ops for the token. See docs/auth.md for how secrets are rotated.";
  const r = withMode("redact", () => egress.screen(prose));
  assert.equal(r.verdict, "clean", `prose about keys must pass through: ${JSON.stringify(r.findings)}`);
  assert.equal(r.content, prose);
  const code = "const apiKey = process.env.OPENAI_API_KEY;\nif (!apiKey) throw new Error('missing');";
  assert.equal(withMode("redact", () => egress.screen(code)).verdict, "clean", "reading a key from env is not a key");
  console.log("  ok — prose and env lookups are not mangled");
}

// --- the audit trail must not undo the module ---
{
  const secret = SECRETS["github-token"];
  const r = withMode("redact", () => egress.screen(`token=${secret}`));
  const dump = JSON.stringify(r.findings);
  assert.ok(!dump.includes(secret), "the finding must not contain the secret");
  assert.ok(dump.length < 300 && !dump.includes(secret.slice(3, 20)), "not even a reconstructable slice of it");
  assert.ok(r.findings[0].length >= 20, "the length is reported, which is safe and useful");
  console.log("  ok — findings report the shape, never the value");
}

// --- modes ---
{
  const text = `key: ${SECRETS["aws-access-key"]}`;
  assert.equal(withMode("off", () => egress.screen(text)).content, text, "off passes everything through");

  const warned = withMode("warn", () => egress.screen(text));
  assert.equal(warned.verdict, "warned");
  assert.equal(warned.content, text, "warn detects and journals but does not alter");
  assert.equal(warned.findings.length, 1);

  assert.throws(
    () => withMode("refuse", () => egress.screen(text)),
    (e) => /refused/.test(e.message) && e.egress?.findings?.length === 1,
    "refuse fails the read and carries the finding"
  );
  console.log("  ok — off / warn / refuse behave as documented");
}

// --- the real doors: fs_read and shell ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nef-eg-"));
  const f = path.join(dir, ".env");
  const secret = SECRETS["stripe-key"];
  fs.writeFileSync(f, `STRIPE_KEY=${secret}\nPORT=3000\n`);

  const r = withMode("redact", () => ops.opFsRead({ path: f }));
  assert.ok(!r.output.includes(secret), "fs_read must not put a live key into the context");
  assert.match(r.output, /PORT=3000/, "the rest of the file still arrives");
  assert.equal(r.meta.egress, "redacted");
  assert.ok(r.meta.kinds.includes("stripe-key"), "the journal records WHAT was withheld");
  console.log("  ok — fs_read masks a key and journals the kind, not the value");

  const shell = await withMode("redact", () =>
    ops.opShell({ command: `echo "AWS=${SECRETS["aws-access-key"]}"`, cwd: dir }, CLASS.REVERSIBLE)
  );
  assert.ok(!shell.output.stdout.includes(SECRETS["aws-access-key"]), "a command's output is screened like a file");
  console.log("  ok — shell output goes through the same boundary");

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- the second tier, absent ---
{
  const j = await egress.judge("some ordinary text about the weather");
  assert.equal(j, null, "with no local model the judgement is null — no opinion, never approval");
  console.log("  ok — no local model means 'not assessed', not 'safe'");
}

assert.equal(classify("egress_check", { path: "/x" }).class, CLASS.REVERSIBLE, "asking is read-only, never gated");
console.log("  ok — egress_check is read-only");

console.log("EGRESS TESTS PASSED");
