// PromptBuilder — turns an AgentTask into a GatewayRequest with the §3.5
// layout: sorted tools + frozen system text as prefix (cacheable); planet /
// cycle context next; per-agent state last and small.

import type { AgentTask, GatewayRequest, Profile, ToolDeclaration } from '@orbital/contracts';
import { AgentDecisionSchema, ActionSchema } from '@orbital/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { systemRulesFor } from './rules.js';

export interface BuildArgs {
  task: AgentTask;
  profile: Profile;
  /** Read tools the model may call in `tools` mode. Keep them pure. */
  tools?: ToolDeclaration[];
  /** Thread the engine's read-tool runner. */
  runTool?: GatewayRequest['runTool'];
}

/** Build the `responseSchema` the model emits, narrowing actions to what's allowed this cycle. */
function responseSchemaFor(task: AgentTask): Record<string, unknown> {
  // The model never returns `source`, `usage` or `agentId`; the runtime fills those in.
  const allowed = new Set(task.allowedActions);
  const narrowedAction = ActionSchema.refine((a) => allowed.has(a.kind), { message: 'disallowed action' });
  const schema = AgentDecisionSchema.pick({ actions: true, survey: true, reason: true, memo: true }).extend({
    actions: z.array(narrowedAction).max(20),
  });
  return zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
}

/** Planet + cycle context: the shared block for everyone on this planet this cycle. */
export function contextBlockFor(task: AgentTask): string {
  const o = task.observation;
  const marketLines = o.markets.map((m) => {
    const bid = m.bids[0];
    const ask = m.asks[0];
    const bidStr = bid ? `${bid.qty}@${bid.price}` : 'none';
    const askStr = ask ? `${ask.qty}@${ask.price}` : 'none';
    const trend = m.trend.length > 0 ? m.trend.join(',') : 'n/a';
    return `- ${m.good}: last=${m.lastPrice ?? 'n/a'} bid=${bidStr} ask=${askStr} trend=[${trend}]`;
  }).join('\n');
  const fxLines = o.fx.map((f) => `- ${f.base}/${f.quote}: ${f.lastRatePpm ?? 'n/a'}ppm`).join('\n');
  const headlines = o.headlines.length ? o.headlines.map((h) => `- ${h}`).join('\n') : '- (none)';
  const briefing = o.briefing ? `\n\nBriefing:\n${o.briefing}` : '';
  const elsewhere = o.elsewhere?.length
    ? `\n\nOther planets (last price in their own currency, import tariff, travel time from here):\n${o.elsewhere
        .map((r) => `- ${r.planet} (${r.travelCycles} cycles): ${r.goods.map((g) => `${g.good}=${g.lastPrice ?? 'n/a'}${g.tariffBp ? ` (tariff ${g.tariffBp}bp)` : ''}`).join(', ')}`)
        .join('\n')}`
    : '';
  return [
    `Planet ${task.planet}, cycle ${task.cycle}.`,
    '',
    'Markets:',
    marketLines || '- (none)',
    '',
    'FX:',
    fxLines || '- (none)',
    elsewhere,
    '',
    'Policy:',
    `- tariffs(bp): ${JSON.stringify(o.policy.tariffsBp)}`,
    `- quotas: ${JSON.stringify(o.policy.quotas)}`,
    `- embargoes: ${JSON.stringify(o.policy.embargoes)}`,
    `- policy rate(bp): ${o.policy.policyRateBp}`,
    '',
    'Headlines:',
    headlines,
    briefing,
  ].join('\n');
}

/** Per-agent, uncached suffix. Keep it compact and stable-sorted. */
export function stateBlockFor(task: AgentTask): string {
  const o = task.observation;
  // Sort every record so the serialisation is stable. Memos are tiny but remind
  // the model where it was; that is the whole continuity story.
  const payload = {
    purse: sortKeys(o.purse),
    inventory: sortKeys(o.inventory),
    openOrders: o.openOrders,
    loans: o.loans,
    shipments: o.shipments,
    allowedActions: [...task.allowedActions].sort(),
    memo: o.memo ?? null,
  };
  return JSON.stringify(payload);
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key]!;
  return out;
}

export function buildRequest(args: BuildArgs): GatewayRequest {
  const { task, profile, tools = [], runTool } = args;
  return {
    universeId: task.universeId,
    cycle: task.cycle,
    agentId: task.agentId,
    role: task.role,
    planet: task.planet,
    profile,
    prefix: { system: systemRulesFor(task.role), tools },
    context: contextBlockFor(task),
    state: stateBlockFor(task),
    responseSchema: responseSchemaFor(task),
    deadlineMs: task.deadlineMs,
    runTool,
  };
}
