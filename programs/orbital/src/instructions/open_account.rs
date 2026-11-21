use anchor_lang::prelude::*;
use anchor_spl::token::{self, InitializeAccount3, MintTo, Token};

use crate::{constants::*, error::ErrorCode, instructions::inventory::check_lines, state::*};

/// Size of an SPL token account.
const TOKEN_ACCOUNT_LEN: u64 = 165;

#[derive(Accounts)]
pub struct OpenAccount<'info> {
    #[account(mut, address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA with no data, the mint authority.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    /// The planet ledger where the starting goods are placed.
    #[account(mut)]
    pub ledger: AccountLoader<'info, PlanetLedger>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: for each currency, in order, [its mint, the owner's new purse (not yet created)].
}

/// Opens an owner completely in one transaction: a purse in every currency, the starting cash minted into them, and the
/// starting goods placed on the home planet. Being one transaction, it either all happens or none of it does, so there is
/// no half-opened account.
pub fn handle_open_account<'info>(
    ctx: Context<'info, OpenAccount<'info>>, owner: [u8; 32], codes: Vec<[u8; 5]>, amounts: Vec<u64>, cargo: Vec<Cargo>,
) -> Result<()> {
    require!(codes.len() == amounts.len() && ctx.remaining_accounts.len() == codes.len() * 2, ErrorCode::AccountMismatch);
    check_lines(&cargo)?;

    let rent = Rent::get()?.minimum_balance(TOKEN_ACCOUNT_LEN as usize);
    for (i, (code, amount)) in codes.iter().zip(&amounts).enumerate() {
        let (mint, purse) = (&ctx.remaining_accounts[2 * i], &ctx.remaining_accounts[2 * i + 1]);
        let expected_mint = Pubkey::find_program_address(&[MINT_SEED, code.as_ref()], &crate::ID).0;
        require_keys_eq!(mint.key(), expected_mint, ErrorCode::AccountMismatch);
        let (expected_purse, bump) = Pubkey::find_program_address(&[PURSE_SEED, owner.as_ref(), code.as_ref()], &crate::ID);
        require_keys_eq!(purse.key(), expected_purse, ErrorCode::AccountMismatch);

        // Create the purse as a token account that is its own owner, so no wallet key can spend it.
        let seeds: &[&[u8]] = &[PURSE_SEED, owner.as_ref(), code.as_ref(), &[bump]];
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::CreateAccount { from: ctx.accounts.admin.to_account_info(), to: purse.clone() },
                &[seeds],
            ),
            rent,
            TOKEN_ACCOUNT_LEN,
            &token::ID,
        )?;
        token::initialize_account3(CpiContext::new(
            ctx.accounts.token_program.key(),
            InitializeAccount3 { account: purse.clone(), mint: mint.clone(), authority: purse.clone() },
        ))?;

        if *amount > 0 {
            let authority_seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, &[ctx.bumps.mint_authority]];
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    MintTo { mint: mint.clone(), to: purse.clone(), authority: ctx.accounts.mint_authority.to_account_info() },
                    &[authority_seeds],
                ),
                *amount,
            )?;
        }
    }

    let mut ledger = ctx.accounts.ledger.load_mut()?;
    for c in &cargo {
        ledger.add(&owner, &c.good, c.qty)?;
    }
    Ok(())
}
