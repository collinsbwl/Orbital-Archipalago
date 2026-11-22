// Agent wiring for the live server. With GEMINI_API_KEY set, agents run on the
// real Gemini stack: colonists, traders and governments pick from rule-built
// candidates on gemini-decision-1, and traders/governments fall back to Flash
// when the pick is unsure. Without a key (or GATEWAY_PROFILE=stub) the server
// keeps the seeded RandomValidPolicy.
//
// Env:
//   GEMINI_API_KEY (or GOOGLE_API_KEY)   enables Gemini
//   GATEWAY_PROFILE=cheap|full|stub      DEFAULT: cheap with a key, else stub
//   RUN_BUDGET_USD                       hard per-run spend cap, DEFAULT 15
//   FLASH_RPM / FLASH_CONCURRENCY        DEFAULT 1000 / 32
//   DECISION_RPM / DECISION_CONCURRENCY  DEFAULT 2000 / 64
//   MIN_CHOICE_CONFIDENCE                below this, traders/governments defer to Flash, DEFAULT 0.4
//   RECORD_DIR                           if set, every call is appended to <dir>/<universe>/calls.jsonl
//   CACHE_SCOPE=role|planet_cycle        explicit Flash cache scope, DEFAULT role

import type { AgentDecision, AgentTask, Profile, WorldConfig } from '@orbital/contracts';
import { ProfileSchema } from '@orbital/contracts';
import { DefaultAgentRuntime } from '@orbital/agents';
import {
  CacheManager, CostMeter, createDecisionGateway, createGateway, DECISION_MODEL_ID, GoogleGenaiClient, Limiter, MODEL_IDS,
} from '@orbital/gateway';
import { RandomValidPolicy } from '@orbital/engine';
import type { DecisionProvider } from '@orbital/engine';
import { MarketBoards, readToolsFor, runReadTool } from './read-tools.js';

const num = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

/** Cycles between spend / decision-source log lines. */
const LOG_EVERY = 10;

/** Adapts DefaultAgentRuntime to the engine's DecisionProvider (no caller signal; the runtime enforces per-task deadlines). */
export class GeminiAgents implements DecisionProvider {
  private readonly sources = new Map<string, number>();

  constructor(
    private readonly runtime: DefaultAgentRuntime,
    private readonly cost: CostMeter,
    /** Cross-planet books for the read tools; refreshed from each cycle's batch. */
    private readonly boards?: MarketBoards,
  ) {}

  async decideAll(tasks: AgentTask[]): Promise<AgentDecision[]> {
    this.boards?.update(tasks);
    const out = await this.runtime.decideAll(tasks, new AbortController().signal);
    for (const d of out) this.sources.set(d.source, (this.sources.get(d.source) ?? 0) + 1);
    const cycle = tasks[0]?.cycle;
    if (cycle !== undefined && cycle % LOG_EVERY === 0) {
      const t = this.cost.snapshot();
      const byModel = Object.entries(t.byModel).map(([m, usd]) => `${m}=$${usd.toFixed(4)}`).join(' ');
      const src = [...this.sources].map(([s, n]) => `${s}=${n}`).join(' ');
      console.log(`[agents] cycle ${cycle}: spend $${t.totalUsd.toFixed(4)} (${byModel || 'none'}); decisions ${src}`);
    }
    return out;
  }

  fork(): GeminiAgents {
    return new GeminiAgents(this.runtime.fork(), this.cost, this.boards);
  }
}

/** Wraps any DecisionProvider and hands each cycle's tasks + decisions to `record` (e.g. Tiger). Write failures are logged, never fatal. */
export class RecordedDecisions implements DecisionProvider {
  constructor(
    private readonly inner: DecisionProvider,
    private readonly record: (tasks: AgentTask[], decisions: AgentDecision[]) => Promise<void>,
  ) {}

  async decideAll(tasks: AgentTask[]): Promise<AgentDecision[]> {
    const out = await this.inner.decideAll(tasks);
    await this.record(tasks, out).catch((e) => console.error('[agents] failed to record decisions', e));
    return out;
  }

