// Usage: pnpm --filter @orbital/ledger-solana swap-in -- --cycles 50 [--seed N] [--deep-every N]
// Runs the same seed on InMemoryLedger and SolanaLedger (in-process LiteSVM) and reports the first difference, if any.
import { DEFAULT_WORLD } from '@orbital/contracts';
import { hasProgram } from '../test/env.js';
import { runSwapIn } from '../test/swap-in-lib.js';

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
if (!hasProgram) {
  console.error('target/deploy/orbital.so is missing: run `anchor build` first');
  process.exit(1);
}
const cycles = arg('cycles', 50);
const seed = arg('seed', DEFAULT_WORLD.seed);
const world = { ...DEFAULT_WORLD, seed };

console.log(`seed ${seed}, ${cycles} cycles, deep state compare every ${arg('deep-every', 10)} cycles`);
const r = await runSwapIn({
  world, cycles, deepEvery: arg('deep-every', 10),
  onCycle: (c, ms) => { if (c % 5 === 0) console.log(`  cycle ${c}: memory ${ms.memory.toFixed(0)}ms, solana ${ms.solana.toFixed(0)}ms`); },
});
if (r.divergence) {
  const d = r.divergence;
  console.log(`DIVERGED at cycle ${d.cycle} (${d.what}) at ${d.path}`);
  console.log('  memory:', JSON.stringify(d.memory));
  console.log('  solana:', JSON.stringify(d.solana));
  process.exit(2);
}
console.log(`IDENTICAL for ${r.cyclesRun} cycles (memory ${(r.msMemory / 1000).toFixed(1)}s, solana ${(r.msSolana / 1000).toFixed(1)}s)`);
