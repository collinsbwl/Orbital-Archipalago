# @orbital/ledger-memory

`InMemoryLedger`: the reference, fully deterministic implementation of the frozen `Ledger` interface from
`@orbital/contracts` (no `Math.random`, no `Date`). `@orbital/ledger-memory/contract` exports
`runLedgerContractSuite(name, makeLedger)`, a vitest suite that uses only the `Ledger` interface; Track C runs it
unchanged against `SolanaLedger`. The semantics below are pinned: a conforming implementation must match them
bit-for-bit.

```ts
import { runLedgerContractSuite } from '@orbital/ledger-memory/contract';
runLedgerContractSuite('SolanaLedger', async (world) => new SolanaLedger(world));
```

## Conventions

- Amounts are safe integers. Currency amounts and inventory are `>= 0`; quantities (`qty`, `giveAmount`, cargo, loan
  `amount`) are `> 0`. Violations are `invalid_amount`. Products that could leave the safe range are computed with BigInt;
  a product that is not a safe integer is `invalid_amount`.
- Unknown planet, good, currency, malformed owner id, `from === to`, `give === want`, `base === quote` are all
  `invalid_amount`.
- Check order: `invalid_amount` (shape and unknown ids), then `unknown_account`, then state errors
  (`insufficient_*`, `invalid_state`). Every method is atomic: on error, no state changes.
- Ids: orders `o1, o2, ...` (FX orders share this counter; only accepted orders consume a number), shipments `s1, ...`,
  loans `l1, ...`.
- All returned objects are copies.

## Accounts

`openAccount` once per owner (agent id or planet id for a treasury); a second open is `invalid_state`. Treasuries are
never opened automatically. The opening purse and inventory (placed on the home planet) count toward initial supply.
Every other method on an unopened owner is `unknown_account` (placement rejects it per order). Purses are keyed by
currency, inventory by (owner, planet, good); missing = 0. `transfer` of 0 is allowed; `insufficient_funds` if short.
`produce` / `consume` are atomic (`insufficient_inventory`); duplicate goods in `inputs` are aggregated before checking.

## Local orders and auction

`placeOrders` validates each order on its own; rejects are returned in `rejected` (with their index), never thrown.
Buy escrows `qty * limitPrice` of the planet's currency; sell escrows `qty` of the good held on that planet. Orders rest
across cycles until filled or cancelled. `cancelOrder` refunds the remaining escrow (`unknown_order` if not open; it
also cancels FX orders). `openOrders(agent)` returns remaining qty, ordered by order sequence.

`clearLocalAuction(planet, good, cycle)` over all resting orders for that planet/good:

1. Candidate prices = distinct limit prices. `D(p)` = buy qty with limit >= p, `S(p)` = sell qty with limit <= p,
   `V = min(D, S)`.
2. Pick the candidate with max `V`; ties: min `|D - S|`; ties: lowest `p`. Max `V = 0` -> `clearingPrice: null`,
   `volume: 0`, no fills.
3. Allocate `V`: buys by limit desc then sequence; sells by limit asc then sequence; greedy (partial fills allowed,
   remainders keep resting).
4. Everything executes at `p`: buyer receives goods on that planet, pays `qty*p` and gets `qty*(limit-p)` back; seller
   receives `qty*p`. `fills` has one entry per touched order: all buys (priority order) then all sells (priority
   order), `total = qty*price`. Fully filled orders are removed. The last non-null clearing price per (planet, good) is
   remembered for tariffs.

## FX

`placeFxOrders` escrows `giveAmount` of `give`. FX orders are immediate-or-cancel: they live until the next
`clearFxAuction` of their pair, which refunds whatever is unfilled and removes them (they can also be cancelled).
`clearFxAuction(base, quote, cycle)` considers `give=base/want=quote` orders (sellers) and `give=quote/want=base`
orders (buyers). Rates are ppm quote-per-base (`RATE_SCALE = 1e6`).

- Seller limit = `ceil(minReceive*1e6 / giveAmount)` (accepts `r >= limit`). Buyer limit =
  `floor(giveAmount*1e6 / minReceive)` (accepts `r <= limit`; `minReceive = 0` -> uncapped).
