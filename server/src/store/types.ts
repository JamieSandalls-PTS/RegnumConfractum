import type {
  AppearanceOverride,
  CharacterAdvances,
  CharacterLook,
  EquipSlot,
} from '@rc/shared';

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
  /**
   * What the player set by hand at creation (D-539). Null for every
   * character made before the appearance step, and for every character a bot
   * creates — both then look exactly as the seed says, unchanged.
   */
  appearance: AppearanceOverride | null;
  areaId: string;
  x: number;
  y: number;
  coin: number;
  bluff: number;
  insight: number;
  languages: string[];
  hp: number;
  maxHp: number;
  xp: number;
  deathDebt: number;
  deeds: number;
  retired: boolean;
  /** Playable class (D-208/D-511); null on pre-class characters. */
  classId: string | null;
  /** What it is (D-560/D-572); null on every character made before races. */
  raceId: string | null;
  /**
   * The parts chosen at creation (D-574); null on everything made before the
   * face step. Stored as one document rather than a column per slot: the slot
   * vocabulary is content's to grow (D-561), and a schema change per hat is
   * not a migration anybody should have to write.
   */
  look: CharacterLook | null;
  /** Scales the concurrent-zombie cap (D-511). 0–100 like bluff/insight. */
  necromancy: number;
  /**
   * Skills allocated at creation, by content id (D-208). bluff, insight and
   * necromancy also live in their own columns — creation mirrors them out of
   * this map, so each mechanic keeps a single source of truth and no existing
   * reader had to change.
   */
  skills: Record<string, number>;
  feats: string[];
  spells: string[];
  /**
   * Attribute TOTALS allocated at creation (D-546). Null for every character
   * made before the attribute step, which `resolveAttributes` then reads as a
   * straight 10/10/10/10 — exactly the character the pre-attribute code
   * produced, which is why no migration backfills anything.
   */
  attributes: Record<string, number> | null;
  /**
   * What the player spent on the level-up screen (D-546). Stored rather than
   * derived, because unlike level these are CHOICES and nothing can recompute
   * them. Null means nothing has been spent yet.
   */
  advances: CharacterAdvances | null;
  /**
   * The saved hotbar (D-553). Null means the character has never arranged
   * one and should get the defaults — which is what every character written
   * before this had.
   */
  hotbar: (string | null)[] | null;
  /**
   * Has this character had its starting kit for the current round (D-547)?
   *
   * ⚠ PERSISTED, not held in memory. It was a `Set` in the gateway, which a
   * restart emptied — so the next login handed out another kit, and another,
   * until two of them fought over an equipment slot and the login crashed.
   */
  kitGranted: boolean;
}

/** Baseline for the three skills that predate the creation screen. */
export const BASE_BLUFF = 10;
export const BASE_INSIGHT = 10;
export const BASE_NECROMANCY = 0;

/**
 * Turns a submitted build into starting record fields, shared by both stores.
 * Allocated points ADD to the baseline, so an unallocated character is
 * exactly the character the pre-creation code produced.
 */
export function startingBuild(c: {
  skills?: Record<string, number>;
  feats?: string[];
  spells?: string[];
}): {
  skills: Record<string, number>;
  feats: string[];
  spells: string[];
  bluff: number;
  insight: number;
  necromancy: number;
} {
  const skills = { ...(c.skills ?? {}) };
  return {
    skills,
    feats: [...(c.feats ?? [])],
    spells: [...(c.spells ?? [])],
    bluff: BASE_BLUFF + (skills.bluff ?? 0),
    insight: BASE_INSIGHT + (skills.insight ?? 0),
    necromancy: BASE_NECROMANCY + (skills.necromancy ?? 0),
  };
}

/** What createCharacter needs; everything else gets its starting value. */
export interface CharacterCreate {
  accountId: string;
  name: string;
  appearanceSeed: number;
  appearance?: AppearanceOverride | null;
  areaId: string;
  x: number;
  y: number;
  classId: string | null;
  raceId?: string | null;
  look?: CharacterLook | null;
  skills?: Record<string, number>;
  feats?: string[];
  spells?: string[];
  attributes?: Record<string, number> | null;
}

