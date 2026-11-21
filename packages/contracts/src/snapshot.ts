import { z } from 'zod';
import {
  CurrencyIdSchema, CycleSchema, GoodIdSchema, MinorUnitsSchema, PlanetIdSchema, RatePpmSchema,
  RateBpSchema, SignedBpSchema, SignedMinorUnitsSchema, StockSchema, UniverseIdSchema,
} from './ids.js';
import { PolicyStateSchema, ShipmentSchema } from './ledger.js';

const CommandIdSchema = z.string().min(1).max(64);

export const PlanetMetricsSchema = z.object({
  /** In the planet's currency. */
  gdp: MinorUnitsSchema,
  /** Consumer price index; 10_000 = base period. */
  cpi: z.number().int().nonnegative(),
  /** Exports minus imports, planet currency (signed). */
  tradeBalance: SignedMinorUnitsSchema,
  population: StockSchema,
  /** 0-100. */
  consumerConfidence: z.number().int().min(0).max(100),
  businessConfidence: z.number().int().min(0).max(100),
});

export const PlanetSnapshotSchema = z.object({
  planet: PlanetIdSchema,
  currency: CurrencyIdSchema,
  /** Last clearing price per good, planet currency. */
  prices: z.record(GoodIdSchema, MinorUnitsSchema),
  policy: PolicyStateSchema,
  metrics: PlanetMetricsSchema,
  /** Orbital angle position in cycles within the period (for the 3D view). */
  orbitPhaseCycles: z.number().int().nonnegative(),
});
export type PlanetSnapshot = z.infer<typeof PlanetSnapshotSchema>;

export const FxQuoteSchema = z.object({ base: CurrencyIdSchema, quote: CurrencyIdSchema, ratePpm: RatePpmSchema });

export const SimEventSchema = z.object({
  id: z.string().min(1).max(64),
  cycle: CycleSchema,
  kind: z.enum(['headline', 'policy', 'shock', 'crisis', 'system']),
  planet: PlanetIdSchema.optional(),
  text: z.string().max(280),
});
export type SimEvent = z.infer<typeof SimEventSchema>;

export const CHART_METRICS = ['gdp', 'cpi', 'trade_balance', 'price', 'fx_rate'] as const;
/** Filled by the engine from Tiger Data continuous aggregates. Points are [cycle, value]. */
export const ChartSeriesSchema = z.object({
  metric: z.enum(CHART_METRICS),
  planet: PlanetIdSchema.optional(),
  good: GoodIdSchema.optional(),
  /** For fx_rate: `BASE/QUOTE`, value in ppm. */
  pair: z.string().optional(),
  points: z.array(z.tuple([CycleSchema, SignedMinorUnitsSchema])).max(1_000),
});
export type ChartSeries = z.infer<typeof ChartSeriesSchema>;

export const SnapshotSchema = z.object({
  universeId: UniverseIdSchema,
  cycle: CycleSchema,
  paused: z.boolean(),
  planets: z.array(PlanetSnapshotSchema),
  fx: z.array(FxQuoteSchema),
  shipments: z.array(ShipmentSchema),
  events: z.array(SimEventSchema).max(50),
  series: z.array(ChartSeriesSchema),
  /** Cumulative gateway spend (USD telemetry). */
  gatewayCostUsd: z.number().nonnegative(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ---- God mode (operators only) -------------------------------------------

export const SHOCK_TYPES = ['drought', 'strike', 'windfall', 'blight', 'demand_surge'] as const;

export const GodModeCommandSchema = z.discriminatedUnion('kind', [
  /** Scale a planet's output of a good by `magnitudeBp` (e.g. -3000 = -30%) for `durationCycles`. */
  z.object({ kind: z.literal('shock'), planet: PlanetIdSchema, shock: z.enum(SHOCK_TYPES), good: GoodIdSchema, magnitudeBp: SignedBpSchema, durationCycles: z.number().int().min(1).max(200) }),
  z.object({ kind: z.literal('tariff'), planet: PlanetIdSchema, good: GoodIdSchema, rateBp: RateBpSchema }),
  z.object({ kind: z.literal('embargo'), planet: PlanetIdSchema, target: PlanetIdSchema, active: z.boolean() }),
  z.object({ kind: z.literal('policy_rate'), planet: PlanetIdSchema, rateBp: RateBpSchema }),
  /** Copy ledger + RNG state into a new universe. */
  z.object({ kind: z.literal('fork'), label: z.string().max(60).optional() }),
  z.object({ kind: z.literal('pause') }),
  z.object({ kind: z.literal('resume') }),
]);
export type GodModeCommand = z.infer<typeof GodModeCommandSchema>;

// ---- WebSocket envelopes (discriminated by `type`) -----------------------
// Auth0 token travels on the handshake, not in messages.

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), contractsVersion: z.string(), universeId: UniverseIdSchema, role: z.enum(['spectator', 'operator']) }),
  z.object({ type: z.literal('snapshot'), snapshot: SnapshotSchema }),
  z.object({ type: z.literal('command_ack'), commandId: CommandIdSchema, ok: z.boolean(), error: z.string().optional(), forkedUniverseId: UniverseIdSchema.optional() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), universeId: UniverseIdSchema }),
  z.object({ type: z.literal('command'), commandId: CommandIdSchema, universeId: UniverseIdSchema, command: GodModeCommandSchema }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
