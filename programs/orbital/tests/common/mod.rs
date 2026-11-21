#![allow(dead_code)]
use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, program_pack::Pack, system_program},
        InstructionData, ToAccountMetas,
    },
    anchor_spl::token::{spl_token, ID as TOKEN_PROGRAM},
    litesvm::LiteSVM,
    orbital::Cargo,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[orbital::constants::CONFIG_SEED], &orbital::id()).0
}
pub fn authority_pda() -> Pubkey {
    Pubkey::find_program_address(&[orbital::constants::MINT_AUTHORITY_SEED], &orbital::id()).0
}
pub fn mint_pda(code: &[u8; 3]) -> Pubkey {
    Pubkey::find_program_address(&[orbital::constants::MINT_SEED, code], &orbital::id()).0
}
pub fn purse_pda(owner: &[u8; 32], code: &[u8; 3]) -> Pubkey {
    Pubkey::find_program_address(&[orbital::constants::PURSE_SEED, owner, code], &orbital::id()).0
}
/// Ids are hashed client-side: owner and good keys on-chain are sha256(id).
pub fn key(id: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(id.as_bytes()).into()
}

pub fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/orbital.so"));
    svm.add_program(orbital::id(), bytes).unwrap();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
    (svm, admin)
}

pub fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> Result<(), String> {
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
}

pub fn init_ix(admin: &Keypair) -> Instruction {
    Instruction::new_with_bytes(
        orbital::id(),
        &orbital::instruction::Initialize {}.data(),
        orbital::accounts::Initialize { admin: admin.pubkey(), config: config_pda(), system_program: system_program::ID }
            .to_account_metas(None),
    )
}

pub fn create_currency_ix(admin: &Keypair, code: [u8; 3]) -> Instruction {
    Instruction::new_with_bytes(
        orbital::id(),
        &orbital::instruction::CreateCurrency { code }.data(),
        orbital::accounts::CreateCurrency {
            admin: admin.pubkey(),
            config: config_pda(),
            mint_authority: authority_pda(),
            mint: mint_pda(&code),
            token_program: TOKEN_PROGRAM,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn open_purse_ix(admin: &Keypair, owner: [u8; 32], code: [u8; 3]) -> Instruction {
    Instruction::new_with_bytes(
        orbital::id(),
        &orbital::instruction::OpenPurse { owner, code }.data(),
        orbital::accounts::OpenPurse {
            admin: admin.pubkey(),
            config: config_pda(),
            mint: mint_pda(&code),
            purse: purse_pda(&owner, &code),
            token_program: TOKEN_PROGRAM,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn issue_ix(admin: &Keypair, owner: [u8; 32], code: [u8; 3], amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        orbital::id(),
        &orbital::instruction::Issue { owner, code, amount }.data(),
        orbital::accounts::Issue {
            admin: admin.pubkey(),
            config: config_pda(),
            mint_authority: authority_pda(),
            mint: mint_pda(&code),
            purse: purse_pda(&owner, &code),
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None),
    )
}

pub fn transfer_ix(admin: &Keypair, from: [u8; 32], to: [u8; 32], code: [u8; 3], amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        orbital::id(),
        &orbital::instruction::Transfer { from_owner: from, to_owner: to, code, amount }.data(),
        orbital::accounts::TransferFunds {
            admin: admin.pubkey(),
            config: config_pda(),
            from_purse: purse_pda(&from, &code),
            to_purse: purse_pda(&to, &code),
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None),
    )
}

/// Allocates a zeroed, program-owned ledger account at full size (what the client does on a real cluster).
pub fn alloc_ledger(svm: &mut LiteSVM) -> Pubkey {
    let size = 8 + std::mem::size_of::<orbital::PlanetLedger>();
    let addr = Pubkey::new_unique();
    svm.set_account(
        addr,
        Account { lamports: svm.minimum_balance_for_rent_exemption(size), data: vec![0; size], owner: orbital::id(), executable: false, rent_epoch: 0 },
    )
    .unwrap();
    addr
}

pub fn create_planet_ix(admin: &Keypair, ledger: Pubkey, planet: &str, code: [u8; 3]) -> Instruction {
    Instruction::new_with_bytes(
        orbital::id(),
        &orbital::instruction::CreatePlanet { planet: key(planet), currency: code }.data(),
        orbital::accounts::CreatePlanet { admin: admin.pubkey(), config: config_pda(), ledger }.to_account_metas(None),
    )
}

fn edit_accounts(admin: &Keypair, ledger: Pubkey) -> Vec<anchor_lang::prelude::AccountMeta> {
    orbital::accounts::EditInventory { admin: admin.pubkey(), config: config_pda(), ledger }.to_account_metas(None)
}

pub fn cargo(good: &str, qty: u64) -> Cargo {
    Cargo { good: key(good), qty }
}

pub fn grant_ix(admin: &Keypair, ledger: Pubkey, owner: &str, c: Vec<Cargo>) -> Instruction {
    Instruction::new_with_bytes(orbital::id(), &orbital::instruction::Grant { owner: key(owner), cargo: c }.data(), edit_accounts(admin, ledger))
}
pub fn produce_ix(admin: &Keypair, ledger: Pubkey, owner: &str, inputs: Vec<Cargo>, outputs: Vec<Cargo>) -> Instruction {
    Instruction::new_with_bytes(orbital::id(), &orbital::instruction::Produce { owner: key(owner), inputs, outputs }.data(), edit_accounts(admin, ledger))
}
pub fn consume_ix(admin: &Keypair, ledger: Pubkey, owner: &str, c: Vec<Cargo>) -> Instruction {
    Instruction::new_with_bytes(orbital::id(), &orbital::instruction::Consume { owner: key(owner), cargo: c }.data(), edit_accounts(admin, ledger))
}

pub fn balance(svm: &LiteSVM, owner: &str, code: [u8; 3]) -> u64 {
    let acct = svm.get_account(&purse_pda(&key(owner), &code)).unwrap();
    spl_token::state::Account::unpack(&acct.data).unwrap().amount
}

pub fn supply(svm: &LiteSVM, code: [u8; 3]) -> u64 {
    spl_token::state::Mint::unpack(&svm.get_account(&mint_pda(&code)).unwrap().data).unwrap().supply
}

/// Reads an inventory straight from the zero-copy account bytes.
/// Layout after the 8-byte discriminator: planet 32, currency 3, pad 5, len u64, then 72-byte slots.
pub fn inventory(svm: &LiteSVM, ledger: Pubkey, owner: &str, good: &str) -> u64 {
    let data = svm.get_account(&ledger).unwrap().data;
    let len = u64::from_le_bytes(data[48..56].try_into().unwrap()) as usize;
    let (o, g) = (key(owner), key(good));
    for i in 0..len {
        let s = &data[56 + i * 72..56 + (i + 1) * 72];
        if s[..32] == o && s[32..64] == g {
            return u64::from_le_bytes(s[64..72].try_into().unwrap());
        }
    }
    0
}
