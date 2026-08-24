// Core operations behind the MCP tools. Extracted so the single tools and the
// plan executor share ONE implementation (same snapshotting, same enforcement).
// Callers own gating and journaling; ops only do the work.
// Each op returns { output, meta } — output is what the caller returns to the
// model, meta is what the caller journals.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import * as snapshots from "./snapshots.mjs";
import { enforceWrap } from "./enforce.mjs";
import * as egress from "./egress.mjs";
import * as cgroups from "./cgroups.mjs";
import crypto from "node:crypto";

export function opFsRead({ path: p }) {
  const data = fs.readFileSync(p, "utf8");
  // The context boundary sits here rather than at the outbound API call, which
  // is not ours to see. What the agent never reads, it cannot forward.
  const s = egress.screen(data, { source: "fs_read", path: p });
  return {
    output: s.content,
    meta: {
      bytes: s.content.length,
      ...(s.findings.length ? { egress: s.verdict, withheld: s.findings.length, kinds: [...new Set(s.findings.map((f) => f.kind))] } : {}),
    },
  };
}

export function opFsWrite({ path: p, content }) {
  const snapId = snapshots.snapshot([p], { tool: "fs_write" });
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  fs.writeFileSync(p, content);
  return {
    output: { status: "written", path: p, snapshot_id: snapId },
    meta: { snapshotId: snapId, bytes: content.length },
  };
}

export function opFsDelete({ path: p }) {
  if (!fs.existsSync(p)) return { output: { status: "noop", reason: "file does not exist" }, meta: null };
  if (fs.statSync(p).isDirectory())
    return { output: { status: "refused", reason: "directories are not deletable in phase 1 (not snapshot-covered)" }, meta: null };
  const snapId = snapshots.snapshot([p], { tool: "fs_delete" });
  fs.rmSync(p);
  return { output: { status: "deleted", path: p, snapshot_id: snapId }, meta: { snapshotId: snapId } };
}

export function opShell({ command, cwd }, cls) {
  const workdir = cwd || os.homedir();
  // Reversible commands run under the enforcement driver (writes confined to
  // workdir + /tmp) when available; everything else runs plain.
  const { file, args: execArgs, enforced, driver } = enforceWrap(command, { cls, cwd: workdir });

  // A cgroup of its own, so the command is a thing the OS can be told about
  // rather than an anonymous child: what CPU it actually consumed, and later
  // whether to freeze it or let it yield. Where cgroups are unavailable — a
  // laptop, an ordinary container — this is silently nothing and the command
  // runs exactly as before.
  const group = `sh-${crypto.randomBytes(4).toString("hex")}`;
  const grouped = cgroups.ensure(group).ok;

  // The command joins the group ITSELF, before exec, rather than being moved
  // into it afterwards. Moving afterwards is a race that a pipeline wins: the
  // shell forks its members within microseconds and they stay wherever it was
  // at the time. It does not merely lose a little accuracy — measured, it
  // reported a busy `head | md5sum` as 507us of CPU and a `sleep 0.4` as
  // 11655us, which is the answer inverted.
  //
  // The write happens BEFORE the enforcer runs, which is the only order that
  // works: Landlock confines writes to the workspace, and /sys/fs/cgroup is not
  // in it.
  let spawnFile = file;
  let spawnArgs = execArgs;
  if (grouped) {
    spawnFile = "/bin/sh";
    spawnArgs = ["-c", `echo $$ > ${cgroups.procsPath(group)}; exec "$0" "$@"`, file, ...execArgs];
  }

  return new Promise((resolve) => {
    execFile(spawnFile, spawnArgs, { cwd: workdir, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      // A command's output reaches the context exactly like a file's contents —
      // `cat .env`, `env`, `git remote -v` — so it is screened the same way.
      const so = egress.screen(String(stdout), { source: "shell", path: workdir });
      const se = egress.screen(String(stderr), { source: "shell", path: workdir });
      const found = [...so.findings, ...se.findings];
      // Read before the group is torn down: the counters go with it.
      const used = grouped ? cgroups.usage(group) : null;
      resolve({
        output: { exitCode: err ? (err.code ?? 1) : 0, stdout: so.content, stderr: se.content },
        meta: {
          enforced: !!enforced,
          driver,
          ...(used?.usage_usec != null ? { cpu_usec: used.usage_usec } : {}),
          ...(found.length ? { egress: so.verdict === "clean" ? se.verdict : so.verdict, withheld: found.length, kinds: [...new Set(found.map((f) => f.kind))] } : {}),
        },
      });
      // The kernel needs a moment to reap the exited process before the
      // directory can go; a failed rmdir here is not worth an error path, the
      // next ensure() with the same name would simply adopt it.
      if (grouped) setTimeout(() => cgroups.destroy(group), 50).unref?.();
    });
  });
}
