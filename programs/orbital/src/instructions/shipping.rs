use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct Depart<'info> {
    #[account(mut, address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + Shipment::INIT_SPACE,
        seeds = [SHIPMENT_SEED, config.next_shipment.to_le_bytes().as_ref()],
        bump
    )]
    pub shipment: Account<'info, Shipment>,
    /// The origin planet's ledger: the cargo leaves the owner's inventory here.
    #[account(mut)]
    pub from_ledger: AccountLoader<'info, PlanetLedger>,
    pub system_program: Program<'info, System>,
}

/// Moves cargo out of the owner's inventory on the origin planet into a new shipment.
pub fn handle_depart(ctx: Context<Depart>, owner: [u8; 32], to: [u8; 32], cargo: Vec<Cargo>, cycle: u64, arrive_cycle: u64) -> Result<()> {
    require!(!cargo.is_empty() && cargo.len() <= MAX_CARGO_LINES, ErrorCode::TooManyCargoLines);
    require!(cargo.iter().all(|c| c.qty > 0), ErrorCode::InvalidAmount);
    require!(arrive_cycle > cycle, ErrorCode::InvalidAmount);

    let mut from_ledger = ctx.accounts.from_ledger.load_mut()?;
    require!(from_ledger.planet != to, ErrorCode::InvalidAmount);

    let sh = &mut ctx.accounts.shipment;
    sh.owner = owner;
    sh.from = from_ledger.planet;
    sh.to = to;
    for (i, c) in cargo.iter().enumerate() {
        from_ledger.sub(&owner, &c.good, c.qty)?;
        sh.lines[i] = CargoLine { good: c.good, qty: c.qty };
    }
    sh.n_lines = cargo.len() as u8;
    sh.depart_cycle = cycle;
    sh.arrive_cycle = arrive_cycle;
    sh.arrived = false;

    ctx.accounts.config.next_shipment = ctx.accounts.config.next_shipment.checked_add(1).ok_or(ErrorCode::Overflow)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(shipment_id: u64, cycle: u64, treasury: [u8; 32])]
pub struct Arrive<'info> {
    #[account(address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [SHIPMENT_SEED, shipment_id.to_le_bytes().as_ref()], bump)]
    pub shipment: Account<'info, Shipment>,
    /// Origin planet ledger: withheld cargo goes back here.
    #[account(mut)]
    pub from_ledger: AccountLoader<'info, PlanetLedger>,
    /// Destination planet ledger: delivered cargo goes here.
    #[account(mut)]
    pub to_ledger: AccountLoader<'info, PlanetLedger>,
    /// Destination planet policy: embargoes, quotas, tariffs and prices.
    #[account(mut)]
    pub policy: AccountLoader<'info, PlanetPolicy>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: only when duty is owed, [owner purse, destination treasury purse], both in the destination currency.
}

/// Delivers a shipment under the destination's policy:
///   1. an embargo on the origin planet withholds everything;
///   2. otherwise each good is capped by its quota for this cycle (the excess is withheld);
///   3. withheld cargo returns to the owner on the origin planet, delivered cargo goes to the owner on the destination;
///   4. each delivered good pays floor(qty * price * tariff / 10000) from the owner's purse to the destination treasury
///      (capped by what the owner holds), where price is the last clearing price on that planet or else the base price.
pub fn handle_arrive<'info>(ctx: Context<'info, Arrive<'info>>, _shipment_id: u64, cycle: u64, treasury: [u8; 32]) -> Result<()> {
    let sh = &mut ctx.accounts.shipment;
    require!(!sh.arrived, ErrorCode::ShipmentNotInFlight);
    require!(cycle >= sh.arrive_cycle, ErrorCode::ArrivedTooEarly);

    let mut from = ctx.accounts.from_ledger.load_mut()?;
    let mut to = ctx.accounts.to_ledger.load_mut()?;
    let mut policy = ctx.accounts.policy.load_mut()?;
    require!(from.planet == sh.from && to.planet == sh.to && policy.planet == sh.to, ErrorCode::AccountMismatch);

    let embargoed = policy.embargoes_planet(&sh.from);
    let mut owed: u128 = 0;
    for line in sh.lines[..sh.n_lines as usize].iter() {
        let (good, qty) = (line.good, line.qty);
        let mut delivered = if embargoed { 0 } else { qty };
        if !embargoed {
            if let Some(i) = policy.find(&good) {
                let g = &mut policy.goods[i];
                if g.has_quota == 1 {
                    if g.quota_cycle != cycle {
                        g.quota_cycle = cycle;
                        g.quota_used = 0;
                    }
                    delivered = qty.min(g.quota_max.saturating_sub(g.quota_used));
                    g.quota_used += delivered;
                }
                if delivered > 0 && g.tariff_bp > 0 {
                    let price = if g.has_price == 1 { g.last_price } else { g.base_price };
                    owed += delivered as u128 * price as u128 * g.tariff_bp as u128 / 10_000;
                }
            }
        }
        if delivered > 0 {
            to.add(&sh.owner, &good, delivered)?;
        }
        if qty > delivered {
            from.add(&sh.owner, &good, qty - delivered)?;
        }
    }
    sh.arrived = true;

    if owed == 0 {
        require!(ctx.remaining_accounts.is_empty(), ErrorCode::AccountMismatch);
        return Ok(());
    }
    require!(ctx.remaining_accounts.len() == 2, ErrorCode::AccountMismatch);
    let code = to.currency;
    let (owner_purse, treasury_purse) = (&ctx.remaining_accounts[0], &ctx.remaining_accounts[1]);
    let (expected_owner, bump) = Pubkey::find_program_address(&[PURSE_SEED, sh.owner.as_ref(), code.as_ref()], &crate::ID);
    require_keys_eq!(owner_purse.key(), expected_owner, ErrorCode::AccountMismatch);
    let expected_treasury = Pubkey::find_program_address(&[PURSE_SEED, treasury.as_ref(), code.as_ref()], &crate::ID).0;
    require_keys_eq!(treasury_purse.key(), expected_treasury, ErrorCode::AccountMismatch);

    // The treasury must be the destination planet's own (its key is the planet's id hash).
    require!(treasury == to.planet, ErrorCode::AccountMismatch);
    let held = Account::<TokenAccount>::try_from(owner_purse)?.amount;
    let duty = (owed.min(held as u128)) as u64;
    if duty > 0 {
        let seeds: &[&[u8]] = &[PURSE_SEED, sh.owner.as_ref(), code.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer { from: owner_purse.clone(), to: treasury_purse.clone(), authority: owner_purse.clone() },
                &[seeds],
            ),
            duty,
        )?;
    }
    Ok(())
}