export interface InjuryRecord {
  id: string;
  characterId: string;
  location: 'head' | 'torso' | 'arms' | 'legs';
  kind: 'cut' | 'pierce' | 'blunt';
  severity: 'minor' | 'major';
}

export interface ItemData {
  title?: string;
  text?: string;
  /**
   * Ruined by somebody (D-580). Food that has been got at.
   *
   * ⚠ It rides on the ITEM rather than on the store, and that is the whole
   * point: bread taken out of a spoiled larder is still bad bread tomorrow.
   * A window on the store instead — the model the well uses (D-552) — would
   * let a victim carry the loaf clear of the sabotage and eat it safely,
   * which is not what spoiling stores means. The well is a SOURCE and is
   * rightly timed; provisions are things, and things go off.
   *
   * ⚠ Nothing about a spoiled loaf looks different in the pack. You find out
   * by eating it, or because somebody watched it happen.
   */
  spoiled?: boolean;
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
  /** Exactly one owner is set: a living character or a corpse (D-224). */
  ownerCharacterId: string | null;
  ownerCorpseId: string | null;
  /**
   * The facility store holding it (D-580), keyed `<areaId>:<stationType>`.
   *
   * The third owner an item can have. Modelling the common stores as an
   * OWNER rather than as a list hanging off the station is what keeps
   * D-114's no-duplication invariant for free: an item is in exactly one
   * place, and depositing is a move rather than a copy. Postgres enforces
   * exactly-one-owner with a check constraint, because the gateway is not
   * the only writer (D-547).
   */
  ownerStoreId: string | null;
  qty: number;
  data: ItemData | null;
  /**
   * Which paperdoll slot it is worn in, or null for "in the pack" (D-547).
   *
   * It lives on the ITEM rather than in a separate equipped-list on the
   * character so the two can never disagree about where a thing is — and it
   * is cleared by every move (transfer, corpse, loot), because an item that
   * arrives in a new owner's pack still claiming a slot is a sword worn by
   * somebody who never picked it up.
   */
  equippedSlot: EquipSlot | null;
}

/**
 * A corpse as a world object (D-224/D-511). `ticksLeft` is the countdown
 * remaining in the current state at last write; the server resumes from it
 * on boot, so a restart can lengthen a corpse's life but never destroy items.
 */
export interface CorpseRecord {
  id: string;
  /**
   * Null when nothing that died here was a person (D-554): a roamer's body,
   * or a heap of dropped goods. Readers must treat null as "there is no
   * spirit to reach" rather than as missing data — it is the flag the rites
   * refuse on.
   */
  characterId: string | null;
  areaId: string;
  x: number;
  y: number;
  state: 'corpse' | 'animated' | 'ground' | 'gone';
  ticksLeft: number;
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

export interface DmEventRecord {
  id: string;
  name: string;
  doc: unknown;
  enabled: boolean;
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
  createCharacter(c: CharacterCreate): Promise<CharacterRecord | 'character_name_taken'>;
  setCharacterLanguages(id: string, languages: string[]): Promise<void>;
  getCharacter(id: string): Promise<CharacterRecord | null>;
  getCharactersByAccount(accountId: string): Promise<CharacterRecord[]>;
  /** Batched dirty-flag flush target; also called immediately on logout (D-106). */
  saveCharacterPosition(id: string, areaId: string, x: number, y: number): Promise<void>;
  /** Skill tuning — admin/tests now, character systems (M4) later. */
  setCharacterSkills(
    id: string,
    skills: { bluff?: number; insight?: number; necromancy?: number },
  ): Promise<void>;
  /** Immediate on death/logout, batched otherwise (D-106). */
  saveCharacterVitals(
    id: string,
    vitals: { hp?: number; xp?: number; deathDebt?: number; deeds?: number },
  ): Promise<void>;
  /** The player's level-up spending (D-546). Written immediately — a level
   * spent and then lost to a crash is the worst possible bug here. */
  saveCharacterAdvances(id: string, advances: CharacterAdvances): Promise<void>;
  /** The character's hotbar arrangement (D-553). */
  saveCharacterHotbar(id: string, hotbar: (string | null)[]): Promise<void>;
  /** Records that the kit has been handed over, or clears it at a round reset. */
  setKitGranted(id: string, granted: boolean): Promise<void>;
  /** Clears it for everybody — one statement at a reset, not one per player. */
  clearAllKitGranted(): Promise<void>;

