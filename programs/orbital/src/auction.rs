//! The uniform-price batch auction, as plain Rust with no Solana types so it can be tested on its own.
//! These are the rules Track A pinned in packages/ledger-memory/README.md ("Local orders and auction").

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

/// A resting order. Its position in the slice is its placement order (oldest first).
#[derive(Clone, Copy, Debug)]
pub struct Bid {
    pub side: Side,
    pub qty: u64,
    pub limit: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Outcome {
    /// None when nothing crosses.
    pub price: Option<u64>,
    pub volume: u128,
    /// (index into the input slice, units filled): all buys in priority order, then all sells in priority order.
    pub fills: Vec<(usize, u64)>,
}

/// Reference version that works everything out itself, including the sorting. The program uses `clear_sorted` below;
/// this one stays as the test oracle that `clear_sorted` must always agree with.
#[cfg(test)]
pub fn clear(orders: &[Bid]) -> Outcome {
    // 1. Candidate prices are the distinct limit prices. At price p, D = buy qty willing to pay p, S = sell qty
    //    willing to accept p, and the volume that can trade is min(D, S).
    let mut prices: Vec<u64> = orders.iter().map(|o| o.limit).collect();
    prices.sort_unstable();
    prices.dedup();

    // 2. Best price = most volume; ties go to the smaller imbalance |D - S|, then the lowest price.
    //    Prices are visited in ascending order, so keeping the first of equals gives the lowest price.
    let mut best: Option<(u128, u128, u64)> = None; // (volume, imbalance, price)
    for &p in &prices {
        let (mut d, mut s) = (0u128, 0u128);
        for o in orders {
            match o.side {
                Side::Buy if o.limit >= p => d += o.qty as u128,
                Side::Sell if o.limit <= p => s += o.qty as u128,
                _ => {}
            }
        }
        let (v, gap) = (d.min(s), d.abs_diff(s));
        let better = match best {
            None => true,
            Some((bv, bg, _)) => v > bv || (v == bv && gap < bg),
        };
        if better {
            best = Some((v, gap, p));
        }
    }
    let Some((volume, _, price)) = best.filter(|b| b.0 > 0) else {
        return Outcome { price: None, volume: 0, fills: vec![] };
    };

    // 3. Hand out the volume greedily: buyers with the highest limit first, sellers with the lowest first,
    //    ties by placement order. Partial fills are allowed; the rest keeps resting.
    let mut buys: Vec<usize> = (0..orders.len()).filter(|&i| orders[i].side == Side::Buy && orders[i].limit >= price).collect();
    let mut sells: Vec<usize> = (0..orders.len()).filter(|&i| orders[i].side == Side::Sell && orders[i].limit <= price).collect();
    buys.sort_by(|&a, &b| orders[b].limit.cmp(&orders[a].limit).then(a.cmp(&b)));
    sells.sort_by(|&a, &b| orders[a].limit.cmp(&orders[b].limit).then(a.cmp(&b)));

    let mut fills = Vec::new();
    for side in [buys, sells] {
        let mut left = volume;
        for i in side {
            if left == 0 {
                break;
            }
            let q = (orders[i].qty as u128).min(left);
            fills.push((i, q as u64));
            left -= q;
        }
    }
    Outcome { price: Some(price), volume, fills }
}

/// Why a client-supplied sort order was rejected.
#[derive(Debug, PartialEq, Eq)]
pub enum SortError {
    BadIndex,
    WrongSide,
    NotSorted,
    Incomplete,
}

/// The on-chain half of "sort off-chain, verify on-chain". The client sends every buy as an index into `orders`,
/// best first (highest limit, then oldest), and every sell the same way (lowest limit, then oldest). One pass over each
/// list proves it is sorted and complete; then a single sweep finds the clearing price and hands out the volume.
/// No sorting happens here, which is what makes it cheap.
pub fn clear_sorted(orders: &[Bid], buys: &[usize], sells: &[usize]) -> Result<Outcome, SortError> {
    verify(orders, buys, Side::Buy)?;
    verify(orders, sells, Side::Sell)?;

    // prefix[k] = quantity of the first k orders on that side
    let prefix = |list: &[usize]| -> Vec<u128> {
        let mut out = Vec::with_capacity(list.len() + 1);
        out.push(0u128);
        for &i in list {
            out.push(out[out.len() - 1] + orders[i].qty as u128);
        }
        out
    };
    let (buy_sum, sell_sum) = (prefix(buys), prefix(sells));

    // Candidate prices ascending = a merge of the sells (ascending) and the buys read backwards (they are descending).
    let mut prices: Vec<u64> = Vec::with_capacity(buys.len() + sells.len());
    let (mut bi, mut si) = (buys.len(), 0);
    while bi > 0 || si < sells.len() {
        let next = match (bi > 0, si < sells.len()) {
            (true, true) => orders[buys[bi - 1]].limit.min(orders[sells[si]].limit),
            (true, false) => orders[buys[bi - 1]].limit,
            _ => orders[sells[si]].limit,
        };
        while bi > 0 && orders[buys[bi - 1]].limit == next {
            bi -= 1;
        }
        while si < sells.len() && orders[sells[si]].limit == next {
            si += 1;
        }
        prices.push(next);
    }

    // Sweep the prices upwards. The buys willing to pay p are a prefix of the buy list that shrinks as p rises;
    // the sells willing to accept p are a prefix of the sell list that grows.
    let mut best: Option<(u128, u128, u64, usize, usize)> = None; // (volume, imbalance, price, buys used, sells used)
    let (mut buy_ge, mut sell_le) = (buys.len(), 0usize);
    for &p in &prices {
        while buy_ge > 0 && orders[buys[buy_ge - 1]].limit < p {
            buy_ge -= 1;
        }
        while sell_le < sells.len() && orders[sells[sell_le]].limit <= p {
            sell_le += 1;
        }
        let (d, s) = (buy_sum[buy_ge], sell_sum[sell_le]);
        let (v, gap) = (d.min(s), d.abs_diff(s));
        if best.is_none_or(|(bv, bg, ..)| v > bv || (v == bv && gap < bg)) {
            best = Some((v, gap, p, buy_ge, sell_le));
        }
    }
    let Some((volume, _, price, nb, ns)) = best.filter(|b| b.0 > 0) else {
        return Ok(Outcome { price: None, volume: 0, fills: vec![] });
    };

    let mut fills = Vec::new();
    for list in [&buys[..nb], &sells[..ns]] {
        let mut left = volume;
        for &i in list {
            if left == 0 {
                break;
            }
            let q = (orders[i].qty as u128).min(left);
            fills.push((i, q as u64));
            left -= q;
        }
    }
    Ok(Outcome { price: Some(price), volume, fills })
}

/// One pass: every index valid and on the right side, strictly in priority order, and nothing missing.
fn verify(orders: &[Bid], list: &[usize], side: Side) -> Result<(), SortError> {
    if list.len() != orders.iter().filter(|o| o.side == side).count() {
        return Err(SortError::Incomplete);
    }
    let mut prev: Option<usize> = None;
    for &i in list {
        let o = orders.get(i).ok_or(SortError::BadIndex)?;
        if o.side != side {
            return Err(SortError::WrongSide);
        }
        if let Some(p) = prev {
            let (a, b) = (orders[p].limit, o.limit);
            let in_order = match side {
                Side::Buy => a > b || (a == b && p < i),
                Side::Sell => a < b || (a == b && p < i),
            };
            if !in_order {
                return Err(SortError::NotSorted); // also catches a repeated index
            }
        }
        prev = Some(i);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn buy(qty: u64, limit: u64) -> Bid { Bid { side: Side::Buy, qty, limit } }
    const fn sell(qty: u64, limit: u64) -> Bid { Bid { side: Side::Sell, qty, limit } }

    /// What the client sends: each side's indices in priority order.
    fn sorted_lists(orders: &[Bid]) -> (Vec<usize>, Vec<usize>) {
        let mut buys: Vec<usize> = (0..orders.len()).filter(|&i| orders[i].side == Side::Buy).collect();
        let mut sells: Vec<usize> = (0..orders.len()).filter(|&i| orders[i].side == Side::Sell).collect();
        buys.sort_by(|&a, &b| orders[b].limit.cmp(&orders[a].limit).then(a.cmp(&b)));
        sells.sort_by(|&a, &b| orders[a].limit.cmp(&orders[b].limit).then(a.cmp(&b)));
        (buys, sells)
    }

    /// The program's version (sorted input, one-pass verify) must always agree with the all-in-one oracle.
    fn clear_both(orders: &[Bid]) -> Outcome {
        let (buys, sells) = sorted_lists(orders);
        let fast = clear_sorted(orders, &buys, &sells).unwrap();
        assert_eq!(fast, clear(orders), "clear_sorted disagrees with the reference for {orders:?}");
        fast
    }

    #[test]
    fn empty_and_non_crossing_books_do_not_clear() {
        assert_eq!(clear_both(&[]).price, None);
        let o = clear_both(&[buy(5, 5), sell(5, 6)]);
        assert_eq!((o.price, o.volume, o.fills.len()), (None, 0, 0));
    }

    #[test]
    fn equal_volume_and_balance_picks_the_lowest_price() {
        let o = clear_both(&[buy(10, 20), sell(10, 10)]);
        assert_eq!((o.price, o.volume), (Some(10), 10));
        assert_eq!(o.fills, vec![(0, 10), (1, 10)]);
    }

    #[test]
    fn picks_the_volume_maximising_price() {
        // candidates 6,8,9,10 -> V = 4,4,5,5 ; |D-S| = 6,6,3,3 -> price 9
        let o = clear_both(&[buy(5, 10), buy(5, 8), sell(4, 6), sell(4, 9)]);
        assert_eq!((o.price, o.volume), (Some(9), 5));
        assert_eq!(o.fills, vec![(0, 5), (2, 4), (3, 1)]);
    }

    #[test]
    fn smaller_imbalance_beats_a_lower_price() {
        // V = 2 at every candidate; the gap is 2,2,1,1 for 4,6,8,10 -> 8
        let o = clear_both(&[buy(2, 10), buy(2, 6), sell(2, 4), sell(1, 8)]);
        assert_eq!((o.price, o.volume), (Some(8), 2));
    }

    #[test]
    fn rations_the_long_buy_side_by_limit_then_time() {
        let o = clear_both(&[buy(3, 10), buy(3, 10), buy(3, 12), sell(4, 5)]);
        assert_eq!((o.price, o.volume), (Some(5), 4));
        // best limit first (order 2), then the older of the two equal limits (order 0); order 1 gets nothing
        assert_eq!(o.fills, vec![(2, 3), (0, 1), (3, 4)]);
    }

    #[test]
    fn rations_the_long_sell_side_by_lowest_limit_then_time() {
        let o = clear_both(&[sell(3, 8), sell(3, 8), sell(3, 6), buy(5, 9)]);
        assert_eq!(o.price, Some(8));
        assert_eq!(o.fills, vec![(3, 5), (2, 3), (0, 2)]);
    }

    #[test]
    fn a_zero_priced_cross_clears_at_zero() {
        let o = clear_both(&[buy(2, 0), sell(2, 0)]);
        assert_eq!((o.price, o.volume), (Some(0), 2));
    }

    #[test]
    fn rejects_bad_sort_orders() {
        let book = [buy(3, 10), buy(3, 12), sell(4, 5)];
        // buys must be highest limit first
        assert_eq!(clear_sorted(&book, &[0, 1], &[2]), Err(SortError::NotSorted));
        assert!(clear_sorted(&book, &[1, 0], &[2]).is_ok());
        // a missing order, a repeated one, one on the wrong side, and one out of range
        assert_eq!(clear_sorted(&book, &[1], &[2]), Err(SortError::Incomplete));
        assert_eq!(clear_sorted(&book, &[1, 1], &[2]), Err(SortError::NotSorted));
        assert_eq!(clear_sorted(&book, &[1, 2], &[0]), Err(SortError::WrongSide));
        assert_eq!(clear_sorted(&book, &[1, 9], &[2]), Err(SortError::BadIndex));
        // equal limits: the older order (lower index) must come first
        let same = [buy(1, 7), buy(1, 7)];
        assert_eq!(clear_sorted(&same, &[1, 0], &[]), Err(SortError::NotSorted));
    }

    /// Many random books: the fast path and the reference must agree on price, volume and every fill.
    #[test]
    fn agrees_with_the_reference_on_random_books() {
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = move |n: u64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) % n
        };
        for _ in 0..3000 {
            let n = next(14) as usize;
            let book: Vec<Bid> = (0..n)
                .map(|_| Bid { side: if next(2) == 0 { Side::Buy } else { Side::Sell }, qty: 1 + next(6), limit: next(8) })
                .collect();
            clear_both(&book);
        }
    }

    #[test]
    fn handles_huge_quantities() {
        let big = 1u64 << 40;
        let o = clear_both(&[buy(big, 1 << 11), sell(big, 3)]);
        assert_eq!((o.price, o.volume), (Some(3), big as u128));
    }
}
