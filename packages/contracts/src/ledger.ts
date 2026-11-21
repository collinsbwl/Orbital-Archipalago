import { z } from 'zod';
import {
  AgentIdSchema, CurrencyIdSchema, GoodIdSchema, LoanIdSchema, MinorUnitsSchema, OrderIdSchema, PlanetIdSchema,
  QtySchema, RatePpmSchema, RateBpSchema, ShipmentIdSchema, StockSchema, CycleSchema,
} from './ids.js';
import type { AgentId, CurrencyId, GoodId, MinorUnits, OrderId, OwnerId, PlanetId, ShipmentId } from './ids.js';

// ---- Orders and auctions -------------------------------------------------

export const SideSchema = z.enum(['buy', 'sell']);
export type Side = z.infer<typeof SideSchema>;

/** Local-auction order. `limitPrice` = minor units of the planet's currency per 1 good unit. */
export const OrderSchema = z.object({
  agentId: AgentIdSchema,
  planet: PlanetIdSchema,
  good: GoodIdSchema,
  side: SideSchema,
  qty: QtySchema,
  limitPrice: MinorUnitsSchema,
});
export type Order = z.infer<typeof OrderSchema>;

/** A resting order. DEFAULT: orders rest (funds/goods escrowed) until filled or cancelled. */
export const OrderRecordSchema = OrderSchema.extend({ orderId: OrderIdSchema, cycle: CycleSchema });
export type OrderRecord = z.infer<typeof OrderRecordSchema>;

export const FillSchema = z.object({
  orderId: OrderIdSchema,
  agentId: AgentIdSchema,
  good: GoodIdSchema,
  side: SideSchema,
  qty: QtySchema,
  price: MinorUnitsSchema,
  total: MinorUnitsSchema,
});
export type Fill = z.infer<typeof FillSchema>;

/** Uniform-price batch auction result. `clearingPrice` is null when nothing crossed. */
export const AuctionResultSchema = z.object({
  planet: PlanetIdSchema,
  good: GoodIdSchema,
  cycle: CycleSchema,
  clearingPrice: MinorUnitsSchema.nullable(),
  volume: StockSchema,
  fills: z.array(FillSchema),
});
export type AuctionResult = z.infer<typeof AuctionResultSchema>;

/** FX order in integers only: give `giveAmount` of `give`, accept no less than `minReceive` of `want`. */
export const FxOrderSchema = z.object({
  agentId: AgentIdSchema,
  give: CurrencyIdSchema,
  giveAmount: QtySchema,
  want: CurrencyIdSchema,
  minReceive: MinorUnitsSchema,
});
export type FxOrder = z.infer<typeof FxOrderSchema>;

export const FxFillSchema = z.object({
  orderId: OrderIdSchema,
  agentId: AgentIdSchema,
  give: CurrencyIdSchema,
  giveAmount: MinorUnitsSchema,
  want: CurrencyIdSchema,
  receiveAmount: MinorUnitsSchema,
});
export type FxFill = z.infer<typeof FxFillSchema>;

export const FxAuctionResultSchema = z.object({
  base: CurrencyIdSchema,
  quote: CurrencyIdSchema,
  cycle: CycleSchema,
  /** Clearing rate, quote per base, in ppm (see RATE_SCALE). Null when nothing crossed. */
  ratePpm: RatePpmSchema.nullable(),
  fills: z.array(FxFillSchema),
});
export type FxAuctionResult = z.infer<typeof FxAuctionResultSchema>;

export interface PlaceOrdersResult {
  accepted: { index: number; orderId: OrderId }[];
  rejected: { index: number; error: LedgerErrorShape }[];
}

// ---- Shipping ------------------------------------------------------------

export const CargoSchema = z.object({ good: GoodIdSchema, qty: QtySchema });
export type Cargo = z.infer<typeof CargoSchema>;

