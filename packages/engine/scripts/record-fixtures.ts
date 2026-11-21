// Records 5 cycles of AgentTask[] (colonists and traders) from DEFAULT_WORLD (InMemoryLedger + RandomValidPolicy) into fixtures/agent-tasks.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_WORLD } from '@orbital/contracts';
import type { AgentDecision, AgentTask } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { RandomValidPolicy, Universe } from '../src/index.js';
import type { DecisionProvider } from '../src/index.js';

const CYCLES = 5;
const PER_CYCLE = 10;

const inner = new RandomValidPolicy(DEFAULT_WORLD, DEFAULT_WORLD.seed);
const recorded: AgentTask[][] = [];
const recorder: DecisionProvider = {
  async decideAll(tasks: AgentTask[]): Promise<AgentDecision[]> {
    // Evenly spaced sample with up to 5 traders (ship/fx tasks) and colonists for the rest, spread over all planets.
    const spaced = (xs: AgentTask[], n: number) => Array.from({ length: Math.min(n, xs.length) }, (_, i) => xs[Math.floor((i * xs.length) / n)] as AgentTask);
    const traders = spaced(tasks.filter((t) => t.role === 'trader'), PER_CYCLE / 2);
    recorded.push([...spaced(tasks.filter((t) => t.role !== 'trader'), PER_CYCLE - traders.length), ...traders]);
    return inner.decideAll(tasks);
  },
};

const u = new Universe({ world: DEFAULT_WORLD, ledger: new InMemoryLedger(DEFAULT_WORLD), agents: recorder });
await u.init();
for (let i = 0; i < CYCLES; i++) await u.step();

const out = new URL('../fixtures/agent-tasks.json', import.meta.url);
mkdirSync(new URL('../fixtures/', import.meta.url), { recursive: true });
writeFileSync(out, JSON.stringify(recorded, null, 1) + '\n');
console.log(`wrote ${out.pathname}: ${recorded.length} cycles x ${recorded[0]?.length} tasks`);
