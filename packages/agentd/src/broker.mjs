// Permission broker: classifies every action before it touches the host.
// Allowlist philosophy: unknown = irreversible = human gate.
//
// Shell classification is defense-in-depth:
//   1. GLOBAL DANGER SCAN over the raw string catches side-effect-enabling
//      constructs (substitution, redirects, pipe-to-interpreter) that a naive
//      per-segment allowlist would miss. Any hit => IRREVERSIBLE.
//   2. Only if the string is free of those constructs do we split into segments
//      and require EVERY segment to be on the safe/noisy allowlist.
// A shell string is Turing-complete, so the safe default is always "gate it".

import { isSensitivePath, classifyNet } from "./policy.mjs";

export const CLASS = {
  REVERSIBLE: "reversible",
  NOISY: "noisy",
  IRREVERSIBLE: "irreversible",
};

// Interpreters / sinks that turn arbitrary input into execution or writes.
const EXEC_SINKS =
  "sh|bash|zsh|dash|ksh|fish|python3?|perl|ruby|node|deno|php|eval|source|exec|tee|dd|xargs|env";

// --- GLOBAL danger constructs: presence anywhere forces IRREVERSIBLE ---
const DANGER = [
  { re: /\$\(/, why: "command substitution $()" },
  { re: /`/, why: "backtick command substitution" },
  { re: /<\(|>\(/, why: "process substitution" },
  { re: /\beval\b/, why: "eval" },
  // pipe (or command chain) feeding an interpreter/sink
  { re: new RegExp(`\\|\\s*(sudo\\s+)?(${EXEC_SINKS})\\b`), why: "pipe into interpreter" },
];

// Redirect targets that create no persistent state (writing to them is a no-op),
// so a redirect to one of these is NOT a reason to gate.
const DISCARD_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

// Find output redirects (`>`, `>>`, `2>`, `&>`, …) and return the first target
// that would actually persist a write. fd-dup like `2>&1` is skipped (the char
// after `>` is `&`); redirects to a discard sink are allowed.
function redirectDanger(cmd) {
  const re = /(?:^|[\s\d&])>>?\s*([^\s&|;<>]+)/g;
  let m;
  while ((m = re.exec(cmd))) {
    if (!DISCARD_SINKS.has(m[1])) return "output redirect to file";
  }
  return null;
}

// find/xargs with destructive actions must gate even though `find` reads.
const FIND_DESTRUCTIVE = /\bfind\b[^|;&]*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/;

// Read-only leading commands (per-segment).
const SAFE_RO = [
  /^(ls|cat|head|tail|wc|stat|file|grep|egrep|fgrep|rg|find|which|whereis|type)\b/,
  /^command\s+-[vV]\b/, // `command -v X` is a read-only lookup (not `command X` which runs X)
  /^(sort|uniq|cut|tr|comm|diff|jq|column|fold|nl|tac|rev)\b/,
  /^(basename|dirname|realpath|readlink|tree|md5sum|sha1sum|sha256sum)\b/,
  /^(ps|top -b|pgrep|pidof|lsof|ss|netstat|ip (a|addr|r|route|link)|ifconfig)\b/,
  /^(df|du|free|uptime|uname|hostname|whoami|id|pwd|env|printenv|date|cal|locale)\b/,
  /^(systemctl (status|list-units|list-unit-files|show|is-active|is-enabled|cat)|journalctl)\b/,
  /^(git (status|log|diff|show|branch|remote|describe|rev-parse|ls-files|blame|tag -l|config --get))( |$)/,
  /^(docker (ps|images|logs|inspect|version|info)|kubectl (get|describe|logs))\b/,
  /^(echo|printf)\b/,
  /^(apt(-get)? (list|show|search)|apt-cache\b|dpkg -l|npm (ls|view|outdated|run)|pip (list|show|freeze)|cargo (tree|--version))\b/,
  /^(less|more|man|help|true|false|test)\b/,
];

// curl/wget are dual-use: a plain GET that prints is fine, but sending data out
// (--data/-F/POST) or writing a file (-o/-O/-T) is not undoable => gate it.
const NET_EXFIL = /(-X\s*(POST|PUT|DELETE|PATCH)|--data(-\w+)?|(^|\s)-d(\s|=|$)|(^|\s)-F(\s|$)|--form|--upload-file|(^|\s)-T(\s|$)|(^|\s)-[oO](\s|$)|--output)/;

// Allowed but worth telling the human about (state-changing, expected).
const NOISY_PATTERNS = [
  /^(sudo )?apt(-get)? install\b/,
  /^(npm (install|i|ci|update)|pnpm (install|add)|yarn( add)?|pip install|cargo install)\b/,
  /^(sudo )?systemctl (start|stop|restart|reload|enable|disable)\b/,
  /^git (add|commit|checkout|switch|stash|fetch|pull|merge --ff-only|init)\b/,
  /^mkdir\b/,
  /^(sudo )?(docker (build|pull|run|start|stop))\b/,
];

function scanDanger(cmd) {
  for (const d of DANGER) if (d.re.test(cmd)) return d.why;
  const rd = redirectDanger(cmd);
  if (rd) return rd;
  if (FIND_DESTRUCTIVE.test(cmd)) return "find with destructive action";
  return null;
}

function classifySegment(seg) {
  const s = seg.trim();
  if (!s) return CLASS.REVERSIBLE;
  if (/^find\b/.test(s) && FIND_DESTRUCTIVE.test(s)) return CLASS.IRREVERSIBLE;
  if (/^(curl|wget)\b/.test(s)) {
    if (NET_EXFIL.test(s)) return CLASS.IRREVERSIBLE;
    // No exfil flags, but a GET with a query string to an untrusted host is
    // still a data-out channel ($VAR expansion the danger scan doesn't catch).
    return classifyNet(s) === "irreversible" ? CLASS.IRREVERSIBLE : CLASS.REVERSIBLE;
  }
  if (SAFE_RO.some((re) => re.test(s))) return CLASS.REVERSIBLE;
  if (NOISY_PATTERNS.some((re) => re.test(s))) return CLASS.NOISY;
  return CLASS.IRREVERSIBLE;
}

export function classifyShell(command) {
  const cmd = (command || "").trim();
  if (!cmd) return CLASS.REVERSIBLE;

  // Step 1 — global danger scan wins over everything.
  if (scanDanger(cmd)) return CLASS.IRREVERSIBLE;

  // Step 2 — split on every separator; the whole is only as safe as its
  // weakest segment. Splitting on `|` is safe here because pipe-into-interpreter
  // was already caught in step 1, so remaining pipes are safe cmd -> safe cmd.
  const segments = cmd.split(/&&|\|\||[|;&\n]/).map((s) => s.trim()).filter(Boolean);
  const classes = segments.map(classifySegment);
  if (classes.includes(CLASS.IRREVERSIBLE)) return CLASS.IRREVERSIBLE;
  if (classes.includes(CLASS.NOISY)) return CLASS.NOISY;
  return CLASS.REVERSIBLE;
}

// Human-readable reason for the shell verdict (used in journal + gate message).
export function shellReason(command) {
  const why = scanDanger((command || "").trim());
  if (why) return `dangerous construct: ${why}`;
  const c = classifyShell(command);
  return c === CLASS.IRREVERSIBLE
    ? "command not in the known-safe allowlist"
    : c === CLASS.NOISY
      ? "known state-changing command"
      : "read-only command";
}

// Tools allowed inside a plan. No plan_run (no nesting), no undo/timeline
// (time travel from inside a transaction would invalidate the transaction).
export const PLAN_TOOLS = ["fs_read", "fs_write", "fs_delete", "shell"];

// A plan's class is the WORST class of its steps, so one irreversible step
// parks the whole plan at the gate before step 1 runs. Returns { class,
// reason, per } — per[i] is the classification of step i (used by the executor).
export function classifyPlan(steps) {
  if (!Array.isArray(steps) || steps.length === 0)
    return { class: CLASS.IRREVERSIBLE, reason: "empty or malformed plan", per: [] };
  // No early return: per[] must cover EVERY step — the executor reads
  // per[i].class after the gate, so a partial per crashes the plan mid-run.
  const per = [];
  let worst = CLASS.REVERSIBLE;
  let reason = `all ${steps.length} steps reversible`;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const c = PLAN_TOOLS.includes(s.tool)
      ? classify(s.tool, s.args || {})
      : { class: CLASS.IRREVERSIBLE, reason: `tool not allowed inside a plan: ${s.tool}` };
    per.push(c);
    if (c.class === CLASS.IRREVERSIBLE && worst !== CLASS.IRREVERSIBLE) {
      worst = CLASS.IRREVERSIBLE;
      reason = `step ${i} (${s.tool}): ${c.reason}`;
    } else if (c.class === CLASS.NOISY && worst === CLASS.REVERSIBLE) {
      worst = CLASS.NOISY;
      reason = `step ${i} (${s.tool}): ${c.reason}`;
    }
  }
  return { class: worst, reason, per };
}

// A trajectories call = K plans + an optional eval command. Its class is the
// WORST across all of them, so one irreversible step in ANY trajectory (or in
// the eval command) parks the whole call at the gate before any fork exists.
export function classifyTrajectories(trajectories, evalCmd) {
  if (!Array.isArray(trajectories) || trajectories.length === 0)
    return { class: CLASS.IRREVERSIBLE, reason: "empty or malformed trajectories" };
  let worst = CLASS.REVERSIBLE;
  let reason = `all ${trajectories.length} trajectories reversible`;
  for (let i = 0; i < trajectories.length; i++) {
    const c = classifyPlan(trajectories[i]?.steps);
    if (c.class === CLASS.IRREVERSIBLE)
      return { class: CLASS.IRREVERSIBLE, reason: `trajectory ${i}: ${c.reason}` };
    if (c.class === CLASS.NOISY && worst === CLASS.REVERSIBLE) {
      worst = CLASS.NOISY;
      reason = `trajectory ${i}: ${c.reason}`;
    }
  }
  if (evalCmd) {
    const c = classifyShell(evalCmd);
    if (c === CLASS.IRREVERSIBLE)
      return { class: CLASS.IRREVERSIBLE, reason: `eval command: ${shellReason(evalCmd)}` };
    if (c === CLASS.NOISY && worst === CLASS.REVERSIBLE) {
      worst = CLASS.NOISY;
      reason = `eval command: ${shellReason(evalCmd)}`;
    }
  }
  return { class: worst, reason };
}

// Classify a tool invocation. Returns { class, reason }.
export function classify(tool, args) {
  switch (tool) {
    case "fs_read":
    case "working_set":
    case "sys_status":
    case "journal_tail":
    case "pending_list":
      return { class: CLASS.REVERSIBLE, reason: "read-only" };
    case "fs_write":
      return isSensitivePath(args.path)
        ? { class: CLASS.IRREVERSIBLE, reason: "write to a sensitive path (startup/cron/service/auth) — effect can fire before undo" }
        : { class: CLASS.REVERSIBLE, reason: "write covered by snapshot" };
    case "fs_delete":
      return isSensitivePath(args.path)
        ? { class: CLASS.IRREVERSIBLE, reason: "delete of a sensitive path (startup/cron/service/auth)" }
        : { class: CLASS.REVERSIBLE, reason: "delete covered by snapshot" };
    case "undo":
      return { class: CLASS.NOISY, reason: "restores prior state" };
    case "timeline_checkpoint":
    case "timeline_fork":
      return { class: CLASS.REVERSIBLE, reason: "copies state into the timeline store, touches nothing outside it" };
    case "timeline_restore":
    case "timeline_promote":
      return { class: CLASS.NOISY, reason: "rewrites the working tree (auto-checkpointed first, so itself undoable)" };
    case "timeline_list":
      return { class: CLASS.REVERSIBLE, reason: "read-only" };
    case "plan_run": {
      const { class: cls, reason } = classifyPlan(args?.steps);
      return { class: cls, reason };
    }
    case "trajectories_run":
      return classifyTrajectories(args?.trajectories, args?.eval_cmd);
    case "shell":
      return { class: classifyShell(args.command || ""), reason: shellReason(args.command || "") };
    default:
      return { class: CLASS.IRREVERSIBLE, reason: "unknown tool" };
  }
}
