import { AnchorProvider, BN, Program, Wallet } from '@anchor-lang/core';
import {
  ComputeBudgetProgram, type Connection, type Keypair, PublicKey, SendTransactionError, Transaction,
  type TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  LedgerError, type BorrowRequest, type Cargo, type CurrencyId, type DepartRequest, type GoodId, type Ledger, type MinorUnits,
  type OpenAccountRequest, type OwnerId, type PlanetId, type PolicyInstruction, type RepayRequest, type WorldConfig,
} from '@orbital/contracts';
import { IDL } from './idl/orbital.js';
import type { Orbital } from './idl/orbital-types.js';
import { Addresses, codeBytes, idKey } from './keys.js';
import { toLedgerError } from './errors.js';

export interface SolanaLedgerOptions {
  connection: Connection;
  /** The sim engine's key: the only signer the program accepts. */
  admin: Keypair;
  /** Planets (and their currencies) this ledger knows about. */
  world: Pick<WorldConfig, 'planets'>;
  programId?: PublicKey;
}

// Layout of a PlanetLedger account (programs/orbital/src/state.rs), after the 8-byte discriminator:
// planet[32] currency[3] pad[5] len:u64, then `len` slots of owner[32] good[32] qty:u64.
const LEDGER_HEADER = 8 + 32 + 3 + 5;
const SLOT_SIZE = 72;
/** Inventory instructions scan the ledger linearly, which needs more than the default 200k compute units. */
const INVENTORY_COMPUTE_UNITS = 600_000;
/** Instructions per transaction: keeps openAccount under the 1232-byte transaction limit. */
const MAX_IXS_PER_TX = 3;

const notYet = (what: string): never => {
  throw new LedgerError('invalid_state', `SolanaLedger.${what} is not implemented yet (C2-C4)`);
};

export class SolanaLedger implements Ledger {
  readonly addr: Addresses;
  /** The typed Anchor client. Public so bootstrap can reuse it. */
  readonly program: Program<Orbital>;
  private readonly connection: Connection;
  private readonly admin: Keypair;
  private readonly currencies: CurrencyId[];

  constructor(private readonly opts: SolanaLedgerOptions) {
    this.connection = opts.connection;
    this.admin = opts.admin;
    const provider = new AnchorProvider(opts.connection, new Wallet(opts.admin), { commitment: 'confirmed' });
    this.program = new Program<Orbital>(IDL as unknown as Orbital, provider);
    this.addr = new Addresses(opts.programId ?? this.program.programId, opts.admin.publicKey);
    this.currencies = opts.world.planets.map((p) => p.currency);
  }

  // ---- C1: accounts, purses, inventories -------------------------------------------------------

  async openAccount(req: OpenAccountRequest): Promise<void> {
    const purse = req.purse ?? {};
    const inventory = req.inventory ?? {};
    for (const c of Object.keys(purse)) this.assertCurrency(c);
    for (const [c, amt] of Object.entries(purse)) this.assertAmount(amt, `purse ${c}`, true);
    for (const [g, qty] of Object.entries(inventory)) this.assertAmount(qty, `inventory ${g}`, true);
    if (await this.accountExists(this.addr.purse(req.owner, this.currencies[0]!))) {
      throw new LedgerError('invalid_state', `account ${req.owner} already exists`);
    }

    // Every owner gets a purse in every currency, so it can receive any of them later.
    const ixs: TransactionInstruction[] = [];
    for (const code of this.currencies) ixs.push(await this.openPurseIx(req.owner, code));
    for (const [code, amt] of Object.entries(purse)) if (amt > 0) ixs.push(await this.issueIx(req.owner, code, amt));
    await this.sendAll(ixs);

    const cargo = Object.entries(inventory).filter(([, q]) => q > 0).map(([good, qty]) => ({ good, qty }));
    if (cargo.length) await this.send([await this.grantIx(req.planet, req.owner, cargo)], INVENTORY_COMPUTE_UNITS);
  }