  // Legacy (D-207/D-222)
  addLegacyPoints(accountId: string, amount: number): Promise<void>;
  getLegacyPoints(accountId: string): Promise<number>;
  retireCharacter(id: string): Promise<void>;
  countRetired(accountId: string): Promise<number>;

  // Injuries (D-205)
  addInjury(injury: Omit<InjuryRecord, 'id'>): Promise<InjuryRecord>;
  listInjuries(characterId: string): Promise<InjuryRecord[]>;
  removeInjury(injuryId: string): Promise<boolean>;
  /** Death scars over: major wounds become minor (respawn path). */
  downgradeInjuries(characterId: string): Promise<void>;

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
  /**
   * Wipes ALL recognition knowledge (D-525). The Round calls this at reset so
   * every round opens with strangers even among familiar faces. Note what
   * this does NOT touch: names and appearances persist, because knowing who
   * someone is says nothing about what they are this round — the antagonist
   * is drawn at random. The persistent world must never call it.
   */
  clearAllKnowledge(): Promise<number>;

  // Items & coin
  grantItem(
    ownerCharacterId: string,
    templateId: string,
    qty: number,
    data?: ItemData,
  ): Promise<ItemRecord>;
  getItem(itemId: string): Promise<ItemRecord | null>;
  getItemsByCharacter(characterId: string): Promise<ItemRecord[]>;
  /**
   * Removes one unit of a template from the owner (decrement or delete).
   * Null if they hold none. Atomic — the writing-material sink.
   *
   * Returns WHAT it consumed, because the caller sometimes needs to know:
   * a loaf that has been got at (D-580) nourishes nobody, and the eat path
   * cannot tell one loaf from another by template alone.
   *
   * ⚠ Prefers an UNSPOILED one where there is a choice. Given a good loaf
   * and a ruined one a person eats the good loaf, so sabotage bites when the
   * good food has run out — which is exactly the pressure D-529 wants, and
   * the opposite of a rule that made every meal a coin toss.
   */
  consumeOneItem(ownerCharacterId: string, templateId: string): Promise<ItemRecord | null>;
  /**
   * Removes everything a character owns, returning how many rows went.
   * Gear is stripped between rounds (D-522) — only xp and the character
   * itself survive.
   */
  stripCharacterItems(characterId: string): Promise<number>;
  /**
   * Wear or stow one item (D-547). Returns false if the item is gone or is
   * not this character's — the same ownership check transferItem makes, and
   * for the same reason: equipping is the one verb that reads an item id
   * straight off the wire.
   */
  setItemEquipped(itemId: string, characterId: string, slot: EquipSlot | null): Promise<boolean>;
  /** True iff the item existed AND belonged to `from` at transfer time. Atomic. */
  transferItem(itemId: string, fromCharacterId: string, toCharacterId: string): Promise<boolean>;
  /** Test/admin faucet — production coin enters via player trade only (D-220). */
  grantCoin(characterId: string, amount: number): Promise<void>;
  getCoin(characterId: string): Promise<number>;
  /** True iff `from` had at least `amount`. Atomic, never overdraws. */
  transferCoin(fromCharacterId: string, toCharacterId: string, amount: number): Promise<boolean>;

