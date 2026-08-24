# Proportionality — full OS power without token / hallucination bankruptcy

> Companion to [VISION.md](./VISION.md).  
> Problem: **full access** raises capability *and* risk of context bloat, cost, invented state, and forgetfulness.  
> Solution: store fat, inject thin; escalate surface with the goal; execute at intent level; wake with deltas.

---

## 1. Design law

```
capability_available  ≥  what a careful human admin can do
context_injected      ∝  current goal phase + uncertainty
truth_about_host      :=  tools / world / assert  (never chat alone)
progress              :=  side-effects + asserts  (never notes alone)
```

If these four lines hold, “full access” does not imply “full dump.”

---

## 2. Context budget — default envelopes

Soft targets per **active model turn** (adjust per model window):

| Envelope | Tokens (order of mag.) | Contents |
| --- | --- | --- |
| **Always** | 500–2 000 | goal card, done criterion, host tier, session id, discipline card |
| **Wake** | +500–1 500 | wake reason, delta summary, open todo titles, last assert |
| **Working** | +2 000–8 000 | current file slices, last tool outputs (temporary retention) |
| **Emergency** | + up to 20 000 | rare: deep debug; must be marked temporary and compactable |

Hard rules:

1. Journal full-text never auto-injected — only `journal_tail` / filtered query.  
2. Directory trees never pasted whole — `list` with depth/limit + search.  
3. Trajectory losers stay on disk until explicit `inspect`.  
4. Skill/tool catalogs: temporary retention (drop on compact).  
5. Layer 0 always byte-stable when possible (prompt cache).

---

## 3. Progressive disclosure API (agent-facing)

Conceptual tools / facets (names may map to MCP):

| Call | Returns | Use when |
| --- | --- | --- |
| `world({facets})` | typed JSON for requested facets only | orientation, post-wake |
| `world_delta(since)` | changes since ts / session | self-wake, resume |
| `search_host(query)` | ranked hits (files, units, pkgs) | unknown location |
| `plan_run(steps)` | one result blob | known multi-step |
| `trajectories_run(...)` | K results + winner hint | multi-strategy |
| `assert_outcome(check)` | pass/fail + evidence | before claiming done |
| `preflight(action)` | class, will_gate, undo_via | before risky intent |
| `journal_query(filter)` | few events | audit / debug |
| `wake_register(rule)` | rule id | self-wake setup |

**Anti-pattern:** `shell("find / -type f")` into the model context.  
**Pattern:** `search_host` → open 1–3 paths → `assert_outcome`.

---

## 4. Host tiers (proportional surface)

| Tier | Name | Default allow | Default gate | Typical Ania mode |
| --- | --- | --- | --- | --- |
| **T0** | Chat | none | all mutation | smalltalk |
| **T1** | Workspace | R/W project tree | outside tree, net write | effort T1–T2 |
| **T2** | Project ops | shell in tree, test/build, local git | package managers system-wide | effort T3 / plan |
| **T3** | Host ops | services, packages, net (policy) | destroy, secrets, firewall | safe_host + plan |
| **T4** | Privileged | explicit grant | everything sensitive dual-control | human session |

Rules:

- Session starts at **minimum tier that can satisfy goal score** (router).  
- Escalation is a **logged event** (journal + Ania state).  
- De-escalation after goal complete (don’t keep T3 open for chat).  
- Full catalog of tools can still be *listed*; **auto-allow** is tiered.

---

## 5. Coupling to Ania effort / goal harness

| Ania signal | Nefertari default |
| --- | --- |
| smalltalk / T0 effort | Host T0 |
| declare_effort T1–T2 | Host T1 |
| declare_effort T3 + coding | Host T2 |
| plan mode multi-step ops | Host T2–T3 |
| team multi-role on host | Host T2 + fork per casa |
| explicit “install / system” language | propose T3 + preflight |
| finish → verify | prefer `assert_outcome` / `eval_cmd` over prose |

Verifier should consume **OS evidence** (exit codes, assert JSON), not only model summary.

---

## 6. Self-wake packets (token-safe resume)

On wake, inject **only**:

```json
{
  "wake": { "type": "timer|event|gate|dependency|watchdog", "reason": "..." },
  "session_id": "...",
  "goal_id": "...",
  "goal_card": { "title": "...", "done_criterion": "...", "phase": "execute" },
  "delta": { "since": "ISO", "summary": ["file X changed", "job Y exit 0"], "pending_approvals": 0 },
  "todos": [{ "id": "t2", "title": "...", "status": "in_progress" }],
  "last_assert": { "ok": true, "name": "tests" },
  "budget": { "steps_left": 4, "host_tier": "T2" }
}
```

Do **not** re-attach full chat.  
Brain loads long-term recall **only if** delta or goal card says memory scope is needed.

### Wake rate limits

- max N timer wakes / hour / goal  
- coalesce events (burst → one packet)  
- watchdog wake at most once per stall episode  

---

## 7. Anti-hallucination rules (enforceable)

| Rule | Enforced by |
| --- | --- |
| Host facts require tool/world evidence id in-run | Ania harness nudge / schema |
| `finish(success)` requires verify pass | Ania goal harness |
| Critical mutations followed by assert | policy or plan template |
| No “I deleted X” without tool result | discipline card + optional lint |
| Compact drops temporary tool dumps first | Ania context manager |
| Passive bookkeep doesn’t reset anti-loop | Ania engine |

---

## 8. Anti-amnesia rules

| Risk | Mitigation |
| --- | --- |
| Context compact | pin goal card + done criterion + open blockers |
| New process / crash | session + goal durable in `NEFERTARI_HOME` / Ania store |
| Self-wake | packet §6 |
| Multi-day goal | notebook / journal_query by goal_id |
| Team handoff | promote + report artifact path, not “read my mind” |

---

## 9. Cost accounting (what to measure)

Per goal / per day:

- tokens in / out  
- tool calls vs plan_run steps collapsed  
- wakes and tokens per wake  
- host tier time distribution  
- asserts vs free-text verifies  
- dual-path attempts (should be 0 when body contract on)

**Target after body contract + world + plan_run:**  
tokens/goal **down**, autonomy **up**, not the opposite.

---

## 10. Implementation checklist (near-term)

- [ ] Body contract: Ania mutation only via agentd  
- [ ] `world` facets + `world_delta` (T4/T5)  
- [ ] `assert_outcome` (T6) wired into Ania verify  
- [ ] Wake bus + packet schema  
- [ ] Host tier on session + journal escalate  
- [ ] Default excludes and size guards already (timeline) — keep  
- [ ] Metrics export for tokens/steps/wakes  

---

## 11. NexusDB in the budget (neural, not dump)

| Mechanism | Token effect |
| --- | --- |
| `.nxm` cartridge on disk | 0 until query |
| `recall` top_k=5–8 | ~1–3k tokens fixed envelope |
| Hebbian boost / LTD | **0 tokens** — reorders candidates |
| Post-success signal write | 0 in context (async persist) |
| Mythos multi-loop retrieval | optional, expensive — hard mode only |

Plastic learning improves *which* thin slice appears; it must not become an excuse to raise `top_k` without bound.

See [NEURAL-LAYER-NEXUSDB.md](./NEURAL-LAYER-NEXUSDB.md).

---

## 12. Summary

**Give the agent a full body (Nefertari). Give it plastic nerves (NexusDB). Give the mind a skinny, truthful, proportional view. Wake it with deltas, not encyclopedias. Let intent, assert, and Hebbian rank replace keystroke spam, prose fantasy, and static RAG.**
