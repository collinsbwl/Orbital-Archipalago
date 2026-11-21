// Usage: tsx scripts/sim.ts --cycles 200 [--seed N]
import { DEFAULT_WORLD } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { RandomValidPolicy, Universe } from '../src/index.js';

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const cycles = arg('cycles', DEFAULT_WORLD.cycles);
const seed = arg('seed', DEFAULT_WORLD.seed);
const world = { ...DEFAULT_WORLD, seed };

const ledger = new InMemoryLedger(world);
const u = new Universe({ world, ledger, agents: new RandomValidPolicy(world, seed) });
await u.init();

const volume = Object.fromEntries(world.planets.map((p) => [p.id, 0]));
for (let i = 1; i <= cycles; i++) {
  const r = await u.step();
  for (const a of r.auctions) volume[a.planet] = (volume[a.planet] ?? 0) + a.volume;
  if (i % 20 === 0 || i === cycles) {
    const ok = (await ledger.checkInvariants()).ok;
    const vol = Object.entries(volume).map(([p, v]) => `${p}=${v}`).join(' ');
    console.log(`cycle ${r.cycle} volume(last window) ${vol} invariants ${ok ? 'ok' : 'FAIL'}`);
    for (const k of Object.keys(volume)) volume[k] = 0;
  }
}
