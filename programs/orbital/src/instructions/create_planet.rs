use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct CreatePlanet<'info> {
    #[account(address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// Pre-allocated by the client at full size (too big for a CPI-created account),
    /// owned by this program and still zeroed; `zero` checks exactly that.
    #[account(zero)]
    pub ledger: AccountLoader<'info, PlanetLedger>,
}

pub fn handle_create_planet(ctx: Context<CreatePlanet>, planet: [u8; 32], currency: [u8; 3]) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_init()?;
    ledger.planet = planet;
    ledger.currency = currency;
    Ok(())
}