  async getPurse(owner: OwnerId, currency: CurrencyId): Promise<MinorUnits> {
    this.assertCurrency(currency);
    const info = await this.connection.getAccountInfo(this.addr.purse(owner, currency), 'confirmed');
    if (!info) throw new LedgerError('unknown_account', `no purse for ${owner} in ${currency}`);
    // SPL token account: mint[32] owner[32] amount:u64 ...
    return toSafeNumber(info.data.readBigUInt64LE(64));
  }

  async getInventory(owner: OwnerId, planet: PlanetId, good: GoodId): Promise<number> {
    const info = await this.connection.getAccountInfo(await this.addr.ledger(planet), 'confirmed');
    if (!info) throw new LedgerError('unknown_account', `unknown planet ${planet}`);
    const { data } = info;
    const len = Number(data.readBigUInt64LE(LEDGER_HEADER));
    const o = Buffer.from(idKey(owner));
    const g = Buffer.from(idKey(good));
    for (let i = 0; i < len; i++) {
      const at = LEDGER_HEADER + 8 + i * SLOT_SIZE;
      if (data.subarray(at, at + 32).equals(o) && data.subarray(at + 32, at + 64).equals(g)) {
        return toSafeNumber(data.readBigUInt64LE(at + 64));
      }
    }
    return 0;
  }

  async transfer(req: { from: OwnerId; to: OwnerId; currency: CurrencyId; amount: MinorUnits }): Promise<void> {
    this.assertCurrency(req.currency);
    this.assertAmount(req.amount, 'transfer amount', false);
    for (const who of [req.from, req.to]) {
      if (!(await this.accountExists(this.addr.purse(who, req.currency)))) {
        throw new LedgerError('unknown_account', `no purse for ${who} in ${req.currency}`);
      }
    }
    const ix = await this.program.methods
      .transfer(idKey(req.from), idKey(req.to), codeBytes(req.currency), new BN(req.amount))
      .accountsPartial({
        admin: this.admin.publicKey,
        config: this.addr.config(),
        fromPurse: this.addr.purse(req.from, req.currency),
        toPurse: this.addr.purse(req.to, req.currency),
      })
      .instruction();
    await this.send([ix]);
  }

  async produce(req: { owner: OwnerId; planet: PlanetId; inputs: Cargo[]; outputs: Cargo[] }): Promise<void> {
    for (const c of [...req.inputs, ...req.outputs]) this.assertAmount(c.qty, `cargo ${c.good}`, false);
    const ix = await this.program.methods
      .produce(idKey(req.owner), toCargo(req.inputs), toCargo(req.outputs))
      .accountsPartial(await this.editAccounts(req.planet))
      .instruction();
    await this.send([ix], INVENTORY_COMPUTE_UNITS);
  }

  async consume(req: { owner: OwnerId; planet: PlanetId; cargo: Cargo[] }): Promise<void> {
    for (const c of req.cargo) this.assertAmount(c.qty, `cargo ${c.good}`, false);
    const ix = await this.program.methods
      .consume(idKey(req.owner), toCargo(req.cargo))
      .accountsPartial(await this.editAccounts(req.planet))
      .instruction();
    await this.send([ix], INVENTORY_COMPUTE_UNITS);
  }

  // ---- Later milestones ------------------------------------------------------------------------

