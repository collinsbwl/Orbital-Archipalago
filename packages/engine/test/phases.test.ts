import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD, WorldConfigSchema } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { bootstrap, runConsumption, runProduction } from '../src/index.js';

const fresh = async () => {
  const ledger = new InMemoryLedger(DEFAULT_WORLD);
  await bootstrap(DEFAULT_WORLD, ledger);
  return ledger;
};

describe('bootstrap', () => {
  it('opens treasuries, purses and starting need inventory', async () => {
    const l = await fresh();
    expect(await l.getPurse('helion', 'HLX')).toBe(100_000);
    expect(await l.getPurse('verdan:trader:2', 'VRD')).toBe(10_000);
    expect(await l.getPurse('tethys:government:0', 'TTH')).toBe(0);
    expect(await l.getInventory('helion:colonist:0', 'helion', 'grain')).toBe(3);
    expect(await l.getInventory('helion:trader:0', 'helion', 'grain')).toBe(0);
    expect((await l.checkInvariants()).ok).toBe(true);
  });
});

describe('production', () => {
  it('runs up to batchesPerCycle, skipping batches whose owner lacks inputs', async () => {
    const l = await fresh();
    const p = await runProduction(DEFAULT_WORLD, l, 0);
    // helion: 10 mine_iron (no inputs); refine_fuel needs 3 water but each owner holds 3 -> some run.
    expect(p['helion']?.['iron']).toBe(40);
    expect(p['helion']?.['fuel']).toBe(4);
    // verdan: farm_grain needs 1 water, owners have 3 -> 12 batches ok; pump_water 8 batches
    expect(p['verdan']?.['grain']).toBe(48);
    expect(p['verdan']?.['water']).toBe(48);
    // tethys: forge_tools needs iron+fuel nobody holds yet -> skipped
    expect(p['tethys']?.['tools']).toBeUndefined();
    expect(p['tethys']?.['iron']).toBe(12);
    expect((await l.checkInvariants()).ok).toBe(true);
  });

  it('rotates batch owners by cycle', async () => {
    const l = await fresh();
    await runProduction(DEFAULT_WORLD, l, 0);
    await runProduction(DEFAULT_WORLD, l, 1);
    // helion has 14 batches/cycle over 30 colonists: cycle 0 -> colonists 0..13, cycle 1 -> 14..27
    expect(await l.getInventory('helion:colonist:0', 'helion', 'iron')).toBeGreaterThan(0);
    expect(await l.getInventory('helion:colonist:14', 'helion', 'iron')).toBeGreaterThan(0);
    expect(await l.getInventory('helion:colonist:29', 'helion', 'iron')).toBe(0);
  });
});

describe('consumption', () => {
  it('consumes up to the need and records unmet units', async () => {
    const l = await fresh();
    for (let i = 0; i < 3; i++) expect(Object.values(await runConsumption(DEFAULT_WORLD, l)).every((u) => Object.keys(u).length === 0)).toBe(true);
    const unmet = await runConsumption(DEFAULT_WORLD, l); // 4th cycle: starting stock of 3 is gone
    expect(unmet['helion']).toEqual({ grain: 30, water: 30 });
    expect(await l.getInventory('helion:colonist:0', 'helion', 'grain')).toBe(0);
    expect((await l.checkInvariants()).ok).toBe(true);
  });

  it('partial holdings are consumed in full', async () => {
    const world = WorldConfigSchema.parse({ ...DEFAULT_WORLD, colonistNeeds: [{ good: 'grain', qty: 5 }] });
    const l = new InMemoryLedger(world);
    await bootstrap(world, l); // 15 grain each
    for (let i = 0; i < 3; i++) await runConsumption(world, l);
    expect(await l.getInventory('verdan:colonist:0', 'verdan', 'grain')).toBe(0);
    expect((await runConsumption(world, l))['verdan']).toEqual({ grain: 150 });
  });
});
