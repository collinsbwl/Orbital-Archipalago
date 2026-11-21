use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::{constants::*, error::ErrorCode, state::Config};

/// A purse is an SPL token account at ["purse", owner, code] whose token-owner is
/// ITSELF. Self-owned means no wallet key can spend it; only this program can sign
/// for the PDA, and only inside `transfer`.
#[derive(Accounts)]
#[instruction(owner: [u8; 32], code: [u8; 5])]
pub struct OpenPurse<'info> {
    #[account(mut, address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [MINT_SEED, code.as_ref()], bump)]
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [PURSE_SEED, owner.as_ref(), code.as_ref()],
        bump,
        token::mint = mint,
        token::authority = purse,
    )]
    pub purse: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_purse(_ctx: Context<OpenPurse>, _owner: [u8; 32], _code: [u8; 5]) -> Result<()> {
    Ok(())
}

/// Genesis mint into a purse (starting cash). Later, `borrow` will be the only other minter.
#[derive(Accounts)]
#[instruction(owner: [u8; 32], code: [u8; 5])]
pub struct Issue<'info> {
    #[account(address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA with no data, the mint authority.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [MINT_SEED, code.as_ref()], bump)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [PURSE_SEED, owner.as_ref(), code.as_ref()], bump)]
    pub purse: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_issue(ctx: Context<Issue>, _owner: [u8; 32], _code: [u8; 5], amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);
    let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[ctx.bumps.mint_authority]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.purse.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

#[derive(Accounts)]
#[instruction(from_owner: [u8; 32], to_owner: [u8; 32], code: [u8; 5])]
pub struct TransferFunds<'info> {
    #[account(address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [PURSE_SEED, from_owner.as_ref(), code.as_ref()], bump)]
    pub from_purse: Account<'info, TokenAccount>,
    #[account(mut, seeds = [PURSE_SEED, to_owner.as_ref(), code.as_ref()], bump)]
    pub to_purse: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_transfer(ctx: Context<TransferFunds>, from_owner: [u8; 32], _to_owner: [u8; 32], code: [u8; 5], amount: u64) -> Result<()> {
    // A transfer of 0 is allowed (the ledger contract pins this); only issue and cargo lines require > 0.
    require!(ctx.accounts.from_purse.amount >= amount, ErrorCode::InsufficientFunds);
    let seeds: &[&[u8]] = &[PURSE_SEED, from_owner.as_ref(), code.as_ref(), &[ctx.bumps.from_purse]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.from_purse.to_account_info(),
                to: ctx.accounts.to_purse.to_account_info(),
                authority: ctx.accounts.from_purse.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}
