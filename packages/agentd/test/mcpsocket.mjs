// MCP over a local socket — the daemon as a service the agent connects to,
// rather than a child it owns.
//
// The point is not the transport. It is that a daemon spawned by the agent
// inherits any confinement placed on the agent, and Landlock cannot be relaxed
// by the process that inherited it — so a confined agent would drag the broker,
// the timeline and the journal down with it. Everything below is in service of
// "the daemon can outlive its client".
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nef-sock-home-"));
const SOCK =
  process.platform === "win32"
    ? `\\\\.\\pipe\\nef-test-${process.pid}`
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nef-sock-")), "agentd.sock");

// A minimal client: the framing is newline-delimited JSON-RPC, so a socket needs
// no more than this. Using the SDK's own helpers keeps it honest about the wire
// format rather than reimplementing a guess at it.
function client(sockPath) {
  const socket = net.connect(sockPath);
  const buf = new ReadBuffer();
  const waiting = new Map();
  let nextId = 1;
  socket.on("data", (chunk) => {
    buf.append(chunk);
    for (;;) {
      let msg;
      try {
        msg = buf.readMessage();
      } catch {
        break;
      }
      if (!msg) break;
      const pending = waiting.get(msg.id);
      if (pending) {
        waiting.delete(msg.id);
        pending(msg);
      }
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, resolve);
      socket.write(serializeMessage({ jsonrpc: "2.0", id, method, params }));
      setTimeout(() => (waiting.has(id) ? (waiting.delete(id), reject(new Error(`${method} timed out`))) : null), 8000);
    });
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return { socket, call, ready };
}

const daemon = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "cli.mjs"), "mcp-socket", SOCK], {
  env: { ...process.env, NEFERTARI_HOME: home, NEFERTARI_LOCAL_DRIVER: "null" },
  stdio: "ignore",
});

try {
  // --- it comes up on the socket, with stdin closed: nothing is feeding it ---
  for (let i = 0; i < 60 && !fs.existsSync(SOCK) && process.platform !== "win32"; i++) await sleep(100);
  if (process.platform === "win32") await sleep(2500);
  assert.ok(process.platform === "win32" || fs.existsSync(SOCK), "the socket must appear");
  console.log("  ok — the daemon serves on a socket, not on the agent's stdio");

  // --- the socket is the boundary, so its permissions are the ACL ---
  if (process.platform !== "win32") {
    const mode = fs.statSync(SOCK).mode & 0o777;
    assert.equal(mode, 0o600, `anything that can talk to this can run shell commands; mode was 0${mode.toString(8)}`);
    console.log("  ok — socket is 0600: owner only");
  }

  // --- a real MCP session over it ---
  const c = client(SOCK);
  await c.ready;
  const init = await c.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "socket-test", version: "0" },
  });
  assert.ok(init.result?.serverInfo, `initialize must succeed: ${JSON.stringify(init).slice(0, 200)}`);
  const tools = await c.call("tools/list", {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  assert.ok(names.includes("plan_run") && names.includes("journal_verify"), "the same tool surface as over stdio");
  console.log(`  ok — a real MCP session over the socket (${names.length} tools)`);

  // --- and it actually does work, not just handshake ---
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "nef-sock-ws-"));
  const wrote = await c.call("tools/call", {
    name: "fs_write",
    arguments: { path: path.join(ws, "a.txt"), content: "over the socket" },
  });
  assert.ok(!wrote.error, `fs_write must work: ${JSON.stringify(wrote.error)}`);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "over the socket", "verified on disk, not in the reply");
  console.log("  ok — a tool call over the socket lands on the filesystem");

  // --- a second client is refused with a reason ---
  {
    const second = net.connect(SOCK);
    const said = await new Promise((resolve) => {
      let acc = "";
      second.on("data", (d) => (acc += d.toString()));
      second.on("close", () => resolve(acc));
      second.on("error", () => resolve(acc));
      setTimeout(() => resolve(acc), 3000);
    });
    assert.match(said, /already has a client/, "a second connection must be told why, not just dropped");
    assert.match(said, /multi-agent scheduler/, "and told what would actually be needed");
    console.log("  ok — a second client is refused with a reason");
  }

  // --- the daemon survives its client leaving. This is the whole point. ---
  const pidBefore = daemon.pid;
  c.socket.destroy();
  await sleep(600);
  assert.equal(daemon.exitCode, null, "the daemon must OUTLIVE its client — a child on stdio would have died with it");

  const again = client(SOCK);
  await again.ready;
  const back = await again.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "socket-test-2", version: "0" },
  });
  assert.ok(back.result?.serverInfo, "and accept a new client after the first left");
  assert.equal(daemon.pid, pidBefore, "the same process throughout");
  again.socket.destroy();
  console.log("  ok — the daemon outlives its client and accepts the next one");

  fs.rmSync(ws, { recursive: true, force: true });
} finally {
  daemon.kill("SIGKILL");
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("MCP SOCKET TESTS PASSED");
