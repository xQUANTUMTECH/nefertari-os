# Nefertari — Vision: OS for AI agents (body + mind substrate)

> Status: product thesis (2026-07-16). Complements [ARCHITECTURE.md](./ARCHITECTURE.md) and [PERFORMANCE-TRACK.md](./PERFORMANCE-TRACK.md).  
> Consumers: Ania, Fortuna Team AI, any agent brain. Nefertari is **not** the brain.

---

## 1. One-liner

**Nefertari is the operating system layer where AI agents are first-class citizens:** full machine access at intent-speed, a live world they don’t rediscover every turn, and physics (undo / fork / gate / journal) so capability does not mean chaos, token blow-up, or hallucination.

It is **not** a sandbox that shrinks the OS.  
It is **not** an orchestrator (Ania owns cognition).  
It is **not** the plastic knowledge graph (that is **NexusDB** — see [NEURAL-LAYER-NEXUSDB.md](./NEURAL-LAYER-NEXUSDB.md)).  
It is the **body, time, and ambient machine-state memory** for any agent.

---

## 2. Why an agent-native OS (advantages)

Giving an agent “this OS” is not a feature checklist. It changes what autonomy *can* mean.

### 2.1 Capability advantages

| Advantage | Without Nefertari (classic agent on stock OS) | With Nefertari |
| --- | --- | --- |
| **Autonomy** | Runs until the next missing fact or irreversible fear; stops or asks often | Can act across long horizons; irreversible is gated by *physics*, reversible is free |
| **Self-wake / continuity** | Session dies → amnesia; human must re-prompt | Session identity + journal + world delta + scheduled/event wakes (see §3) |
| **Memory of the machine** | Re-probes host every run (20× `ls`/`ps`) | World model + delta since last session (orientation tax → 0) |
| **Memory of work** | Chat log only; compaction loses goals | Journal + timeline checkpoints + promote history = durable work memory |
| **Parallel self / team** | Agents trample or serialize | Fork ×K isolated worlds; promote winner = org chart |
| **Intent speed** | 1 model turn per keystroke-level tool | `plan_run` / trajectories: N steps or K strategies per turn |
| **Self-healing** | Failure = stuck narrative | Failed plan → atomic restore + forensic checkpoint; retry other trajectory |
| **Audit / trust** | “Trust the model” | Append-only journal; human gate; Landlock when reversible |
| **Training moat** | Expensive to label agent trajectories | Fork/promote = chosen/rejected pairs as by-product |
| **Full OS access** | Either raw shell (unsafe) or tiny tool cage (weak) | **Full surface**, classified and reversible where possible |

### 2.2 What “full access” means (and does not)

| Means | Does **not** mean |
| --- | --- |
| Admin-class capability: fs, shell, net, packages, processes, desktop sensors, install… | Dumping the entire machine into the prompt every turn |
| Capability always *addressable* via OS primitives | Every capability always *loaded* into context |
| Unknown actions default to gate, not silent deny of the whole OS | A 15-tool cage forever |
| Body is mandatory for host mutation (no dual path) | Brain and body are the same process forever |

**Principle:** maximum *power*, minimum *context*, zero *bypass*.

---

## 3. Autonomy stack (beyond “runs tools”)

Autonomy is layered. Nefertari supplies the lower layers; Ania (or another brain) supplies cognition.

```
┌──────────────────────────────────────────────────────────┐
│  L5  Goals & strategy     Ania goal harness / team roles │
│  L4  Self-wake & schedule  wake rules, monitors, inbox   │  ← OS + brain
│  L3  Ambient perception    events, world delta, asserts  │  ← OS (push)
│  L2  Intent execution      plan_run, trajectories, jobs  │  ← OS (LIVE T1–3)
│  L1  Host physics          classify, snapshot, enforce   │  ← OS (LIVE)
└──────────────────────────────────────────────────────────┘
```

### 3.1 Autonomy (L5 + L2)

Long-horizon work without babysitting: reversible work proceeds; irreversible parks once; failed branches roll back; best branch promotes.

### 3.2 Self-wake (L4) — first-class product requirement

An agent that only answers when the human types is a **chatbot**. An OS-level agent needs:

| Wake type | Trigger | Example |
| --- | --- | --- |
| **Human wake** | user message / approve / deny | classic chat + gate UI |
| **Timer wake** | cron / interval / deadline | “retry deploy 06:00”, weekly report |
| **Event wake** | host/bus event | file changed, test job finished, disk > 90%, webhook, email |
| **Gate wake** | pending approval resolved | continue plan after human OK |
| **Watchdog wake** | stall / no progress / laziness | re-engage with system reminder, not full re-prompt history |
| **Dependency wake** | subagent / trajectory complete | parent continues without polling burn |
| **Budget wake** | token/step budget pressure | converge / finish / escalate |

**Contract:** wakes deliver a **small, structured packet** (why woke, delta since sleep, open goal id, 3–10 relevant facts) — not the entire journal and not a cold start.

