import { AgentIdSchema, LedgerError, RATE_SCALE } from '@orbital/contracts';
import type {
  ArriveResult, AuctionResult, BorrowRequest, Cargo, CurrencyId, DepartRequest, Fill, FxAuctionResult, FxFill, FxOrder,
  GoodId, InvariantReport, Ledger, Loan, MinorUnits, OpenAccountRequest, Order, OrderId, OrderRecord, OwnerId,
  PlaceOrdersResult, PlanetId, PolicyInstruction, PolicyState, RepayRequest, Shipment, ShipmentId, WorldConfig,
} from '@orbital/contracts';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const SCALE = BigInt(RATE_SCALE);

const isInt = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
const fail = (code: ConstructorParameters<typeof LedgerError>[0], msg: string): never => {
  throw new LedgerError(code, msg);
};
/** Exact product of two safe integers; throws `invalid_amount` if it is not a safe integer. */
const mul = (a: number, b: number): number => {
  const p = BigInt(a) * BigInt(b);
  return p > MAX ? fail('invalid_amount', `product ${p} exceeds the safe-integer range`) : Number(p);
};
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const bmin = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const cmp = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
const INF = 1n << 200n; // stands in for an uncapped buyer limit when sorting

interface LocalOrder { rec: OrderRecord; seq: number; remaining: number; escrow: number }
interface FxEntry { id: OrderId; seq: number; order: FxOrder; escrow: number }
interface LoanState { loan: Loan; lastAccrual: number }

export class InMemoryLedger implements Ledger {
  private readonly accounts = new Set<OwnerId>();
  private readonly purses = new Map<string, number>(); // `${owner}|${currency}`
  private readonly inv = new Map<string, number>(); // `${owner}|${planet}|${good}`
  private readonly orders = new Map<OrderId, LocalOrder>();
  private readonly fxOrders = new Map<OrderId, FxEntry>();
  private readonly shipments = new Map<ShipmentId, Shipment>();
  private readonly loans = new Map<string, LoanState>();
  private readonly policies = new Map<PlanetId, PolicyState>();
  private readonly lastPrice = new Map<string, number>(); // `${planet}|${good}`
  private readonly quotaUsed = new Map<string, number>(); // `${planet}|${good}|${cycle}`
  private readonly expectedCurrency = new Map<CurrencyId, number>();
  private readonly expectedGoods = new Map<GoodId, number>();
  private readonly currencyOf = new Map<PlanetId, CurrencyId>();
  private readonly planetOfCurrency = new Map<CurrencyId, PlanetId>();
  private readonly basePrice = new Map<GoodId, number>();
  private orderCounter = 0;
  private shipmentCounter = 0;
  private loanCounter = 0;

  constructor(world: WorldConfig) {
    for (const p of world.planets) {
      this.currencyOf.set(p.id, p.currency);
      this.planetOfCurrency.set(p.currency, p.id);
      this.expectedCurrency.set(p.currency, 0);
      this.policies.set(p.id, { tariffsBp: {}, quotas: {}, embargoes: [], policyRateBp: 0 });
    }
    for (const g of world.goods) {
      this.basePrice.set(g.id, g.basePrice);
      this.expectedGoods.set(g.id, 0);
    }
  }

  // ---- validation / balance helpers -----------------------------------

