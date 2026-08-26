// Identities the agent can use and never see.
//
// In a classic OS a credential is a file readable by the UID: `~/.ssh`, a token
// in the environment. That model breaks completely here, because every byte an
// agent reads is sent to a third party on its next turn. A secret that reaches
// the context is exfiltrated by ARCHITECTURE, not by attack — no prompt, no
// policy and no amount of care changes that, because the sending is the normal
// operation of the system.
//
// So the secret never enters the context. The agent says "call GitHub as the
// identity for this goal" and the broker attaches the credential DOWNSTREAM of
// the agent, at the point of egress. The prior art is exact and has worked for
// years: the AWS instance metadata service. The machine has the identity; the
// process does not.
//
// FOUR RULES, and each one closes a way the secret gets out anyway:
//
//   1. It is never returned. There is no tool that reads a secret, deliberately
//      — not a redacted one, not a prefix, not a length. An agent that can ask
//      "how long is it" can ask 200 times.
//
//   2. It is never journalled. The record says WHICH identity was used and
//      against what; the value appears nowhere, because the journal is the one
//      file designed to be read later by someone reconstructing events.
//
//   3. It is never in argv. `nefertari secret add` reads from stdin, because a
//      command line lands in shell history, in `ps` output, and in this very
//      daemon's own record of what commands ran.
//
//   4. It is scoped to hosts, and the scope is checked before the request goes
//      out. Otherwise the name of an identity is enough: an agent that knows
//      "github" exists can point it at a host it controls and be handed the
//      token by the broker itself. The scope is what makes the name safe to
//      know — and it is why identities are per-goal rather than per-user.
//
// AND THE ANSWER IS SCANNED ON THE WAY BACK. A response that echoes the
// credential — an API that reflects its own Authorization header, a debug
// endpoint, a error message quoting the request — would put in the context
// exactly what all of the above kept out. It is redacted before it is returned.
//
// WHAT THIS IS NOT, yet: the root of trust is a file with 0600 on it, not a
// kernel keyring or a TPM. That is a real limit and it is worth stating plainly
// — anything running as this user can read the file. What it buys today is that
// the AGENT cannot, because the agent runs confined and the daemon does not, and
// `--deny-read` makes the store unreadable to it even so.

import fs from "node:fs";
import path from "node:path";
import { HOME, ensureHome } from "./paths.mjs";

const FILE = () => path.join(HOME, "identities.json");

function load() {
  try {
    const all = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

function save(items) {
  ensureHome();
  const tmp = `${FILE()}.tmp${process.pid}`;
  // 0600 from the moment it exists, and never chmodded afterwards: a window in
  // which the file is world-readable is a window, however short.
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
}

const live = (items, now = Date.now()) => items.filter((i) => !i.expiresAt || now < Date.parse(i.expiresAt));

/**
 * Register an identity. Called by the CLI on a human's behalf — there is no
 * tool for this, and that absence is the point.
 *
 * `hosts` is required and has no default. A credential with no scope is a
 * credential that can be pointed anywhere, and "we'll add the scope later" is
 * how it ends up permanent.
 */
export function put({ name, value, hosts, header = "Authorization", scheme = "Bearer", ttlMs, note = "" }) {
  if (!name || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) return { ok: false, reason: "a name is required: letters, digits, - and _" };
  if (!value) return { ok: false, reason: "no value given (it is read from stdin, never from the command line)" };
  if (!Array.isArray(hosts) || !hosts.length) {
    return {
      ok: false,
      reason:
        "at least one host is required. An identity with no scope can be pointed at any server, which " +
        "makes knowing its name enough to be handed the credential.",
    };
  }
  const items = live(load()).filter((i) => i.name !== name);
  const entry = {
    name,
    value,
    hosts: hosts.map((h) => h.toLowerCase()),
    header,
    scheme,
    note,
    addedAt: new Date().toISOString(),
    expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null,
  };
  save([...items, entry]);
  return { ok: true, name, hosts: entry.hosts, expires_at: entry.expiresAt };
}

export function remove(name) {
  const items = live(load());
  if (!items.some((i) => i.name === name)) return { ok: false, reason: `no identity named ${name}` };
  save(items.filter((i) => i.name !== name));
  return { ok: true, removed: name };
}

/**
 * What identities exist, and what they may be used against.
 *
 * The value is not here, and there is no argument that adds it. Everything
 * else is safe to know precisely BECAUSE of the scope: an agent that learns
 * "deploy-token exists and works against api.railway.app" has learned nothing
 * it can misuse.
 */
export function list() {
  const items = live(load());
  const before = load().length;
  if (items.length !== before) save(items);
  return items.map((i) => ({
    name: i.name,
    hosts: i.hosts,
    header: i.header,
    note: i.note,
    added_at: i.addedAt,
    expires_at: i.expiresAt,
    expires_in_ms: i.expiresAt ? Math.max(0, Date.parse(i.expiresAt) - Date.now()) : null,
  }));
}

/** Internal only. Never exported through a tool, never returned to a caller. */
function resolve(name) {
  return live(load()).find((i) => i.name === name) || null;
}

/**
 * May this identity be used against this URL?
 *
 * Checked here rather than at the call site so there is exactly one place that
 * decides it. A host matches if it is the scope entry or a subdomain of it —
 * `api.github.com` matches a scope of `github.com`, and `github.com.evil.tld`
 * does not, which is the whole reason the check is a suffix match on a dot
 * boundary rather than `includes`.
 */
export function allowedFor(name, url) {
  const id = resolve(name);
  if (!id) return { ok: false, reason: `no identity named "${name}". secret_list shows what exists.` };
  let host;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(host)) {
      return {
        ok: false,
        reason: `refusing to attach a credential to ${u.protocol}//${host} — plaintext sends it over the wire in the clear`,
      };
    }
  } catch {
    return { ok: false, reason: `not a URL: ${url}` };
  }
  const ok = id.hosts.some((h) => host === h || host.endsWith(`.${h}`));
  if (!ok) {
    return {
      ok: false,
      reason:
        `identity "${name}" is scoped to ${id.hosts.join(", ")} and this request is to ${host}. ` +
        `The scope is what makes an identity's NAME safe for you to know.`,
    };
  }
  return { ok: true, host };
}

/**
 * Attach the credential to a set of headers. The only function that ever
 * touches a value, and it hands back headers rather than the secret.
 */
export function attach(name, headers = {}) {
  const id = resolve(name);
  if (!id) return { ok: false, reason: `no identity named "${name}"` };
  const value = id.scheme ? `${id.scheme} ${id.value}` : id.value;
  return { ok: true, headers: { ...headers, [id.header]: value }, redact: id.value };
}

/**
 * Remove any credential value from text on its way back to the agent.
 *
 * Defence in depth, and not theoretical: plenty of APIs quote the request back
 * in an error, and a debug endpoint will happily reflect its own headers. All
 * live values are checked, not just the one used — a response that happens to
 * contain a different identity's token is the same leak.
 */
export function redact(text) {
  if (typeof text !== "string" || !text) return { text, redacted: 0 };
  let out = text;
  let n = 0;
  for (const i of live(load())) {
    if (!i.value || i.value.length < 8) continue; // too short to match safely
    let at = out.indexOf(i.value);
    while (at !== -1) {
      out = out.slice(0, at) + `[redacted: ${i.name}]` + out.slice(at + i.value.length);
      n++;
      at = out.indexOf(i.value);
    }
  }
  return { text: out, redacted: n };
}
