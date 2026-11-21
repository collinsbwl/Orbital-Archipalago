import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { LedgerError } from '@orbital/contracts';

// These constants mirror programs/orbital/src/constants.rs.
const enc = (s: string) => Buffer.from(s, 'ascii');
const CONFIG_SEED = enc('config');
const MINT_AUTHORITY_SEED = enc('mint_authority');
const MINT_SEED = enc('mint');
const PURSE_SEED = enc('purse');
const VAULT_SEED = enc('vault');
const BOOK_SEED = enc('book');
const FX_BOOK_SEED = enc('fxbook');
const POLICY_SEED = enc('policy');
const SHIPMENT_SEED = enc('shipment');

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
  purse = (owner: string, code: string) => this.purseOfKey(Buffer.from(idKey(owner)), code);
  /** Same as purse(), for an owner known only by its on-chain key (sha256 of the id), e.g. read from an order book. */
  purseOfKey = (ownerKey: Buffer, code: string) =>
    PublicKey.findProgramAddressSync([PURSE_SEED, ownerKey, Buffer.from(codeBytes(code))], this.programId)[0];
  /** Escrow vault holding every resting buy order's currency. */
  vault = (code: string) => PublicKey.findProgramAddressSync([VAULT_SEED, Buffer.from(codeBytes(code))], this.programId)[0];
  /** FX book for an unordered currency pair; the codes must be in alphabetical order (a < b). */
  fxBook = (a: string, b: string) =>
    PublicKey.findProgramAddressSync([FX_BOOK_SEED, Buffer.from(codeBytes(a)), Buffer.from(codeBytes(b))], this.programId)[0];
  /** A planet's policy account: tariffs, quotas, embargoes, policy rate and last clearing prices. */
  policy = (planet: string) => PublicKey.findProgramAddressSync([POLICY_SEED, Buffer.from(idKey(planet))], this.programId)[0];
  /** Shipment "s<n>" lives at the PDA ["shipment", n as u64 little-endian]. */
  shipment = (n: number) => {
    const le = Buffer.alloc(8);
    le.writeBigUInt64LE(BigInt(n));
    return PublicKey.findProgramAddressSync([SHIPMENT_SEED, le], this.programId)[0];
  };
  book = (planet: string, good: string) =>
    PublicKey.findProgramAddressSync([BOOK_SEED, Buffer.from(idKey(planet)), Buffer.from(idKey(good))], this.programId)[0];

  /** Planet ledgers are too big for a PDA (CPI-created accounts cap at 10 KB), so each one is a
   *  deterministic seeded account: createWithSeed(admin, planetId, program). Anyone can re-derive it. */
  ledger = (planet: string) => PublicKey.createWithSeed(this.admin, planet, this.programId);
}
