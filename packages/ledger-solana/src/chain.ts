import {
  type Commitment, type Connection, type Keypair, type PublicKey, SendTransactionError, type Transaction, sendAndConfirmTransaction,
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
  /** Several accounts in one round trip, in order (null where missing). Optional: callers fall back to getAccountData. */
  getMultipleAccountsData?(pks: PublicKey[]): Promise<(Buffer | null)[]>;
}

/** Many accounts through `getMultipleAccountsData` when the chain has it, else one read each. */
export async function readMany(chain: Chain, pks: PublicKey[]): Promise<(Buffer | null)[]> {
  if (!chain.getMultipleAccountsData) return Promise.all(pks.map((pk) => chain.getAccountData(pk)));
  const out: (Buffer | null)[] = [];
  for (let i = 0; i < pks.length; i += 100) out.push(...(await chain.getMultipleAccountsData(pks.slice(i, i + 100))));
  return out;
}

export class ConnectionChain implements Chain {
  /**
   * `commitment` is used for reads, preflight and confirmation alike, so a read always sees every write this chain
   * confirmed. `processed` is safe on a single local validator (nothing to fork away from) and several times faster.
   */
  constructor(readonly connection: Connection, readonly commitment: Commitment = 'confirmed') {}

  async getAccountData(pk: PublicKey): Promise<Buffer | null> {
    const info = await this.connection.getAccountInfo(pk, this.commitment);
    return info ? info.data : null;
  }

  async getMultipleAccountsData(pks: PublicKey[]): Promise<(Buffer | null)[]> {
    const infos = await this.connection.getMultipleAccountsInfo(pks, this.commitment);
    return infos.map((i) => (i ? i.data : null));
  }

  async send(tx: Transaction, signers: Keypair[]): Promise<void> {
    try {
      await sendAndConfirmTransaction(this.connection, tx, signers, { commitment: this.commitment, preflightCommitment: this.commitment });
    } catch (e) {
      const logs = e instanceof SendTransactionError ? ((await e.getLogs(this.connection).catch(() => [])) ?? []) : [];
      throw new ChainError(e instanceof Error ? e.message : String(e), logs);
    }
  }

  rentExemption(space: number): Promise<number> {
    return this.connection.getMinimumBalanceForRentExemption(space);
  }
}
