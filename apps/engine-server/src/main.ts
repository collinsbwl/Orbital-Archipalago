// Usage: node dist/main.js [--port 8787] [--interval 1000] [--cycles N]   (or `pnpm dev -- ...`)
// Env:
//   ENGINE_PORT (if no --port; default 8787)
//   LEDGER=memory|solana (default memory); SOLANA_RPC_URL, SOLANA_ADMIN_KEYPAIR for solana (see src/ledger.ts)
//   TIGER_DATABASE_URL (else in-memory series)
//   AUTH0_ISSUER + AUTH0_AUDIENCE (else auth disabled, every caller is DEV_ROLE or 'operator')
//   GEMINI_API_KEY (or GOOGLE_API_KEY), GATEWAY_PROFILE, RUN_BUDGET_USD, ... for real Gemini agents (see src/agents.ts)
//   ENV_FILE (default: repo-root .env, loaded if present; real env vars take precedence)
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_WORLD } from '@orbital/contracts';
import { createAuthVerifier, InMemorySeries, LiveRunner, startServer, TigerStore, Universe } from '@orbital/engine';
import type { MetricsSink, SeriesSource, ViewerRole } from '@orbital/engine';
import { makeAgents, RecordedDecisions } from './agents.js';
import { makeLedger } from './ledger.js';

// Local runs: load the repo-root .env (or ENV_FILE). Values already in the environment
// win, so Docker / CI settings are never overridden; the image ships no .env at all.
const envFile = process.env.ENV_FILE ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
  console.log(`loaded env from ${envFile}`);
}

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

const ledger = await makeLedger(world);
const baseAgents = makeAgents(world);
const agents = tiger ? new RecordedDecisions(baseAgents, (tasks, ds) => tiger.writeDecisions(tasks, ds)) : baseAgents;
const universe = new Universe({ world, ledger, agents, sink: store });
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

const port = arg('port', Number(process.env.ENGINE_PORT) || 8787);
const server = await startServer({ port, hub: runner, auth });
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