export const ShipmentSchema = z.object({
  id: ShipmentIdSchema,
  owner: AgentIdSchema,
  from: PlanetIdSchema,
  to: PlanetIdSchema,
  cargo: z.array(CargoSchema).min(1),
  departCycle: CycleSchema,
  arriveCycle: CycleSchema,
  status: z.enum(['in_flight', 'arrived']),
});
export type Shipment = z.infer<typeof ShipmentSchema>;

export const DepartRequestSchema = z.object({
  owner: AgentIdSchema,
  from: PlanetIdSchema,
  to: PlanetIdSchema,
  cargo: z.array(CargoSchema).min(1),
  cycle: CycleSchema,
  /** Computed by the engine from orbits; the ledger just records it. */
  arriveCycle: CycleSchema,
});
export type DepartRequest = z.infer<typeof DepartRequestSchema>;

export const ArriveResultSchema = z.object({
  shipment: ShipmentSchema,
  delivered: z.array(CargoSchema),
  /** Cargo held back by embargo or quota. DEFAULT: returned to the owner's inventory on the origin planet. */
  withheld: z.array(CargoSchema),
  /** Tariff collected from the owner into the destination treasury. */
  duty: z.object({ currency: CurrencyIdSchema, amount: MinorUnitsSchema }),
});
export type ArriveResult = z.infer<typeof ArriveResultSchema>;

// ---- Credit --------------------------------------------------------------

export const LoanSchema = z.object({
  id: LoanIdSchema,
  borrower: AgentIdSchema,
  /** Lending planet (its reserve bank). Currency is that planet's. */
  planet: PlanetIdSchema,
  currency: CurrencyIdSchema,
  principal: MinorUnitsSchema,
  outstanding: MinorUnitsSchema,
  /** Interest rate per cycle in basis points. DEFAULT: simple interest, accrued on repay. */
  rateBp: RateBpSchema,
  issuedCycle: CycleSchema,
  dueCycle: CycleSchema,
});
export type Loan = z.infer<typeof LoanSchema>;

export const BorrowRequestSchema = z.object({
  borrower: AgentIdSchema,
  planet: PlanetIdSchema,
  amount: QtySchema,
  termCycles: z.number().int().min(1).max(1_000),
  cycle: CycleSchema,
});
export type BorrowRequest = z.infer<typeof BorrowRequestSchema>;

export const RepayRequestSchema = z.object({ loanId: LoanIdSchema, amount: QtySchema, cycle: CycleSchema });
export type RepayRequest = z.infer<typeof RepayRequestSchema>;

// ---- Policy --------------------------------------------------------------

export const SetTariffSchema = z.object({ kind: z.literal('set_tariff'), planet: PlanetIdSchema, good: GoodIdSchema, rateBp: RateBpSchema });
export const SetQuotaSchema = z.object({ kind: z.literal('set_quota'), planet: PlanetIdSchema, good: GoodIdSchema, maxPerCycle: StockSchema });
export const SetEmbargoSchema = z.object({ kind: z.literal('set_embargo'), planet: PlanetIdSchema, target: PlanetIdSchema, active: z.boolean() });
export const SetPolicyRateSchema = z.object({ kind: z.literal('set_policy_rate'), planet: PlanetIdSchema, rateBp: RateBpSchema });

export const PolicyInstructionSchema = z.discriminatedUnion('kind', [SetTariffSchema, SetQuotaSchema, SetEmbargoSchema, SetPolicyRateSchema]);
export type PolicyInstruction = z.infer<typeof PolicyInstructionSchema>;

export const PolicyStateSchema = z.object({
  tariffsBp: z.record(GoodIdSchema, RateBpSchema),
  quotas: z.record(GoodIdSchema, StockSchema),
  embargoes: z.array(PlanetIdSchema),
  policyRateBp: RateBpSchema,
});
export type PolicyState = z.infer<typeof PolicyStateSchema>;

// ---- Errors and invariants ----------------------------------------------

