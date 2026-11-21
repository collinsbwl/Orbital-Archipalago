mod common;
use common::*;

use anchor_lang::{prelude::Pubkey, solana_program::program_pack::Pack};
use anchor_spl::token::spl_token;
use solana_keypair::Keypair;
use solana_signer::Signer;

const HLX: [u8; 3] = *b"HLX";

fn world() -> (litesvm::LiteSVM, Keypair) {
    let (mut svm, admin) = setup();
    send(&mut svm, &admin, init_ix(&admin)).unwrap();
    send(&mut svm, &admin, create_currency_ix(&admin, HLX)).unwrap();
    (svm, admin)
}

#[test]
fn purses_are_self_owned_and_money_moves_with_conserved_supply() {
    let (mut svm, admin) = world();
    for who in ["alice", "bob"] {
        send(&mut svm, &admin, open_purse_ix(&admin, key(who), HLX)).unwrap();
    }
    // The purse's token-owner is the purse itself: no wallet key can spend it.
    let purse = purse_pda(&key("alice"), &HLX);
    let acct = spl_token::state::Account::unpack(&svm.get_account(&purse).unwrap().data).unwrap();
    assert_eq!(acct.owner, purse);

    send(&mut svm, &admin, issue_ix(&admin, key("alice"), HLX, 1_000)).unwrap();
    send(&mut svm, &admin, transfer_ix(&admin, key("alice"), key("bob"), HLX, 400)).unwrap();

    assert_eq!(balance(&svm, "alice", HLX), 600);
    assert_eq!(balance(&svm, "bob", HLX), 400);
    assert_eq!(supply(&svm, HLX), 1_000);
}

#[test]
fn transfer_rejects_overdraft_zero_and_non_admin() {
    let (mut svm, admin) = world();
    for who in ["alice", "bob"] {
        send(&mut svm, &admin, open_purse_ix(&admin, key(who), HLX)).unwrap();
    }
    send(&mut svm, &admin, issue_ix(&admin, key("alice"), HLX, 100)).unwrap();

    assert!(send(&mut svm, &admin, transfer_ix(&admin, key("alice"), key("bob"), HLX, 101)).is_err());
    assert!(send(&mut svm, &admin, transfer_ix(&admin, key("alice"), key("bob"), HLX, 0)).is_err());

    let intruder = Keypair::new();
    svm.airdrop(&intruder.pubkey(), 1_000_000_000).unwrap();
    assert!(send(&mut svm, &intruder, transfer_ix(&intruder, key("alice"), key("bob"), HLX, 10)).is_err());
    assert!(send(&mut svm, &intruder, issue_ix(&intruder, key("alice"), HLX, 10)).is_err());

    assert_eq!(balance(&svm, "alice", HLX), 100);
    assert_eq!(supply(&svm, HLX), 100);
}

#[test]
fn inventories_grant_produce_consume() {
    let (mut svm, admin) = world();
    let ledger = alloc_ledger(&mut svm);
    send(&mut svm, &admin, create_planet_ix(&admin, ledger, "helion", HLX)).unwrap();

    send(&mut svm, &admin, grant_ix(&admin, ledger, "alice", vec![cargo("iron", 10)])).unwrap();
    assert_eq!(inventory(&svm, ledger, "alice", "iron"), 10);
    assert_eq!(inventory(&svm, ledger, "bob", "iron"), 0);

    send(&mut svm, &admin, produce_ix(&admin, ledger, "alice", vec![cargo("iron", 4)], vec![cargo("steel", 1)])).unwrap();
    assert_eq!(inventory(&svm, ledger, "alice", "iron"), 6);
    assert_eq!(inventory(&svm, ledger, "alice", "steel"), 1);

    send(&mut svm, &admin, consume_ix(&admin, ledger, "alice", vec![cargo("iron", 6)])).unwrap();
    assert_eq!(inventory(&svm, ledger, "alice", "iron"), 0);
}

#[test]
fn inventory_failures_are_atomic() {
    let (mut svm, admin) = world();
    let ledger = alloc_ledger(&mut svm);
    send(&mut svm, &admin, create_planet_ix(&admin, ledger, "helion", HLX)).unwrap();
    send(&mut svm, &admin, grant_ix(&admin, ledger, "alice", vec![cargo("iron", 5)])).unwrap();

    // Second input is missing, so the whole produce reverts (iron stays 5, no steel).
    let r = send(&mut svm, &admin, produce_ix(&admin, ledger, "alice", vec![cargo("iron", 2), cargo("coal", 1)], vec![cargo("steel", 1)]));
    assert!(r.is_err());
    assert_eq!(inventory(&svm, ledger, "alice", "iron"), 5);
    assert_eq!(inventory(&svm, ledger, "alice", "steel"), 0);

    assert!(send(&mut svm, &admin, consume_ix(&admin, ledger, "alice", vec![cargo("iron", 6)])).is_err());
    assert!(send(&mut svm, &admin, consume_ix(&admin, ledger, "alice", vec![cargo("iron", 0)])).is_err());

    let intruder = Keypair::new();
    svm.airdrop(&intruder.pubkey(), 1_000_000_000).unwrap();
    assert!(send(&mut svm, &intruder, grant_ix(&intruder, ledger, "alice", vec![cargo("iron", 1)])).is_err());
}

#[test]
fn ledger_cannot_be_created_twice_or_on_a_non_zero_account() {
    let (mut svm, admin) = world();
    let ledger = alloc_ledger(&mut svm);
    send(&mut svm, &admin, create_planet_ix(&admin, ledger, "helion", HLX)).unwrap();
    assert!(send(&mut svm, &admin, create_planet_ix(&admin, ledger, "other", HLX)).is_err());
    let _: Pubkey = ledger;
}
