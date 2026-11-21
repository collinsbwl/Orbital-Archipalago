mod common;
use common::*;

use anchor_lang::{prelude::Pubkey, solana_program::program_pack::Pack};
use anchor_spl::token::{spl_token, ID as TOKEN_PROGRAM};
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn creates_three_mints_controlled_only_by_the_program() {
    let (mut svm, admin) = setup();
    send(&mut svm, &admin, init_ix(&admin)).unwrap();

    for code in [*b"HLX", *b"KRN", *b"VSP"] {
        send(&mut svm, &admin, create_currency_ix(&admin, code)).unwrap();

        let acct = svm.get_account(&mint_pda(&code)).unwrap();
        assert_eq!(acct.owner, TOKEN_PROGRAM);
        let mint = spl_token::state::Mint::unpack(&acct.data).unwrap();
        assert_eq!(mint.supply, 0);
        assert_eq!(mint.decimals, 0);
        assert_eq!(Option::<Pubkey>::from(mint.mint_authority), Some(authority_pda()));
        assert_eq!(Option::<Pubkey>::from(mint.freeze_authority), None);
    }
}

#[test]
fn only_the_admin_can_create_a_currency() {
    let (mut svm, admin) = setup();
    send(&mut svm, &admin, init_ix(&admin)).unwrap();

    let intruder = Keypair::new();
    svm.airdrop(&intruder.pubkey(), 10_000_000_000).unwrap();
    assert!(send(&mut svm, &intruder, create_currency_ix(&intruder, *b"HLX")).is_err());
}

#[test]
fn rejects_bad_codes_and_duplicates() {
    let (mut svm, admin) = setup();
    send(&mut svm, &admin, init_ix(&admin)).unwrap();

    assert!(send(&mut svm, &admin, create_currency_ix(&admin, *b"hlx")).is_err());
    send(&mut svm, &admin, create_currency_ix(&admin, *b"HLX")).unwrap();
    assert!(send(&mut svm, &admin, create_currency_ix(&admin, *b"HLX")).is_err());
}