  placeOrders: Ledger['placeOrders'] = async () => notYet('placeOrders'); // C2
  cancelOrder: Ledger['cancelOrder'] = async () => notYet('cancelOrder'); // C2
  openOrders: Ledger['openOrders'] = async () => notYet('openOrders'); // C2
  clearLocalAuction: Ledger['clearLocalAuction'] = async () => notYet('clearLocalAuction'); // C2
  placeFxOrders: Ledger['placeFxOrders'] = async () => notYet('placeFxOrders'); // C2
  clearFxAuction: Ledger['clearFxAuction'] = async () => notYet('clearFxAuction'); // C2
  depart = async (_req: DepartRequest) => notYet('depart'); // C3
  arrive: Ledger['arrive'] = async () => notYet('arrive'); // C3
  borrow = async (_req: BorrowRequest) => notYet('borrow'); // C4
  repay = async (_req: RepayRequest) => notYet('repay'); // C4
  applyPolicy = async (_i: PolicyInstruction) => notYet('applyPolicy'); // C3/C4
  getPolicy: Ledger['getPolicy'] = async () => notYet('getPolicy'); // C3/C4
  checkInvariants: Ledger['checkInvariants'] = async () => notYet('checkInvariants'); // C4

  // ---- Instruction builders (also used by bootstrap) -------------------------------------------

  async openPurseIx(owner: OwnerId, code: CurrencyId): Promise<TransactionInstruction> {
    return this.program.methods
      .openPurse(idKey(owner), codeBytes(code))
      .accountsPartial({
        admin: this.admin.publicKey,
        config: this.addr.config(),
        mint: this.addr.mint(code),
        purse: this.addr.purse(owner, code),
      })
      .instruction();
  }

  async issueIx(owner: OwnerId, code: CurrencyId, amount: number): Promise<TransactionInstruction> {
    return this.program.methods
      .issue(idKey(owner), codeBytes(code), new BN(amount))
      .accountsPartial({
        admin: this.admin.publicKey,
        config: this.addr.config(),
        mintAuthority: this.addr.mintAuthority(),
        mint: this.addr.mint(code),
        purse: this.addr.purse(owner, code),
      })
      .instruction();
  }

  async grantIx(planet: PlanetId, owner: OwnerId, cargo: Cargo[]): Promise<TransactionInstruction> {
    return this.program.methods
      .grant(idKey(owner), toCargo(cargo))
      .accountsPartial(await this.editAccounts(planet))
      .instruction();
  }

  // ---- Internals -------------------------------------------------------------------------------

  private async editAccounts(planet: PlanetId) {
    return { admin: this.admin.publicKey, config: this.addr.config(), ledger: await this.addr.ledger(planet) };
  }

  private async accountExists(pk: PublicKey): Promise<boolean> {
    return (await this.connection.getAccountInfo(pk, 'confirmed')) !== null;
  }

  private assertCurrency(code: string): void {
    if (!this.currencies.includes(code)) throw new LedgerError('unknown_account', `unknown currency ${code}`);
  }

  private assertAmount(n: number, what: string, allowZero: boolean): void {
    if (!Number.isSafeInteger(n) || n < 0 || (!allowZero && n === 0)) {
      throw new LedgerError('invalid_amount', `${what} must be a ${allowZero ? 'non-negative' : 'positive'} integer, got ${n}`);
    }
  }

  /** Sends instructions in as few transactions as fit; not atomic across transactions. */
  private async sendAll(ixs: TransactionInstruction[]): Promise<void> {
    for (let i = 0; i < ixs.length; i += MAX_IXS_PER_TX) await this.send(ixs.slice(i, i + MAX_IXS_PER_TX));
  }

  private async send(ixs: TransactionInstruction[], computeUnits?: number): Promise<void> {
    const tx = new Transaction();
    if (computeUnits) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
    tx.add(...ixs);
    try {
      await sendAndConfirmTransaction(this.connection, tx, [this.admin], { commitment: 'confirmed' });
    } catch (e) {
      const logs = e instanceof SendTransactionError ? ((await e.getLogs(this.connection).catch(() => [])) ?? []) : [];
      throw toLedgerError(e, logs);
    }
  }
}

function toCargo(cargo: Cargo[]) {
  return cargo.map((c) => ({ good: idKey(c.good), qty: new BN(c.qty) }));
}

function toSafeNumber(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new LedgerError('invalid_amount', `on-chain value ${n} exceeds the safe integer range`);
  return Number(n);
}
