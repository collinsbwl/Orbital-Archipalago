use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};

use crate::{constants::*, error::ErrorCode, state::{Config, CurrencyBook}};

#[derive(Accounts)]
#[instruction(code: [u8; 5])]
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
    /// Starts at zero minted, zero burned.
    #[account(init, payer = admin, space = 8 + CurrencyBook::INIT_SPACE, seeds = [CURRENCY_SEED, code.as_ref()], bump)]
    pub book: Account<'info, CurrencyBook>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_currency(_ctx: Context<CreateCurrency>, code: [u8; 5]) -> Result<()> {
    require!(valid_code(&code), ErrorCode::InvalidCurrencyCode);
    Ok(())
}

/// 2 to 5 capitals followed only by zero padding, e.g. "HX\0\0\0" or "HELIX". Padding keeps one canonical form per code.
pub fn valid_code(code: &[u8; 5]) -> bool {
    let n = code.iter().position(|&b| b == 0).unwrap_or(5);
    (2..=5).contains(&n) && code[..n].iter().all(|b| b.is_ascii_uppercase()) && code[n..].iter().all(|&b| b == 0)
}