Implementation sketch (phase 2+):

- `session` + `goal_id` durable under `NEFERTARI_HOME`
- `wake_rules` registered by brain or OS
- event bus → `inbox` for agent (Ania `check_inbox` / push)
- companion / systemd / container sidecar can fire wakes when brain is idle

### 3.3 Ambient perception (L3)

The OS pushes, the model doesn’t poll:

- world delta (T4)
- job completion, timeline promote, pending gate
- postcondition fail/pass (T6)
- optional desktop/screenshot hooks (companion)

### 3.4 Memory (three kinds — do not conflate)

| Kind | Owner | Content | Cost if naive |
| --- | --- | --- | --- |
| **Machine memory** | Nefertari | host state, packages, services, tree index, deltas | huge if dumped raw |
| **Work / episodic log** | Nefertari journal + timeline | what ran, forks, promotes, asserts | huge if full transcript always |
| **Plastic / associative memory** | **NexusDB** (Hebbian + `.nxm`) | domain expertise, co-activation of what worked, client-specific boosts | controlled: top-k only; learning changes *rank*, not dump size |

**Fusion rule:** store fat on disk; inject **skinny projections** into the model (see §4).  
**Learning rule:** every **verified** outcome (assert / promote / human) emits a Hebbian signal — continuous online plasticity without waiting for LoRA. Details: [NEURAL-LAYER-NEXUSDB.md](./NEURAL-LAYER-NEXUSDB.md).

### 3.5 Self-control without babysitting

| Control | Mechanism |
| --- | --- |
| Don’t destroy production by accident | class + gate + enforce |
| Don’t loop forever | Ania stuck/budget + OS assert fail count |
| Don’t wait-burn tokens on human | blocked state + gate wake (no sleep-tool spam) |
| Don’t forget the goal across wakes | durable goal id + card + world delta |
| Don’t invent host state | typed world + assert_outcome, not free prose |

---

## 4. Proportionality — full body, cheap mind

Full OS access **increases** potential token cost and hallucination surface if every fact is shoved into context. The OS must therefore own **context economy**.

### 4.1 The tax model (what we optimize)

| Tax | Cause | Nefertari counter |
| --- | --- | --- |
| **Orientation** | re-discover machine each session | T4 world + delta |
| **Round-trip** | 1 inference per micro-step | T2 `plan_run` |
| **Recompute** | re-grep, re-build, re-list | cache, index, world |
| **Single-path** | try A then B sequentially | T3 trajectories |
| **Context bloat** | paste entire logs/trees | progressive disclosure |
| **Hallucinated state** | model invents disk/process truth | typed reads + T6 assert |
| **Amnesia** | compaction / new session | durable cards + wake packets |
| **Wake thrash** | re-send full history on every timer | resume handle + delta only |

### 4.2 Progressive disclosure (how the agent “sees” the OS)

Never: “here is the whole filesystem and last 10k journal lines.”

Always: **ask → summary → drill-down → pin**.

| Layer | What enters context | Size target |
| --- | --- | --- |
| **0 — Always on** | goal card, done criterion, policy tier, host fingerprint (os, cwd, agent session id) | ~0.5–2k tokens |
| **1 — On wake** | wake reason + delta since last active + open todos (ids + titles) | ~0.5–1.5k |
| **2 — On demand** | `world` slice (services / disk / project index) | only requested facets |
| **3 — Working set** | files currently open / last tool outputs (retention temporary) | drop on compact |
| **4 — Archive** | full journal, full trees, trajectory losers | disk only; retrieve by query |

Ania’s retention/cache layers (`system|tools|skills|memory|working`) map cleanly:

- Layer 0–1 → `system` / `memory` (stable, cacheable)
- Layer 2–3 → `working` / temporary
- Layer 4 → Nefertari store + Ania `recall` / journal_tail with filters

### 4.3 Intent over keystrokes (cost control)

| Style | Tokens | When |
| --- | --- | --- |
| Micro tool spam | high | only for unknown exploration |
| `plan_run` (known procedure) | low | install, scaffold, multi-file edit batch |
| `trajectories_run` (K known alternatives) | mid, parallel wall-clock win | architecture A vs B, fix strategies |
| `assert_outcome` | tiny | replace “let me check by reading 12 files” |

### 4.4 Anti-hallucination / anti-forget (OS-side)

1. **No prose claims about host state without a tool result id** (brain policy + optional harness).  
2. **`assert_outcome`** after critical actions — OS answers yes/no with evidence.  
3. **World model is source of truth** for machine facts; chat is not.  
4. **Goal card survives compaction** (pinned); tool catalogs are temporary.  
5. **Wake packet includes last known goal phase** so self-wake doesn’t reinvent the plan.  
6. **Bookkeeping tools don’t count as progress** (Ania harness) — prevents note-loops that “feel busy.”

### 4.5 Proportional access (capability tiers)

Full access is available; **default exposure is proportional to goal and trust**.

