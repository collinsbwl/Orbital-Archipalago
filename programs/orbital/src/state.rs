use anchor_lang::prelude::*;

use crate::{constants::{MAX_EMBARGOES, MAX_ORDERS, MAX_POLICY_GOODS, MAX_SLOTS}, error::ErrorCode};

/// Singleton: who may create currencies and operate the ledger (the sim engine).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Next order sequence number (local and FX orders share it). Ids are "o<seq>", starting at 1.
    pub next_order: u64,
    /// Next shipment id; ids are "s<n>", starting at 1.
    pub next_shipment: u64,
}

/// One line of cargo in an instruction: `good` is sha256(goodId), computed client-side.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Cargo {
    pub good: [u8; 32],
    pub qty: u64,
}

/// One inventory entry: how many units of `good` `owner` holds on this planet.
/// Entries are never removed (a zero qty entry is reused), so `len` only grows.
#[zero_copy]
pub struct InventorySlot {
    pub owner: [u8; 32],
    pub good: [u8; 32],
    pub qty: u64,
}

/// All inventories on one planet, in one big account (zero-copy: no deserialization,
/// so the 74 KB body costs nothing to load). Created by the client at full size and
/// initialised by `create_planet`.
#[account(zero_copy)]
pub struct PlanetLedger {
    /// sha256(planetId)
    pub planet: [u8; 32],
    pub currency: [u8; 3],
    pub _pad: [u8; 5],
    pub len: u64,
    pub slots: [InventorySlot; MAX_SLOTS],
}

impl PlanetLedger {
    fn find(&self, owner: &[u8; 32], good: &[u8; 32]) -> Option<usize> {
        self.slots[..self.len as usize]
            .iter()
            .position(|s| s.owner == *owner && s.good == *good)
    }

    pub fn add(&mut self, owner: &[u8; 32], good: &[u8; 32], qty: u64) -> Result<()> {
        match self.find(owner, good) {
            Some(i) => {
                let s = &mut self.slots[i];
                s.qty = s.qty.checked_add(qty).ok_or(ErrorCode::Overflow)?;
            }
            None => {
                let i = self.len as usize;
                require!(i < MAX_SLOTS, ErrorCode::LedgerFull);
                self.slots[i] = InventorySlot { owner: *owner, good: *good, qty };
                self.len += 1;
            }
        }
        Ok(())
    }

    pub fn sub(&mut self, owner: &[u8; 32], good: &[u8; 32], qty: u64) -> Result<()> {
        let i = self.find(owner, good).ok_or(ErrorCode::InsufficientInventory)?;
        let s = &mut self.slots[i];
        require!(s.qty >= qty, ErrorCode::InsufficientInventory);
        s.qty -= qty;
        Ok(())
    }
}

/// One resting order. `qty` is what remains unfilled. Buys have `limit * qty` of currency escrowed in the vault;
/// sells have `qty` of the good held here (removed from the owner's inventory).
#[zero_copy]
pub struct OrderSlot {
    pub seq: u64,
    pub owner: [u8; 32],
    pub qty: u64,
    pub limit: u64,
    pub cycle: u64,
    /// SIDE_BUY or SIDE_SELL
    pub side: u8,
    pub _pad: [u8; 7],
}

/// All resting orders for one (planet, good), in placement order (oldest first).
#[account(zero_copy)]
pub struct OrderBook {
    /// sha256(planetId)
    pub planet: [u8; 32],
    /// sha256(goodId)
    pub good: [u8; 32],
    pub len: u64,
    pub slots: [OrderSlot; MAX_ORDERS],
}

impl OrderBook {
    pub fn push(&mut self, slot: OrderSlot) -> Result<()> {
        let i = self.len as usize;
        require!(i < MAX_ORDERS, ErrorCode::BookFull);
        self.slots[i] = slot;
        self.len += 1;
        Ok(())
    }

    pub fn find(&self, seq: u64) -> Option<usize> {
        self.slots[..self.len as usize].iter().position(|s| s.seq == seq)
    }

    /// Removes the order at `i`, keeping the rest in placement order.
    pub fn remove(&mut self, i: usize) {
        let len = self.len as usize;
        self.slots.copy_within(i + 1..len, i);
        self.len -= 1;
    }

    /// Drops every filled (qty 0) order, keeping placement order.
    pub fn compact(&mut self) {
        let len = self.len as usize;
        let mut w = 0;
        for r in 0..len {
            if self.slots[r].qty > 0 {
                self.slots[w] = self.slots[r];
                w += 1;
            }
        }
        self.len = w as u64;
    }
}

/// One cargo line inside a shipment.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct CargoLine {
    pub good: [u8; 32],
    pub qty: u64,
}

/// Goods in flight between planets. Kept after arrival (arrived = true) so a second arrive is rejected.
#[account]
#[derive(InitSpace)]
pub struct Shipment {
    pub owner: [u8; 32],
    pub from: [u8; 32],
    pub to: [u8; 32],
    pub lines: [CargoLine; 8],
    pub n_lines: u8,
    pub depart_cycle: u64,
    pub arrive_cycle: u64,
    pub arrived: bool,
}

/// Everything a planet's government decides about one good, plus the prices tariffs are charged against.
#[zero_copy]
pub struct GoodPolicy {
    pub good: [u8; 32],
    /// Tariff in basis points on imports of this good; 0 = none.
    pub tariff_bp: u64,
    pub quota_max: u64,
    /// Units imported so far in `quota_cycle` (resets when a new cycle arrives).
    pub quota_used: u64,
    pub quota_cycle: u64,
    /// Last non-null local clearing price on this planet.
    pub last_price: u64,
    /// The good's base price, the tariff price until the first auction clears.
    pub base_price: u64,
    pub has_quota: u8,
    pub has_price: u8,
    pub _pad: [u8; 6],
}

/// One planet's trade policy: tariffs, quotas, embargoes, the central-bank rate, and last prices.
#[account(zero_copy)]
pub struct PlanetPolicy {
    /// sha256(planetId)
    pub planet: [u8; 32],
    pub policy_rate_bp: u64,
    pub n_goods: u64,
    pub n_embargoes: u64,
    pub embargoes: [[u8; 32]; MAX_EMBARGOES],
    pub goods: [GoodPolicy; MAX_POLICY_GOODS],
}

impl PlanetPolicy {
    pub fn find(&self, good: &[u8; 32]) -> Option<usize> {
        self.goods[..self.n_goods as usize].iter().position(|g| g.good == *good)
    }

    /// The entry for `good`, created (all zero) if it does not exist yet.
    pub fn entry(&mut self, good: &[u8; 32]) -> Result<&mut GoodPolicy> {
        let i = match self.find(good) {
            Some(i) => i,
            None => {
                let i = self.n_goods as usize;
                require!(i < MAX_POLICY_GOODS, ErrorCode::PolicyFull);
                self.goods[i].good = *good;
                self.n_goods += 1;
                i
            }
        };
        Ok(&mut self.goods[i])
    }

    pub fn embargoes_planet(&self, planet: &[u8; 32]) -> bool {
        self.embargoes[..self.n_embargoes as usize].contains(planet)
    }
}
