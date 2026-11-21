//! The FX pair auction as plain Rust (no Solana types), following Track A's pinned rules
//! (packages/ledger-memory/README.md, "FX"). Rates are ppm: quote units per base unit, times 1_000_000.

const SCALE: u128 = 1_000_000;
const MAX_RATE: u128 = (1u128 << 53) - 1;

/// One IOC order. In a pair, "sellers" give the base currency and "buyers" give the quote currency.
#[derive(Clone, Copy, Debug)]
pub struct FxBid {
    pub gives_base: bool,
    pub give: u64,
    pub min_receive: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct FxFill {
    pub index: usize,
    /// What the order actually gives up (the rest of its escrow is refunded).
    pub spent: u64,
    pub received: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct FxOutcome {
    pub rate: Option<u64>,
    /// Sellers in priority order, then buyers in priority order.
    pub fills: Vec<FxFill>,
    /// Quote currency that buyers pay beyond what sellers receive (rounding); the quote planet's treasury gets it.
    pub dust: u64,
}

/// Lowest rate a seller accepts: ceil(minReceive * 1e6 / give).
fn seller_limit(b: &FxBid) -> u128 {
    (b.min_receive as u128 * SCALE).div_ceil(b.give as u128)
}

/// Highest rate a buyer accepts: floor(give * 1e6 / minReceive). None = uncapped (minReceive 0).
fn buyer_limit(b: &FxBid) -> Option<u128> {
    (b.min_receive != 0).then(|| b.give as u128 * SCALE / b.min_receive as u128)
}

/// Base units a buyer can afford at rate r.
fn capacity(b: &FxBid, r: u128) -> u128 {
    b.give as u128 * SCALE / r
}

pub fn clear(orders: &[FxBid]) -> FxOutcome {
    let none = FxOutcome { rate: None, fills: vec![], dust: 0 };
    let eligible_seller = |b: &FxBid, r: u128| b.gives_base && seller_limit(b) <= r;
    let eligible_buyer = |b: &FxBid, r: u128| !b.gives_base && buyer_limit(b).is_none_or(|l| l >= r);

    // Candidate rates: every finite limit in [1, MAX_RATE].
    let mut rates: Vec<u128> = orders
        .iter()
        .filter_map(|b| if b.gives_base { Some(seller_limit(b)) } else { buyer_limit(b) })
        .filter(|&l| (1..=MAX_RATE).contains(&l))
        .collect();
    rates.sort_unstable();
    rates.dedup();

    // Most volume wins; ties go to the smaller imbalance, then the lowest rate (ascending, so keep the first).
    let mut best: Option<(u128, u128, u128)> = None; // (volume, imbalance, rate)
    for &r in &rates {
        let s: u128 = orders.iter().filter(|b| eligible_seller(b, r)).map(|b| b.give as u128).sum();
        let d: u128 = orders.iter().filter(|b| eligible_buyer(b, r)).map(|b| capacity(b, r)).sum();
        let (v, gap) = (s.min(d), s.abs_diff(d));
        if best.is_none_or(|(bv, bg, _)| v > bv || (v == bv && gap < bg)) {
            best = Some((v, gap, r));
        }
    }
    let Some((volume, _, r)) = best.filter(|b| b.0 > 0) else { return none };

    // Sellers: lowest limit first. Buyers: highest limit first, uncapped before any cap. Ties by placement order.
    let mut sellers: Vec<usize> = (0..orders.len()).filter(|&i| eligible_seller(&orders[i], r)).collect();
    let mut buyers: Vec<usize> = (0..orders.len()).filter(|&i| eligible_buyer(&orders[i], r)).collect();
    sellers.sort_by_key(|&i| (seller_limit(&orders[i]), i));
    buyers.sort_by_key(|&i| (std::cmp::Reverse(buyer_limit(&orders[i]).unwrap_or(u128::MAX)), i));

    let mut fills = Vec::new();
    let (mut paid, mut got) = (0u128, 0u128);

    let mut left = volume;
    for i in sellers {
        if left == 0 {
            break;
        }
        let s = (orders[i].give as u128).min(left);
        let receive = s * r / SCALE; // sellers round down
        fills.push(FxFill { index: i, spent: s as u64, received: receive as u64 });
        got += receive;
        left -= s;
    }
    let mut left = volume;
    for i in buyers {
        if left == 0 {
            break;
        }
        let b = capacity(&orders[i], r).min(left);
        if b == 0 {
            continue;
        }
        let pay = (b * r).div_ceil(SCALE); // buyers round up, never above their escrow
        fills.push(FxFill { index: i, spent: pay as u64, received: b as u64 });
        paid += pay;
        left -= b;
    }
    FxOutcome { rate: Some(r as u64), fills, dust: (paid - got) as u64 }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn sell(give: u64, min_receive: u64) -> FxBid { FxBid { gives_base: true, give, min_receive } }
    const fn buy(give: u64, min_receive: u64) -> FxBid { FxBid { gives_base: false, give, min_receive } }

    #[test]
    fn clears_where_supply_and_demand_balance() {
        // seller limit 2.0, buyer limit 3.0 -> at 3.0: S = 100, D = 100
        let o = clear(&[sell(100, 200), buy(300, 100)]);
        assert_eq!(o.rate, Some(3_000_000));
        assert_eq!(o.fills, vec![FxFill { index: 0, spent: 100, received: 300 }, FxFill { index: 1, spent: 300, received: 100 }]);
        assert_eq!(o.dust, 0);
    }

    #[test]
    fn no_crossing_gives_no_rate() {
        let o = clear(&[sell(100, 300), buy(100, 100)]);
        assert_eq!((o.rate, o.fills.len(), o.dust), (None, 0, 0));
    }

    #[test]
    fn rounds_sellers_down_buyers_up_and_reports_dust() {
        let o = clear(&[sell(3, 1), buy(10, 3)]);
        assert_eq!(o.rate, Some(3_333_333));
        assert_eq!(o.fills, vec![FxFill { index: 0, spent: 3, received: 9 }, FxFill { index: 1, spent: 10, received: 3 }]);
        assert_eq!(o.dust, 1);
    }

    #[test]
    fn an_uncapped_buyer_buys_at_any_rate() {
        let o = clear(&[sell(10, 20), buy(100, 0)]);
        assert_eq!(o.rate, Some(2_000_000));
        assert_eq!(o.fills, vec![FxFill { index: 0, spent: 10, received: 20 }, FxFill { index: 1, spent: 20, received: 10 }]);
    }

    #[test]
    fn rations_the_long_buy_side_by_limit_then_time() {
        // seller gives 10 at limit 1.0; buyers: index 1 limit 3.0, index 2 limit 5.0 -> rate 5.0, only index 2 fills
        let o = clear(&[sell(10, 10), buy(30, 10), buy(50, 10)]);
        assert_eq!(o.rate, Some(5_000_000));
        assert_eq!(o.fills, vec![FxFill { index: 0, spent: 10, received: 50 }, FxFill { index: 2, spent: 50, received: 10 }]);
    }
}