  // Corpses (D-224/D-511). All item moves here are bulk and atomic — the same
  // no-duplication contract as transferItem.
  createCorpse(c: Omit<CorpseRecord, 'id'>): Promise<CorpseRecord>;
  updateCorpse(
    id: string,
    patch: { state?: CorpseRecord['state']; areaId?: string; x?: number; y?: number; ticksLeft?: number },
  ): Promise<void>;
  /** Corpses to re-materialize on boot (state <> 'gone'). */
  listActiveCorpses(): Promise<CorpseRecord[]>;
  getItemsByCorpse(corpseId: string): Promise<ItemRecord[]>;
  /**
   * Puts an item straight onto a corpse rather than into a character's pack
   * (D-554) — what a dead roamer was carrying, and what somebody dropped on
   * the floor. The same rows `moveItemsToCorpse` produces, so looting,
   * decay and cleanup all work on it unchanged.
   */
  grantItemToCorpse(corpseId: string, templateId: string, qty: number): Promise<ItemRecord>;
  /**
   * Puts an item straight into the common stores (D-593), the third owner an
   * item can have (D-580).
   *
   * ⚠ Needed because a town has to START stocked. D-529 identified the
   * constraint and D-533 recorded it as still unmet: hiding in town beats the
   * clock unless the storehouse RUNS OUT, and nothing could stock it in the
   * first place — every route into a store went through somebody's pack.
   */
  grantItemToStore(storeId: string, templateId: string, qty: number): Promise<ItemRecord>;
  /**
   * Moves ONE item from a character onto a corpse or heap (D-554) — dropping.
   * True iff it existed AND belonged to `from`, the same atomicity contract
   * as transferItem, because dropping is a transfer with the floor as the
   * recipient and must not be able to duplicate anything.
   */
  moveItemToCorpse(itemId: string, fromCharacterId: string, corpseId: string): Promise<boolean>;
  /** Death in the wilderness (D-224): everything carried moves to the corpse. */
  moveItemsToCorpse(characterId: string, corpseId: string): Promise<number>;
  /** Looting: everything the corpse holds moves to the looter. */
  moveItemsFromCorpse(corpseId: string, toCharacterId: string): Promise<number>;
  /** The ground-loot cleanup sink (D-511: unclaimed gear is destroyed after
   * an hour). DELIBERATE destruction — callers must log what was lost. */
  deleteItemsByCorpse(corpseId: string): Promise<number>;

  // The common stores (D-529, D-530, built D-580). A facility store is keyed
  // `<areaId>:<stationType>` — the town's stores, not one particular sack.
  /** What the stores hold. Visible to anybody standing at them: pooling is
   * public, which is the whole cost of pooling (D-530). */
  getItemsByStore(storeId: string): Promise<ItemRecord[]>;
  /**
   * Pooling one item. True iff it existed AND belonged to `from` — the same
   * atomicity contract as `transferItem` and `moveItemToCorpse`, because a
   * deposit is a transfer with the town as the recipient and must not be
   * able to duplicate anything.
   */
  moveItemToStore(itemId: string, fromCharacterId: string, storeId: string): Promise<boolean>;
  /** Taking one item back out. True iff it was in THAT store. */
  moveItemFromStore(itemId: string, storeId: string, toCharacterId: string): Promise<boolean>;
  /**
   * Mark these items ruined (D-580). Returns how many were changed.
   *
   * The store layer is told WHICH items, never which are food: what counts
   * as provisions is content the gateway resolves (`nourishes`), and teaching
   * persistence about it would put the same rule in two places.
   */
  spoilItems(itemIds: readonly string[]): Promise<number>;
  /**
   * Emptying the stores at a round reset (D-522).
   *
   * ⚠ Not optional tidying. Gear is stripped between rounds, and stores that
   * survived would let the cast accumulate a permanent larder across rounds —
   * which defeats D-529's hard constraint that the stores must RUN OUT, in a
   * way that gets worse every round and would look like generosity.
   */
  clearStores(): Promise<number>;

  // DM events (D-216) — editor documents, validated against EventDocSchema
  createDmEvent(name: string, doc: unknown): Promise<DmEventRecord>;
  listDmEvents(): Promise<DmEventRecord[]>;
  getDmEvent(id: string): Promise<DmEventRecord | null>;
  updateDmEvent(
    id: string,
    patch: { name?: string; doc?: unknown; enabled?: boolean },
  ): Promise<void>;
  deleteDmEvent(id: string): Promise<void>;

  // Event log (append-only, D-106)
  appendEvent(type: string, data: Record<string, unknown>): Promise<void>;
  listRecentEvents(limit: number): Promise<EventRecord[]>;

  // Invariant probes for the harness (D-114)
  totalCoin(): Promise<number>;
  countItems(): Promise<number>;
}
