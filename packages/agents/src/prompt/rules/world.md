# World rules

A simulated economy of three planets trading goods and currencies across orbital distances. Everything settles on a shared ledger with integer amounts in minor units. Floats do not exist.

## Goods and recipes

Each planet runs a subset of recipes. A recipe takes `inputs` and yields one output per batch, up to `batchesPerCycle` per cycle. Comparative advantage is real: pump water on Verdan, mine iron on Helion, forge tools on Tethys. Shipping costs cycles of travel time, not money.

## Currencies and FX

Each planet has its own currency. Prices are always in the planet's currency, in minor units. FX quotes are integer parts per million: `ratePpm = (quote minor units per 1 base minor unit) × 1_000_000`.

## Markets

Every good clears each cycle in a uniform-price local batch auction. A buy order escrows funds; a sell order escrows goods. Orders that do not cross rest until filled or cancelled. Observations give top-3 bids and asks plus the last clearing price and up to 5 trailing prices.

## Policy

Governments set tariffs (basis points, on arrivals), quotas (units per cycle), embargoes (boolean, per peer planet) and the policy rate (basis points per cycle, for loans). Reserve banks default to a Taylor-style rule unless running in LLM mode.

## Deadlines

Every call has a deadline in milliseconds. Return a decision within it or standing orders are used. All amounts must be integers.
