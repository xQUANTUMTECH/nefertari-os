// Accept the shapes models actually emit for plans and trajectories.
//
// plan_run asked for [{tool, args:{...}}] and trajectories_run for
// [{label, steps:[{tool, args:{...}}]}] — three levels of nesting on the call
// that matters most. Benchmarking found what that costs: a model would emit the
// wrapper as markup, or send a step whose args came back empty, and burn retries
// on a shape rather than on the work. A primitive only strong models can address
// is not a primitive, and cheap models are the whole point of running locally.
//
// So the wire shape widens and the semantics do not:
//
//   - steps may arrive as an ARRAY or as a JSON STRING of one (ocs_run already
//     accepts both for its document; models that stringify structured fields are
//     common enough that refusing them is a self-inflicted failure).
//   - a step may be FLAT — {tool, path, content} — instead of nesting an args
//     object. One less level to get right, and the field names are the ones the
//     tool documentation already uses.
//   - the nested {tool, args:{...}} form keeps working unchanged.
//
// Anything genuinely wrong fails with a message naming the step, the tool and
// the missing field, because a model that is told what is missing fixes it on
// the next turn, while one told "invalid arguments" guesses again.

import { PLAN_TOOLS } from "./broker.mjs";

// Which flat fields belong to which tool. Also drives the "you forgot X" error.
const REQUIRED = {
  fs_read: ["path"],
  fs_write: ["path", "content"],
  fs_delete: ["path"],
  shell: ["command"],
};
const OPTIONAL = { shell: ["cwd"] };
const FLAT_FIELDS = ["path", "content", "command", "cwd"];

function parseMaybeJson(value, what) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${what} is an empty string`);
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`${what} is a string but not valid JSON: ${e.message}`);
  }
}

function normalizeStep(raw, where) {
  const step = parseMaybeJson(raw, where);
  if (!step || typeof step !== "object" || Array.isArray(step))
    throw new Error(`${where} must be an object like {"tool":"fs_write","path":"a.txt","content":"hi"}`);

  const tool = step.tool;
  if (!PLAN_TOOLS.includes(tool))
    throw new Error(`${where} has tool "${tool ?? "(missing)"}"; allowed inside a plan: ${PLAN_TOOLS.join(", ")}`);

  // Flat fields first, explicit args on top: a caller that sends both means the
  // args object, and neither form silently loses to the other.
  const nested = parseMaybeJson(step.args ?? {}, `${where}.args`) || {};
  if (typeof nested !== "object" || Array.isArray(nested))
    throw new Error(`${where}.args must be an object`);

  const args = {};
  for (const f of FLAT_FIELDS) if (step[f] !== undefined) args[f] = step[f];
  Object.assign(args, nested);

  const missing = (REQUIRED[tool] || []).filter((f) => args[f] === undefined);
  if (missing.length) {
    const example = { tool, ...Object.fromEntries((REQUIRED[tool] || []).map((f) => [f, `<${f}>`])) };
    throw new Error(
      `${where} (${tool}) is missing ${missing.join(" and ")}. ` +
        `Send it flat: ${JSON.stringify(example)}`
    );
  }

  // Keep only fields the tool understands, so a stray key cannot reach an op.
  const keep = [...(REQUIRED[tool] || []), ...(OPTIONAL[tool] || [])];
  const clean = {};
  for (const f of keep) if (args[f] !== undefined) clean[f] = args[f];
  return { tool, args: clean };
}

export function normalizeSteps(steps, where = "steps") {
  const arr = parseMaybeJson(steps, where);
  if (!Array.isArray(arr)) throw new Error(`${where} must be an array of steps (or a JSON string of one)`);
  if (arr.length === 0) throw new Error(`${where} is empty — a plan needs at least one step`);
  return arr.map((s, i) => normalizeStep(s, `${where}[${i}]`));
}

export function normalizeTrajectories(trajectories) {
  const arr = parseMaybeJson(trajectories, "trajectories");
  if (!Array.isArray(arr)) throw new Error("trajectories must be an array (or a JSON string of one)");
  if (arr.length === 0) throw new Error("trajectories is empty — give at least one alternative to try");
  return arr.map((raw, i) => {
    const t = parseMaybeJson(raw, `trajectories[${i}]`);
    if (!t || typeof t !== "object" || Array.isArray(t))
      throw new Error(`trajectories[${i}] must be an object like {"label":"a","steps":[...]}`);
    // A trajectory that is only its steps is unambiguous, and one nesting level
    // shallower for the model.
    const steps = t.steps !== undefined ? t.steps : Array.isArray(raw) ? raw : undefined;
    if (steps === undefined) throw new Error(`trajectories[${i}] has no steps`);
    return {
      ...(t.label !== undefined ? { label: String(t.label) } : {}),
      steps: normalizeSteps(steps, `trajectories[${i}].steps`),
    };
  });
}
