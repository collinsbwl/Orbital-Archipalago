import { BN } from '@anchor-lang/core';
import { SystemProgram, Transaction } from '@solana/web3.js';
import { SolanaLedger, type SolanaLedgerOptions } from './solana-ledger.js';
import { codeBytes, idKey } from './keys.js';

// PlanetLedger account size: 8 discriminator + 48 header + 1024 slots * 72 bytes (programs/orbital/src/state.rs).
const PLANET_LEDGER_SPACE = 8 + 48 + 1024 * 72;

/**
 * One-time setup of a fresh cluster, safe to re-run: records the admin, creates the currency
 * mints and one ledger account per planet. Returns a ready SolanaLedger.
 */
export async function bootstrapLedger(opts: SolanaLedgerOptions): Promise<SolanaLedger> {
  const ledger = new SolanaLedger(opts);
  const { chain, program } = ledger;
  const { admin, world } = opts;
  const exists = async (pk: Parameters<typeof chain.getAccountData>[0]) => (await chain.getAccountData(pk)) !== null;
  const run = (tx: Transaction) => chain.send(tx, [admin]);

  if (!(await exists(ledger.addr.config()))) {
    await run(new Transaction().add(await program.methods.initialize().accountsPartial({ admin: admin.publicKey, config: ledger.addr.config() }).instruction()));
  }

  for (const planet of world.planets) {
    const code = planet.currency;
    if (!(await exists(ledger.addr.mint(code)))) {
      await run(new Transaction().add(
        await program.methods.createCurrency(codeBytes(code)).accountsPartial({
          admin: admin.publicKey, config: ledger.addr.config(), mintAuthority: ledger.addr.mintAuthority(), mint: ledger.addr.mint(code), book: ledger.addr.currencyBook(code),
        }).instruction(),
      ));
    }

    if (!(await exists(ledger.addr.vault(code)))) {
      await run(new Transaction().add(
        await program.methods.createVault(codeBytes(code)).accountsPartial({
          admin: admin.publicKey, config: ledger.addr.config(), mint: ledger.addr.mint(code), vault: ledger.addr.vault(code),
        }).instruction(),
      ));
    }

    // Every planet gets a policy account, seeded with each good's base price (tariffs are charged against it).
    if (!(await exists(ledger.addr.policy(planet.id)))) {
      await run(new Transaction().add(
        await program.methods.createPolicy(idKey(planet.id)).accountsPartial({
          admin: admin.publicKey, config: ledger.addr.config(), policy: ledger.addr.policy(planet.id),
        }).instruction(),
      ));
      const prices = await Promise.all(world.goods.map((g) =>
        program.methods.applyPolicy({ setBasePrice: { good: idKey(g.id), price: new BN(g.basePrice) } }).accountsPartial({
          admin: admin.publicKey, config: ledger.addr.config(), policy: ledger.addr.policy(planet.id),
        }).instruction()));
      for (let i = 0; i < prices.length; i += 4) await run(new Transaction().add(...prices.slice(i, i + 4)));
    }

    const ledgerAddr = await ledger.addr.ledger(planet.id);
    if (!(await exists(ledgerAddr))) {
      const lamports = await chain.rentExemption(PLANET_LEDGER_SPACE);
      await run(new Transaction().add(
        SystemProgram.createAccountWithSeed({
          fromPubkey: admin.publicKey, newAccountPubkey: ledgerAddr, basePubkey: admin.publicKey,
          seed: planet.id, lamports, space: PLANET_LEDGER_SPACE, programId: ledger.addr.programId,
        }),
        await program.methods.createPlanet(idKey(planet.id), codeBytes(code)).accountsPartial({
          admin: admin.publicKey, config: ledger.addr.config(), ledger: ledgerAddr,
        }).instruction(),
      ));
    }
  }
  return ledger;
}
