// Plan wire shapes: what a model may send and still be understood.
//   - flat steps, nested {args}, and a JSON string of either
//   - trajectories the same way, one level shallower
//   - refusals name the step, the tool and the missing field
//
// Benchmarking found models emitting the wrapper as markup or sending empty
// args, then burning retries on the shape instead of the work. Every case below
// is one of those retries not happening.
import assert from "node:assert";
import { normalizeSteps, normalizeTrajectories } from "../src/planshape.mjs";

// --- the flat form: one nesting level fewer than the original ---
assert.deepEqual(
  normalizeSteps([
    { tool: "fs_write", path: "a.txt", content: "hi" },
    { tool: "shell", command: "npm test" },
  ]),
  [
    { tool: "fs_write", args: { path: "a.txt", content: "hi" } },
    { tool: "shell", args: { command: "npm test" } },
  ]
);
console.log("  ok — flat steps normalize to the executor's shape");

// --- the original nested form still works, unchanged ---
assert.deepEqual(normalizeSteps([{ tool: "fs_read", args: { path: "a.txt" } }]), [
  { tool: "fs_read", args: { path: "a.txt" } },
]);
console.log("  ok — the nested {args} form is untouched");

// --- a JSON string of the array, which is what stringifying models send ---
assert.deepEqual(normalizeSteps('[{"tool":"fs_delete","path":"old.txt"}]'), [
  { tool: "fs_delete", args: { path: "old.txt" } },
]);
console.log("  ok — a JSON string of the array is accepted");

// --- both forms at once: the explicit args object wins, nothing is lost ---
assert.deepEqual(normalizeSteps([{ tool: "fs_write", path: "flat.txt", args: { path: "nested.txt", content: "c" } }]), [
  { tool: "fs_write", args: { path: "nested.txt", content: "c" } },
]);
console.log("  ok — explicit args win over flat fields");

// --- a stray field never reaches an op ---
assert.deepEqual(normalizeSteps([{ tool: "shell", command: "ls", nonsense: "drop me", cwd: "/tmp" }]), [
  { tool: "shell", args: { command: "ls", cwd: "/tmp" } },
]);
console.log("  ok — unknown fields are dropped, not forwarded");

// --- refusals have to be actionable ---
const refuses = (fn, re, what) => {
  assert.throws(fn, (e) => re.test(e.message), what);
};
refuses(() => normalizeSteps([{ tool: "fs_write", path: "a.txt" }]), /missing content.*Send it flat/s, "names the missing field");
refuses(() => normalizeSteps([{ tool: "wat", path: "a" }]), /allowed inside a plan: fs_read, fs_write/, "lists the allowed tools");
refuses(() => normalizeSteps([]), /is empty/, "an empty plan is refused");
refuses(() => normalizeSteps("not json"), /not valid JSON/, "a non-JSON string says so");
refuses(() => normalizeSteps([{ tool: "shell", command: "ls" }, { tool: "fs_read" }]), /steps\[1\]/, "names which step");
console.log("  ok — refusals name the step, the tool and the missing field");

// --- trajectories: same widening, one level deeper ---
assert.deepEqual(
  normalizeTrajectories([{ label: "a", steps: [{ tool: "fs_write", path: "x", content: "1" }] }]),
  [{ label: "a", steps: [{ tool: "fs_write", args: { path: "x", content: "1" } }] }]
);
assert.deepEqual(normalizeTrajectories('[{"steps":[{"tool":"shell","command":"make"}]}]'), [
  { steps: [{ tool: "shell", args: { command: "make" } }] },
]);
refuses(() => normalizeTrajectories([{ label: "a" }]), /has no steps/, "a trajectory without steps is refused");
refuses(
  () => normalizeTrajectories([{ steps: [{ tool: "fs_write", path: "x" }] }]),
  /trajectories\[0\]\.steps\[0\]/,
  "the path to the bad step is spelled out"
);
console.log("  ok — trajectories accept the same shapes and refuse as clearly");

console.log("PLANSHAPE TESTS PASSED");
