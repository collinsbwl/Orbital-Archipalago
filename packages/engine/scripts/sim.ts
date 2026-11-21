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
const fxClears: Record<string, number> = {};
let unmet = 0, departures = 0, arrivals = 0;
for (let i = 1; i <= cycles; i++) {
  const r = await u.step();
  for (const a of r.auctions) volume[a.planet] = (volume[a.planet] ?? 0) + a.volume;
  for (const f of r.fx) if (f.ratePpm !== null) fxClears[`${f.base}/${f.quote}`] = (fxClears[`${f.base}/${f.quote}`] ?? 0) + 1;
  for (const p of Object.values(r.unmet)) for (const n of Object.values(p)) unmet += n;
  departures += r.departures.length;
  arrivals += r.arrivals.length;
  if (i % 20 === 0 || i === cycles) {
    const ok = (await ledger.checkInvariants()).ok;
    const vol = Object.entries(volume).map(([p, v]) => `${p}=${v}`).join(' ');
    console.log(`cycle ${r.cycle} volume(last window) ${vol} unmet ${unmet} departures(total) ${departures} arrivals(total) ${arrivals} invariants ${ok ? 'ok' : 'FAIL'}`);
    for (const k of Object.keys(volume)) volume[k] = 0;
    unmet = 0;
  }
}
console.log(`fx clears: ${Object.entries(fxClears).map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`);
