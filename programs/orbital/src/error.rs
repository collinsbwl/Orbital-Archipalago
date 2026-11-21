use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the admin can do this")]
    Unauthorized,
    #[msg("Currency code must be 3 ASCII capitals")]
    InvalidCurrencyCode,
}
