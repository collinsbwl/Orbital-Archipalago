import { DEFAULT_WORLD } from '@orbital/contracts';
import { describe, expect, it } from 'vitest';
import { hasProgram } from './env.js';
import { runSwapIn } from './swap-in-lib.js';

// C5 in miniature: the same seed on InMemoryLedger and SolanaLedger must give identical cycle reports, snapshots and
// ledger state. The full 200-cycle run is `pnpm --filter @orbital/ledger-solana swap-in --cycles 200`.
describe.skipIf(!hasProgram)('swap-in: InMemoryLedger vs SolanaLedger', () => {
  it('runs the same seed identically for 25 cycles', async () => {
    const r = await runSwapIn({ world: DEFAULT_WORLD, cycles: 25, deepEvery: 5 });
    expect(r.divergence).toBeNull();
    expect(r.cyclesRun).toBe(25);
  }, 300_000);

  it('a different seed also matches', async () => {
    const r = await runSwapIn({ world: { ...DEFAULT_WORLD, seed: 7 }, cycles: 12, deepEvery: 4 });
    expect(r.divergence).toBeNull();
  }, 300_000);
});
