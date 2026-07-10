// Optional kernel-level enforcement of the reversibility verdict, via the
// nefertari-enforce binary (Landlock). When it's available and the action is
// REVERSIBLE, the shell command runs confined so it can only write to the
// working dir and /tmp — meaning a command the classifier BELIEVED was
// read-only literally cannot write anywhere else. It's defense-in-depth: even a
// classifier false-negative can't cause a silent write outside the sandbox.
//
// NOISY / system-changing commands (installs, service ops, git) legitimately
// touch system and home paths and are already surfaced to the human, so they
// run unconfined. Irreversible commands never reach here — they're gated first.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLASS } from "./broker.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED = process.env.NEFERTARI_ENFORCE === "1";

function findEnforcer() {
  if (process.env.NEFERTARI_ENFORCE_BIN) return process.env.NEFERTARI_ENFORCE_BIN;
  const candidates = [
    path.resolve(HERE, "../../enforce/target/release/nefertari-enforce"),
    "/usr/local/bin/nefertari-enforce",
  ];
  return (
    candidates.find((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) || null
  );
}

// Returns { file, args } ready for execFile. Falls back to plain bash when the
// enforcer isn't installed (e.g. non-Linux hosts) unless NEFERTARI_ENFORCE=1.
export function enforceWrap(command, { cls, cwd }) {
  const plain = { file: "bash", args: ["-lc", command] };
  if (cls !== CLASS.REVERSIBLE) return plain;

  const bin = findEnforcer();
  if (!bin) {
    if (REQUIRED) throw new Error("NEFERTARI_ENFORCE=1 but the nefertari-enforce binary was not found");
    return plain;
  }

  const args = [];
  for (const w of [cwd, "/tmp"]) args.push("--allow-write", w);
  args.push("--", "bash", "-lc", command);
  return { file: bin, args, enforced: true };
}
