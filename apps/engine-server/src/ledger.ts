import type { Ledger, WorldConfig } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { Addresses, bootstrapLedger, ConnectionChain, IDL } from '@orbital/ledger-solana';
import { type Commitment, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

export type LedgerKind = 'memory' | 'solana';

type Env = Record<string, string | undefined>;

export const DEFAULT_RPC_URL = 'http://127.0.0.1:8899';
const MIN_ADMIN_SOL = 100;
const AIRDROP_SOL = 1000;
const RPC_WAIT_MS = 60_000;

/** `LEDGER` env: unset or `memory` → in-memory, `solana` → on-chain. Anything else is a configuration error. */
export function ledgerKind(env: Env = process.env): LedgerKind {
  const v = (env.LEDGER ?? '').trim().toLowerCase();
  if (v === '' || v === 'memory') return 'memory';
  if (v === 'solana') return 'solana';
  throw new Error(`LEDGER must be "memory" or "solana", got "${env.LEDGER}"`);
}

/** `SOLANA_ADMIN_KEYPAIR` as a JSON byte array (the format of ~/.config/solana/id.json), or a fresh key. */
export function adminKeypair(env: Env = process.env): Keypair {
  const raw = env.SOLANA_ADMIN_KEYPAIR?.trim();
  if (!raw) return Keypair.generate();
  let bytes: unknown;
  try {
    bytes = JSON.parse(raw);
  } catch {
    throw new Error('SOLANA_ADMIN_KEYPAIR must be a JSON array of 64 bytes');
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error('SOLANA_ADMIN_KEYPAIR must be a JSON array of 64 bytes');
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

/**
 * `SOLANA_COMMITMENT`: how settled a transaction must be before the engine moves on. `processed` is safe and several
 * times faster on a single local validator (nothing to roll back); keep `confirmed` (the default) on devnet or mainnet.
 */
export function commitment(env: Env = process.env): Commitment {
  const v = (env.SOLANA_COMMITMENT ?? '').trim().toLowerCase();
  if (v === '') return 'confirmed';
  if (v === 'processed' || v === 'confirmed' || v === 'finalized') return v;
  throw new Error(`SOLANA_COMMITMENT must be processed, confirmed or finalized, got "${env.SOLANA_COMMITMENT}"`);
}

/** Builds the ledger the engine runs on, chosen by the `LEDGER` env var. */
export async function makeLedger(world: WorldConfig, env: Env = process.env, log: (msg: string) => void = console.log): Promise<Ledger> {
  if (ledgerKind(env) === 'memory') {
    log('ledger: memory');
    return new InMemoryLedger(world);
  }

  const rpcUrl = env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const admin = adminKeypair(env);
  const level = commitment(env);
  log(`ledger: solana (rpc ${rpcUrl}, commitment ${level}, admin ${admin.publicKey.toBase58()})`);
  const connection = new Connection(rpcUrl, level);
  await waitForRpc(connection, rpcUrl);

  const programId = new PublicKey(IDL.address);
  if (!(await connection.getAccountInfo(programId))) {
    throw new Error(`Orbital program ${programId.toBase58()} is not deployed on ${rpcUrl}; start the validator with --bpf-program`);
  }
  // The engine opens every account on start and SolanaLedger keeps its owner map in memory, so it needs a fresh chain.
  if (await connection.getAccountInfo(new Addresses(programId, admin.publicKey).config())) {
    throw new Error(`chain at ${rpcUrl} is already bootstrapped; restart the validator with --reset (e.g. docker compose restart solana-test-validator engine)`);
  }

  await fund(connection, admin.publicKey, log);
  const ledger = await bootstrapLedger({ chain: new ConnectionChain(connection, level), connection, admin, world });
  log('ledger: solana bootstrap complete');
  return ledger;
}

async function waitForRpc(connection: Connection, rpcUrl: string): Promise<void> {
  const deadline = Date.now() + RPC_WAIT_MS;
  for (;;) {
    try {
      await connection.getLatestBlockhash();
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`Solana RPC at ${rpcUrl} not reachable after ${RPC_WAIT_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function fund(connection: Connection, who: PublicKey, log: (msg: string) => void): Promise<void> {
  const balance = await connection.getBalance(who, 'confirmed');
  if (balance >= MIN_ADMIN_SOL * LAMPORTS_PER_SOL) return;
  log(`ledger: airdropping ${AIRDROP_SOL} SOL to admin`);
  const sig = await connection.requestAirdrop(who, AIRDROP_SOL * LAMPORTS_PER_SOL);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
}
