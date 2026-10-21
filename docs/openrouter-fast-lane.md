# OpenRouter fast lane — the free block is ordered by the measured answer time

Owner decision (2026-10-21): the free OpenRouter models must be **after every other free
provider** and **before the paid tail**, and inside that block the ladder must use the
**fastest** free OpenRouter models — with a **second reserve model** behind the first one.

This document explains how the ordering is measured and applied.

## The rules, in one place

1. **Free before paid.** The `openrouter/*:free` block of a ladder stands after the free rungs of
   the other providers (`opencode-go/*-free`, `zen-rings/*-free`) and before the paid tail.
   `config/ladders.json` is the source of truth; `test/openrouter-fast-lane.test.js` asserts the
   invariant over **every** ladder and role (the old config violated it in 11 of them — the two
   ring rungs `zen-rings/big-pickle` and `zen-rings/nemotron-3.5-lightning-free` used to sit
   *behind* the OpenRouter block).

   The paid Go rung inside the service ladders (`opencode-go/mimo-v2.6-flash`) stays where it is:
   it is the "strong tier" of those ladders, the same pattern `doctor` / `research` use.

2. **Speed decides, quality breaks the tie.** The free OpenRouter block is reordered by the
   measured p50 answer time of the current context tier. When two models answer within a small
   margin (≤ 25% + 500 ms of the fastest), the speed is a tie and the **more capable** model takes
   the first slot; the fastest one becomes the reserve behind it.

3. **The block keeps its place.** Reordering happens *inside* the block. The block never moves in
   front of another provider's free rungs and never behind the paid tail.

## How the measurement works

The same pipeline that measures the free Go models now measures the free OpenRouter models:

- **When** — every collect pass (`POST /v1/free-models/collect`, the `collect-free-models`
  workflow, cron `13 */4 * * *`). A model is re-measured when it has no measurement yet, when the
  last one failed, or when it is older than 24 hours.
- **What** — the free OpenRouter models of the current catalog, three models per pass, measured
  in parallel. Each model answers the tier prompts twice: `small` (1 KB), `medium` (32 KB),
  `large` (128 KB) — the tier is chosen by the estimated prompt size, so a 40 KB prompt is never
  ranked by the number of a 1 KB prompt.
- **With which key** — one key per model, rotated over the whole pool (the env secret plus the
  admin-managed tokens in D1, `docs/provider-credentials.md`). The free tier rate-limits per key,
  so the bench spreads over the pool instead of hammering one key. The key never leaves the
  worker and never lands in a log or in the report.
- **What is stored** — `free_model_benchmarks` (`provider = 'openrouter'`), one row per model:
  `attempts`, `successes`, `correct`, `p50_ms`, `out_tokens`, `truncated`, `last_error` per tier.

### The quality proxy — what it is and what it is not

`correct` counts how often the model followed the instruction of the bench prompt
(`Reply with exactly: ready`); the second signal is the context window from the catalog. This is
a **proxy**, not a quality benchmark: it separates "answers correctly and fast" from "answers
slowly", not "writes better code". The rule is deliberately conservative — the tie-break only
matters when two models are within the same margin of speed, and the winner is the one that
followed the instruction.

### Why a model that burns the budget never joins the ladder

A model that needs most of the 1500-token bench budget to answer is a **reasoning** model. Its
token floor in the ladder is unknown there (`REASONING_MODELS` is a static list, and a reasoning
model under the plain floor can come back empty — issue #38). Such a model is measured and
ordered inside the block it is already part of, but it is **not** injected into a ladder it is
not configured in.

## The effect

- The block of every ladder is ordered per call: the fastest measured model for the current
  prompt size leads, the next one is the reserve, the unmeasured rungs keep their place at the
  end of the block.
- A free OpenRouter model that is not in `config/ladders.json` may **join** the block when it is
  available in the catalog, measured successfully on that tier, and answered within its budget.
- Benchmarks are read from D1 with a 60-second cache; an inventory outage never interrupts a
  ladder call.

## What it does not change

- The Go block rules (`orderBenchmarkedGoRungs`) — unchanged.
- The paid tail, the tier ladders, `doctor` / `research` — unchanged.
- The token rotation: every next OpenRouter request takes the next key of the pool
  (`nextOpenrouterKeyIndex`), and a key that answers 401/429 rotates once within the call.

## Known limits (issue #294)

- **The sweep is slow.** Three models per pass, a pass every 4 hours: with ~20 free models in the
  catalog a full round takes ~1.5 days. A model that leaves the catalog is not measured again — it
  simply disappears from the block, and the ladder order does not change.
- **The catalog shrinks.** The last collect pass lost 21 models from the inventory (13
  `opencode-zen`, 3 `opencode-go`, 5 `openrouter`). The ladder still names one of the gone ones —
  `openrouter/inclusionai/ling-3.0-flash-sante:free` in 11 `service.*` roles — so it costs a hop
  per call until the config is synchronised with the catalog.
- **Quality is a proxy** (see above): `correct` plus the context window, not a quality benchmark.
