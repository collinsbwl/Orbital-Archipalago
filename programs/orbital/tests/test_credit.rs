mod common;
use common::*;

use orbital::PolicyOp;

const HLX_NAME: &str = "HLX";

/// A planet "helion" with currency HLX, its policy at `rate_bp`, and alice opened with 1,000 HLX.
fn world(rate_bp: u64) -> (litesvm::LiteSVM, solana_keypair::Keypair, anchor_lang::prelude::Pubkey) {
    let (mut svm, admin) = setup();
    send(&mut svm, &admin, init_ix(&admin)).unwrap();
    send(&mut svm, &admin, create_currency_ix(&admin, code(HLX_NAME))).unwrap();
    let ledger = alloc_ledger(&mut svm);
    send(&mut svm, &admin, create_planet_ix(&admin, ledger, "helion", code(HLX_NAME))).unwrap();
    send(&mut svm, &admin, create_policy_ix(&admin, "helion")).unwrap();
    send(&mut svm, &admin, apply_policy_ix(&admin, "helion", PolicyOp::SetPolicyRate { rate_bp })).unwrap();
    send(&mut svm, &admin, open_account_ix(&admin, ledger, "alice", &[code(HLX_NAME)], &[1_000], vec![])).unwrap();
    (svm, admin, ledger)
}

#[test]
fn borrow_mints_and_repay_burns_with_the_supply_record_in_step() {
    let (mut svm, admin, ledger) = world(100); // 1% per cycle
    let hlx = code(HLX_NAME);
    assert_eq!(minted_burned(&svm, hlx), (1_000, 0));

    send(&mut svm, &admin, borrow_ix(&admin, ledger, "alice", "helion", hlx, 10_000, 10, 0, 1)).unwrap();
    assert_eq!(balance(&svm, "alice", hlx), 11_000);
    assert_eq!(supply(&svm, hlx), 11_000);
    assert_eq!(minted_burned(&svm, hlx), (11_000, 0));
    assert_eq!(loan(&svm, 1), (10_000, 10_000, 100, 0, 10, 0));

    // cycle 5: +500 interest, pay 500 -> still 10_000 outstanding; 500 burned
    send(&mut svm, &admin, repay_ix(&admin, "alice", hlx, 1, 500, 5)).unwrap();
    assert_eq!(loan(&svm, 1).1, 10_000);
    // cycle 7: +200 interest, pay 100 -> 10_100
    send(&mut svm, &admin, repay_ix(&admin, "alice", hlx, 1, 100, 7)).unwrap();
    assert_eq!(loan(&svm, 1).1, 10_100);

    assert_eq!(balance(&svm, "alice", hlx), 11_000 - 600);
    assert_eq!(supply(&svm, hlx), 11_000 - 600);
    assert_eq!(minted_burned(&svm, hlx), (11_000, 600)); // minted - burned == supply, always
}

#[test]
fn repay_rules_overpayment_settled_early_and_broke() {
    let (mut svm, admin, ledger) = world(0);
    let hlx = code(HLX_NAME);
    send(&mut svm, &admin, borrow_ix(&admin, ledger, "alice", "helion", hlx, 1_000, 10, 5, 1)).unwrap();

    assert!(send(&mut svm, &admin, repay_ix(&admin, "alice", hlx, 1, 0, 6)).is_err()); // zero amount
    assert!(send(&mut svm, &admin, repay_ix(&admin, "alice", hlx, 1, 1, 4)).is_err()); // before the last accrual

    // an overpayment burns only what is owed, and a settled loan cannot be repaid again
    send(&mut svm, &admin, repay_ix(&admin, "alice", hlx, 1, 5_000, 6)).unwrap();
    assert_eq!(loan(&svm, 1).1, 0);
    assert_eq!(balance(&svm, "alice", hlx), 1_000); // 2_000 - 1_000
    assert!(send(&mut svm, &admin, repay_ix(&admin, "alice", hlx, 1, 1, 7)).is_err());

    // a borrower without the funds cannot repay, and nothing changes
    send(&mut svm, &admin, borrow_ix(&admin, ledger, "alice", "helion", hlx, 500, 10, 8, 2)).unwrap();
    send(&mut svm, &admin, open_account_ix(&admin, ledger, "bob", &[hlx], &[0], vec![])).unwrap();
    send(&mut svm, &admin, transfer_ix(&admin, key("alice"), key("bob"), hlx, 1_500)).unwrap();
    let before = (loan(&svm, 2), minted_burned(&svm, hlx), supply(&svm, hlx));
    assert!(send(&mut svm, &admin, repay_ix(&admin, "alice", hlx, 2, 100, 9)).is_err());
    assert_eq!((loan(&svm, 2), minted_burned(&svm, hlx), supply(&svm, hlx)), before);
}