  private planet(p: PlanetId): CurrencyId {
    return this.currencyOf.get(p) ?? fail('invalid_amount', `unknown planet ${p}`);
  }
  private good(g: GoodId): void {
    if (!this.basePrice.has(g)) fail('invalid_amount', `unknown good ${g}`);
  }
  private currency(c: CurrencyId): void {
    if (!this.planetOfCurrency.has(c)) fail('invalid_amount', `unknown currency ${c}`);
  }
  private account(o: OwnerId): void {
    if (!this.accounts.has(o)) fail('unknown_account', `no account for ${o}`);
  }
  private cargo(cargo: Cargo[]): Map<GoodId, number> {
    const m = new Map<GoodId, number>();
    for (const c of cargo) {
      this.good(c.good);
      if (!isInt(c.qty, 1)) fail('invalid_amount', `qty must be a positive safe integer: ${c.qty}`);
      m.set(c.good, (m.get(c.good) ?? 0) + c.qty);
    }
    for (const q of m.values()) if (!isInt(q, 1)) fail('invalid_amount', 'aggregate cargo exceeds the safe-integer range');
    return m;
  }
  private purse(o: OwnerId, c: CurrencyId): number {
    return this.purses.get(`${o}|${c}`) ?? 0;
  }
  private addPurse(o: OwnerId, c: CurrencyId, d: number): void {
    this.purses.set(`${o}|${c}`, this.purse(o, c) + d);
  }
  private stock(o: OwnerId, p: PlanetId, g: GoodId): number {
    return this.inv.get(`${o}|${p}|${g}`) ?? 0;
  }
  private addStock(o: OwnerId, p: PlanetId, g: GoodId, d: number): void {
    this.inv.set(`${o}|${p}|${g}`, this.stock(o, p, g) + d);
  }
  private bump(m: Map<string, number>, k: string, d: number): void {
    m.set(k, (m.get(k) ?? 0) + d);
  }
  private requireStock(o: OwnerId, p: PlanetId, need: Map<GoodId, number>): void {
    for (const [g, q] of need) if (this.stock(o, p, g) < q) fail('insufficient_inventory', `${o} has ${this.stock(o, p, g)} ${g} on ${p}, needs ${q}`);
  }
  private newOrderId(): { id: OrderId; seq: number } {
    const seq = ++this.orderCounter;
    return { id: `o${seq}`, seq };
  }

  // ---- accounts ---------------------------------------------------------

  async openAccount(req: OpenAccountRequest): Promise<void> {
    if (!AgentIdSchema.safeParse(req.owner).success) fail('invalid_amount', `invalid owner id ${req.owner}`);
    this.planet(req.planet);
    const purse = Object.entries(req.purse ?? {});
    const inventory = Object.entries(req.inventory ?? {});
    for (const [c, a] of purse) {
      this.currency(c);
      if (!isInt(a, 0)) fail('invalid_amount', `bad purse amount for ${c}`);
    }
    for (const [g, q] of inventory) {
      this.good(g);
      if (!isInt(q, 0)) fail('invalid_amount', `bad inventory qty for ${g}`);
    }
    if (this.accounts.has(req.owner)) fail('invalid_state', `account ${req.owner} already open`);
    this.accounts.add(req.owner);
    for (const [c, a] of purse) {
      this.addPurse(req.owner, c, a);
      this.bump(this.expectedCurrency, c, a);
    }
    for (const [g, q] of inventory) {
      this.addStock(req.owner, req.planet, g, q);
      this.bump(this.expectedGoods, g, q);
    }
  }

  async getPurse(owner: OwnerId, currency: CurrencyId): Promise<MinorUnits> {
    this.currency(currency);
    this.account(owner);
    return this.purse(owner, currency);
  }

  async getInventory(owner: OwnerId, planet: PlanetId, good: GoodId): Promise<number> {
    this.planet(planet);
    this.good(good);
    this.account(owner);
    return this.stock(owner, planet, good);
  }

  async transfer(req: { from: OwnerId; to: OwnerId; currency: CurrencyId; amount: MinorUnits }): Promise<void> {
    this.currency(req.currency);
    if (!isInt(req.amount, 0)) fail('invalid_amount', `bad amount ${req.amount}`);
    this.account(req.from);
    this.account(req.to);
    if (this.purse(req.from, req.currency) < req.amount) fail('insufficient_funds', `${req.from} lacks ${req.amount} ${req.currency}`);
    this.addPurse(req.from, req.currency, -req.amount);
    this.addPurse(req.to, req.currency, req.amount);
  }

  async produce(req: { owner: OwnerId; planet: PlanetId; inputs: Cargo[]; outputs: Cargo[] }): Promise<void> {
    this.planet(req.planet);
    const inputs = this.cargo(req.inputs);
    const outputs = this.cargo(req.outputs);
    this.account(req.owner);
    this.requireStock(req.owner, req.planet, inputs);
    for (const [g, q] of inputs) {
      this.addStock(req.owner, req.planet, g, -q);
      this.bump(this.expectedGoods, g, -q);
    }
    for (const [g, q] of outputs) {
      this.addStock(req.owner, req.planet, g, q);
      this.bump(this.expectedGoods, g, q);
    }
  }

