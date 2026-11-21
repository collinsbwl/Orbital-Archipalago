use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
#[instruction(planet: [u8; 32])]
pub struct CreatePolicy<'info> {
    #[account(mut, address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + std::mem::size_of::<PlanetPolicy>(),
        seeds = [POLICY_SEED, planet.as_ref()],
        bump
    )]
    pub policy: AccountLoader<'info, PlanetPolicy>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_policy(ctx: Context<CreatePolicy>, planet: [u8; 32]) -> Result<()> {
    ctx.accounts.policy.load_init()?.planet = planet;
    Ok(())
}

/// One government decision. Goods and planets are sha256 keys, like everywhere else on-chain.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum PolicyOp {
    /// rate_bp 0 removes the tariff.
    SetTariff { good: [u8; 32], rate_bp: u64 },
    /// Quotas are never removed; 0 blocks the good.
    SetQuota { good: [u8; 32], max: u64 },
    SetEmbargo { target: [u8; 32], active: bool },
    SetPolicyRate { rate_bp: u64 },
    /// Genesis: the price tariffs use until a local auction clears.
    SetBasePrice { good: [u8; 32], price: u64 },
}

#[derive(Accounts)]
pub struct ApplyPolicy<'info> {
    #[account(address = config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub policy: AccountLoader<'info, PlanetPolicy>,
}

pub fn handle_apply_policy(ctx: Context<ApplyPolicy>, op: PolicyOp) -> Result<()> {
    let mut p = ctx.accounts.policy.load_mut()?;
    match op {
        PolicyOp::SetTariff { good, rate_bp } => {
            require!(rate_bp <= 10_000, ErrorCode::InvalidRate);
            p.entry(&good)?.tariff_bp = rate_bp;
        }
        PolicyOp::SetQuota { good, max } => {
            let g = p.entry(&good)?;
            g.quota_max = max;
            g.has_quota = 1;
        }
        PolicyOp::SetEmbargo { target, active } => {
            let n = p.n_embargoes as usize;
            let at = p.embargoes[..n].iter().position(|e| *e == target);
            match (active, at) {
                (true, None) => {
                    require!(n < MAX_EMBARGOES, ErrorCode::PolicyFull);
                    p.embargoes[n] = target;
                    p.n_embargoes += 1;
                }
                (false, Some(i)) => {
                    p.embargoes[i] = p.embargoes[n - 1];
                    p.n_embargoes -= 1;
                }
                _ => {} // already in the requested state
            }
        }
        PolicyOp::SetPolicyRate { rate_bp } => {
            require!(rate_bp <= 10_000, ErrorCode::InvalidRate);
            p.policy_rate_bp = rate_bp;
        }
        PolicyOp::SetBasePrice { good, price } => p.entry(&good)?.base_price = price,
    }
    Ok(())
}
