import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import { type Keypair, type PublicKey, type Transaction } from '@solana/web3.js';
import { ChainError, type Chain } from '../src/index.js';

/** An in-process Solana runtime: every test gets a brand-new chain in milliseconds, no validator needed. */
export class LiteSvmChain implements Chain {
  constructor(readonly svm: LiteSVM) {}

  async getAccountData(pk: PublicKey): Promise<Buffer | null> {
    const a = this.svm.getAccount(pk);
    return a ? Buffer.from(a.data) : null;
  }

  async send(tx: Transaction, signers: Keypair[]): Promise<void> {
    this.svm.expireBlockhash(); // identical transactions would otherwise be rejected as already processed
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = signers[0]!.publicKey;
    tx.sign(...signers);
    const r = this.svm.sendTransaction(tx);
    if (r instanceof FailedTransactionMetadata) throw new ChainError(r.toString(), r.meta().logs());
  }

  async rentExemption(space: number): Promise<number> {
    return Number(this.svm.minimumBalanceForRentExemption(BigInt(space)));
  }
}
