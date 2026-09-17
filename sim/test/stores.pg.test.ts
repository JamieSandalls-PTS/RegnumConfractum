import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '@rc/server/store/postgres';

/**
 * The common stores against REAL Postgres (D-580).
 *
 * ⚠ This exists because `MemoryStore` cannot check the half of the design that
 * matters most here. A store is the third owner an item can have, and what
 * makes "an item is in exactly one place" true is a database CHECK CONSTRAINT
 * rather than the gateway being careful — the gateway is not the only writer
 * (D-547). The fake has no constraints at all, so every deposit test in
 * `mr6-stores` would pass against a schema that allowed an item to be in a
 * character's pack and the larder at once.
 *
 * This repo has been bitten by the fake being more permissive than the real
 * store before (D-572: a column added to the type but not to the INSERT passes
 * every in-memory test and costs a login).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const runTag = Date.now().toString();

let store: PgStore;

describe.skipIf(!DATABASE_URL)('the common stores (Postgres)', () => {
  let characterId = '';
  let otherId = '';
  const storeId = `round-town:storehouse:${runTag}`;

  beforeAll(async () => {
    store = new PgStore(DATABASE_URL!);
    await store.init();
    const account = await store.createAccount(`larder_${runTag}`, 'a-long-password');
    if (account === 'username_taken') throw new Error('fixture username collided');
    const make = async (name: string, seed: number): Promise<string> => {
      const made = await store.createCharacter({
        accountId: account.id,
        name,
        appearanceSeed: seed,
        areaId: 'round-town',
        x: 5,
        y: 5,
        classId: null,
      });
      if (made === 'character_name_taken') throw new Error('fixture name collided');
      return made.id;
    };
    // Letters only: character names allow no digits.
    const tag = runTag.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!);
    characterId = await make(`Larder ${tag}`, 5);
    otherId = await make(`Thief ${tag}`, 6);
  });

  afterAll(async () => {
    await store?.clearStores();
    await store?.close();
  });

  it('moves an item in and out without ever duplicating it', async () => {
    const loaf = await store.grantItem(characterId, 'coarse-bread', 1);

    expect(await store.moveItemToStore(loaf.id, characterId, storeId)).toBe(true);
    // In exactly one place: the larder, not the pack.
    expect((await store.getItemsByStore(storeId)).map((i) => i.id)).toEqual([loaf.id]);
    expect((await store.getItemsByCharacter(characterId)).some((i) => i.id === loaf.id)).toBe(false);

    // ⚠ ANYBODY may take it: the stores are common (D-530), and the exposure
    // is the cost of pooling rather than an oversight.
    expect(await store.moveItemFromStore(loaf.id, storeId, otherId)).toBe(true);
    expect((await store.getItemsByCharacter(otherId)).some((i) => i.id === loaf.id)).toBe(true);
    expect(await store.getItemsByStore(storeId)).toEqual([]);
  });

  it('refuses a deposit of something the depositor does not hold', async () => {
    // The WHERE clause is the permission check, so two clients racing for the
    // same loaf cannot both win — the same contract `transferItem` has.
    const loaf = await store.grantItem(characterId, 'coarse-bread', 1);
    expect(await store.moveItemToStore(loaf.id, otherId, storeId)).toBe(false);
    expect((await store.getItemsByCharacter(characterId)).some((i) => i.id === loaf.id)).toBe(true);
  });

  it('refuses a withdrawal from the WRONG store', async () => {
    // ⚠ Standing at the infirmary must not reach into the storehouse across
    // the square. `owner_store = $2`, not "is in some store".
    const loaf = await store.grantItem(characterId, 'coarse-bread', 1);
    await store.moveItemToStore(loaf.id, characterId, storeId);
    expect(await store.moveItemFromStore(loaf.id, `${storeId}-elsewhere`, otherId)).toBe(false);
    expect((await store.getItemsByStore(storeId)).some((i) => i.id === loaf.id)).toBe(true);
  });

  it('⚠ will not let one item have two owners', async () => {
    // The constraint this whole shape rests on, extended rather than dropped
    // when the third owner arrived. Asserted against the database because the
    // database is what enforces it.
    const loaf = await store.grantItem(characterId, 'coarse-bread', 1);
    await expect(
      store.query('update items set owner_store = $2 where id = $1', [loaf.id, storeId]),
    ).rejects.toThrow();
  });

  it('⚠ stocks a store with no pack involved — the round-opening path', async () => {
    // ⚠ This is the one route into a store that does NOT go through
    // somebody's inventory (D-593's larder), and it was the only store method
    // with no test against real Postgres. It named a column — `owner_store_id`
    // — that has never existed, so the insert was rejected every time.
    //
    // ⚠ The consequence was not a failed deposit. Its caller is
    // `stockCommonStores`, which runs on the first tick of EVERY round, and
    // the rejection propagated out of the tick loop and KILLED THE SERVER
    // PROCESS the instant a round began. `MemoryStore` has no columns to
    // disagree about, so all 1015 in-memory tests passed against it.
    const stocked = await store.grantItemToStore(storeId, 'coarse-bread', 2);
    expect(stocked.ownerStoreId).toBe(storeId);
    expect(stocked.qty).toBe(2);

    // It is genuinely IN the store, not merely inserted somewhere.
    const held = await store.getItemsByStore(storeId);
    expect(held.map((i) => i.id)).toContain(stocked.id);

    // ⚠ And readable back through `getItem`, which selects an explicit
    // column list that had forgotten `owner_store` existed — so a pooled loaf
    // read that way reported belonging to nobody.
    expect((await store.getItem(stocked.id))?.ownerStoreId).toBe(storeId);

    // Somebody can take what the town started with, like anything else pooled.
    expect(await store.moveItemFromStore(stocked.id, storeId, characterId)).toBe(true);
    expect((await store.getItemsByCharacter(characterId)).some((i) => i.id === stocked.id))
      .toBe(true);
  });

  it('marks items spoiled without losing what else the data held', async () => {
    // ⚠ Merged into `data`, not replacing it: a letter that was spoiled must
    // not lose its text (D-505).
    const note = await store.grantItem(characterId, 'coarse-bread', 1, { title: 'For Mira' });
    expect(await store.spoilItems([note.id])).toBe(1);
    const back = await store.getItem(note.id);
    expect(back?.data?.spoiled).toBe(true);
    expect(back?.data?.title).toBe('For Mira');
  });

  it('empties every store at a reset, and touches nothing in a pack', async () => {
    const pooled = await store.grantItem(characterId, 'coarse-bread', 1);
    const kept = await store.grantItem(characterId, 'coarse-bread', 1);
    await store.moveItemToStore(pooled.id, characterId, storeId);

    await store.clearStores();
    expect(await store.getItemsByStore(storeId)).toEqual([]);
    // ⚠ The hoarder keeps theirs. Gear is stripped separately (D-522); this
    // clears the larder, not the cast.
    expect(await store.getItem(kept.id)).not.toBeNull();
  });
});
