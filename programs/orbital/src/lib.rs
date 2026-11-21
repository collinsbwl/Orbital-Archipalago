pub mod auction;
pub mod constants;
pub mod error;
pub mod fx;
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
    pub fn create_currency(ctx: Context<CreateCurrency>, code: [u8; 5]) -> Result<()> {
        crate::instructions::create_currency::handle_create_currency(ctx, code)
    }

    /// Initialises a pre-allocated zero-copy ledger for one planet.
    pub fn create_planet(ctx: Context<CreatePlanet>, planet: [u8; 32], currency: [u8; 5]) -> Result<()> {
        crate::instructions::create_planet::handle_create_planet(ctx, planet, currency)
    }

    /// Opens an owner's purse (self-owned SPL token account) in one currency.
    pub fn open_purse(ctx: Context<OpenPurse>, owner: [u8; 32], code: [u8; 5]) -> Result<()> {
        crate::instructions::purse::handle_open_purse(ctx, owner, code)
    }

    /// Genesis mint into a purse.
    pub fn issue(ctx: Context<Issue>, owner: [u8; 32], code: [u8; 5], amount: u64) -> Result<()> {
        crate::instructions::purse::handle_issue(ctx, owner, code, amount)
    }

    /// Moves currency between two purses of the same currency.
    pub fn transfer(ctx: Context<TransferFunds>, from_owner: [u8; 32], to_owner: [u8; 32], code: [u8; 5], amount: u64) -> Result<()> {
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

    /// Creates the escrow vault for one currency.
    pub fn create_vault(ctx: Context<CreateVault>, code: [u8; 5]) -> Result<()> {
        crate::instructions::orders::handle_create_vault(ctx, code)
    }

    /// Creates the order book for one (planet, good).
    pub fn create_book(ctx: Context<CreateBook>, planet: [u8; 32], good: [u8; 32]) -> Result<()> {
        crate::instructions::orders::handle_create_book(ctx, planet, good)
    }

    /// Rests one order, escrowing funds (buy) or goods (sell).
    pub fn place_order(ctx: Context<OrderOp>, owner: [u8; 32], code: [u8; 5], side: u8, qty: u64, limit: u64, cycle: u64) -> Result<()> {
        crate::instructions::orders::handle_place_order(ctx, owner, code, side, qty, limit, cycle)
    }

    /// Cancels a resting order and refunds what remains of its escrow.
    pub fn cancel_order(ctx: Context<OrderOp>, owner: [u8; 32], code: [u8; 5], seq: u64) -> Result<()> {
        crate::instructions::orders::handle_cancel_order(ctx, owner, code, seq)
    }

    /// Clears one book at a single uniform price and settles every fill. The client sends the buys and sells already
    /// sorted (best first); the program verifies the sort in one pass. Purses of the filled orders are the remaining accounts.
    pub fn clear_local_auction<'info>(ctx: Context<'info, ClearLocalAuction<'info>>, code: [u8; 5], buys: Vec<u8>, sells: Vec<u8>) -> Result<()> {
        crate::instructions::orders::handle_clear_local_auction(ctx, code, buys, sells)
    }

    /// Creates the FX order book for one currency pair (codes in alphabetical order).
    pub fn create_fx_book(ctx: Context<CreateFxBook>, a: [u8; 5], b: [u8; 5]) -> Result<()> {
        crate::instructions::fx_orders::handle_create_fx_book(ctx, a, b)
    }

    /// Rests one FX order, escrowing the currency it gives.
    pub fn place_fx_order(
        ctx: Context<FxOrderOp>, owner: [u8; 32], a: [u8; 5], b: [u8; 5], give_code: [u8; 5], give_amount: u64, min_receive: u64, cycle: u64,
    ) -> Result<()> {
        crate::instructions::fx_orders::handle_place_fx_order(ctx, owner, a, b, give_code, give_amount, min_receive, cycle)
    }

    /// Cancels an FX order and refunds its escrow.
    pub fn cancel_fx_order(ctx: Context<FxOrderOp>, owner: [u8; 32], a: [u8; 5], b: [u8; 5], give_code: [u8; 5], seq: u64) -> Result<()> {
        crate::instructions::fx_orders::handle_cancel_fx_order(ctx, owner, a, b, give_code, seq)
    }

    /// Clears one FX pair at a single rate and settles and removes every order in its book.
    pub fn clear_fx_auction<'info>(ctx: Context<'info, ClearFxAuction<'info>>, base: [u8; 5], quote: [u8; 5], treasury: [u8; 32]) -> Result<()> {
        crate::instructions::fx_orders::handle_clear_fx_auction(ctx, base, quote, treasury)
    }

    /// Creates a planet's policy account.
    pub fn create_policy(ctx: Context<CreatePolicy>, planet: [u8; 32]) -> Result<()> {
        crate::instructions::policy::handle_create_policy(ctx, planet)
    }

    /// Applies one government decision (tariff, quota, embargo, policy rate) or sets a base price.
    pub fn apply_policy(ctx: Context<ApplyPolicy>, op: PolicyOp) -> Result<()> {
        crate::instructions::policy::handle_apply_policy(ctx, op)
    }

    /// Sends cargo from the owner's inventory on the origin planet into a new shipment.
    pub fn depart(ctx: Context<Depart>, owner: [u8; 32], to: [u8; 32], cargo: Vec<Cargo>, cycle: u64, arrive_cycle: u64) -> Result<()> {
        crate::instructions::shipping::handle_depart(ctx, owner, to, cargo, cycle, arrive_cycle)
    }

    /// Delivers a shipment under the destination's embargo, quota and tariff rules.
    pub fn arrive<'info>(ctx: Context<'info, Arrive<'info>>, shipment_id: u64, cycle: u64, treasury: [u8; 32]) -> Result<()> {
        crate::instructions::shipping::handle_arrive(ctx, shipment_id, cycle, treasury)
    }

    /// Opens an owner in one atomic transaction: purses in every currency, starting cash, starting goods.
    pub fn open_account<'info>(ctx: Context<'info, OpenAccount<'info>>, owner: [u8; 32], codes: Vec<[u8; 5]>, amounts: Vec<u64>, cargo: Vec<Cargo>) -> Result<()> {
        crate::instructions::open_account::handle_open_account(ctx, owner, codes, amounts, cargo)
    }
}