  async consume(req: { owner: OwnerId; planet: PlanetId; cargo: Cargo[] }): Promise<void> {
    await this.produce({ owner: req.owner, planet: req.planet, inputs: req.cargo, outputs: [] });
  }

  // ---- local orders -------------------------------------------------------

  async placeOrders(orders: Order[], cycle: number): Promise<PlaceOrdersResult> {
    if (!isInt(cycle, 0)) fail('invalid_amount', `bad cycle ${cycle}`);
    const result: PlaceOrdersResult = { accepted: [], rejected: [] };
    orders.forEach((o, index) => {
      try {
        result.accepted.push({ index, orderId: this.placeOne(o, cycle) });
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        result.rejected.push({ index, error: e.toJSON() });
      }
    });
    return result;
  }

  private placeOne(o: Order, cycle: number): OrderId {
    const cur = this.planet(o.planet);
    this.good(o.good);
    if (o.side !== 'buy' && o.side !== 'sell') fail('invalid_amount', `bad side ${String(o.side)}`);
    if (!isInt(o.qty, 1)) fail('invalid_amount', `qty must be a positive safe integer: ${o.qty}`);
    if (!isInt(o.limitPrice, 0)) fail('invalid_amount', `bad limitPrice ${o.limitPrice}`);
    this.account(o.agentId);
    let escrow: number;
    if (o.side === 'buy') {
      escrow = mul(o.qty, o.limitPrice);
      if (this.purse(o.agentId, cur) < escrow) fail('insufficient_funds', `${o.agentId} lacks ${escrow} ${cur}`);
      this.addPurse(o.agentId, cur, -escrow);
    } else {
      escrow = o.qty;
      this.requireStock(o.agentId, o.planet, new Map([[o.good, o.qty]]));
      this.addStock(o.agentId, o.planet, o.good, -escrow);
    }
    const { id, seq } = this.newOrderId();
    this.orders.set(id, { rec: { ...o, orderId: id, cycle }, seq, remaining: o.qty, escrow });
    return id;
  }

  async cancelOrder(orderId: OrderId): Promise<void> {
    const o = this.orders.get(orderId);
    if (o) {
      const { agentId, planet, good, side } = o.rec;
      if (side === 'buy') this.addPurse(agentId, this.planet(planet), o.escrow);
      else this.addStock(agentId, planet, good, o.escrow);
      this.orders.delete(orderId);
      return;
    }
    const fx = this.fxOrders.get(orderId);
    if (!fx) return fail('unknown_order', `order ${orderId} is not open`);
    this.addPurse(fx.order.agentId, fx.order.give, fx.escrow);
    this.fxOrders.delete(orderId);
  }

  async openOrders(agentId: string): Promise<OrderRecord[]> {
    this.account(agentId);
    return [...this.orders.values()]
      .filter((o) => o.rec.agentId === agentId)
      .sort((a, b) => a.seq - b.seq)
      .map((o) => ({ ...o.rec, qty: o.remaining }));
  }

