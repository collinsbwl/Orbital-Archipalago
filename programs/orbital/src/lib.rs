pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("3sRnQvQFEDeZ7Mt5hTk2hghucfB1RvdAB1RMq17BSZBa");

#[program]
pub mod orbital {
    use super::*;

    /// One-time setup: records the admin who may create currencies.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        crate::instructions::initialize::handle_initialize(ctx)
    }

    /// Creates the SPL mint for one planet currency (PDA mint, PDA authority, 0 decimals).
    pub fn create_currency(ctx: Context<CreateCurrency>, code: [u8; 3]) -> Result<()> {
        crate::instructions::create_currency::handle_create_currency(ctx, code)
    }

    /// Initialises a pre-allocated zero-copy ledger for one planet.
    pub fn create_planet(ctx: Context<CreatePlanet>, planet: [u8; 32], currency: [u8; 3]) -> Result<()> {
        crate::instructions::create_planet::handle_create_planet(ctx, planet, currency)
    }

    /// Opens an owner's purse (self-owned SPL token account) in one currency.
    pub fn open_purse(ctx: Context<OpenPurse>, owner: [u8; 32], code: [u8; 3]) -> Result<()> {
        crate::instructions::purse::handle_open_purse(ctx, owner, code)
    }

    /// Genesis mint into a purse.
    pub fn issue(ctx: Context<Issue>, owner: [u8; 32], code: [u8; 3], amount: u64) -> Result<()> {
        crate::instructions::purse::handle_issue(ctx, owner, code, amount)
    }

    /// Moves currency between two purses of the same currency.
    pub fn transfer(ctx: Context<TransferFunds>, from_owner: [u8; 32], to_owner: [u8; 32], code: [u8; 3], amount: u64) -> Result<()> {
        crate::instructions::purse::handle_transfer(ctx, from_owner, to_owner, code, amount)
    }

    /// Genesis: place starting goods in an owner's inventory on this planet.
    pub fn grant(ctx: Context<EditInventory>, owner: [u8; 32], cargo: Vec<Cargo>) -> Result<()> {
        crate::instructions::inventory::handle_grant(ctx, owner, cargo)
    }

    /// Consume inputs and create outputs in an owner's inventory.
    pub fn produce(ctx: Context<EditInventory>, owner: [u8; 32], inputs: Vec<Cargo>, outputs: Vec<Cargo>) -> Result<()> {
        crate::instructions::inventory::handle_produce(ctx, owner, inputs, outputs)
    }

    /// Destroy goods in an owner's inventory.
    pub fn consume(ctx: Context<EditInventory>, owner: [u8; 32], cargo: Vec<Cargo>) -> Result<()> {
        crate::instructions::inventory::handle_consume(ctx, owner, cargo)
    }
}
