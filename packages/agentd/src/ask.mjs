// The line the person draws, on top of the one the broker draws.
//
// The broker answers "is this undoable". A person asks something else — "don't
// delete anything without asking me" — which is about intent, not physics.
// Driving a tidy-up through the broker showed the two come apart: it gated a
// move inside the folder (unknown command) and let a delete through in silence
// (snapshotted, therefore reversible). Both right on the broker's axis, both
// backwards on the person's.
//
// NEFERTARI_ASK names tools that must reach the human gate whatever the broker
// thinks: "fs_delete,shell:git push,http_as". An entry is a tool name, or
// tool:REGEX with the regex tested against the arguments as JSON; "*" matches
// every tool. It only ever tightens — a rule can send an action to the gate,
// never past it — and the pending entry names the rule that did, so the record
// shows the line as it was drawn. Read from the environment on every call, so a
// rule is exactly as durable as the shell that declared it.

export function rules() {
  return (process.env.NEFERTARI_ASK || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(":");
      return i < 0 ? { tool: s } : { tool: s.slice(0, i), pattern: s.slice(i + 1) };
    });
}

/** The reason to gate this call under a declared rule, or null. */
export function match(tool, args) {
  for (const r of rules()) {
    if (r.tool !== tool && r.tool !== "*") continue;
    if (r.pattern) {
      let re;
      try {
        re = new RegExp(r.pattern);
      } catch {
        continue; // a rule that does not parse gates nothing, and says so in sys_status
      }
      if (!re.test(JSON.stringify(args ?? {}))) continue;
    }
    return `ask rule ${r.tool}${r.pattern ? ":" + r.pattern : ""}: the person asked to be consulted before this`;
  }
  return null;
}
