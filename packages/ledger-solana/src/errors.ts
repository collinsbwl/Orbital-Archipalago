import { LedgerError, type LedgerErrorCode } from '@orbital/contracts';
import { ChainError } from './chain.js';

/** Program error name (programs/orbital/src/error.rs) -> contract error code. */
const BY_PROGRAM_ERROR: Record<string, LedgerErrorCode> = {
  InsufficientFunds: 'insufficient_funds',
  InsufficientInventory: 'insufficient_inventory',
  InvalidAmount: 'invalid_amount',
  LedgerFull: 'invalid_state',
  TooManyCargoLines: 'invalid_state',
  Overflow: 'invalid_amount',
  Unauthorized: 'invalid_state',
  InvalidCurrencyCode: 'invalid_state',
};

/** Turns a failed transaction into a LedgerError by reading the program's "Error Code: X" log line. */
export function toLedgerError(e: unknown): Error {
  if (e instanceof LedgerError) return e;
  const logs = e instanceof ChainError ? e.logs : [];
  const text = [e instanceof Error ? e.message : String(e), ...logs].join('\n');
  const m = /Error Code: (\w+)/.exec(text);
  const code = m?.[1] && BY_PROGRAM_ERROR[m[1]];
  if (code) return new LedgerError(code, `${m![1]}: ${e instanceof Error ? e.message : String(e)}`);
  return e instanceof Error ? e : new Error(text);
}
