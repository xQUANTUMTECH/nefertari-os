// OCS v0 — Organism Control Surface AST parse / compile / run.
// Freeze: agent-engine-template-sdk/docs/organismo/OCS-AST-V0.md
// Report: CONTRACTS-V0.md OcsReport
//
// v0 steps only (no fork/traj/await/sense/macro). Asserts run in this runner,
// not as plan_run shell. Executable steps lower to { tool, args } and execute
// sequentially via ops.mjs (avoids plan_run gate complexity for mkdir/node -e).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ops from "./ops.mjs";
import * as approvals from "./approvals.mjs";
import { classifyShell } from "./broker.mjs";

const V0_OPS = new Set([
  "ensure_dir",
  "ensure_file",
  "run",
  "assert_path_exists",
  "assert_last_exit",
  "read",
]);
// v0.1 meso ops — accepted; sense/await stub or skip in run; macro expanded if macros present
const V01_OPS = new Set(["sense", "await", "macro", "assert_outcome"]);

function applyVars(value, vars) {
  if (typeof value !== "string" || !vars || typeof vars !== "object") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  );
}

function resolveUnder(root, p) {
  if (typeof p !== "string" || !p) throw new Error("path is required");
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.resolve(root, p);
}

function shellMkdirCommand(absDir) {
  // Cross-platform recursive mkdir via node (works on win/linux/mac).
  const js = `require("fs").mkdirSync(${JSON.stringify(absDir)},{recursive:true})`;
  return `node -e ${JSON.stringify(js)}`;
}

function validateStep(step, i) {
  if (!step || typeof step !== "object" || Array.isArray(step))
    throw new Error(`parseOcs: step ${i} must be an object`);
  if (typeof step.op !== "string" || (!V0_OPS.has(step.op) && !V01_OPS.has(step.op)))
    throw new Error(`parseOcs: step ${i} unknown or missing op ${JSON.stringify(step?.op)} (v0/v0.1)`);

  switch (step.op) {
    case "ensure_dir":
      if (typeof step.path !== "string" || !step.path)
        throw new Error(`parseOcs: step ${i} ensure_dir requires path`);
      break;
    case "ensure_file":
      if (typeof step.path !== "string" || !step.path)
        throw new Error(`parseOcs: step ${i} ensure_file requires path`);
      if (typeof step.content !== "string")
        throw new Error(`parseOcs: step ${i} ensure_file requires content string`);
      if (step.if_exists != null && step.if_exists !== "skip" && step.if_exists !== "overwrite")
        throw new Error(`parseOcs: step ${i} ensure_file if_exists must be skip|overwrite`);
      break;
    case "run":
      if (typeof step.cmd !== "string" || !step.cmd)
        throw new Error(`parseOcs: step ${i} run requires cmd`);
      break;
    case "assert_path_exists":
      if (typeof step.path !== "string" || !step.path)
        throw new Error(`parseOcs: step ${i} assert_path_exists requires path`);
      break;
    case "assert_last_exit":
      if (step.code != null && typeof step.code !== "number")
        throw new Error(`parseOcs: step ${i} assert_last_exit code must be a number`);
      break;
    case "read":
      if (typeof step.path !== "string" || !step.path)
        throw new Error(`parseOcs: step ${i} read requires path`);
      break;
    case "sense":
      break;
    case "await":
      if (step.on != null && !["pending", "port", "path", "ms"].includes(step.on))
        throw new Error(`parseOcs: step ${i} await.on invalid`);
      break;
    case "macro":
      if (typeof step.name !== "string" || !step.name)
        throw new Error(`parseOcs: step ${i} macro requires name`);
      break;
    case "assert_outcome":
      if (typeof step.claim !== "string" || !step.claim)
        throw new Error(`parseOcs: step ${i} assert_outcome requires claim`);
      break;
  }
}

/**
 * Accept object or JSON string; validate ocs==="0" and steps.
 * @returns {object} parsed OcsDoc
 */
