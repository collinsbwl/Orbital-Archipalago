import { AnchorProvider, BN, Program, Wallet } from '@anchor-lang/core';
import { ComputeBudgetProgram, Connection, type Keypair, type PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import {
  AgentIdSchema, LedgerError, type BorrowRequest, type Cargo, type CurrencyId, type DepartRequest, type GoodId, type InvariantReport,
  type Ledger, type MinorUnits, type OpenAccountRequest, type OwnerId, type PlanetId, type PolicyInstruction, type RepayRequest, type WorldConfig,
} from '@orbital/contracts';
import { type Chain, ConnectionChain } from './chain.js';
import { IDL } from './idl/orbital.js';
import type { Orbital } from './idl/orbital-types.js';
import { Addresses, codeBytes, idKey } from './keys.js';
import { toLedgerError } from './errors.js';

export interface SolanaLedgerOptions {
  /** Where to send transactions: a Chain, or a Connection (wrapped in a ConnectionChain). */
  chain?: Chain;
  connection?: Connection;
  /** The sim engine's key: the only signer the program accepts. */
  admin: Keypair;
  /** Planets, currencies and goods this ledger accepts; anything else is `invalid_amount`. */
  world: WorldConfig;
  programId?: PublicKey;
}

// Layout of a PlanetLedger account (programs/orbital/src/state.rs), after the 8-byte discriminator:
// planet[32] currency[3] pad[5] len:u64, then `len` slots of owner[32] good[32] qty:u64.
const LEDGER_HEADER = 8 + 32 + 3 + 5;
const SLOT_SIZE = 72;
// SPL mint: mint_authority COption<Pubkey> (36 bytes), then supply u64. SPL token account: mint[32] owner[32] amount u64.
const MINT_SUPPLY_OFFSET = 36;
const TOKEN_AMOUNT_OFFSET = 64;
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
  readonly chain: Chain;
  private readonly admin: Keypair;
  private readonly world: WorldConfig;
  private readonly currencies: CurrencyId[];
  /** Owners opened through this instance; checkInvariants sums their purses (C4 replaces this with an on-chain total). */
  private readonly owners = new Set<OwnerId>();

  constructor(opts: SolanaLedgerOptions) {
    const chain = opts.chain ?? (opts.connection ? new ConnectionChain(opts.connection) : undefined);
    if (!chain) throw new Error('SolanaLedger needs a chain or a connection');
    this.chain = chain;
    this.admin = opts.admin;
    this.world = opts.world;
    // Anchor only builds instructions here; it never talks to this placeholder connection.
    const provider = new AnchorProvider(opts.connection ?? new Connection('http://127.0.0.1:1'), new Wallet(opts.admin), { commitment: 'confirmed' });
    this.program = new Program<Orbital>(IDL as unknown as Orbital, provider);
    this.addr = new Addresses(opts.programId ?? this.program.programId, opts.admin.publicKey);
    this.currencies = opts.world.planets.map((p) => p.currency);
  }

  // ---- C1: accounts, purses, inventories -------------------------------------------------------
  // Check order (pinned by the contract): invalid_amount (shape, unknown ids), unknown_account, then state errors.

  async openAccount(req: OpenAccountRequest): Promise<void> {
    this.checkOwner(req.owner);
    this.checkPlanet(req.planet);
    const purse = req.purse ?? {};
    const inventory = req.inventory ?? {};
    for (const [c, amt] of Object.entries(purse)) {
      this.checkCurrency(c);
      this.checkAmount(amt, `purse ${c}`, true);
    }
    for (const [g, qty] of Object.entries(inventory)) {
      this.checkGood(g);
      this.checkAmount(qty, `inventory ${g}`, true);
    }
    if (await this.isOpen(req.owner)) throw new LedgerError('invalid_state', `account ${req.owner} already exists`);

    // Every owner gets a purse in every currency, so it can receive any of them later.
    const ixs: TransactionInstruction[] = [];
    for (const code of this.currencies) ixs.push(await this.openPurseIx(req.owner, code));
    for (const [code, amt] of Object.entries(purse)) if (amt > 0) ixs.push(await this.issueIx(req.owner, code, amt));
    await this.sendAll(ixs);

    const cargo = Object.entries(inventory).filter(([, q]) => q > 0).map(([good, qty]) => ({ good, qty }));
    if (cargo.length) await this.send([await this.grantIx(req.planet, req.owner, cargo)], INVENTORY_COMPUTE_UNITS);
    this.owners.add(req.owner);
  }

  async getPurse(owner: OwnerId, currency: CurrencyId): Promise<MinorUnits> {
    this.checkOwner(owner);
    this.checkCurrency(currency);
    const data = await this.chain.getAccountData(this.addr.purse(owner, currency));
    if (!data) throw new LedgerError('unknown_account', `no account ${owner}`);
    return toSafeNumber(data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET));
  }

  async getInventory(owner: OwnerId, planet: PlanetId, good: GoodId): Promise<number> {
    this.checkOwner(owner);
    this.checkPlanet(planet);
    this.checkGood(good);
    await this.requireOpen(owner);
    const slots = await this.readLedger(planet);
    return slots.get(slotKey(owner, good)) ?? 0;
  }

  async transfer(req: { from: OwnerId; to: OwnerId; currency: CurrencyId; amount: MinorUnits }): Promise<void> {
    this.checkOwner(req.from);
    this.checkOwner(req.to);
    this.checkCurrency(req.currency);
    this.checkAmount(req.amount, 'transfer amount', true);
    if (req.from === req.to) throw new LedgerError('invalid_amount', 'cannot transfer to the same owner');
    await this.requireOpen(req.from);
    await this.requireOpen(req.to);
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
    this.checkOwner(req.owner);
    this.checkPlanet(req.planet);
    for (const c of [...req.inputs, ...req.outputs]) this.checkCargo(c);
    await this.requireOpen(req.owner);
    const ix = await this.program.methods
      .produce(idKey(req.owner), toCargo(req.inputs), toCargo(req.outputs))
      .accountsPartial(await this.editAccounts(req.planet))
      .instruction();
    await this.send([ix], INVENTORY_COMPUTE_UNITS);
  }

  async consume(req: { owner: OwnerId; planet: PlanetId; cargo: Cargo[] }): Promise<void> {
    this.checkOwner(req.owner);
    this.checkPlanet(req.planet);
    for (const c of req.cargo) this.checkCargo(c);
    await this.requireOpen(req.owner);
    const ix = await this.program.methods
      .consume(idKey(req.owner), toCargo(req.cargo))
      .accountsPartial(await this.editAccounts(req.planet))
      .instruction();
    await this.send([ix], INVENTORY_COMPUTE_UNITS);
  }

  /**
   * C1 version: totals read from the chain (currency = mint supply, goods = sum of every planet ledger) and one check,
   * supply == sum of purses, over the owners opened through this instance. C4 replaces it with an on-chain running total.
   */
  async checkInvariants(): Promise<InvariantReport> {
    const currency: Record<string, number> = {};
    const violations: { code: string; message: string }[] = [];
    for (const code of this.currencies) {
      const mint = await this.chain.getAccountData(this.addr.mint(code));
      const supply = mint ? toSafeNumber(mint.readBigUInt64LE(MINT_SUPPLY_OFFSET)) : 0;
      currency[code] = supply;
      let purses = 0;
      for (const owner of this.owners) purses += await this.getPurse(owner, code);
      if (purses !== supply) violations.push({ code: 'currency_supply_mismatch', message: `${code}: supply ${supply} != purses ${purses}` });
    }
    const goods: Record<string, number> = Object.fromEntries(this.world.goods.map((g) => [g.id, 0]));
    for (const p of this.world.planets) {
      for (const [key, qty] of await this.readLedger(p.id)) {
        const good = key.slice(key.indexOf('|') + 1);
        if (good in goods) goods[good]! += qty;
      }
    }
    return { ok: violations.length === 0, violations, totals: { currency, goods } };
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
  getPolicy: Ledger['getPolicy'] = async (planet) => {
    this.checkPlanet(planet);
    return notYet('getPolicy'); // C3/C4
  };

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

  // ---- Validation ------------------------------------------------------------------------------

  private checkOwner(owner: string): void {
    if (!AgentIdSchema.safeParse(owner).success) throw new LedgerError('invalid_amount', `malformed owner id "${owner}"`);
  }
  private checkPlanet(planet: string): void {
    if (!this.world.planets.some((p) => p.id === planet)) throw new LedgerError('invalid_amount', `unknown planet ${planet}`);
  }
  private checkCurrency(code: string): void {
    if (!this.currencies.includes(code)) throw new LedgerError('invalid_amount', `unknown currency ${code}`);
  }
  private checkGood(good: string): void {
    if (!this.world.goods.some((g) => g.id === good)) throw new LedgerError('invalid_amount', `unknown good ${good}`);
  }
  private checkAmount(n: number, what: string, allowZero: boolean): void {
    if (!Number.isSafeInteger(n) || n < 0 || (!allowZero && n === 0)) {
      throw new LedgerError('invalid_amount', `${what} must be a ${allowZero ? 'non-negative' : 'positive'} integer, got ${n}`);
    }
  }
  private checkCargo(c: Cargo): void {
    this.checkGood(c.good);
    this.checkAmount(c.qty, `cargo ${c.good}`, false);
  }

  // ---- Internals -------------------------------------------------------------------------------

  /** An owner is open iff its purse exists (openAccount creates purses in every currency). */
  private async isOpen(owner: OwnerId): Promise<boolean> {
    return (await this.chain.getAccountData(this.addr.purse(owner, this.currencies[0]!))) !== null;
  }

  private async requireOpen(owner: OwnerId): Promise<void> {
    if (!(await this.isOpen(owner))) throw new LedgerError('unknown_account', `no account ${owner}`);
  }

  private async editAccounts(planet: PlanetId) {
    return { admin: this.admin.publicKey, config: this.addr.config(), ledger: await this.addr.ledger(planet) };
  }

  /** Every (owner, good) quantity on a planet, keyed "ownerHash|goodId" (hash for owner, id for known goods). */
  private async readLedger(planet: PlanetId): Promise<Map<string, number>> {
    const data = await this.chain.getAccountData(await this.addr.ledger(planet));
    if (!data) throw new LedgerError('unknown_account', `planet ${planet} has no ledger (run bootstrapLedger)`);
    const goodByHash = new Map(this.world.goods.map((g) => [Buffer.from(idKey(g.id)).toString('hex'), g.id]));
    const len = Number(data.readBigUInt64LE(LEDGER_HEADER));
    const out = new Map<string, number>();
    for (let i = 0; i < len; i++) {
      const at = LEDGER_HEADER + 8 + i * SLOT_SIZE;
      const good = goodByHash.get(data.subarray(at + 32, at + 64).toString('hex'));
      if (good === undefined) continue;
      out.set(`${data.subarray(at, at + 32).toString('hex')}|${good}`, toSafeNumber(data.readBigUInt64LE(at + 64)));
    }
    return out;
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
      await this.chain.send(tx, [this.admin]);
    } catch (e) {
      throw toLedgerError(e);
    }
  }
}

const slotKey = (owner: OwnerId, good: GoodId) => `${Buffer.from(idKey(owner)).toString('hex')}|${good}`;

function toCargo(cargo: Cargo[]) {
  return cargo.map((c) => ({ good: idKey(c.good), qty: new BN(c.qty) }));
}

function toSafeNumber(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new LedgerError('invalid_amount', `on-chain value ${n} exceeds the safe integer range`);
  return Number(n);
}
