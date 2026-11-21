use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};

use crate::{constants::*, error::ErrorCode, state::*};

/// A loan is money creation: the planet's currency is minted straight into the borrower's purse.
#[derive(Accounts)]
#[instruction(owner: [u8; 32], planet: [u8; 32], code: [u8; 5])]
pub struct Borrow<'info> {
    #[account(mut, address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + Loan::INIT_SPACE,
        seeds = [LOAN_SEED, config.next_loan.to_le_bytes().as_ref()],
        bump
    )]
    pub loan: Account<'info, Loan>,
    /// The lending planet's policy: its current rate is snapshotted into the loan.
    pub policy: AccountLoader<'info, PlanetPolicy>,
    /// Proves `code` is that planet's currency.
    pub ledger: AccountLoader<'info, PlanetLedger>,
    /// CHECK: PDA with no data, the mint authority.
    #[account(seeds = [MINT_AUTHORITY_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [MINT_SEED, code.as_ref()], bump)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [CURRENCY_SEED, code.as_ref()], bump)]
    pub book: Account<'info, CurrencyBook>,
    #[account(mut, seeds = [PURSE_SEED, owner.as_ref(), code.as_ref()], bump)]
    pub purse: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_borrow(ctx: Context<Borrow>, owner: [u8; 32], planet: [u8; 32], code: [u8; 5], amount: u64, term_cycles: u64, cycle: u64) -> Result<()> {
    require!(amount > 0 && term_cycles >= 1, ErrorCode::InvalidAmount);
    let rate_bp = {
        let policy = ctx.accounts.policy.load()?;
        let ledger = ctx.accounts.ledger.load()?;
        require!(policy.planet == planet && ledger.planet == planet && ledger.currency == code, ErrorCode::AccountMismatch);
        policy.policy_rate_bp
    };

    let id = ctx.accounts.config.next_loan;
    ctx.accounts.config.next_loan = id.checked_add(1).ok_or(ErrorCode::Overflow)?;
    let loan = &mut ctx.accounts.loan;
    loan.borrower = owner;
    loan.planet = planet;
    loan.currency = code;
    loan.principal = amount;
    loan.outstanding = amount;
    loan.rate_bp = rate_bp;
    loan.issued_cycle = cycle;
    loan.due_cycle = cycle.checked_add(term_cycles).ok_or(ErrorCode::Overflow)?;
    loan.last_accrual = cycle;

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
    )?;
    ctx.accounts.book.record_mint(amount)?;
    require!(mint_supply(&ctx.accounts.mint.to_account_info())? == ctx.accounts.book.expected_supply(), ErrorCode::SupplyMismatch);
    Ok(())
}

/// Repaying is money destruction: the payment is burned out of the borrower's purse.
#[derive(Accounts)]
#[instruction(loan_id: u64, code: [u8; 5])]
pub struct Repay<'info> {
    #[account(address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [LOAN_SEED, loan_id.to_le_bytes().as_ref()], bump)]
    pub loan: Account<'info, Loan>,
    #[account(mut, seeds = [MINT_SEED, code.as_ref()], bump)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [CURRENCY_SEED, code.as_ref()], bump)]
    pub book: Account<'info, CurrencyBook>,
    #[account(mut, seeds = [PURSE_SEED, loan.borrower.as_ref(), code.as_ref()], bump)]
    pub purse: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Accrues simple interest since the last accrual (floor(principal * rate * cycles / 10000)), then burns
/// min(amount, outstanding) from the borrower's purse.
pub fn handle_repay(ctx: Context<Repay>, _loan_id: u64, code: [u8; 5], amount: u64, cycle: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);
    let loan = &mut ctx.accounts.loan;
    require!(loan.currency == code, ErrorCode::AccountMismatch);
    require!(loan.outstanding > 0, ErrorCode::LoanSettled);
    require!(cycle >= loan.last_accrual, ErrorCode::CycleBeforeAccrual);

    let interest = loan.principal as u128 * loan.rate_bp as u128 * (cycle - loan.last_accrual) as u128 / 10_000;
    let outstanding = u64::try_from(loan.outstanding as u128 + interest).map_err(|_| ErrorCode::Overflow)?;
    let pay = amount.min(outstanding);
    require!(ctx.accounts.purse.amount >= pay, ErrorCode::InsufficientFunds);

    let seeds: &[&[u8]] = &[PURSE_SEED, loan.borrower.as_ref(), code.as_ref(), &[ctx.bumps.purse]];
    token::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.purse.to_account_info(),
                authority: ctx.accounts.purse.to_account_info(),
            },
            &[seeds],
        ),
        pay,
    )?;
    loan.outstanding = outstanding - pay;
    loan.last_accrual = cycle;
    ctx.accounts.book.record_burn(pay)?;
    require!(mint_supply(&ctx.accounts.mint.to_account_info())? == ctx.accounts.book.expected_supply(), ErrorCode::SupplyMismatch);
    Ok(())
}
