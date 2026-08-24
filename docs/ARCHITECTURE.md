# Nefertari OS — Architecture

> Product thesis: [VISION.md](./VISION.md) · Context economy: [PROPORTIONALITY.md](./PROPORTIONALITY.md) · Perf taxes: [PERFORMANCE-TRACK.md](./PERFORMANCE-TRACK.md)

## 1. Design principles

1. **Agent as first-class citizen.** The OS is built for the agent as caller — body, time, ambient machine memory — not a human typing in a terminal. Cognition (goals, skills) stays in the brain (e.g. Ania); Nefertari is host physics + continuity.
2. **Full access, proportional context.** Capability surface can be admin-class; what enters the model is skinny, faceted, and tiered (see PROPORTIONALITY). Power ≠ paste-the-machine.
3. **Reversibility is the security model.** The safety net is not "the AI is careful", it is "every action has an undo". Anything that cannot be proven reversible is treated as irreversible and gated.
4. **The broker is physics, not convention.** The agent never touches the host directly; every action flows through `agentd`, which classifies, snapshots, journals, and — when needed — blocks pending human approval. Dual-path mutation (brain bypassing agentd) breaks the model — body contract is mandatory for production.
5. **Host-agnostic core.** The same daemon runs on WSL2, in a Railway/Docker container, or on bare-metal Linux. Host-specific capabilities (snapshot backend, desktop access, notifications, wakes) are pluggable backends, never assumptions.
6. **Unknown = irreversible.** Classification is allowlist-based. A shell command that matches no known-safe pattern is gated, not guessed.
7. **Continuity over chat sessions.** Journal, timeline, world delta, and self-wake packets outlive a single model context window.

## 2. Components

### agentd (`packages/agentd`)
MCP server over stdio. Node ≥ 20, ESM. State lives under `$NEFERTARI_HOME` (default `~/.nefertari`):

```
~/.nefertari/
  journal.jsonl        # append-only action log
  pending.json         # actions awaiting human approval
  snapshots/<id>/      # pre-action file copies + manifest.json
```

### Permission broker (`broker.mjs`)
Pure classification + policy. Input: tool name + args. Output: `{ class, decision }`.

- `reversible` → execute (after snapshot when the action writes).
- `noisy` → execute + journal with `notify: true` (phase 2: push to companion).
- `irreversible` → check approvals; if not pre-approved, register in `pending.json` and return `pending_approval` with the action id. The human approves via CLI (phase 2: companion UI), the client retries, the broker matches the approval by action hash and lets it through **once**.

Shell classification is allowlist-based (see `SAFE_RO` / `NOISY_PATTERNS` in `broker.mjs`). Everything else is irreversible by default.

### Snapshot engine (`snapshots.mjs`)
Interface: `snapshot(paths[]) -> id`, `restore(id)`, `list()`.

Backends (in order of adoption):
1. **file-copy** (phase 1, works everywhere including containers): copies affected files into `snapshots/<id>/` with a manifest; restore copies them back. Handles "file did not exist" (restore = delete).
2. **btrfs/ZFS** (phase 2, bare metal / VM): true CoW subvolume snapshots.
3. **NixOS generations** (phase 2, the custom distro): system-level rollback for free.

### Journal (`journal.mjs`)
One JSON line per event: `{ ts, id, tool, argsSummary, class, decision, snapshotId?, outcome, durationMs }`. Never truncated by agentd; rotation is an operator concern. The journal is the replay/audit source of truth.

### Approvals (`approvals.mjs`)
Pending actions are keyed by a stable hash of `(tool, canonicalized args)`. Approval is single-use and expires (default 15 min). This prevents both replay ("approve once, run twice") and bait-and-switch (approve X, execute X').

## 3. Host profiles

| Capability | WSL2 | Container (Railway) | Bare Linux |
|---|---|---|---|
| Snapshot backend | file-copy → btrfs later | file-copy | file-copy → btrfs/ZFS |
| Desktop access | via Windows companion (phase 2, UIA) | none (headless) | AT-SPI (phase 3) |
| Notifications | companion toasts | webhook (phase 2) | libnotify |
| Human gate | CLI now, companion UI later | CLI / API endpoint | CLI / desktop dialog |

**Railway / Fortuna Team AI note:** in containers, agentd is the sandbox-side enforcement layer for agent executors. The executor (ania / Team AI engine) talks MCP to a local agentd instead of raw shell; the broker + journal replace "the prompt asks the agent to be careful". Approvals in headless mode are exposed via the pending-list (poll or webhook) so the existing human-approval UI (e.g. Fortuna `awaiting_approval` gates) can drive them.

## 4. Threat model (phase 1, honest version)

In phase 1 the agent and agentd run as the same user, so a malicious/compromised agent could bypass the broker by simply not using it. Phase 1's goal is **hallucination containment and auditability**, not adversarial isolation. Adversarial isolation arrives when the agent brain is separated from the enforcement point: WSL2 VM boundary + Windows companion (phase 2), or container boundary + host-side broker (Railway).

## 5. Phase 2 sketch

- **Windows companion**: tiny service (or PowerShell host) reachable from WSL2 via localhost; provides toast notifications, an approve/deny dialog, screenshots, and UI Automation primitives. The WSL2↔Windows boundary makes the gate physical.
- **NixOS-WSL fork**: agentd preinstalled as a systemd unit, `configuration.nix` exposed as a first-class MCP tool with generation rollback as the snapshot backend.
- **Body contract** with brains (Ania): host mutation only via agentd; path alias; unified HITL pending queue.
- **World model + assert** (T4–T6): kill orientation and “I think the file exists” hallucinations.
- **Self-wake bus** (T7): timer/event/gate/dependency wakes with skinny resume packets.
- **Host tiers T0–T4** (T8): escalate capability with the goal; de-escalate after done.
