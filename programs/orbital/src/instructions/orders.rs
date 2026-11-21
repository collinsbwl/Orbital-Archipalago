use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::{
    auction::{self, Bid, Side},
    constants::*,
    error::ErrorCode,
    state::*,
};

// ---- Setup: escrow vault per currency, order book per (planet, good) --------------------------------

/// The vault holds every buy order's escrowed currency. Like a purse it is a self-owned token account.
#[derive(Accounts)]
#[instruction(code: [u8; 3])]
pub struct CreateVault<'info> {
    #[account(mut, address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [MINT_SEED, code.as_ref()], bump)]
    pub mint: Account<'info, Mint>,
    #[account(init, payer = admin, seeds = [VAULT_SEED, code.as_ref()], bump, token::mint = mint, token::authority = vault)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_vault(_ctx: Context<CreateVault>, _code: [u8; 3]) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
#[instruction(planet: [u8; 32], good: [u8; 32])]
pub struct CreateBook<'info> {
    #[account(mut, address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + std::mem::size_of::<OrderBook>(),
        seeds = [BOOK_SEED, planet.as_ref(), good.as_ref()],
        bump
    )]
    pub book: AccountLoader<'info, OrderBook>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_book(ctx: Context<CreateBook>, planet: [u8; 32], good: [u8; 32]) -> Result<()> {
    let mut book = ctx.accounts.book.load_init()?;
    book.planet = planet;
    book.good = good;
    Ok(())
}

// ---- Placing and cancelling ---------------------------------------------------------------------------

/// Everything needed to escrow or refund one owner's order on one book.
#[derive(Accounts)]
#[instruction(owner: [u8; 32], code: [u8; 3])]
pub struct OrderOp<'info> {
    #[account(address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub book: AccountLoader<'info, OrderBook>,
    #[account(mut)]
    pub ledger: AccountLoader<'info, PlanetLedger>,
    #[account(mut, seeds = [VAULT_SEED, code.as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [PURSE_SEED, owner.as_ref(), code.as_ref()], bump)]
    pub purse: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

fn check_book(book: &OrderBook, ledger: &PlanetLedger, code: &[u8; 3]) -> Result<()> {
    require!(book.planet == ledger.planet && ledger.currency == *code, ErrorCode::AccountMismatch);
    Ok(())
}

pub fn handle_place_order(ctx: Context<OrderOp>, owner: [u8; 32], code: [u8; 3], side: u8, qty: u64, limit: u64, cycle: u64) -> Result<()> {
    require!(qty > 0, ErrorCode::InvalidAmount);
    let mut book = ctx.accounts.book.load_mut()?;
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    check_book(&book, &ledger, &code)?;

    match side {
        SIDE_BUY => {
            // Escrow the most the buyer could pay. Price improvement is refunded at the auction.
            let escrow = qty.checked_mul(limit).ok_or(ErrorCode::Overflow)?;
            require!(ctx.accounts.purse.amount >= escrow, ErrorCode::InsufficientFunds);
            let seeds: &[&[u8]] = &[PURSE_SEED, owner.as_ref(), code.as_ref(), &[ctx.bumps.purse]];
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
                escrow,
            )?;
        }
        SIDE_SELL => ledger.sub(&owner, &book.good, qty)?, // the goods now live in the order
        _ => return err!(ErrorCode::InvalidSide),
    }

    let seq = ctx.accounts.config.next_order;
    ctx.accounts.config.next_order = seq.checked_add(1).ok_or(ErrorCode::Overflow)?;
    book.push(OrderSlot { seq, owner, qty, limit, cycle, side, _pad: [0; 7] })
}

pub fn handle_cancel_order(ctx: Context<OrderOp>, owner: [u8; 32], code: [u8; 3], seq: u64) -> Result<()> {
    let mut book = ctx.accounts.book.load_mut()?;
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    check_book(&book, &ledger, &code)?;

    let i = book.find(seq).ok_or(ErrorCode::UnknownOrder)?;
    let slot = book.slots[i];
    require!(slot.owner == owner, ErrorCode::AccountMismatch);

    if slot.side == SIDE_BUY {
        let refund = slot.qty.checked_mul(slot.limit).ok_or(ErrorCode::Overflow)?;
        let seeds: &[&[u8]] = &[VAULT_SEED, code.as_ref(), &[ctx.bumps.vault]];
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
            refund,
        )?;
    } else {
        ledger.add(&owner, &book.good, slot.qty)?;
    }
    book.remove(i);
    Ok(())
}

// ---- The auction ----------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(code: [u8; 3])]
pub struct ClearLocalAuction<'info> {
    #[account(address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub book: AccountLoader<'info, OrderBook>,
    #[account(mut)]
    pub ledger: AccountLoader<'info, PlanetLedger>,
    #[account(mut, seeds = [VAULT_SEED, code.as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: one purse per fill, in fill order (all buys, then all sells). The client works the fills
    // out with the same rules; if it gets one wrong the account check below fails and the whole clear reverts.
}

/// Pays `amount` from the vault to `to` (a purse). Zero is skipped.
fn pay_from_vault<'info>(ctx: &Context<'info, ClearLocalAuction<'info>>, code: &[u8; 3], to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[VAULT_SEED, code.as_ref(), &[ctx.bumps.vault]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: to.clone(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// `buys` and `sells` are the book's buy and sell orders as indices, best first (the client sorts, this verifies).
pub fn handle_clear_local_auction<'info>(ctx: Context<'info, ClearLocalAuction<'info>>, code: [u8; 3], buys: Vec<u8>, sells: Vec<u8>) -> Result<()> {
    let mut book = ctx.accounts.book.load_mut()?;
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    check_book(&book, &ledger, &code)?;

    let len = book.len as usize;
    let bids: Vec<Bid> = book.slots[..len]
        .iter()
        .map(|s| Bid { side: if s.side == SIDE_BUY { Side::Buy } else { Side::Sell }, qty: s.qty, limit: s.limit })
        .collect();
    let (buys, sells): (Vec<usize>, Vec<usize>) = (buys.iter().map(|&i| i as usize).collect(), sells.iter().map(|&i| i as usize).collect());
    let outcome = auction::clear_sorted(&bids, &buys, &sells).map_err(|_| error!(ErrorCode::BadSortOrder))?;
    let Some(price) = outcome.price else { return Ok(()) };
    require!(ctx.remaining_accounts.len() == outcome.fills.len(), ErrorCode::AccountMismatch);

    let good = book.good;
    for (k, &(i, q)) in outcome.fills.iter().enumerate() {
        let slot = book.slots[i];
        let purse = &ctx.remaining_accounts[k];
        let expected = Pubkey::find_program_address(&[PURSE_SEED, slot.owner.as_ref(), code.as_ref()], &crate::ID).0;
        require_keys_eq!(purse.key(), expected, ErrorCode::AccountMismatch);

        if slot.side == SIDE_BUY {
            // The buyer gets the goods and the difference between what was escrowed and what it pays.
            ledger.add(&slot.owner, &good, q)?;
            let refund = q.checked_mul(slot.limit - price).ok_or(ErrorCode::Overflow)?;
            pay_from_vault(&ctx, &code, purse, refund)?;
        } else {
            // The seller's goods were escrowed at placement; it just gets paid.
            let paid = q.checked_mul(price).ok_or(ErrorCode::Overflow)?;
            pay_from_vault(&ctx, &code, purse, paid)?;
        }
        book.slots[i].qty -= q;
    }
    book.compact();
    Ok(())
}
