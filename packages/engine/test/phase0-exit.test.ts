import { describe, expect, it } from 'vitest';
import { makeUniverse } from './helpers.js';

// Build plan, Phase 0 exit test: "200 stub cycles run in about 2 minutes, with goods and credits conserved".
// Conservation is checked by the ledger every cycle (Universe throws if `checkInvariants()` fails); exact money-supply
// accounting with credit (initial + minted - burned) is asserted in economics.test.ts.
describe('Phase 0 exit test', () => {
  it('runs 200 stub cycles within 2 minutes with goods and credits conserved', async () => {
    const { world, ledger, universe } = makeUniverse();
    await universe.init();
    const start = performance.now();
    for (let c = 0; c < 200; c++) await universe.step();
    const seconds = (performance.now() - start) / 1000;
    const inv = await ledger.checkInvariants();
    expect(inv.ok, JSON.stringify(inv.violations)).toBe(true);
    expect(universe.cycle).toBe(200);
    expect(seconds).toBeLessThan(120);
    expect(Object.keys(inv.totals.goods).sort()).toEqual(world.goods.map((g) => g.id).sort());
  }, 130_000);
});
