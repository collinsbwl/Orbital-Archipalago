# @orbital/contracts

Day-0 frozen types and zod schemas shared by Track A (engine), B (agents/gateway), C (Solana) and the web app.

## Change rule

1. Any change to a schema or interface here needs a short note to the **other two tracks**.
2. The PR needs a **review from someone on a different track**.
3. Bump `CONTRACTS_VERSION` (`src/version.ts`): patch for docs/comments, minor for additive changes, major for breaking.

## Conventions

- Amounts are **integers**, never floats: `MinorUnits` (currency, >= 0), `SignedMinorUnits` (balances of trade), `Qty` (goods). Stored as JS `number` and bounded to the safe-integer range (JSON-friendly; `bigint` does not serialize).
- Fractions are basis points (`RateBp`, 10_000 = 100%) or parts per million (`RATE_SCALE`). Only `Usage.costUsd` is a float (USD telemetry, not ledger state).
- Schemas under `AgentDecision` / `Action` avoid transforms and refinements so they export to JSON schema for the model.
- Discriminated unions use `kind` (actions, commands, policy) or `type` (WebSocket envelopes).
- Values marked `// DEFAULT:` are placeholders the team may revise.

## Changelog

- **0.3.0** (additive, minor): `PlanetMetrics` gains required growth-accounting fields `realGdp`, `labourInput`, `capitalStock`, `realGdpGrowthBp`, `labourContribBp`, `capitalContribBp`, `tfpContribBp` (signed, unbounded integer bp for the growth ones); `CHART_METRICS` gains `real_gdp`. Producers of `PlanetMetrics` (engine, fixtures) must fill them. Other tracks: please acknowledge per the change rule above.
- **0.4.0** (additive, minor): `PlanetConfig` gains optional `population { children, workingAge, retired }`; `PlanetMetrics` gains required `children`, `workingAge`, `retired`, `dependencyRatioBp`, `participationBp` (`population` is now the cohort total and `labourInput` working-age x participation x hours); the colonist `Observation` gains optional `household { size, workingAge? }`. Producers of `PlanetMetrics` (engine, fixtures) must fill the new fields. Other tracks: please acknowledge per the change rule above.
