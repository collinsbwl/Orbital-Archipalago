use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the admin can do this")]
    Unauthorized,
    #[msg("Currency code must be 3 ASCII capitals")]
    InvalidCurrencyCode,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Insufficient funds in purse")]
    InsufficientFunds,
    #[msg("Insufficient inventory")]
    InsufficientInventory,
    #[msg("Planet ledger is full")]
    LedgerFull,
    #[msg("Too many cargo lines")]
    TooManyCargoLines,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Unknown order")]
    UnknownOrder,
    #[msg("Order book is full")]
    BookFull,
    #[msg("Accounts do not match (planet, currency, owner or purse)")]
    AccountMismatch,
    #[msg("Invalid order side")]
    InvalidSide,
    #[msg("The supplied sort order is not valid for this book")]
    BadSortOrder,
}
