import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '@rc/server/store/memory';

describe('MemoryStore conservation semantics', () => {
  let store: MemoryStore;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    store = new MemoryStore();
    const account = await store.createAccount('tester', 'hash');
    if (account === 'username_taken') throw new Error('unreachable');
    const a = await store.createCharacter({
      accountId: account.id, name: 'Alice', appearanceSeed: 1, areaId: 'x', x: 0, y: 0,
    });
    const b = await store.createCharacter({
      accountId: account.id, name: 'Bob', appearanceSeed: 2, areaId: 'x', x: 0, y: 0,
    });
    if (typeof a === 'string' || typeof b === 'string') throw new Error('unreachable');
    alice = a.id;
    bob = b.id;
  });

  it('transferItem moves ownership exactly once', async () => {
    const item = await store.grantItem(alice, 'iron-ore', 1);
    expect(await store.transferItem(item.id, alice, bob)).toBe(true);
    // Alice no longer owns it — a second transfer from her must fail.
    expect(await store.transferItem(item.id, alice, bob)).toBe(false);
    expect(await store.countItems()).toBe(1);
    expect((await store.getItemsByCharacter(bob)).map((i) => i.id)).toEqual([item.id]);
    expect(await store.getItemsByCharacter(alice)).toEqual([]);
  });

  it('transferCoin never overdraws and conserves the total', async () => {
    await store.grantCoin(alice, 100);
    expect(await store.transferCoin(alice, bob, 60)).toBe(true);
    expect(await store.transferCoin(alice, bob, 60)).toBe(false); // only 40 left
    expect(await store.getCoin(alice)).toBe(40);
    expect(await store.getCoin(bob)).toBe(60);
    expect(await store.totalCoin()).toBe(100);
  });

  it('duplicate usernames and character names are rejected', async () => {
    expect(await store.createAccount('TESTER', 'hash2')).toBe('username_taken');
    const dup = await store.createCharacter({
      accountId: 'whatever', name: 'alice', appearanceSeed: 3, areaId: 'x', x: 0, y: 0,
    });
    expect(dup).toBe('character_name_taken');
  });

  it('expired sessions are not returned', async () => {
    await store.createSession({ token: 'tok', accountId: 'acc', expiresAt: Date.now() - 1000 });
    expect(await store.getSession('tok')).toBeNull();
    await store.createSession({ token: 'tok2', accountId: 'acc', expiresAt: Date.now() + 60_000 });
    expect((await store.getSession('tok2'))?.accountId).toBe('acc');
  });
});
