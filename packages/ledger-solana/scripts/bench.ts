// Usage: pnpm --filter @orbital/ledger-solana bench -- [--rpc http://127.0.0.1:8899] [--cycles 3] [--commitment confirmed]
// Times bootstrap and live cycles of the default world on a real validator (fresh chain: start it with --reset),
// counting transactions and account reads per cycle.
import { DEFAULT_WORLD } from '@orbital/contracts';
import { RandomValidPolicy, Universe } from '@orbital/engine';
import { type Commitment, Connection, Keypair, LAMPORTS_PER_SOL, type PublicKey, type Transaction } from '@solana/web3.js';
import { bootstrapLedger, type Chain, ConnectionChain } from '../src/index.js';

const opt = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const rpc = opt('rpc', 'http://127.0.0.1:8899');
const cycles = Number(opt('cycles', '3'));
const commitment = opt('commitment', 'confirmed') as Commitment;

/** Wraps a Chain and counts what goes through it. */
class CountingChain implements Chain {
  sends = 0;
  reads = 0;
  sendMs = 0;
  constructor(private readonly inner: Chain) {}
  async getAccountData(pk: PublicKey) { this.reads++; return this.inner.getAccountData(pk); }
  async getMultipleAccountsData(pks: PublicKey[]) {
    this.reads++;
    return this.inner.getMultipleAccountsData ? this.inner.getMultipleAccountsData(pks) : Promise.all(pks.map((p) => this.inner.getAccountData(p)));
  }
  async send(tx: Transaction, signers: Parameters<Chain['send']>[1]) {
    this.sends++;
    const t = performance.now();
    try { return await this.inner.send(tx, signers); } finally { this.sendMs += performance.now() - t; }
  }
  rentExemption(space: number) { return this.inner.rentExemption(space); }
  reset() { this.sends = 0; this.reads = 0; this.sendMs = 0; }
}

const connection = new Connection(rpc, commitment);
const admin = Keypair.generate();
const sig = await connection.requestAirdrop(admin.publicKey, 1000 * LAMPORTS_PER_SOL);
const bh = await connection.getLatestBlockhash();
await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');

const chain = new CountingChain(new ConnectionChain(connection, commitment));
const world = DEFAULT_WORLD;
let t = performance.now();
const ledger = await bootstrapLedger({ chain, connection, admin, world });
// Per-method wall time (overlapping calls are summed, so parallel phases read as more than wall time) and call counts.
const prof = new Map<string, { calls: number; ms: number; busy: number; active: number; since: number }>();
const timed = new Proxy(ledger, {
  get(target, prop, recv) {
    const v = Reflect.get(target, prop, recv);
    if (typeof v !== 'function') return v;
    return async (...args: unknown[]) => {
      const t0 = performance.now();
      const e = prof.get(String(prop)) ?? { calls: 0, ms: 0, busy: 0, active: 0, since: 0 };
      prof.set(String(prop), e);
      if (e.active++ === 0) e.since = t0;
      try { return await v.apply(target, args); } finally {
        const t1 = performance.now();
        e.calls++; e.ms += t1 - t0;
        if (--e.active === 0) e.busy += t1 - e.since; // wall time with at least one call in flight
      }
    };
  },
});
const universe = new Universe({ world, ledger: timed, agents: new RandomValidPolicy(world, world.seed) });
await universe.init();
console.log(`bootstrap+init: ${((performance.now() - t) / 1000).toFixed(1)}s, ${chain.sends} txs, ${chain.reads} reads (commitment ${commitment})`);

for (let i = 1; i <= cycles; i++) {
  chain.reset();
  prof.clear();
  t = performance.now();
  await universe.step();
  const ms = performance.now() - t;
  console.log(`cycle ${i}: ${(ms / 1000).toFixed(1)}s, ${chain.sends} txs (${(chain.sendMs / Math.max(chain.sends, 1)).toFixed(0)}ms avg per send), ${chain.reads} reads`);
  console.log('  wall: ' + [...prof].sort((a, b) => b[1].busy - a[1].busy).map(([k, v]) => `${k} ${v.calls}x ${(v.busy / 1000).toFixed(1)}s`).join(', '));
}
