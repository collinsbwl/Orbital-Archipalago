import type { Snapshot } from '@orbital/contracts';

export function makeSnapshot(cycle: number, universeId = 'u0'): Snapshot {
  const planet = (id: string, currency: string, phase: number) => ({
    planet: id,
    currency,
    prices: { iron: 100, grain: 40 },
    policy: { tariffsBp: {}, quotas: {}, embargoes: [], policyRateBp: 200 },
    metrics: { gdp: 1000, cpi: 10_000, tradeBalance: -5, population: 30, consumerConfidence: 50, businessConfidence: 50, realGdp: 900, labourInput: 30, capitalStock: 5, realGdpGrowthBp: 120, labourContribBp: 0, capitalContribBp: 30, tfpContribBp: 90, children: 9, workingAge: 16, retired: 5, dependencyRatioBp: 8_750, participationBp: 8_000 },
    orbitPhaseCycles: phase,
  });
  return {
    universeId, cycle, paused: false,
    planets: [planet('helion', 'HLX', 1), planet('verdan', 'VRD', 2)],
    fx: [{ base: 'HLX', quote: 'VRD', ratePpm: 1_000_000 }],
    shipments: [], series: [],
    events: [{ id: `e${cycle}`, cycle, kind: 'system', text: '[god mode] drought on Verdan' }],
    gatewayCostUsd: 0,
  };
}
