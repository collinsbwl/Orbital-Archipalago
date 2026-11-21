pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("3sRnQvQFEDeZ7Mt5hTk2hghucfB1RvdAB1RMq17BSZBa");

#[program]
pub mod orbital {
    use super::*;

    /// One-time setup: records the admin who may create currencies.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        crate::instructions::initialize::handle_initialize(ctx)
    }

    /// Creates the SPL mint for one planet currency (PDA mint, PDA authority, 0 decimals).
    pub fn create_currency(ctx: Context<CreateCurrency>, code: [u8; 3]) -> Result<()> {
        crate::instructions::create_currency::handle_create_currency(ctx, code)
    }
}
