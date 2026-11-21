use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, program_pack::Pack, system_program},
        InstructionData, ToAccountMetas,
    },
    anchor_spl::token::{spl_token, ID as TOKEN_PROGRAM},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[orbital::constants::CONFIG_SEED], &orbital::id()).0
}
fn authority_pda() -> Pubkey {
    Pubkey::find_program_address(&[orbital::constants::MINT_AUTHORITY_SEED], &orbital::id()).0
}
fn mint_pda(code: &[u8; 3]) -> Pubkey {
    Pubkey::find_program_address(&[orbital::constants::MINT_SEED, code], &orbital::id()).0
}

fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/orbital.so"));
    svm.add_program(orbital::id(), bytes).unwrap();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
    (svm, admin)
}

fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> Result<(), String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
}

fn init_ix(admin: &Keypair) -> Instruction {
    Instruction::new_with_bytes(
        orbital::id(),
        &orbital::instruction::Initialize {}.data(),
        orbital::accounts::Initialize {
            admin: admin.pubkey(),
            config: config_pda(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn create_ix(admin: &Keypair, code: [u8; 3]) -> Instruction {
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

#[test]
fn creates_three_mints_controlled_only_by_the_program() {
    let (mut svm, admin) = setup();
    send(&mut svm, &admin, init_ix(&admin)).unwrap();

    for code in [*b"HLX", *b"KRN", *b"VSP"] {
        send(&mut svm, &admin, create_ix(&admin, code)).unwrap();

        let acct = svm.get_account(&mint_pda(&code)).unwrap();
        assert_eq!(acct.owner, TOKEN_PROGRAM);
        let mint = anchor_spl::token::spl_token::state::Mint::unpack(&acct.data).unwrap();
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
    assert!(send(&mut svm, &intruder, create_ix(&intruder, *b"HLX")).is_err());
}

#[test]
fn rejects_bad_codes_and_duplicates() {
    let (mut svm, admin) = setup();
    send(&mut svm, &admin, init_ix(&admin)).unwrap();

    assert!(send(&mut svm, &admin, create_ix(&admin, *b"hlx")).is_err());
    send(&mut svm, &admin, create_ix(&admin, *b"HLX")).unwrap();
    svm.expire_blockhash();
    assert!(send(&mut svm, &admin, create_ix(&admin, *b"HLX")).is_err());
}
