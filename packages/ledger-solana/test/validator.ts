import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Connection } from '@solana/web3.js';
import { IDL } from '../src/idl/orbital.js';

/** Vitest global setup: runs a throwaway solana-test-validator with the built program loaded. */
let validator: ChildProcess | undefined;
let dir: string | undefined;

export const RPC_URL = 'http://127.0.0.1:8899';

export async function setup(): Promise<void> {
  const so = resolve(__dirname, '../../../target/deploy/orbital.so');
  if (!existsSync(so)) throw new Error(`missing ${so}: run \`anchor build\` first`);
  dir = mkdtempSync(join(tmpdir(), 'orbital-validator-'));
  validator = spawn('solana-test-validator', ['--reset', '--quiet', '--ledger', dir, '--bpf-program', IDL.address, so], {
    stdio: 'ignore',
    env: { ...process.env, PATH: `${process.env.HOME}/.local/share/solana/install/active_release/bin:${process.env.PATH}` },
  });
  validator.on('error', (e) => { throw e; });

  const conn = new Connection(RPC_URL, 'confirmed');
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { await conn.getLatestBlockhash(); return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('solana-test-validator did not start in 60s');
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function teardown(): Promise<void> {
  validator?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (dir) rmSync(dir, { recursive: true, force: true });
}