  async clearLocalAuction(planet: PlanetId, good: GoodId, cycle: number): Promise<AuctionResult> {
    const cur = this.planet(planet);
    this.good(good);
    if (!isInt(cycle, 0)) fail('invalid_amount', `bad cycle ${cycle}`);
    const book = [...this.orders.values()].filter((o) => o.rec.planet === planet && o.rec.good === good);
    const buys = book.filter((o) => o.rec.side === 'buy');
    const sells = book.filter((o) => o.rec.side === 'sell');
    const sum = (xs: LocalOrder[], pred: (o: LocalOrder) => boolean) => xs.reduce((s, o) => s + (pred(o) ? o.remaining : 0), 0);

    let best: { p: number; v: number; gap: number } | null = null;
    for (const p of new Set(book.map((o) => o.rec.limitPrice))) {
      const d = sum(buys, (o) => o.rec.limitPrice >= p);
      const s = sum(sells, (o) => o.rec.limitPrice <= p);
      const v = Math.min(d, s);
      const gap = Math.abs(d - s);
      if (v > 0 && (!best || v > best.v || (v === best.v && (gap < best.gap || (gap === best.gap && p < best.p))))) best = { p, v, gap };
    }
    if (!best) return { planet, good, cycle, clearingPrice: null, volume: 0, fills: [] };

    const { p, v } = best;
    const alloc = (side: LocalOrder[], elig: (o: LocalOrder) => boolean, cmp: (a: LocalOrder, b: LocalOrder) => number) => {
      let left = v;
      const out: { o: LocalOrder; q: number }[] = [];
      for (const o of side.filter(elig).sort((a, b) => cmp(a, b) || a.seq - b.seq)) {
        const q = Math.min(left, o.remaining);
        if (q > 0) out.push({ o, q });
        left -= q;
      }
      return out;
    };
    const buyFills = alloc(buys, (o) => o.rec.limitPrice >= p, (a, b) => b.rec.limitPrice - a.rec.limitPrice);
    const sellFills = alloc(sells, (o) => o.rec.limitPrice <= p, (a, b) => a.rec.limitPrice - b.rec.limitPrice);
    const fills: Fill[] = [...buyFills, ...sellFills].map(({ o, q }) => ({
      orderId: o.rec.orderId, agentId: o.rec.agentId, good, side: o.rec.side, qty: q, price: p, total: mul(q, p),
    }));

    for (const { o, q } of buyFills) {
      this.addStock(o.rec.agentId, planet, good, q);
      this.addPurse(o.rec.agentId, cur, mul(q, o.rec.limitPrice - p)); // refund of the price improvement
      o.escrow -= mul(q, o.rec.limitPrice);
      this.settle(o, q);
    }
    for (const { o, q } of sellFills) {
      this.addPurse(o.rec.agentId, cur, mul(q, p));
      o.escrow -= q;
      this.settle(o, q);
    }
    this.lastPrice.set(`${planet}|${good}`, p);
    return { planet, good, cycle, clearingPrice: p, volume: v, fills };
  }

  private settle(o: LocalOrder, q: number): void {
    o.remaining -= q;
    if (o.remaining === 0) this.orders.delete(o.rec.orderId);
  }

  // ---- FX -----------------------------------------------------------------

  async placeFxOrders(orders: FxOrder[], cycle: number): Promise<PlaceOrdersResult> {
    if (!isInt(cycle, 0)) fail('invalid_amount', `bad cycle ${cycle}`);
    const result: PlaceOrdersResult = { accepted: [], rejected: [] };
    orders.forEach((o, index) => {
      try {
        this.currency(o.give);
        this.currency(o.want);
        if (o.give === o.want) fail('invalid_amount', 'give and want must differ');
        if (!isInt(o.giveAmount, 1)) fail('invalid_amount', `giveAmount must be a positive safe integer: ${o.giveAmount}`);
        if (!isInt(o.minReceive, 0)) fail('invalid_amount', `bad minReceive ${o.minReceive}`);
        this.account(o.agentId);
        if (this.purse(o.agentId, o.give) < o.giveAmount) fail('insufficient_funds', `${o.agentId} lacks ${o.giveAmount} ${o.give}`);
        this.addPurse(o.agentId, o.give, -o.giveAmount);
        const { id, seq } = this.newOrderId();
        this.fxOrders.set(id, { id, seq, order: { ...o }, escrow: o.giveAmount });
        result.accepted.push({ index, orderId: id });
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        result.rejected.push({ index, error: e.toJSON() });
      }
    });
    return result;
  }

