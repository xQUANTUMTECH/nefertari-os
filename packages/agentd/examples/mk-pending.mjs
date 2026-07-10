// Demo utility: register pending actions in the human gate, so you can watch
// them arrive in the Windows companion (toast + approve/deny) without running
// a full agent session. Usage: node examples/mk-pending.mjs
import * as approvals from "../src/approvals.mjs";

const demos = [
  ["shell", { command: "rm -rf /var/cache/demo" }, "command not in the known-safe allowlist"],
  ["shell", { command: "dd if=/dev/zero of=/dev/sdb" }, "dangerous construct: raw disk write"],
];

for (const [tool, args, reason] of demos) {
  const e = approvals.registerPending(tool, args, reason);
  console.log(`${e.id}  ${tool}  ${JSON.stringify(args)}`);
}
