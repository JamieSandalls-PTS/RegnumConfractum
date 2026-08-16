/**
 * Persistence interface (D-106). Two implementations: PgStore (production —
 * Postgres is the source of truth) and MemoryStore (deterministic tests).
 *
 * Contract notes that matter for correctness:
 * - transferItem / transferCoin are ATOMIC. They either fully happen or fully
 *   don't, and they must be safe under concurrent calls — these are the
 *   operations behind the no-duplication / no-creation invariants.
 * - appendEvent is append-only. Nothing in the codebase updates or deletes
 *   event rows, and the Postgres schema enforces that with a trigger (D-106).
 */

export interface Account {
  id: string;
  username: string;
  passHash: string;
}

export interface CharacterRecord {
  id: string;
  accountId: string;
  name: string;
  appearanceSeed: number;
  areaId: string;
  x: number;
  y: number;
  coin: number;
  bluff: number;
  insight: number;
  languages: string[];
}

export interface ItemData {
  title?: string;
  text?: string;
}

/** What one character knows about another's observed identity (D-219). */
export interface KnowledgeRecord {
  observerCharacterId: string;
  subjectCharacterId: string;
  presentation: string;
  knownName: string | null;
  provenance: 'self_claimed' | 'third_party' | 'verified';
  impression: 'rings_false' | 'certain_false' | null;
}

export interface ItemRecord {
  id: string;
  templateId: string;
  ownerCharacterId: string;
  qty: number;
  data: ItemData | null;
}

export interface SessionRecord {
  token: string;
  accountId: string;
  expiresAt: number; // epoch ms
}

export interface EventRecord {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  // Accounts & sessions
  createAccount(username: string, passHash: string): Promise<Account | 'username_taken'>;
  getAccountByUsername(username: string): Promise<Account | null>;
  createSession(session: SessionRecord): Promise<void>;
  getSession(token: string): Promise<SessionRecord | null>;
  deleteSession(token: string): Promise<void>;

  // Characters
  createCharacter(
    c: Omit<CharacterRecord, 'id' | 'coin' | 'bluff' | 'insight' | 'languages'>,
  ): Promise<CharacterRecord | 'character_name_taken'>;
  setCharacterLanguages(id: string, languages: string[]): Promise<void>;
  getCharacter(id: string): Promise<CharacterRecord | null>;
  getCharactersByAccount(accountId: string): Promise<CharacterRecord[]>;
  /** Batched dirty-flag flush target; also called immediately on logout (D-106). */
  saveCharacterPosition(id: string, areaId: string, x: number, y: number): Promise<void>;
  /** Skill tuning — admin/tests now, character systems (M4) later. */
  setCharacterSkills(id: string, skills: { bluff?: number; insight?: number }): Promise<void>;

  // Recognition (D-218/D-219)
  /** What `observerId` knows about each of `subjectIds` in a presentation. */
  getKnowledge(
    observerId: string,
    subjectIds: string[],
    presentation?: string,
  ): Promise<Map<string, KnowledgeRecord>>;
  upsertKnowledge(k: KnowledgeRecord): Promise<void>;
  /**
   * The merge event (D-219): the observer has connected the subject's hooded
   * identity to the real one. The hooded thread folds into 'normal' (normal's
   * name wins when both exist) and is deleted.
   */
  mergeKnowledge(observerId: string, subjectId: string, fromPresentation: string): Promise<void>;

  // Items & coin
  grantItem(
    ownerCharacterId: string,
    templateId: string,
    qty: number,
    data?: ItemData,
  ): Promise<ItemRecord>;
  getItem(itemId: string): Promise<ItemRecord | null>;
  getItemsByCharacter(characterId: string): Promise<ItemRecord[]>;
  /** Removes one unit of a template from the owner (decrement or delete).
   * False if they hold none. Atomic — the writing-material sink. */
  consumeOneItem(ownerCharacterId: string, templateId: string): Promise<boolean>;
  /** True iff the item existed AND belonged to `from` at transfer time. Atomic. */
  transferItem(itemId: string, fromCharacterId: string, toCharacterId: string): Promise<boolean>;
  /** Test/admin faucet — production coin enters via player trade only (D-220). */
  grantCoin(characterId: string, amount: number): Promise<void>;
  getCoin(characterId: string): Promise<number>;
  /** True iff `from` had at least `amount`. Atomic, never overdraws. */
  transferCoin(fromCharacterId: string, toCharacterId: string, amount: number): Promise<boolean>;

  // Event log (append-only, D-106)
  appendEvent(type: string, data: Record<string, unknown>): Promise<void>;
  listRecentEvents(limit: number): Promise<EventRecord[]>;

  // Invariant probes for the harness (D-114)
  totalCoin(): Promise<number>;
  countItems(): Promise<number>;
}
