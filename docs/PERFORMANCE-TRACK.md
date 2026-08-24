# Performance track — the OS built for the agent as caller

> Headline repositioned (2026-07-11): Nefertari's core claim is **performance for
> autonomous agents**, not security. Reversibility + human gate remain as the
> **parallel track** — same machinery (snapshots), different face.

## Why agents are slow on today's OS

Every OS assumes three things about its caller, and an AI agent violates all three:

| The OS assumes… | …the agent is the opposite |
|---|---|
| persistent memory (the human remembers the machine) | amnesia every session |
| cost-per-action ≈ zero (syscalls are ns; the human is the slow part) | inverted: the "syscall" is a model inference — seconds + tokens |
| always-on eyes (visual state is free and continuous) | sees only what it asks for, one text blob at a time |

That inversion produces four taxes on every autonomous run:

1. **Orientation tax** — every session re-discovers the machine (20 probe commands).
2. **Round-trip tax** — every tool call is a model turn; a 30-step procedure = 30 inferences.
3. **Recompute tax** — same builds, fetches, greps, over and over.
4. **Single-path tax** — try A, fail, backtrack, try B. Sequential exploration.

Sandboxes address none of these. Nefertari attacks all four — and the snapshot
engine, born as a safety net, becomes the *offensive* primitive that powers it.

## Primary users

- **AI teams** (e.g. Fortuna Team AI): N agents working the same host. Today they
  either serialize or trample each other. With forkable state, each teammate works
  in an isolated fork of the *same* checkpoint; the team keeps the best result.
  Speculation is not a trick here — it *is* the org chart.
- **Agentic robotics / embodied agents**: the physical world is the ultimate
  irreversible medium — you cannot snapshot a broken glass. There the same
  primitives invert: fork the *world model* (digital twin), not the world;
  `preflight` (will this gate? is it undoable?) is not a nicety, it is the only
  safe planning signal before actuation. Nefertari's classifier + preflight is the
  software half of that loop, designed so a robotics stack can plug in as a driver
  (same philosophy as the pluggable enforcement drivers).

## Task list

### T1 — Time as a primitive: `timeline` (checkpoint / fork / restore / promote) ← FIRST
The common bottleneck. Without cheap fork there is no speculation; with it, the
plan executor becomes transactional for free.

- [x] `src/timeline.mjs`: tree-level checkpoints (vs `snapshots.mjs` per-file undo)
  - `checkpoint(dir, label)` → immutable copy under `~/.nefertari/timeline/`
  - `fork(checkpointId, n)` → n isolated working copies (one per teammate / strategy)
  - `restoreTo(checkpointId, dir)` → put the working dir back to T (auto-checkpoint first, so restore is itself undoable)
  - `promote(forkId, dir)` → winning fork becomes the working dir (auto-checkpoint first)
  - size guard (`NEFERTARI_TIMELINE_MAX_MB`, default 512) + `exclude` (default `node_modules`)
  - backend = file copy (works anywhere); interface stable for btrfs/overlayfs/ZFS CoW later
- [x] broker classes: checkpoint/fork = **reversible**, restore/promote = **noisy** (like `undo`)
- [x] MCP tools in `server.mjs`: `timeline_checkpoint`, `timeline_fork`, `timeline_restore`, `timeline_promote`, `timeline_list`
- [x] `test/timeline.mjs`: checkpoint→mutate→restore fidelity (incl. resurrect deleted, remove created), fork isolation ×3, promote winner, size-guard refusal
- [x] README: performance-first rewrite of the thesis section

### T2 — Plan executor (transactional intent, not keystrokes)
Kills the round-trip tax: submit a plan (list/DAG of tool calls), agentd runs it
in one shot **inside a timeline checkpoint**; any step fails → atomic restore.
30 steps → 1 model turn. Prior art: CodeAct / code-mode MCP; our twist is
*transactional + gated* (a plan containing an irreversible step parks at the gate
before step 1 runs).

- [x] `plan_run` tool: steps = existing tools only; pre-classify ALL steps first (worst class wins, gate up front); checkpoint → execute → auto-restore on failure — `src/plan.mjs` + `src/ops.mjs` (single implementation shared with the individual tools), `classifyPlan` in the broker, failed state auto-checkpointed for forensics, shell steps default cwd = plan dir
- [x] journal: one plan entry + per-step children (`plan` + `step` fields)

### T3 — Speculative trajectories (the team superpower)
`fork ×K` from T1 + `plan_run` from T2 = run K strategies in parallel, evaluate,
`promote` the best. For Team AI: one fork per teammate, promote = merge review.

- [x] `trajectories_run` tool: {checkpoint_id, trajectories[K], eval_cmd} → results + winner recommendation — `src/trajectories.mjs` (each trajectory = `runPlan` on its own fork, so failures roll back per-fork and never poison the others; eval_cmd scored per completed fork, exit 0 = pass; `classifyTrajectories` in the broker = worst across ALL plans + eval, gate fires before any fork exists)
- [x] parallelism cap (K ≤ 8 at the tool schema) + per-fork enforcement (shell steps run with cwd = fork dir → Landlock confines writes to the fork; security track composes for free)
- [x] plans are fork-portable: relative fs paths resolve INSIDE the plan/fork dir, escapes roll back (`resolveInside` in plan.mjs)

### T4 — Live world-model (`world` tool)
Kills the orientation tax: one call returns the machine as typed data — OS,
services, packages, project index, **delta since the agent's last session**
(computed from the journal, which we already have).

### T5 — Typed system state (machine-first output)
`ps`/`df`/`ls` as JSON, not human tables to re-parse. Cheap; fold into T4.

### T6 — Postcondition assert
`assert_outcome(check)` after actions; the OS answers "did you get what you
wanted?" instead of the model re-probing.

### T7 — Self-wake bus (continuity tax)
An agent that only runs while a human is typing is not autonomous. Wakes:

- timer / cron / deadline  
- host events (job done, fs watch, disk, webhook)  
- gate resolved (human approved/denied)  
- dependency (subagent / trajectory finished)  
- watchdog (stall / no progress)

Each wake delivers a **skinny packet** (goal id, delta, open todos) — not a full
transcript reload. See [VISION.md](./VISION.md) §3.2 and [PROPORTIONALITY.md](./PROPORTIONALITY.md) §6.

### T8 — Proportional host tiers + context economy
Full OS *capability* with progressive disclosure: world facets on demand, host
tiers T0–T4, no journal/tree dumps into the prompt. See [PROPORTIONALITY.md](./PROPORTIONALITY.md).

## Parallel track (security — same machinery, second face)

- `preflight(action)` → `{class, will_gate, undo_via}` without executing. Cheap to
  build (classifier already exists), **required** for the robotics story.
- Gate, sensitive paths, net allowlist, MAX_PENDING, enforcement drivers: done
  (phase 1) — maintained, no longer the headline.

## Sequencing

T1 → T2 → T3 form one dependency chain (each reuses the previous). T4/T5/T6 kill
orientation and hallucination taxes. T7 (self-wake) and T8 (proportionality) make
autonomy continuous and affordable. Preflight rides along whenever convenient.

Product thesis (body + fusion + cost control): [VISION.md](./VISION.md).
