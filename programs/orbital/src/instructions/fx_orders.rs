use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::ErrorCode,
    fx::{self, FxBid},
    state::*,
};

/// FX orders reuse OrderBook/OrderSlot: slot.qty = giveAmount, slot.limit = minReceive, slot.side = 0 if the order
/// gives the pair's first (alphabetical) currency, 1 if it gives the second. The book's planet/good fields hold the codes.
fn pad(code: &[u8; 3]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..3].copy_from_slice(code);
    out
}

fn check_pair(a: &[u8; 3], b: &[u8; 3]) -> Result<()> {
    require!(a < b, ErrorCode::AccountMismatch); // canonical order, so each pair has exactly one book
    Ok(())
}

#[derive(Accounts)]
#[instruction(a: [u8; 3], b: [u8; 3])]
pub struct CreateFxBook<'info> {
    #[account(mut, address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + std::mem::size_of::<OrderBook>(),
        seeds = [FX_BOOK_SEED, a.as_ref(), b.as_ref()],
        bump
    )]
    pub book: AccountLoader<'info, OrderBook>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_fx_book(ctx: Context<CreateFxBook>, a: [u8; 3], b: [u8; 3]) -> Result<()> {
    check_pair(&a, &b)?;
    let mut book = ctx.accounts.book.load_init()?;
    book.planet = pad(&a);
    book.good = pad(&b);
    Ok(())
}

#[derive(Accounts)]
#[instruction(owner: [u8; 32], a: [u8; 3], b: [u8; 3], give_code: [u8; 3])]
pub struct FxOrderOp<'info> {
    #[account(address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [FX_BOOK_SEED, a.as_ref(), b.as_ref()], bump)]
    pub book: AccountLoader<'info, OrderBook>,
    #[account(mut, seeds = [VAULT_SEED, give_code.as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [PURSE_SEED, owner.as_ref(), give_code.as_ref()], bump)]
    pub purse: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

fn side_of(give_code: &[u8; 3], a: &[u8; 3], b: &[u8; 3]) -> Result<u8> {
    if give_code == a {
        Ok(0)
    } else if give_code == b {
        Ok(1)
    } else {
        err!(ErrorCode::AccountMismatch)
    }
}

pub fn handle_place_fx_order(
    ctx: Context<FxOrderOp>, owner: [u8; 32], a: [u8; 3], b: [u8; 3], give_code: [u8; 3], give_amount: u64, min_receive: u64, cycle: u64,
) -> Result<()> {
    require!(give_amount > 0, ErrorCode::InvalidAmount);
    check_pair(&a, &b)?;
    let side = side_of(&give_code, &a, &b)?;
    require!(ctx.accounts.purse.amount >= give_amount, ErrorCode::InsufficientFunds);

    let seeds: &[&[u8]] = &[PURSE_SEED, owner.as_ref(), give_code.as_ref(), &[ctx.bumps.purse]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.purse.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.purse.to_account_info(),
            },
            &[seeds],
        ),
        give_amount,
    )?;

    let seq = ctx.accounts.config.next_order;
    ctx.accounts.config.next_order = seq.checked_add(1).ok_or(ErrorCode::Overflow)?;
    ctx.accounts.book.load_mut()?.push(OrderSlot { seq, owner, qty: give_amount, limit: min_receive, cycle, side, _pad: [0; 7] })
}

pub fn handle_cancel_fx_order(ctx: Context<FxOrderOp>, owner: [u8; 32], a: [u8; 3], b: [u8; 3], give_code: [u8; 3], seq: u64) -> Result<()> {
    let mut book = ctx.accounts.book.load_mut()?;
    let i = book.find(seq).ok_or(ErrorCode::UnknownOrder)?;
    let slot = book.slots[i];
    require!(slot.owner == owner && slot.side == side_of(&give_code, &a, &b)?, ErrorCode::AccountMismatch);

    let seeds: &[&[u8]] = &[VAULT_SEED, give_code.as_ref(), &[ctx.bumps.vault]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.purse.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        slot.qty,
    )?;
    book.remove(i);
    Ok(())
}

