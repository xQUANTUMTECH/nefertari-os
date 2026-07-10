# Nefertari OS

**An AI-native system layer for Linux.** The agent is not an app — it is a first-class citizen of the machine: it can see everything, act on everything, and *every action has an undo*.

> Status: early prototype (phase 1 — `agentd` + permission broker on WSL2 / any Linux).

## The thesis

Giving an AI root access takes 5 minutes. The hard problem is doing it so that:

1. **Every write action is reversible** — automatic snapshot before, one-command undo after.
2. **Nothing irreversible happens without a human gate** — not as a convention the AI is asked to respect, but as physics of the system: the broker sits between the agent and the machine.
3. **Everything is auditable** — an append-only journal records every action, its classification, its outcome.

## Architecture (phase 1)

```
┌────────────────────────────┐
│  Any MCP client            │  Claude Code, ania, Team AI executor…
│  (the "brain")             │
└────────────┬───────────────┘
             │ MCP (stdio)
┌────────────▼───────────────┐
│  agentd                    │  packages/agentd
│  ┌──────────────────────┐  │
│  │ permission broker    │  │  classifies: reversible / noisy / irreversible
│  ├──────────────────────┤  │
│  │ snapshot engine      │  │  pluggable: file-copy (anywhere) → btrfs → nix
│  ├──────────────────────┤  │
│  │ journal (append-only)│  │  ~/.nefertari/journal.jsonl
│  └──────────────────────┘  │
└────────────┬───────────────┘
             │
      Linux host: WSL2 · container (Railway) · VM · bare metal
```

The same `agentd` runs unmodified on:
- **WSL2** (primary dev target — desktop companion for Windows comes in phase 2)
- **Containers** (Railway, Docker) — headless mode, snapshot backend = file-copy or overlay
- **Any Linux** (VM, bare metal) — snapshot backend = btrfs/ZFS when available

## Action classes

| Class | Examples | Broker decision |
|---|---|---|
| `reversible` | read file, write file (snapshotted), restart service | pass |
| `noisy` | install package, open port | pass + notify |
| `irreversible` | delete outside snapshot, send data out, spend money, unknown shell command | **human approval required** |

Unknown = irreversible. The safe default is not "trust the AI", it's "prove reversibility or ask".

## Quick start

```bash
cd packages/agentd
npm install
node src/server.mjs          # starts the MCP server on stdio
```

Register it in any MCP client (e.g. Claude Code):

```bash
claude mcp add nefertari -- node /path/to/packages/agentd/src/server.mjs
```

Human gate CLI:

```bash
node src/cli.mjs pending             # list actions waiting for approval
node src/cli.mjs approve <id>        # approve one
node src/cli.mjs journal 20          # tail the journal
node src/cli.mjs undo <snapshot_id>  # restore a snapshot
```

## Windows companion (phase 2, block 1)

If agentd runs in WSL2, you approve from Windows — no shell into WSL needed.
`packages/companion-win/nefertari-companion.ps1` (zero deps, PowerShell 5.1):

```powershell
.\nefertari-companion.ps1                 # watch: toast on every new pending + keys 1-9 / A / D
.\nefertari-companion.ps1 -Once           # list pending and exit
.\nefertari-companion.ps1 -Approve <id>   # approve
.\nefertari-companion.ps1 -Deny <id>      # deny
.\nefertari-companion.ps1 -Journal 20     # tail the audit journal
```

The companion never reimplements gate logic: it shells into agentd's own CLI
inside WSL, so there is exactly one approval implementation.

## Real-model test

`examples/ania-on-nefertari.mjs` connects a live LLM (any OpenAI-compatible
endpoint) to agentd over MCP and gives it a sysadmin task whose only path is an
irreversible action. Verified with kat-coder-pro-v2.5 on AtlasCloud: the model
works normally through reversible tools, hits the gate on `rm -rf`, and stops —
with the data physically untouched on disk.

## Roadmap

- **Phase 1** (done): agentd + broker + journal + snapshots, MCP over stdio. Tests: smoke 21/21, red-team 52/52, e2e + hard e2e, real-model run.
- **Phase 2** (started): Windows companion (✅ toasts + approve/deny from Windows; next: UI Automation eyes/hands), Rust enforcement daemon at the trust boundary (Landlock/seccomp), NixOS-WSL custom distro with native declarative rollback.
- **Phase 3**: desktop control via accessibility APIs (AT-SPI / UIA / AXUIElement), local model routing, voice.

## License

TBD (leaning AGPL / fair-code — open core).
