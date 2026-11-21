# Orbital Economy Sim — Architecture

Companion to [orbital-economy-sim-build-plan.md](orbital-economy-sim-build-plan.md). The build plan says *what* we're building. This doc covers *how the code is split* so three people can work at the same time, and *how every agent call gets routed* to a model.

## TL;DR

- **Three tracks, one hub.** Track A builds the sim engine (the hub). Track B builds agents and the model gateway. Track C builds the Solana program. B and C never call each other: both plug into A through interfaces frozen on day 0.
- **Agents never touch models or the chain directly.** An agent is a pure function `(observation) → decision`. The engine decides who acts, the gateway decides which model answers, and the engine validates and settles the result.
- **No LiteLLM for v1.** A ~300-line in-process TypeScript gateway on the Anthropic SDK covers tier routing, caching, concurrency, deadlines and cost tracking. LiteLLM only earns its place if we go multi-provider or split universes across processes, and the gateway interface lets us add it later without touching agents. Reasoning is in [Do we need LiteLLM?](#do-we-need-litellm).

---

## 1. System shape

```
                       ┌──────────────────────────────┐
                       │  apps/web (React, Three.js)  │
                       └──────────────▲───────────────┘
                                      │ WebSocket: Snapshot out, GodModeCommand in
┌─────────────────────────────────────┴──────────────────────────────────────┐
│ packages/engine  (TRACK A: the hub)                                        │
│                                                                            │
│  CycleClock ─► Events ─► Production ─► Consumption ─► Markets ─► Trade     │
│                                       ─► FX ─► Credit/Policy ─► Snapshot   │
│                                                                            │
│  Scheduler + TriggerFilter ──AgentTask[]──►  AgentRuntime (Track B)        │
│  Validator  ◄──AgentDecision[]────────────┘                                │
│  Settlement ──Ledger ops──► Ledger interface                               │
└──────────────┬─────────────────────────────────────────┬───────────────────┘
               │                                         │
     ┌─────────▼──────────┐                   ┌──────────▼─────────────────┐
     │ packages/agents    │                   │ Ledger implementations     │
     │ (TRACK B)          │                   │  • InMemoryLedger (A)      │
     │  policies, prompts │                   │  • SolanaLedger (C) ──► Anchor
     │  ModelGateway ─────┼──► Anthropic API  │    program on test-validator
     └────────────────────┘                   └────────────────────────────┘
```

The rule from the build plan holds: **only the engine talks to agents and the ledger.** That rule is what lets the three tracks run in parallel.

### Repo layout (pnpm monorepo)

```
packages/
  contracts/        # day-0 frozen types + zod schemas: Ledger, AgentTask, AgentDecision, Snapshot, GodModeCommand, WorldConfig
  engine/           # Track A: cycle loop, markets, shipping, FX, credit, reserve-bank rules, metrics, detectors, forks, WS server
  ledger-memory/    # Track A: InMemoryLedger (the reference implementation and the test oracle)
  agents/           # Track B: AgentRuntime, policies (stub + LLM), prompts, briefings, surveys
  gateway/          # Track B: ModelGateway, tier router, limiter, cache layout, recorder/replay
  ledger-solana/    # Track C: SolanaLedger adapter (TS client for the program)
programs/
  orbital/          # Track C: Anchor program (Rust)
apps/
  web/              # dashboard + 3D view (Track A from milestone M3; see §2)
```

---

## 2. Three parallel tracks

### Day 0: freeze the contracts (everyone, about half a day)

Nothing parallelizes until these exist in `packages/contracts`. After day 0, changing them needs a short note to the other two tracks.

| Contract | Owner | Consumers | What it pins down |
| --- | --- | --- | --- |
| `Ledger` | A | A, C | Purses, inventories, `placeOrders`, `clearLocalAuction`, `clearFxAuction`, `depart`, `arrive`, `borrow`, `repay`, policy instructions, `checkInvariants()`. All amounts are integers (minor units), never floats |
| `AgentTask` / `AgentDecision` | B | A, B | What an agent sees (observation) and what it may return (actions + survey + reason). Zod schemas double as tool and JSON schemas for the model |
| `Snapshot` / `GodModeCommand` | A | A, web | The per-cycle state pushed over WebSocket and the commands accepted back |
| `WorldConfig` + seed | A | all | Planets, goods, recipes, orbit periods, agent counts, RNG seed |

Each track also ships a **fake** of what it owns on day 1: A ships a scripted engine that emits `AgentTask`s from fixtures, B ships `RandomValidPolicy`, and C works against the `Ledger` interface tests that A writes against `InMemoryLedger`.

### Track A: Sim engine and economy (the hub)

Owns the deterministic core and the critical path. Every other track's milestone depends on A's interfaces staying stable.

| Milestone | Scope | Done when |
| --- | --- | --- |
| A1 | `InMemoryLedger`, cycle loop, 3 planets, production, consumption, local batch auctions | 200 cycles with `RandomValidPolicy`, goods and credits conserved |
| A2 | Orbits, shipping and travel times, customs, FX pair auctions | Freighters move and FX clears with stub traders |
| A3 | Credit, rule-based reserve banks, metrics (GDP, CPI, trade balance…), SQLite snapshots, WS server | Build-plan Phase 0 exit test passes. Snapshot stream is live |
| A4 | God-mode event handlers, fork (copy ledger + RNG state), detectors (trade war, currency crisis, recession, diversion) | Each event changes the metric it should under stub agents |
| A5 | `apps/web`: metric panels, event feed, god-mode panel, then the 3D view | Dashboard runs against recorded snapshots and against a live run |

Frontend starts at A5 because the engine is the critical path. It builds against **recorded `Snapshot` fixtures**, so it never blocks on a live run. If a fourth person joins, `apps/web` becomes Track D and starts on day 1 against fixtures.

### Track B: Agents and the model gateway

Owns everything between "agent X is due this cycle" and "here is a validated decision."

| Milestone | Scope | Done when |
| --- | --- | --- |
| B1 | `AgentRuntime`, `StubGateway`, rule-based stub policies for colonists and traders (smarter than random: follow prices, respect comparative advantage) | Plugs into A1 with no engine changes |
| B2 | `AnthropicGateway`: tier router, prompt cache layout, concurrency limiter, deadlines, recorder/replay, cost meter | 50-cycle LLM run under budget, `cache_read_input_tokens` > 0 on most calls |
| B3 | Colonist and trader prompts, triggers (with A), standing orders, confidence surveys | Build-plan Phase 1 exit test: plausible prices and FX, trade follows comparative advantage |
| B4 | Governments: briefings (balanced), approval, petitions, elections, policy tools. LLM mode for reserve banks | Phase 3 exit test: a tariff episode in ≥ 1 of 8 seeds, no god mode |
| B5 | News agent, agent inspector data, economist report, multi-universe cost controls | Phase 4/5 storytelling features work off recorded runs |

### Track C: Solana program

Owns the on-chain mirror of `InMemoryLedger`. The riskiest track, so it gets the most isolation.

| Milestone | Scope | Done when |
| --- | --- | --- |
| C1 | Anchor skeleton: 3 SPL mints with PDA mint authority, 3 zero-copy planetary ledgers, `SolanaLedger` adapter with purses and inventories only | Ledger contract tests pass for balances and transfers |
| C2 | Local batch auction (off-chain sort, on-chain one-pass verify), FX pair books | Auction contract tests match `InMemoryLedger` results exactly |
| C3 | Shipment accounts, `depart`/`arrive`, customs vaults, tariffs, quotas, embargoes | Shipping contract tests pass |
| C4 | Credit (`borrow` mints, `repay` burns), treasuries, bonds, FX reserves, all policy instructions, on-chain invariants | Full contract suite green |
| C5 | Swap-in run: same seed on `InMemoryLedger` and `SolanaLedger`, diff every snapshot | Phase 2 exit test: identical run, fully reconciled on-chain |

**The ledger contract test suite is the handshake between A and C.** Track A writes it against `InMemoryLedger`, and Track C runs the identical suite against `SolanaLedger`. If both pass, the swap in C5 is a config flag.

### Sync points

```
Day 0      contracts frozen
Week 1     A1 + B1 + C1      → stub run on InMemoryLedger
Week 2     A3 + B2/B3 + C2   → first LLM run (Phase 1 exit)
Week 3     A4 + B4 + C3/C4   → politics on, god mode on
Week 4     A5 + B5 + C5      → on-chain swap-in, dashboard, 8-seed results, demo
```

Two integration rules: `main` always runs a 200-cycle stub run in CI (about 2 minutes), and nobody merges a change to `packages/contracts` without a review from one other track.

---

## 3. Agent architecture

### 3.1 Agents are stateless functions

An agent never holds a connection, a key or a conversation. Every call is:

```ts
// packages/contracts
interface AgentTask {
  universeId: string; cycle: number; agentId: string;
  role: 'colonist' | 'trader' | 'government' | 'reserve_bank' | 'news' | 'economist';
  planet: PlanetId;
  observation: Observation;     // compact state: top-3 book levels, 5-cycle trend, own purse, open orders, memo
  allowedActions: ActionKind[]; // derived from role + cycle (policy tools only on policy cycles)
  deadlineMs: number;
}

interface AgentDecision {
  agentId: string;
  actions: Action[];            // validated by the engine, never trusted
  survey?: SurveyAnswer;        // rides along on every call (consumer or business confidence)
  reason: string;               // 1–2 sentences, feeds the agent inspector
  memo?: string;                // ≤ 200 chars the agent leaves for its next turn
  source: 'llm' | 'stub' | 'standing_orders' | 'replay';
  usage?: { model: string; inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number; latencyMs: number };
}
```

**No per-agent chat history.** Each turn is a fresh request built from the current observation plus the agent's own `memo`. That keeps prompts small and flat-sized over 200 cycles, makes every call cacheable the same way, and makes replay and forks trivial. The `memo` gives agents continuity ("waiting for the Verdan launch window") without a growing transcript.

### 3.2 The life of one cycle's agent calls

```
 engine (Track A)                         agents + gateway (Track B)                    Anthropic API
 ────────────────                         ──────────────────────────                    ─────────────
 1. Scheduler: who is due?
    • colonists: TriggerFilter
      (price moved >5%, unfilled order,
       loan due, policy changed, every 4th
       cycle, 20% survey sample every 5th)
    • traders: freighter docked/idle
    • governments: every 5th cycle or shock
    • reserve banks: rule (no call) unless LLM mode
 2. Build AgentTask[] (≈70/cycle)  ──────► 3. AgentRuntime.decideAll(tasks)
                                              for each task:
                                              a. pick Policy (stub | llm | replay)
                                              b. PromptBuilder → cached prefix + suffix
                                              c. ModelGateway.invoke(request)  ──────────► Messages API
                                                 • TierRouter: role → tier → model         (parallel, rate-
                                                 • Limiter: per-tier semaphore +             limited)
                                                   token bucket (RPM / ITPM / OTPM)
                                                 • deadline via AbortController
                                                 • ≤ N tool turns (colonist 1, trader 3, gov 4)
                                              d. parse + zod-validate submit_turn  ◄────── tool_use / JSON
                                              e. on timeout / 429 / invalid / refusal
                                                 → StandingOrdersPolicy
                                              f. Recorder writes request + response
 5. Validator: funds, inventory,   ◄──────── 4. AgentDecision[]
    allowed this cycle? Clip or reject.
 6. Settlement via Ledger interface
```

Steps 1, 5 and 6 are Track A. Steps 3–4 are Track B. The deadline from the build plan (5–8 s per cycle) is enforced in the gateway, and a miss always resolves to standing orders, so a slow provider can never stall the cycle.

### 3.3 How a call is routed

Routing is a config table, not code scattered through agents:

```ts
// packages/gateway/routing.ts
const ROUTES: Record<Role, Route> = {
  colonist:     { tier: 'small',    maxTurns: 1, effort: 'low',    maxTokens: 1_000, mode: 'structured' },
  trader:       { tier: 'small',    maxTurns: 3, effort: 'medium', maxTokens: 2_000, mode: 'tools' },
  government:   { tier: 'frontier', maxTurns: 4, effort: 'medium', maxTokens: 8_000, mode: 'tools' },
  reserve_bank: { tier: 'rule' },                                    // LLM mode → 'mid'
  news:         { tier: 'small',    maxTurns: 1, effort: 'low',    maxTokens: 800,   mode: 'structured' },
  economist:    { tier: 'frontier', maxTurns: 1, effort: 'high',   maxTokens: 16_000, mode: 'text' },
};

const TIERS: Record<Profile, Record<Tier, ModelId | 'stub'>> = {
  stub:  { small: 'stub',             mid: 'stub',              frontier: 'stub' },
  cheap: { small: 'claude-haiku-5-5', mid: 'claude-haiku-5-5',  frontier: 'claude-sonnet-5-5' }, // tuning runs
  full:  { small: 'claude-haiku-5-5', mid: 'claude-sonnet-5-5', frontier: 'claude-opus-5-5' },   // demo runs
};
```

- **Role → tier → model.** Agents only name their role. Each universe picks a profile (`stub`, `cheap`, `full`), which is how "stub universes for tuning, frontier governments only for final runs" from the risk table becomes one flag.
- **Traders default to `small`.** The build plan has traders on a mid model. With thinking tokens billed as output, a mid-tier trader at about 2,400 calls per run is the largest line in the budget (see §3.6). Start traders on Haiku 5.5, run an A/B against Sonnet 5.5 on the same seed, and promote only if trade quality clearly improves.
- **Overrides** in god mode or config: `route.override(agentId | role | planet, tier)`, for example to give one government a different model in an experiment.
- **One model per role for the whole run.** Prompt caches are scoped to a model, so switching a role's model mid-run throws away its cache. Downgrades happen only in the fallback path (standing orders), never by hopping models.

### 3.4 Three call modes

| Mode | Used by | Shape | Why |
| --- | --- | --- | --- |
| `structured` | Colonists, news | One request, `output_config.format` JSON schema built from the zod `AgentDecision` schema. No tools | Cheapest and fastest. Everything a colonist needs is already in the observation |
| `tools` | Traders, governments | Read tools (`quote_route`, `fx_quote`, `book_depth`, `briefing_detail`) plus one terminal tool `submit_turn` with `strict: true`. Loop until `submit_turn` or `maxTurns` | Traders need to price routes; governments drill into briefings. The terminal tool keeps the output schema-valid |
| `text` | Economist report | One streamed request, plain prose | Long output, end of run only |

Notes for current Claude models, which the gateway must respect:

- Forced `tool_choice` (`any` / a named tool) is rejected on Opus 5.5 and Sonnet 5.5. Use `tool_choice: auto`, tell the model to finish with `submit_turn`, and treat "no `submit_turn` by the last turn" as a fallback to standing orders.
- Thinking can't be turned off on Opus 5.5. Cost and latency are controlled with `output_config.effort` (`low` for colonists, `medium` for traders and governments).
- Check `stop_reason` before reading content. A `refusal` resolves to standing orders, the same as a timeout.
- Read tools are pure functions over the engine's read-only view for the current cycle. They can't change state, so a tool loop can't break determinism.

### 3.5 Prompt layout for caching

Requests are laid out so the expensive parts are shared and the per-agent part is last:

```
┌─ tools ─────────────────────────────┐  role's tool list, sorted by name, byte-identical all run
├─ system: world rules + role rules ──┤  frozen text: economics, goods, recipes, how to act
│                    ◄── breakpoint 1 │  shared by every agent of this role on every planet
├─ user: planet/cycle context ────────┤  this planet's market summary, news, policy, confidence indexes
│                    ◄── breakpoint 2 │  shared by every agent of this role on this planet this cycle
├─ user: agent's own state ───────────┤  purse, inventory, open orders, skills, personality, memo
└─────────────────────────────────────┘  uncached, kept to a few hundred tokens
```

- With about 30 colonists per planet hitting the same prefix within seconds, breakpoint 2 is written once per planet per cycle and read about 10–20 times. Breakpoint 1 is read on every call of that role.
- Calls with a shared prefix land seconds apart, so the default 5-minute TTL stays warm on its own. The 1-hour TTL would only double write costs.
- The current models cache prefixes from 512 tokens, so even the colonist system prompt clears the minimum. Verify it anyway: the gateway logs `usage.cache_read_input_tokens` per role, and a cycle where it reads zero for a role trips a warning.
- Silent cache killers to keep out of the prefix: timestamps, cycle numbers in the system block, unsorted JSON, per-agent names, a tool list that changes between calls. The cycle number belongs in the planet-context block.
- **Warm before fan-out.** Send the first request of each (role, planet) group alone, then release the rest of the group. Otherwise 30 parallel requests all miss and all pay for the write.

### 3.6 Concurrency, deadlines and cost

**Concurrency.** One `Limiter` per model, sized from the account's rate limits: a semaphore for in-flight requests plus token buckets for requests, input tokens and output tokens per minute. The per-cycle peak is about 70 calls, mostly Haiku, so a single process handles it. For 8 universes, run them all in **one Node process sharing one gateway** (or worker threads with the gateway on the main thread). The limiter then throttles across universes for free.

**Deadlines.** Each `AgentTask` carries `deadlineMs`. The gateway retries a 429 or 5xx only if the remaining deadline covers it, otherwise it returns `standing_orders`. The engine never waits past the cycle deadline.

**Cost meter.** Every response's `usage` is priced from a table in `gateway/pricing.ts` and summed per run, role and model. A hard per-run budget (default $15) switches remaining calls to stub with a feed event, so a bug can't burn money overnight.

Rough per-run estimate at the build plan's call counts (`full` profile). Recompute from the cost meter after B2. Thinking tokens dominate, which is why effort and `maxTokens` are set per role:

| Role | Calls / run | Model | Est. cost |
| --- | --- | --- | --- |
| Colonists | ~11,000 | Haiku 5.5 | ~$2–3 |
| Traders | ~2,400 (×1–3 turns) | Haiku 5.5 | ~$2–4 |
| Traders, if promoted | same | Sonnet 5.5 | ~$12–20 |
| Governments | ~120–150 | Opus 5.5 | ~$7–14 |
| News + economist | ~120 + 1 | Haiku / Opus | < $1 |
| **Total (traders on Haiku)** | | | **~$12–22** |

The government line is what to watch against the $15 target. Levers in order: effort `low` on routine reviews and `medium` only after shocks, a tighter briefing, then `cheap` profile (Sonnet 5.5) for governments in tuning runs.

**Batch API: not for the loop.** Batches are cheaper but asynchronous, and each cycle depends on the last. It doesn't fit the live sim.

### 3.7 Recorder and replay

Every gateway call is written to `runs/<universe>/calls.jsonl` keyed by `(cycle, agentId, turn)`, with the full request, response, usage and latency.

- **`ReplayGateway`** returns recorded responses instead of calling the API. A recorded run replays for free and gives the same result every time, so the dashboard, detectors and Track C's on-chain diff (C5) can all use real LLM runs at no cost.
- **Forks** replay the parent's calls up to the fork cycle and go live after it. The two branches share identical history, which is the clean counterfactual the build plan asks for.
- **Prompt review.** The "briefings bias the result" and "sci-fi drift" risks both need logged prompts. This is that log.

### 3.8 Policies

`AgentRuntime` picks a policy per task:

| Policy | When | Notes |
| --- | --- | --- |
| `LlmPolicy` | Default for due agents in `cheap`/`full` profiles | Goes through the gateway |
| `StubPolicy` | `stub` profile, budget exhausted, CI | Rule-based, deterministic per seed |
| `StandingOrdersPolicy` | Agent not due, timeout, invalid output, refusal | Repeats the last stall and shopping list. The common case for about 65% of colonists each cycle |
| `ReplayPolicy` | Replaying a recorded run or the pre-fork part of a fork | Wraps `ReplayGateway` |
| `RulePolicy` | Reserve banks by default | The Taylor-style rule from the build plan, no model |

---

## 4. Do we need LiteLLM?

**No, not for v1.** Here is what we need from the routing layer and who covers it:

| Need | In-process gateway on the Anthropic SDK | LiteLLM proxy |
| --- | --- | --- |
| Role → tier → model routing | A config table (§3.3) | Model aliases in YAML |
| Prompt caching with exact breakpoint placement | Native `cache_control`, exactly as laid out in §3.5 | Passes through, but via an OpenAI-shaped translation layer. Breakpoint placement is harder to control and to verify |
| `effort`, structured outputs, `strict` tools, `refusal` stop reason | Native | Depends on how well the translation keeps up with new Anthropic parameters |
| Concurrency and rate limits | `Limiter` (§3.6), shared by all universes in one process | Built in, and shared across processes |
| Per-cycle deadline with standing-orders fallback | Has to live in our code either way | Has to live in our code either way |
| Cost tracking and a hard budget | `usage` × price table | Built-in spend tracking and budgets |
| Stub and replay modes | Just other `ModelGateway` implementations | Not its job. We'd build these anyway |
| Ops | Nothing extra | A Python sidecar (Docker) next to a Node stack, one more network hop inside a 5–8 s deadline, one more process to fail in a live demo |

LiteLLM's real strengths are multi-provider routing, cross-process rate limiting and spend dashboards. None of those is a v1 requirement if we run one provider and keep all universes in one process.

**When to revisit it:**

- We add a second provider, for example a very fast host for colonists to cut cycle latency.
- Universes must run as separate processes or machines and share one rate limit and budget.
- The team wants per-person virtual keys and a spend dashboard for development.

**How to keep the door open:** everything goes through one interface, so LiteLLM would be just another adapter:

```ts
interface ModelGateway {
  invoke(req: GatewayRequest, signal: AbortSignal): Promise<GatewayResult>;
}
// implementations: StubGateway, ReplayGateway, AnthropicGateway, (later) LiteLlmGateway
```

If we do add it, pin the exact version or image digest and keep the Anthropic adapter as the default for governments, where caching and effort control matter most.

---

## 5. Open decisions

| Decision | Default in this doc | Owner |
| --- | --- | --- |
| Traders on Haiku 5.5 or Sonnet 5.5 | Haiku, A/B in B3 | B |
| Who builds the frontend | Track A from A5, or Track D if a 4th person joins | Team |
| Governments' effort level | `low` routine, `medium` after shocks | B |
| Universes in one process or many | One process, shared gateway | A + B |
| Per-run hard budget | $15, then stub | B |
