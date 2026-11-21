import { describe, expect, it } from 'vitest';
import { LedgerError } from '@orbital/contracts';
import type { WorldConfig } from '@orbital/contracts';
import { DEFAULT_WORLD } from '@orbital/contracts';
import { runLedgerContractSuite } from '../src/contract/suite.js';
import { InMemoryLedger } from '../src/in-memory-ledger.js';

runLedgerContractSuite('InMemoryLedger', async (world: WorldConfig) => new InMemoryLedger(world));

async function open(): Promise<InMemoryLedger> {
  const l = new InMemoryLedger(DEFAULT_WORLD);
  for (const p of DEFAULT_WORLD.planets) await l.openAccount({ owner: p.id, planet: p.id, purse: { [p.currency]: 100 } });
  await l.openAccount({ owner: 'a1', planet: 'helion', purse: { HLX: 1_000, VRD: 1_000 }, inventory: { iron: 10 } });
  await l.openAccount({ owner: 'a2', planet: 'helion', purse: { HLX: 1_000, VRD: 1_000 } });
  return l;
}

describe('InMemoryLedger specifics', () => {
  it('assigns counter ids: orders (shared with FX) o1.., shipments s1.., loans l1..', async () => {
    const l = await open();
    const r1 = await l.placeOrders([
      { agentId: 'a1', planet: 'helion', good: 'iron', side: 'buy', qty: 1, limitPrice: 1 },
      { agentId: 'a1', planet: 'helion', good: 'iron', side: 'buy', qty: 0, limitPrice: 1 }, // rejected: consumes no id
      { agentId: 'a1', planet: 'helion', good: 'iron', side: 'sell', qty: 1, limitPrice: 1 },
    ], 1);
    expect(r1.accepted.map((a) => a.orderId)).toEqual(['o1', 'o2']);
    const fx = await l.placeFxOrders([{ agentId: 'a1', give: 'HLX', giveAmount: 1, want: 'VRD', minReceive: 1 }], 1);
    expect(fx.accepted[0]!.orderId).toBe('o3');
    const s = await l.depart({ owner: 'a1', from: 'helion', to: 'verdan', cargo: [{ good: 'iron', qty: 1 }], cycle: 1, arriveCycle: 2 });
    expect(s.id).toBe('s1');
    expect((await l.borrow({ borrower: 'a1', planet: 'helion', amount: 5, termCycles: 1, cycle: 1 })).id).toBe('l1');
    expect((await l.borrow({ borrower: 'a1', planet: 'helion', amount: 5, termCycles: 1, cycle: 1 })).id).toBe('l2');
  });

  it('FX clearing with quote dust needs the quote treasury; nothing changes if it is missing', async () => {
    const l = new InMemoryLedger(DEFAULT_WORLD);
    await l.openAccount({ owner: 'a1', planet: 'helion', purse: { HLX: 100, VRD: 100 } });
    await l.openAccount({ owner: 'a2', planet: 'helion', purse: { HLX: 100, VRD: 100 } });
    await l.placeFxOrders([
      { agentId: 'a1', give: 'HLX', giveAmount: 3, want: 'VRD', minReceive: 1 },
      { agentId: 'a2', give: 'VRD', giveAmount: 10, want: 'HLX', minReceive: 3 },
    ], 1);
    await expect(l.clearFxAuction('HLX', 'VRD', 1)).rejects.toMatchObject({ code: 'unknown_account' });
    expect(await l.getPurse('a1', 'HLX')).toBe(97); // still escrowed
    await l.openAccount({ owner: 'verdan', planet: 'verdan' });
    expect((await l.clearFxAuction('HLX', 'VRD', 1)).ratePpm).toBe(3_333_333);
    expect(await l.getPurse('verdan', 'VRD')).toBe(1);
    expect((await l.checkInvariants()).ok).toBe(true);
  });

  it('a failed repay for insufficient funds does not accrue interest', async () => {
    const l = await open();
    await l.applyPolicy({ kind: 'set_policy_rate', planet: 'helion', rateBp: 1_000 });
    const loan = await l.borrow({ borrower: 'a2', planet: 'helion', amount: 1_000, termCycles: 10, cycle: 0 });
    await l.transfer({ from: 'a2', to: 'a1', currency: 'HLX', amount: 2_000 });
    await expect(l.repay({ loanId: loan.id, amount: 5, cycle: 2 })).rejects.toBeInstanceOf(LedgerError);
    await l.transfer({ from: 'a1', to: 'a2', currency: 'HLX', amount: 2_000 });
    // accrual runs once, from cycle 0 to 4: floor(1000 * 1000 * 4 / 10000) = 400
    expect((await l.repay({ loanId: loan.id, amount: 400, cycle: 4 })).outstanding).toBe(1_000);
  });

  it('every method on a fresh ledger with no accounts fails closed', async () => {
    const l = new InMemoryLedger(DEFAULT_WORLD);
    await expect(l.getPurse('x', 'HLX')).rejects.toMatchObject({ code: 'unknown_account' });
    expect((await l.checkInvariants()).ok).toBe(true);
    expect(Object.keys((await l.checkInvariants()).totals.currency).sort()).toEqual(['HLX', 'TTH', 'VRD']);
  });
});

describe('InMemoryLedger.clone', () => {
  it('copies all state and evolves independently, keeping invariants', async () => {
    const l = await open();
    await l.placeOrders([{ agentId: 'a1', planet: 'helion', good: 'iron', side: 'sell', qty: 3, limitPrice: 5 }], 1);
    await l.depart({ owner: 'a1', from: 'helion', to: 'verdan', cargo: [{ good: 'iron', qty: 2 }], cycle: 1, arriveCycle: 3 });
    await l.borrow({ borrower: 'a2', planet: 'helion', amount: 50, termCycles: 5, cycle: 1 });
    await l.applyPolicy({ kind: 'set_tariff', planet: 'verdan', good: 'iron', rateBp: 1_000 });

    const c = l.clone();
    expect(await c.getPolicy('verdan')).toEqual(await l.getPolicy('verdan'));
    expect(await c.checkInvariants()).toEqual(await l.checkInvariants());

    // Evolve only the clone: arrive (duty, stock moves), a new order and loan (counters continue where the original left off).
    await c.arrive('s1', 3);
    await c.applyPolicy({ kind: 'set_embargo', planet: 'helion', target: 'verdan', active: true });
    expect((await c.borrow({ borrower: 'a2', planet: 'helion', amount: 5, termCycles: 1, cycle: 4 })).id).toBe('l2');
    await c.repay({ loanId: 'l1', amount: 10, cycle: 4 });
    expect(await c.getInventory('a1', 'verdan', 'iron')).toBe(2);
    expect(await l.getInventory('a1', 'verdan', 'iron')).toBe(0);
    expect((await l.getPolicy('helion')).embargoes).toEqual([]);
    expect((await l.borrow({ borrower: 'a2', planet: 'helion', amount: 5, termCycles: 1, cycle: 4 })).id).toBe('l2');
    expect((await l.arrive('s1', 3)).delivered).toEqual([{ good: 'iron', qty: 2 }]);

    expect((await c.checkInvariants()).ok).toBe(true);
    expect((await l.checkInvariants()).ok).toBe(true);
    expect((await c.clearLocalAuction('helion', 'iron', 4)).volume).toBe(0);
  });
});