  async clearFxAuction(base: CurrencyId, quote: CurrencyId, cycle: number): Promise<FxAuctionResult> {
    this.currency(base);
    this.currency(quote);
    if (base === quote) fail('invalid_amount', 'base and quote must differ');
    if (!isInt(cycle, 0)) fail('invalid_amount', `bad cycle ${cycle}`);
    const all = [...this.fxOrders.values()];
    // Limit rates in ppm. Seller (gives base): accepts r >= limit. Buyer (gives quote): accepts r <= limit (null = no cap).
    const sellers = all.filter((e) => e.order.give === base && e.order.want === quote)
      .map((e) => ({ e, limit: ceilDiv(BigInt(e.order.minReceive) * SCALE, BigInt(e.order.giveAmount)) }));
    const buyers = all.filter((e) => e.order.give === quote && e.order.want === base)
      .map((e) => ({ e, limit: e.order.minReceive === 0 ? null : (BigInt(e.order.giveAmount) * SCALE) / BigInt(e.order.minReceive) }));
    const buyerCap = (b: { e: FxEntry }, r: bigint) => (BigInt(b.e.order.giveAmount) * SCALE) / r;

    const cands = new Set<bigint>();
    for (const x of [...sellers, ...buyers]) if (x.limit !== null && x.limit >= 1n && x.limit <= MAX) cands.add(x.limit);
    let best: { r: bigint; v: bigint; gap: bigint } | null = null;
    for (const r of cands) {
      const s = sellers.reduce((t, x) => (x.limit <= r ? t + BigInt(x.e.order.giveAmount) : t), 0n);
      const d = buyers.reduce((t, x) => (x.limit === null || x.limit >= r ? t + buyerCap(x, r) : t), 0n);
      const v = bmin(s, d);
      const gap = s > d ? s - d : d - s;
      if (v > 0n && (!best || v > best.v || (v === best.v && (gap < best.gap || (gap === best.gap && r < best.r))))) best = { r, v, gap };
    }

    // spent/received per order; everything is computed before any state is touched.
    const spent = new Map<OrderId, { spent: number; received: number }>();
    let dust = 0n;
    if (best) {
      const { r, v } = best;
      let left = v;
      for (const x of sellers.filter((s) => s.limit <= r).sort((a, b) => cmp(a.limit, b.limit) || a.e.seq - b.e.seq)) {
        const s = bmin(left, BigInt(x.e.order.giveAmount));
        if (s > 0n) spent.set(x.e.id, { spent: Number(s), received: Number((s * r) / SCALE) });
        dust -= (s * r) / SCALE;
        left -= s;
      }
      left = v;
      for (const x of buyers.filter((b) => b.limit === null || b.limit >= r)
        .sort((a, b) => cmp(b.limit ?? INF, a.limit ?? INF) || a.e.seq - b.e.seq)) {
        const b = bmin(left, buyerCap(x, r));
        if (b > 0n) {
          const pay = ceilDiv(b * r, SCALE);
          spent.set(x.e.id, { spent: Number(pay), received: Number(b) });
          dust += pay;
        }
        left -= b;
      }
    }
    const treasury = this.planetOfCurrency.get(quote)!;
    if (dust > 0n) this.account(treasury);

    const fills: FxFill[] = [];
    for (const x of [...sellers, ...buyers]) {
      const o = x.e.order;
      const s = spent.get(x.e.id);
      if (s) fills.push({ orderId: x.e.id, agentId: o.agentId, give: o.give, giveAmount: s.spent, want: o.want, receiveAmount: s.received });
      this.addPurse(o.agentId, o.give, x.e.escrow - (s?.spent ?? 0));
      this.addPurse(o.agentId, o.want, s?.received ?? 0);
      this.fxOrders.delete(x.e.id);
    }
    if (dust > 0n) this.addPurse(treasury, quote, Number(dust));
    return { base, quote, cycle, ratePpm: best ? Number(best.r) : null, fills };
  }

  // ---- shipping -----------------------------------------------------------

  async depart(req: DepartRequest): Promise<Shipment> {
    this.planet(req.from);
    this.planet(req.to);
    if (req.from === req.to) fail('invalid_amount', 'from and to must differ');
    if (!isInt(req.cycle, 0) || !isInt(req.arriveCycle, 0) || req.arriveCycle <= req.cycle) fail('invalid_amount', 'arriveCycle must be after cycle');
    if (req.cargo.length === 0) fail('invalid_amount', 'cargo must not be empty');
    const need = this.cargo(req.cargo);
    this.account(req.owner);
    this.requireStock(req.owner, req.from, need);
    for (const [g, q] of need) this.addStock(req.owner, req.from, g, -q);
    const shipment: Shipment = {
      id: `s${++this.shipmentCounter}`, owner: req.owner, from: req.from, to: req.to,
      cargo: [...need].map(([good, qty]) => ({ good, qty })), departCycle: req.cycle, arriveCycle: req.arriveCycle, status: 'in_flight',
    };
    this.shipments.set(shipment.id, shipment);
    return structuredClone(shipment);
  }

