// Run the agent itself under confinement, so the broker stops being optional.
//
// Until now the guarantee was circular. The broker classified, snapshotted and
// gated every command that went THROUGH it, and an agent that ran its own shell
// simply was not seen — so "physics, not convention" described the tools rather
// than the agent. This closes it: the agent is started inside a Landlock
// sandbox where the workspace is READ-ONLY, and the only way for it to change
// anything there is to ask the daemon.
//
//   nefertari mcp-socket /run/nefertari.sock &
//   nefertari run --workspace ./project -- claude --mcp nefertari
//
// Two facts make this work, and both were verified rather than assumed:
//
//   1. Landlock is inherited and cannot be relaxed. Whatever the agent spawns —
//      its own shell, a subagent, a build — is confined too, and running the
//      enforcer again with a wider allowlist grants nothing. There is no way
//      out from inside.
//   2. A confined process can still CONNECT to a unix socket outside its
//      allowlist. ABI 3 governs file writes, and connect() is not one, so the
//      daemon stays reachable while the workspace does not.
//
// Which is why the daemon must not be the agent's child — see mcpsocket.mjs. A
// child would inherit this confinement and lose the ability to write the very
// snapshots and journal that make the arrangement worth anything.
//
// READS ARE THE OTHER HALF, and they are the half that matters for secrets.
// Confining writes protects the machine; it does nothing about a credential,
// because an agent that cannot WRITE ~/.aws can still read it — and everything
// an agent reads is sent to a third-party API on its next turn. `--deny-read`
// makes a path unreadable, so the only way to use a credential is to ask the
// daemon to use it on the agent's behalf.
//
// THE LISTS ARE DECLARED, NEVER INFERRED. Only /tmp is writable by default.
// Agents keep state in places that vary by client (~/.claude, ~/.dsh, ~/.grok),
// and guessing at them would either break the agent or quietly widen the hole
// the whole feature exists to close. Name them with --allow.

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { enforcerPath } from "./enforce.mjs";
import * as journal from "./journal.mjs";
import * as cgroups from "./cgroups.mjs";
import * as gatefreeze from "./gatefreeze.mjs";

/**
 * Parse `run`'s own flags, stopping at `--`. Everything after it is the agent's
 * command line and is passed through untouched — an agent's flags are its own
 * business and must not collide with ours.
 */
export function parseArgs(argv) {
  const sep = argv.indexOf("--");
  const mine = sep === -1 ? argv : argv.slice(0, sep);
  const command = sep === -1 ? [] : argv.slice(sep + 1);
  const opts = { workspace: process.cwd(), allow: [], denyRead: [], dryRun: false };
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i];
    if (a === "--workspace" || a === "-w") opts.workspace = mine[++i];
    else if (a === "--allow") opts.allow.push(mine[++i]);
    else if (a === "--deny-read") opts.denyRead.push(mine[++i]);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a} (agent flags go after --)`);
  }
  if (!opts.workspace) throw new Error("--workspace needs a path");
  return { ...opts, command };
}

/**
 * Build the argv that runs `command` confined. Separated from spawning so the
 * decision can be shown with --dry-run and asserted in a test: a sandbox whose
 * shape you cannot inspect is a sandbox nobody will trust.
 */
export function plan({ workspace, allow, denyRead = [], command }) {
  const bin = enforcerPath();
  if (!bin) {
    throw new Error(
      "no Landlock enforcer found. Build it with `cargo build --release` in packages/enforce, or set " +
        "NEFERTARI_ENFORCE_BIN. Running the agent unconfined would look identical and guarantee nothing, " +
        "so this refuses instead."
    );
  }
  if (!command.length) throw new Error("nothing to run: put the agent's command after --");

  const ws = path.resolve(workspace);
  if (!fs.existsSync(ws)) throw new Error(`workspace does not exist: ${ws}`);

  const writable = ["/tmp", ...allow.map((p) => path.resolve(p))];

  // The containment has to be checked in BOTH directions, and the second is the
  // one that bites. A declared path inside the workspace punches a hole through
  // it; a workspace inside a declared path makes the whole sandbox vacuous —
  // and /tmp is writable by default, so a workspace under /tmp confines nothing
  // at all while looking exactly like one that does.
  //
  // Found by the test, not by reading: the first version refused the first case
  // and shipped the second, and the agent wrote the workspace directly with the
  // sandbox reporting itself active.
  const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep) || child.startsWith(parent + "/");
  for (const w of writable) {
    if (inside(w, ws)) {
      throw new Error(
        `--allow ${w} is inside the workspace. The workspace is exactly what must stay read-only: ` +
          `let the agent write it through the daemon instead.`
      );
    }
    if (inside(ws, w)) {
      throw new Error(
        `the workspace ${ws} is inside the writable path ${w}, so confining the agent would guarantee ` +
          `nothing while appearing to work. Move the workspace outside it` +
          (w === "/tmp" ? ", or run with a workspace that is not under /tmp." : ", or drop that --allow.")
      );
    }
  }

  const unreadable = denyRead.map((p) => path.resolve(p));
  // Denying a read inside the workspace would leave the agent unable to see the
  // code it is meant to work on, which is not a boundary, it is a broken setup.
  for (const d of unreadable) {
    if (inside(d, ws)) {
      throw new Error(
        `--deny-read ${d} is inside the workspace. The agent has to be able to READ what it works on; ` +
          `what it must not do is write it behind the broker's back.`
      );
    }
  }

  const args = [];
  for (const w of writable) args.push("--allow-write", w);
  for (const d of unreadable) args.push("--deny-read", d);
  args.push("--", ...command);
  return { file: bin, args, writable, unreadable, workspace: ws };
}

export async function run(argv) {
  const opts = parseArgs(argv);
  const p = plan(opts);

  if (opts.dryRun) {
    return { ...p, spawned: false };
  }

  journal.append({
    tool: "run",
    class: "noisy",
    decision: "executed",
    outcome:
      `agent confined: workspace ${p.workspace} read-only, writable ${p.writable.join(", ")}` +
      (p.unreadable.length ? `, unreadable ${p.unreadable.join(", ")}` : ""),
    command: opts.command.join(" ").slice(0, 200),
  });

  // The agent goes into a cgroup of its own, so the gate can stop the whole
  // tree — the agent AND whatever it left running — while a human decides.
  // Best-effort: on a host without cgroup v2 the agent runs exactly as before,
  // because confinement is the guarantee here and this is an optimisation.
  const group = `agent-${process.pid}`;
  const cg = cgroups.ensure(group);

  // The process joins the group ITSELF, before exec. Moving it afterwards is a
  // race the mover usually loses: a shell forks its pipeline within
  // microseconds and those grandchildren stay where the shell was. Measured
  // once as a busy pipeline reporting less CPU than a sleep.
  const [file, args] = cg.ok
    ? ["/bin/sh", ["-c", `echo $$ > ${cgroups.procsPath(group)}; exec "$0" "$@"`, p.file, ...p.args]]
    : [p.file, p.args];

  const child = spawn(file, args, { stdio: "inherit", cwd: p.workspace });
  if (cg.ok) gatefreeze.registerAgent({ cgroup: group, pid: child.pid, command: opts.command.join(" ").slice(0, 200) });
  return await new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      // A stale registration would let the gate freeze a pid the OS has since
      // handed to somebody else.
      gatefreeze.clearAgent();
      if (cg.ok) cgroups.destroy(group);
      resolve({ ...p, spawned: true, code, signal, cgroup: cg.ok ? group : null });
    });
    child.on("error", (e) => resolve({ ...p, spawned: false, error: e.message }));
  });
}
