import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { LedgerError } from '@orbital/contracts';

// These constants mirror programs/orbital/src/constants.rs.
const enc = (s: string) => Buffer.from(s, 'ascii');
const CONFIG_SEED = enc('config');
const MINT_AUTHORITY_SEED = enc('mint_authority');
const MINT_SEED = enc('mint');
const PURSE_SEED = enc('purse');

/** Owners and goods are stored on-chain as sha256(id): fixed size, any id length. */
export function idKey(id: string): number[] {
  return Array.from(createHash('sha256').update(id, 'utf8').digest());
}

/** Currency codes are exactly 3 ASCII capitals on-chain (the contract schema allows 2-5). */
export function codeBytes(code: string): number[] {
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new LedgerError('invalid_state', `currency code "${code}" must be exactly 3 capitals on-chain`);
  }
  return Array.from(enc(code));
}

export class Addresses {
  constructor(readonly programId: PublicKey, readonly admin: PublicKey) {}

  config = () => PublicKey.findProgramAddressSync([CONFIG_SEED], this.programId)[0];
  mintAuthority = () => PublicKey.findProgramAddressSync([MINT_AUTHORITY_SEED], this.programId)[0];
  mint = (code: string) => PublicKey.findProgramAddressSync([MINT_SEED, Buffer.from(codeBytes(code))], this.programId)[0];
  purse = (owner: string, code: string) =>
    PublicKey.findProgramAddressSync([PURSE_SEED, Buffer.from(idKey(owner)), Buffer.from(codeBytes(code))], this.programId)[0];

  /** Planet ledgers are too big for a PDA (CPI-created accounts cap at 10 KB), so each one is a
   *  deterministic seeded account: createWithSeed(admin, planetId, program). Anyone can re-derive it. */
  ledger = (planet: string) => PublicKey.createWithSeed(this.admin, planet, this.programId);
}
