import { describe, expect, it } from 'vitest';
import {
  ACTION_KINDS, ActionSchema, AgentDecisionSchema, AgentTaskSchema, ClientMessageSchema, CONTRACTS_VERSION,
  DEFAULT_WORLD, GodModeCommandSchema, ServerMessageSchema, SnapshotSchema, WorldConfigSchema,
  type AgentDecision, type AgentTask, type Snapshot,
} from '../src/index.js';

const policy = { tariffsBp: { iron: 500 }, quotas: {}, embargoes: [], policyRateBp: 100 };

const task: AgentTask = {
  universeId: 'u0', cycle: 3, agentId: 'helion:colonist:1', role: 'colonist', planet: 'helion',
  observation: {
    purse: { HLX: 1000 }, inventory: { grain: 2 }, openOrders: [], loans: [], shipments: [],
    markets: [{ good: 'iron', bids: [{ price: 95, qty: 3 }], asks: [{ price: 105, qty: 2 }], lastPrice: 100, trend: [98, 99, 100] }],
    fx: [{ base: 'HLX', quote: 'VRD', lastRatePpm: 1_250_000 }],
    policy, headlines: ['Iron prices steady'], memo: 'waiting for the Verdan launch window',
  },
  allowedActions: ['place_order', 'pass'], deadlineMs: 5000,
};

const decision: AgentDecision = {
  agentId: 'helion:colonist:1',
  actions: [{ kind: 'place_order', good: 'grain', side: 'buy', qty: 2, limitPrice: 45 }, { kind: 'pass' }],
  survey: { type: 'consumer', confidence: 60 }, reason: 'Grain is cheap; stock up.', memo: 'buy grain again',
  source: 'llm', usage: { model: 'gemini-flash', inputTokens: 900, cachedTokens: 700, outputTokens: 80, costUsd: 0.0004, latencyMs: 850 },
};

const snapshot: Snapshot = {
  universeId: 'u0', cycle: 3, paused: false,
  planets: [{
    planet: 'helion', currency: 'HLX', prices: { iron: 100 }, policy, orbitPhaseCycles: 3,
    metrics: { gdp: 50_000, cpi: 10_000, tradeBalance: -1_200, population: 30, consumerConfidence: 55, businessConfidence: 60 },
  }],
  fx: [{ base: 'HLX', quote: 'VRD', ratePpm: 1_250_000 }],
  shipments: [{ id: 's1', owner: 'helion:trader:1', from: 'helion', to: 'verdan', cargo: [{ good: 'iron', qty: 5 }], departCycle: 2, arriveCycle: 5, status: 'in_flight' }],
  events: [{ id: 'e1', cycle: 3, kind: 'headline', planet: 'helion', text: 'Iron holds' }],
  series: [{ metric: 'gdp', planet: 'helion', points: [[1, 49_000], [2, 50_000]] }],
  gatewayCostUsd: 0.12,
};

describe('contracts', () => {
  it('exposes a version', () => expect(CONTRACTS_VERSION).toBe('0.1.0'));

  it('DEFAULT_WORLD parses and is stable', () => {
    expect(WorldConfigSchema.parse(DEFAULT_WORLD)).toEqual(DEFAULT_WORLD);
    expect(DEFAULT_WORLD.planets.map((p) => p.id)).toEqual(['helion', 'verdan', 'tethys']);
  });

  it('rejects a world with an unknown recipe', () => {
    const bad = structuredClone(DEFAULT_WORLD);
    bad.planets[0]!.recipes.push({ recipe: 'nope', batchesPerCycle: 1 });
    expect(WorldConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('round-trips AgentTask, AgentDecision, Snapshot, GodModeCommand', () => {
    expect(AgentTaskSchema.parse(JSON.parse(JSON.stringify(task)))).toEqual(task);
    expect(AgentDecisionSchema.parse(JSON.parse(JSON.stringify(decision)))).toEqual(decision);
    expect(SnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    const cmd = { kind: 'shock', planet: 'helion', shock: 'strike', good: 'iron', magnitudeBp: -3000, durationCycles: 5 } as const;
    expect(GodModeCommandSchema.parse(cmd)).toEqual(cmd);
  });

  it('round-trips WS envelopes', () => {
    const msg = { type: 'snapshot', snapshot } as const;
    expect(ServerMessageSchema.parse(msg)).toEqual(msg);
    const c = { type: 'command', commandId: 'c1', universeId: 'u0', command: { kind: 'pause' } } as const;
    expect(ClientMessageSchema.parse(c)).toEqual(c);
  });

  it('rejects float amounts', () => {
    expect(ActionSchema.safeParse({ kind: 'place_order', good: 'iron', side: 'buy', qty: 1.5, limitPrice: 10 }).success).toBe(false);
    expect(ActionSchema.safeParse({ kind: 'place_order', good: 'iron', side: 'buy', qty: 1, limitPrice: 10.5 }).success).toBe(false);
    expect(ActionSchema.safeParse({ kind: 'place_order', good: 'iron', side: 'buy', qty: 1, limitPrice: -1 }).success).toBe(false);
  });

  it('rejects memo over 200 chars', () => {
    expect(AgentDecisionSchema.safeParse({ ...decision, memo: 'x'.repeat(201) }).success).toBe(false);
    expect(AgentDecisionSchema.safeParse({ ...decision, memo: 'x'.repeat(200) }).success).toBe(true);
  });

  it('rejects unknown action kinds and sources', () => {
    expect(AgentDecisionSchema.safeParse({ ...decision, actions: [{ kind: 'teleport' }] }).success).toBe(false);
    expect(AgentDecisionSchema.safeParse({ ...decision, source: 'oracle' }).success).toBe(false);
    expect(GodModeCommandSchema.safeParse({ kind: 'nuke' }).success).toBe(false);
  });

  it('ACTION_KINDS matches the Action union', () => {
    const kinds = ActionSchema.options.map((o) => o.shape.kind.value).sort();
    expect([...ACTION_KINDS].sort()).toEqual(kinds);
  });
});
