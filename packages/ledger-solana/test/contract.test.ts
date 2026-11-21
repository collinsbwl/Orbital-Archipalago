import { resolve } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LiteSVM } from 'litesvm';
import { runLedgerContractSuite } from '@orbital/ledger-memory/contract';
import { bootstrapLedger } from '../src/index.js';
import { IDL } from '../src/idl/orbital.js';
import { LiteSvmChain } from './litesvm-chain.js';

const PROGRAM_SO = resolve(__dirname, '../../../target/deploy/orbital.so');

// Track A's contract suite, unchanged. The suite asks for a fresh ledger per test, so each one gets its own LiteSVM chain.
runLedgerContractSuite('SolanaLedger', async (world) => {
  const svm = new LiteSVM();
  svm.addProgramFromFile(new PublicKey(IDL.address), PROGRAM_SO);
  const admin = Keypair.generate();
  svm.airdrop(admin.publicKey, 1_000_000_000_000n);
  return bootstrapLedger({ chain: new LiteSvmChain(svm), admin, world });
});
