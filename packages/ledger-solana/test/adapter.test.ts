import { Keypair, PublicKey } from '@solana/web3.js';
import { LiteSVM } from 'litesvm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD, LedgerError, type WorldConfig } from '@orbital/contracts';
import { bootstrapLedger, SolanaLedger } from '../src/index.js';
import { IDL } from '../src/idl/orbital.js';
import { hasProgram, PROGRAM_SO } from './env.js';
import { LiteSvmChain } from './litesvm-chain.js';

// Currencies of different lengths: the contract allows 2-5 capitals.
const WORLD: WorldConfig = structuredClone(DEFAULT_WORLD);
WORLD.planets[0]!.currency = 'HX';
WORLD.planets[1]!.currency = 'VERDA';

async function make(): Promise<{ ledger: SolanaLedger; svm: LiteSVM }> {
  const svm = new LiteSVM();
  svm.addProgramFromFile(new PublicKey(IDL.address), PROGRAM_SO);
  const admin = Keypair.generate();
  svm.airdrop(admin.publicKey, 1_000_000_000_000n);
  return { ledger: await bootstrapLedger({ chain: new LiteSvmChain(svm), admin, world: WORLD }), svm };
}

describe.skipIf(!hasProgram)('SolanaLedger on a world with 2-, 3- and 5-letter currencies', () => {
  it('opens accounts, moves money and keeps invariants', async () => {
    const { ledger } = await make();
    await ledger.openAccount({ owner: 'a1', planet: 'helion', purse: { HX: 1_000, VERDA: 50, TTH: 7 }, inventory: { iron: 10 } });
    await ledger.openAccount({ owner: 'a2', planet: 'helion' });
    expect(await ledger.getPurse('a1', 'HX')).toBe(1_000);
    expect(await ledger.getPurse('a1', 'VERDA')).toBe(50);
    expect(await ledger.getPurse('a1', 'TTH')).toBe(7);
    await ledger.transfer({ from: 'a1', to: 'a2', currency: 'VERDA', amount: 20 });
    expect(await ledger.getPurse('a2', 'VERDA')).toBe(20);
    expect((await ledger.checkInvariants()).ok).toBe(true);
  });

  it('trades across 2- and 5-letter currencies (FX book names the pair)', async () => {
    const { ledger } = await make();
    await ledger.openAccount({ owner: 'helion', planet: 'helion', purse: { HX: 100 } });
    await ledger.openAccount({ owner: 'verdan', planet: 'verdan', purse: { VERDA: 100 } });
    await ledger.openAccount({ owner: 'a1', planet: 'helion', purse: { HX: 1_000, VERDA: 1_000 } });
    await ledger.openAccount({ owner: 'a2', planet: 'helion', purse: { HX: 1_000, VERDA: 1_000 } });
    // 'HX' sorts before 'VERDA'; HX is the base here
    await ledger.placeFxOrders([
      { agentId: 'a1', give: 'HX', giveAmount: 100, want: 'VERDA', minReceive: 100 },
      { agentId: 'a2', give: 'VERDA', giveAmount: 100, want: 'HX', minReceive: 100 },
    ], 1);
    const res = await ledger.clearFxAuction('HX', 'VERDA', 1);
    expect(res.ratePpm).toBe(1_000_000);
    expect((await ledger.checkInvariants()).ok).toBe(true);
  });

  it('a rejected openAccount leaves nothing behind, and an owner opens exactly once', async () => {
    // (That the program itself is all-or-nothing, even when it fails after minting, is tested in programs/orbital/tests.)
    const { ledger } = await make();
    await ledger.openAccount({ owner: 'seed', planet: 'helion', purse: { HX: 1 } }); // so there is supply to compare against
    const before = (await ledger.checkInvariants()).totals;
    await expect(ledger.openAccount({ owner: 'broken', planet: 'helion', purse: { HX: 500, VERDA: 500 }, inventory: { nothing: 1 } }))
      .rejects.toBeInstanceOf(LedgerError); // unknown good
    expect((await ledger.checkInvariants()).totals).toEqual(before);

    // The same owner opens fine afterwards, exactly once.
    await ledger.openAccount({ owner: 'broken', planet: 'helion', purse: { HX: 500 } });
    await expect(ledger.openAccount({ owner: 'broken', planet: 'helion' })).rejects.toMatchObject({ code: 'invalid_state' });
    expect(await ledger.getPurse('broken', 'HX')).toBe(500);
  });

  it('rejects a currency code outside 2-5 capitals when bootstrapping', async () => {
    const bad: WorldConfig = structuredClone(DEFAULT_WORLD);
    bad.planets[0]!.currency = 'H';
    const svm = new LiteSVM();
    svm.addProgramFromFile(new PublicKey(IDL.address), PROGRAM_SO);
    const admin = Keypair.generate();
    svm.airdrop(admin.publicKey, 1_000_000_000_000n);
    await expect(bootstrapLedger({ chain: new LiteSvmChain(svm), admin, world: bad })).rejects.toBeInstanceOf(LedgerError);
  });
});