export function parseOcs(input) {
  let doc = input;
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input);
    } catch (e) {
      throw new Error(`parseOcs: invalid JSON: ${e.message}`);
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error("parseOcs: expected object or JSON string");
  if (doc.ocs !== "0" && doc.ocs !== "0.1")
    throw new Error(`parseOcs: ocs must be "0" or "0.1", got ${JSON.stringify(doc.ocs)}`);
  if (!Array.isArray(doc.steps))
    throw new Error("parseOcs: steps must be an array");
  for (let i = 0; i < doc.steps.length; i++) validateStep(doc.steps[i], i);
  return doc;
}

/**
 * Lower OCS steps to plan_run-like steps: { tool: "fs_write"|"fs_read"|"shell", args }.
 * assert_* are not lowered (runner evaluates them).
 * ensure_file if_exists:"skip" is marked with if_exists on the step for the runner.
 */
/** Expand macros in-document (v0.1). */
function expandMacrosLocal(doc) {
  const macros = doc.macros && typeof doc.macros === "object" ? doc.macros : {};
  const out = [];
  function walk(steps, depth, stack) {
    if (depth > 8) throw new Error("macro max depth");
    for (const step of steps) {
      if (step.op === "macro") {
        const name = step.name;
        if (!macros[name]) throw new Error(`unknown macro ${name}`);
        if (stack.includes(name)) throw new Error(`macro cycle ${name}`);
        walk(macros[name], depth + 1, stack.concat(name));
      } else out.push(step);
    }
  }
  walk(doc.steps || [], 0, []);
  return out;
}

export function compileOcs(doc, { projectRoot } = {}) {
  const d = doc?.ocs === "0" || doc?.ocs === "0.1" ? doc : parseOcs(doc);
  const root = path.resolve(projectRoot || d.meta?.project || process.cwd());
  const vars = d.vars && typeof d.vars === "object" ? d.vars : {};
  const steps = [];
  const flatSteps = expandMacrosLocal(d);

  for (let i = 0; i < flatSteps.length; i++) {
    const raw = flatSteps[i];
    const op = raw.op;
    const p = raw.path != null ? applyVars(raw.path, vars) : undefined;
    const content = raw.content != null ? applyVars(raw.content, vars) : undefined;
    const cmd = raw.cmd != null ? applyVars(raw.cmd, vars) : undefined;
    const cwd = raw.cwd != null ? applyVars(raw.cwd, vars) : undefined;

    switch (op) {
      case "ensure_dir": {
        const abs = resolveUnder(root, p);
        steps.push({ tool: "shell", args: { command: shellMkdirCommand(abs) } });
        break;
      }
      case "ensure_file": {
        const abs = resolveUnder(root, p);
        const ifExists = raw.if_exists || "overwrite";
        const step = {
          tool: "fs_write",
          args: { path: abs, content: content ?? "" },
        };
        if (ifExists === "skip") step.if_exists = "skip";
        steps.push(step);
        break;
      }
      case "run": {
        const work = cwd ? resolveUnder(root, cwd) : root;
        steps.push({ tool: "shell", args: { command: cmd, cwd: work } });
        break;
      }
      case "read": {
        const abs = resolveUnder(root, p);
        steps.push({ tool: "fs_read", args: { path: abs } });
        break;
      }
      case "assert_path_exists":
      case "assert_last_exit":
      case "sense":
      case "await":
      case "assert_outcome":
        // runner-only / stub
        break;
      default:
        throw new Error(`compileOcs: unhandled op ${op}`);
    }
  }

  return { projectRoot: root, steps };
}

/**
 * Run an OCS document. dry_run returns expanded plan without side effects.
 * @returns {Promise<import('./ocs-types').OcsReport>}
 */
