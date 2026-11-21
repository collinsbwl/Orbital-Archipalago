import { describe, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { LiteSVM } from 'litesvm';
import { runLedgerContractSuite } from '@orbital/ledger-memory/contract';
import { bootstrapLedger } from '../src/index.js';
import { IDL } from '../src/idl/orbital.js';
import { hasProgram, PROGRAM_SO } from './env.js';
import { LiteSvmChain } from './litesvm-chain.js';

if (hasProgram) {
  // Track A's contract suite, unchanged. The suite asks for a fresh ledger per test, so each one gets its own LiteSVM chain.
  runLedgerContractSuite('SolanaLedger', async (world) => {
    const svm = new LiteSVM();
    svm.addProgramFromFile(new PublicKey(IDL.address), PROGRAM_SO);
    const admin = Keypair.generate();
    svm.airdrop(admin.publicKey, 1_000_000_000_000n);
    return bootstrapLedger({ chain: new LiteSvmChain(svm), admin, world });
  });
} else {
  // Machines without the Solana toolchain (e.g. CI) skip, like the Tiger Data tests do without a database.
  describe.skip('SolanaLedger: ledger contract (orbital.so not built; run `anchor build`)', () => {
    it('is skipped', () => {});
  });
}