| Tier | Typical goals | Surface default | Escalate when |
| --- | --- | --- | --- |
| **T0 Chat** | Q&A | no host mutation | — |
| **T1 Workspace** | edit project files | fs in project tree, RO shell | need install/net |
| **T2 Project ops** | test, build, local git | shell in tree, plan_run | need system packages |
| **T3 Host ops** | services, packages, net | broad shell + net policy | irreversible patterns |
| **T4 Privileged** | secrets, firewall, destroy | always gate + dual control | never silent |

Escalation is explicit (brain requests / policy / human).  
**Not** “always T4 in the prompt.” Capability *exists*; context and defaults *scale*.

Same idea as Ania `declare_effort` T1–T4: **effort tier ↔ host tier** can be coupled later.

### 4.6 Cost budget as OS concern

Optional limits (config / session):

- max tokens/day, max irreversible pending, max forks K, max plan steps  
- wake rate limits (avoid timer storms)  
- world facet allowlist per session  

When over budget: OS returns structured `budget_exceeded` → brain must summarize / promote / stop — not silently continue.

---

## 5. Fusion model (brain ↔ body ↔ neural tissue)

```
                 wake / events / asserts
        ┌────────────────────────────────────┐
        │            NEFERTARI               │
        │  world · journal · timeline · jobs │
        │  broker · enforce · wake bus       │
        └──────────────▲─────────────────────┘
                       │ body contract
          remember/recall/hebbian signals
        ┌──────────────┼─────────────────────┐
        │         NEXUSDB (.nxm)               │
        │  Hebbian LTP/LTD · hybrid retrieval  │
        │  cartridges · traj curation          │
        └──────────────▲─────────────────────┘
                       │ skinny top-k + ranks
        ┌──────────────┴─────────────────────┐
        │              ANIA                  │
        │  goals · verify · skills · team    │
        │  mode router · budgets · LTM API   │
        └────────────────────────────────────┘
```

**Fusion ≠ one binary.** Fusion =:

1. **Body contract** — Ania cannot mutate host except through Nefertari.  
2. **Ambient mind** — world/wake/assert flow *into* Ania without re-probing.  
3. **Shared session identity** — same goal_id / session across sleeps.  
4. **Shared HITL** — one pending queue.  
5. **Shared training log** — trajectories + promotes + goal outcomes.  
6. **Neural plasticity** — NexusDB strengthens associations that verified success; suppresses failures; `.nxm` portable across forks/clients.

---

## 6. Product phases (vision → build)

| Phase | Name | Outcome |
| --- | --- | --- |
| **1** (done) | Daemon + physics | broker, snapshot, journal, MCP |
| **2a** (done) | Time & intent | timeline, plan_run, trajectories_run |
| **2b** | **Body contract** | mandatory path for Ania; no dual channel; path alias |
| **2c** | **World + assert** | T4/T5/T6 — orientation tax and hallucination tax |
| **2d** | **Self-wake bus** | timer/event/gate/dependency wakes + skinny packets |
| **2e** | **Proportional tiers** | T0–T4 host surface + effort coupling |
| **3** | Citizen OS | desktop sensors, Nix/WSL profile, CoW, local model routing |

---

## 7. Success metrics (vision-level)

| Metric | Direction |
| --- | --- |
| Steps / goal (with body vs raw tools) | down after body contract (target ≤1.3× raw, then &lt; raw via plan_run) |
| Tokens / goal | down (orientation + round-trip + bloat) |
| False claims about host state | down (assert + typed world) |
| Cold-start probe commands / session | → ~0 with T4 |
| Human interventions / reversible work | down |
| Gate interventions / irreversible | appropriate, not zero |
| Successful self-wakes that resume without replan | up |
| Trajectory pairs logged for training | up |

---

## 8. Non-goals

- Replacing Ania / Claude / Grok as the reasoner  
- Adversarial multi-tenant security in phase 1 (honest: same-user can bypass if dual path exists — fix with body contract + isolation boundary)  
- Dumping maximum OS state into every prompt “for power”  
- Self-wake spam that re-sends full chat history  

---

## 9. Related docs

| Doc | Role |
| --- | --- |
| **Indice organismo** | `agent-engine-template-sdk/docs/MAPPA-ORGANISMO.md` |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | components, threat model |
| [PERFORMANCE-TRACK.md](./PERFORMANCE-TRACK.md) | T1–T8 taxes and tasks |
| [PROPORTIONALITY.md](./PROPORTIONALITY.md) | context economy & tiers (detail) |
| [NEURAL-LAYER-NEXUSDB.md](./NEURAL-LAYER-NEXUSDB.md) | Hebbian tissue, wiring Ania/Nefertari |
| Ania plan | `agent-engine-template-sdk/PLAN-ANIA-GROK-ORCHESTRATOR.md` |
| NexusDB engine | [xQUANTUMTECH/nexusdb](https://github.com/xQUANTUMTECH/nexusdb) |
