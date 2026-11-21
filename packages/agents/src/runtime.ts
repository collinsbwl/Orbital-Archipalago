// DefaultAgentRuntime (architecture.md §3.2, §3.8).
//
// - Picks a policy per task.
// - Runs the per-cycle batch in parallel, each with its own deadline-bound
//   AbortController, so a slow model never stalls the cycle.
// - Any throw or deadline miss resolves to standing orders.
// - Every decision passes through AgentDecisionSchema.parse before leaving the
//   runtime, with agentId forced to the task's id (the engine never trusts
//   whatever the model returns).
// - On budget_exhausted the runtime switches the rest of the run to StubPolicy.
// - The last decision per (universeId, agentId) is the only in-memory state,
//   and it is reconstructible from the recorder.

import type { AgentDecision, AgentRuntime, AgentTask, ModelGateway, Profile, Role, ToolDeclaration, WorldConfig } from '@orbital/contracts';
import { AgentDecisionSchema } from '@orbital/contracts';
import type { Policy, PolicyCtx } from './policy.js';
import { RandomValidPolicy } from './policies/random.js';
import { StubPolicy } from './policies/stub.js';
import { RulePolicy } from './policies/rule.js';
import { StandingOrdersPolicy } from './policies/standing-orders.js';
import { LlmPolicy, LlmPolicyError } from './policies/llm.js';
import { rngFor } from './rng.js';

export interface DefaultAgentRuntimeConfig {
  world: WorldConfig;
  /** Required for `cheap` / `full`. Ignored for `stub`. */
  gateway?: ModelGateway;
  /** Override the policy choice per role. */
  policies?: Partial<Record<Role, Policy>>;
  /** Read tools passed to the LlmPolicy for `tools` mode. */
  toolsFor?: (task: AgentTask) => ToolDeclaration[];
  runTool?: (name: string, args: unknown, task: AgentTask) => Promise<unknown>;
  /** Profile for the whole runtime. Each universe can have its own instance. */
  profile?: Profile;
  /** Called when the budget switches us to stub for the rest of the run. */
  onDegrade?: (reason: 'budget_exhausted') => void;
}

export class DefaultAgentRuntime implements AgentRuntime {
  private readonly world: WorldConfig;
  private readonly gateway?: ModelGateway;
  private readonly profile: Profile;
  private readonly roleOverrides: Partial<Record<Role, Policy>>;
  private readonly standing = new StandingOrdersPolicy();
  private readonly stub = new StubPolicy();
  private readonly rule = new RulePolicy();
  private readonly random = new RandomValidPolicy();
  private readonly llm?: LlmPolicy;
  private readonly previous = new Map<string, AgentDecision>();
  private readonly onDegrade?: (reason: 'budget_exhausted') => void;
  private degraded = false;

  constructor(cfg: DefaultAgentRuntimeConfig) {
    this.world = cfg.world;
    this.gateway = cfg.gateway;
    this.profile = cfg.profile ?? cfg.world.gatewayProfile;
    this.roleOverrides = cfg.policies ?? {};
    this.onDegrade = cfg.onDegrade;
    if (this.profile !== 'stub' && this.gateway) {
      this.llm = new LlmPolicy(this.gateway, this.profile, cfg.toolsFor, cfg.runTool);
    }
  }

  async decideAll(tasks: AgentTask[], signal: AbortSignal): Promise<AgentDecision[]> {
    const results = await Promise.all(tasks.map((task) => this.decideOne(task, signal)));
    return results;
  }

  private async decideOne(task: AgentTask, parent: AbortSignal): Promise<AgentDecision> {
    const key = `${task.universeId}:${task.agentId}`;
    const ctrl = linkedController(parent, task.deadlineMs);
    const ctx: PolicyCtx = {
      world: this.world,
      rng: rngFor({ seed: this.world.seed, universeId: task.universeId, cycle: task.cycle, agentId: task.agentId }),
      previous: this.previous.get(key),
      signal: ctrl.signal,
    };
    const policy = this.pickPolicy(task.role);
    let decision: AgentDecision;
    try {
      decision = await policy.decide(task, ctx);
    } catch (err) {
      if (err instanceof LlmPolicyError && err.failure === 'budget_exhausted' && !this.degraded) {
        this.degraded = true;
        this.onDegrade?.('budget_exhausted');
      }
      decision = await this.standing.decide(task, ctx);
    } finally {
      ctrl.cleanup();
    }
    const stamped = finalize(task, decision);
    this.previous.set(key, stamped);
    return stamped;
  }

  private pickPolicy(role: Role): Policy {
    const override = this.roleOverrides[role];
    if (override) return override;
    if (this.degraded) return this.stub;
    if (role === 'reserve_bank') return this.rule;
    if (this.profile === 'stub') return this.stub;
    if (this.llm) return this.llm;
    return this.stub;
  }

  /** For tests / forks: pre-seed the standing-orders memory with a prior decision. */
  seedPrevious(universeId: string, agentId: string, decision: AgentDecision): void {
    this.previous.set(`${universeId}:${agentId}`, decision);
  }
}

/** Zod-validate and lock `agentId`. The engine never trusts the model's echo. */
function finalize(task: AgentTask, decision: AgentDecision): AgentDecision {
  const candidate = { ...decision, agentId: task.agentId };
  const parsed = AgentDecisionSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  // Last resort: a pass with the agent's id, so the engine's Validator step sees a usable shape.
  return {
    agentId: task.agentId,
    actions: [{ kind: 'pass' }],
    reason: 'invalid decision replaced with pass',
    source: 'standing_orders',
  };
}

interface Linked {
  signal: AbortSignal;
  cleanup: () => void;
}

function linkedController(parent: AbortSignal, deadlineMs: number): Linked {
  const ctrl = new AbortController();
  if (parent.aborted) ctrl.abort(parent.reason);
  const onParent = () => ctrl.abort(parent.reason);
  parent.addEventListener('abort', onParent);
  const timer = setTimeout(() => ctrl.abort(new DOMException('deadline', 'TimeoutError')), Math.max(0, deadlineMs));
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onParent);
    },
  };
}