export const LedgerErrorCodeSchema = z.enum([
  'insufficient_funds', 'insufficient_inventory', 'unknown_account', 'unknown_order', 'unknown_shipment',
  'unknown_loan', 'embargoed', 'quota_exceeded', 'invalid_amount', 'invalid_state',
]);
export type LedgerErrorCode = z.infer<typeof LedgerErrorCodeSchema>;

export const LedgerErrorShapeSchema = z.object({ code: LedgerErrorCodeSchema, message: z.string() });
export type LedgerErrorShape = z.infer<typeof LedgerErrorShapeSchema>;

/** Thrown by Ledger methods for rule violations (per-order rejects come back in PlaceOrdersResult). */
export class LedgerError extends Error {
  constructor(readonly code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
  }
  toJSON(): LedgerErrorShape {
    return { code: this.code, message: this.message };
  }
}

export const InvariantReportSchema = z.object({
  ok: z.boolean(),
  violations: z.array(z.object({ code: z.string(), message: z.string() })),
  /** Money supply per currency and goods totals (incl. escrow and in-flight cargo). */
  totals: z.object({ currency: z.record(CurrencyIdSchema, MinorUnitsSchema), goods: z.record(GoodIdSchema, StockSchema) }),
});
export type InvariantReport = z.infer<typeof InvariantReportSchema>;

// ---- The interface -------------------------------------------------------

export interface OpenAccountRequest {
  owner: OwnerId;
  /** Home planet. Starting `inventory` is placed here. */
  planet: PlanetId;
  purse?: Record<CurrencyId, MinorUnits>;
  inventory?: Record<GoodId, number>;
}

/**
 * Implemented by InMemoryLedger (Track A) and SolanaLedger (Track C); both run the same contract suite.
 * All amounts are integers. Methods are async because the Solana impl is.
 * Goods are located: inventory is keyed by (owner, planet, good) and only moves between planets via depart/arrive.
 * Purses are keyed by currency only (each currency belongs to one planet).
 */
export interface Ledger {
  openAccount(req: OpenAccountRequest): Promise<void>;
  getPurse(owner: OwnerId, currency: CurrencyId): Promise<MinorUnits>;
  getInventory(owner: OwnerId, planet: PlanetId, good: GoodId): Promise<number>;
  transfer(req: { from: OwnerId; to: OwnerId; currency: CurrencyId; amount: MinorUnits }): Promise<void>;
  /** Consume `inputs` and create `outputs` in an owner's inventory on `planet` (production). */
  produce(req: { owner: OwnerId; planet: PlanetId; inputs: Cargo[]; outputs: Cargo[] }): Promise<void>;
  /** Destroy goods on `planet` (household consumption). */
  consume(req: { owner: OwnerId; planet: PlanetId; cargo: Cargo[] }): Promise<void>;

  /** Escrows funds (buys) or goods held on `order.planet` (sells). Invalid orders are rejected individually. */
  placeOrders(orders: Order[], cycle: number): Promise<PlaceOrdersResult>;
  cancelOrder(orderId: OrderId): Promise<void>;
  openOrders(agentId: AgentId): Promise<OrderRecord[]>;
  clearLocalAuction(planet: PlanetId, good: GoodId, cycle: number): Promise<AuctionResult>;

  placeFxOrders(orders: FxOrder[], cycle: number): Promise<PlaceOrdersResult>;
  clearFxAuction(base: CurrencyId, quote: CurrencyId, cycle: number): Promise<FxAuctionResult>;

  depart(req: DepartRequest): Promise<Shipment>;
  arrive(shipmentId: ShipmentId, cycle: number): Promise<ArriveResult>;

  borrow(req: BorrowRequest): Promise<Loan>;
  repay(req: RepayRequest): Promise<Loan>;

  applyPolicy(instruction: PolicyInstruction): Promise<void>;
  getPolicy(planet: PlanetId): Promise<PolicyState>;

  /** Conservation of goods and money, non-negative balances, escrow consistency. */
  checkInvariants(): Promise<InvariantReport>;
}
