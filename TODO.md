# TODO — deferred and incomplete work

Running list of things left out of, or only partly done in, the Track A milestones. Grouped by what blocks them.
Milestones refer to [architecture.md](architecture.md) §2; "build plan" is `orbital-economy-sim-build-plan.md` (kept outside the repo).

## Needs a contracts change (`@orbital/contracts`, cross-track review)

- [ ] God-mode events from the build plan that `GodModeCommand` can't express:
  - [ ] Recession / credit crunch (+5 pt rate and doubled collateral haircut — needs collateral first)
  - [ ] Route closure and orbital lockout (route-level travel overrides for N cycles)
  - [ ] Currency crisis (reserve bank prints money with no collateral)
  - [ ] Snap election, leader swap (depends on B4 governments)
  - [ ] News shock (planted headline)
  - [ ] Solar storm as one command (today: one `shock` per planet/good)
  - [ ] Rule override (edit live dials: inflation target, orbit speeds, …)
  - [ ] Time controls beyond pause/resume: step one cycle, change speed
- [ ] Per-origin tariffs ("tariff on a good from one planet"). Tariffs today apply to all origins, so the trade-war and trade-diversion detectors approximate "on each other".
- [ ] Confidence surveys: build-plan fields (income/sales outlook, price expectations, big-purchase / investment plans, FX view) and the index formula `100 + %up − %down`. Today the index is the mean of a 0–100 `confidence`, and `PlanetMetrics` caps it at 100.

## Engine (Track A) — not yet built

- [ ] **TriggerFilter** in the scheduler (price moved > 5%, unfilled order, loan due, policy changed, every 4th cycle, 20% survey sample every 5th cycle). Today every colonist acts every cycle.
- [ ] Schedule governments (every 5th cycle or after a shock) and reserve banks in LLM mode (with B4).
- [ ] Random shocks in the Events phase (ion storms, solar flares).
- [ ] Reserve-bank tools beyond the policy rate: collateral rules and haircuts, credit cap, open-market operations / bonds, FX reserves and intervention, pegs, lender of last resort, independence dial.
- [ ] Collateralised loans and foreclosure. Loans are unsecured today; overdue loans are auto-repaid from the purse, otherwise counted as defaults.
- [ ] Colonist depth: job/rest choice, skills, drones, well-being, migration. Population is fixed.
- [ ] Freighter fuel, and investment in more freighters or drones.
- [ ] Expire stale resting orders. They rest forever unless an agent cancels them.
- [ ] Withheld cargo (embargo/quota) goes back to the origin planet while the trader docks at the destination, so it's stranded until the trader returns.
- [ ] Engine loan cache excludes interest accrued between repays (`Loan.outstanding` is refreshed only from ledger returns).
- [x] `Snapshot.gatewayCostUsd` carries the run's `CostMeter` total (via `DecisionProvider.costUsd()`), and each cycle's value lands in `gateway_cost`.
- [ ] Per-call `call_usage` rows: `CostMeter`'s `onUsage` hook exists, but Tiger has no `call_usage` table or writer yet (architecture.md §3.6).
- [ ] Forks need `clone()` on the ledger. `InMemoryLedger` has it; `SolanaLedger` (Track C) would need a fork strategy, such as replaying from a seed or snapshotting accounts.
- [ ] A fork's chart series start at the fork cycle. Its pre-fork history isn't copied into Tiger, so the dashboard can't overlay a fork and its parent from cycle 0 without a query that unions the parent's rows.
- [ ] Shock edge cases: a supply shock scaled to 0 output still consumes inputs; `demand_surge` is spread evenly across colonists (floor of the total).
- [ ] Drought barely moves the grain clearing price under stub agents (CPI rises, price flat), so `god-mode.test.ts` only logs price. Re-check, and assert it, with B1/B3 agents.
- [x] Recorded **Snapshot fixtures** for the frontend: `apps/web/public/fixtures/snapshots.json`, re-recorded with `pnpm --filter @orbital/engine record-snapshots`.

## Verification gaps

- [ ] Tiger Data SQL has never run against a real TimescaleDB locally (no Docker or Postgres on the dev machine). CI runs it in a service container, but CI hasn't run yet because nothing is pushed.
- [ ] CI workflow (`.github/workflows/ci.yml`) is unverified until the first push or PR.
- [ ] With the stub agents, about 57% of colonist needs go unmet on planets that can't produce food (random traders ship too little). Re-check with Track B's B1 stub policies.

## Later milestones / phases

- [ ] **A5:** `apps/web` on Vercel: Auth0 login, metric panels, event feed, god-mode panel (operators only), 3D solar-system view.
- [ ] Phase 5: 8 parallel seeded universes, results summary (share of runs with a trade war, time to start, trigger), demo script.
- [ ] Docs: `architecture.md` links to `orbital-economy-sim-build-plan.md`, which isn't in the repo.
