import type { Ledger } from '@orbital/contracts';

/** Optional ledger capability: a deep, independent copy of all state. `InMemoryLedger` has it; Tiger-backed ledgers may not. */
export interface ForkableLedger extends Ledger {
  clone(): Ledger | Promise<Ledger>;
}

export const isForkable = (l: Ledger): l is ForkableLedger => typeof (l as Partial<ForkableLedger>).clone === 'function';
