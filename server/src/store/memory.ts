import { randomUUID } from 'node:crypto';
import type {
  Account,
  CharacterRecord,
  EventRecord,
  InjuryRecord,
  ItemData,
  ItemRecord,
  KnowledgeRecord,
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
  private knowledge = new Map<string, KnowledgeRecord>(); // key: observer|subject|presentation
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
    c: Omit<CharacterRecord, 'id' | 'coin' | 'bluff' | 'insight' | 'languages' | 'hp' | 'maxHp' | 'xp' | 'deathDebt' | 'deeds' | 'retired'>,
  ): Promise<CharacterRecord | 'character_name_taken'> {
    const nameKey = c.name.toLowerCase();
    for (const existing of this.characters.values()) {
      if (existing.name.toLowerCase() === nameKey) return 'character_name_taken';
    }
    const record: CharacterRecord = {
      ...c,
      id: randomUUID(),
      coin: 0,
      bluff: 10,
      insight: 10,
      languages: ['common'],
      hp: 20,
      maxHp: 20,
      xp: 0,
      deathDebt: 0,
      deeds: 0,
      retired: false,
    };
    this.characters.set(record.id, record);
    return { ...record };
  }

  async setCharacterLanguages(id: string, languages: string[]): Promise<void> {
    const c = this.characters.get(id);
    if (!c) throw new Error(`setCharacterLanguages: no character ${id}`);
    c.languages = [...languages];
  }

  async setCharacterSkills(id: string, skills: { bluff?: number; insight?: number }): Promise<void> {
    const c = this.characters.get(id);
    if (!c) throw new Error(`setCharacterSkills: no character ${id}`);
    if (skills.bluff !== undefined) c.bluff = skills.bluff;
    if (skills.insight !== undefined) c.insight = skills.insight;
  }

  async saveCharacterVitals(
    id: string,
    vitals: { hp?: number; xp?: number; deathDebt?: number; deeds?: number },
  ): Promise<void> {
    const c = this.characters.get(id);
    if (!c) throw new Error(`saveCharacterVitals: no character ${id}`);
    if (vitals.hp !== undefined) c.hp = vitals.hp;
    if (vitals.xp !== undefined) c.xp = vitals.xp;
    if (vitals.deathDebt !== undefined) c.deathDebt = vitals.deathDebt;
    if (vitals.deeds !== undefined) c.deeds = vitals.deeds;
  }

  private legacyPoints = new Map<string, number>();

  async addLegacyPoints(accountId: string, amount: number): Promise<void> {
    this.legacyPoints.set(accountId, (this.legacyPoints.get(accountId) ?? 0) + amount);
  }

  async getLegacyPoints(accountId: string): Promise<number> {
    return this.legacyPoints.get(accountId) ?? 0;
  }

  async retireCharacter(id: string): Promise<void> {
    const c = this.characters.get(id);
    if (!c) throw new Error(`retireCharacter: no character ${id}`);
    c.retired = true;
  }

  async countRetired(accountId: string): Promise<number> {
    return [...this.characters.values()].filter((c) => c.accountId === accountId && c.retired)
      .length;
  }

  private injuries = new Map<string, InjuryRecord>();

  async addInjury(injury: Omit<InjuryRecord, 'id'>): Promise<InjuryRecord> {
    const record: InjuryRecord = { ...injury, id: randomUUID() };
    this.injuries.set(record.id, record);
    return { ...record };
  }

  async listInjuries(characterId: string): Promise<InjuryRecord[]> {
    return [...this.injuries.values()]
      .filter((i) => i.characterId === characterId)
      .map((i) => ({ ...i }));
  }

  async removeInjury(injuryId: string): Promise<boolean> {
    return this.injuries.delete(injuryId);
  }

  async downgradeInjuries(characterId: string): Promise<void> {
    for (const i of this.injuries.values()) {
      if (i.characterId === characterId) i.severity = 'minor';
    }
  }

  async getKnowledge(
    observerId: string,
    subjectIds: string[],
    presentation = 'normal',
  ): Promise<Map<string, KnowledgeRecord>> {
    const out = new Map<string, KnowledgeRecord>();
    for (const subjectId of subjectIds) {
      const k = this.knowledge.get(`${observerId}|${subjectId}|${presentation}`);
      if (k) out.set(subjectId, { ...k });
    }
    return out;
  }

  async upsertKnowledge(k: KnowledgeRecord): Promise<void> {
    this.knowledge.set(`${k.observerCharacterId}|${k.subjectCharacterId}|${k.presentation}`, {
      ...k,
    });
  }

  async mergeKnowledge(
    observerId: string,
    subjectId: string,
    fromPresentation: string,
  ): Promise<void> {
    const fromKey = `${observerId}|${subjectId}|${fromPresentation}`;
    const toKey = `${observerId}|${subjectId}|normal`;
    const from = this.knowledge.get(fromKey);
    if (!from) return;
    const to = this.knowledge.get(toKey);
    if (!to || to.knownName === null) {
      this.knowledge.set(toKey, { ...from, presentation: 'normal' });
    }
    this.knowledge.delete(fromKey);
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

  async grantItem(
    ownerCharacterId: string,
    templateId: string,
    qty: number,
    data?: ItemData,
  ): Promise<ItemRecord> {
    if (!this.characters.has(ownerCharacterId)) {
      throw new Error(`grantItem: no character ${ownerCharacterId}`);
    }
    const item: ItemRecord = {
      id: randomUUID(),
      templateId,
      ownerCharacterId,
      qty,
      data: data ?? null,
    };
    this.items.set(item.id, item);
    return { ...item };
  }

  async getItem(itemId: string): Promise<ItemRecord | null> {
    const item = this.items.get(itemId);
    return item ? { ...item } : null;
  }

  async consumeOneItem(ownerCharacterId: string, templateId: string): Promise<boolean> {
    for (const item of this.items.values()) {
      if (item.ownerCharacterId === ownerCharacterId && item.templateId === templateId) {
        if (item.qty > 1) item.qty -= 1;
        else this.items.delete(item.id);
        return true;
      }
    }
    return false;
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

  private dmEvents = new Map<string, { id: string; name: string; doc: unknown; enabled: boolean }>();

  async createDmEvent(name: string, doc: unknown) {
    const record = { id: randomUUID(), name, doc, enabled: true };
    this.dmEvents.set(record.id, record);
    return { ...record };
  }

  async listDmEvents() {
    return [...this.dmEvents.values()].map((e) => ({ ...e }));
  }

  async getDmEvent(id: string) {
    const e = this.dmEvents.get(id);
    return e ? { ...e } : null;
  }

  async updateDmEvent(id: string, patch: { name?: string; doc?: unknown; enabled?: boolean }) {
    const e = this.dmEvents.get(id);
    if (!e) throw new Error(`no dm event ${id}`);
    if (patch.name !== undefined) e.name = patch.name;
    if (patch.doc !== undefined) e.doc = patch.doc;
    if (patch.enabled !== undefined) e.enabled = patch.enabled;
  }

  async deleteDmEvent(id: string) {
    this.dmEvents.delete(id);
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
