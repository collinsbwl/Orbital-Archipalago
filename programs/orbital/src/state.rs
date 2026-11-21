use anchor_lang::prelude::*;

use crate::{constants::MAX_SLOTS, error::ErrorCode};

/// Singleton: who may create currencies and operate the ledger (the sim engine).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
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
