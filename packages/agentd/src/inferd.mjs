// Supervision of a local inference server — the lifecycle is ours, the
// inference is not.
//
// The local tier cannot be a chat server like Ollama, and it cannot be a
// library inside the privileged component either. A chat server loads a model
// on demand and unloads it after a keep-alive, which makes a cold start of
// seconds normal — fatal for something called on every read — and it gives no
// say over scheduling, which is the whole of the inference-window idea. A
// library couples the trust root to the weights: a missing GGUF, a GPU driver
// that is not ready, or an OOM inside inference would take down the component
// that holds the keys and the policy, at boot, when nothing else can help.
//
// So: a separate process, supervised, restartable, in a cgroup of ours. The
// inference code is llama.cpp's — upstream, maintained by people who do that
// for a living — and what we own is the part that matters here:
//
//   - the model stays RESIDENT, never unloaded behind our back
//   - it runs at background priority, so speculative work cannot slow down the
//     tool call it is preparing for
//   - it FREEZES the instant real work arrives: zero CPU, memory untouched,
//     back in milliseconds. Preempting mid-token is not needed; stopping is.
//   - it fails alone. If it will not start, the daemon starts anyway, the
//     context boundary runs on patterns, and it says so.
//
// Nothing here knows what llama-server is. It supervises a command:
//
//   NEFERTARI_INFER_CMD     the argv to run, JSON array or a plain string
//   NEFERTARI_INFER_HEALTH  a URL that answers 200 when the model is loaded
//   NEFERTARI_INFER_READY_MS  how long to wait for that (default 120s: mmapping
//                             a multi-gigabyte GGUF on a cold page cache is not
//                             a fast operation, and killing it at 10s would
//                             make a working setup look broken)
//
// Unset NEFERTARI_INFER_CMD and this is inert, which is the default.

import { spawn } from "node:child_process";
import * as cgroups from "./cgroups.mjs";
import * as journal from "./journal.mjs";

const GROUP = "inferd";

function argv() {
  const raw = process.env.NEFERTARI_INFER_CMD;
  if (!raw || !raw.trim()) return null;
  const t = raw.trim();
  if (t.startsWith("[")) {
    try {
      const a = JSON.parse(t);
      return Array.isArray(a) && a.length ? a.map(String) : null;
    } catch {
      return null;
    }
  }
  // Deliberately a plain split, not a shell. Going through a shell would let
  // the configured command string reach an interpreter, and this value comes
  // from a deployment file rather than from a person typing it — use the JSON
  // form for anything with spaces inside an argument.
  const parts = t.split(/\s+/).filter(Boolean);
  return parts.length ? parts : null;
}

const healthUrl = () => process.env.NEFERTARI_INFER_HEALTH || null;
const readyMs = () => Number(process.env.NEFERTARI_INFER_READY_MS) || 120000;

let proc = null;
let state = "stopped"; // stopped | starting | ready | frozen | failed
let detail = null;

async function healthy(signal) {
  const url = healthUrl();
  // With no health URL the process being alive is the only evidence available,
  // and saying so is better than inventing a readiness we cannot observe.
  if (!url) return proc !== null && proc.exitCode === null;
  try {
    const res = await fetch(url, { signal });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the inference service and wait until it answers.
 *
 * Never throws and never blocks the daemon: a caller that awaits this gets a
 * verdict, and a caller that does not is unaffected. Returns
 * { ok, state, reason? }.
 */
export async function start() {
  if (state === "ready" || state === "starting") return { ok: true, state };

  const cmd = argv();
  if (!cmd) {
    state = "stopped";
    detail = "NEFERTARI_INFER_CMD is not set";
    return { ok: false, state, reason: detail };
  }

  const group = cgroups.ensure(GROUP);
  state = "starting";

  proc = spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: false });
  proc.on("exit", (code, signal) => {
    // Losing inference is a degradation, not an outage: whoever asks next is
    // told there is no local model, and the deterministic half of the boundary
    // never depended on one.
    proc = null;
    if (state !== "stopped") {
      state = "failed";
      detail = `inference service exited (code ${code}, signal ${signal})`;
      journal.append({ tool: "inferd", decision: "executed", outcome: detail, class: "noisy" });
    }
  });
  proc.on("error", (e) => {
    proc = null;
    state = "failed";
    detail = `cannot start inference service: ${e.message}`;
  });

  if (group.ok) {
    cgroups.move(GROUP, proc.pid);
    // Background from the start. Inference is never the reason a tool call
    // waits: it exists to be ready when one arrives, not to compete with it.
    const bg = cgroups.setBackground(GROUP);
    if (!bg.ok) detail = bg.reason;
  }

  const deadline = Date.now() + readyMs();
  while (Date.now() < deadline) {
    if (proc === null) return { ok: false, state, reason: detail || "exited during startup" };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    let up = false;
    try {
      up = await healthy(ctl.signal);
    } finally {
      clearTimeout(t);
    }
    if (up) {
      state = "ready";
      journal.append({
        tool: "inferd",
        decision: "executed",
        outcome: `ready${group.ok ? " (supervised in cgroup)" : " (ungrouped: no cgroup control on this host)"}`,
        class: "noisy",
      });
      return { ok: true, state, grouped: group.ok };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  state = "failed";
  detail = `did not become healthy within ${readyMs()}ms`;
  return { ok: false, state, reason: detail };
}

/**
 * Stop consuming CPU this instant, without losing the loaded model.
 *
 * This is the inference window's other half: pre-work runs while the model
 * thinks, and stops dead the moment a real tool call arrives. A frozen group
 * holds its memory, so the multi-gigabyte model does not have to be read again
 * — which is exactly what makes freezing worth doing rather than stopping.
 */
export function freeze() {
  if (state !== "ready") return { ok: false, state, reason: `not running (${state})` };
  const r = cgroups.freeze(GROUP);
  if (r.ok) state = "frozen";
  return r.ok ? { ok: true, state } : { ok: false, state, reason: r.reason };
}

export function thaw() {
  if (state !== "frozen") return { ok: false, state, reason: `not frozen (${state})` };
  const r = cgroups.thaw(GROUP);
  if (r.ok) state = "ready";
  return r.ok ? { ok: true, state } : { ok: false, state, reason: r.reason };
}

export function stop() {
  state = "stopped";
  detail = null;
  if (proc) {
    // Thaw first: a frozen process cannot notice a signal, and SIGKILL on a
    // frozen cgroup leaves it frozen and unkillable until someone thaws it.
    cgroups.thaw(GROUP);
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    proc = null;
  }
  cgroups.destroy(GROUP);
  return { ok: true, state };
}

export function status() {
  return {
    state,
    pid: proc?.pid ?? null,
    configured: argv() !== null,
    health_url: healthUrl(),
    grouped: cgroups.available().ok,
    cpu: state === "stopped" ? null : cgroups.usage(GROUP),
    detail: detail || undefined,
  };
}

/** Test seam. */
export function reset() {
  proc = null;
  state = "stopped";
  detail = null;
}
