# Benchmark

What three execution primitives are worth, measured on cheap models, with the
verdict read from the filesystem rather than from the model's account of itself.

> Raw data: [`packages/agentd/examples/bench-results.json`](../packages/agentd/examples/bench-results.json) ·
> per-cell medians: `bench-summary.json` · harness:
> [`bench-on-nefertari.mjs`](../packages/agentd/examples/bench-on-nefertari.mjs),
> [`bench-dsh.mjs`](../packages/agentd/examples/bench-dsh.mjs),
> workloads: [`bench-workloads.mjs`](../packages/agentd/examples/bench-workloads.mjs)

## Method

**Two taxes, two tasks.**

*Bench A — the round-trip tax.* Create six files with exact contents. `single`
makes one `fs_write` call per file, with `plan_run` hidden from the model.
`plan` does it in one transactional `plan_run`.

*Bench B — the single-path tax.* Find which of three candidate taglines passes
an acceptance test (`grep -qi fidano hero.md`). `seq` tries them one at a time.
`traj` runs one `trajectories_run` with three parallel forks and promotes the
winner. **The winner is the third candidate on purpose**: that is the worst case
for anything sequential, whose cost scales with the winner's position, and it is
free for a parallel race, whose cost does not. A benchmark whose winner came
first would flatter the baseline and prove nothing.

**Rules the numbers depend on.**

- **The verdict is physical.** Every run is scored by reading the files on disk,
  never by what the model says it did. Agents announce success they did not
  achieve often enough that a benchmark trusting the transcript measures
  confidence rather than work.
- **Tokens are the provider's.** Taken from the API's own `usage` field, prompt
  plus completion, not estimated from text length.
- **Tools are hidden per mode.** A mode's forbidden tools are removed from the
  list the model sees, and a guard answers "not available" if it hallucinates
  one anyway — so `single` cannot quietly use `plan_run`.
- **A fresh environment per run.** New workspace, new `NEFERTARI_HOME`, new MCP
  server every time.
- **The enforcer is on.** Landlock confines the reversible shells, and the
  broker classifies every action, exactly as in a real run.
- **Five runs per cell, median with range.** One run per cell cannot separate a
  real effect from a model having a good turn. The first five made the case on
  their own: the same cell came in at 8.5s and at 45.1s.

**Models.** Cheap ones, deliberately. The claim is that these primitives help
most where the model is small, so proving it on a flagship would prove the wrong
thing. All three on Atlas Cloud: `deepseek-ai/deepseek-v4-flash`,
`kwaipilot/kat-coder-air-v2.5`, `bytedance/doubao-seed-2.0-lite-260428`.

---

## Bench B — parallel exploration

| Model | Mode | Success | Turns | Tokens | Wall (median) |
|---|---|---|---|---|---|
| deepseek-v4-flash | seq | **4/5** | 7.5 (7–10) | 17 478 | 25.7s |
| deepseek-v4-flash | **traj** | **5/5** | 6 (6–7) | 24 748 | **19.3s** |
| kat-coder-air | seq | 5/5 | 7 (7–11) | 17 019 | 32.7s |
| kat-coder-air | **traj** | 5/5 | **4** (4–5) | **15 831** | **16.3s** |
| doubao-2.0-lite | seq | 5/5 | 7 (7–7) | 17 783 | 49.1s |
| doubao-2.0-lite | **traj** | 5/5 | **4** (4–4) | **16 124** | **27.2s** |

**The result worth remembering is not the speed.** Sequential failed one run in
five; parallel never failed. On the two models that use the primitive well it is
also *cheaper* — fewer tokens, not more — which contradicts the obvious reading
that speculation is insurance you pay for. On deepseek it is insurance you pay
for: 24 748 tokens against 17 478.

Look at the turn ranges rather than the medians. `seq` spans 7–11 turns;
`traj` spans 4–5, and on doubao exactly 4 every time against exactly 7. Constant
cost regardless of where the winner sits is the claim, and the spread is where
it shows.

## Bench A — execution at the level of intent

| Model | Mode | Success | Tool calls | Tokens | Wall (median) |
|---|---|---|---|---|---|
| deepseek-v4-flash | single | 5/5 | 6 | 5 664 | 11.4s |
| deepseek-v4-flash | **plan** | 5/5 | **1** | 6 468 | **5.9s** |
| kat-coder-air | single | 5/5 | 6 | 6 091 | 10.3s |
| kat-coder-air | **plan** | 5/5 | **1** | 6 985 | **4.9s** |
| doubao-2.0-lite | single | 5/5 | 6 | 6 565 | 18.5s |
| doubao-2.0-lite | plan | **1/5** | 1 | 7 406 | 47.3s |

Roughly half the wall-clock for one tool call instead of six, at 10–14% more
tokens. Both models did the six writes in **two** turns even in `single` mode —
parallel tool calling already mitigates the round-trip tax on flat, independent
batches, so `plan_run`'s win here is the single call, the lower wall-clock, and
the atomic rollback that no sequence of individual writes can offer. Not the
turn count.

