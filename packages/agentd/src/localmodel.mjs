// A local model tier — the judgement that must not leave the machine.
//
// Everything an agent reads is shipped to a third party on the next turn: the
// context IS the exfiltration channel, by construction rather than by attack.
// So the decision "may this content leave" cannot itself be made by asking a
// remote model, because asking is sending. It has to be made here, on the host,
// by something that never talks to anyone.
//
// **Which engine does the inferring is a DRIVER — the core stays neutral**, the
// same contract as enforce.mjs. Nefertari depends on no vendor and ships no
// weights; it speaks to whatever is already running:
//
//   openai   ANY OpenAI-compatible /v1/chat/completions on localhost — llama.cpp
//            --server, LM Studio, vLLM, llamafile, Jan, and Ollama's own /v1
//            shim. This is the DEFAULT because it is the widest door.
//   ollama   Ollama's native /api/chat, for hosts that run it and want its
//            model management. Never required.
//   llamacpp llama.cpp's native /completion, for a bare server with no shim.
//   http     ANY endpoint at all, wired purely through env — the escape hatch
//            for a WebGPU runtime, a bridge to a model living somewhere with no
//            HTTP of its own, or something not invented yet. A browser
//            extension running Gemma in-page (gemma-gem is the example) needs
//            such a bridge WRITTEN: it exposes no endpoint today, and an
//            earlier version of this comment said otherwise.
//   null     no local model. Deterministic detection still runs; see egress.mjs.
//
// Pick with NEFERTARI_LOCAL_DRIVER (default "auto" = probe openai, then ollama,
// then llamacpp, then give up quietly).
//
// The model here is asked to CLASSIFY and EXTRACT, never to orchestrate. Small
// local models are measurably poor at multi-step tool use and good at "is this
// a credential, yes or no" — the split is deliberate and matches what the
// hardware can actually run.

const DEFAULT_ENDPOINTS = {
  openai: "http://127.0.0.1:8080/v1",
  ollama: "http://127.0.0.1:11434",
  llamacpp: "http://127.0.0.1:8080",
};

const TIMEOUT_MS = Number(process.env.NEFERTARI_LOCAL_TIMEOUT_MS) || 8000;

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function endpointFor(driver) {
  return env("NEFERTARI_LOCAL_ENDPOINT", DEFAULT_ENDPOINTS[driver] || DEFAULT_ENDPOINTS.openai).replace(/\/+$/, "");
}

function modelName() {
  return env("NEFERTARI_LOCAL_MODEL", "local");
}

async function post(url, body, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// --- drivers: each returns the model's raw text, or throws ---

const drivers = {
  async openai(prompt, signal) {
    const j = await post(
      `${endpointFor("openai")}/chat/completions`,
      {
        model: modelName(),
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: Number(env("NEFERTARI_LOCAL_MAX_TOKENS", "256")),
        stream: false,
      },
      signal
    );
    return j?.choices?.[0]?.message?.content ?? "";
  },

  async ollama(prompt, signal) {
    const j = await post(
      `${endpointFor("ollama")}/api/chat`,
      {
        model: env("NEFERTARI_LOCAL_MODEL", "gemma3"),
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { temperature: 0 },
      },
      signal
    );
    return j?.message?.content ?? "";
  },

  async llamacpp(prompt, signal) {
    const j = await post(
      `${endpointFor("llamacpp")}/completion`,
      { prompt, temperature: 0, n_predict: Number(env("NEFERTARI_LOCAL_MAX_TOKENS", "256")), stream: false },
      signal
    );
    return j?.content ?? "";
  },

  // Wire anything: the body is a JSON template where {{prompt}} is substituted,
  // and the answer is plucked by a dotted path. No code change, no new driver.
  //   NEFERTARI_LOCAL_HTTP_URL=http://127.0.0.1:7331/infer
  //   NEFERTARI_LOCAL_HTTP_BODY={"input":"{{prompt}}"}
  //   NEFERTARI_LOCAL_HTTP_PATH=output.text
  async http(prompt, signal) {
    const url = env("NEFERTARI_LOCAL_HTTP_URL", "");
    if (!url) throw new Error("NEFERTARI_LOCAL_HTTP_URL is not set");
    const tpl = env("NEFERTARI_LOCAL_HTTP_BODY", '{"prompt":"{{prompt}}"}');
    // Substituting into the SERIALISED json would break on any quote or newline
    // in the content, which credentials and file bodies are full of. Parse
    // first, substitute into the parsed value, so escaping is JSON's problem.
    const body = JSON.parse(tpl);
    const fill = (v) =>
      typeof v === "string"
        ? v.replace("{{prompt}}", prompt)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
          : v;
    const j = await post(url, fill(body), signal);
    const path = env("NEFERTARI_LOCAL_HTTP_PATH", "content").split(".");
    let cur = j;
    for (const k of path) cur = cur?.[k];
    return typeof cur === "string" ? cur : JSON.stringify(cur ?? "");
  },
};

function selected() {
  return env("NEFERTARI_LOCAL_DRIVER", "auto").toLowerCase();
}

let probed = null; // { driver } | { driver: null } — cached for the process

async function reachable(driver) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const url =
      driver === "ollama"
        ? `${endpointFor("ollama")}/api/tags`
        : driver === "llamacpp"
          ? `${endpointFor("llamacpp")}/health`
          : `${endpointFor("openai")}/models`;
    const res = await fetch(url, { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Which driver this host will actually use, probing once. Returns null when
 * there is no local model — a normal deployment state, not an error: the
 * deterministic detectors in egress.mjs never depended on one.
 */
export async function resolve() {
  if (probed) return probed.driver;
  const want = selected();
  if (want === "null") {
    probed = { driver: null };
    return null;
  }
  if (want !== "auto") {
    probed = { driver: drivers[want] ? want : null };
    return probed.driver;
  }
  for (const d of ["openai", "ollama", "llamacpp"]) {
    if (await reachable(d)) {
      probed = { driver: d };
      return d;
    }
  }
  probed = { driver: null };
  return null;
}

/** Test seam: forget the probe. */
export function reset() {
  probed = null;
}

/**
 * Ask the local model one question. Returns its text, or null when no local
 * model is available or it failed — callers must treat null as "no opinion"
 * and fall back to their deterministic answer, never as "approved".
 */
export async function ask(prompt) {
  const driver = await resolve();
  if (!driver) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const out = await drivers[driver](prompt, ctl.signal);
    return typeof out === "string" ? out.trim() : null;
  } catch {
    // A local model that is slow, wedged or mid-restart must never become an
    // outage of the filesystem. Silence here means "no opinion".
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** What this host is running, for sys_status and the journal. */
export async function info() {
  const driver = await resolve();
  return {
    driver,
    endpoint: driver ? (driver === "http" ? env("NEFERTARI_LOCAL_HTTP_URL", "") : endpointFor(driver)) : null,
    model: driver ? modelName() : null,
  };
}