- Candidates = distinct finite limits `>= 1` (and `<= MAX_SAFE_INTEGER`). At `r`: `S` = sum of eligible sellers'
  `giveAmount`; `D` = sum of eligible buyers' `floor(giveAmount*1e6 / r)`; `V = min(S, D)` base units. Same tie-breaks
  as the local auction. `V = 0` -> `ratePpm: null`, everything refunded.
- Allocate `V`: sellers by limit asc then sequence; buyers by limit desc (uncapped first) then sequence; greedy. A
  seller selling `s` base receives `floor(s*r/1e6)` quote; a buyer receiving `b` base pays `ceil(b*r/1e6)` quote
  (never more than its escrow). Only the rate is guaranteed against the limit, NOT `minReceive` exactly: the rounded
  receive amount can be below the proportional `minReceive`.
- Quote dust (`sum buyer pays - sum seller receives`, always `>= 0`) is credited to the treasury of the planet whose
  currency is `quote`. If dust > 0 and that treasury is unopened: `unknown_account`, nothing changes.
- Unspent escrow is refunded. `fills` has one entry per touched order (`giveAmount` actually spent, `receiveAmount`
  received): sellers then buyers, each in allocation priority order.

## Shipping

`depart` moves cargo from the owner's inventory on `from` into a shipment (`insufficient_inventory`; `from === to`,
empty cargo, or `arriveCycle <= cycle` -> `invalid_amount`). Duplicate goods in cargo are merged (first-appearance
order). `arrive(id, cycle)`: `unknown_shipment`; already arrived or `cycle < arriveCycle` -> `invalid_state`.

1. Embargo is checked on arrival only: if the destination's `embargoes` contains the origin planet, all cargo is
   withheld.
2. Otherwise, per good, the destination's `quotas[good]` limits total units imported for that (destination, good) in
   the `cycle` passed to `arrive`, across all arrivals; excess is withheld. Quota 0 blocks a good. Quotas are never
   deleted (no instruction removes one).
3. Withheld cargo returns to the owner's inventory on the origin planet; delivered cargo goes to the owner on the
   destination.
4. Duty: for each delivered good with tariff `t` bp, `floor(qty * price * t / 10000)` where `price` is the last non-null
   local clearing price for that good on the destination, else the good's `basePrice`. Collected = `min(duty, owner's
   purse in the destination currency)`, moved to the destination treasury and reported in `duty.amount`. If duty owed
   is > 0 and the destination treasury account is unopened: `unknown_account`, nothing changes.

## Credit

`borrow` mints `amount` of the planet's currency into the borrower's purse (money supply up). `rateBp` is the planet's
`policyRateBp` at borrow time; `dueCycle = cycle + termCycles` (`termCycles >= 1`); `outstanding = principal`.
`repay(loanId, amount, cycle)`: `unknown_loan`; outstanding already 0 or `cycle` < last accrual cycle -> `invalid_state`.
Then accrue simple interest `outstanding += floor(principal*rateBp*(cycle - lastAccrual)/10000)` and set
`lastAccrual = cycle` (initially `issuedCycle`); `pay = min(amount, outstanding)`; the borrower must hold `pay`
(`insufficient_funds`, and then no accrual is kept); `pay` is burned (supply down). Returns the updated loan.

## Policy

`applyPolicy`: `set_tariff` (`rateBp` 0 deletes the key), `set_quota`, `set_embargo` (active adds, inactive removes;
sorted, no duplicates; target === planet is `invalid_amount`), `set_policy_rate`. Default state: empty maps, no
embargoes, `policyRateBp 0`. `rateBp` must be 0..10000.

## Invariants

Expected supply per currency = initial + minted (borrow) - burned (repay); per good = initial + produced - consumed.
`checkInvariants()` totals: currency = purses + buy escrow + FX escrow; goods = inventories + sell escrow + in-flight
cargo. All world currencies and goods appear in `totals` (zero if empty). Violation codes: `currency_supply_mismatch`,
`goods_supply_mismatch`, `negative_balance`, `escrow_mismatch`. `ok` is true iff there are no violations.
