// Usage: tsx scripts/serve.ts [--port 8787] [--interval 1000] [--cycles N]
// Env: TIGER_DATABASE_URL (else in-memory series), AUTH0_ISSUER + AUTH0_AUDIENCE (else auth disabled, every caller is DEV_ROLE or 'operator').
import { DEFAULT_WORLD } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { createAuthVerifier, InMemorySeries, LiveRunner, RandomValidPolicy, startServer, TigerStore, Universe } from '../src/index.js';
import type { MetricsSink, SeriesSource, ViewerRole } from '../src/index.js';

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const world = DEFAULT_WORLD;

let store: (MetricsSink & SeriesSource) | undefined;
let tiger: TigerStore | undefined;
if (process.env.TIGER_DATABASE_URL) {
  tiger = TigerStore.fromUrl();
  await tiger.migrate();
  await tiger.registerUniverse(world.universeId, world.name, world.seed, world);
  store = tiger;
} else {
  console.warn('TIGER_DATABASE_URL not set: using in-memory series');
  store = new InMemorySeries();
}

const universe = new Universe({ world, ledger: new InMemoryLedger(world), agents: new RandomValidPolicy(world, world.seed), sink: store });
await universe.init();

const runner = new LiveRunner({
  universeId: world.universeId,
  universe,
  series: store,
  intervalMs: arg('interval', 1000),
  maxCycles: arg('cycles', world.cycles),
  ...(tiger ? { audit: (e) => tiger.recordGodModeAudit(e) } : {}),
  ...(tiger ? { onFork: (id: string) => tiger.registerUniverse(id, `${world.name} (${id})`, world.seed, { ...world, universeId: id }) } : {}),
  onError: (err) => console.error('cycle failed', err),
});

const { AUTH0_ISSUER, AUTH0_AUDIENCE } = process.env;
const auth = AUTH0_ISSUER && AUTH0_AUDIENCE
  ? createAuthVerifier({ mode: 'auth0', issuer: AUTH0_ISSUER, audience: AUTH0_AUDIENCE })
  : createAuthVerifier({ mode: 'disabled', role: (process.env.DEV_ROLE as ViewerRole | undefined) ?? 'operator' });

const server = await startServer({ port: arg('port', 8787), hub: runner, auth });
console.log(`engine listening on :${server.port} (universe ${world.universeId})`);
runner.start();

const shutdown = async () => {
  runner.stop();
  await server.close();
  await tiger?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
