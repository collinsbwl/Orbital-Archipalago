# Orbital Economy Sim — Architecture

Companion to [orbital-economy-sim-build-plan.md](orbital-economy-sim-build-plan.md). The build plan says *what* we're building. This doc covers *how the code is split* so three people can work at the same time, and *how every agent call gets routed* to a model.

## TL;DR

- **Three tracks, one hub.** Track A builds the sim engine (the hub). Track B builds agents and the model gateway. Track C builds the Solana program. B and C never call each other: both plug into A through interfaces frozen on day 0.
- **Agents never touch models or the chain directly.** An agent is a pure function `(observation) → decision`. The engine decides who acts, the gateway decides which model answers, and the engine validates and settles the result.
- **No LiteLLM for v1.** A ~300-line in-process TypeScript gateway on the Gemini SDK (`@google/genai`) covers tier routing, context caching, concurrency, deadlines and cost tracking. LiteLLM only earns its place if we go multi-provider or split universes across processes, and the gateway interface lets us add it later without touching agents. Reasoning is in [Do we need LiteLLM?](#do-we-need-litellm).
- **Hackathon stack, one job each.** Gemini decides and explains. Solana settles. Tiger Data stores the economy's history and serves the charts. Auth0 decides who may watch and who may touch god mode. Vultr runs everything — sim and web app — on one VM, deployed with Coolify. Map is in [Hackathon stack](#hackathon-stack).

---

## Hackathon stack

Each sponsor owns a layer we already needed. None of them is a demo route bolted on beside the sim.

| Technology | Lives in | What it does in this project |
| --- | --- | --- |
| **Gemini API** | `packages/gateway` (`GeminiGateway`) and the spectator advisor in `apps/web` | Colonists, traders, and governments decide in natural language. The news agent writes the cycle's headlines. The economist reads Tiger aggregates and writes the end-of-run report. A logged-in spectator can ask the advisor for advice grounded in the live snapshot ("what happens if I tariff iron on Helion?"). |
| **Solana** | `programs/orbital`, `packages/ledger-solana` | Every auction, shipment, loan, and tariff settles on-chain. Local batch auctions and FX books are the DEX. `borrow` / `repay` is the lending market. Shipments, customs, and embargoes are the supply chain. Agent and planet PDAs are the identity. A cycle can clear dozens of transfers because confirmation is fast and fees are near zero. |
| **Tiger Data** | Engine metrics writer, read back into `Snapshot` chart series | PostgreSQL, so the SQL we already know. One database holds relational rows (Auth0 users, universes, world config) beside hypertables of cycle metrics (GDP, CPI, prices, FX, trade balance, gateway cost). Continuous aggregates feed the dashboard charts. Compression is what makes 8 universes × 200 cycles of ticks cheap to keep. |
| **Auth0** | `apps/web`, enforced again on the Vultr engine | Social login, passwordless, and MFA come from Auth0. Roles are `spectator` and `operator`. Spectators watch and talk to the advisor. Operators send `GodModeCommand`. The advisor is the Auth0-for-AI-Agents surface: the endpoint checks the caller's token before Gemini sees the question. |
| **Vultr + Coolify** | Cloud Compute VM | One box runs everything. Coolify (self-hosted PaaS) manages a Docker Compose stack: Caddy fronts the single domain and routes `/` to the `apps/web` static build, `/ws` to the engine WebSocket, and `/api` to the advisor HTTPS endpoint; the engine Node process holds the cycle loop, Gemini gateway and Solana client; `solana-test-validator` runs beside it. Same origin means one Auth0 callback and no CORS. |

### Can we host everything on one Vultr VM?

Yes — Coolify is the easy path.

```
Browser
  │  Auth0 login + API calls (one origin)
  ▼
https://<your-domain>  ── Vultr Cloud Compute, managed by Coolify ──┐
                         ├─ Caddy (TLS + routing, bundled with Coolify)
                         │    ├─ /         → apps/web (static build)
                         │    ├─ /ws       → engine WebSocket
                         │    └─ /api      → advisor HTTPS
                         ├─ packages/engine  (cycle loop, WS + HTTP server)
                         ├─ packages/gateway (Gemini API)
                         ├─ Solana test-validator + SolanaLedger
                         └─ reads/writes Tiger Data Cloud
```

- **Coolify** is the PaaS on the VM: git-push deploys, per-PR preview environments, log aggregation, Let's Encrypt TLS, and the Docker Compose definition for engine + `solana-test-validator`. The SPA deploys as a static site Coolify builds from the same repo.
- **Vultr Cloud Compute** is the one box. The engine process is alive for the whole demo, holds the gateway limiter, and keeps the 5–8 s cycle deadline — a serverless function cannot own that loop. A GPU stays off: inference is the Gemini API. GPU is open only if we later host a local model.
- **Tiger Data Cloud** (free tier) is the database. The connection string is a Coolify env var on the engine service. The SPA never talks to Postgres. Chart series ride along in `Snapshot`, filled from continuous aggregates. A `god_mode_audit` table records which Auth0 `sub` fired which command.
- **Auth0** is the only identity provider, and the single origin collapses the config: one SPA callback URL, one API audience. The engine validates the JWT (issuer, audience, `operator` role for god mode) on the WS handshake and on `/api/advisor`. Same origin also means no CORS.

What we give up versus Vercel: a global CDN for the SPA, push-to-deploy polish, and the Vercel sponsor slot. For the demo that's a fair trade for one domain, one deploy and one log stream.

Local dev still matches the demo shape: Docker Compose on a laptop runs the engine + a Timescale-compatible Postgres (Tiger's extension) + Caddy. Coolify is only the hosted PaaS.

## 1. System shape

```
 Auth0 ──JWT──► ┌────────────────────────────────┐
                │ apps/web (static, via Coolify) │
                │ React, Three.js, advisor chat  │
                └───────────────▲────────────────┘
                                │ WSS: Snapshot out, GodModeCommand in
                                │ HTTPS: advisor question in, answer out
┌───────────────────────────────┴────────────────────────────────────────┐
│ Vultr Cloud Compute                                                    │
│ packages/engine  (TRACK A: the hub)                                    │
│                                                                        │
│  CycleClock ─► Events ─► Production ─► Consumption ─► Markets ─► Trade │
│                                       ─► FX ─► Credit/Policy ─► Snapshot│
│                                                                        │
│  Scheduler + TriggerFilter ──AgentTask[]──►  AgentRuntime (Track B)    │
│  Validator  ◄──AgentDecision[]────────────┘                            │
│  Settlement ──Ledger ops──► Ledger interface                           │
│  metrics row / chart series ──────────► Tiger Data                     │
└──────────────┬─────────────────────────────────────┬───────────────────┘
               │                                     │
     ┌─────────▼──────────┐               ┌──────────▼─────────────────┐
     │ packages/agents    │               │ Ledger implementations     │
     │ (TRACK B)          │               │  • InMemoryLedger (A)      │
     │  policies, prompts │               │  • SolanaLedger (C) ──► Anchor
     │  GeminiGateway ────┼──► Gemini API │    program on the Vultr    │
     └────────────────────┘               │    test-validator          │
                                          └────────────────────────────┘
```

The rule from the build plan holds: **only the engine talks to agents and the ledger.** That rule is what lets the three tracks run in parallel.

### Repo layout (pnpm monorepo)

```
packages/
  contracts/        # day-0 frozen types + zod schemas: Ledger, AgentTask, AgentDecision, Snapshot, GodModeCommand, WorldConfig
  engine/           # Track A: cycle loop, markets, shipping, FX, credit, reserve-bank rules, metrics, detectors, forks, WS server, Tiger writer
  ledger-memory/    # Track A: InMemoryLedger (the reference implementation and the test oracle)
  agents/           # Track B: AgentRuntime, policies (stub + LLM), prompts, briefings, surveys, advisor
  gateway/          # Track B: ModelGateway, GeminiGateway, tier router, limiter, cache layout, recorder/replay
  ledger-solana/    # Track C: SolanaLedger adapter (TS client for the program)
programs/
  orbital/          # Track C: Anchor program (Rust). Auctions, credit, shipments, policy — the on-chain economy
apps/
  web/              # Served by Coolify on the same Vultr VM. Dashboard, 3D view, Auth0, advisor chat (Track A from A5; see §2)
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
| A3 | Credit, rule-based reserve banks, metrics (GDP, CPI, trade balance…), Tiger Data hypertables + continuous aggregates, WS server | Build-plan Phase 0 exit test passes. Snapshot stream is live and chart series come from continuous aggregates |
| A4 | God-mode event handlers, fork (copy ledger + RNG state), detectors (trade war, currency crisis, recession, diversion) | Each event changes the metric it should under stub agents. Operator commands land in `god_mode_audit` |
| A5 | `apps/web` served by Coolify on the Vultr VM: Auth0 login, metric panels, event feed, god-mode panel (operators only), then the 3D view | Dashboard runs against recorded snapshots and against a live run on Vultr |

Frontend starts at A5 because the engine is the critical path. It builds against **recorded `Snapshot` fixtures**, so it never blocks on a live run. If a fourth person joins, `apps/web` becomes Track D and starts on day 1 against fixtures.

### Track B: Agents and the model gateway

Owns everything between "agent X is due this cycle" and "here is a validated decision."

| Milestone | Scope | Done when |
| --- | --- | --- |
| B1 | `AgentRuntime`, `StubGateway`, rule-based stub policies for colonists and traders (smarter than random: follow prices, respect comparative advantage) | Plugs into A1 with no engine changes |
| B2 | `GeminiGateway`: tier router, explicit context-cache layout, concurrency limiter, deadlines, recorder/replay, cost meter | 50-cycle LLM run under budget, cached-token hits on most calls |
| B3 | Colonist and trader prompts, triggers (with A), standing orders, confidence surveys | Build-plan Phase 1 exit test: plausible prices and FX, trade follows comparative advantage |
| B4 | Governments: briefings (balanced), approval, petitions, elections, policy tools. LLM mode for reserve banks | Phase 3 exit test: a tariff episode in ≥ 1 of 8 seeds, no god mode |
| B5 | News agent (cycle headlines), agent inspector data, economist report grounded in Tiger aggregates, spectator advisor, multi-universe cost controls | Phase 4/5 storytelling features work off recorded runs. Advisor answers a logged-in user from the live snapshot |

### Track C: Solana program

Owns the on-chain mirror of `InMemoryLedger`. The riskiest track, so it gets the most isolation.

This is the Solana prize surface, and it is the same work as the ledger port:

- **High-frequency settlement.** A cycle can settle production, a local auction, an FX book, and every freighter that docks. Fees stay negligible, so we settle the economy instead of batching it into one blob.
- **Trading and lending.** Local batch auctions and FX pair books are the exchange. `borrow` mints and `repay` burns are the credit market, with treasuries, bonds, and FX reserves beside them.
- **Supply chain.** Shipments, travel time, customs vaults, tariffs, quotas, and embargoes are goods moving between planets with rules enforced on-chain.
- **Identity.** Planet ledgers and agent purses are PDAs. A balance is an account, not a row we assert in the UI.

Dev and the live demo run `solana-test-validator` on the Vultr box so C5 can diff against `InMemoryLedger` without devnet airdrop flakiness. A public devnet deploy is a follow-up if we want an explorer link in the submission.

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
 engine (Track A, on Vultr)              agents + gateway (Track B)                    Gemini API
 ──────────────────────────              ──────────────────────────                    ──────────
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
                                              c. ModelGateway.invoke(request)  ──────────► generateContent
                                                 • TierRouter: role → tier → model         (parallel, rate-
                                                 • Limiter: per-tier semaphore +             limited)
                                                   token bucket (RPM / TPM)
                                                 • deadline via AbortController
                                                 • ≤ N tool turns (colonist 1, trader 3, gov 4)
                                              d. parse + zod-validate submit_turn  ◄────── function call / JSON
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
  stub:  { small: 'stub',         mid: 'stub',         frontier: 'stub' },
  cheap: { small: 'gemini-flash', mid: 'gemini-flash', frontier: 'gemini-flash' }, // tuning runs
  full:  { small: 'gemini-flash', mid: 'gemini-flash', frontier: 'gemini-pro' },   // demo runs
};
```

`gemini-flash` and `gemini-pro` are tier names. The routing table pins the current Gemini model ids (the Flash and Pro SKUs available that weekend) in one place.

- **Role → tier → model.** Agents only name their role. Each universe picks a profile (`stub`, `cheap`, `full`), which is how "stub universes for tuning, frontier governments only for final runs" from the risk table becomes one flag.
- **Traders default to `small`.** The build plan has traders on a mid model. Thinking tokens are billed as output, so a Pro trader at about 2,400 calls per run is the line that blows the budget (see §3.6). Start traders on Flash, run an A/B against Pro on the same seed, and promote only if trade quality clearly improves.
- **Three Gemini jobs, matching how the model is actually good at language.** Flash and Pro *decide* (colonists, traders, governments). Pro *reads* the Tiger aggregate series and writes the economist report. Flash *writes* the news headlines. The spectator advisor is a separate, user-triggered call: personalized advice from the live snapshot plus that user's god-mode history, gated by Auth0. It is not inside the cycle loop.
- **Overrides** in god mode or config: `route.override(agentId | role | planet, tier)`, for example to give one government a different model in an experiment.
- **One model per role for the whole run.** Explicit caches are scoped to a model, so switching a role's model mid-run throws away its cache. Downgrades happen only in the fallback path (standing orders), never by hopping models.

### 3.4 Three call modes

| Mode | Used by | Shape | Why |
| --- | --- | --- | --- |
| `structured` | Colonists, news | One `generateContent`, `responseMimeType: application/json` and a `responseSchema` built from the zod `AgentDecision` schema. No tools | Cheapest and fastest. Everything a colonist needs is already in the observation. News uses the same shape with a short headline schema |
| `tools` | Traders, governments, advisor | Function declarations (`quote_route`, `fx_quote`, `book_depth`, `briefing_detail`, and for the advisor `metric_history`) plus one terminal function `submit_turn`. Loop until `submit_turn` or `maxTurns` | Traders price routes; governments drill into briefings; the advisor pulls a continuous aggregate before it answers. The terminal function keeps the output schema-valid |
| `text` | Economist report | One streamed request, plain prose, with the Tiger aggregate series already in the prompt | Long output, end of run only |

Notes the gateway must respect for Gemini:

- Per-role thinking budget (`thinkingConfig.thinkingBudget`) is the cost and latency knob: small for colonists and news, larger for traders and governments, largest for the economist.
- A safety block, a missing `submit_turn` by the last turn, or invalid JSON resolves to standing orders, the same as a timeout. The advisor surfaces an error to the user instead, because there is no sim action to fall back to.
- Read tools are pure functions over the engine's read-only view for the current cycle (or over Tiger aggregates for `metric_history`). They can't change state, so a tool loop can't break determinism.

### 3.5 Prompt layout for caching

Requests are laid out so the expensive parts are shared and the per-agent part is last. Gemini explicit context caching (`caches.create`, then `cachedContent` on `generateContent`) stores the prefix:

```
┌─ tools ─────────────────────────────┐  role's function declarations, sorted by name, byte-identical all run
├─ system: world rules + role rules ──┤  frozen text: economics, goods, recipes, how to act
│                    ◄── cached prefix │  one cache per (role, planet, cycle), TTL ~5 minutes
├─ user: planet/cycle context ────────┤  this planet's market summary, news, policy, confidence indexes
├─ user: agent's own state ───────────┤  purse, inventory, open orders, skills, personality, memo
└─────────────────────────────────────┘  uncached, kept to a few hundred tokens
```

- One cache object per `(role, planet, cycle)` holds tools, system rules, and that planet's cycle context. About 30 colonists on a planet then reference it. The role-level rules also sit in a longer-lived cache reused across planets and cycles, since that text never changes during a run.
- Cache TTL is 5 minutes. Calls for a planet land in the same cycle, seconds apart, so the TTL stays warm on its own.
- The prefix has to clear Gemini's minimum cache size. The gateway logs cached-token counts per role, and a cycle where a role never hits trips a warning.
- Silent cache killers to keep out of the prefix: timestamps, cycle numbers in the system block, unsorted JSON, per-agent names, a tool list that changes between calls. The cycle number belongs in the planet-context block.
- **Create the cache, then fan out.** Write the `(role, planet)` cache once, then release the rest of the group against `cachedContent`. Otherwise 30 parallel requests all miss and all pay to send the prefix.

### 3.6 Concurrency, deadlines and cost

**Concurrency.** One `Limiter` per model, sized from the account's rate limits: a semaphore for in-flight requests plus token buckets for requests, input tokens and output tokens per minute. The per-cycle peak is about 70 calls, mostly Flash, so a single process handles it. For 8 universes, run them all in **one Node process sharing one gateway** (or worker threads with the gateway on the main thread). The limiter then throttles across universes for free.

**Deadlines.** Each `AgentTask` carries `deadlineMs`. The gateway retries a 429 or 5xx only if the remaining deadline covers it, otherwise it returns `standing_orders`. The engine never waits past the cycle deadline.

**Cost meter.** Every response's `usage` is priced from a table in `gateway/pricing.ts` (Gemini's published rates for the pinned model ids) and summed per run, role and model. The same rows are inserted into Tiger's `call_usage` hypertable so the dashboard can chart spend. A hard per-run budget (default $15) switches remaining calls to stub with a feed event, so a bug can't burn money overnight. Advisor calls count against a separate per-user cap so a chatty spectator cannot drain the sim budget.

Call volume is unchanged from the build plan. Recompute dollars from the cost meter after B2. Thinking tokens dominate, which is why the thinking budget and `maxTokens` are set per role:

| Role | Calls / run | Model tier |
| --- | --- | --- |
| Colonists | ~11,000 | Flash |
| Traders | ~2,400 (×1–3 turns) | Flash, A/B against Pro |
| Governments | ~120–150 | Pro |
| News + economist | ~120 + 1 | Flash / Pro |
| Advisor | user-triggered, outside the cycle | Flash, Pro if the question needs `metric_history` |

The government line is what to watch against the $15 target. Levers in order: a smaller thinking budget on routine reviews and a larger one only after shocks, a tighter briefing, then the `cheap` profile (Flash for governments) in tuning runs.

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

| Need | In-process gateway on the Gemini SDK | LiteLLM proxy |
| --- | --- | --- |
| Role → tier → model routing | A config table (§3.3) | Model aliases in YAML |
| Explicit context caching, prefix placed where §3.5 says | Native `caches.create` / `cachedContent` | Passes through an OpenAI-shaped translation layer. Cache placement is harder to control and to verify |
| Thinking budget, JSON schema responses, function calling, safety blocks | Native | Depends on how well the translation keeps up with Gemini parameters |
| Concurrency and rate limits | `Limiter` (§3.6), shared by all universes in one process | Built in, and shared across processes |
| Per-cycle deadline with standing-orders fallback | Has to live in our code either way | Has to live in our code either way |
| Cost tracking and a hard budget | `usage` × price table, mirrored into Tiger | Built-in spend tracking and budgets |
| Stub and replay modes | Just other `ModelGateway` implementations | Not its job. We'd build these anyway |
| Ops | Nothing extra on the Vultr box | A Python sidecar (Docker) next to a Node stack, one more network hop inside a 5–8 s deadline, one more process to fail in a live demo |

LiteLLM's real strengths are multi-provider routing, cross-process rate limiting and spend dashboards. None of those is a v1 requirement if we run Gemini only and keep all universes in one process. Spend charts come from Tiger, not from a proxy UI.

**When to revisit it:**

- We add a second provider, for example a very fast host for colonists to cut cycle latency.
- Universes must run as separate processes or machines and share one rate limit and budget.
- The team wants per-person virtual keys and a spend dashboard for development.

**How to keep the door open:** everything goes through one interface, so LiteLLM would be just another adapter:

```ts
interface ModelGateway {
  invoke(req: GatewayRequest, signal: AbortSignal): Promise<GatewayResult>;
}
// implementations: StubGateway, ReplayGateway, GeminiGateway, (later) LiteLlmGateway
```

If we do add it, pin the exact version or image digest and keep the Gemini adapter as the default for governments, where caching and the thinking budget matter most.

---

## 5. Open decisions

| Decision | Default in this doc | Owner |
| --- | --- | --- |
| Traders on Gemini Flash or Pro | Flash, A/B in B3 | B |
| Who builds the frontend | Track A from A5, or Track D if a 4th person joins | Team |
| Governments' thinking budget | Small on routine reviews, larger after shocks | B |
| Universes in one process or many | One process, shared gateway, on one Vultr VM | A + B |
| Per-run hard budget | $15, then stub | B |
| Frontend host | Coolify on the Vultr VM (`apps/web`, Auth0 SPA) — single origin with the engine | Web |
| Engine host | Vultr Cloud Compute, Coolify-managed Docker Compose with `solana-test-validator` | A |
| Database | Tiger Data Cloud free tier. Local Docker Postgres with the Tiger extension for dev | A |
| Chain for the demo | `solana-test-validator` on the Vultr VM. Devnet only if we want a public explorer | C |
| Vultr GPU | Off. Inference is Gemini. Revisit only for a local model | Team |
| God mode | Auth0 role `operator`. Everyone else is `spectator` and can use the advisor | Web |