  get fork(): (() => DecisionProvider) | undefined {
    const f = this.inner.fork?.bind(this.inner);
    return f ? () => new RecordedDecisions(f(), this.record) : undefined;
  }
}

/** The Gemini key: GEMINI_API_KEY, else GOOGLE_API_KEY (the name .env and the SDK docs use). */
export function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

export function resolveProfile(): Profile {
  // Empty counts as unset (docker-compose passes `${GATEWAY_PROFILE:-}`).
  const raw = process.env.GATEWAY_PROFILE || (geminiApiKey() ? 'cheap' : 'stub');
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`GATEWAY_PROFILE must be one of ${ProfileSchema.options.join('|')}, got ${raw}`);
  return parsed.data;
}

export interface MakeAgentsOpts {
  /** Inject a client (tests drive the real gateways against a fake SDK). */
  client?: GoogleGenaiClient;
}

export function makeAgents(world: WorldConfig, opts: MakeAgentsOpts = {}): DecisionProvider {
  const profile = resolveProfile();
  if (profile === 'stub') {
    console.warn('GATEWAY_PROFILE=stub (or no GEMINI_API_KEY / GOOGLE_API_KEY): agents use RandomValidPolicy, no Gemini calls');
    return new RandomValidPolicy(world, world.seed);
  }
  const apiKey = geminiApiKey();
  if (!apiKey && !opts.client) throw new Error(`GATEWAY_PROFILE=${profile} needs GEMINI_API_KEY (or GOOGLE_API_KEY)`);

  const client = opts.client ?? new GoogleGenaiClient({ apiKey });
  const flash = MODEL_IDS['gemini-flash'];
  const cost = new CostMeter({
    runBudgetUsd: num('RUN_BUDGET_USD', 15),
    onBudgetExhausted: (t) => console.warn(`[agents] run budget spent ($${t.totalUsd.toFixed(2)}): remaining calls drop to stub`),
  });
  const recording = process.env.RECORD_DIR ? { runsDir: process.env.RECORD_DIR, universeId: world.universeId } : undefined;

  const gateway = createGateway(profile, {
    gemini: {
      client,
      limiters: {
        [flash]: new Limiter({ concurrency: num('FLASH_CONCURRENCY', 32), rpm: num('FLASH_RPM', 1_000), inputTpm: 4_000_000, outputTpm: 1_000_000 }),
      },
      cache: new CacheManager({ client: client.caches }),
      // Flash is a low-volume fallback here, so one long-lived cache per role (system +
      // tools) beats a cache per planet and cycle that would rarely be hit twice.
      cacheScope: process.env.CACHE_SCOPE === 'planet_cycle' ? 'planet_cycle' : 'role',
      cost,
    },
    ...(recording ? { recording } : {}),
  });
  const decisionGateway = createDecisionGateway(profile, {
    gemini: {
      client: client.decisions,
      limiter: new Limiter({ concurrency: num('DECISION_CONCURRENCY', 64), rpm: num('DECISION_RPM', 2_000), inputTpm: 20_000_000, outputTpm: 1_000_000 }),
      cost,
    },
    ...(recording ? { recording } : {}),
  });

  // Read tools for the Flash fallback (traders: planet_prices + quote_route; governments: planet_prices).
  const boards = new MarketBoards(world);
  const runtime = new DefaultAgentRuntime({
    world,
    profile,
    gateway,
    decisionGateway,
    toolsFor: readToolsFor,
    runTool: runReadTool(boards, world),
    choice: { minChoiceConfidence: num('MIN_CHOICE_CONFIDENCE', 0.4) },
    onDegrade: (reason) => console.warn(`[agents] degraded to stub policy: ${reason}`),
  });
  console.log(`[agents] Gemini on (profile ${profile}): choices on ${DECISION_MODEL_ID}, fallback on ${flash}, budget $${num('RUN_BUDGET_USD', 15)}`);
  return new GeminiAgents(runtime, cost, boards);
}