  async arrive(shipmentId: ShipmentId, cycle: number): Promise<ArriveResult> {
    const s = this.shipments.get(shipmentId) ?? fail('unknown_shipment', `unknown shipment ${shipmentId}`);
    if (!isInt(cycle, 0)) fail('invalid_amount', `bad cycle ${cycle}`);
    if (s.status !== 'in_flight') fail('invalid_state', `shipment ${s.id} already arrived`);
    if (cycle < s.arriveCycle) fail('invalid_state', `shipment ${s.id} arrives at cycle ${s.arriveCycle}`);
    const policy = this.policies.get(s.to)!;
    const embargoed = policy.embargoes.includes(s.from);
    const delivered: Cargo[] = [];
    const withheld: Cargo[] = [];
    const used: [string, number][] = [];
    let duty = 0n;
    for (const { good, qty } of s.cargo) {
      let ok = embargoed ? 0 : qty;
      const quota = policy.quotas[good];
      const key = `${s.to}|${good}|${cycle}`;
      if (!embargoed && quota !== undefined) {
        ok = Math.min(qty, Math.max(0, quota - (this.quotaUsed.get(key) ?? 0)));
        used.push([key, ok]);
      }
      if (ok > 0) {
        delivered.push({ good, qty: ok });
        const t = policy.tariffsBp[good];
        if (t) duty += (BigInt(ok) * BigInt(this.lastPrice.get(`${s.to}|${good}`) ?? this.basePrice.get(good)!) * BigInt(t)) / 10_000n;
      }
      if (ok < qty) withheld.push({ good, qty: qty - ok });
    }
    const cur = this.planet(s.to);
    if (duty > 0n) this.account(s.to);
    const collected = duty > 0n ? Math.min(Number(duty > MAX ? MAX : duty), this.purse(s.owner, cur)) : 0;

    for (const [k, n] of used) this.bump(this.quotaUsed, k, n);
    for (const c of delivered) this.addStock(s.owner, s.to, c.good, c.qty);
    for (const c of withheld) this.addStock(s.owner, s.from, c.good, c.qty);
    if (collected > 0) {
      this.addPurse(s.owner, cur, -collected);
      this.addPurse(s.to, cur, collected);
    }
    s.status = 'arrived';
    return { shipment: structuredClone(s), delivered, withheld, duty: { currency: cur, amount: collected } };
  }

  // ---- credit -------------------------------------------------------------

  async borrow(req: BorrowRequest): Promise<Loan> {
    const cur = this.planet(req.planet);
    if (!isInt(req.amount, 1)) fail('invalid_amount', `amount must be a positive safe integer: ${req.amount}`);
    if (!isInt(req.termCycles, 1) || !isInt(req.cycle, 0)) fail('invalid_amount', 'bad termCycles or cycle');
    this.account(req.borrower);
    const loan: Loan = {
      id: `l${++this.loanCounter}`, borrower: req.borrower, planet: req.planet, currency: cur, principal: req.amount,
      outstanding: req.amount, rateBp: this.policies.get(req.planet)!.policyRateBp, issuedCycle: req.cycle, dueCycle: req.cycle + req.termCycles,
    };
    this.loans.set(loan.id, { loan, lastAccrual: req.cycle });
    this.addPurse(req.borrower, cur, req.amount);
    this.bump(this.expectedCurrency, cur, req.amount);
    return { ...loan };
  }

  async repay(req: RepayRequest): Promise<Loan> {
    const st = this.loans.get(req.loanId) ?? fail('unknown_loan', `unknown loan ${req.loanId}`);
    const { loan } = st;
    if (!isInt(req.amount, 1) || !isInt(req.cycle, 0)) fail('invalid_amount', 'bad amount or cycle');
    if (loan.outstanding === 0) fail('invalid_state', `loan ${loan.id} is already repaid`);
    if (req.cycle < st.lastAccrual) fail('invalid_state', `cycle ${req.cycle} is before last accrual ${st.lastAccrual}`);
    const interest = (BigInt(loan.principal) * BigInt(loan.rateBp) * BigInt(req.cycle - st.lastAccrual)) / 10_000n;
    const outstanding = loan.outstanding + Number(interest);
    if (!Number.isSafeInteger(outstanding)) fail('invalid_amount', 'outstanding exceeds the safe-integer range');
    const pay = Math.min(req.amount, outstanding);
    if (this.purse(loan.borrower, loan.currency) < pay) fail('insufficient_funds', `${loan.borrower} lacks ${pay} ${loan.currency}`);
    this.addPurse(loan.borrower, loan.currency, -pay);
    this.bump(this.expectedCurrency, loan.currency, -pay);
    loan.outstanding = outstanding - pay;
    st.lastAccrual = req.cycle;
    return { ...loan };
  }

