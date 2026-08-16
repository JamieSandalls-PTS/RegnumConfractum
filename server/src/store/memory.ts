import { randomUUID } from 'node:crypto';
import type {
  Account,
  CharacterRecord,
  EventRecord,
  ItemRecord,
  SessionRecord,
  Store,
} from './types';

/**
 * In-memory Store for tests and the deterministic harness. Single-threaded
 * JS makes each method atomic as long as it does not await mid-mutation —
 * every mutation below is synchronous internally.
 */
export class MemoryStore implements Store {
  private accounts = new Map<string, Account>(); // by id
  private accountsByName = new Map<string, string>();
  private sessions = new Map<string, SessionRecord>();
  private characters = new Map<string, CharacterRecord>();
  private items = new Map<string, ItemRecord>();
  private events: EventRecord[] = [];
  private nextEventId = 1;

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async createAccount(username: string, passHash: string): Promise<Account | 'username_taken'> {
    const key = username.toLowerCase();
    if (this.accountsByName.has(key)) return 'username_taken';
    const account: Account = { id: randomUUID(), username, passHash };
    this.accounts.set(account.id, account);
    this.accountsByName.set(key, account.id);
    return account;
  }

  async getAccountByUsername(username: string): Promise<Account | null> {
    const id = this.accountsByName.get(username.toLowerCase());
    return id ? (this.accounts.get(id) ?? null) : null;
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.token, { ...session });
  }

  async getSession(token: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return { ...s };
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async createCharacter(
    c: Omit<CharacterRecord, 'id' | 'coin'>,
  ): Promise<CharacterRecord | 'character_name_taken'> {
    const nameKey = c.name.toLowerCase();
    for (const existing of this.characters.values()) {
      if (existing.name.toLowerCase() === nameKey) return 'character_name_taken';
    }
    const record: CharacterRecord = { ...c, id: randomUUID(), coin: 0 };
    this.characters.set(record.id, record);
    return { ...record };
  }

  async getCharacter(id: string): Promise<CharacterRecord | null> {
    const c = this.characters.get(id);
    return c ? { ...c } : null;
  }

  async getCharactersByAccount(accountId: string): Promise<CharacterRecord[]> {
    return [...this.characters.values()]
      .filter((c) => c.accountId === accountId)
      .map((c) => ({ ...c }));
  }

  async saveCharacterPosition(id: string, areaId: string, x: number, y: number): Promise<void> {
    const c = this.characters.get(id);
    if (!c) throw new Error(`saveCharacterPosition: no character ${id}`);
    c.areaId = areaId;
    c.x = x;
    c.y = y;
  }

  async grantItem(ownerCharacterId: string, templateId: string, qty: number): Promise<ItemRecord> {
    if (!this.characters.has(ownerCharacterId)) {
      throw new Error(`grantItem: no character ${ownerCharacterId}`);
    }
    const item: ItemRecord = { id: randomUUID(), templateId, ownerCharacterId, qty };
    this.items.set(item.id, item);
    return { ...item };
  }

  async getItemsByCharacter(characterId: string): Promise<ItemRecord[]> {
    return [...this.items.values()]
      .filter((i) => i.ownerCharacterId === characterId)
      .map((i) => ({ ...i }));
  }

  async transferItem(
    itemId: string,
    fromCharacterId: string,
    toCharacterId: string,
  ): Promise<boolean> {
    const item = this.items.get(itemId);
    if (!item || item.ownerCharacterId !== fromCharacterId) return false;
    if (!this.characters.has(toCharacterId)) return false;
    item.ownerCharacterId = toCharacterId;
    return true;
  }

  async grantCoin(characterId: string, amount: number): Promise<void> {
    const c = this.characters.get(characterId);
    if (!c) throw new Error(`grantCoin: no character ${characterId}`);
    c.coin += amount;
  }

  async getCoin(characterId: string): Promise<number> {
    return this.characters.get(characterId)?.coin ?? 0;
  }

  async transferCoin(
    fromCharacterId: string,
    toCharacterId: string,
    amount: number,
  ): Promise<boolean> {
    const from = this.characters.get(fromCharacterId);
    const to = this.characters.get(toCharacterId);
    if (!from || !to || amount <= 0 || from.coin < amount) return false;
    from.coin -= amount;
    to.coin += amount;
    return true;
  }

  async appendEvent(type: string, data: Record<string, unknown>): Promise<void> {
    this.events.push({ id: this.nextEventId++, type, data });
  }

  async listRecentEvents(limit: number): Promise<EventRecord[]> {
    return this.events.slice(-limit).map((e) => ({ ...e }));
  }

  async totalCoin(): Promise<number> {
    let sum = 0;
    for (const c of this.characters.values()) sum += c.coin;
    return sum;
  }

  async countItems(): Promise<number> {
    let sum = 0;
    for (const i of this.items.values()) sum += i.qty;
    return sum;
  }
}
