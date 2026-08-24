// The agent itself, confined — the test that decides whether this project's
// central sentence is true or merely tidy.
//
// Everything else here classifies, snapshots and gates what goes THROUGH the
// broker. That is worth nothing if the agent can open a shell and write the same
// files behind its back. So the claim to check is exactly one:
//
//   an agent started this way CANNOT write the workspace directly,
//   and CAN still change it by asking the daemon.
//
// Both halves matter. The first alone is a sandbox; the second alone is a
// convention. Together they are the argument.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import assert from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { parseArgs, plan } from "../src/run.mjs";
import { enforcerPath } from "../src/enforce.mjs";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.mjs");

// --- the shape of the sandbox is inspectable, everywhere ---
{
  const a = parseArgs(["--workspace", "/w", "--allow", "/var/agent", "--", "claude", "--flag", "-x"]);
  assert.deepEqual(a.command, ["claude", "--flag", "-x"], "the agent's own flags pass through untouched");
  assert.deepEqual(a.allow, ["/var/agent"]);
  assert.throws(() => parseArgs(["--nonsense"]), /unknown option/, "our flags are ours, and typos are not silently ignored");
  console.log("  ok — flags stop at --, and the agent's are its own");
}

if (!enforcerPath()) {
  console.log("  skip — no Landlock enforcer on this host; the rest of this test is the enforcement itself");
  console.log("RUN TESTS PASSED (argument parsing only)");
  process.exit(0);
}

// NOT under /tmp: /tmp is writable by default, and a workspace inside a
// writable path is a sandbox that guarantees nothing. plan() refuses that
// outright now — see the next block — but the enforcement tests need a
// workspace where enforcement can actually happen.
const wsRoot = fs.existsSync("/workspace") ? "/workspace" : os.homedir();
const ws = fs.mkdtempSync(path.join(wsRoot, "nef-run-ws-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-run-home-"));
fs.writeFileSync(path.join(ws, "existing.txt"), "before");

// --- a workspace inside a writable path is refused: the sandbox would be vacuous ---
{
  const under = fs.mkdtempSync(path.join(os.tmpdir(), "nef-under-tmp-"));
  assert.throws(
    () => plan({ workspace: under, allow: [], command: ["true"] }),
    /inside the writable path/,
    "a workspace under /tmp confines nothing, and must not look like it does"
  );
  fs.rmSync(under, { recursive: true, force: true });
  console.log("  ok — a workspace inside a writable path is refused, not silently vacuous");
}

// --- a hole punched inside the workspace is refused, and named ---
{
  assert.throws(
    () => plan({ workspace: ws, allow: [path.join(ws, "scratch")], command: ["true"] }),
    /inside the workspace/,
    "allowing a path inside the workspace would silently defeat the whole feature"
  );
  const p = plan({ workspace: ws, allow: ["/var/agentstate"], command: ["claude"] });
  assert.ok(p.args.includes("--allow-write") && p.args.includes("/tmp"), "/tmp is writable by default");
  assert.ok(!p.args.includes(ws), "the workspace is never in the allowlist");
  assert.deepEqual(p.args.slice(-1), ["claude"], "the command comes last, after --");
  console.log("  ok — the workspace is never writable, and a hole inside it is refused by name");
}

// --- FIRST HALF: the confined agent cannot write the workspace ---
{
  const target = path.join(ws, "sneaked.txt");
  const p = plan({ workspace: ws, allow: [], command: ["/bin/sh", "-c", `echo sneaked > ${target}`] });
  let failed = false;
  try {
    execFileSync(p.file, p.args, { stdio: "pipe" });
  } catch {
    failed = true;
  }
  assert.ok(failed, "the write must fail");
  assert.ok(!fs.existsSync(target), "PHYSICAL: the file must not exist. A refusal the filesystem disagrees with is not one");
  console.log("  ok — the agent cannot write the workspace directly");
}

// --- and cannot escape by re-running the enforcer with a wider allowlist ---
{
  const target = path.join(ws, "escaped.txt");
  const p = plan({
    workspace: ws,
    allow: [],
    command: [enforcerPath(), "--allow-write", ws, "--", "/bin/sh", "-c", `echo escaped > ${target}`],
  });
  try {
    execFileSync(p.file, p.args, { stdio: "pipe" });
  } catch {
    /* expected */
  }
  assert.ok(!fs.existsSync(target), "Landlock cannot be relaxed from inside: asking again must grant nothing");
  console.log("  ok — it cannot widen its own sandbox from inside");
}

// --- SECOND HALF: it can still change the workspace by asking the daemon ---
const SOCK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nef-run-sock-")), "d.sock");
const daemon = spawn(process.execPath, [CLI, "mcp-socket", SOCK], {
  env: { ...process.env, NEFERTARI_HOME: home, NEFERTARI_LOCAL_DRIVER: "null" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 60 && !fs.existsSync(SOCK); i++) await sleep(100);
  assert.ok(fs.existsSync(SOCK), "the daemon must be listening");

  // The client runs CONFINED, exactly as the agent would, and talks to the
  // daemon over the socket. This is the arrangement the feature exists to
  // create, exercised rather than described.
  const asker = path.join(os.tmpdir(), `nef-asker-${process.pid}.mjs`);
  fs.writeFileSync(
    asker,
    `import net from "node:net";
import { ReadBuffer, serializeMessage } from ${JSON.stringify(
      path.join(import.meta.dirname, "..", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "shared", "stdio.js")
    )};
const s = net.connect(process.argv[2]);
const buf = new ReadBuffer();
const want = new Map();
let id = 1;
s.on("data", (c) => { buf.append(c); for(;;){ let m; try { m = buf.readMessage(); } catch { break; } if(!m) break; const f = want.get(m.id); if(f){want.delete(m.id); f(m);} } });
const call = (method, params) => new Promise((res) => { const i = id++; want.set(i, res); s.write(serializeMessage({ jsonrpc:"2.0", id:i, method, params })); });
await new Promise((r) => s.once("connect", r));
await call("initialize", { protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{ name:"confined-agent", version:"0" } });
const r = await call("tools/call", { name:"fs_write", arguments:{ path: process.argv[3], content: "written through the broker" } });
console.log(r.error ? "ERROR " + JSON.stringify(r.error) : "OK");
s.destroy();
`
  );

  const asked = path.join(ws, "asked.txt");
  const p = plan({ workspace: ws, allow: [], command: [process.execPath, asker, SOCK, asked] });
  const out = execFileSync(p.file, p.args, { stdio: "pipe" }).toString();
  assert.match(out, /OK/, `the confined agent must reach the daemon: ${out}`);
  assert.equal(
    fs.readFileSync(asked, "utf8"),
    "written through the broker",
    "PHYSICAL: the workspace changed — through the broker, which is the only door left open"
  );
  console.log("  ok — it CAN change the workspace by asking the daemon");

  // --- and that write went through the broker, so it is on the record ---
  const journalFile = path.join(home, "journal.jsonl");
  const entries = fs
    .readFileSync(journalFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(
    entries.some((e) => e.tool === "fs_write" && e.args?.path === asked && e.decision === "executed"),
    "the only way in is also the way that gets recorded — which is the point of closing the other one"
  );
  console.log("  ok — and the change is in the journal, because the broker is now unavoidable");

  fs.rmSync(asker, { force: true });
} finally {
  daemon.kill("SIGKILL");
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("RUN TESTS PASSED");