  // ---- policy -------------------------------------------------------------

  async applyPolicy(ins: PolicyInstruction): Promise<void> {
    this.planet(ins.planet);
    const pol = this.policies.get(ins.planet)!;
    switch (ins.kind) {
      case 'set_tariff':
        this.good(ins.good);
        if (!isInt(ins.rateBp, 0) || ins.rateBp > 10_000) fail('invalid_amount', `bad rateBp ${ins.rateBp}`);
        if (ins.rateBp === 0) delete pol.tariffsBp[ins.good];
        else pol.tariffsBp[ins.good] = ins.rateBp;
        break;
      case 'set_quota':
        this.good(ins.good);
        if (!isInt(ins.maxPerCycle, 0)) fail('invalid_amount', `bad maxPerCycle ${ins.maxPerCycle}`);
        pol.quotas[ins.good] = ins.maxPerCycle;
        break;
      case 'set_embargo': {
        this.planet(ins.target);
        if (ins.target === ins.planet) fail('invalid_amount', 'a planet cannot embargo itself');
        const set = new Set(pol.embargoes);
        if (ins.active) set.add(ins.target);
        else set.delete(ins.target);
        pol.embargoes = [...set].sort();
        break;
      }
      case 'set_policy_rate':
        if (!isInt(ins.rateBp, 0) || ins.rateBp > 10_000) fail('invalid_amount', `bad rateBp ${ins.rateBp}`);
        pol.policyRateBp = ins.rateBp;
        break;
    }
  }

  async getPolicy(planet: PlanetId): Promise<PolicyState> {
    this.planet(planet);
    return structuredClone(this.policies.get(planet)!);
  }

  // ---- invariants -----------------------------------------------------------

  async checkInvariants(): Promise<InvariantReport> {
    const violations: InvariantReport['violations'] = [];
    const cur: Record<string, number> = Object.fromEntries([...this.planetOfCurrency.keys()].map((c) => [c, 0]));
    const goods: Record<string, number> = Object.fromEntries([...this.basePrice.keys()].map((g) => [g, 0]));
    const negative = (what: string, n: number) => {
      if (!Number.isSafeInteger(n) || n < 0) violations.push({ code: 'negative_balance', message: `${what} = ${n}` });
    };
    for (const [k, n] of this.purses) {
      negative(`purse ${k}`, n);
      cur[k.split('|')[1]!]! += n;
    }
    for (const [k, n] of this.inv) {
      negative(`inventory ${k}`, n);
      goods[k.split('|')[2]!]! += n;
    }
    for (const o of this.orders.values()) {
      const { orderId, planet, good, side, limitPrice } = o.rec;
      const want = side === 'buy' ? mul(o.remaining, limitPrice) : o.remaining;
      if (o.remaining < 1 || o.escrow !== want) violations.push({ code: 'escrow_mismatch', message: `order ${orderId} escrow ${o.escrow} != ${want}` });
      negative(`escrow ${orderId}`, o.escrow);
      if (side === 'buy') cur[this.currencyOf.get(planet)!]! += o.escrow;
      else goods[good]! += o.escrow;
    }
    for (const e of this.fxOrders.values()) {
      if (e.escrow !== e.order.giveAmount) violations.push({ code: 'escrow_mismatch', message: `fx order ${e.id} escrow ${e.escrow} != ${e.order.giveAmount}` });
      negative(`escrow ${e.id}`, e.escrow);
      cur[e.order.give]! += e.escrow;
    }
    for (const s of this.shipments.values()) if (s.status === 'in_flight') for (const c of s.cargo) goods[c.good]! += c.qty;
    for (const [c, n] of Object.entries(cur)) {
      if (n !== this.expectedCurrency.get(c)) violations.push({ code: 'currency_supply_mismatch', message: `${c}: total ${n} != expected ${this.expectedCurrency.get(c)}` });
    }
    for (const [g, n] of Object.entries(goods)) {
      if (n !== this.expectedGoods.get(g)) violations.push({ code: 'goods_supply_mismatch', message: `${g}: total ${n} != expected ${this.expectedGoods.get(g)}` });
    }
    return { ok: violations.length === 0, violations, totals: { currency: cur, goods } };
  }
}