**Doubao failed `plan` four times in five while passing `single` five times in
five**, and that is a finding rather than noise. It emits the plan, the call
returns, and the files do not verify: the escaping inside a nested JSON array
defeats it where the same content through six separate calls does not. This is
the shape problem the plan API was already widened for — flat steps and a JSON
string are both accepted — and widening was not enough for the cheapest model.
It argues for a builder form (`plan_begin` / `plan_add` / `plan_commit`), one
flat call per step, where escaping is local.

## The machine is idle while all this happens

| Cell | Idle share |
|---|---|
| B-tagline / seq | **100%** |
| B-tagline / traj | **99%** |
| A-files / single | 60% |
| A-files / plan | no window to measure |

The share is the time between one tool call returning and the next arriving —
the model thinking — as a fraction of the run. `agentd` sees both edges of that
window, which is why it can report this at all and why it is the only process on
the host that could schedule into it.

`plan_run` shows no window because a window exists *between* two calls and
`plan_run` makes one. Collapsing six round-trips leaves nothing to measure,
which is the point of it rather than a gap in the measurement.

What the idle is worth, once something uses it: a checkpoint of a 64-file tree
takes **103ms cold and 9ms** when the copy was made during the previous window.
A pre-built copy is adopted per file only where that file's mtime is strictly
older than the moment the pre-build started reading; everything else is copied
at checkpoint time. A speculative optimisation must never be able to produce a
wrong answer, only a useless one.

---

## Against DeepSeek Harness

Claiming to beat a harness nobody ran is a claim anyone can check in ten
minutes, and dsh is public — so it was run: same two tasks, same model
(`deepseek-v4-flash`), same physical verdict on disk, three runs per cell. Its
turns, tool calls and tokens come from **dsh's own append-only session log**,
not from an estimate.

| Task | Harness | Turns | Tool calls | Tokens | Wall |
|---|---|---|---|---|---|
| A — 6 files | dsh | 2 | 6 | 10 545 | 14.9s |
| A — 6 files | Nefertari `single` | 2 | 6 | **5 664** | 11.4s |
| A — 6 files | Nefertari `plan` | 2 | **1** | 6 468 | **5.9s** |
| B — tagline | dsh | 11 (11–15) | 10–15 | **16 939** | 33s |
| B — tagline | Nefertari `seq` | 7.5 (7–10) | 6 | 17 478 | 25.7s |
| B — tagline | Nefertari `traj` | **6** (6–7) | 6 | 24 748 | **19.3s** |

**Task A is the harness overhead, plainly.** Identical work, identical call
pattern — six writes, two turns, both — and dsh spends **1.9× the tokens**. That
is not a defect: it is what being a harness costs. dsh carries a system prompt, a
tool catalogue, context management and a session-title call on every task, and
Nefertari carries none of that because it is a layer underneath a bare loop.

**Task B is the primitive.** dsh needs **11 turns where the parallel primitive
needs 6**, on the same model — and 4 on `kat-coder-air`. It has no trajectories
primitive, so it can only try one candidate at a time and verify as it goes.
That is the finding, not a handicap imposed on it.

**And the token column does not go our way, so here it is.** On task B dsh spends
16 939 tokens against `traj`'s 24 748: *cheaper than us*. Speculation on
deepseek costs a premium, and against a harness that walks the sequential path
efficiently, that premium is visible. Compared with our own `seq` (17 478) the
two are level — dsh simply takes more turns to spend the same tokens.

### What this comparison is, and is not

It measures **two stacks end to end on one task**, not two implementations of the
same thing. dsh is a complete agent harness; Nefertari is a system layer with a
minimal loop on top. Someone deciding what to run cares about the end-to-end
number, which is why it is here — but reading it as "our agent is better than
their agent" would be reading it wrong.

Wall-clock is the weakest column: dsh ran on the Windows host, Nefertari inside
the Linux container, and both are dominated by provider latency (one dsh run
took 51s against a 14.9s median). **Turns and tokens are the comparable
figures.** Raw data: [`bench-dsh-results.json`](../packages/agentd/examples/bench-dsh-results.json).

---

## Honest readings

- **Bench A's turn count is not a win.** Parallel tool calling already collapses
  flat batches to two turns. `plan_run` wins on calls, wall-clock and
  transactionality.
- **`traj` costs more tokens when the sequential path would have guessed early.**
  On deepseek that is 24 748 against 17 478. It is insurance, and this is the
  premium.
- **Nested JSON defeats the cheapest model.** Doubao's `plan` cell is 1/5. The
  primitive is only as available as the shape it demands.
- **Wall-clock carries provider latency.** Atlas latency spikes appear as
  outliers in every cell (one `traj` run took 179s against a 16s median), which
  is why medians and ranges are reported rather than means.
- **Small sample, short tasks.** Five runs per cell, three models, tasks of
  seconds. The direction is clear and the magnitudes are indicative.
- **Two of three models, for Bench A.** Doubao's `plan` cell has one successful
  run, so its median is a single number rather than a median.

## Reproducing

```bash
docker build -f packages/agentd/Dockerfile -t nefertari-agentd .
ATLASCLOUD_API_KEY=... BENCH_RUNS=5 bash packages/agentd/examples/run-bench-matrix.sh
```

The runner drives the benchmark inside the container, so the enforcer is active
as it is in a real run. Raw results and per-cell medians are written next to
each other; every claim above is recomputable from the raw file.
