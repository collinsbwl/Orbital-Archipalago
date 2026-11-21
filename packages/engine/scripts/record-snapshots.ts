// Records 60 cycles of Snapshots from DEFAULT_WORLD (InMemoryLedger + RandomValidPolicy + InMemorySeries) into
// apps/web/public/fixtures/snapshots.json, with a god-mode drought and tariff at cycle 30 so the event feed has content.
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_WORLD, SnapshotSchema } from '@orbital/contracts';
import type { Snapshot } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { InMemorySeries, RandomValidPolicy, Universe } from '../src/index.js';

const CYCLES = 60;
const SERIES_POINTS = 60;
const world = DEFAULT_WORLD;
const series = new InMemorySeries();
const u = new Universe({ world, ledger: new InMemoryLedger(world), agents: new RandomValidPolicy(world, world.seed), sink: series });
await u.init();

const out: Snapshot[] = [];
for (let i = 1; i <= CYCLES; i++) {
  if (i === 31) {
    u.enqueue({ kind: 'shock', planet: 'verdan', shock: 'drought', good: 'grain', magnitudeBp: -5000, durationCycles: 15 }, { sub: 'fixture' });
    u.enqueue({ kind: 'tariff', planet: 'helion', good: 'grain', rateBp: 1500 }, { sub: 'fixture' });
  }
  await u.step();
  const all = await series.readSeries(world.universeId);
  const trimmed = all.map((s) => ({ ...s, points: s.points.slice(-SERIES_POINTS) }));
  out.push(SnapshotSchema.parse(await u.snapshot({ series: trimmed })));
}

const file = new URL('../../../apps/web/public/fixtures/snapshots.json', import.meta.url);
mkdirSync(new URL('./', file), { recursive: true });
const json = JSON.stringify(out);
writeFileSync(file, json + '\n');
console.log(`wrote ${file.pathname}: ${out.length} snapshots, ${(json.length / 1024).toFixed(0)} KiB, ${out.at(-1)?.events.length} events in last`);
