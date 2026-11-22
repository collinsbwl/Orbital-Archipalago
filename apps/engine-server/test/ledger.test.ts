import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { Keypair } from '@solana/web3.js';
import { adminKeypair, commitment, ledgerKind, makeLedger } from '../src/ledger.js';

describe('ledgerKind', () => {
  it('defaults to memory', () => {
    expect(ledgerKind({})).toBe('memory');
    expect(ledgerKind({ LEDGER: '' })).toBe('memory');
    expect(ledgerKind({ LEDGER: 'memory' })).toBe('memory');
  });
  it('accepts solana, case-insensitively', () => {
    expect(ledgerKind({ LEDGER: 'solana' })).toBe('solana');
    expect(ledgerKind({ LEDGER: ' Solana ' })).toBe('solana');
  });
  it('rejects anything else', () => {
    expect(() => ledgerKind({ LEDGER: 'postgres' })).toThrow(/LEDGER must be/);
  });
});

describe('adminKeypair', () => {
  it('generates a key when unset', () => {
    expect(adminKeypair({})).toBeInstanceOf(Keypair);
  });
  it('loads a JSON byte array', () => {
    const k = Keypair.generate();
    const loaded = adminKeypair({ SOLANA_ADMIN_KEYPAIR: JSON.stringify([...k.secretKey]) });
    expect(loaded.publicKey.equals(k.publicKey)).toBe(true);
  });
  it('rejects malformed input', () => {
    expect(() => adminKeypair({ SOLANA_ADMIN_KEYPAIR: 'not json' })).toThrow(/64 bytes/);
    expect(() => adminKeypair({ SOLANA_ADMIN_KEYPAIR: '[1,2,3]' })).toThrow(/64 bytes/);
  });
});

describe('commitment', () => {
  it('defaults to confirmed and accepts the three levels', () => {
    expect(commitment({})).toBe('confirmed');
    expect(commitment({ SOLANA_COMMITMENT: 'Processed' })).toBe('processed');
    expect(commitment({ SOLANA_COMMITMENT: 'finalized' })).toBe('finalized');
  });
  it('rejects anything else', () => {
    expect(() => commitment({ SOLANA_COMMITMENT: 'fast' })).toThrow(/SOLANA_COMMITMENT/);
  });
});

describe('makeLedger', () => {
  it('builds an InMemoryLedger by default', async () => {
    const l = await makeLedger(DEFAULT_WORLD, {}, () => {});
    expect(l).toBeInstanceOf(InMemoryLedger);
  });
});
