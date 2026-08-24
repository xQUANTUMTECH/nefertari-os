// The context boundary — what an agent is allowed to KNOW.
//
// The enforceable point is not the outbound API call. Nefertari never sees that
// request: the agent makes it, to a provider of its choosing, from a process
// that is not ours. A guard placed there would be a convention again, and this
// project's whole claim is that its guarantees are not conventions.
//
// The enforceable point is one step earlier. Everything an agent learns about
// this host arrives through fs_read, a shell's output or a fetch — all of which
// already pass through ops.mjs. **A secret the agent never saw cannot be
// exfiltrated by it.** So the boundary is drawn at what enters the context, and
// there it holds by construction rather than by good behaviour.
//
// Two tiers, deliberately unequal:
//
//   PATTERNS (here, synchronous, no dependency) catch the shapes that are
//   credentials by construction — a PEM block, an AKIA key, a bearer token.
//   They run on every read and cannot be switched off by a model being down,
//   because a filesystem that stops working when an inference server restarts
//   is worse than no boundary at all.
//
//   JUDGEMENT (localmodel.mjs, asynchronous, optional) is for what patterns
//   cannot see: a paragraph naming a customer, an internal hostname, a table of
//   salaries. Asking a REMOTE model whether content may leave would be sending
//   it — the question is the leak — so this tier is local or it does not exist.
//
// NEFERTARI_EGRESS: redact (default) · warn (detect and journal only) · refuse
// (fail the read) · off.

const MODES = new Set(["redact", "warn", "refuse", "off"]);

export function mode() {
  const m = (process.env.NEFERTARI_EGRESS || "redact").toLowerCase();
  return MODES.has(m) ? m : "redact";
}

// Each rule is (kind, regex). Ordered most-specific first so a PEM body is
// reported as a private key rather than as forty high-entropy strings.
//
// Every pattern here matches a shape that is a credential BY CONSTRUCTION — an
// issuer's own prefix, or a structural marker. Nothing guesses from context,
// because a false positive silently corrupts a file the agent needed.
const RULES = [
  ["private-key", /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)* PRIVATE KEY-----/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["openai-key", /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["stripe-key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  ["atlas-key", /\bapikey-[A-Za-z0-9]{24,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["bearer-header", /\b[Aa]uthorization\s*:\s*[Bb]earer\s+[A-Za-z0-9._-]{16,}/g],
  // The last two are shape rules rather than issuer rules, so they are the ones
  // that can be wrong. Both were tightened after a plain regex on
  // "name that says secret, then a value" masked
  //     const apiKey = process.env.OPENAI_API_KEY;
  // — the line that READS a key, in a source file the agent needed intact.
  // A boundary that corrupts code to protect a secret that was never there is
  // worse than no boundary: it makes the agent work from a false copy.
  //
  // Quoted assignment: a secret in JSON/YAML/code config is quoted. Requiring
  // the quotes is what separates a literal from an expression.
  [
    "credential-assignment",
    /\b(?:api[_-]?key|secret[_-]?key|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*(["'])([A-Za-z0-9/+_.:=-]{12,})\1/gi,
    2,
  ],
  // Dotenv line: NAME=value to end of line, where NAME shouts. The lookahead
  // drops KEY=$OTHER and KEY="${x}", which are references, not values.
  [
    "dotenv-secret",
    /^[ \t]*(?:export[ \t]+)?[A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Za-z0-9_]*[ \t]*=[ \t]*(?!["']?[$\{])["']?([A-Za-z0-9/+_.:=-]{12,})["']?[ \t]*$/gim,
    1,
  ],
];

const MASK = (kind) => `«nefertari: ${kind} withheld»`;

/**
 * Screen content leaving the host for the agent's context. Synchronous and
 * dependency-free by design — see the header.
 *
 * Returns { verdict, content, findings }. `content` is the text the caller
 * should hand on: unchanged when clean, masked under `redact`.
 */
export function screen(content, { source = "unknown", path = null } = {}) {
  if (mode() === "off" || typeof content !== "string" || !content) {
    return { verdict: "clean", content, findings: [] };
  }

  const findings = [];
  let out = content;

  for (const [kind, re, group = 0] of RULES) {
    re.lastIndex = 0;
    out = out.replace(re, (match, ...rest) => {
      // Where a rule names a capture group, only the VALUE is secret: the key
      // name is what makes the masked line readable, and blanking it hides why
      // the mask is there at all.
      const secret = group === 0 ? match : rest[group - 1];
      if (!secret || secret.length < 8) return match;
      findings.push({
        kind,
        // Never the value, and never enough of it to reconstruct: the point of
        // this module cannot be undone by its own audit trail.
        length: secret.length,
        hint: `${secret.slice(0, 3)}…${secret.slice(-2)}`,
      });
      if (mode() === "warn") return match;
      return group === 0 ? MASK(kind) : match.replace(secret, MASK(kind));
    });
  }

  if (findings.length === 0) return { verdict: "clean", content, findings: [] };

  const meta = { source, path, findings };
  if (mode() === "refuse") {
    const kinds = [...new Set(findings.map((f) => f.kind))].join(", ");
    const err = new Error(
      `refused: content holds ${findings.length} credential-shaped value(s) [${kinds}] and NEFERTARI_EGRESS=refuse. ` +
        `Read it with NEFERTARI_EGRESS=redact to get a masked copy, or name the specific value you need.`
    );
    err.egress = meta;
    throw err;
  }
  if (mode() === "warn") return { verdict: "warned", content, findings };
  return { verdict: "redacted", content: out, findings };
}

/**
 * The second tier: ask the LOCAL model whether a payload is safe to put in
 * front of an agent, for the sensitivity patterns cannot describe.
 *
 * Returns null when no local model is configured — "no opinion", which the
 * caller must never read as approval. Only the first 4000 characters are
 * shown: the question is a classification, not a summary, and a small model
 * given a whole file answers worse, not better.
 */
export async function judge(content, { question = null } = {}) {
  const { ask } = await import("./localmodel.mjs");
  const sample = String(content ?? "").slice(0, 4000);
  if (!sample.trim()) return null;

  const prompt =
    `You are a data boundary for an AI agent. Everything the agent reads is sent to a third-party model API, so anything sensitive in this text WILL leave this machine.\n\n` +
    `Answer with ONE word on the first line: SAFE or SENSITIVE.\n` +
    `On the second line give a short reason (max 15 words).\n` +
    `SENSITIVE means: credentials, personal data, customer or employee names, salaries, internal hostnames or IPs, unreleased business information, medical or legal records.\n` +
    `SAFE means: source code, public documentation, configuration without secrets, logs without personal data.\n` +
    (question ? `\nThe caller also asks: ${question}\n` : "") +
    `\n--- TEXT ---\n${sample}\n--- END ---`;

  const raw = await ask(prompt);
  if (raw === null) return null;

  const first = raw.split("\n")[0].trim().toUpperCase();
  const reason = (raw.split("\n")[1] || "").trim().slice(0, 200);
  // Anything that is not an unambiguous SAFE is treated as sensitive: a local
  // model that rambles must not be able to wave content through.
  const sensitive = !/^SAFE\b/.test(first);
  return { sensitive, reason: reason || raw.slice(0, 200), raw_verdict: first.slice(0, 40) };
}
