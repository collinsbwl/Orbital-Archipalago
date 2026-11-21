// LlmPolicy — the default for due agents on cheap/full profiles. Build a
// GatewayRequest with the §3.5 layout, invoke the gateway, zod-parse the
// output, stamp source/usage. Any failure returns null so the runtime can
// swap in standing orders (the runtime also tracks `budget_exhausted` so the
// rest of the run drops to the stub policy).

import type { AgentDecision, AgentTask, ModelGateway, Profile, ToolDeclaration, Usage } from '@orbital/contracts';
import { AgentDecisionSchema } from '@orbital/contracts';
import type { Policy, PolicyCtx } from '../policy.js';
import { buildRequest } from '../prompt/builder.js';

export class LlmPolicy implements Policy {
  readonly name = 'llm';

  constructor(
    private readonly gateway: ModelGateway,
    private readonly profile: Profile,
    private readonly toolsFor: (task: AgentTask) => ToolDeclaration[] = () => [],
    private readonly runTool?: (name: string, args: unknown, task: AgentTask) => Promise<unknown>,
  ) {}

  async decide(task: AgentTask, ctx: PolicyCtx): Promise<AgentDecision> {
    const request = buildRequest({
      task,
      profile: this.profile,
      tools: this.toolsFor(task),
      runTool: this.runTool ? (name, args) => this.runTool!(name, args, task) : undefined,
    });
    const signal = ctx.signal ?? new AbortController().signal;
    const result = await this.gateway.invoke(request, signal);
    if (!result.ok) {
      // Caller inspects .source to decide whether to fall back (standing orders)
      // or short-circuit the run (budget_exhausted → stub policy).
      const error = new LlmPolicyError(result.failure, result.message ?? result.failure);
      throw error;
    }
    const parsed = AgentDecisionSchema.parse({
      agentId: task.agentId,
      actions: isDecisionShape(result.output) ? result.output.actions : [],
      survey: isDecisionShape(result.output) ? result.output.survey : undefined,
      reason: isDecisionShape(result.output) ? result.output.reason : 'llm',
      memo: isDecisionShape(result.output) ? result.output.memo : undefined,
      source: 'llm',
      usage: result.usage satisfies Usage,
    });
    return parsed;
  }
}

export class LlmPolicyError extends Error {
  constructor(readonly failure: string, message: string) {
    super(message);
    this.name = 'LlmPolicyError';
  }
}

function isDecisionShape(x: unknown): x is {
  actions: unknown[];
  survey?: unknown;
  reason?: string;
  memo?: string;
} {
  return typeof x === 'object' && x !== null && 'actions' in (x as Record<string, unknown>);
}