// ---- The FX auction ---------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(base: [u8; 3], quote: [u8; 3])]
pub struct ClearFxAuction<'info> {
    #[account(address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub book: AccountLoader<'info, OrderBook>,
    #[account(mut, seeds = [VAULT_SEED, base.as_ref()], bump)]
    pub base_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_SEED, quote.as_ref()], bump)]
    pub quote_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts, in book order: for every order its purse in the currency it gives (refund of what it did not
    // spend), then, if it traded, its purse in the currency it receives. Last, if rounding left dust, the quote treasury's purse.
}

fn pay<'info>(token_program: Pubkey, vault: &Account<'info, TokenAccount>, bump: u8, code: &[u8; 3], to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[VAULT_SEED, code.as_ref(), &[bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program,
            Transfer { from: vault.to_account_info(), to: to.clone(), authority: vault.to_account_info() },
            &[seeds],
        ),
        amount,
    )
}

fn check_purse(account: &AccountInfo, owner: &[u8; 32], code: &[u8; 3]) -> Result<()> {
    let expected = Pubkey::find_program_address(&[PURSE_SEED, owner.as_ref(), code.as_ref()], &crate::ID).0;
    require_keys_eq!(account.key(), expected, ErrorCode::AccountMismatch);
    Ok(())
}

/// Clears every order in the pair's book at one rate and removes them all (orders are immediate-or-cancel):
/// what is not spent is refunded.
pub fn handle_clear_fx_auction<'info>(ctx: Context<'info, ClearFxAuction<'info>>, base: [u8; 3], quote: [u8; 3], treasury: [u8; 32]) -> Result<()> {
    let (a, b) = if base < quote { (base, quote) } else { (quote, base) };
    let mut book = ctx.accounts.book.load_mut()?;
    require!(book.planet == pad(&a) && book.good == pad(&b), ErrorCode::AccountMismatch);

    let len = book.len as usize;
    let give_code = |side: u8| if side == 0 { a } else { b };
    let bids: Vec<FxBid> = book.slots[..len]
        .iter()
        .map(|s| FxBid { gives_base: give_code(s.side) == base, give: s.qty, min_receive: s.limit })
        .collect();
    let outcome = fx::clear(&bids);
    let mut by_index: Vec<Option<(u64, u64)>> = vec![None; len];
    for f in &outcome.fills {
        by_index[f.index] = Some((f.spent, f.received));
    }

    let program = ctx.accounts.token_program.key();
    let (base_bump, quote_bump) = (ctx.bumps.base_vault, ctx.bumps.quote_vault);
    let mut next = 0usize;
    let mut take = |ctx: &Context<'info, ClearFxAuction<'info>>| -> Result<AccountInfo<'info>> {
        let acc = ctx.remaining_accounts.get(next).ok_or(ErrorCode::AccountMismatch)?.clone();
        next += 1;
        Ok(acc)
    };

    for i in 0..len {
        let slot = book.slots[i];
        let gives = give_code(slot.side);
        let gives_base = gives == base;
        let wants = if gives_base { quote } else { base };
        let (give_vault, give_bump, want_vault, want_bump) = if gives_base {
            (&ctx.accounts.base_vault, base_bump, &ctx.accounts.quote_vault, quote_bump)
        } else {
            (&ctx.accounts.quote_vault, quote_bump, &ctx.accounts.base_vault, base_bump)
        };

        let give_purse = take(&ctx)?;
        check_purse(&give_purse, &slot.owner, &gives)?;
        let (spent, received) = by_index[i].unwrap_or((0, 0));
        pay(program, give_vault, give_bump, &gives, &give_purse, slot.qty - spent)?;
        if by_index[i].is_some() {
            let want_purse = take(&ctx)?;
            check_purse(&want_purse, &slot.owner, &wants)?;
            pay(program, want_vault, want_bump, &wants, &want_purse, received)?;
        }
    }
    if outcome.dust > 0 {
        let treasury_purse = take(&ctx)?;
        check_purse(&treasury_purse, &treasury, &quote)?;
        pay(program, &ctx.accounts.quote_vault, quote_bump, &quote, &treasury_purse, outcome.dust)?;
    }
    require!(next == ctx.remaining_accounts.len(), ErrorCode::AccountMismatch);
    book.len = 0;
    Ok(())
}
