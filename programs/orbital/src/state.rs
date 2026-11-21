use anchor_lang::prelude::*;

use crate::{constants::{MAX_ORDERS, MAX_SLOTS}, error::ErrorCode};

/// Singleton: who may create currencies and operate the ledger (the sim engine).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Next order sequence number (local and FX orders share it). Ids are "o<seq>", starting at 1.
    pub next_order: u64,
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
