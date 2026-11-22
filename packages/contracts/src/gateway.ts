import { z } from 'zod';
import type { AgentId, PlanetId, UniverseId } from './ids.js';
import { AgentIdSchema, CycleSchema } from './ids.js';
import type { Role } from './agent.js';

// Route tables and model ids live in packages/gateway; only the shapes are shared.
export const ProfileSchema = z.enum(['stub', 'cheap', 'full']);
export type Profile = z.infer<typeof ProfileSchema>;

export type ModelTier = 'small' | 'mid' | 'frontier';
export type Tier = ModelTier | 'rule';
export type CallMode = 'structured' | 'tools' | 'text';
export type Effort = 'low' | 'medium' | 'high';

export type Route =
  | { tier: 'rule' }
  | { tier: ModelTier; maxTurns: number; effort: Effort; maxTokens: number; mode: CallMode };

export const UsageSchema = z.object({
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** USD telemetry: the one float in the contracts, never ledger state. */
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON schema of the arguments. */
  parameters: Record<string, unknown>;
}

/** What the PromptBuilder hands the gateway. Layout follows architecture.md §3.5. */
export interface GatewayRequest {
  universeId: UniverseId;
  cycle: number;
  agentId: AgentId;
  role: Role;
  planet: PlanetId;
  profile: Profile;
  /** Cacheable prefix: sorted tools + frozen system text. */
  prefix: { system: string; tools: ToolDeclaration[] };
  /** Planet/cycle context block (shared by agents on a planet). */
  context: string;
  /** Per-agent suffix (purse, inventory, memo). Uncached. */
  state: string;
  /** JSON schema for `structured` mode and for the terminal `submit_turn` tool. */
  responseSchema?: Record<string, unknown>;
  deadlineMs: number;
  /** Executes read-only tools in `tools` mode. Not recorded. */
  runTool?: (name: string, args: unknown) => Promise<unknown>;
}

export const GatewayFailureSchema = z.enum(['timeout', 'rate_limited', 'invalid_output', 'refused', 'budget_exhausted', 'error']);
export type GatewayFailure = z.infer<typeof GatewayFailureSchema>;

/** Any failure means the caller falls back to standing orders. */
export const GatewayResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** Parsed `submit_turn` / structured JSON, or text in `text` mode. Caller zod-validates. */
    output: z.unknown(),
    usage: UsageSchema,
    turns: z.number().int().positive(),
  }),
  z.object({ ok: z.literal(false), failure: GatewayFailureSchema, message: z.string().optional(), usage: UsageSchema.optional() }),
]);
export type GatewayResult = z.infer<typeof GatewayResultSchema>;

export interface ModelGateway {
  invoke(req: GatewayRequest, signal: AbortSignal): Promise<GatewayResult>;
}

// Re-exported for implementers that key recorder rows.
export type RecorderKey = { cycle: number; agentId: AgentId; turn: number };
export const RecorderKeySchema = z.object({ cycle: CycleSchema, agentId: AgentIdSchema, turn: z.number().int().nonnegative() });

// ---- Decision gateway (closed-set, non-generative) -----------------------
// Gemini Decision 1 scores caller-supplied options in one pass instead of
// generating text. Question shapes mirror the API (`noul` = yes/no).

export type DecisionQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true_description?: string; false_description?: string } }
  | { type: 'choice'; instructions: string; /** Option id → description (2-255 options). */ criteria: Record<string, string> }
  | { type: 'score'; instructions: string; /** Rubric levels, lowest first (2-255). */ criteria: string[] };

export type DecisionAnswer =
  | { type: 'noul'; /** Calibrated P(true), 0.01-0.99. */ noul: number; confidence: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; /** Probability-weighted level index; may be fractional. */ score: number; probabilities: Record<string, number>; confidence: number };

export interface DecisionRequest {
  universeId: UniverseId;
  cycle: number;
  agentId: AgentId;
  role: Role;
  planet: PlanetId;
  /** Shared context every question is evaluated against. */
  input: string;
  /** Keyed by caller-defined ids matching [A-Za-z0-9_-]{1,64}. 1-1,000 questions. */
  questions: Record<string, DecisionQuestion>;
  deadlineMs: number;
}

export type DecisionResult =
  | { ok: true; answers: Record<string, DecisionAnswer>; usage: Usage }
  | { ok: false; failure: GatewayFailure; message?: string; usage?: Usage };

export interface DecisionGateway {
  decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
}
