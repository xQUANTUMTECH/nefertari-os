# Neural layer — NexusDB as the missing tissue

> Companion to [VISION.md](./VISION.md) and [PROPORTIONALITY.md](./PROPORTIONALITY.md).  
> Engine: [NexusDB](https://github.com/xQUANTUMTECH/nexusdb) — Rust, cartridges + Hebbian layer.

---

## 1. The gap

| Layer | What it is | What it is **not** |
| --- | --- | --- |
| **Ania** | Cognition / process harness | Durable neural memory |
| **Nefertari** | Body / time / host physics / wake | Association graph that learns from use |
| **LLM weights** | Slow, offline intelligence | Online client-specific plasticity |
| **Classic vector DB / chat log** | Static store or amnesic buffer | Plastic retrieval that strengthens success |

Without a plastic memory layer the “OS for agents” still has:

- a body that acts  
- a brain that reasons  
- **no nervous tissue that remembers *what worked together* on *this* host / client / domain**

That tissue is **NexusDB**: Hebbian overlays + `.nxm` cartridges + hybrid retrieval (HNSW + BM25 + RRF + Hebbian modulation).

---

## 2. Four-layer stack (complete organism)

```
┌─────────────────────────────────────────────────────────────┐
│  WEIGHTS (slow)     V4 + LoRA offline — months/€             │
│  distill process policy from trajectories                    │
└──────────────────────────▲──────────────────────────────────┘
                           │ curated .nxm / SFT-DPO export
┌──────────────────────────┴──────────────────────────────────┐
│  NEXUSDB (fast neural)   plastic memory · .nxm · Hebbian     │
│  online LTP/LTD · recall skinny · training curation          │
└──────────▲───────────────────────────────▲───────────────────┘
           │ remember/recall/signals       │ world/traj store
┌──────────┴──────────┐         ┌──────────┴───────────────────┐
│  ANIA (cognition)   │         │  NEFERTARI (body + time)     │
│  goal · verify ·    │ body    │  fork · plan · wake · journal│
│  skill · team       │◄───────►│  assert · host tiers         │
└─────────────────────┘contract └──────────────────────────────┘
```

**Metaphor**

| Biological | Stack |
| --- | --- |
| Cortex (deliberation) | Ania + LLM |
| Body / muscles / clock | Nefertari |
| **Associative cortex / hippocampus-like plasticity** | **NexusDB** |
| Genome (species knowledge) | Base model + LoRA |

---

## 3. Why NexusDB fits “full body without token bankruptcy”

NexusDB’s original product claim is exactly the proportionality law:

> Thousands of pages live on disk as `.nxm`; each turn gets **5–10 chunks (~2k tokens)**, not the corpus.

Applied to the agent OS:

| Fat on disk (Nexus / Nefertari) | Thin in prompt |
| --- | --- |
| Domain skill cartridges (legal, PMI, brand) | top-k recall |
| Trajectory archive + promote labels | hard examples / few-shot only when needed |
| World-model snapshots (T4 store as `.nxm`) | `world_delta` facets |
| Hebbian boost graph | **order/rank** of retrieval, not extra tokens |
| Journal full history | filtered query / goal_id |

Hebbian learning **does not grow the context window**. It changes *which* skinny pieces surface first — continuous learning without continuous dump.

---

## 4. Continuous Hebbian learning for agents (not only doc RAG)

### 4.1 What exists in code today (`nexusdb-rust/src/hebbian/`)

- **LTP / LTD** as **delta overlays** on base adjacency (base embeddings never mutated).  
- Signals: co-activated regions + selected chunks + feedback  
  `Implicit | ExplicitPositive | ExplicitNegative`.  
- Energy budget, consolidation (“sleep cycle”), anti-noise filters.  
- Persist: `{skill}.hebbian.json` next to skill.  
- Roadmap v0.3: async L-BFGS graph relaxation (deeper consolidation).

### 4.2 Signal map from the live agent loop

| Event (Ania / Nefertari) | Hebbian feedback | Effect |
| --- | --- | --- |
| Recall chunks used in a **successful** verify/assert | ExplicitPositive (or strong Implicit) | LTP on co-activated chunks |
| Trajectory **promoted** (winner) | Positive on plan/skill traces used | strengthen winning associations |
| Trajectory **rejected** / verify fail | ExplicitNegative | LTD — suppress bad retrieval paths |
| User thumbs-down / gate deny after bad plan | ExplicitNegative | avoid repeating |
| Chunk retrieved but never used in tools | weak Implicit or none | no free LTP spam |
| Bookkeep-only turns | **no signal** | don’t teach “note loops” |

**Rule:** only **grounded success/failure** (assert, eval_cmd, promote, human) trains the graph — same honesty as goal verify.

### 4.3 “Constant” learning — two tempos

| Tempo | Mechanism | When |
| --- | --- | --- |
| **Online (constant)** | Hebbian signal after each verified outcome | every goal / wake |
| **Consolidation sleep** | decay + energy cap + optional L-BFGS | interval / idle / night |
| **Offline (slow)** | export winners → SFT/DPO → LoRA | batch GPU |

NexusDB = **always-on nervous adaptation**.  
LoRA = **species upgrade**.  
Neither replaces the other.

---

## 5. Three roles of NexusDB

The three places a retrieval engine earns its keep in an agent stack, made concrete:

### Role A — Runtime plastic memory (Ania `LongTermMemory`)

Replace / back `InMemoryStore` with Nexus-backed adapter:

- `remember` → ingest episode / fact into session or client cartridge  
- `recall` / `search_memory` → query top-k + Hebbian rank  
- scope: `client_id`, `goal_id`, `skill`, `host_fingerprint`

**Proportionality:** recall default `top_k=5–8`, retention temporary unless `mark_important`.

**Regole complete (kind, scope, confidence, deny-list, Hebbian, team):**  
`agent-engine-template-sdk/docs/ANIA-NEXUS-MEMORY.md` — *cosa Ania scrive/legge.*  

**Layer L0–L5, formato campi su chunk, caching C0–C2, pull event-driven (no poll loop):**  
`agent-engine-template-sdk/docs/ANIA-NEXUS-LAYERS.md` — *come si monta su Nexus reale.*  

**Analisi “Nexus come cervello” (Hebbian train, mappa biologica, gap):**  
`nexusdb-rust/DOCS/BRAIN-SIMULATION-ANALYSIS.md`

### Role B — Training / curation data layer

- Ingest all Nefertari trajectories (K forks + promote label)  
- Near-dup dedup, diversity sample, held-out contamination guard  
- Export SFT/DPO sets without shipping raw data off-box until GPU run  

### Role C — World-model & domain cartridge store for Nefertari

- T4 world snapshots / project indexes as `.nxm` (portable with timeline checkpoint)  
- Brand/legal/ops skill packs as cartridges the agent “plugs in”  
- Fork promote can copy/attach `.nxm` + `.hebbian.json` with the tree  

---

## 6. Wiring sketch (implementation order)

```
Phase N0  Library smoke: ingest 10k traj-like docs, recall, dedup, hebbian signal round-trip
Phase N1  Ania adapter: LongTermMemory → Nexus local or HTTP (nexusdb-server)
Phase N2  Signal bridge: on verify pass/fail + promote → HebbianSignal
Phase N3  Nefertari: optional store world facets + traj blobs under NEFERTARI_HOME via Nexus
Phase N4  Curation CLI: export chosen/rejected + contamination check
Phase N5  Couple wake packet: include 0–3 hebbian-hot recalls for open goal (token budget)
```

**Do not** put Mythos multi-loop retrieval on every Ania step by default — ACT loops cost tokens; use for hard research modes only.

---

## 7. Honesty / constraints

| Fact | Implication |
| --- | --- |
| Hebbian core exists; deep async consolidation still roadmap (v0.3) | Ship online signals + consolidate; don’t oversell L-BFGS yet |
| Fortuna cloud skills once chose **Vectorize-only** (AGENTI-SDK) | Cloud multi-tenant ≠ desktop agent OS; Nexus is **local/edge cartridge** story for Ania+Nefertari |
| AGPL on NexusDB | product/license path for SaaS embedding must be explicit (FZE IP chain) |
| Same-user dual-path without body contract | Hebbian can’t fix bypassed physics — still need Nefertari body contract |
| Hallucination of *host* state | still Nefertari assert/world; Nexus grounds *knowledge*, not live `ps` |

---

## 8. Metrics (neural layer)

| Metric | Target direction |
| --- | --- |
| Tokens / successful recall-backed goal | down vs paste-docs |
| Repeat failure rate on same mistake class | down after negative signals |
| Time-to-relevant chunk (p50) | low (ms–tens of ms local) |
| Hebbian energy ratio | bounded (no drift) |
| Contamination hits on held-out | 0 |
| % goals with ≥1 grounded recall | up without bookkeep spam |

---

## 9. One-liner

**Nefertari is the body. Ania is the deliberative mind. NexusDB is the plastic nervous system — continuous Hebbian learning and portable `.nxm` expertise so the organism improves every verified action without stuffing the context window or waiting for the next LoRA.**
