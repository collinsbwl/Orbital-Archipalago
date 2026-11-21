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
    #[msg("Unknown shipment")]
    UnknownShipment,
    #[msg("Shipment has already arrived")]
    ShipmentNotInFlight,
    #[msg("Shipment has not reached its arrival cycle")]
    ArrivedTooEarly,
    #[msg("Policy table is full")]
    PolicyFull,
    #[msg("Rate must be 0..=10000 basis points")]
    InvalidRate,
    #[msg("Loan is already repaid")]
    LoanSettled,
    #[msg("Repayment cycle is before the last accrual")]
    CycleBeforeAccrual,
    #[msg("Token supply does not match the minted minus burned record")]
    SupplyMismatch,
}
