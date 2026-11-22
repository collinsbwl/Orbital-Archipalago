import { describe, expect, it } from 'vitest';
import { SnapshotSchema } from '@orbital/contracts';
import type { Snapshot } from '@orbital/contracts';
import { snapshotToRows } from '../src/tiger/rows.js';

const policy = { tariffsBp: {}, quotas: {}, embargoes: [], policyRateBp: 200 };

function makeSnapshot(universeId: string, cycle: number): Snapshot {
  return SnapshotSchema.parse({
    universeId, cycle, paused: false,
    planets: [
      {
        planet: 'helion', currency: 'HEL', prices: { iron: 100 + cycle, grain: 50 }, policy,
        metrics: { gdp: 1_000 + cycle, cpi: 10_000 + cycle, tradeBalance: -25, population: 500, consumerConfidence: 60, businessConfidence: 55, realGdp: 900, labourInput: 30, capitalStock: 5, realGdpGrowthBp: 120, labourContribBp: 0, capitalContribBp: 30, tfpContribBp: 90, children: 9, workingAge: 16, retired: 5, dependencyRatioBp: 8_750, participationBp: 8_000, netMigration: -3, emigrants: 5, immigrants: 2 },
        orbitPhaseCycles: 3,
      },
      {
        planet: 'vesta', currency: 'VES', prices: { iron: 90 }, policy,
        metrics: { gdp: 2_000, cpi: 9_900, tradeBalance: 40, population: 800, consumerConfidence: 70, businessConfidence: 65, realGdp: 900, labourInput: 30, capitalStock: 5, realGdpGrowthBp: 120, labourContribBp: 0, capitalContribBp: 30, tfpContribBp: 90, children: 9, workingAge: 16, retired: 5, dependencyRatioBp: 8_750, participationBp: 8_000, netMigration: -3, emigrants: 5, immigrants: 2 },
        orbitPhaseCycles: 7,
      },
    ],
    fx: [{ base: 'HEL', quote: 'VES', ratePpm: 1_250_000 }],
    shipments: [], migrants: [], events: [], series: [], gatewayCostUsd: 1.5,
  });
}

describe('snapshotToRows', () => {
  const rows = snapshotToRows(makeSnapshot('u0', 12));

  it('maps one planet_metrics row per planet', () => {
    expect(rows.planetMetrics).toEqual([
      { universeId: 'u0', cycle: 12, planet: 'helion', gdp: 1_012, cpi: 10_012, tradeBalance: -25, population: 500, consumerConfidence: 60, businessConfidence: 55, realGdp: 900, labourInput: 30, capitalStock: 5, realGdpGrowthBp: 120, labourContribBp: 0, capitalContribBp: 30, tfpContribBp: 90, children: 9, workingAge: 16, retired: 5, dependencyRatioBp: 8_750, participationBp: 8_000, netMigration: -3, emigrants: 5, immigrants: 2 },
      { universeId: 'u0', cycle: 12, planet: 'vesta', gdp: 2_000, cpi: 9_900, tradeBalance: 40, population: 800, consumerConfidence: 70, businessConfidence: 65, realGdp: 900, labourInput: 30, capitalStock: 5, realGdpGrowthBp: 120, labourContribBp: 0, capitalContribBp: 30, tfpContribBp: 90, children: 9, workingAge: 16, retired: 5, dependencyRatioBp: 8_750, participationBp: 8_000, netMigration: -3, emigrants: 5, immigrants: 2 },
    ]);
  });

  it('maps one price row per planet x good', () => {
    expect(rows.prices).toHaveLength(3);
    expect(rows.prices).toContainEqual({ universeId: 'u0', cycle: 12, planet: 'helion', good: 'iron', price: 112 });
    expect(rows.prices).toContainEqual({ universeId: 'u0', cycle: 12, planet: 'helion', good: 'grain', price: 50 });
    expect(rows.prices).toContainEqual({ universeId: 'u0', cycle: 12, planet: 'vesta', good: 'iron', price: 90 });
  });

  it('maps fx quotes to BASE/QUOTE pairs and the gateway cost to one row', () => {
    expect(rows.fxRates).toEqual([{ universeId: 'u0', cycle: 12, pair: 'HEL/VES', ratePpm: 1_250_000 }]);
    expect(rows.gatewayCost).toEqual([{ universeId: 'u0', cycle: 12, costUsd: 1.5 }]);
  });
});
