use anchor_lang::prelude::*;

/// Seed of the singleton Config account.
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

/// Seed of the PDA that is the mint authority of every currency.
/// It holds no data and no key exists for it: only this program can sign as it.
#[constant]
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";

/// Seed prefix of each currency mint: ["mint", currency_code].
#[constant]
pub const MINT_SEED: &[u8] = b"mint";

/// Currency codes are 3 ASCII capitals, e.g. "HLX".
pub const CURRENCY_CODE_LEN: usize = 3;

/// All amounts in the contracts are integer minor units, so mints have 0 decimals.
pub const CURRENCY_DECIMALS: u8 = 0;

/// Seed prefix of each purse (an SPL token account): ["purse", owner, currency_code].
#[constant]
pub const PURSE_SEED: &[u8] = b"purse";

/// Inventory entries a planet ledger can hold. One entry is one (owner, good) pair.
/// Lookup is a linear scan, so this stays modest; see PlanetLedger.
pub const MAX_SLOTS: usize = 1024;

/// Max cargo lines in one produce/consume/grant instruction.
pub const MAX_CARGO_LINES: usize = 8;

/// Seed prefix of each escrow vault (a self-owned token account, one per currency): ["vault", currency_code].
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Seed prefix of each order book: ["book", sha256(planet), sha256(good)].
#[constant]
pub const BOOK_SEED: &[u8] = b"book";

/// Resting orders one book can hold. The auction scans the book, so this stays modest.
pub const MAX_ORDERS: usize = 128;

pub const SIDE_BUY: u8 = 0;
pub const SIDE_SELL: u8 = 1;

/// Seed prefix of each FX order book, one per unordered currency pair: ["fxbook", first_code, second_code]
/// with the codes in alphabetical order.
#[constant]
pub const FX_BOOK_SEED: &[u8] = b"fxbook";
