import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The program binary that `anchor build` produces (git-ignored, so CI machines without Solana tooling won't have it). */
export const PROGRAM_SO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../target/deploy/orbital.so');

export const SOLANA_BIN = `${process.env.HOME}/.local/share/solana/install/active_release/bin`;

export const hasProgram = existsSync(PROGRAM_SO);

/** True if `solana-test-validator` can run here. */
export const hasValidator = hasProgram && spawnSync('solana-test-validator', ['--version'], {
  stdio: 'ignore',
  env: { ...process.env, PATH: `${SOLANA_BIN}:${process.env.PATH}` },
}).status === 0;
