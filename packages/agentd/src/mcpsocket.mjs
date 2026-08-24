// MCP over a local socket, so the daemon can outlive the agent instead of being
// its child.
//
// This exists for one reason, and it is not convenience. Landlock restrictions
// are inherited by children and cannot be relaxed — verified: a child of a
// confined process is confined, and running the enforcer again with a wider
// allowlist grants nothing. So while `agentd` is spawned by the agent over
// stdio, confining the agent would confine the broker with it, and the daemon
// could no longer write the snapshots, the timeline or the journal that make
// its guarantees real.
//
// Which means "physics, not convention" is, today, circular: the broker is
// unavoidable only for commands that already went through it, and an agent that
// runs its own shell simply is not seen. Breaking that circle needs the daemon
// to be a service the agent CONNECTS to rather than a process it OWNS.
//
//   nefertari mcp-socket /run/nefertari.sock
//
// A LISTENER, NOT A SERVER. Each connection gets a freshly spawned server.mjs
// with the socket as its stdin and stdout — which is inetd's shape, and it is
// here for two reasons rather than nostalgia:
//
//   1. An McpServer cannot be reconnected. Serving a second client from one
//      long-lived instance looks like it works, accepts the socket, and then
//      never answers `initialize` — a hang rather than an error, which is the
//      worst way for this to fail.
//   2. A process per client is better isolation than a shared one, and it is
//      what makes the daemon genuinely outlive its clients: the listener holds
//      no session state to corrupt.
//
// The socket is the boundary, so its permissions are the ACL: 0600, owner only.
// Anything that can talk to it can run shell commands as this user — the same
// authority the daemon already has and no more, but worth being deliberate
// about rather than inheriting whatever umask was set.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as journal from "./journal.mjs";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs");
const isPipe = (p) => p.startsWith("\\\\.\\pipe\\") || p.startsWith("//./pipe/");

/**
 * Listen on a unix socket (or a Windows named pipe) and serve one agentd per
 * connection. Resolves once it is listening.
 */
export async function listen(socketPath) {
  // A socket file left by a crashed daemon makes bind fail with EADDRINUSE and
  // looks exactly like "another daemon is already running". Tell the two apart
  // by trying to connect: if nobody answers, the file is a corpse.
  if (!isPipe(socketPath) && fs.existsSync(socketPath)) {
    const alive = await new Promise((resolve) => {
      const probe = net.connect(socketPath);
      probe.on("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.on("error", () => resolve(false));
    });
    if (alive) throw new Error(`another daemon is already listening on ${socketPath}`);
    fs.rmSync(socketPath, { force: true });
  }

  let current = null; // the child serving the connected client, if any

  const listener = net.createServer((socket) => {
    if (current) {
      // Said in the protocol's own shape, so a client sees an error rather than
      // a socket that closes for no stated reason.
      socket.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "this daemon already has a client. One agent per daemon: sharing a broker, a timeline and an approval queue between two is the multi-agent scheduler, not a second connection.",
          },
          id: null,
        }) + "\n"
      );
      return;
    }

    // The socket becomes the child's stdin and stdout, so server.mjs needs no
    // knowledge of any of this: from inside, it is talking over stdio exactly
    // as it always has.
    const child = spawn(process.execPath, [SERVER], {
      stdio: [socket, socket, "inherit"],
      env: process.env,
    });
    current = child;

    const done = () => {
      if (current === child) current = null;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      socket.destroy();
    };
    child.on("exit", done);
    child.on("error", done);
    socket.on("close", done);
    socket.on("error", done);
  });

  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(socketPath, () => {
      listener.removeListener("error", reject);
      resolve();
    });
  });

  if (!isPipe(socketPath)) {
    // Set after listen: the file does not exist before it, and a window in
    // which it is world-writable is a window in which it is world-usable.
    fs.chmodSync(socketPath, 0o600);
  }

  const cleanup = () => {
    try {
      listener.close();
    } catch {
      /* closing twice is fine */
    }
    if (current) {
      try {
        current.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    if (!isPipe(socketPath)) fs.rmSync(socketPath, { force: true });
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

  journal.append({
    tool: "agentd",
    class: "noisy",
    decision: "executed",
    outcome: `listening on ${socketPath}`,
  });

  return { close: cleanup, path: socketPath };
}
