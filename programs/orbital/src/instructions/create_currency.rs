use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};

use crate::{constants::*, error::ErrorCode, state::Config};

#[derive(Accounts)]
#[instruction(code: [u8; 3])]
pub struct CreateCurrency<'info> {
    #[account(mut, address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA with no data; it only exists to be the mint authority.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        seeds = [MINT_SEED, code.as_ref()],
        bump,
        mint::decimals = CURRENCY_DECIMALS,
        mint::authority = mint_authority,
        // No freeze authority: nobody can freeze a purse.
    )]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_currency(_ctx: Context<CreateCurrency>, code: [u8; 3]) -> Result<()> {
    require!(
        code.iter().all(|b| b.is_ascii_uppercase()),
        ErrorCode::InvalidCurrencyCode
    );
    Ok(())
}