export async function runOcs(doc, opts = {}) {
  let d;
  try {
    d = parseOcs(doc);
  } catch (e) {
    return {
      status: "failed",
      asserts: [],
      steps_run: 0,
      error: String(e.message || e),
    };
  }

  const projectRoot = path.resolve(
    opts.projectRoot || d.meta?.project || process.cwd()
  );
  const dryRun = opts.dry_run != null ? !!opts.dry_run : !!d.meta?.dry_run;
  const compiled = compileOcs(d, { projectRoot });

  if (dryRun) {
    return {
      status: "dry_run",
      asserts: [],
      steps_run: 0,
      expanded: compiled.steps,
    };
  }

  const vars = d.vars && typeof d.vars === "object" ? d.vars : {};
  const asserts = [];
  let steps_run = 0;
  let last_exit = 0;
  const senseOut = {};
  let flat;
  try {
    flat = expandMacrosLocal(d);
  } catch (e) {
    return { status: "failed", asserts: [], steps_run: 0, error: String(e.message || e) };
  }

  try {
    for (let i = 0; i < flat.length; i++) {
      const raw = flat[i];
      const p = raw.path != null ? applyVars(raw.path, vars) : undefined;
      const content = raw.content != null ? applyVars(raw.content, vars) : undefined;
      const cmd = raw.cmd != null ? applyVars(raw.cmd, vars) : undefined;
      const cwd = raw.cwd != null ? applyVars(raw.cwd, vars) : undefined;

      switch (raw.op) {
        case "ensure_dir": {
          const abs = resolveUnder(projectRoot, p);
          // Direct fs — same effect as compiled node -e mkdir, no broker gate.
          fs.mkdirSync(abs, { recursive: true });
          steps_run++;
          break;
        }
        case "ensure_file": {
          const abs = resolveUnder(projectRoot, p);
          const ifExists = raw.if_exists || "overwrite";
          if (ifExists === "skip" && fs.existsSync(abs)) {
            steps_run++;
            break;
          }
          ops.opFsWrite({ path: abs, content: content ?? "" });
          steps_run++;
          break;
        }
        case "run": {
          const work = cwd ? resolveUnder(projectRoot, cwd) : projectRoot;
          const retries = Math.max(0, Number(raw.retry) || 0);
          let attempt = 0;
          let r;
          for (;;) {
            const cls = classifyShell(cmd);
            r = await ops.opShell({ command: cmd, cwd: work }, cls);
            last_exit = r.output.exitCode ?? 1;
            if (last_exit === 0 || attempt >= retries) break;
            attempt++;
          }
          steps_run++;
          break;
        }
        case "read": {
          const abs = resolveUnder(projectRoot, p);
          ops.opFsRead({ path: abs });
          steps_run++;
          break;
        }
        case "sense": {
          const facets = Array.isArray(raw.facets) && raw.facets.length
            ? raw.facets
            : ["host", "cwd"];
          for (const f of facets) {
            if (f === "host") {
              senseOut.host = {
                platform: process.platform,
                arch: process.arch,
                hostname: os.hostname(),
                release: os.release(),
                cpus: os.cpus()?.length,
                freemem: os.freemem(),
                totalmem: os.totalmem(),
              };
            } else if (f === "cwd" || f === "project") {
              senseOut.cwd = projectRoot;
            } else if (f === "env") {
              senseOut.env = {
                node: process.version,
                user: process.env.USER || process.env.USERNAME || null,
              };
            } else if (f === "disk") {
              try {
                const st = fs.statfsSync ? fs.statfsSync(projectRoot) : null;
                senseOut.disk = st
                  ? { bavail: st.bavail, bsize: st.bsize, blocks: st.blocks }
                  : { note: "statfs unavailable" };
              } catch {
                senseOut.disk = { note: "unavailable" };
              }
            } else if (f === "pending") {
              try {
                senseOut.pending = approvals.listPending().map((x) => ({
                  id: x.id,
                  tool: x.tool,
                  reason: x.reason,
                }));
              } catch {
                senseOut.pending = [];
              }
            } else {
              senseOut[f] = { note: "facet unknown" };
            }
          }
          steps_run++;
          break;
        }
        case "await": {
          if (raw.on === "ms") {
            const ms = Math.min(60_000, Math.max(0, Number(raw.target) || 0));
            await new Promise((r) => setTimeout(r, ms));
          } else if (raw.on === "path" && raw.target) {
            const abs = resolveUnder(projectRoot, String(raw.target));
            const deadline = Date.now() + Math.min(120_000, Number(raw.timeout_ms) || 30_000);
            while (!fs.existsSync(abs) && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 200));
            }
            if (!fs.existsSync(abs)) {
              return {
                status: "failed",
                asserts,
                steps_run,
                error: `await path timeout: ${raw.target}`,
                sense: Object.keys(senseOut).length ? senseOut : undefined,
              };
            }
          } else if (raw.on === "pending") {
            // Wait until target id is gone (approved/denied) or queue empty if no target
            const deadline = Date.now() + Math.min(300_000, Number(raw.timeout_ms) || 120_000);
            const targetId = raw.target != null ? String(raw.target) : null;
            for (;;) {
              let pend = [];
              try {
                pend = approvals.listPending() || [];
              } catch {
                pend = [];
              }
              if (targetId) {
                if (!pend.some((x) => x.id === targetId)) break;
              } else if (pend.length === 0) break;
              if (Date.now() >= deadline) {
                return {
                  status: "pending_approval",
                  asserts,
                  steps_run,
                  pending_id: targetId || pend[0]?.id,
                  error: "await pending timeout",
                  sense: Object.keys(senseOut).length ? senseOut : undefined,
                };
              }
              await new Promise((r) => setTimeout(r, 400));
            }
          } else if (raw.on === "port") {
            // best-effort: try TCP connect via node net
            const port = Number(raw.target);
            const deadline = Date.now() + Math.min(120_000, Number(raw.timeout_ms) || 30_000);
            const net = await import("node:net");
            let up = false;
            while (Date.now() < deadline) {
              up = await new Promise((resolve) => {
                const s = net.connect({ port, host: "127.0.0.1" }, () => {
                  s.destroy();
                  resolve(true);
                });
                s.on("error", () => resolve(false));
                s.setTimeout(400, () => {
                  try {
                    s.destroy();
                  } catch {}
                  resolve(false);
                });
              });
              if (up) break;
              await new Promise((r) => setTimeout(r, 300));
            }
            if (!up) {
              return {
                status: "failed",
                asserts,
                steps_run,
                error: `await port timeout: ${port}`,
                sense: Object.keys(senseOut).length ? senseOut : undefined,
              };
            }
          }
          steps_run++;
          break;
        }
        case "assert_outcome": {
          let ok = true;
          let detail = raw.claim || "";
          if (raw.check?.type === "path_exists") {
            const abs = resolveUnder(projectRoot, applyVars(raw.check.path, vars));
            ok = fs.existsSync(abs);
            detail = `${raw.claim} path=${abs}`;
          } else if (raw.check?.type === "exit0") {
            const work = projectRoot;
            const r = await ops.opShell(
              { command: applyVars(raw.check.cmd, vars), cwd: work },
              classifyShell(raw.check.cmd)
            );
            ok = (r.output.exitCode ?? 1) === 0;
            detail = `${raw.claim} exit=${r.output.exitCode}`;
          }
          asserts.push({ name: `assert_outcome:${raw.claim}`, ok, detail });
          if (!ok) {
            return { status: "failed", asserts, steps_run, error: detail };
          }
          steps_run++;
          break;
        }
        case "assert_path_exists": {
          const abs = resolveUnder(projectRoot, p);
          const ok = fs.existsSync(abs);
          asserts.push({
            name: `assert_path_exists:${p}`,
            ok,
            detail: ok ? abs : `missing: ${abs}`,
          });
          if (!ok) {
            return {
              status: "failed",
              asserts,
              steps_run,
              error: `assert_path_exists failed: ${abs}`,
            };
          }
          break;
        }
        case "assert_last_exit": {
          const want = raw.code != null ? raw.code : 0;
          const ok = last_exit === want;
          asserts.push({
            name: `assert_last_exit:${want}`,
            ok,
            detail: `last_exit=${last_exit} expected=${want}`,
          });
          if (!ok) {
            return {
              status: "failed",
              asserts,
              steps_run,
              error: `assert_last_exit failed: got ${last_exit}, want ${want}`,
            };
          }
          break;
        }
        default:
          return {
            status: "failed",
            asserts,
            steps_run,
            error: `unknown op: ${raw.op}`,
          };
      }
    }

    return {
      status: "ok",
      asserts,
      steps_run,
      sense: Object.keys(senseOut).length ? senseOut : undefined,
    };
  } catch (e) {
    return {
      status: "failed",
      asserts,
      steps_run,
      error: String(e.message || e),
      sense: Object.keys(senseOut).length ? senseOut : undefined,
    };
  }
}
