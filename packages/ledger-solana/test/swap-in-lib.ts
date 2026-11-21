import { Keypair, PublicKey } from '@solana/web3.js';
import { LiteSVM } from 'litesvm';
import type { Ledger, WorldConfig } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { RandomValidPolicy, Universe, listAgents } from '@orbital/engine';
import { bootstrapLedger } from '../src/index.js';
import { IDL } from '../src/idl/orbital.js';
import { LiteSvmChain } from './litesvm-chain.js';
import { PROGRAM_SO } from './env.js';

/** A fresh in-process Solana chain with the program loaded and a funded admin. */
export async function makeSolanaLedger(world: WorldConfig): Promise<Ledger> {
  const svm = new LiteSVM();
  svm.addProgramFromFile(new PublicKey(IDL.address), PROGRAM_SO);
  const admin = Keypair.generate();
  svm.airdrop(admin.publicKey, 1_000_000_000_000n);
  return bootstrapLedger({ chain: new LiteSvmChain(svm), admin, world });
}

export interface Divergence {
  cycle: number;
  /** What differed, e.g. "cycle report" or "state". */
  what: string;
  /** First differing path inside it. */
  path: string;
  memory: unknown;
  solana: unknown;
}

export interface SwapInResult {
  cyclesRun: number;
  divergence: Divergence | null;
  msMemory: number;
  msSolana: number;
}

/** First place two JSON-like values differ, as a path, or null if equal. */
export function firstDiff(a: unknown, b: unknown, path = '$'): { path: string; a: unknown; b: unknown } | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return { path, a, b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, a, b };
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

/** Everything observable through the Ledger interface: purses, inventories, resting orders, policies, supply totals. */
export async function ledgerState(l: Ledger, world: WorldConfig): Promise<unknown> {
  const owners = [...world.planets.map((p) => p.id), ...listAgents(world).map((a) => a.id)];
  const agents = new Set(listAgents(world).map((a) => a.id));
  const state: Record<string, unknown> = {};
  for (const o of owners) {
    const purse: Record<string, number> = {};
    for (const p of world.planets) purse[p.currency] = await l.getPurse(o, p.currency);
    const inventory: Record<string, number> = {};
    for (const p of world.planets) for (const g of world.goods) {
      const q = await l.getInventory(o, p.id, g.id);
      if (q > 0) inventory[`${p.id}/${g.id}`] = q;
    }
    state[o] = { purse, inventory, orders: agents.has(o) ? await l.openOrders(o) : [] };
  }
  const policies: Record<string, unknown> = {};
  for (const p of world.planets) policies[p.id] = await l.getPolicy(p.id);
  const inv = await l.checkInvariants();
  return { owners: state, policies, invariants: { ok: inv.ok, violations: inv.violations, totals: inv.totals } };
}

/**
 * Runs the same seed on InMemoryLedger and SolanaLedger side by side. After every cycle it compares the cycle report and
 * the snapshot; every `deepEvery` cycles it also compares the whole ledger state. Stops at the first difference.
 */
export async function runSwapIn(opts: {
  world: WorldConfig;
  cycles: number;
  deepEvery?: number;
  onCycle?: (cycle: number, ms: { memory: number; solana: number }) => void;
}): Promise<SwapInResult> {
  const { world, cycles, deepEvery = 1 } = opts;
  const memory = new InMemoryLedger(world);
  const solana = await makeSolanaLedger(world);
  const mk = (ledger: Ledger) => new Universe({ world, ledger, agents: new RandomValidPolicy(world, world.seed) });
  const [um, us] = [mk(memory), mk(solana)];
  await um.init();
  await us.init();

  let msMemory = 0;
  let msSolana = 0;
  const diverged = (cycle: number, what: string, m: unknown, s: unknown): SwapInResult | null => {
    const d = firstDiff(m, s);
    return d ? { cyclesRun: cycle, msMemory, msSolana, divergence: { cycle, what, path: d.path, memory: d.a, solana: d.b } } : null;
  };

  for (let i = 1; i <= cycles; i++) {
    let t = performance.now();
    const rm = await um.step();
    const dm = performance.now() - t;
    msMemory += dm;

    t = performance.now();
    let rs;
    try {
      rs = await us.step();
    } catch (e) {
      return { cyclesRun: i, msMemory, msSolana, divergence: { cycle: i, what: 'SolanaLedger threw', path: '$', memory: 'ok', solana: e instanceof Error ? e.message : String(e) } };
    }
    const ds = performance.now() - t;
    msSolana += ds;
    opts.onCycle?.(i, { memory: dm, solana: ds });

    const reportDiff = diverged(i, 'cycle report', JSON.parse(JSON.stringify(rm)), JSON.parse(JSON.stringify(rs)));
    if (reportDiff) return reportDiff;
    const snapDiff = diverged(i, 'snapshot', await um.snapshot({ series: [] }), await us.snapshot({ series: [] }));
    if (snapDiff) return snapDiff;
    if (i % deepEvery === 0 || i === cycles) {
      const stateDiff = diverged(i, 'ledger state', await ledgerState(memory, world), await ledgerState(solana, world));
      if (stateDiff) return stateDiff;
    }
  }
  return { cyclesRun: cycles, msMemory, msSolana, divergence: null };
}
