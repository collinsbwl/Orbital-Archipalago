import { z } from 'zod';
import {
  CurrencyIdSchema, GoodIdSchema, MinorUnitsSchema, PlanetIdSchema, QtySchema, RecipeIdSchema, StockSchema, UniverseIdSchema,
} from './ids.js';
import { ProfileSchema } from './gateway.js';

const GoodSchema = z.object({ id: GoodIdSchema, name: z.string(), basePrice: MinorUnitsSchema });
const IoSchema = z.object({ good: GoodIdSchema, qty: QtySchema });
export const RecipeSchema = z.object({
  id: RecipeIdSchema,
  inputs: z.array(IoSchema),
  output: IoSchema,
});
export type Recipe = z.infer<typeof RecipeSchema>;

export const PlanetConfigSchema = z.object({
  id: PlanetIdSchema,
  name: z.string(),
  currency: CurrencyIdSchema,
  /** Circular orbit: radius in abstract distance units, period and phase in cycles. */
  orbit: z.object({ radius: z.number().int().positive(), periodCycles: z.number().int().positive(), phaseCycles: z.number().int().nonnegative() }),
  /** Recipes this planet can run and max batches per cycle (drives comparative advantage). */
  recipes: z.array(z.object({ recipe: RecipeIdSchema, batchesPerCycle: QtySchema })),
  /** Agent counts for roles that live on a planet (news and economist are global). */
  agents: z.object({ colonist: StockSchema, trader: StockSchema, government: StockSchema, reserve_bank: StockSchema }),
  /** Starting purses in this planet's currency. */
  purses: z.object({ colonist: MinorUnitsSchema, trader: MinorUnitsSchema, treasury: MinorUnitsSchema }),
  /**
   * Starting population by age cohort. The colonist agents are households sharing it. Absent = everyone working-age, one
   * person per colonist, with static demographics.
   */
  population: z.object({ children: StockSchema, workingAge: StockSchema, retired: StockSchema }).optional(),
});
export type PlanetConfig = z.infer<typeof PlanetConfigSchema>;

export const WorldConfigSchema = z
  .object({
    name: z.string(),
    universeId: UniverseIdSchema,
    seed: z.number().int().nonnegative(),
    cycles: z.number().int().positive(),
    /** Per-cycle wall-clock deadline. */
    cycleDeadlineMs: z.number().int().positive(),
    gatewayProfile: ProfileSchema,
    goods: z.array(GoodSchema).min(1),
    recipes: z.array(RecipeSchema).min(1),
    /** Goods each colonist consumes per cycle. */
    colonistNeeds: z.array(IoSchema),
    /** Travel time is derived by the engine from orbit positions: distance / speed, at least minCycles. */
    travel: z.object({ speedUnitsPerCycle: QtySchema, minCycles: QtySchema }),
    planets: z.array(PlanetConfigSchema).min(2),
  })
  .superRefine((w, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const dup = (xs: string[]) => new Set(xs).size !== xs.length;
    if (dup(w.planets.map((p) => p.id))) issue('duplicate planet id');
    if (dup(w.planets.map((p) => p.currency))) issue('duplicate currency');
    if (dup(w.goods.map((g) => g.id))) issue('duplicate good id');
    if (dup(w.recipes.map((r) => r.id))) issue('duplicate recipe id');
    const goods = new Set(w.goods.map((g) => g.id));
    const recipes = new Set(w.recipes.map((r) => r.id));
    for (const r of w.recipes) for (const io of [...r.inputs, r.output]) if (!goods.has(io.good)) issue(`recipe ${r.id}: unknown good ${io.good}`);
    for (const n of w.colonistNeeds) if (!goods.has(n.good)) issue(`colonistNeeds: unknown good ${n.good}`);
    for (const p of w.planets) for (const r of p.recipes) if (!recipes.has(r.recipe)) issue(`planet ${p.id}: unknown recipe ${r.recipe}`);
  });
export type WorldConfig = z.infer<typeof WorldConfigSchema>;

// DEFAULT: all names and numbers below are placeholders pending the build plan.
export const DEFAULT_WORLD: WorldConfig = WorldConfigSchema.parse({
  name: 'Orbital Archipelago',
  universeId: 'u0',
  seed: 42,
  cycles: 200,
  cycleDeadlineMs: 6_000,
  gatewayProfile: 'stub',
  goods: [
    { id: 'iron', name: 'Iron', basePrice: 100 },
    { id: 'grain', name: 'Grain', basePrice: 40 },
    { id: 'water', name: 'Water', basePrice: 20 },
    { id: 'fuel', name: 'Fuel', basePrice: 60 },
    { id: 'tools', name: 'Tools', basePrice: 300 },
  ],
  recipes: [
    { id: 'mine_iron', inputs: [], output: { good: 'iron', qty: 4 } },
    { id: 'pump_water', inputs: [], output: { good: 'water', qty: 6 } },
    { id: 'farm_grain', inputs: [{ good: 'water', qty: 1 }], output: { good: 'grain', qty: 4 } },
    { id: 'refine_fuel', inputs: [{ good: 'water', qty: 3 }], output: { good: 'fuel', qty: 1 } },
    { id: 'forge_tools', inputs: [{ good: 'iron', qty: 2 }, { good: 'fuel', qty: 1 }], output: { good: 'tools', qty: 1 } },
  ],
  colonistNeeds: [{ good: 'grain', qty: 1 }, { good: 'water', qty: 1 }],
  travel: { speedUnitsPerCycle: 20, minCycles: 1 },
  planets: [
    {
      id: 'helion', name: 'Helion', currency: 'HLX',
      orbit: { radius: 100, periodCycles: 20, phaseCycles: 0 },
      recipes: [{ recipe: 'mine_iron', batchesPerCycle: 10 }, { recipe: 'refine_fuel', batchesPerCycle: 4 }],
      agents: { colonist: 30, trader: 3, government: 1, reserve_bank: 1 },
      purses: { colonist: 1_000, trader: 10_000, treasury: 100_000 },
      population: { children: 900, workingAge: 1_650, retired: 450 },
    },
    {
      id: 'verdan', name: 'Verdan', currency: 'VRD',
      orbit: { radius: 160, periodCycles: 32, phaseCycles: 8 },
      recipes: [{ recipe: 'farm_grain', batchesPerCycle: 12 }, { recipe: 'pump_water', batchesPerCycle: 8 }],
      agents: { colonist: 30, trader: 3, government: 1, reserve_bank: 1 },
      purses: { colonist: 1_000, trader: 10_000, treasury: 100_000 },
      population: { children: 900, workingAge: 1_650, retired: 450 },
    },
    {
      id: 'tethys', name: 'Tethys', currency: 'TTH',
      orbit: { radius: 240, periodCycles: 48, phaseCycles: 16 },
      recipes: [
        { recipe: 'pump_water', batchesPerCycle: 10 },
        { recipe: 'refine_fuel', batchesPerCycle: 2 },
        { recipe: 'forge_tools', batchesPerCycle: 5 },
        { recipe: 'mine_iron', batchesPerCycle: 3 },
      ],
      agents: { colonist: 30, trader: 3, government: 1, reserve_bank: 1 },
      purses: { colonist: 1_000, trader: 10_000, treasury: 100_000 },
      population: { children: 900, workingAge: 1_650, retired: 450 },
    },
  ],
});
