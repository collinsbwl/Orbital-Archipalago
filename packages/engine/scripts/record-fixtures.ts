// Records 5 cycles of AgentTask[] from DEFAULT_WORLD (InMemoryLedger + RandomValidPolicy) into fixtures/agent-tasks.json.
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
    // Evenly spaced sample so every planet and role shows up, not just the first planet's colonists.
    recorded.push(Array.from({ length: Math.min(PER_CYCLE, tasks.length) }, (_, i) => tasks[Math.floor((i * tasks.length) / PER_CYCLE)] as AgentTask));
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
