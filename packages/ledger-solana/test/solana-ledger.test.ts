import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_WORLD, LedgerError } from '@orbital/contracts';
import { bootstrapLedger, SolanaLedger } from '../src/index.js';
import { hasValidator } from './env.js';
import { RPC_URL } from './validator.js';

// The validator is shared by every test in this file, so each test uses its own owner ids.
let ledger: SolanaLedger;
let n = 0;
const id = (p: string) => `${p}${n++}`;

const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e, `expected LedgerError ${code}`).toBeInstanceOf(LedgerError);
  expect((e as LedgerError).code).toBe(code);
};

beforeAll(async () => {
  if (!hasValidator) return;
  const connection = new Connection(RPC_URL, 'confirmed');
  const admin = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(admin.publicKey, 100 * LAMPORTS_PER_SOL), 'confirmed');
  ledger = await bootstrapLedger({ connection, admin, world: DEFAULT_WORLD });
});

describe.skipIf(!hasValidator)('purses', () => {
  it('opens an account with a starting purse and reads it back', async () => {
    const a = id('alice');
    await ledger.openAccount({ owner: a, planet: 'helion', purse: { HLX: 1_000 } });
    expect(await ledger.getPurse(a, 'HLX')).toBe(1_000);
    expect(await ledger.getPurse(a, 'VRD')).toBe(0); // purses exist in every currency
  });

  it('transfers between owners and conserves the total', async () => {
    const [a, b] = [id('alice'), id('bob')];
    await ledger.openAccount({ owner: a, planet: 'helion', purse: { HLX: 500 } });
    await ledger.openAccount({ owner: b, planet: 'helion', purse: { HLX: 100 } });
    await ledger.transfer({ from: a, to: b, currency: 'HLX', amount: 200 });
    expect(await ledger.getPurse(a, 'HLX')).toBe(300);
    expect(await ledger.getPurse(b, 'HLX')).toBe(300);
  });

  it('maps rule violations to contract error codes', async () => {
    const [a, b] = [id('alice'), id('bob')];
    await ledger.openAccount({ owner: a, planet: 'helion', purse: { HLX: 50 } });
    await ledger.openAccount({ owner: b, planet: 'helion' });
    await rejects(ledger.transfer({ from: a, to: b, currency: 'HLX', amount: 51 }), 'insufficient_funds');
    await rejects(ledger.transfer({ from: a, to: b, currency: 'HLX', amount: -1 }), 'invalid_amount');
    await rejects(ledger.transfer({ from: a, to: b, currency: 'XXX', amount: 1 }), 'invalid_amount');
    await ledger.transfer({ from: a, to: b, currency: 'HLX', amount: 0 }); // zero is allowed
    await rejects(ledger.transfer({ from: a, to: b, currency: 'HLX', amount: 1.5 }), 'invalid_amount');
    await rejects(ledger.transfer({ from: a, to: 'ghost', currency: 'HLX', amount: 1 }), 'unknown_account');
    await rejects(ledger.getPurse('ghost', 'HLX'), 'unknown_account');
    await rejects(ledger.openAccount({ owner: a, planet: 'helion' }), 'invalid_state');
    expect(await ledger.getPurse(a, 'HLX')).toBe(50);
  });
});

describe.skipIf(!hasValidator)('inventories', () => {
  it('places starting goods on the home planet only', async () => {
    const a = id('carol');
    await ledger.openAccount({ owner: a, planet: 'helion', inventory: { iron: 10, water: 3 } });
    expect(await ledger.getInventory(a, 'helion', 'iron')).toBe(10);
    expect(await ledger.getInventory(a, 'verdan', 'iron')).toBe(0);
    await rejects(ledger.getInventory('nobody', 'helion', 'iron'), 'unknown_account');
  });

  it('produces and consumes', async () => {
    const a = id('dave');
    await ledger.openAccount({ owner: a, planet: 'helion', inventory: { iron: 4, fuel: 1 } });
    await ledger.produce({ owner: a, planet: 'helion', inputs: [{ good: 'iron', qty: 2 }, { good: 'fuel', qty: 1 }], outputs: [{ good: 'tools', qty: 1 }] });
    expect(await ledger.getInventory(a, 'helion', 'iron')).toBe(2);
    expect(await ledger.getInventory(a, 'helion', 'fuel')).toBe(0);
    expect(await ledger.getInventory(a, 'helion', 'tools')).toBe(1);
    await ledger.consume({ owner: a, planet: 'helion', cargo: [{ good: 'iron', qty: 2 }] });
    expect(await ledger.getInventory(a, 'helion', 'iron')).toBe(0);
  });

  it('rejects overdrafts atomically and unknown planets', async () => {
    const a = id('erin');
    await ledger.openAccount({ owner: a, planet: 'helion', inventory: { iron: 3 } });
    await rejects(ledger.consume({ owner: a, planet: 'helion', cargo: [{ good: 'iron', qty: 4 }] }), 'insufficient_inventory');
    await rejects(
      ledger.produce({ owner: a, planet: 'helion', inputs: [{ good: 'iron', qty: 1 }, { good: 'fuel', qty: 1 }], outputs: [{ good: 'tools', qty: 1 }] }),
      'insufficient_inventory',
    );
    expect(await ledger.getInventory(a, 'helion', 'iron')).toBe(3);
    expect(await ledger.getInventory(a, 'helion', 'tools')).toBe(0);
    await rejects(ledger.getInventory(a, 'mars', 'iron'), 'invalid_amount');
  });
});

describe.skipIf(!hasValidator)('later milestones', () => {
  it('fail loudly instead of pretending', async () => {
    await rejects(ledger.borrow({ borrower: 'x', planet: 'helion', amount: 1, termCycles: 1, cycle: 1 }), 'invalid_state');
  });
});
