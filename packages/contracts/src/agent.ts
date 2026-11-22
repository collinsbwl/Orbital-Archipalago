import { z } from 'zod';
import {
  AgentIdSchema, CurrencyIdSchema, CycleSchema, GoodIdSchema, LoanIdSchema, MinorUnitsSchema, OrderIdSchema,
  PlanetIdSchema, QtySchema, RatePpmSchema, StockSchema, UniverseIdSchema,
} from './ids.js';
import {
  CargoSchema, LoanSchema, OrderRecordSchema, PolicyStateSchema, SetEmbargoSchema, SetPolicyRateSchema,
  SetQuotaSchema, SetTariffSchema, ShipmentSchema, SideSchema,
} from './ledger.js';
import { UsageSchema } from './gateway.js';

export const ROLES = ['colonist', 'trader', 'government', 'reserve_bank', 'news', 'economist'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

// ---- Actions -------------------------------------------------------------
// Keep these simple (no transforms/refinements): they are exported as model tool/JSON schemas.
// The acting agent's planet is implied by the task, so actions carry no `planet`.

export const ACTION_KINDS = [
  'place_order', 'cancel_order', 'place_fx_order', 'ship', 'borrow', 'repay',
  'set_tariff', 'set_quota', 'set_embargo', 'set_policy_rate', 'publish_headlines', 'write_report', 'pass',
] as const;
export const ActionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('place_order'), good: GoodIdSchema, side: SideSchema, qty: QtySchema, limitPrice: MinorUnitsSchema }),
  z.object({ kind: z.literal('cancel_order'), orderId: OrderIdSchema }),
  z.object({ kind: z.literal('place_fx_order'), give: CurrencyIdSchema, giveAmount: QtySchema, want: CurrencyIdSchema, minReceive: MinorUnitsSchema }),
  z.object({ kind: z.literal('ship'), to: PlanetIdSchema, cargo: z.array(CargoSchema).min(1).max(8) }),
  z.object({ kind: z.literal('borrow'), amount: QtySchema, termCycles: z.number().int().min(1).max(1_000) }),
  z.object({ kind: z.literal('repay'), loanId: LoanIdSchema, amount: QtySchema }),
  SetTariffSchema.omit({ planet: true }),
  SetQuotaSchema.omit({ planet: true }),
  SetEmbargoSchema.omit({ planet: true }),
  SetPolicyRateSchema.omit({ planet: true }),
  z.object({ kind: z.literal('publish_headlines'), headlines: z.array(z.string().max(160)).min(1).max(5) }),
  z.object({ kind: z.literal('write_report'), text: z.string().max(20_000) }),
  z.object({ kind: z.literal('pass') }),
]);
export type Action = z.infer<typeof ActionSchema>;

// ---- Observation ---------------------------------------------------------

const BookLevelSchema = z.object({ price: MinorUnitsSchema, qty: QtySchema });
export const MarketViewSchema = z.object({
  good: GoodIdSchema,
  bids: z.array(BookLevelSchema).max(3),
  asks: z.array(BookLevelSchema).max(3),
  lastPrice: MinorUnitsSchema.nullable(),
  /** Last up to 5 clearing prices, oldest first. */
  trend: z.array(MinorUnitsSchema).max(5),
});
export type MarketView = z.infer<typeof MarketViewSchema>;

export const FxViewSchema = z.object({ base: CurrencyIdSchema, quote: CurrencyIdSchema, lastRatePpm: RatePpmSchema.nullable() });

/** Compact state an agent sees. DEFAULT: shape is a first cut; Track B may add fields (minor bump). */
export const ObservationSchema = z.object({
  purse: z.record(CurrencyIdSchema, MinorUnitsSchema),
  /** Goods the agent holds on the task's planet. */
  inventory: z.record(GoodIdSchema, StockSchema),
  openOrders: z.array(OrderRecordSchema).max(20),
  loans: z.array(LoanSchema).max(10),
  shipments: z.array(ShipmentSchema).max(10),
  markets: z.array(MarketViewSchema).max(16),
  fx: z.array(FxViewSchema).max(6),
  policy: PolicyStateSchema,
  headlines: z.array(z.string().max(160)).max(5),
  /** Governments: balanced briefing text. */
  briefing: z.string().max(4_000).optional(),
  memo: z.string().max(200).optional(),
  /** Colonists: the household this agent represents (people, of whom `workingAge` are of working age). */
  household: z.object({ size: StockSchema, workingAge: StockSchema.optional() }).optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

// ---- Task and decision (architecture.md §3.1) ----------------------------

export const AgentTaskSchema = z.object({
  universeId: UniverseIdSchema,
  cycle: CycleSchema,
  agentId: AgentIdSchema,
  role: RoleSchema,
  planet: PlanetIdSchema,
  observation: ObservationSchema,
  /** Derived from role + cycle (policy tools only on policy cycles). */
  allowedActions: z.array(ActionKindSchema),
  deadlineMs: z.number().int().positive(),
});
export type AgentTask = z.infer<typeof AgentTaskSchema>;

/** Consumer (colonists) or business (traders) confidence, 0-100. Rides along on every call. */
export const SurveyAnswerSchema = z.object({
  type: z.enum(['consumer', 'business']),
  confidence: z.number().int().min(0).max(100),
});
export type SurveyAnswer = z.infer<typeof SurveyAnswerSchema>;

export const DECISION_SOURCES = ['llm', 'stub', 'standing_orders', 'replay'] as const;

export const AgentDecisionSchema = z.object({
  agentId: AgentIdSchema,
  /** Validated by the engine, never trusted. */
  actions: z.array(ActionSchema).max(20),
  survey: SurveyAnswerSchema.optional(),
  /** 1-2 sentences, feeds the agent inspector. */
  reason: z.string().max(500),
  /** Note to the agent's next turn, at most 200 chars. */
  memo: z.string().max(200).optional(),
  source: z.enum(DECISION_SOURCES),
  usage: UsageSchema.optional(),
});
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

/**
 * Track B surface the engine (Track A) depends on. See architecture.md §3.2.
 * `decideAll` runs the day's agent tasks in parallel. It must return exactly one
 * decision per task, keyed by `agentId`, in the same order as the input tasks.
 * Any failure (timeout, bad output, refusal, budget) resolves to standing orders
 * inside the runtime; the engine never sees a thrown decision.
 */
export interface AgentRuntime {
  decideAll(tasks: AgentTask[], signal: AbortSignal): Promise<AgentDecision[]>;
}
