import {
  type Connection, type Keypair, type PublicKey, SendTransactionError, type Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';

/** A failed transaction, with the program logs the error mapping reads ("Error Code: X"). */
export class ChainError extends Error {
  constructor(message: string, readonly logs: string[] = []) {
    super(message);
    this.name = 'ChainError';
  }
}

/**
 * The only thing SolanaLedger needs from a cluster. Two implementations: a real RPC connection
 * (solana-test-validator, devnet) and, in tests, an in-process LiteSVM that gives every test a fresh chain.
 */
export interface Chain {
  /** Account data, or null if the account does not exist. */
  getAccountData(pk: PublicKey): Promise<Buffer | null>;
  /** Signs with `signers` (first one pays) and sends; rejects with a ChainError if the transaction fails. */
  send(tx: Transaction, signers: Keypair[]): Promise<void>;
  rentExemption(space: number): Promise<number>;
}

export class ConnectionChain implements Chain {
  constructor(readonly connection: Connection) {}

  async getAccountData(pk: PublicKey): Promise<Buffer | null> {
    const info = await this.connection.getAccountInfo(pk, 'confirmed');
    return info ? info.data : null;
  }

  async send(tx: Transaction, signers: Keypair[]): Promise<void> {
    try {
      await sendAndConfirmTransaction(this.connection, tx, signers, { commitment: 'confirmed' });
    } catch (e) {
      const logs = e instanceof SendTransactionError ? ((await e.getLogs(this.connection).catch(() => [])) ?? []) : [];
      throw new ChainError(e instanceof Error ? e.message : String(e), logs);
    }
  }

  rentExemption(space: number): Promise<number> {
    return this.connection.getMinimumBalanceForRentExemption(space);
  }
}
