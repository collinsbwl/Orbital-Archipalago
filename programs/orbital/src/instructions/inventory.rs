use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct EditInventory<'info> {
    #[account(address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub ledger: AccountLoader<'info, PlanetLedger>,
}

fn check_lines(lines: &[Cargo]) -> Result<()> {
    require!(lines.len() <= MAX_CARGO_LINES, ErrorCode::TooManyCargoLines);
    require!(lines.iter().all(|c| c.qty > 0), ErrorCode::InvalidAmount);
    Ok(())
}

/// Genesis: place starting goods (the engine's `openAccount` inventory).
pub fn handle_grant(ctx: Context<EditInventory>, owner: [u8; 32], cargo: Vec<Cargo>) -> Result<()> {
    check_lines(&cargo)?;
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    for c in &cargo {
        ledger.add(&owner, &c.good, c.qty)?;
    }
    Ok(())
}

/// Consume `inputs`, create `outputs`. Atomic: any failure reverts the whole transaction.
pub fn handle_produce(ctx: Context<EditInventory>, owner: [u8; 32], inputs: Vec<Cargo>, outputs: Vec<Cargo>) -> Result<()> {
    check_lines(&inputs)?;
    check_lines(&outputs)?;
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    for c in &inputs {
        ledger.sub(&owner, &c.good, c.qty)?;
    }
    for c in &outputs {
        ledger.add(&owner, &c.good, c.qty)?;
    }
    Ok(())
}

/// Destroy goods (household consumption).
pub fn handle_consume(ctx: Context<EditInventory>, owner: [u8; 32], cargo: Vec<Cargo>) -> Result<()> {
    check_lines(&cargo)?;
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    for c in &cargo {
        ledger.sub(&owner, &c.good, c.qty)?;
    }
    Ok(())
}
