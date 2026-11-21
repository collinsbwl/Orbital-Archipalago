use anchor_lang::prelude::*;

/// Singleton: who may create currencies.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
}
