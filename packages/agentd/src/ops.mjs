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
  return new Promise((resolve) => {
    execFile(file, execArgs, { cwd: workdir, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      // A command's output reaches the context exactly like a file's contents —
      // `cat .env`, `env`, `git remote -v` — so it is screened the same way.
      const so = egress.screen(String(stdout), { source: "shell", path: workdir });
      const se = egress.screen(String(stderr), { source: "shell", path: workdir });
      const found = [...so.findings, ...se.findings];
      resolve({
        output: { exitCode: err ? (err.code ?? 1) : 0, stdout: so.content, stderr: se.content },
        meta: {
          enforced: !!enforced,
          driver,
          ...(found.length ? { egress: so.verdict === "clean" ? se.verdict : so.verdict, withheld: found.length, kinds: [...new Set(found.map((f) => f.kind))] } : {}),
        },
      });
    });
  });
}
