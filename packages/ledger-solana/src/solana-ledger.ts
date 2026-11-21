import { AnchorProvider, BN, Program, Wallet } from '@anchor-lang/core';
import { ComputeBudgetProgram, Connection, type Keypair, type PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import {
  AgentIdSchema, LedgerError, type AuctionResult, type BorrowRequest, type Cargo, type CurrencyId, type DepartRequest, type GoodId,
  type FxAuctionResult, type FxOrder, type InvariantReport, type Ledger, type Loan, type MinorUnits, type OpenAccountRequest, type Order, type OrderId, type OrderRecord, type OwnerId,
  type ArriveResult, type PlaceOrdersResult, type PlanetId, type PolicyInstruction, type PolicyState, type RepayRequest, type Shipment,
  type ShipmentId, type WorldConfig,
} from '@orbital/contracts';
import { clearAuction, sortBook } from './auction.js';
import { clearFx } from './fx.js';
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
// Config account (after the discriminator): admin[32], next_order u64.
const CONFIG_NEXT_ORDER_OFFSET = 8 + 32;
const CONFIG_NEXT_SHIPMENT_OFFSET = 8 + 40;
const CONFIG_NEXT_LOAN_OFFSET = 8 + 48;
// CurrencyBook (after the discriminator): minted u64, burned u64.
// Loan (after the discriminator): borrower[32] planet[32] currency[5] principal u64 outstanding u64 rate_bp u64 issued u64 due u64 last_accrual u64.
const LOAN_CURRENCY_OFFSET = 8 + 64;
const LOAN_NUMBERS_OFFSET = LOAN_CURRENCY_OFFSET + 5;
// PlanetPolicy (after the discriminator): planet[32] policy_rate u64 n_goods u64 n_embargoes u64, 16 embargo keys[32],
// then goods of 88 bytes: good[32] tariff u64 quota_max u64 quota_used u64 quota_cycle u64 last_price u64 base_price u64 has_quota u8 has_price u8 pad[6].
const POLICY_RATE_OFFSET = 8 + 32;
const POLICY_N_GOODS_OFFSET = POLICY_RATE_OFFSET + 8;
const POLICY_N_EMBARGOES_OFFSET = POLICY_N_GOODS_OFFSET + 8;
const POLICY_EMBARGOES_OFFSET = POLICY_N_EMBARGOES_OFFSET + 8;
const POLICY_GOODS_OFFSET = POLICY_EMBARGOES_OFFSET + 16 * 32;
const GOOD_POLICY_SIZE = 88;
// Shipment (after the discriminator): owner[32] from[32] to[32], 8 cargo lines of good[32]+qty u64, n_lines u8,
// depart_cycle u64, arrive_cycle u64, arrived u8.
const SHIPMENT_LINES_OFFSET = 8 + 96;
const SHIPMENT_N_OFFSET = SHIPMENT_LINES_OFFSET + 8 * 40;

interface GoodRules {
  good: string;
  tariffBp: number;
  hasQuota: boolean;
  quotaMax: bigint;
  quotaUsed: bigint;
  quotaCycle: bigint;
  hasPrice: boolean;
  lastPrice: bigint;
  basePrice: bigint;
}

interface ShipmentData {
  id: ShipmentId;
  n: number;
  ownerKey: Buffer;
  from: PlanetId;
  to: PlanetId;
  cargo: Cargo[];
  departCycle: number;
  arriveCycle: number;
  arrived: boolean;
}
// OrderBook account (after the discriminator): planet[32] good[32] len u64, then `len` order slots of
// seq u64, owner[32], qty u64, limit u64, cycle u64, side u8 + 7 pad.
const BOOK_LEN_OFFSET = 8 + 64;
const BOOK_SLOTS_OFFSET = BOOK_LEN_OFFSET + 8;
const ORDER_SIZE = 72;
/** The auction scans the whole book, so give it the maximum compute budget. */
const AUCTION_COMPUTE_UNITS = 1_400_000;

interface BookOrder {
  seq: number;
  ownerKey: Buffer;
  side: 'buy' | 'sell';
  qty: bigint;
  limit: bigint;
  cycle: number;
}


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
  /** On-chain orders and ledgers only hold sha256(ownerId); this maps back so fills and open orders can name the agent. */
  private readonly ownerByHash = new Map<string, OwnerId>();

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

    // One atomic instruction: a purse in every currency (so the owner can receive any of them later), the starting cash,
    // and the starting goods. Either all of it happens or none of it does.
    const cargo = Object.entries(inventory).filter(([, q]) => q > 0).map(([good, qty]) => ({ good, qty }));
    const ix = await this.program.methods
      .openAccount(idKey(req.owner), this.currencies.map(codeBytes), this.currencies.map((c) => new BN(purse[c] ?? 0)), toCargo(cargo))
      .accountsPartial({
        admin: this.admin.publicKey,
        config: this.addr.config(),
        mintAuthority: this.addr.mintAuthority(),
        ledger: await this.addr.ledger(req.planet),
      })
      // For each currency: its mint, the purse the program will create, and its supply record.
      .remainingAccounts(
        this.currencies.flatMap((c) => [
          { pubkey: this.addr.mint(c), isSigner: false, isWritable: true },
          { pubkey: this.addr.purse(req.owner, c), isSigner: false, isWritable: true },
          { pubkey: this.addr.currencyBook(c), isSigner: false, isWritable: true },
        ]),
      )
      .instruction();
    await this.send([ix], INVENTORY_COMPUTE_UNITS);
    this.owners.add(req.owner);
    this.ownerByHash.set(Buffer.from(idKey(req.owner)).toString('hex'), req.owner);
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
  /**
   * Totals are read from the chain: currency = mint supply (purses + escrow vault), goods = every planet ledger plus the
   * goods held in sell orders. Checks that supply == purses + vault and that the vault equals the buy orders' escrow.
   * The program itself fails any transaction that leaves the supply different from minted - burned; this also compares purses
   * (summed over the owners opened through this instance) with the supply.
   */
  async checkInvariants(): Promise<InvariantReport> {
    const currency: Record<string, number> = {};
    const goods: Record<string, number> = Object.fromEntries(this.world.goods.map((g) => [g.id, 0]));
    const violations: { code: string; message: string }[] = [];

    const buyEscrow: Record<string, bigint> = {};
    for (const p of this.world.planets) {
      buyEscrow[p.currency] ??= 0n;
      for (const g of this.world.goods) {
        for (const o of (await this.readBook(p.id, g.id)) ?? []) {
          if (o.side === 'buy') buyEscrow[p.currency]! += o.qty * o.limit;
          else goods[g.id]! += toSafeNumber(o.qty);
        }
      }
    }

    // FX orders escrow the currency they give, in the same vaults.
    for (const [a, b] of this.fxPairs()) {
      for (const o of (await this.readBookAt(this.addr.fxBook(a, b))) ?? []) buyEscrow[o.side === 'buy' ? a : b]! += o.qty;
    }

    for (const code of this.currencies) {
      const mint = await this.chain.getAccountData(this.addr.mint(code));
      const supply = mint ? toSafeNumber(mint.readBigUInt64LE(MINT_SUPPLY_OFFSET)) : 0;
      currency[code] = supply;
      const vaultData = await this.chain.getAccountData(this.addr.vault(code));
      const vault = vaultData ? toSafeNumber(vaultData.readBigUInt64LE(TOKEN_AMOUNT_OFFSET)) : 0;
      const book = await this.chain.getAccountData(this.addr.currencyBook(code));
      if (book) {
        const expected = book.readBigUInt64LE(8) - book.readBigUInt64LE(16); // minted - burned, tracked by the program
        if (BigInt(supply) !== expected) violations.push({ code: 'currency_supply_mismatch', message: `${code}: supply ${supply} != minted - burned ${expected}` });
      }
      let purses = 0;
      for (const owner of this.owners) purses += await this.getPurse(owner, code);
      if (purses + vault !== supply) violations.push({ code: 'currency_supply_mismatch', message: `${code}: supply ${supply} != purses ${purses} + escrow ${vault}` });
      if (BigInt(vault) !== buyEscrow[code]) violations.push({ code: 'escrow_mismatch', message: `${code}: vault ${vault} != buy orders ${buyEscrow[code]}` });
    }

    // Cargo still in flight belongs to the goods supply.
    const nextShipment = await this.nextShipmentId().catch(() => 1);
    for (let n = 1; n < nextShipment; n++) {
      const sh = await this.readShipment(`s${n}`);
      if (sh && !sh.arrived) for (const c of sh.cargo) if (c.good in goods) goods[c.good]! += c.qty;
    }

    for (const p of this.world.planets) {
      for (const [key, qty] of await this.readLedger(p.id)) {
        const good = key.slice(key.indexOf('|') + 1);
        if (good in goods) goods[good]! += qty;
      }
    }
    return { ok: violations.length === 0, violations, totals: { currency, goods } };
  }

  // ---- C2: local orders and auction ------------------------------------------------------------

  /** Orders are validated and escrowed one at a time (one transaction each); rejects are reported, never thrown. */
  async placeOrders(orders: Order[], cycle: number): Promise<PlaceOrdersResult> {
    const result: PlaceOrdersResult = { accepted: [], rejected: [] };
    for (const [index, order] of orders.entries()) {
      try {
        result.accepted.push({ index, orderId: await this.placeOne(order, cycle) });
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        result.rejected.push({ index, error: e.toJSON() });
      }
    }
    return result;
  }

  private async placeOne(o: Order, cycle: number): Promise<OrderId> {
    this.checkOwner(o.agentId);
    this.checkPlanet(o.planet);
    this.checkGood(o.good);
    if (o.side !== 'buy' && o.side !== 'sell') throw new LedgerError('invalid_amount', `bad side ${String(o.side)}`);
    this.checkAmount(o.qty, 'order qty', false);
    this.checkAmount(o.limitPrice, 'limit price', true);
    if (o.side === 'buy' && BigInt(o.qty) * BigInt(o.limitPrice) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new LedgerError('invalid_amount', 'qty * limitPrice is not a safe integer');
    }
    await this.requireOpen(o.agentId);
    await this.ensureBook(o.planet, o.good);

    const seq = await this.nextOrderSeq();
    const code = this.currencyOf(o.planet);
    const ix = await this.program.methods
      .placeOrder(idKey(o.agentId), codeBytes(code), o.side === 'buy' ? 0 : 1, new BN(o.qty), new BN(o.limitPrice), new BN(cycle))
      .accountsPartial({
        admin: this.admin.publicKey,
        config: this.addr.config(),
        book: this.addr.book(o.planet, o.good),
        ledger: await this.addr.ledger(o.planet),
        vault: this.addr.vault(code),
        purse: this.addr.purse(o.agentId, code),
      })
      .instruction();
    await this.send([ix], INVENTORY_COMPUTE_UNITS);
    this.ownerByHash.set(Buffer.from(idKey(o.agentId)).toString('hex'), o.agentId);
    return `o${seq}`;
  }

  async cancelOrder(orderId: OrderId): Promise<void> {
    const m = /^o(\d+)$/.exec(orderId);
    const seq = m ? Number(m[1]) : NaN;
    for (const planet of this.world.planets) {
      for (const good of this.world.goods) {
        const order = (await this.readBook(planet.id, good.id))?.find((x) => x.seq === seq);
        if (!order) continue;
        const code = planet.currency;
        const ix = await this.program.methods
          .cancelOrder(Array.from(order.ownerKey), codeBytes(code), new BN(seq))
          .accountsPartial({
            admin: this.admin.publicKey,
            config: this.addr.config(),
            book: this.addr.book(planet.id, good.id),
            ledger: await this.addr.ledger(planet.id),
            vault: this.addr.vault(code),
            purse: this.addr.purseOfKey(order.ownerKey, code),
          })
          .instruction();
        await this.send([ix], INVENTORY_COMPUTE_UNITS);
        return;
      }
    }
    // Not a local order: look in the FX books (one per currency pair).
    for (const [a, b] of this.fxPairs()) {
      const order = (await this.readBookAt(this.addr.fxBook(a, b)))?.find((x) => x.seq === seq);
      if (!order) continue;
      const give = order.side === 'buy' ? a : b;
      const ix = await this.program.methods
        .cancelFxOrder(Array.from(order.ownerKey), codeBytes(a), codeBytes(b), codeBytes(give), new BN(seq))
        .accountsPartial({
          admin: this.admin.publicKey,
          config: this.addr.config(),
          book: this.addr.fxBook(a, b),
          vault: this.addr.vault(give),
          purse: this.addr.purseOfKey(order.ownerKey, give),
        })
        .instruction();
      await this.send([ix]);
      return;
    }
    throw new LedgerError('unknown_order', `unknown order ${orderId}`);
  }

  async openOrders(agentId: string): Promise<OrderRecord[]> {
    this.checkOwner(agentId);
    await this.requireOpen(agentId);
    const key = Buffer.from(idKey(agentId));
    const found: (OrderRecord & { seq: number })[] = [];
    for (const planet of this.world.planets) {
      for (const good of this.world.goods) {
        for (const o of (await this.readBook(planet.id, good.id)) ?? []) {
          if (!o.ownerKey.equals(key)) continue;
          found.push({
            seq: o.seq, orderId: `o${o.seq}`, agentId, planet: planet.id, good: good.id, side: o.side,
            qty: toSafeNumber(o.qty), limitPrice: toSafeNumber(o.limit), cycle: o.cycle,
          });
        }
      }
    }
    return found.sort((a, b) => a.seq - b.seq).map(({ seq: _seq, ...rec }) => rec);
  }

  async clearLocalAuction(planet: PlanetId, good: GoodId, cycle: number): Promise<AuctionResult> {
    this.checkPlanet(planet);
    this.checkGood(good);
    const none: AuctionResult = { planet, good, cycle, clearingPrice: null, volume: 0, fills: [] };
    const book = (await this.readBook(planet, good)) ?? [];
    const bids = book.map((o) => ({ side: o.side, qty: o.qty, limit: o.limit }));
    const outcome = clearAuction(bids);
    if (outcome.price === null) return none;
    const { buys, sells } = sortBook(bids);

    const code = this.currencyOf(planet);
    const price = outcome.price;
    const ix = await this.program.methods
      .clearLocalAuction(codeBytes(code), Buffer.from(buys), Buffer.from(sells))
      .accountsPartial({
        admin: this.admin.publicKey,
        config: this.addr.config(),
        book: this.addr.book(planet, good),
        ledger: await this.addr.ledger(planet),
        policy: this.addr.policy(planet),
        vault: this.addr.vault(code),
      })
      // One purse per fill, in fill order: the program checks each against the order it settles.
      .remainingAccounts(outcome.fills.map((f) => ({ pubkey: this.addr.purseOfKey(book[f.index]!.ownerKey, code), isSigner: false, isWritable: true })))
      .instruction();
    await this.send([ix], AUCTION_COMPUTE_UNITS);

    return {
      planet, good, cycle, clearingPrice: toSafeNumber(price), volume: toSafeNumber(outcome.volume),
      fills: outcome.fills.map((f) => {
        const o = book[f.index]!;
        const hex = o.ownerKey.toString('hex');
        return {
          orderId: `o${o.seq}`, agentId: this.ownerByHash.get(hex) ?? hex, good, side: o.side,
          qty: toSafeNumber(f.qty), price: toSafeNumber(price), total: toSafeNumber(f.qty * price),
        };
      }),
    };
  }

  // ---- C2: FX ----------------------------------------------------------------------------------

  /** FX orders are immediate-or-cancel: they escrow what they give and live until the next clear of their pair. */
  async placeFxOrders(orders: FxOrder[], cycle: number): Promise<PlaceOrdersResult> {
    const result: PlaceOrdersResult = { accepted: [], rejected: [] };
    for (const [index, order] of orders.entries()) {
      try {
        result.accepted.push({ index, orderId: await this.placeFxOne(order, cycle) });
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        result.rejected.push({ index, error: e.toJSON() });
      }
    }
    return result;
  }

  private async placeFxOne(o: FxOrder, cycle: number): Promise<OrderId> {
    this.checkOwner(o.agentId);
    this.checkCurrency(o.give);
    this.checkCurrency(o.want);
    if (o.give === o.want) throw new LedgerError('invalid_amount', 'give and want must differ');
    this.checkAmount(o.giveAmount, 'giveAmount', false);
    this.checkAmount(o.minReceive, 'minReceive', true);
    await this.requireOpen(o.agentId);
    const [a, b] = pairOf(o.give, o.want);
    await this.ensureFxBook(a, b);

    const seq = await this.nextOrderSeq();
    const ix = await this.program.methods
      .placeFxOrder(idKey(o.agentId), codeBytes(a), codeBytes(b), codeBytes(o.give), new BN(o.giveAmount), new BN(o.minReceive), new BN(cycle))
      .accountsPartial({
        admin: this.admin.publicKey,
        config: this.addr.config(),
        book: this.addr.fxBook(a, b),
        vault: this.addr.vault(o.give),
        purse: this.addr.purse(o.agentId, o.give),
      })
      .instruction();
    await this.send([ix]);
    this.ownerByHash.set(Buffer.from(idKey(o.agentId)).toString('hex'), o.agentId);
    return `o${seq}`;
  }

  async clearFxAuction(base: CurrencyId, quote: CurrencyId, cycle: number): Promise<FxAuctionResult> {
    this.checkCurrency(base);
    this.checkCurrency(quote);
    if (base === quote) throw new LedgerError('invalid_amount', 'base and quote must differ');
    const none: FxAuctionResult = { base, quote, cycle, ratePpm: null, fills: [] };
    const [a, b] = pairOf(base, quote);
    const book = (await this.readBookAt(this.addr.fxBook(a, b))) ?? [];
    if (book.length === 0) return none;

    const giveOf = (o: BookOrder) => (o.side === 'buy' ? a : b); // side 0 gives `a`, side 1 gives `b` (reuses the book's buy/sell encoding)
    const outcome = clearFx(book.map((o) => ({ givesBase: giveOf(o) === base, give: o.qty, minReceive: o.limit })));

    // Rounding dust goes to the treasury of the quote planet; without that account nothing changes.
    const treasury = this.world.planets.find((p) => p.currency === quote)!.id;
    if (outcome.dust > 0n) await this.requireOpen(treasury);

    // Remaining accounts, in the order the program consumes them: per order its give-currency purse (refund), then
    // its receive-currency purse if it traded; finally the treasury purse when there is dust.
    const filled = new Set(outcome.fills.map((f) => f.index));
    const remaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    const meta = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
    book.forEach((o, i) => {
      const gives = giveOf(o);
      remaining.push(meta(this.addr.purseOfKey(o.ownerKey, gives)));
      if (filled.has(i)) remaining.push(meta(this.addr.purseOfKey(o.ownerKey, gives === base ? quote : base)));
    });
    if (outcome.dust > 0n) remaining.push(meta(this.addr.purse(treasury, quote)));

    const ix = await this.program.methods
      .clearFxAuction(codeBytes(base), codeBytes(quote), idKey(treasury))
      .accountsPartial({
        admin: this.admin.publicKey,
        config: this.addr.config(),
        book: this.addr.fxBook(a, b),
        baseVault: this.addr.vault(base),
        quoteVault: this.addr.vault(quote),
      })
      .remainingAccounts(remaining)
      .instruction();
    await this.send([ix], AUCTION_COMPUTE_UNITS);

    if (outcome.rate === null) return none;
    return {
      base, quote, cycle, ratePpm: toSafeNumber(outcome.rate),
      fills: outcome.fills.map((f) => {
        const o = book[f.index]!;
        const gives = giveOf(o);
        const hex = o.ownerKey.toString('hex');
        return {
          orderId: `o${o.seq}`, agentId: this.ownerByHash.get(hex) ?? hex, give: gives, giveAmount: toSafeNumber(f.spent),
          want: gives === base ? quote : base, receiveAmount: toSafeNumber(f.received),
        };
      }),
    };
  }

  // ---- C4: credit --------------------------------------------------------------------------------

  /** A loan mints the planet's currency into the borrower's purse. The planet's current policy rate is snapshotted. */
  async borrow(req: BorrowRequest): Promise<Loan> {
    this.checkPlanet(req.planet);
    this.checkAmount(req.amount, 'loan amount', false);
    this.checkAmount(req.termCycles, 'termCycles', false);
    this.checkAmount(req.cycle, 'cycle', true);
    this.checkOwner(req.borrower);
    await this.requireOpen(req.borrower);

    const n = await this.counter(CONFIG_NEXT_LOAN_OFFSET);
    const code = this.currencyOf(req.planet);
    const ix = await this.program.methods
      .borrow(idKey(req.borrower), idKey(req.planet), codeBytes(code), new BN(req.amount), new BN(req.termCycles), new BN(req.cycle))
      .accountsPartial({
        admin: this.admin.publicKey,
        config: this.addr.config(),
        loan: this.addr.loan(n),
        policy: this.addr.policy(req.planet),
        ledger: await this.addr.ledger(req.planet),
        mintAuthority: this.addr.mintAuthority(),
        mint: this.addr.mint(code),
        book: this.addr.currencyBook(code),
        purse: this.addr.purse(req.borrower, code),
      })
      .instruction();
    await this.send([ix]);
    return (await this.readLoan(`l${n}`))!;
  }

  /** Accrues simple interest since the last accrual, then burns min(amount, outstanding) from the borrower's purse. */
  async repay(req: RepayRequest): Promise<Loan> {
    const before = await this.readLoan(req.loanId);
    if (!before) throw new LedgerError('unknown_loan', `unknown loan ${req.loanId}`);
    this.checkAmount(req.amount, 'repay amount', false);
    this.checkAmount(req.cycle, 'cycle', true);
    const ix = await this.program.methods
      .repay(new BN(Number(req.loanId.slice(1))), codeBytes(before.currency), new BN(req.amount), new BN(req.cycle))
      .accountsPartial({
        admin: this.admin.publicKey,
        config: this.addr.config(),
        loan: this.addr.loan(Number(req.loanId.slice(1))),
        mint: this.addr.mint(before.currency),
        book: this.addr.currencyBook(before.currency),
        purse: this.addr.purse(before.borrower, before.currency),
      })
      .instruction();
    await this.send([ix]);
    return (await this.readLoan(req.loanId))!;
  }

  // ---- C3: policy and shipping -------------------------------------------------------------------

  async applyPolicy(i: PolicyInstruction): Promise<void> {
    this.checkPlanet(i.planet);
    const rate = (n: number) => {
      if (!Number.isSafeInteger(n) || n < 0 || n > 10_000) throw new LedgerError('invalid_amount', `rateBp must be 0..10000, got ${n}`);
      return new BN(n);
    };
    let op: Parameters<typeof this.program.methods.applyPolicy>[0];
    switch (i.kind) {
      case 'set_tariff':
        this.checkGood(i.good);
        op = { setTariff: { good: idKey(i.good), rateBp: rate(i.rateBp) } };
        break;
      case 'set_quota':
        this.checkGood(i.good);
        this.checkAmount(i.maxPerCycle, 'maxPerCycle', true);
        op = { setQuota: { good: idKey(i.good), max: new BN(i.maxPerCycle) } };
        break;
      case 'set_embargo':
        this.checkPlanet(i.target);
        if (i.target === i.planet) throw new LedgerError('invalid_amount', 'a planet cannot embargo itself');
        op = { setEmbargo: { target: idKey(i.target), active: i.active } };
        break;
      case 'set_policy_rate':
        op = { setPolicyRate: { rateBp: rate(i.rateBp) } };
        break;
    }
    const ix = await this.program.methods
      .applyPolicy(op)
      .accountsPartial({ admin: this.admin.publicKey, config: this.addr.config(), policy: this.addr.policy(i.planet) })
      .instruction();
    await this.send([ix]);
  }

  async getPolicy(planet: PlanetId): Promise<PolicyState> {
    this.checkPlanet(planet);
    const { data, goods } = await this.readPolicy(planet);
    const planetByHash = new Map(this.world.planets.map((p) => [Buffer.from(idKey(p.id)).toString('hex'), p.id]));
    const embargoes: string[] = [];
    const n = Number(data.readBigUInt64LE(POLICY_N_EMBARGOES_OFFSET));
    for (let k = 0; k < n; k++) {
      const at = POLICY_EMBARGOES_OFFSET + k * 32;
      const id = planetByHash.get(data.subarray(at, at + 32).toString('hex'));
      if (id) embargoes.push(id);
    }
    const tariffsBp: Record<string, number> = {};
    const quotas: Record<string, number> = {};
    for (const g of goods) {
      if (g.tariffBp > 0) tariffsBp[g.good] = g.tariffBp;
      if (g.hasQuota) quotas[g.good] = toSafeNumber(g.quotaMax);
    }
    return { tariffsBp, quotas, embargoes: embargoes.sort(), policyRateBp: toSafeNumber(data.readBigUInt64LE(POLICY_RATE_OFFSET)) };
  }

  async depart(req: DepartRequest): Promise<Shipment> {
    this.checkOwner(req.owner);
    this.checkPlanet(req.from);
    this.checkPlanet(req.to);
    if (req.from === req.to) throw new LedgerError('invalid_amount', 'from and to must differ');
    if (req.cargo.length === 0) throw new LedgerError('invalid_amount', 'cargo is empty');
    for (const c of req.cargo) this.checkCargo(c);
    if (!Number.isSafeInteger(req.cycle) || req.cycle < 0 || !Number.isSafeInteger(req.arriveCycle) || req.arriveCycle <= req.cycle) {
      throw new LedgerError('invalid_amount', 'arriveCycle must be after cycle');
    }
    // Duplicate goods merge into one line, in order of first appearance.
    const merged = new Map<GoodId, number>();
    for (const c of req.cargo) merged.set(c.good, (merged.get(c.good) ?? 0) + c.qty);
    const cargo = [...merged].map(([good, qty]) => ({ good, qty }));
    for (const c of cargo) this.checkAmount(c.qty, `cargo ${c.good}`, false);
    await this.requireOpen(req.owner);

    const n = await this.nextShipmentId();
    const ix = await this.program.methods
      .depart(idKey(req.owner), idKey(req.to), toCargo(cargo), new BN(req.cycle), new BN(req.arriveCycle))
      .accountsPartial({
        admin: this.admin.publicKey,
        config: this.addr.config(),
        shipment: this.addr.shipment(n),
        fromLedger: await this.addr.ledger(req.from),
      })
      .instruction();
    await this.send([ix], INVENTORY_COMPUTE_UNITS);
    return { id: `s${n}`, owner: req.owner, from: req.from, to: req.to, cargo, departCycle: req.cycle, arriveCycle: req.arriveCycle, status: 'in_flight' };
  }

  async arrive(shipmentId: ShipmentId, cycle: number): Promise<ArriveResult> {
    if (!Number.isSafeInteger(cycle) || cycle < 0) throw new LedgerError('invalid_amount', `bad cycle ${cycle}`);
    const sh = await this.readShipment(shipmentId);
    if (!sh) throw new LedgerError('unknown_shipment', `unknown shipment ${shipmentId}`);
    if (sh.arrived) throw new LedgerError('invalid_state', `shipment ${shipmentId} already arrived`);
    if (cycle < sh.arriveCycle) throw new LedgerError('invalid_state', `shipment ${shipmentId} arrives in cycle ${sh.arriveCycle}`);

    // Work out the outcome with the same rules as the program (it enforces them; this tells us which accounts it needs).
    const { data, goods } = await this.readPolicy(sh.to);
    const rules = new Map(goods.map((g) => [g.good, g]));
    const embargoed = this.embargoedBy(data, sh.from);
    const delivered: Cargo[] = [];
    const withheld: Cargo[] = [];
    let owed = 0n;
    for (const line of sh.cargo) {
      const g = rules.get(line.good);
      let ok = embargoed ? 0n : BigInt(line.qty);
      if (!embargoed && g?.hasQuota) {
        const used = g.quotaCycle === BigInt(cycle) ? g.quotaUsed : 0n;
        const allowed = g.quotaMax > used ? g.quotaMax - used : 0n;
        if (ok > allowed) ok = allowed;
      }
      if (ok > 0n && g && g.tariffBp > 0) owed += (ok * (g.hasPrice ? g.lastPrice : g.basePrice) * BigInt(g.tariffBp)) / 10_000n;
      if (ok > 0n) delivered.push({ good: line.good, qty: Number(ok) });
      if (BigInt(line.qty) > ok) withheld.push({ good: line.good, qty: Number(BigInt(line.qty) - ok) });
    }

    const currency = this.currencyOf(sh.to);
    let collected = 0n;
    const remaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    if (owed > 0n) {
      await this.requireOpen(sh.to); // the destination treasury must exist to receive the duty
      const purse = this.addr.purseOfKey(sh.ownerKey, currency);
      const held = (await this.chain.getAccountData(purse))!.readBigUInt64LE(TOKEN_AMOUNT_OFFSET);
      collected = owed < held ? owed : held;
      remaining.push({ pubkey: purse, isSigner: false, isWritable: true }, { pubkey: this.addr.purse(sh.to, currency), isSigner: false, isWritable: true });
    }

    const ix = await this.program.methods
      .arrive(new BN(sh.n), new BN(cycle), idKey(sh.to))
      .accountsPartial({
        admin: this.admin.publicKey,
        config: this.addr.config(),
        shipment: this.addr.shipment(sh.n),
        fromLedger: await this.addr.ledger(sh.from),
        toLedger: await this.addr.ledger(sh.to),
        policy: this.addr.policy(sh.to),
      })
      .remainingAccounts(remaining)
      .instruction();
    await this.send([ix], INVENTORY_COMPUTE_UNITS);

    const owner = this.ownerByHash.get(sh.ownerKey.toString('hex')) ?? sh.ownerKey.toString('hex');
    return {
      shipment: { id: sh.id, owner, from: sh.from, to: sh.to, cargo: sh.cargo, departCycle: sh.departCycle, arriveCycle: sh.arriveCycle, status: 'arrived' },
      delivered, withheld, duty: { currency, amount: toSafeNumber(collected) },
    };
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

  private async readPolicy(planet: PlanetId): Promise<{ data: Buffer; goods: GoodRules[] }> {
    const data = await this.chain.getAccountData(this.addr.policy(planet));
    if (!data) throw new LedgerError('unknown_account', `planet ${planet} has no policy account (run bootstrapLedger)`);
    const goodByHash = new Map(this.world.goods.map((g) => [Buffer.from(idKey(g.id)).toString('hex'), g.id]));
    const goods: GoodRules[] = [];
    const n = Number(data.readBigUInt64LE(POLICY_N_GOODS_OFFSET));
    for (let i = 0; i < n; i++) {
      const at = POLICY_GOODS_OFFSET + i * GOOD_POLICY_SIZE;
      const good = goodByHash.get(data.subarray(at, at + 32).toString('hex'));
      if (!good) continue;
      goods.push({
        good,
        tariffBp: Number(data.readBigUInt64LE(at + 32)),
        quotaMax: data.readBigUInt64LE(at + 40),
        quotaUsed: data.readBigUInt64LE(at + 48),
        quotaCycle: data.readBigUInt64LE(at + 56),
        lastPrice: data.readBigUInt64LE(at + 64),
        basePrice: data.readBigUInt64LE(at + 72),
        hasQuota: data.readUInt8(at + 80) === 1,
        hasPrice: data.readUInt8(at + 81) === 1,
      });
    }
    return { data, goods };
  }

  private embargoedBy(policy: Buffer, origin: PlanetId): boolean {
    const key = Buffer.from(idKey(origin));
    const n = Number(policy.readBigUInt64LE(POLICY_N_EMBARGOES_OFFSET));
    for (let k = 0; k < n; k++) {
      const at = POLICY_EMBARGOES_OFFSET + k * 32;
      if (policy.subarray(at, at + 32).equals(key)) return true;
    }
    return false;
  }

  private async counter(offset: number): Promise<number> {
    const data = await this.chain.getAccountData(this.addr.config());
    if (!data) throw new LedgerError('invalid_state', 'ledger is not bootstrapped (no config account)');
    return toSafeNumber(data.readBigUInt64LE(offset));
  }

  /** A loan by id ("l<n>"), or null if there is none. */
  private async readLoan(id: string): Promise<Loan | null> {
    const m = /^l(\d+)$/.exec(id);
    if (!m) return null;
    const data = await this.chain.getAccountData(this.addr.loan(Number(m[1])));
    if (!data) return null;
    const planetByHash = new Map(this.world.planets.map((p) => [Buffer.from(idKey(p.id)).toString('hex'), p.id]));
    const borrowerKey = data.subarray(8, 40).toString('hex');
    const u = (i: number) => toSafeNumber(data.readBigUInt64LE(LOAN_NUMBERS_OFFSET + i * 8));
    return {
      id, borrower: this.ownerByHash.get(borrowerKey) ?? borrowerKey, planet: planetByHash.get(data.subarray(40, 72).toString('hex'))!,
      currency: data.subarray(LOAN_CURRENCY_OFFSET, LOAN_CURRENCY_OFFSET + 5).toString('ascii').replace(/\0+$/, ''),
      principal: u(0), outstanding: u(1), rateBp: u(2), issuedCycle: u(3), dueCycle: u(4),
    };
  }

  private async nextShipmentId(): Promise<number> {
    const data = await this.chain.getAccountData(this.addr.config());
    if (!data) throw new LedgerError('invalid_state', 'ledger is not bootstrapped (no config account)');
    return toSafeNumber(data.readBigUInt64LE(CONFIG_NEXT_SHIPMENT_OFFSET));
  }

  /** A shipment by id ("s<n>"), or null if there is none. */
  private async readShipment(id: ShipmentId): Promise<ShipmentData | null> {
    const m = /^s(\d+)$/.exec(id);
    if (!m) return null;
    const n = Number(m[1]);
    const data = await this.chain.getAccountData(this.addr.shipment(n));
    if (!data) return null;
    const goodByHash = new Map(this.world.goods.map((g) => [Buffer.from(idKey(g.id)).toString('hex'), g.id]));
    const planetByHash = new Map(this.world.planets.map((p) => [Buffer.from(idKey(p.id)).toString('hex'), p.id]));
    const lines = data.readUInt8(SHIPMENT_N_OFFSET);
    const cargo: Cargo[] = [];
    for (let i = 0; i < lines; i++) {
      const at = SHIPMENT_LINES_OFFSET + i * 40;
      cargo.push({ good: goodByHash.get(data.subarray(at, at + 32).toString('hex'))!, qty: toSafeNumber(data.readBigUInt64LE(at + 32)) });
    }
    return {
      id, n, ownerKey: Buffer.from(data.subarray(8, 40)),
      from: planetByHash.get(data.subarray(40, 72).toString('hex'))!, to: planetByHash.get(data.subarray(72, 104).toString('hex'))!,
      cargo,
      departCycle: toSafeNumber(data.readBigUInt64LE(SHIPMENT_N_OFFSET + 1)),
      arriveCycle: toSafeNumber(data.readBigUInt64LE(SHIPMENT_N_OFFSET + 9)),
      arrived: data.readUInt8(SHIPMENT_N_OFFSET + 17) === 1,
    };
  }

  /** Every unordered currency pair, alphabetical inside the pair. */
  private fxPairs(): [CurrencyId, CurrencyId][] {
    const out: [CurrencyId, CurrencyId][] = [];
    for (const x of this.currencies) for (const y of this.currencies) if (x < y) out.push([x, y]);
    return out;
  }

  private currencyOf(planet: PlanetId): CurrencyId {
    return this.world.planets.find((p) => p.id === planet)!.currency;
  }

  private async ensureFxBook(a: CurrencyId, b: CurrencyId): Promise<void> {
    if ((await this.chain.getAccountData(this.addr.fxBook(a, b))) !== null) return;
    const ix = await this.program.methods
      .createFxBook(codeBytes(a), codeBytes(b))
      .accountsPartial({ admin: this.admin.publicKey, config: this.addr.config(), book: this.addr.fxBook(a, b) })
      .instruction();
    await this.send([ix]);
  }

  private async nextOrderSeq(): Promise<number> {
    const data = await this.chain.getAccountData(this.addr.config());
    if (!data) throw new LedgerError('invalid_state', 'ledger is not bootstrapped (no config account)');
    return toSafeNumber(data.readBigUInt64LE(CONFIG_NEXT_ORDER_OFFSET));
  }

  /** Books are created on first use. */
  private async ensureBook(planet: PlanetId, good: GoodId): Promise<void> {
    if ((await this.chain.getAccountData(this.addr.book(planet, good))) !== null) return;
    const ix = await this.program.methods
      .createBook(idKey(planet), idKey(good))
      .accountsPartial({ admin: this.admin.publicKey, config: this.addr.config(), book: this.addr.book(planet, good) })
      .instruction();
    await this.send([ix]);
  }

  /** Resting orders of one book in placement order, or null if the book was never created. */
  private async readBook(planet: PlanetId, good: GoodId): Promise<BookOrder[] | null> {
    return this.readBookAt(this.addr.book(planet, good));
  }

  private async readBookAt(address: PublicKey): Promise<BookOrder[] | null> {
    const data = await this.chain.getAccountData(address);
    if (!data) return null;
    const len = Number(data.readBigUInt64LE(BOOK_LEN_OFFSET));
    const out: BookOrder[] = [];
    for (let i = 0; i < len; i++) {
      const at = BOOK_SLOTS_OFFSET + i * ORDER_SIZE;
      out.push({
        seq: toSafeNumber(data.readBigUInt64LE(at)),
        ownerKey: Buffer.from(data.subarray(at + 8, at + 40)),
        qty: data.readBigUInt64LE(at + 40),
        limit: data.readBigUInt64LE(at + 48),
        cycle: toSafeNumber(data.readBigUInt64LE(at + 56)),
        side: data.readUInt8(at + 64) === 0 ? 'buy' : 'sell',
      });
    }
    return out;
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

/** Both currencies of a pair in the alphabetical order the program uses. */
const pairOf = (x: CurrencyId, y: CurrencyId): [CurrencyId, CurrencyId] => (x < y ? [x, y] : [y, x]);

const slotKey = (owner: OwnerId, good: GoodId) => `${Buffer.from(idKey(owner)).toString('hex')}|${good}`;

function toCargo(cargo: Cargo[]) {
  return cargo.map((c) => ({ good: idKey(c.good), qty: new BN(c.qty) }));
}

function toSafeNumber(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new LedgerError('invalid_amount', `on-chain value ${n} exceeds the safe integer range`);
  return Number(n);
}
