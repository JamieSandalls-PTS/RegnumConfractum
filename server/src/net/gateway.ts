import { WebSocketServer, type WebSocket } from 'ws';
import {
  ATTACK_COOLDOWN_TICKS,
  ATTACK_RANGE,
  BLEED_INTERVAL_TICKS,
  CORPSE_DECAY_TICKS,
  DEATH_DEBT_PER_DEATH,
  ENDGAME_CONFIRM_TICKS,
  FLUSH_INTERVAL_TICKS,
  GHOST_MIN_TICKS,
  GROUND_LOOT_TICKS,
  HOSTILITY_EXPIRY_TICKS,
  HOSTILITY_WINDOW_TICKS,
  INTERACT_RANGE,
  MAX_ZOMBIES_PER_NECROMANCER,
  REVIVE_WINDOW_TICKS,
  Rng,
  SEANCE_QUESTIONS,
  SESSION_TTL_MS,
  TICK_MS,
  ZOMBIE_DURATION_TICKS,
  ATTACK_VARIANTS,
  CARRY_BASE_CAPACITY,
  COMBAT_LEAVE_TICKS,
  COMBAT_PROXIMITY_TILES,
  CREATION_FEAT_PICKS,
  CREATION_SKILL_MAX,
  CREATION_SKILL_POINTS,
  CREATION_SKILL_STEP,
  CREATION_SPELL_PICKS,
  chebyshev,
  describeAppearance,
  describeHooded,
  generateAppearance,
  parseClientMessage,
  validateBuild,
  type AreaDef,
  type Channel,
  type CharacterSummary,
  type ClassAbility,
  type ClientMessage,
  type Direction,
  type ErrorCode,
  type ServerMessage,
  COMBAT_NOISE_NEAR_TILES,
  COMBAT_NOISE_TILES,
  type Vec2,
  applyNightBonus,
  isNight,
  roundHour,
  type ObjectiveDef,
  type RecipeDef,
  type RoamerDef,
  ROAMER_SPAWN_CLEARANCE,
  ROUND_DAY_TICKS,
  ROUND_GRACE_TICKS,
  DIRECTIONS,
  dungeonEntranceOpen,
  dungeonFloorOpen,
  HUNGER_WORK_MULTIPLIER,
  THIRST_MAX_HP_FRACTION,
  deepen,
  needNotice,
  relieve,
  stepHoursFor,
  STARVATION_DAMAGE_PER_HOUR,
  type NeedStage,
  isTileWalkable,
} from '@rc/shared';
import { hashPassword, newSessionToken, verifyPassword } from '../auth';
import type { Content } from '../content';
import type { CharacterRecord, InjuryRecord, Store } from '../store/types';
import { World, toWireEntity, type WorldEntity } from '../game/world';
import { RoundEngine, type RoundResolution } from '../game/round';

/** Words for a bearing, so the wire stays terse and the prose lives here. */
const COMPASS_WORDS: Record<string, string> = {
  n: 'north', ne: 'north-east', e: 'east', se: 'south-east',
  s: 'south', sw: 'south-west', w: 'west', nw: 'north-west', here: 'here',
};

/**
 * Eight-point bearing from a listener to a source. Deliberately coarse: a
 * precise angle would let a listener triangulate, and a sound is meant to
 * send you looking in roughly the right direction, not hand you a position.
 */
function bearingFrom(dx: number, dy: number): 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' | 'here' {
  if (dx === 0 && dy === 0) return 'here';
  const ns = Math.abs(dy) * 2 >= Math.abs(dx) ? (dy < 0 ? 'n' : 's') : '';
  const ew = Math.abs(dx) * 2 >= Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : '';
  return ((ns + ew) || 'here') as 'n';
}

/** How close you must stand to use a facility (D-530). */
const STATION_REACH_TILES = 2;

/** What each facility looks like to an observer. */
const STATION_DESCRIPTORS: Record<string, string> = {
  workshop: 'a scarred anvil and a bench of tools',
  storehouse: 'a rack of barrels and sacks, part-full',
  infirmary: 'a scrubbed table and a shelf of stoppered jars',
  well: 'a stone well, its rope worn smooth',
};

/** How long a resolved round holds the reveal before resetting to lobby. */
const ROUND_RESOLUTION_TICKS = 150; // 15s
import { EmoteParser } from '../game/emotes';
import { hasLineOfSight } from '../game/los';
import { resolveNameContest } from '../game/contest';
import { scrambleSpeech } from '../game/language';
import { computeLegacyAward } from '../game/legacy';

/** Earshot per channel, chebyshev tiles. Whisper and speech need line of
 * sight; a shout carries around walls — you hear it without seeing who. */
const CHANNEL_RANGE: Record<Channel, number> = { whisper: 1, say: 10, shout: 40 };

/**
 * The WebSocket gateway: owns the World, the tick loop, and all connections.
 * Clients send intent; the world decides; deltas go out per tick (D-102,
 * D-107). Constructed in-process by tests and by the real entrypoint alike —
 * the harness runs the same code path players hit.
 */

export interface GameServerOptions {
  store: Store;
  content: Content;
  port: number;
  /** Wall-clock ms per tick. Game logic is tick-based, so tests may shrink
   * this to run faster without changing semantics. Defaults to TICK_MS. */
  tickIntervalMs?: number;
  defaultAreaId?: string;
  /** Seeds contest rolls — fixed in tests for reproducibility (D-114). */
  rngSeed?: number;
  /** Combat/death pacing overrides — tests shrink these (logic is tick-based). */
  hostilityWindowTicks?: number;
  ghostMinTicks?: number;
  attackCooldownTicks?: number;
  bleedIntervalTicks?: number;
  /** Spirit-interaction pacing (D-511) — tests shrink these too. */
  corpseDecayTicks?: number;
  groundLootTicks?: number;
  zombieDurationTicks?: number;
  /** D-206 endgame zones: how long a downed player may still be revived. */
  reviveWindowTicks?: number;
  /** Combat-state pacing — tests shrink these; the rule is tick-based. */
  combatLeaveTicks?: number;
  combatProximityTiles?: number;
  /**
   * The Round (D-521). Off by default: without it this is the persistent
   * world, with respawn, death debt and enduring recognition. Turning it on
   * changes the rules of death, progression and memory all at once, which is
   * why it is one switch rather than several.
   */
  round?: {
    enabled: boolean;
    /** Defaults to ROUND_LENGTH_TICKS; tests shrink it. */
    lengthTicks?: number;
    /** Defaults to ROUND_MIN_CAST (three). */
    minCast?: number;
    /** Seeds antagonist and objective selection. Fixed in tests. */
    seed?: number | string;
    /** Overrides content objectives — tests use a known scenario. */
    objectives?: ObjectiveDef[];
    /** Ticks to hold the resolution before resetting to lobby. */
    resolutionTicks?: number;
    /** Length of one day-night cycle. Tests shrink it; the rule is tick-based. */
    dayTicks?: number;
    /** Length of the dawn truce (D-536). Tests shrink it. */
    graceTicks?: number;
  };
  log?: (msg: string) => void;
}

/**
 * What a body weighs, on the same 0–100 scale as skills. Derived from the
 * dead character's own generated build (D-402), so a heavy figure is
 * genuinely harder to shift than a slight one and the number is stable
 * for a given corpse.
 */
export function corpseBurden(appearanceSeed: number): number {
  const a = generateAppearance(appearanceSeed);
  return Math.round(a.bulk * 90 + (a.height - 1.6) * 30);
}

/** A live corpse or gear-pile world object, mirrored from the corpses table. */
interface CorpseRuntime {
  corpseId: string;
  characterId: string;
  state: 'corpse' | 'ground';
  expiresAtTick: number;
}

/** An animated corpse walking the world (D-224). */
interface ZombieRuntime {
  corpseId: string;
  /** The dead character wearing the gear. */
  characterId: string;
  /** The necromancer who raised it. */
  ownerCharacterId: string;
  expiresAtTick: number;
}

/** A séance in progress (D-204): five questions, answers under no oath. */
interface Seance {
  caster: ConnState;
  spirit: ConnState;
  corpseId: string;
  corpseEntityId: number;
  questionsLeft: number;
}

interface ConnState {
  ws: WebSocket;
  accountId: string | null;
  character: CharacterRecord | null;
  entityId: number | null;
  areaId: string | null;
  /** Live vitals cache; persisted immediately on death/logout (D-106). */
  vitals: { hp: number; maxHp: number; xp: number; deathDebt: number } | null;
  injuries: InjuryRecord[];
  /** Endgame zones (D-206): fallen but revivable until the window closes.
   * Null everywhere else — ordinary deaths ghost immediately. */
  downed: { expiresAtTick: number } | null;
  /**
   * What this connection is working at (MR2). Being occupied is the price of
   * gathering and crafting: you are stationary and busy for a known interval,
   * which is exactly when someone would choose to be behind you (D-529).
   */
  work: {
    activity: 'harvest' | 'craft';
    what: string;
    /** Node entity id, or the recipe id. */
    targetId: number | string;
    startedAtTick: number;
    endsAtTick: number;
    /** Where they stood when they began — moving cancels it. */
    at: { x: number; y: number };
  } | null;
  /**
   * Survival needs (D-526). Round-scoped, like everything else the round
   * holds: a character does not walk into the next round still starving.
   */
  needs: {
    hunger: NeedStage;
    thirst: NeedStage;
    hungerAtHour: number;
    thirstAtHour: number;
    /** Last hour starvation took its bite, so it lands once an hour. */
    starvedAtHour: number;
  };
  /** Serialises message handling per connection. */
  queue: Promise<void>;
}

export class GameServer {
  readonly world = new World();
  private readonly store: Store;
  private readonly content: Content;
  private readonly tickIntervalMs: number;
  private readonly defaultAreaId: string;
  private readonly log: (msg: string) => void;

  private wss: WebSocketServer | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private emoteParser: EmoteParser;
  private contestRng: Rng;
  private conns = new Set<ConnState>();
  private connsByArea = new Map<string, Set<ConnState>>();
  private onlineCharacters = new Set<string>();
  private entityCharacter = new Map<number, string>();
  /** Characters whose position changed since the last flush (D-106). */
  private dirtyCharacters = new Map<string, { areaId: string; x: number; y: number }>();
  /** DM lighting overrides, on top of the authored profile. */
  private lightingOverrides = new Map<string, AreaDef['lighting']>();
  /** Runtime transition overlays (into temporary areas), per host area. */
  private runtimeTransitions = new Map<string, AreaDef['transitions']>();
  /** Temporary (DM/event-spawned) areas, removable at rollback. */
  private tempAreaDefs = new Map<string, AreaDef>();
  /** Script-host hooks — wired by the entrypoint, no-ops otherwise. */
  onAreaEnter: ((areaId: string, entityId: number) => void) | null = null;
  onTickHook: ((tick: number) => void) | null = null;
  /** Fires for any entity death — feeds EventEngine.entityDied (D-508). */
  onEntityDeath: ((entityId: number) => void) | null = null;
  /** attackerCharId|targetCharId → tick the declaration was made (D-206). */
  private hostilities = new Map<string, number>();
  private hostilityWindowTicks = HOSTILITY_WINDOW_TICKS;
  private ghostMinTicks = GHOST_MIN_TICKS;
  private attackCooldownTicks = ATTACK_COOLDOWN_TICKS;
  private bleedIntervalTicks = BLEED_INTERVAL_TICKS;
  private corpseDecayTicks = CORPSE_DECAY_TICKS;
  private groundLootTicks = GROUND_LOOT_TICKS;
  private zombieDurationTicks = ZOMBIE_DURATION_TICKS;
  /** Corpse/pile world objects by entity id (D-224/D-511). */
  private corpsesByEntity = new Map<number, CorpseRuntime>();
  /** Animated corpses by zombie entity id. */
  private zombies = new Map<number, ZombieRuntime>();
  /** Active séances, indexed from both ends. */
  private seancesByCaster = new Map<ConnState, Seance>();
  private seancesBySpirit = new Map<ConnState, Seance>();
  /** Dead players riding along in their animated bodies (D-224). */
  private bodyObservers = new Map<ConnState, number>(); // conn → zombie entity id
  /** Endgame way-marker warnings pending confirmation (D-206). */
  private endgameConfirms = new Map<ConnState, { areaId: string; x: number; y: number; expiresAtTick: number }>();
  private reviveWindowTicks = REVIVE_WINDOW_TICKS;
  private combatLeaveTicks = COMBAT_LEAVE_TICKS;
  private combatProximityTiles = COMBAT_PROXIMITY_TILES;

  // --- The Round (D-521). Null in the persistent world. -------------------
  private round: RoundEngine | null = null;
  private roundResolutionTicks = ROUND_RESOLUTION_TICKS;
  /** Tick at which a resolved round resets; null unless one is resolved. */
  private roundResetAtTick: number | null = null;
  /** Tick the running round started at — the origin of its own clock. */
  private roundStartedAtTick = 0;
  /** Last broadcast day-night phase, so lighting changes fire once. */
  private roundLastNight: boolean | null = null;
  /** One full day-night cycle for this server (D-527); tests shrink it. */
  private roundDayTicks = ROUND_DAY_TICKS;
  /** Length of the dawn truce (D-536); tests shrink it. */
  private roundGraceTicks = ROUND_GRACE_TICKS;
  /** World tick the current truce ends at, or null when the day is running. */
  private roundGraceUntil: number | null = null;
  /**
   * Total ticks the round's clock has been stopped for. Everything on the
   * round clock is measured against `world.tick - this`, so a truce genuinely
   * pauses the day rather than merely suppressing its effects.
   */
  private roundPausedTicks = 0;
  /**
   * XP earned this round, per connection, banked to the character only if
   * they are alive at the end (D-524). Dying forfeits the round's earnings —
   * that is the whole cost of death, and it is why this is a separate pot
   * rather than a write straight to vitals.
   */
  private roundXp = new Map<ConnState, number>();
  /** Characters who have died this round — no respawn, so this only grows. */
  private roundDead = new Set<string>();
  /** Cast size we last complained about being unable to start, if any. */
  private lobbyStuckAt: number | null = null;
  /** Night roamers abroad right now (D-527/D-529), by entity id. */
  private roamers = new Map<number, RoamerDef>();
  /** Seeded so a round's nights are reproducible in the harness (D-114). */
  private roamerRng = new Rng(1);
  /** Each roamer's current drift, held for a stretch so they cross ground. */
  private roamerHeadings = new Map<number, Direction>();

  constructor(opts: GameServerOptions) {
    this.store = opts.store;
    this.content = opts.content;
    this.tickIntervalMs = opts.tickIntervalMs ?? TICK_MS;
    this.log = opts.log ?? (() => {});
    this.emoteParser = new EmoteParser(opts.content.emoteLexicon);
    this.contestRng = new Rng(opts.rngSeed ?? Math.floor(Math.random() * 2 ** 31));
    this.hostilityWindowTicks = opts.hostilityWindowTicks ?? HOSTILITY_WINDOW_TICKS;
    this.ghostMinTicks = opts.ghostMinTicks ?? GHOST_MIN_TICKS;
    this.attackCooldownTicks = opts.attackCooldownTicks ?? ATTACK_COOLDOWN_TICKS;
    this.bleedIntervalTicks = opts.bleedIntervalTicks ?? BLEED_INTERVAL_TICKS;
    this.corpseDecayTicks = Math.max(opts.corpseDecayTicks ?? CORPSE_DECAY_TICKS, this.ghostMinTicks);
    this.groundLootTicks = opts.groundLootTicks ?? GROUND_LOOT_TICKS;
    this.zombieDurationTicks = opts.zombieDurationTicks ?? ZOMBIE_DURATION_TICKS;
    this.reviveWindowTicks = opts.reviveWindowTicks ?? REVIVE_WINDOW_TICKS;
    this.combatLeaveTicks = opts.combatLeaveTicks ?? COMBAT_LEAVE_TICKS;
    this.combatProximityTiles = opts.combatProximityTiles ?? COMBAT_PROXIMITY_TILES;
    if (opts.round?.enabled) {
      this.round = new RoundEngine({
        objectives: opts.round.objectives ?? opts.content.objectives,
        rng: new Rng(opts.round.seed ?? Math.floor(Math.random() * 2 ** 31)),
        lengthTicks: opts.round.lengthTicks,
        minCast: opts.round.minCast,
        log: this.log,
      });
      this.roundResolutionTicks = opts.round.resolutionTicks ?? ROUND_RESOLUTION_TICKS;
      this.roamerRng = new Rng(opts.round.seed ?? 'roamers');
      this.roundDayTicks = opts.round.dayTicks ?? ROUND_DAY_TICKS;
      this.roundGraceTicks = opts.round.graceTicks ?? ROUND_GRACE_TICKS;
      // A configured minimum below anything the content can actually run is a
      // server that fills its lobby and never starts. That is a
      // misconfiguration, and it belongs in the log at boot rather than being
      // discovered by players waiting in an empty town.
      const smallest = Math.min(
        ...this.round.eligibleObjectivesAnySize().map((o) => o.minCast),
      );
      if (Number.isFinite(smallest) && this.round.minimumCast < smallest) {
        this.log(
          `round: WARNING — minimum cast is ${this.round.minimumCast} but the smallest ` +
          `live objective needs ${smallest}. No round can start until enough players join.`,
        );
      }
    }
    for (const def of opts.content.areas.values()) this.world.addArea(def);
    const fallback = opts.content.areas.keys().next().value as string;
    this.defaultAreaId = opts.defaultAreaId ?? fallback;
    if (!this.world.hasArea(this.defaultAreaId)) {
      throw new Error(`default area '${this.defaultAreaId}' not in content`);
    }
    this.requestedPort = opts.port;
  }

  private requestedPort: number;
  port = 0;

  async start(): Promise<void> {
    await this.store.init();
    await this.restoreCorpses();
    await new Promise<void>((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.requestedPort }, resolve);
      this.wss.on('error', reject);
    });
    const address = this.wss!.address();
    this.port = typeof address === 'object' && address ? address.port : this.requestedPort;
    this.wss!.on('connection', (ws) => this.onConnection(ws));
    this.tickTimer = setInterval(() => void this.onTick(), this.tickIntervalMs);
    this.log(`gateway listening on :${this.port}`);
  }

  /** Flushes everything and stops. The store is left open — the caller owns it. */
  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const conn of [...this.conns]) {
      await this.handleDisconnect(conn);
      conn.ws.close();
    }
    await this.flushDirty();
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
    this.wss = null;
  }

  connectionCount(): number {
    return this.conns.size;
  }

  // -------------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------------

  private async onTick(): Promise<void> {
    const eventsByArea = this.world.step();
    const transfers: { conn: ConnState; toArea: string; toX: number; toY: number }[] = [];
    for (const [areaId, events] of eventsByArea) {
      const def = this.world.getAreaDef(areaId);
      for (const event of events) {
        if (event.type === 'entity_moved') {
          const characterId = this.entityCharacter.get(event.id);
          if (characterId) {
            this.dirtyCharacters.set(characterId, { areaId, x: event.x, y: event.y });
          }
          // Stepping onto a transition tile crosses to the linked area (D-103).
          const tr = this.transitionsFor(areaId).find((t) => t.x === event.x && t.y === event.y);
          if (tr) {
            const conn = [...(this.connsByArea.get(areaId) ?? [])].find(
              (c) => c.entityId === event.id,
            );
            if (
              conn &&
              this.dungeonGateAllows(conn, areaId, tr.toArea) &&
              this.confirmEndgameEntry(conn, areaId, event.x, event.y, tr.toArea)
            ) {
              transfers.push({ conn, toArea: tr.toArea, toX: tr.toX, toY: tr.toY });
            }
          }
        }
      }
      // Events are partitioned by plane: the living never receive a ghost's
      // movement, and ghosts never receive the living's (D-203).
      const livingEvents = events.filter((e) => !this.eventFromGhost(e));
      const ghostEvents = events.filter((e) => this.eventFromGhost(e));
      if (livingEvents.length > 0) {
        this.broadcastPlane(areaId, false, { t: 'delta', tick: this.world.tick, events: livingEvents });
      }
      if (ghostEvents.length > 0) {
        this.broadcastPlane(areaId, true, { t: 'delta', tick: this.world.tick, events: ghostEvents });
      }
    }
    for (const t of transfers) {
      await this.transferToArea(t.conn, t.toArea, t.toX, t.toY);
    }
    if (this.world.tick % this.bleedIntervalTicks === 0) {
      await this.bleedTick();
    }
    this.zombieAiTick();
    await this.spiritTick();
    await this.downedTick();
    this.combatTick();
    this.carryTick();
    await this.roundTick();
    this.nodeTick();
    if (this.roundRunning) await this.roamerTick();
    await this.needsTick();
    await this.workTick();
    this.onTickHook?.(this.world.tick);
    if (this.world.tick % FLUSH_INTERVAL_TICKS === 0) {
      await this.flushDirty();
    }
  }

  // -------------------------------------------------------------------------
  // The Round (D-521 - D-527)
  //
  // The gateway owns the round's *world side*; the engine owns its logic and
  // stays pure. What lives here is everything that touches connections,
  // persistence or the clock: who is in the cast, telling one player their
  // secret, banking or forfeiting xp, and the reset that wipes recognition
  // and strips gear.
  // -------------------------------------------------------------------------

  /** Everyone currently in the world with a character - the round's cast. */
  private roundCast(): { characterId: string; entityId: number }[] {
    return [...this.conns]
      .filter((c) => c.character !== null && c.entityId !== null)
      .map((c) => ({ characterId: c.character!.id, entityId: c.entityId! }));
  }

  /** True while a round is running - the switch for round death rules. */
  private get roundRunning(): boolean {
    return this.round?.phase === 'running';
  }

  /** Ticks elapsed in the current round - the origin of its own clock. */
  private roundTickOffset(): number {
    return Math.max(0, this.roundEffectiveTick() - this.roundStartedAtTick);
  }

  /** World tick minus every tick the round has been paused for (D-536). */
  private roundEffectiveTick(): number {
    return this.world.tick - this.roundPausedTicks;
  }

  /** True while the dawn truce holds: no clock, no harm, no leaving. */
  private get inGrace(): boolean {
    return this.roundGraceUntil !== null && this.world.tick < this.roundGraceUntil;
  }

  /** Opens a truce and tells everyone why the world has gone quiet. */
  private beginGrace(reason: string): void {
    if (this.roundGraceTicks <= 0) return;
    this.roundGraceUntil = this.world.tick + this.roundGraceTicks;
    this.broadcastNarrate(reason);
    this.broadcastRoundState();
  }

  private async roundTick(): Promise<void> {
    const r = this.round;
    if (!r) return;
    if (this.inGrace) {
      // The day does not advance. Counted rather than skipped, so every
      // round-clock reading stays consistent with itself.
      this.roundPausedTicks++;
      if (this.world.tick % 10 === 0) this.broadcastRoundState();
      return;
    }
    if (this.roundGraceUntil !== null && this.world.tick >= this.roundGraceUntil) {
      this.roundGraceUntil = null;
      this.broadcastNarrate('The day begins.');
      this.broadcastRoundState();
    }
    if (r.phase === 'lobby') {
      const cast = this.roundCast();
      if (cast.length >= r.minimumCast && (await this.startRound(cast))) return;
      // Broadcast REGARDLESS of whether a start was attempted. The first
      // version only spoke when the cast was too small, so a lobby that was
      // big enough but had no objective it could run went completely silent:
      // no HUD, no clock, no explanation, forever. Found by running it.
      if (this.world.tick % 50 === 0) this.broadcastRoundState();
      return;
    }
    if (r.phase === 'running') {
      this.roundDayNightTick();
      const resolution = r.evaluate(this.roundEffectiveTick());
      if (resolution) await this.finishRound(resolution);
      else if (this.world.tick % 10 === 0) this.broadcastRoundState();
      return;
    }
    if (this.roundResetAtTick !== null && this.world.tick >= this.roundResetAtTick) {
      await this.resetRound();
    }
  }

  private async startRound(cast: { characterId: string; entityId: number }[]): Promise<boolean> {
    const assignment = this.round!.start(cast, this.roundEffectiveTick());
    if (!assignment) {
      // Complain ONCE per change of circumstance, not once per tick. The
      // first version logged this ten times a second.
      if (this.lobbyStuckAt !== cast.length) {
        this.lobbyStuckAt = cast.length;
        this.log(
          `round: waiting — no live objective is playable at a cast of ${cast.length}. ` +
          'Check content/objectives minCast against the configured minimum.',
        );
      }
      return false;
    }
    this.lobbyStuckAt = null;
    this.roundStartedAtTick = this.roundEffectiveTick();
    this.roundLastNight = null;
    this.roundXp.clear();
    this.roundDead.clear();
    // EVERY player receives a role message. Only one carries an objective, so
    // the arrival of the message is not itself a tell - which it would be if
    // only the antagonist were told anything.
    for (const conn of this.conns) {
      if (!conn.character) continue;
      const secret = this.round!.secretRole(conn.character.id);
      this.send(conn, {
        t: 'round_role',
        antagonist: secret !== null,
        objective: secret
          ? { id: secret.objective.id, name: secret.objective.name, brief: secret.objective.brief }
          : null,
      });
    }
    // Logged for moderation (invariant 10). This is the one place the
    // antagonist's identity is written down while the round is live, and it
    // goes to the event log, never to a connection.
    await this.store.appendEvent('round_started', {
      objective: assignment.objective.id,
      antagonist: assignment.antagonistCharacterId,
      target: assignment.targetCharacterId,
      castSize: cast.length,
    });
    this.broadcastRoundState();
    this.roundDayNightTick(false); // set the light, announce nothing
    // The world's resources are per-round, like everything else it holds
    // (D-523): a fresh map every time, with nothing carried over.
    this.despawnNodes();
    this.despawnStations();
    this.spawnNodes();
    this.spawnStations();
    this.despawnRoamers(); // a new round opens at dawn, whatever the last one left
    this.beginGrace('You have all woken in the same place. Say what needs saying.');
    return true;
  }

  /**
   * Drives the compressed day-night cycle (D-527). Night is the round's
   * pressure inwards; the lighting change is the only warning players get, so
   * it fires on the tick the hour turns rather than at the next state
   * broadcast.
   */
  private roundDayNightTick(announce = true): void {
    const night = isNight(this.roundTickOffset(), this.roundDayTicks);
    if (night === this.roundLastNight) return;
    this.roundLastNight = night;
    // Dusk puts them out; dawn takes them back. Survivors do not linger —
    // night is a phase, not a growing infestation.
    if (night) {
      this.spawnRoamers();
    } else {
      this.despawnRoamers();
      // Dawn: the survivors get a minute before the day starts (D-536).
      if (announce) {
        this.beginGrace(
          'Grey light, and everyone still standing. There is a little time before the day starts properly.',
        );
      }
    }
    // At round start there is no transition to announce — the sun did not
    // just come up, the round merely began. Without this every round opened
    // with "it is over, for a while", which reads as the end of a night
    // nobody lived through.
    if (!announce) {
      this.applyDayNightLighting(night);
      this.broadcastRoundState();
      return;
    }
    this.applyDayNightLighting(night);
    this.broadcastNarrate(
      night
        ? 'The light goes out of the sky. Whatever walks abroad is walking now.'
        : 'Grey light returns. It is over, for a while.',
    );
    this.broadcastRoundState();
  }

  /** Darkens or restores every area the sky reaches. */
  private applyDayNightLighting(night: boolean): void {
    for (const areaId of this.world.areaIds()) {
      const def = this.world.getAreaDef(areaId);
      // Only what the sky reaches darkens. Keyed off `outdoor`, never off
      // `lighting` — how an area looks must not decide whether night reaches
      // it (D-527, D-528).
      if (!def.outdoor) continue;
      this.broadcast(areaId, { t: 'area_lighting', lighting: night ? 'night' : def.lighting });
    }
  }

  private broadcastNarrate(text: string): void {
    for (const conn of this.conns) {
      if (conn.character) this.send(conn, { t: 'narrate', text });
    }
  }

  private broadcastRoundState(): void {
    const r = this.round;
    if (!r) return;
    const offset = this.roundTickOffset();
    const running = r.phase === 'running';
    const msg = {
      t: 'round_state' as const,
      phase: r.phase,
      cast: this.roundCast().length,
      minCast: r.minimumCast,
      remainingTicks: r.remainingTicks(this.roundEffectiveTick()),
      // Outside a running round the clock has no meaning; show first light.
      hour: running ? roundHour(offset, this.roundDayTicks) : 6,
      night: running ? isNight(offset, this.roundDayTicks) : false,
      graceTicks: this.roundGraceUntil === null
        ? 0
        : Math.max(0, this.roundGraceUntil - this.world.tick),
    };
    for (const conn of this.conns) {
      if (conn.character) this.send(conn, msg);
    }
  }

  /**
   * Ends the round: banks what the living earned, forfeits what the dead did
   * (D-524), and reveals who was carrying the objective. The reveal is the
   * only message that ever names the antagonist.
   */
  private async finishRound(res: RoundResolution): Promise<void> {
    const antagonistName =
      (await this.store.getCharacter(res.antagonistCharacterId))?.name ?? 'someone unaccounted for';
    for (const conn of this.conns) {
      if (!conn.character || !conn.vitals) continue;
      const pot = this.roundXp.get(conn) ?? 0;
      const survived = !this.roundDead.has(conn.character.id);
      // Dying costs you the round's earnings - the whole cost of death, and
      // the reason a rich late dive is a gamble rather than free value.
      if (survived && pot > 0) {
        conn.vitals.xp += pot;
        await this.store.saveCharacterVitals(conn.character.id, { xp: conn.vitals.xp });
      }
      this.send(conn, {
        t: 'round_ended',
        outcome: res.outcome,
        winner: res.winner,
        objectiveName: res.objective.name,
        antagonistName,
        xpBanked: survived ? pot : 0,
        survived,
      });
      this.sendStatus(conn);
    }
    await this.store.appendEvent('round_ended', {
      outcome: res.outcome,
      winner: res.winner,
      objective: res.objective.id,
      antagonist: res.antagonistCharacterId,
    });
    this.roundResetAtTick = this.world.tick + this.roundResolutionTicks;
    this.broadcastRoundState();
  }

  /**
   * Clears the round. Two wipes matter and both are easy to forget:
   * recognition knowledge (D-525) so the next round opens with strangers even
   * among familiar faces, and gear (D-522) so nothing but xp crosses the
   * boundary. Names, faces and levels persist - the character is the same
   * person, and knowing who they are still says nothing about what they are.
   */
  private async resetRound(): Promise<void> {
    const forgotten = await this.store.clearAllKnowledge();
    let stripped = 0;
    for (const conn of this.conns) {
      if (conn.character) stripped += await this.store.stripCharacterItems(conn.character.id);
    }
    this.despawnNodes();
    this.despawnStations();
    this.despawnRoamers();
    for (const conn of this.conns) this.interruptWork(conn, 'the round ended');
    this.round!.reset();
    this.roundResetAtTick = null;
    this.roundPausedTicks = 0;
    this.roundGraceUntil = null;
    this.roundStartedAtTick = this.world.tick;
    this.roundLastNight = null;
    this.roundXp.clear();
    this.roundDead.clear();
    for (const conn of this.conns) {
      conn.needs = {
        hunger: 'sated',
        thirst: 'sated',
        hungerAtHour: 0,
        thirstAtHour: 0,
        starvedAtHour: 0,
      };
      this.applyThirstToVitals(conn);
    }
    await this.store.appendEvent('round_reset', { forgotten, stripped });
    this.log(`round: reset - ${forgotten} memories wiped, ${stripped} items stripped`);
    this.broadcastRoundState();
  }

  /**
   * The sound of fighting (D-531), to everyone in earshot but the fighters.
   *
   * Three properties are deliberate and each is load-bearing:
   *
   *   - **It ignores line of sight.** You hear a brawl through a wall. Sound
   *     travelling where sight cannot is the whole mechanic — otherwise
   *     killing someone indoors would be silent and the town would be free.
   *   - **It names nobody.** A bearing and a distance band, never an id, a
   *     descriptor or a coordinate. It is a lead worth walking towards, not
   *     evidence, which is what keeps D-217 intact.
   *   - **It respects the plane.** Ghosts never hear the living. A dead
   *     player who could hear where fighting was happening would be a live
   *     scout on a voice call, which is invariant 4 by another route.
   *
   * NPC fights are just as audible as murders, and that ambiguity is a
   * feature: at night, with roamers abroad, "something is fighting to the
   * north" could be a wolf or could be your friend being killed.
   */
  private emitCombatNoise(areaId: string, at: Vec2, participants: number[]): void {
    if (!this.roundRunning) return;
    for (const other of this.connsByArea.get(areaId) ?? []) {
      if (!other.character || other.entityId === null) continue;
      if (participants.includes(other.entityId)) continue;
      const listener = this.world.getEntity(other.entityId);
      if (!listener || listener.ghost) continue; // the dead hear nothing (D-203)
      const dx = at.x - listener.pos.x;
      const dy = at.y - listener.pos.y;
      const range = Math.max(Math.abs(dx), Math.abs(dy));
      if (range > COMBAT_NOISE_TILES) continue;
      const near = range <= COMBAT_NOISE_NEAR_TILES;
      const bearing = bearingFrom(dx, dy);
      const where = bearing === 'here' ? 'right beside you' : `to the ${COMPASS_WORDS[bearing]}`;
      this.send(other, {
        t: 'sound',
        kind: 'combat',
        bearing,
        distance: near ? 'near' : 'far',
        text: near
          ? `Steel and shouting, ${where}.`
          : `You hear fighting somewhere ${where}, carried thin on the air.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Hunger and thirst (D-526)
  //
  // They pull in OPPOSITE directions, which is the design: hunger pushes you
  // OUT (food grows on the farm) and thirst pulls you IN (water is the well
  // at the town's centre). Between them nobody can settle anywhere — and the
  // well becomes the most valuable object on the map, which is what a
  // poisoner needs in order to have anything worth poisoning (D-529).
  //
  // Coarse, never a bar. Stages step on the round's own clock, the first one
  // costs a decision rather than health, and the worst one PLATEAUS. Nothing
  // here can kill: a round decided by an unattended need instead of by a
  // person is a failed round. ⚠ Whether starvation may kill is unratified.
  // -------------------------------------------------------------------------

  /** Total game hours elapsed in this round — needs step on this, not ticks. */
  private roundElapsedHours(): number {
    const ticksPerHour = Math.max(1, this.roundDayTicks / 24);
    return Math.floor(this.roundTickOffset() / ticksPerHour);
  }

  private async needsTick(): Promise<void> {
    if (!this.roundRunning || this.inGrace) return;
    const hours = this.roundElapsedHours();
    for (const conn of this.conns) {
      if (!conn.character || conn.entityId === null || !conn.vitals) continue;
      if (this.world.getEntity(conn.entityId)?.ghost) continue; // the dead do not hunger
      // Starving costs health every game hour (D-534). Applied before the
      // stage steps so the hour a player reaches 'starving' is a warning
      // rather than a wound — the damage begins the hour AFTER.
      if (conn.needs.hunger === 'starving' && hours > conn.needs.starvedAtHour) {
        conn.needs.starvedAtHour = hours;
        conn.vitals.hp -= STARVATION_DAMAGE_PER_HOUR;
        this.sendStatus(conn);
        if (conn.vitals.hp <= 0) {
          await this.die(conn, 'starvation');
          continue;
        }
      }
      for (const need of ['hunger', 'thirst'] as const) {
        const key = need === 'hunger' ? 'hungerAtHour' : 'thirstAtHour';
        const due = conn.needs[key] + stepHoursFor(need, false);
        if (hours < due) continue;
        conn.needs[key] = hours;
        const before = conn.needs[need];
        const after = deepen(before, need);
        if (after === before) continue; // already at the plateau
        conn.needs[need] = after;
        const notice = needNotice(need, after);
        if (notice) this.send(conn, { t: 'narrate', text: notice });
        this.applyThirstToVitals(conn);
        this.sendStatus(conn);
        await this.store.appendEvent('need_deepened', {
          characterId: conn.character.id,
          need,
          stage: after,
        });
      }
    }
  }

  /**
   * Thirst makes you FRAIL rather than dying: maximum health drops, so you
   * lose fights you would otherwise win. Current health is clamped to it, but
   * never below one — the need itself must not be the thing that kills.
   */
  private applyThirstToVitals(conn: ConnState): void {
    if (!conn.vitals || !conn.character) return;
    const full = conn.character.maxHp;
    conn.vitals.maxHp = Math.max(1, Math.round(full * THIRST_MAX_HP_FRACTION[conn.needs.thirst]));
    conn.vitals.hp = Math.max(1, Math.min(conn.vitals.hp, conn.vitals.maxHp));
  }

  /** Hunger makes work slower — the economic half of the pressure. */
  private hungerWorkMultiplier(conn: ConnState): number {
    return HUNGER_WORK_MULTIPLIER[conn.needs.hunger];
  }

  private async handleEat(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'eat' }>,
  ): Promise<void> {
    if (!conn.character || !conn.vitals) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const template = this.content.itemTemplates.get(msg.templateId);
    if (!template?.nourishes) return this.fail(conn, 'not_food', 'that is not food');
    if (conn.needs[template.nourishes] === 'sated') {
      return this.fail(conn, 'not_hungry', 'you have no appetite for it');
    }
    if (!(await this.store.consumeOneItem(conn.character.id, msg.templateId))) {
      return this.fail(conn, 'missing_materials', 'you have none');
    }
    // A meal taken at the stores holds you longer than one taken in a ditch
    // (D-530) — the bonus is TIME, not quantity, so there is no bookkeeping.
    const atFacility = this.atStation(conn, 'storehouse');
    conn.needs[template.nourishes] = relieve();
    const key = template.nourishes === 'hunger' ? 'hungerAtHour' : 'thirstAtHour';
    conn.needs[key] =
      this.roundElapsedHours() +
      (atFacility ? stepHoursFor(template.nourishes, true) - stepHoursFor(template.nourishes, false) : 0);
    this.applyThirstToVitals(conn);
    this.send(conn, {
      t: 'narrate',
      text: atFacility
        ? 'You eat properly, sitting down, out of the common stores. It will hold you a while.'
        : 'You eat standing up, quickly, watching the treeline.',
    });
    await this.sendInventory(conn);
    this.sendStatus(conn);
    await this.store.appendEvent('ate', {
      characterId: conn.character.id,
      item: msg.templateId,
      atFacility,
    });
  }

  private async handleDrink(conn: ConnState): Promise<void> {
    if (!conn.character || !conn.vitals || conn.entityId === null) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    // Water is not carried. You come to the well — which is what makes thirst
    // a leash back to town, and the well worth poisoning (D-529).
    if (!this.atWell(conn)) {
      return this.fail(conn, 'no_water_here', 'there is no water within reach');
    }
    if (conn.needs.thirst === 'sated') return this.fail(conn, 'not_hungry', 'you are not thirsty');
    conn.needs.thirst = relieve();
    conn.needs.thirstAtHour =
      this.roundElapsedHours() + (stepHoursFor('thirst', true) - stepHoursFor('thirst', false));
    this.applyThirstToVitals(conn);
    this.send(conn, { t: 'narrate', text: 'You drink deep. The water is cold and tastes of stone.' });
    this.sendStatus(conn);
    await this.store.appendEvent('drank', { characterId: conn.character.id, areaId: conn.areaId });
  }

  /** Whether the player stands at the well — a placed object like any other. */
  private atWell(conn: ConnState): boolean {
    return this.stationWithinReach(conn, 'well');
  }

  // -------------------------------------------------------------------------
  // Night roamers (D-527, D-529)
  //
  // They come out at dusk, walk the open ground, and go at dawn. Tuned for
  // ATTRITION rather than lethality: individually beatable, collectively a
  // reason not to be out alone. That is the whole point — if a night errand
  // needs a partner, then your partner may be the antagonist, and the line
  // "I'll come with you, it's dangerous alone" is generated by the monsters
  // rather than by a script.
  //
  // ⚠ They spawn in outdoor WILDERNESS areas only, never the settled town.
  // D-529 left "may roamers enter settled areas" unratified; keeping them out
  // is the choice that preserves the three forces — the town has to remain
  // the refuge night drives people INTO, or night is uniformly lethal and
  // stops being a decision. Flip this if the stakeholder rules otherwise.
  // -------------------------------------------------------------------------

  /** Areas roamers walk: under the sky, and outside the law. */
  private roamerAreas(): string[] {
    return this.world.areaIds().filter((id) => {
      const def = this.world.getAreaDef(id);
      return def.outdoor && def.zone !== 'settled';
    });
  }

  private spawnRoamers(): void {
    if (this.content.roamers.length === 0) return;
    for (const areaId of this.roamerAreas()) {
      const def = this.world.getAreaDef(areaId);
      const players = this.world
        .entitiesIn(areaId)
        .filter((e) => e.characterId !== null && !e.ghost)
        .map((e) => e.pos);
      for (const kind of this.content.roamers) {
        for (let i = 0; i < kind.perArea; i++) {
          const at = this.findRoamerTile(def, players);
          if (!at) continue;
          const { entity } = this.world.spawn(areaId, {
            characterId: null,
            name: kind.descriptor,
            npcDescriptor: kind.descriptor,
            appearanceSeed: this.roamerRng.int(1, 1_000_000),
            pos: at,
            hp: kind.hp,
          });
          this.roamers.set(entity.id, kind);
          this.broadcastPlane(areaId, false, {
            t: 'delta',
            tick: this.world.tick,
            events: [{ type: 'entity_entered', entity: toWireEntity(entity, kind.descriptor) }],
          });
        }
      }
    }
  }

  /** A walkable tile far enough from every player to be fair. */
  private findRoamerTile(
    def: AreaDef,
    players: { x: number; y: number }[],
  ): { x: number; y: number } | null {
    for (let attempt = 0; attempt < 60; attempt++) {
      const at = {
        x: this.roamerRng.int(1, def.width - 2),
        y: this.roamerRng.int(1, def.height - 2),
      };
      if (!isTileWalkable(def, at)) continue;
      // Never materialise on top of somebody: an ambush nobody could have
      // avoided is not danger, it is a coin toss.
      if (players.some((p) => chebyshev(p, at) < ROAMER_SPAWN_CLEARANCE)) continue;
      return at;
    }
    return null;
  }

  private despawnRoamers(): void {
    for (const entityId of [...this.roamers.keys()]) {
      const areaId = this.world.getEntityAreaId(entityId);
      const event = this.world.despawn(entityId);
      if (event && areaId) {
        this.broadcastPlane(areaId, false, { t: 'delta', tick: this.world.tick, events: [event] });
      }
    }
    this.roamers.clear();
    this.roamerHeadings.clear();
  }

  /** Moves and strikes. Called every tick while a round runs. */
  private async roamerTick(): Promise<void> {
    for (const [entityId, kind] of [...this.roamers]) {
      const roamer = this.world.getEntity(entityId);
      const areaId = this.world.getEntityAreaId(entityId);
      if (!roamer || !areaId) {
        this.roamers.delete(entityId);
        continue;
      }
      // Nearest LIVING player. Ghosts are not prey — the dead are not here.
      let quarry: ConnState | null = null;
      let best = Infinity;
      for (const conn of this.connsByArea.get(areaId) ?? []) {
        if (!conn.character || conn.entityId === null || !conn.vitals) continue;
        const target = this.world.getEntity(conn.entityId);
        if (!target || target.ghost || conn.downed) continue;
        const d = chebyshev(roamer.pos, target.pos);
        if (d < best) {
          best = d;
          quarry = conn;
        }
      }
      if (!quarry || best > kind.aggroTiles) {
        // NOTHING IN REACH: wander. Without this they are not roamers at all
        // — they spawn beyond their own aggro radius (deliberately, so nobody
        // is ambushed at the moment night falls) and then stand still until
        // someone walks into them. A player could hold one spot all night
        // untouched, and "night is dangerous" would simply be false.
        this.roamerWander(entityId, kind);
        continue;
      }
      const target = this.world.getEntity(quarry.entityId!)!;
      if (best > 1) {
        if (this.world.tick % kind.moveCooldownTicks !== 0) continue;
        this.world.setMoveIntent(
          entityId,
          directionFrom(Math.sign(target.pos.x - roamer.pos.x), Math.sign(target.pos.y - roamer.pos.y)),
        );
        continue;
      }
      if (this.world.tick < roamer.attackReadyAt) continue;
      roamer.attackReadyAt = this.world.tick + kind.attackCooldownTicks;
      await this.roamerStrike(roamer, kind, quarry, areaId);
    }
  }

  /**
   * Drifts along a heading, changing it now and then. Held for a stretch
   * rather than re-rolled every step, so they cross ground instead of
   * shivering on the spot — and so a player watching from a distance can read
   * which way a thing is going.
   */
  private roamerWander(entityId: number, kind: RoamerDef): void {
    const roamer = this.world.getEntity(entityId);
    if (!roamer) return;
    if (this.world.tick % (kind.moveCooldownTicks * 2) !== 0) return;
    let heading = this.roamerHeadings.get(entityId);
    if (heading === undefined || this.roamerRng.int(0, 7) === 0) {
      heading = this.roamerRng.pick([...DIRECTIONS]);
      this.roamerHeadings.set(entityId, heading);
    }
    this.world.setMoveIntent(entityId, heading);
  }

  private async roamerStrike(
    roamer: WorldEntity,
    kind: RoamerDef,
    victim: ConnState,
    areaId: string,
  ): Promise<void> {
    if (!victim.vitals || victim.entityId === null) return;
    if (this.inGrace) return; // the truce binds the wild things too (D-536)
    const damage = this.roamerRng.int(kind.damageMin, kind.damageMax);
    this.enterCombat(roamer, areaId);
    this.enterCombat(this.world.getEntity(victim.entityId), areaId);
    // Being mauled ends whatever you were doing, exactly as a player's blow
    // does — otherwise gathering through a pack of dogs would be free.
    this.interruptWork(victim, 'something was on you');
    this.broadcastPlane(areaId, false, {
      t: 'delta',
      tick: this.world.tick,
      events: [
        {
          type: 'entity_attacked',
          attackerId: roamer.id,
          targetId: victim.entityId,
          variant: 0,
          damage,
        },
      ],
    });
    // A roamer fight sounds exactly like a murder (D-531), which is what
    // gives the antagonist its deniability at night.
    this.emitCombatNoise(areaId, roamer.pos, [roamer.id, victim.entityId]);
    victim.vitals.hp -= damage;
    this.sendStatus(victim);
    if (victim.vitals.hp <= 0) await this.die(victim, kind.descriptor);
  }

  // -------------------------------------------------------------------------
  // Gathering and crafting (MR2)
  //
  // Both are TIMED and INTERRUPTIBLE, and that is the design rather than a
  // detail: standing still for a known interval is what makes a spoke
  // dangerous and what makes the buddy system worth something. Work is
  // cancelled by moving, by being struck, and by dying.
  // -------------------------------------------------------------------------

  /** Puts every authored node into the world. Called at round start. */
  private spawnNodes(): void {
    for (const areaId of this.world.areaIds()) {
      const def = this.world.getAreaDef(areaId);
      for (const placed of def.nodes) {
        const node = this.content.nodes.get(placed.type);
        if (!node) continue; // the loader already refused unknown types
        const { entity } = this.world.spawn(areaId, {
          characterId: null,
          name: node.descriptor,
          npcDescriptor: node.descriptor,
          objectKind: 'node',
          nodeType: node.id,
          nodeCharges: node.charges,
          pos: { x: placed.x, y: placed.y },
        });
        // Anyone already standing here must be TOLD. Spawning into the world
        // without broadcasting leaves the nodes invisible to every client
        // that snapshotted before the round began — which is all of them,
        // since the round is what spawns them.
        this.broadcastPlane(areaId, false, {
          t: 'delta',
          tick: this.world.tick,
          events: [{ type: 'entity_entered', entity: toWireEntity(entity, node.descriptor) }],
        });
      }
    }
  }

  /** Puts the town's facilities into the world as real objects (D-530). */
  private spawnStations(): void {
    for (const areaId of this.world.areaIds()) {
      for (const placed of this.world.getAreaDef(areaId).stations) {
        const descriptor = STATION_DESCRIPTORS[placed.type] ?? placed.type;
        const { entity } = this.world.spawn(areaId, {
          characterId: null,
          name: descriptor,
          npcDescriptor: descriptor,
          objectKind: 'station',
          stationType: placed.type,
          pos: { x: placed.x, y: placed.y },
        });
        this.broadcastPlane(areaId, false, {
          t: 'delta',
          tick: this.world.tick,
          events: [
            { type: 'entity_entered', entity: toWireEntity(entity, descriptor) },
          ],
        });
      }
    }
  }

  private despawnStations(): void {
    for (const areaId of this.world.areaIds()) {
      for (const e of this.world.entitiesIn(areaId)) {
        if (e.objectKind !== 'station') continue;
        const event = this.world.despawn(e.id);
        if (event) {
          this.broadcastPlane(areaId, false, { t: 'delta', tick: this.world.tick, events: [event] });
        }
      }
    }
  }

  /** Removes every node. Called at round reset, before the next spawn. */
  private despawnNodes(): void {
    for (const areaId of this.world.areaIds()) {
      for (const e of this.world.entitiesIn(areaId)) {
        if (e.objectKind !== 'node') continue;
        const event = this.world.despawn(e.id);
        if (event) {
          this.broadcastPlane(areaId, false, { t: 'delta', tick: this.world.tick, events: [event] });
        }
      }
    }
  }

  /** Refills spent nodes whose timer has come round (within the round). */
  private nodeTick(): void {
    for (const areaId of this.world.areaIds()) {
      for (const e of this.world.entitiesIn(areaId)) {
        if (e.objectKind !== 'node' || e.nodeRefillsAt === null || e.nodeRefillsAt === undefined) {
          continue;
        }
        if (this.world.tick < e.nodeRefillsAt) continue;
        const def = this.content.nodes.get(e.nodeType!);
        e.nodeCharges = def?.charges ?? 1;
        e.nodeRefillsAt = null;
      }
    }
  }

  private async handleHarvest(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'harvest' }>,
  ): Promise<void> {
    if (!conn.character || conn.entityId === null || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const self = this.world.getEntity(conn.entityId);
    if (!self || self.ghost) return this.fail(conn, 'not_dead', 'the dead gather nothing');
    if (conn.work) return this.fail(conn, 'already_working', 'you are busy');
    const target = this.world.getEntity(msg.targetEntityId);
    if (!target || target.objectKind !== 'node') {
      return this.fail(conn, 'bad_target', 'there is nothing to work there');
    }
    if (chebyshev(self.pos, target.pos) > 1) {
      return this.fail(conn, 'not_adjacent', 'too far to reach');
    }
    if ((target.nodeCharges ?? 0) <= 0) {
      return this.fail(conn, 'node_spent', 'there is nothing left in it');
    }
    const def = this.content.nodes.get(target.nodeType!);
    if (!def) return this.fail(conn, 'bad_target', 'there is nothing to work there');
    conn.work = {
      activity: 'harvest',
      what: def.descriptor,
      targetId: target.id,
      startedAtTick: this.world.tick,
      endsAtTick: this.world.tick + Math.round(def.effortTicks * this.hungerWorkMultiplier(conn)),
      at: { ...self.pos },
    };
    this.sendWork(conn, conn.work, 0, false, null);
  }

  private async handleCraft(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'craft' }>,
  ): Promise<void> {
    if (!conn.character || conn.entityId === null || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const self = this.world.getEntity(conn.entityId);
    if (!self || self.ghost) return this.fail(conn, 'not_dead', 'the dead make nothing');
    if (conn.work) return this.fail(conn, 'already_working', 'you are busy');
    const recipe = this.content.recipes.get(msg.recipeId);
    if (!recipe) return this.fail(conn, 'no_such_recipe', 'you do not know that');
    if (recipe.station !== 'anywhere' && !this.atStation(conn, recipe.station)) {
      return this.fail(conn, 'wrong_station', `that needs the ${recipe.station}`);
    }
    // Materials are checked NOW and again on completion. Checking only at the
    // start would let two crafts run off one pile of ore; checking only at the
    // end would waste the worker's time silently.
    if (!(await this.hasMaterials(conn, recipe))) {
      return this.fail(conn, 'missing_materials', 'you do not have what that takes');
    }
    conn.work = {
      activity: 'craft',
      what: recipe.name,
      targetId: recipe.id,
      startedAtTick: this.world.tick,
      endsAtTick: this.world.tick + Math.round(recipe.effortTicks * this.hungerWorkMultiplier(conn)),
      at: { ...self.pos },
    };
    this.sendWork(conn, conn.work, 0, false, null);
  }

  private async hasMaterials(conn: ConnState, recipe: RecipeDef): Promise<boolean> {
    const held = await this.store.getItemsByCharacter(conn.character!.id);
    for (const need of recipe.inputs) {
      const have = held
        .filter((i) => i.templateId === need.item)
        .reduce((n, i) => n + i.qty, 0);
      if (have < need.quantity) return false;
    }
    return true;
  }

  /**
   * Whether the player stands at a given station. For now a station is the
   * town itself: the buildings are authored geometry with no identity of
   * their own yet, so this is deliberately coarse and honest about it.
   * ⚠ MR3 should make stations real placed objects — until then "the
   * workshop" means "in Ashfold".
   */
  private atStation(conn: ConnState, station: string): boolean {
    return this.stationWithinReach(conn, station);
  }

  /**
   * Whether the player stands beside a facility of this type. Stations are
   * real placed objects now, so "needs the workshop" means a specific anvil
   * in a specific building rather than "you are somewhere in the town" —
   * which is what lets the antagonist stand next to one, or spoil it.
   */
  private stationWithinReach(conn: ConnState, station: string): boolean {
    if (conn.entityId === null || !conn.areaId) return false;
    const self = this.world.getEntity(conn.entityId);
    if (!self) return false;
    return this.world
      .entitiesIn(conn.areaId)
      .some(
        (e) =>
          e.objectKind === 'station' &&
          e.stationType === station &&
          chebyshev(e.pos, self.pos) <= STATION_REACH_TILES,
      );
  }

  /**
   * Reports on a job. The activity and subject are passed IN rather than read
   * from `conn.work`, because completion clears the slot first — reading it
   * there reported every finished craft as a harvest of nothing.
   */
  private sendWork(
    conn: ConnState,
    job: { activity: 'harvest' | 'craft'; what: string },
    progress: number,
    done: boolean,
    interrupted: string | null,
  ): void {
    this.send(conn, {
      t: 'work',
      activity: job.activity,
      what: job.what,
      progress,
      done,
      interrupted,
    });
  }

  /** Cancels work in progress, telling the worker why. */
  private interruptWork(conn: ConnState, why: string): void {
    if (!conn.work) return;
    this.sendWork(conn, conn.work, 0, true, why);
    conn.work = null;
  }

  /** Advances every occupied connection; call once per tick. */
  private async workTick(): Promise<void> {
    for (const conn of [...this.conns]) {
      const work = conn.work;
      if (!work || !conn.character || conn.entityId === null) continue;
      const self = this.world.getEntity(conn.entityId);
      if (!self || self.ghost) {
        this.interruptWork(conn, 'you died');
        continue;
      }
      // Moving abandons the work. Checked by POSITION rather than by intent so
      // that any cause of movement — being carried, a transition — counts.
      if (self.pos.x !== work.at.x || self.pos.y !== work.at.y) {
        this.interruptWork(conn, 'you moved');
        continue;
      }
      if (this.world.tick < work.endsAtTick) {
        // A progress ping about twice a second; the client draws the bar.
        if (this.world.tick % 5 === 0) {
          const span = work.endsAtTick - work.startedAtTick;
          this.sendWork(conn, work, Math.min(1, (this.world.tick - work.startedAtTick) / span), false, null);
        }
        continue;
      }
      conn.work = null;
      if (work.activity === 'harvest') await this.finishHarvest(conn, work, work.targetId as number);
      else await this.finishCraft(conn, work, work.targetId as string);
    }
  }

  private async finishHarvest(
    conn: ConnState,
    job: { activity: 'harvest' | 'craft'; what: string },
    nodeEntityId: number,
  ): Promise<void> {
    const node = this.world.getEntity(nodeEntityId);
    if (!node || node.objectKind !== 'node' || (node.nodeCharges ?? 0) <= 0) {
      this.sendWork(conn, job, 1, true, 'there was nothing left in it');
      return;
    }
    const def = this.content.nodes.get(node.nodeType!);
    if (!def) return;
    node.nodeCharges = (node.nodeCharges ?? 1) - 1;
    if (node.nodeCharges <= 0) node.nodeRefillsAt = this.world.tick + def.respawnTicks;
    await this.store.grantItem(conn.character!.id, def.yields, def.quantity);
    // Night pays half again for what is won outdoors (D-528) — gainXp applies
    // the multiplier, so gathering inherits it without knowing about it.
    this.gainXp(conn, 4);
    this.countDeed(conn);
    await this.store.appendEvent('harvest', {
      characterId: conn.character!.id,
      node: def.id,
      yielded: def.yields,
      areaId: conn.areaId,
    });
    this.sendWork(conn, job, 1, true, null);
    await this.sendInventory(conn);
    this.sendStatus(conn);
  }

  private async finishCraft(
    conn: ConnState,
    job: { activity: 'harvest' | 'craft'; what: string },
    recipeId: string,
  ): Promise<void> {
    const recipe = this.content.recipes.get(recipeId);
    if (!recipe) return;
    // Re-checked on completion: the materials may have been given away, spent
    // on another craft, or looted off a corpse while this one was working.
    if (!(await this.hasMaterials(conn, recipe))) {
      this.sendWork(conn, job, 1, true, 'the materials were gone when you reached for them');
      return;
    }
    for (const need of recipe.inputs) {
      for (let i = 0; i < need.quantity; i++) {
        await this.store.consumeOneItem(conn.character!.id, need.item);
      }
    }
    await this.store.grantItem(conn.character!.id, recipe.output, recipe.outputQuantity);
    this.gainXp(conn, 6);
    this.countDeed(conn, 2);
    await this.store.appendEvent('craft', {
      characterId: conn.character!.id,
      recipe: recipe.id,
      output: recipe.output,
      areaId: conn.areaId,
    });
    this.sendWork(conn, job, 1, true, null);
    await this.sendInventory(conn);
    this.sendStatus(conn);
  }

  /** A death the round cares about. No respawn, so this is terminal. */
  private noteRoundDeath(characterId: string): void {
    if (!this.roundRunning) return;
    this.roundDead.add(characterId);
    this.round!.noteCharacterDeath(characterId);
  }

  // -------------------------------------------------------------------------
  // Combat state (stakeholder, 2026-08-18)
  //
  // Entered on violence — an attack either way, or a declaration of hostility
  // either way — and left only when nothing threatening has happened for
  // COMBAT_LEAVE_TICKS *and* no hostile stands within COMBAT_PROXIMITY_TILES.
  // The state is what makes weapons go away: out of combat a character
  // sheathes and returns to a true idle.
  // -------------------------------------------------------------------------

  /** Marks an entity as fighting and refreshes its cooldown. */
  private enterCombat(entity: WorldEntity | undefined, areaId: string | null): void {
    if (!entity || !areaId || entity.ghost) return;
    entity.combatHotUntil = this.world.tick + this.combatLeaveTicks;
    if (entity.combat) return;
    entity.combat = true;
    this.broadcastPlane(areaId, entity.ghost, {
      t: 'delta',
      tick: this.world.tick,
      events: [{ type: 'entity_combat', id: entity.id, inCombat: true }],
    });
  }

  /** Is this entity someone `self` is currently at odds with? */
  private isHostileTo(self: WorldEntity, other: WorldEntity): boolean {
    if (other.id === self.id || other.ghost) return false;
    if (other.objectKind === 'corpse' || other.objectKind === 'pile') return false;
    // A walking corpse is always a threat; so is anything mid-fight with us.
    if (other.objectKind === 'zombie') return true;
    if (self.characterId === null || other.characterId === null) {
      // NPC involvement: treat any other combatant as the reason to stay up.
      return other.combat;
    }
    const a = this.hostilities.get(`${self.characterId}|${other.characterId}`);
    const b = this.hostilities.get(`${other.characterId}|${self.characterId}`);
    const fresh = (t: number | undefined): boolean =>
      t !== undefined && this.world.tick - t <= HOSTILITY_EXPIRY_TICKS;
    return fresh(a) || fresh(b);
  }

  /** Drops combat for anyone who has been left alone long enough. */
  private combatTick(): void {
    for (const areaId of this.world.areaIds()) {
      const entities = this.world.entitiesIn(areaId);
      for (const entity of entities) {
        if (!entity.combat) continue;
        if (this.world.tick < entity.combatHotUntil) continue;
        const threatened = entities.some(
          (other) =>
            this.isHostileTo(entity, other) &&
            chebyshev(entity.pos, other.pos) <= this.combatProximityTiles,
        );
        if (threatened) continue;
        entity.combat = false;
        this.broadcastPlane(areaId, entity.ghost, {
          t: 'delta',
          tick: this.world.tick,
          events: [{ type: 'entity_combat', id: entity.id, inCombat: false }],
        });
      }
    }
  }

  /** Carried bodies travel with whoever shoulders them. */
  private carryTick(): void {
    for (const areaId of this.world.areaIds()) {
      for (const entity of this.world.entitiesIn(areaId)) {
        if (entity.carriedBy === null) continue;
        const carrier = this.world.getEntity(entity.carriedBy);
        if (!carrier || this.world.getEntityAreaId(carrier.id) !== areaId || carrier.ghost) {
          // The carrier vanished (logged out, died, changed area): the body
          // stays where it is rather than following into nothing.
          this.setCarried(entity, null, areaId);
          continue;
        }
        if (entity.pos.x === carrier.pos.x && entity.pos.y === carrier.pos.y) continue;
        entity.pos = { ...carrier.pos };
        entity.facing = carrier.facing;
        this.broadcastPlane(areaId, false, {
          t: 'delta',
          tick: this.world.tick,
          events: [{
            type: 'entity_moved',
            id: entity.id,
            x: entity.pos.x,
            y: entity.pos.y,
            facing: entity.facing,
          }],
        });
      }
    }
  }

  private setCarried(body: WorldEntity, carrierId: number | null, areaId: string): void {
    body.carriedBy = carrierId;
    this.broadcastPlane(areaId, false, {
      t: 'delta',
      tick: this.world.tick,
      events: [{ type: 'entity_carried', id: body.id, carrierId }],
    });
  }

  /**
   * The unmissable warning (D-206): the first step onto a way-marker into an
   * endgame area does NOT cross — it warns. Stepping off and back on within
   * the window confirms. Ghosts pass freely; they have nothing left to lose.
   */
  /**
   * The dungeon's stairs (D-535). Two gates, both narrated rather than
   * silent — a stair that simply does nothing reads as a bug, and players
   * need to know a way exists before it opens in order to plan around it.
   *
   *   1. **Floors open on successive round-days.** The dungeon deepens
   *      instead of reshaping, so nothing ever changes under someone's feet.
   *   2. **The entrance seals between dusk and dawn.** The dungeon is the
   *      one place roamers cannot reach; leaving it open would make diving
   *      the correct way to earn through the night without taking night's
   *      risk. Movement between floors already reached stays open, so being
   *      caught below is frightening rather than merely idle.
   */
  private dungeonGateAllows(conn: ConnState, fromArea: string, toArea: string): boolean {
    if (!this.roundRunning || !this.world.hasArea(toArea)) return true;
    // Nobody slips away during the truce (D-536). Leaving mid-conversation
    // would let the antagonist skip the one moment it must answer questions.
    if (this.inGrace) {
      this.send(conn, {
        t: 'narrate',
        text: 'Not yet. Nobody is going anywhere until the day starts.',
      });
      return false;
    }
    const to = this.world.getAreaDef(toArea);
    const from = this.world.getAreaDef(fromArea);
    const offset = this.roundTickOffset();

    // Crossing the threshold in either direction, at night: shut.
    const crossingEntrance =
      (to.dungeonFloor !== undefined) !== (from.dungeonFloor !== undefined);
    if (crossingEntrance && !dungeonEntranceOpen(offset, this.roundDayTicks)) {
      this.send(conn, {
        t: 'narrate',
        text: to.dungeonFloor !== undefined
          ? 'The shaft breathes cold and will not take you. Whatever opens it does so at dawn.'
          : 'The way up has closed against the dark. You are down here until morning.',
      });
      return false;
    }

    // Descending to a floor that has not opened yet.
    if (to.dungeonFloor !== undefined && !dungeonFloorOpen(to.dungeonFloor, offset, this.roundDayTicks)) {
      this.send(conn, {
        t: 'narrate',
        text: 'The stair below is choked with fallen rock. It shifts, a little, each dawn.',
      });
      return false;
    }
    return true;
  }

  private confirmEndgameEntry(
    conn: ConnState,
    areaId: string,
    x: number,
    y: number,
    toArea: string,
  ): boolean {
    const targetDef = this.world.hasArea(toArea) ? this.world.getAreaDef(toArea) : null;
    if (targetDef?.zone !== 'endgame') return true;
    if (conn.entityId !== null && this.world.getEntity(conn.entityId)?.ghost) return true;
    const pending = this.endgameConfirms.get(conn);
    if (
      pending && pending.areaId === areaId && pending.x === x && pending.y === y &&
      this.world.tick < pending.expiresAtTick
    ) {
      this.endgameConfirms.delete(conn);
      return true;
    }
    this.endgameConfirms.set(conn, {
      areaId,
      x,
      y,
      expiresAtTick: this.world.tick + ENDGAME_CONFIRM_TICKS,
    });
    this.send(conn, {
      t: 'narrate',
      text:
        `⚠ Beyond lies ${targetDef.name} — a place of FINAL DEATH. ` +
        'Fall there unaided and your story ENDS: no ghost, no respawn, no return. ' +
        'Step off the marker and step on again if you truly mean to enter.',
    });
    return false;
  }

  private eventFromGhost(event: { type: string } & Record<string, unknown>): boolean {
    const id =
      event.type === 'entity_entered'
        ? (event.entity as { id: number }).id
        : (event.id as number | undefined) ?? (event.attackerId as number | undefined);
    if (id === undefined) return false;
    return this.world.getEntity(id)?.ghost ?? false;
  }

  private broadcastPlane(areaId: string, ghost: boolean, msg: ServerMessage, except?: ConnState): void {
    const payload = JSON.stringify(msg);
    for (const conn of this.connsByArea.get(areaId) ?? []) {
      if (conn === except || conn.entityId === null) continue;
      const entity = this.world.getEntity(conn.entityId);
      if (!entity || entity.ghost !== ghost) continue;
      if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(payload);
    }
  }

  /** Untreated major wounds bleed (D-205) — the physician-shaped pressure. */
  private async bleedTick(): Promise<void> {
    for (const conn of this.conns) {
      if (!conn.character || !conn.vitals || conn.entityId === null) continue;
      const entity = this.world.getEntity(conn.entityId);
      if (!entity || entity.ghost) continue;
      const majors = conn.injuries.filter((i) => i.severity === 'major').length;
      if (majors === 0) continue;
      conn.vitals.hp -= majors;
      this.sendStatus(conn);
      if (conn.vitals.hp <= 0) await this.die(conn, 'their wounds');
    }
  }

  /** Moves a player between areas: despawn, respawn, fresh snapshot (D-103). */
  private async transferToArea(
    conn: ConnState,
    toAreaId: string,
    x: number,
    y: number,
  ): Promise<void> {
    if (!conn.character || conn.entityId === null || !conn.areaId) return;
    if (!this.world.hasArea(toAreaId)) {
      this.log(`transition to unknown area '${toAreaId}' ignored`);
      return;
    }
    const oldAreaId = conn.areaId;
    const oldEntity = this.world.getEntity(conn.entityId)!;
    const leftEvent = this.world.despawn(conn.entityId);
    this.entityCharacter.delete(conn.entityId);
    this.connsByArea.get(oldAreaId)?.delete(conn);
    if (leftEvent) {
      this.broadcastPlane(oldAreaId, oldEntity.ghost, { t: 'delta', tick: this.world.tick, events: [leftEvent] });
    }
    const { entity } = this.world.spawn(toAreaId, {
      characterId: conn.character.id,
      name: conn.character.name,
      appearanceSeed: conn.character.appearanceSeed,
      pos: { x, y },
      facing: oldEntity.facing,
      ghost: oldEntity.ghost, // the grey country has the same doors
    });
    entity.presentation = oldEntity.presentation; // the hood survives the door
    conn.entityId = entity.id;
    conn.areaId = toAreaId;
    this.entityCharacter.set(entity.id, conn.character.id);
    for (const other of this.connsByArea.get(toAreaId) ?? []) {
      if (!other.character || other.entityId === null) continue;
      if (this.world.getEntity(other.entityId)?.ghost !== entity.ghost) continue;
      const descriptor = await this.descriptorFor(other, entity);
      this.send(other, {
        t: 'delta',
        tick: this.world.tick,
        events: [{ type: 'entity_entered', entity: toWireEntity(entity, descriptor) }],
      });
    }
    let byArea = this.connsByArea.get(toAreaId);
    if (!byArea) this.connsByArea.set(toAreaId, (byArea = new Set()));
    byArea.add(conn);
    this.dirtyCharacters.set(conn.character.id, {
      areaId: toAreaId,
      x: entity.pos.x,
      y: entity.pos.y,
    });
    this.countDeed(conn);
    await this.store.appendEvent('area_transition', {
      characterId: conn.character.id,
      from: oldAreaId,
      to: toAreaId,
    });
    await this.sendSnapshot(conn);
    this.onAreaEnter?.(toAreaId, entity.id);
  }

  private async flushDirty(): Promise<void> {
    const batch = [...this.dirtyCharacters];
    this.dirtyCharacters.clear();
    for (const [characterId, pos] of batch) {
      try {
        await this.store.saveCharacterPosition(characterId, pos.areaId, pos.x, pos.y);
      } catch (err) {
        // Re-mark dirty so the next flush retries rather than losing the write.
        this.dirtyCharacters.set(characterId, pos);
        this.log(`flush failed for ${characterId}: ${(err as Error).message}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    const conn: ConnState = {
      ws,
      accountId: null,
      character: null,
      entityId: null,
      areaId: null,
      vitals: null,
      injuries: [],
      downed: null,
      work: null,
      needs: {
        hunger: 'sated',
        thirst: 'sated',
        hungerAtHour: 0,
        thirstAtHour: 0,
        starvedAtHour: 0,
      },
      queue: Promise.resolve(),
    };
    this.conns.add(conn);
    ws.on('message', (raw) => {
      conn.queue = conn.queue.then(() => this.onMessage(conn, raw.toString()).catch((err) => {
        this.log(`handler error: ${(err as Error).stack}`);
        this.send(conn, { t: 'error', code: 'internal', message: 'internal error' });
      }));
    });
    ws.on('close', () => {
      conn.queue = conn.queue.then(() => this.handleDisconnect(conn));
    });
    ws.on('error', () => ws.close());
  }

  private async onMessage(conn: ConnState, raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.fail(conn, 'invalid_message', 'not valid JSON');
      return;
    }
    const msg = parseClientMessage(json);
    if (!msg) {
      this.fail(conn, 'invalid_message', 'message failed schema validation');
      return;
    }
    // Downed in an endgame zone (D-206): you may speak — last words matter —
    // but you cannot act, and you cannot retire your way out of the price.
    if (
      conn.downed &&
      ['move', 'attack', 'hostile', 'treat', 'loot', 'speak_dead', 'animate_dead',
        'give', 'pay', 'write', 'respawn', 'retire', 'revive'].includes(msg.t)
    ) {
      return this.fail(conn, 'dead', 'you are bleeding out — only another hand can save you');
    }
    switch (msg.t) {
      case 'register':
        return this.handleRegister(conn, msg);
      case 'login':
        return this.handleLogin(conn, msg);
      case 'resume':
        return this.handleResume(conn, msg);
      case 'create_character':
        return this.handleCreateCharacter(conn, msg);
      case 'get_creation_content':
        return this.handleGetCreationContent(conn);
      case 'enter_world':
        return this.handleEnterWorld(conn, msg);
      case 'move':
        return this.handleMove(conn, msg);
      case 'say':
        return this.handleSay(conn, msg);
      case 'set_presentation':
        return this.handleSetPresentation(conn, msg);
      case 'write':
        return this.handleWrite(conn, msg);
      case 'read_item':
        return this.handleReadItem(conn, msg);
      case 'give':
        return this.handleGive(conn, msg);
      case 'pay':
        return this.handlePay(conn, msg);
      case 'hostile':
        return this.handleHostile(conn, msg);
      case 'attack':
        return this.handleAttack(conn, msg);
      case 'harvest':
        return this.handleHarvest(conn, msg);
      case 'craft':
        return this.handleCraft(conn, msg);
      case 'eat':
        return this.handleEat(conn, msg);
      case 'drink':
        return this.handleDrink(conn);
      case 'cancel_work':
        this.interruptWork(conn, 'you stopped');
        return;
      case 'treat':
        return this.handleTreat(conn, msg);
      case 'respawn':
        return this.handleRespawn(conn);
      case 'retire':
        return this.handleRetire(conn);
      case 'loot':
        return this.handleLoot(conn, msg);
      case 'speak_dead':
        return this.handleSpeakDead(conn, msg);
      case 'animate_dead':
        return this.handleAnimateDead(conn, msg);
      case 'observe_body':
        return this.handleObserveBody(conn, msg);
      case 'revive':
        return this.handleRevive(conn, msg);
      case 'carry_body':
        return this.handleCarryBody(conn, msg);
      case 'drop_body':
        return this.handleDropBody(conn);
      case 'resync':
        return this.handleResync(conn);
      case 'ping':
        this.send(conn, { t: 'pong', nonce: msg.nonce, tick: this.world.tick });
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Combat, death, and treatment (D-104, D-203, D-205, D-206)
  // -------------------------------------------------------------------------

  private sendStatus(conn: ConnState): void {
    if (!conn.vitals || conn.entityId === null) return;
    const entity = this.world.getEntity(conn.entityId);
    this.send(conn, {
      t: 'status',
      hp: conn.vitals.hp,
      maxHp: conn.vitals.maxHp,
      xp: conn.vitals.xp,
      deathDebt: conn.vitals.deathDebt,
      ghost: entity?.ghost ?? false,
      hunger: conn.needs.hunger,
      thirst: conn.needs.thirst,
      injuries: conn.injuries.map((i) => ({
        id: i.id,
        location: i.location,
        kind: i.kind,
        severity: i.severity,
      })),
    });
  }

  /** XP pays down death debt before it advances the character (D-203). */
  /**
   * Where and when this connection is earning — the two facts the night
   * bonus turns on (D-528). Outside a round there is no bonus at all.
   */
  private rewardContext(conn: ConnState): { outdoor: boolean; night: boolean } {
    if (!this.roundRunning || !conn.areaId || !this.world.hasArea(conn.areaId)) {
      return { outdoor: false, night: false };
    }
    return {
      outdoor: this.world.getAreaDef(conn.areaId).outdoor,
      night: isNight(this.roundTickOffset(), this.roundDayTicks),
    };
  }

  private gainXp(conn: ConnState, rawAmount: number): void {
    if (!conn.vitals) return;
    // Applied here rather than at each grant site so every reward path picks
    // it up — including MR2's gathering and crafting, which do not exist yet.
    const amount = applyNightBonus(rawAmount, this.rewardContext(conn));
    // Inside a round, earnings go to a pot that is banked only if you live to
    // the end (D-524). There is no death debt to pay down in a round, so the
    // debt path is skipped entirely rather than being paid from the pot.
    if (this.roundRunning) {
      this.roundXp.set(conn, (this.roundXp.get(conn) ?? 0) + amount);
      return;
    }
    const paid = Math.min(conn.vitals.deathDebt, amount);
    conn.vitals.deathDebt -= paid;
    conn.vitals.xp += amount - paid;
  }

  /**
   * Declared hostility (D-206): the intent is spoken aloud through the real
   * speech pipeline and logged verbatim; the attack window opens only after
   * the wait — space for roleplay, or for running.
   */
  private async handleHostile(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'hostile' }>,
  ): Promise<void> {
    if (conn.entityId === null || !conn.character || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const self = this.world.getEntity(conn.entityId)!;
    if (self.ghost) return this.fail(conn, 'dead', 'the dead declare nothing');
    const target = this.world.getEntity(msg.targetEntityId);
    if (!target || target.characterId === null || target.characterId === conn.character.id ||
        this.world.getEntityAreaId(target.id) !== conn.areaId || target.ghost) {
      return this.fail(conn, 'bad_target', 'no such quarry');
    }
    this.hostilities.set(`${conn.character.id}|${target.characterId}`, this.world.tick);
    // Declaring puts BOTH parties on their guard — the threatened one has
    // every reason to draw (D-206's warning window is for exactly this).
    this.enterCombat(self, conn.areaId);
    this.enterCombat(target, conn.areaId);
    await this.deliverSpeech({
      speaker: self,
      areaId: conn.areaId,
      speakerConn: conn,
      channel: 'say',
      text: msg.text,
      languageId: 'common',
    });
    await this.store.appendEvent('hostility_declared', {
      attacker: conn.character.id,
      target: target.characterId,
      areaId: conn.areaId,
      text: msg.text,
    });
  }

  private async handleAttack(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'attack' }>,
  ): Promise<void> {
    if (conn.entityId === null || !conn.character || !conn.areaId || !conn.vitals) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const self = this.world.getEntity(conn.entityId)!;
    if (self.ghost) return this.fail(conn, 'dead', 'the dead cannot fight');
    const target = this.world.getEntity(msg.targetEntityId);
    if (!target || target.id === self.id || target.ghost ||
        this.world.getEntityAreaId(target.id) !== conn.areaId) {
      return this.fail(conn, 'bad_target', 'no such target');
    }
    if (this.corpsesByEntity.has(target.id)) {
      // Lying corpses and dropped gear are not combatants. Zombies are.
      return this.fail(conn, 'bad_target', 'it is already dead');
    }
    if (chebyshev(self.pos, target.pos) > ATTACK_RANGE) {
      return this.fail(conn, 'not_adjacent', 'out of reach');
    }
    if (this.world.tick < self.attackReadyAt) {
      return this.fail(conn, 'on_cooldown', 'not ready');
    }
    // The dawn truce is total (D-536): nobody strikes, so nobody has to
    // watch their back while the cast is deciding what to do with the day.
    if (this.inGrace) {
      return this.fail(conn, 'grace_window', 'not now — the day has not started');
    }
    // Zone rules (D-206): NPCs are fair game; players are protected in
    // settled zones unless hostility was declared and the window has passed.
    //
    // NOT IN A ROUND (D-531). A twenty-five minute scenario cannot afford a
    // ten-second spoken warning: it does not make murder risky, it makes it
    // impossible, and a settled town would leave the antagonist nothing to do
    // at the one place everybody is. In a round violence is free — and loud.
    // The restraint is informational rather than procedural: the swing is
    // heard by everyone nearby, so distance from witnesses, not a zone rule,
    // is what decides whether a killing goes unnoticed.
    if (target.characterId !== null && !this.roundRunning) {
      const zone = this.world.getAreaDef(conn.areaId).zone;
      if (zone === 'settled') {
        const declaredAt = this.hostilities.get(`${conn.character.id}|${target.characterId}`);
        const age = declaredAt === undefined ? -1 : this.world.tick - declaredAt;
        if (age < this.hostilityWindowTicks || age > HOSTILITY_EXPIRY_TICKS) {
          return this.fail(conn, 'not_hostile', 'declare your hostility and wait out the warning');
        }
      }
    }

    self.attackReadyAt = this.world.tick + this.attackCooldownTicks;
    const damage = this.contestRng.int(2, 6);
    // The swing is chosen here, not on each client: a cosmetic disagreement
    // would still be a disagreement about the thing players are watching.
    const variant = this.contestRng.int(0, ATTACK_VARIANTS - 1);
    this.enterCombat(self, conn.areaId);
    this.enterCombat(target, conn.areaId);
    // A blow ends whatever the victim was doing. This is what makes standing
    // still to gather a real risk rather than a timer (MR2).
    const struck = [...(this.connsByArea.get(conn.areaId) ?? [])].find(
      (c) => c.entityId === target.id,
    );
    if (struck) this.interruptWork(struck, 'you were struck');
    // The blow is heard, not the intent to strike (D-531). This belongs to
    // the SWING, not to the hostility declaration — a declaration is speech
    // and already travels through the speech pipeline.
    this.emitCombatNoise(conn.areaId, self.pos, [self.id, target.id]);
    this.broadcastPlane(conn.areaId, false, {
      t: 'delta',
      tick: this.world.tick,
      events: [{
        type: 'entity_attacked',
        attackerId: self.id,
        targetId: target.id,
        damage,
        variant,
      }],
    });

    if (target.characterId === null) {
      target.hp -= damage;
      if (target.hp <= 0) {
        const targetId = target.id;
        const lastPos = { ...target.pos };
        this.broadcastPlane(conn.areaId, false, {
          t: 'delta',
          tick: this.world.tick,
          events: [{ type: 'entity_died', id: targetId }],
        });
        // The round watches NPC deaths by public descriptor - this is how a
        // 'kill the keeper' objective resolves (D-526).
        if (this.roundRunning && target.npcDescriptor) {
          this.round!.noteNpcDeath(target.npcDescriptor);
        }
        this.world.despawn(targetId);
        this.gainXp(conn, 10);
        this.sendStatus(conn);
        const zombieInfo = this.zombies.get(targetId);
        if (zombieInfo) {
          await this.zombieDestroyed(targetId, zombieInfo, conn.areaId, lastPos, conn.character.id);
        }
        await this.store.appendEvent('npc_death', {
          entityId: targetId,
          killer: conn.character.id,
          areaId: conn.areaId,
        });
        this.onEntityDeath?.(targetId);
      }
      return;
    }

    const targetConn = [...(this.connsByArea.get(conn.areaId) ?? [])].find(
      (c) => c.entityId === target.id,
    );
    if (!targetConn?.vitals) return;
    targetConn.vitals.hp -= damage;
    // Wounds land where the dice say (D-205); heavy hits maim.
    const injuryChance = damage >= 5 ? 0.5 : 0.25;
    if (this.contestRng.float() < injuryChance) {
      const injury = await this.store.addInjury({
        characterId: targetConn.character!.id,
        location: this.contestRng.pick(['head', 'torso', 'arms', 'legs'] as const),
        kind: this.contestRng.pick(['cut', 'pierce', 'blunt'] as const),
        severity: damage >= 5 ? 'major' : 'minor',
      });
      targetConn.injuries.push(injury);
    }
    this.sendStatus(targetConn);
    if (targetConn.vitals.hp <= 0) {
      // NO REWARD FOR KILLING A PLAYER IN A ROUND (D-522). The persistent
      // world pays for a kill; a round must not, at any layer. At a cast of
      // three to eight, xp-for-player-kills is xp-for-lynching — it pays the
      // cast to execute whoever they suspect, which is precisely the
      // mechanical reward for accusation that D-303 forbids and that D-521
      // restated as a rule the Round may not break. Deeds are suppressed for
      // the same reason: they feed Legacy (D-510), so paying them here would
      // reinstate the same incentive one layer up, at account level.
      if (!this.roundRunning) {
        this.gainXp(conn, 25);
        this.countDeed(conn, 5);
      }
      this.sendStatus(conn);
      await this.die(targetConn, conn.character.name);
    }
  }

  /**
   * A body stays behind (D-224/D-511). Outside settled ground, everything
   * carried moves onto it — ownership and all; the player will wake with
   * nothing. In settled zones the corpse is a shape, not a container.
   */
  private async createCorpseObject(
    conn: ConnState,
    src: { pos: { x: number; y: number }; facing: Direction; presentation: WorldEntity['presentation']; appearanceSeed: number },
  ): Promise<WorldEntity> {
    const zone = this.world.getAreaDef(conn.areaId!).zone;
    const corpseRec = await this.store.createCorpse({
      characterId: conn.character!.id,
      areaId: conn.areaId!,
      x: src.pos.x,
      y: src.pos.y,
      state: 'corpse',
      ticksLeft: this.corpseDecayTicks,
    });
    let gearMoved = 0;
    if (zone !== 'settled') {
      gearMoved = await this.store.moveItemsToCorpse(conn.character!.id, corpseRec.id);
    }
    const { entity: corpse } = this.world.spawn(conn.areaId!, {
      characterId: null,
      name: `the corpse of ${conn.character!.name}`,
      objectKind: 'corpse',
      corpseOfCharacterId: conn.character!.id,
      appearanceSeed: src.appearanceSeed,
      pos: src.pos,
      facing: src.facing,
    });
    corpse.presentation = src.presentation; // died hooded, lies hooded
    this.corpsesByEntity.set(corpse.id, {
      corpseId: corpseRec.id,
      characterId: conn.character!.id,
      state: 'corpse',
      expiresAtTick: this.world.tick + this.corpseDecayTicks,
    });
    await this.store.appendEvent('corpse_created', {
      corpseId: corpseRec.id,
      characterId: conn.character!.id,
      areaId: conn.areaId,
      x: src.pos.x,
      y: src.pos.y,
      zone,
      gearMoved,
    });
    return corpse;
  }

  /** The living see what remains, each under the name they knew (or didn't). */
  private async announceCorpse(corpse: WorldEntity, areaId: string, except?: ConnState): Promise<void> {
    for (const other of this.connsByArea.get(areaId) ?? []) {
      if (other === except || !other.character || other.entityId === null) continue;
      if (this.world.getEntity(other.entityId)?.ghost !== false) continue;
      this.send(other, {
        t: 'delta',
        tick: this.world.tick,
        events: [{ type: 'entity_entered', entity: toWireEntity(corpse, await this.descriptorFor(other, corpse)) }],
      });
    }
  }

  /** Death (D-203): the visible fall for the living; a quiet second world
   * for the ghost. Debt goes on the books immediately. In endgame zones the
   * fall is not yet death — it opens the revival window instead (D-206). */
  private async die(conn: ConnState, cause: string): Promise<void> {
    if (!conn.character || !conn.vitals || conn.entityId === null || !conn.areaId) return;
    if (this.world.getAreaDef(conn.areaId).zone === 'endgame') {
      // First fall opens the revival window; a blow landed while down is an
      // execution — the window slams shut.
      if (conn.downed) return this.finalizeEndgameDeath(conn, cause);
      return this.becomeDowned(conn, cause);
    }
    const entity = this.world.getEntity(conn.entityId)!;
    conn.vitals.hp = 0;
    // A round has no death debt and no respawn: you are dead until revived or
    // until the round ends, and what it costs you is the round's earnings
    // (D-521, D-524). Debt belongs to the persistent world's walk-it-off loop.
    if (!this.roundRunning) conn.vitals.deathDebt += DEATH_DEBT_PER_DEATH;
    else this.noteRoundDeath(conn.character.id);
    entity.ghost = true;
    entity.intent = null;
    entity.diedAtTick = this.world.tick;
    for (const key of [...this.hostilities.keys()]) {
      if (key.includes(conn.character.id)) this.hostilities.delete(key);
    }
    this.endSeanceInvolving(conn, 'death');
    const corpse = await this.createCorpseObject(conn, {
      pos: { ...entity.pos },
      facing: entity.facing,
      presentation: entity.presentation,
      appearanceSeed: entity.appearanceSeed,
    });
    // The living watch them fall and see them no more.
    this.broadcastPlane(conn.areaId, false, {
      t: 'delta',
      tick: this.world.tick,
      events: [{ type: 'entity_died', id: entity.id }],
    }, conn);
    await this.announceCorpse(corpse, conn.areaId, conn);
    // Ghosts already present greet a new arrival to their plane.
    for (const other of this.connsByArea.get(conn.areaId) ?? []) {
      if (other === conn || !other.character || other.entityId === null) continue;
      if (!this.world.getEntity(other.entityId)?.ghost) continue;
      const descriptor = await this.descriptorFor(other, entity);
      this.send(other, {
        t: 'delta',
        tick: this.world.tick,
        events: [{ type: 'entity_entered', entity: toWireEntity(entity, descriptor) }],
      });
    }
    await this.store.saveCharacterVitals(conn.character.id, {
      hp: 0,
      deathDebt: conn.vitals.deathDebt,
    });
    await this.store.appendEvent('death', {
      characterId: conn.character.id,
      areaId: conn.areaId,
      cause,
    });
    await this.sendSnapshot(conn); // the ghost's world: only other ghosts
    this.sendStatus(conn);
    this.onEntityDeath?.(entity.id);
  }

  /**
   * The endgame fall (D-206): hp 0, no ghost, no debt — a body on the floor
   * that another player can still pull back within the window. Speech works;
   * everything else is locked, retirement included (no buying your way out).
   */
  private async becomeDowned(conn: ConnState, cause: string): Promise<void> {
    if (!conn.character || !conn.vitals || conn.entityId === null || !conn.areaId) return;
    const entity = this.world.getEntity(conn.entityId)!;
    conn.vitals.hp = 0;
    conn.downed = { expiresAtTick: this.world.tick + this.reviveWindowTicks };
    entity.intent = null;
    entity.posture = 'kneeling';
    for (const key of [...this.hostilities.keys()]) {
      if (key.includes(conn.character.id)) this.hostilities.delete(key);
    }
    this.broadcastPlane(conn.areaId, false, {
      t: 'delta',
      tick: this.world.tick,
      events: [{ type: 'entity_emote', id: entity.id, posture: 'kneeling', transients: [] }],
    });
    for (const other of this.connsByArea.get(conn.areaId) ?? []) {
      if (other === conn || !other.character || other.entityId === null) continue;
      if (this.world.getEntity(other.entityId)?.ghost !== false) continue;
      this.send(other, {
        t: 'narrate',
        text: `${await this.descriptorFor(other, entity)} crumples, bleeding out. They can still be saved — briefly.`,
      });
    }
    this.send(conn, {
      t: 'narrate',
      text: 'You are bleeding out. In this place there is no grey country waiting — only a hand, or the end.',
    });
    this.sendStatus(conn);
    await this.store.saveCharacterVitals(conn.character.id, { hp: 0 });
    await this.store.appendEvent('downed', {
      characterId: conn.character.id,
      areaId: conn.areaId,
      cause,
    });
  }

  /** The revival window is tick-counted like everything else. */
  private async downedTick(): Promise<void> {
    for (const conn of [...this.conns]) {
      if (conn.downed && this.world.tick >= conn.downed.expiresAtTick) {
        await this.finalizeEndgameDeath(conn, 'bled out');
      }
    }
  }

  /** D-206: pull a downed companion back from the brink. */
  private async handleRevive(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'revive' }>,
  ): Promise<void> {
    if (conn.entityId === null || !conn.character || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const self = this.world.getEntity(conn.entityId)!;
    if (self.ghost) return this.fail(conn, 'dead', 'the dead save nobody');
    const target = this.world.getEntity(msg.targetEntityId);
    if (!target || target.characterId === null ||
        this.world.getEntityAreaId(target.id) !== conn.areaId) {
      return this.fail(conn, 'bad_target', 'nobody there to save');
    }
    if (chebyshev(self.pos, target.pos) > INTERACT_RANGE) {
      return this.fail(conn, 'not_adjacent', 'get to them first');
    }
    const targetConn = [...(this.connsByArea.get(conn.areaId) ?? [])].find(
      (c) => c.entityId === target.id,
    );
    if (!targetConn?.downed || !targetConn.vitals) {
      return this.fail(conn, 'bad_target', 'they are not dying');
    }
    targetConn.downed = null;
    targetConn.vitals.hp = Math.max(1, Math.ceil(targetConn.vitals.maxHp / 4));
    target.posture = 'standing';
    this.broadcastPlane(conn.areaId, false, {
      t: 'delta',
      tick: this.world.tick,
      events: [{ type: 'entity_emote', id: target.id, posture: 'standing', transients: [] }],
    });
    this.sendStatus(targetConn);
    this.send(targetConn, { t: 'narrate', text: 'A hand drags you back from the edge.' });
    this.send(conn, { t: 'narrate', text: 'You feel the life catch under your hands.' });
    this.countDeed(conn, 5); // saving a life is a deed (D-222)
    await this.store.saveCharacterVitals(targetConn.character!.id, { hp: targetConn.vitals.hp });
    await this.store.appendEvent('revived', {
      characterId: targetConn.character!.id,
      by: conn.character.id,
      areaId: conn.areaId,
    });
  }

  /**
   * The window closed (D-206/D-511 handoff ruling): the character ends,
   * involuntarily — no Legacy award. A corpse remains, wearing everything,
   * for whoever dares retrieve it. NOTE: awarding nothing on involuntary
   * permadeath follows the recorded recommendation and awaits explicit
   * stakeholder ratification (flagged in D-513).
   */
  private async finalizeEndgameDeath(conn: ConnState, cause: string): Promise<void> {
    if (conn.character) this.noteRoundDeath(conn.character.id);
    if (!conn.character || !conn.vitals || conn.entityId === null || !conn.areaId) return;
    const entity = this.world.getEntity(conn.entityId)!;
    conn.downed = null;
    const areaId = conn.areaId;
    const corpse = await this.createCorpseObject(conn, {
      pos: { ...entity.pos },
      facing: entity.facing,
      presentation: entity.presentation,
      appearanceSeed: entity.appearanceSeed,
    });
    // The living watch the end. The entity leaves the world for good.
    this.broadcastPlane(areaId, false, {
      t: 'delta',
      tick: this.world.tick,
      events: [{ type: 'entity_died', id: entity.id }],
    }, conn);
    this.world.despawn(entity.id);
    await this.announceCorpse(corpse, areaId, conn);
    this.entityCharacter.delete(entity.id);
    this.connsByArea.get(areaId)?.delete(conn);
    this.onlineCharacters.delete(conn.character.id);
    this.dirtyCharacters.delete(conn.character.id);
    const totalDeeds = conn.character.deeds + this.deedsDelta(conn);
    this.deedsBuffer.delete(conn);
    await this.store.saveCharacterVitals(conn.character.id, {
      hp: 0,
      xp: conn.vitals.xp,
      deathDebt: conn.vitals.deathDebt,
      deeds: totalDeeds,
    });
    await this.store.retireCharacter(conn.character.id);
    await this.store.appendEvent('retired', {
      characterId: conn.character.id,
      accountId: conn.accountId,
      awarded: 0,
      xp: conn.vitals.xp,
      deeds: totalDeeds,
      voluntary: false,
      cause,
      areaId,
    });
    this.send(conn, {
      t: 'retired',
      awarded: 0,
      totalLegacyPoints: await this.store.getLegacyPoints(conn.accountId!),
    });
    this.send(conn, { t: 'narrate', text: 'The dark place keeps what it takes. The story ends here.' });
    const endedEntityId = entity.id;
    conn.character = null;
    conn.entityId = null;
    conn.areaId = null;
    conn.vitals = null;
    conn.injuries = [];
    this.onEntityDeath?.(endedEntityId);
  }

  /** Self-respawn at the town spawn after the minimum ghost time (D-203). */
  private async handleRespawn(conn: ConnState): Promise<void> {
    // No respawn in a round (D-521). Dead is dead until revived by another
    // player or until the round ends - this is THE difference between the
    // Round and the persistent world, so it is refused at the door.
    if (this.roundRunning) {
      return this.fail(conn, 'not_dead', 'the dead stay down until the round ends');
    }
    if (conn.entityId === null || !conn.character || !conn.vitals || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const entity = this.world.getEntity(conn.entityId)!;
    if (!entity.ghost) return this.fail(conn, 'not_dead', 'you are alive');
    if (entity.diedAtTick !== null && this.world.tick - entity.diedAtTick < this.ghostMinTicks) {
      return this.fail(conn, 'too_soon', 'the grey country does not release you yet');
    }
    this.endSeanceInvolving(conn, 'the spirit moved on');
    if (this.bodyObservers.delete(conn)) this.send(conn, { t: 'observing', on: false });
    // Leave the ghost plane…
    const leftEvent = this.world.despawn(entity.id);
    this.entityCharacter.delete(entity.id);
    this.connsByArea.get(conn.areaId)?.delete(conn);
    if (leftEvent) {
      this.broadcastPlane(conn.areaId, true, { t: 'delta', tick: this.world.tick, events: [leftEvent] });
    }
    // …and wake at the town spawn, scarred but breathing.
    conn.vitals.hp = conn.vitals.maxHp;
    await this.store.downgradeInjuries(conn.character.id);
    conn.injuries = await this.store.listInjuries(conn.character.id);
    const home = this.defaultAreaId;
    const spawn = this.world.getAreaDef(home).spawn;
    const { entity: revived } = this.world.spawn(home, {
      characterId: conn.character.id,
      name: conn.character.name,
      appearanceSeed: conn.character.appearanceSeed,
      pos: { x: spawn.x, y: spawn.y },
    });
    conn.entityId = revived.id;
    conn.areaId = home;
    this.entityCharacter.set(revived.id, conn.character.id);
    let byArea = this.connsByArea.get(home);
    if (!byArea) this.connsByArea.set(home, (byArea = new Set()));
    byArea.add(conn);
    for (const other of byArea) {
      if (other === conn || !other.character || other.entityId === null) continue;
      if (this.world.getEntity(other.entityId)?.ghost) continue;
      const descriptor = await this.descriptorFor(other, revived);
      this.send(other, {
        t: 'delta',
        tick: this.world.tick,
        events: [{ type: 'entity_entered', entity: toWireEntity(revived, descriptor) }],
      });
    }
    this.dirtyCharacters.set(conn.character.id, { areaId: home, x: spawn.x, y: spawn.y });
    await this.store.saveCharacterVitals(conn.character.id, { hp: conn.vitals.hp });
    await this.store.appendEvent('respawn', { characterId: conn.character.id, areaId: home });
    await this.sendSnapshot(conn);
    this.sendStatus(conn);
    this.onAreaEnter?.(home, revived.id);
  }

  /**
   * Voluntary permadeath (D-207/D-222): the character ends, permanently, and
   * the account earns Legacy Points scaled by xp and deeds with diminishing
   * returns on repeat sacrifice. Ghosts may retire too — walking into the
   * dark instead of respawning. Irreversible by design.
   */
  private async handleRetire(conn: ConnState): Promise<void> {
    if (conn.entityId === null || !conn.character || !conn.vitals || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const entity = this.world.getEntity(conn.entityId)!;
    this.endSeanceInvolving(conn, 'the spirit went into the dark');
    this.bodyObservers.delete(conn);
    const totalDeeds = conn.character.deeds + this.deedsDelta(conn);
    const awarded = computeLegacyAward({
      xp: conn.vitals.xp,
      deeds: totalDeeds,
      priorRetirements: await this.store.countRetired(conn.accountId!),
    });
    await this.store.saveCharacterVitals(conn.character.id, {
      hp: entity.ghost ? 0 : conn.vitals.hp,
      xp: conn.vitals.xp,
      deathDebt: conn.vitals.deathDebt,
      deeds: totalDeeds,
    });
    await this.store.retireCharacter(conn.character.id);
    await this.store.addLegacyPoints(conn.accountId!, awarded);
    const total = await this.store.getLegacyPoints(conn.accountId!);
    await this.store.appendEvent('retired', {
      characterId: conn.character.id,
      accountId: conn.accountId,
      awarded,
      xp: conn.vitals.xp,
      deeds: totalDeeds,
      voluntary: true,
    });
    // The world sees them go the way it saw them arrive.
    const event = this.world.despawn(entity.id);
    this.entityCharacter.delete(entity.id);
    this.connsByArea.get(conn.areaId)?.delete(conn);
    if (event) {
      this.broadcastPlane(conn.areaId, entity.ghost, {
        t: 'delta',
        tick: this.world.tick,
        events: [event],
      });
    }
    this.onlineCharacters.delete(conn.character.id);
    this.dirtyCharacters.delete(conn.character.id);
    this.send(conn, { t: 'retired', awarded, totalLegacyPoints: total });
    // Back to the character screen state: authenticated, nobody.
    conn.character = null;
    conn.entityId = null;
    conn.areaId = null;
    conn.vitals = null;
    conn.injuries = [];
  }

  /** Deeds accrued this session but not yet persisted. */
  private deedsBuffer = new Map<ConnState, number>();

  private deedsDelta(conn: ConnState): number {
    return this.deedsBuffer.get(conn) ?? 0;
  }

  /** A meaningful action happened — the D-222 measure of a life lived. */
  private countDeed(conn: ConnState, weight = 1): void {
    this.deedsBuffer.set(conn, (this.deedsBuffer.get(conn) ?? 0) + weight);
  }

  /** Treatment (D-205): minor wounds you may bind yourself; a major wound
   * needs another pair of hands. Bandages are consumed by the treater. */
  private async handleTreat(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'treat' }>,
  ): Promise<void> {
    if (conn.entityId === null || !conn.character || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const self = this.world.getEntity(conn.entityId)!;
    if (self.ghost) return this.fail(conn, 'dead', 'the dead mend nothing');
    const target = this.world.getEntity(msg.targetEntityId);
    if (!target || target.ghost || target.characterId === null ||
        this.world.getEntityAreaId(target.id) !== conn.areaId ||
        chebyshev(self.pos, target.pos) > INTERACT_RANGE) {
      return this.fail(conn, 'bad_target', 'nobody there to tend');
    }
    const targetConn =
      target.id === self.id
        ? conn
        : [...(this.connsByArea.get(conn.areaId) ?? [])].find((c) => c.entityId === target.id);
    if (!targetConn) return this.fail(conn, 'bad_target', 'nobody there to tend');
    const injury =
      (msg.injuryId && targetConn.injuries.find((i) => i.id === msg.injuryId)) ||
      targetConn.injuries.find((i) => i.severity === 'major') ||
      targetConn.injuries[0];
    if (!injury) return this.fail(conn, 'no_injury', 'no wound to treat');
    if (injury.severity === 'major' && targetConn === conn) {
      return this.fail(conn, 'no_injury', 'a major wound cannot be self-treated — find help');
    }
    const hasBandage = await this.store.consumeOneItem(conn.character.id, 'bandage');
    if (!hasBandage) return this.fail(conn, 'no_such_item', 'you need a bandage');
    await this.store.removeInjury(injury.id);
    targetConn.injuries = targetConn.injuries.filter((i) => i.id !== injury.id);
    this.sendStatus(targetConn);
    await this.sendInventory(conn);
    await this.store.appendEvent('treated', {
      treater: conn.character.id,
      patient: targetConn.character!.id,
      injuryId: injury.id,
      severity: injury.severity,
    });
  }

  // -------------------------------------------------------------------------
  // Spirit interactions (D-204, D-224, D-511): corpses, looting, séances,
  // animation. The séance is the ONE sanctioned crossing between the planes,
  // scoped to speech and logged in full.
  // -------------------------------------------------------------------------

  /** Class-gated abilities (D-208/D-511). No class, no ability. */
  private hasAbility(conn: ConnState, ability: ClassAbility): boolean {
    const classId = conn.character?.classId;
    if (!classId) return false;
    return this.content.classes.get(classId)?.abilities.includes(ability) ?? false;
  }

  /** Concurrent zombies scale with necromancy skill, hard-capped (D-511). */
  private zombieCap(necromancy: number): number {
    return Math.min(MAX_ZOMBIES_PER_NECROMANCER, 1 + Math.floor(necromancy / 40));
  }

  private findConnByCharacter(characterId: string): ConnState | null {
    for (const conn of this.conns) {
      if (conn.character?.id === characterId && conn.entityId !== null) return conn;
    }
    return null;
  }

  /** Re-materializes persisted corpses and gear piles on boot. Zombies do not
   * survive a restart — an 'animated' row wakes as a lying corpse again. */
  private async restoreCorpses(): Promise<void> {
    for (const rec of await this.store.listActiveCorpses()) {
      const ch = await this.store.getCharacter(rec.characterId);
      if (!ch) continue;
      let { areaId, x, y } = rec;
      if (!this.world.hasArea(areaId)) {
        // The area is gone (a temp area, most likely): wash up at the town spawn.
        areaId = this.defaultAreaId;
        const spawn = this.world.getAreaDef(areaId).spawn;
        x = spawn.x;
        y = spawn.y;
      }
      const state = rec.state === 'ground' ? 'ground' : 'corpse';
      const ticksLeft = Math.max(
        rec.state === 'animated' ? this.corpseDecayTicks : rec.ticksLeft,
        1,
      );
      const { entity } = this.world.spawn(areaId, {
        characterId: null,
        name: `the ${state === 'ground' ? 'remains' : 'corpse'} of ${ch.name}`,
        objectKind: state === 'ground' ? 'pile' : 'corpse',
        corpseOfCharacterId: ch.id,
        appearanceSeed: ch.appearanceSeed,
        pos: { x, y },
      });
      this.corpsesByEntity.set(entity.id, {
        corpseId: rec.id,
        characterId: ch.id,
        state,
        expiresAtTick: this.world.tick + ticksLeft,
      });
      if (rec.state !== state || rec.areaId !== areaId) {
        await this.store.updateCorpse(rec.id, { state, areaId, x, y, ticksLeft });
      }
    }
  }

  /** Corpse decay and zombie duration (D-511), all tick-counted. */
  private async spiritTick(): Promise<void> {
    for (const [entityId, info] of [...this.corpsesByEntity]) {
      if (this.world.tick < info.expiresAtTick) continue;
      if (info.state === 'corpse') await this.corpseDecays(entityId, info);
      else await this.cleanupPile(entityId, info);
    }
    for (const [zombieId, z] of [...this.zombies]) {
      if (this.world.tick < z.expiresAtTick) continue;
      const zombie = this.world.getEntity(zombieId);
      const areaId = this.world.getEntityAreaId(zombieId);
      if (!zombie || !areaId) {
        this.zombies.delete(zombieId);
        continue;
      }
      const pos = { ...zombie.pos };
      this.broadcastPlane(areaId, false, {
        t: 'delta',
        tick: this.world.tick,
        events: [{ type: 'entity_died', id: zombieId }],
      });
      this.world.despawn(zombieId);
      this.narrate('area', 'The walking corpse sags, and whatever held it lets go.', areaId);
      await this.zombieDestroyed(zombieId, z, areaId, pos, 'duration');
    }
  }

  /** The corpse rots away; anything it held is left lying (D-511: one hour). */
  private async corpseDecays(entityId: number, info: CorpseRuntime): Promise<void> {
    const corpse = this.world.getEntity(entityId);
    const areaId = this.world.getEntityAreaId(entityId);
    this.corpsesByEntity.delete(entityId);
    for (const seance of [...this.seancesByCaster.values()]) {
      if (seance.corpseEntityId === entityId) this.endSeance(seance, 'the body gave out');
    }
    if (!corpse || !areaId) return;
    const pos = { ...corpse.pos };
    const leftEvent = this.world.despawn(entityId);
    if (leftEvent) {
      this.broadcastPlane(areaId, false, { t: 'delta', tick: this.world.tick, events: [leftEvent] });
    }
    const items = await this.store.getItemsByCorpse(info.corpseId);
    if (items.length === 0) {
      await this.store.updateCorpse(info.corpseId, { state: 'gone', ticksLeft: 0 });
    } else {
      await this.spawnPile(info, areaId, pos);
    }
    await this.store.appendEvent('corpse_decayed', {
      corpseId: info.corpseId,
      characterId: info.characterId,
      areaId,
      itemsLeft: items.length,
    });
  }

  /** Gear hits the ground as a lootable pile with its own clock. */
  private async spawnPile(info: CorpseRuntime, areaId: string, pos: { x: number; y: number }): Promise<void> {
    const dead = await this.store.getCharacter(info.characterId);
    const { entity: pile } = this.world.spawn(areaId, {
      characterId: null,
      name: `the remains of ${dead?.name ?? 'someone'}`,
      objectKind: 'pile',
      corpseOfCharacterId: info.characterId,
      appearanceSeed: dead?.appearanceSeed ?? 0,
      pos,
    });
    this.corpsesByEntity.set(pile.id, {
      corpseId: info.corpseId,
      characterId: info.characterId,
      state: 'ground',
      expiresAtTick: this.world.tick + this.groundLootTicks,
    });
    await this.store.updateCorpse(info.corpseId, {
      state: 'ground',
      areaId,
      x: pos.x,
      y: pos.y,
      ticksLeft: this.groundLootTicks,
    });
    for (const other of this.connsByArea.get(areaId) ?? []) {
      if (!other.character || other.entityId === null) continue;
      if (this.world.getEntity(other.entityId)?.ghost !== false) continue;
      this.send(other, {
        t: 'delta',
        tick: this.world.tick,
        events: [{ type: 'entity_entered', entity: toWireEntity(pile, await this.descriptorFor(other, pile)) }],
      });
    }
  }

  /** The hour is up: unclaimed gear is destroyed — deliberately, and logged. */
  private async cleanupPile(entityId: number, info: CorpseRuntime): Promise<void> {
    const areaId = this.world.getEntityAreaId(entityId);
    this.corpsesByEntity.delete(entityId);
    const items = await this.store.getItemsByCorpse(info.corpseId);
    const deleted = await this.store.deleteItemsByCorpse(info.corpseId);
    const leftEvent = this.world.despawn(entityId);
    if (leftEvent && areaId) {
      this.broadcastPlane(areaId, false, { t: 'delta', tick: this.world.tick, events: [leftEvent] });
    }
    await this.store.updateCorpse(info.corpseId, { state: 'gone', ticksLeft: 0 });
    await this.store.appendEvent('corpse_loot_cleanup', {
      corpseId: info.corpseId,
      characterId: info.characterId,
      destroyed: items.map((i) => ({ templateId: i.templateId, qty: i.qty })),
      count: deleted,
    });
  }

  /** Zombies shamble after their necromancer when they share an area. */
  private zombieAiTick(): void {
    for (const [zombieId, z] of this.zombies) {
      const zombie = this.world.getEntity(zombieId);
      const areaId = this.world.getEntityAreaId(zombieId);
      if (!zombie || !areaId) continue;
      const owner = [...(this.connsByArea.get(areaId) ?? [])].find(
        (c) => c.character?.id === z.ownerCharacterId && c.entityId !== null &&
          this.world.getEntity(c.entityId)?.ghost === false,
      );
      if (!owner) continue;
      const ownerEntity = this.world.getEntity(owner.entityId!)!;
      if (chebyshev(zombie.pos, ownerEntity.pos) <= 1) continue;
      const dx = Math.sign(ownerEntity.pos.x - zombie.pos.x);
      const dy = Math.sign(ownerEntity.pos.y - zombie.pos.y);
      this.world.setMoveIntent(zombieId, directionFrom(dx, dy));
    }
  }

  /** Shared aftermath of a zombie's end: the gear it wore hits the ground
   * (D-224 — without this, the hunt for your own corpse has no payoff). */
  private async zombieDestroyed(
    zombieId: number,
    z: ZombieRuntime,
    areaId: string,
    pos: { x: number; y: number },
    cause: string,
  ): Promise<void> {
    this.zombies.delete(zombieId);
    for (const [obsConn, observedId] of [...this.bodyObservers]) {
      if (observedId === zombieId) {
        this.bodyObservers.delete(obsConn);
        this.send(obsConn, { t: 'observing', on: false });
      }
    }
    const items = await this.store.getItemsByCorpse(z.corpseId);
    if (items.length === 0) {
      await this.store.updateCorpse(z.corpseId, { state: 'gone', ticksLeft: 0 });
    } else {
      const info: CorpseRuntime = {
        corpseId: z.corpseId,
        characterId: z.characterId,
        state: 'ground',
        expiresAtTick: this.world.tick + this.groundLootTicks,
      };
      await this.spawnPile(info, areaId, pos);
    }
    await this.store.appendEvent('corpse_destroyed', {
      corpseId: z.corpseId,
      characterId: z.characterId,
      owner: z.ownerCharacterId,
      areaId,
      cause,
      itemsDropped: items.length,
    });
  }

  /** Take everything a corpse or pile holds (D-224/D-511). */
  private async handleLoot(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'loot' }>,
  ): Promise<void> {
    if (conn.entityId === null || !conn.character || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const self = this.world.getEntity(conn.entityId)!;
    if (self.ghost) return this.fail(conn, 'dead', 'the dead carry nothing away');
    const info = this.corpsesByEntity.get(msg.targetEntityId);
    const target = this.world.getEntity(msg.targetEntityId);
    if (!info || !target || this.world.getEntityAreaId(target.id) !== conn.areaId) {
      return this.fail(conn, 'bad_target', 'nothing there to loot');
    }
    if (chebyshev(self.pos, target.pos) > INTERACT_RANGE) {
      return this.fail(conn, 'not_adjacent', 'too far away');
    }
    const moved = await this.store.moveItemsFromCorpse(info.corpseId, conn.character.id);
    if (moved === 0) {
      // Settled-zone corpses hold nothing (D-511) — and piles empty out.
      return this.fail(conn, 'no_such_item', 'nothing to take');
    }
    if (info.state === 'ground') {
      // An emptied pile is no longer a thing in the world.
      this.corpsesByEntity.delete(target.id);
      const leftEvent = this.world.despawn(target.id);
      if (leftEvent) {
        this.broadcastPlane(conn.areaId, false, { t: 'delta', tick: this.world.tick, events: [leftEvent] });
      }
      await this.store.updateCorpse(info.corpseId, { state: 'gone', ticksLeft: 0 });
    }
    await this.store.appendEvent('corpse_looted', {
      corpseId: info.corpseId,
      characterId: info.characterId,
      by: conn.character.id,
      areaId: conn.areaId,
      count: moved,
    });
    await this.sendInventory(conn);
  }

  /** D-204: the ghost is drawn back to its corpse for five questions it is
   * free to answer falsely. Out of reach is a distinct result (D-511). */
  private async handleSpeakDead(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'speak_dead' }>,
  ): Promise<void> {
    if (conn.entityId === null || !conn.character || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const self = this.world.getEntity(conn.entityId)!;
    if (self.ghost) return this.fail(conn, 'dead', 'the dead need no ritual to speak to the dead');
    if (!this.hasAbility(conn, 'speak-with-dead')) {
      return this.fail(conn, 'lacks_ability', 'you do not know the rites');
    }
    if (this.seancesByCaster.has(conn)) {
      return this.fail(conn, 'on_cooldown', 'a séance is already underway');
    }
    const info = this.corpsesByEntity.get(msg.targetEntityId);
    const corpse = this.world.getEntity(msg.targetEntityId);
    if (!info || !corpse || info.state !== 'corpse' ||
        this.world.getEntityAreaId(corpse.id) !== conn.areaId) {
      return this.fail(conn, 'bad_target', 'that is no corpse you can question');
    }
    if (chebyshev(self.pos, corpse.pos) > INTERACT_RANGE) {
      return this.fail(conn, 'not_adjacent', 'kneel by the body first');
    }
    const spirit = this.findConnByCharacter(info.characterId);
    const spiritEntity = spirit?.entityId !== null && spirit ? this.world.getEntity(spirit.entityId!) : null;
    if (!spirit || !spiritEntity?.ghost || this.seancesBySpirit.has(spirit)) {
      // Offline, already respawned, or already being questioned: a
      // deliberately DISTINCT result (D-511) — unlike a ghost who stonewalls.
      await this.store.appendEvent('speak_with_dead_unreachable', {
        caster: conn.character.id,
        corpseId: info.corpseId,
        characterId: info.characterId,
      });
      return this.fail(conn, 'beyond_reach', 'the spirit is beyond reach');
    }
    // Drawn back: the ghost is pulled to its body, still on the other side.
    if (spirit.areaId !== conn.areaId ||
        chebyshev(spiritEntity.pos, corpse.pos) > CHANNEL_RANGE.say) {
      await this.transferToArea(spirit, conn.areaId, corpse.pos.x, corpse.pos.y);
    }
    const seance: Seance = {
      caster: conn,
      spirit,
      corpseId: info.corpseId,
      corpseEntityId: corpse.id,
      questionsLeft: SEANCE_QUESTIONS,
    };
    this.seancesByCaster.set(conn, seance);
    this.seancesBySpirit.set(spirit, seance);
    this.send(conn, { t: 'seance', role: 'caster', active: true, questionsLeft: seance.questionsLeft });
    this.send(spirit, { t: 'seance', role: 'spirit', active: true, questionsLeft: seance.questionsLeft });
    this.send(spirit, {
      t: 'narrate',
      text: 'Something takes hold and draws you back to what you were. Five questions will come. Nothing binds you to the truth.',
    });
    await this.store.appendEvent('speak_with_dead', {
      caster: conn.character.id,
      corpseId: info.corpseId,
      characterId: info.characterId,
      areaId: conn.areaId,
    });
  }

  private endSeance(seance: Seance, reason: string): void {
    this.seancesByCaster.delete(seance.caster);
    this.seancesBySpirit.delete(seance.spirit);
    this.send(seance.caster, { t: 'seance', role: 'caster', active: false, questionsLeft: seance.questionsLeft });
    this.send(seance.spirit, { t: 'seance', role: 'spirit', active: false, questionsLeft: seance.questionsLeft });
    this.send(seance.spirit, { t: 'narrate', text: 'The hold on you loosens. You drift free of the body again.' });
    void this.store.appendEvent('seance_ended', { corpseId: seance.corpseId, reason });
  }

  private endSeanceInvolving(conn: ConnState, reason: string): void {
    const seance = this.seancesByCaster.get(conn) ?? this.seancesBySpirit.get(conn);
    if (seance) this.endSeance(seance, reason);
  }

  /** D-204/D-224: raise a corpse as a walking ally, wearing what it wore. */
  private async handleAnimateDead(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'animate_dead' }>,
  ): Promise<void> {
    if (conn.entityId === null || !conn.character || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const self = this.world.getEntity(conn.entityId)!;
    if (self.ghost) return this.fail(conn, 'dead', 'the dead raise nothing');
    if (!this.hasAbility(conn, 'animate-dead')) {
      return this.fail(conn, 'lacks_ability', 'you do not know the rites');
    }
    const info = this.corpsesByEntity.get(msg.targetEntityId);
    const corpse = this.world.getEntity(msg.targetEntityId);
    if (!info || !corpse || info.state !== 'corpse' ||
        this.world.getEntityAreaId(corpse.id) !== conn.areaId) {
      return this.fail(conn, 'bad_target', 'that is nothing you can raise');
    }
    if (chebyshev(self.pos, corpse.pos) > INTERACT_RANGE) {
      return this.fail(conn, 'not_adjacent', 'kneel by the body first');
    }
    const owned = [...this.zombies.values()].filter(
      (z) => z.ownerCharacterId === conn.character!.id,
    ).length;
    if (owned >= this.zombieCap(conn.character.necromancy)) {
      return this.fail(conn, 'limit_reached', 'you cannot hold another body upright');
    }
    // The ritual overrides any séance in progress on this body.
    for (const seance of [...this.seancesByCaster.values()]) {
      if (seance.corpseEntityId === corpse.id) this.endSeance(seance, 'the body was taken');
    }
    const pos = { ...corpse.pos };
    const presentation = corpse.presentation;
    this.corpsesByEntity.delete(corpse.id);
    const leftEvent = this.world.despawn(corpse.id);
    if (leftEvent) {
      this.broadcastPlane(conn.areaId, false, { t: 'delta', tick: this.world.tick, events: [leftEvent] });
    }
    const { entity: zombie } = this.world.spawn(conn.areaId, {
      characterId: null,
      name: corpse.name,
      objectKind: 'zombie',
      corpseOfCharacterId: info.characterId,
      appearanceSeed: corpse.appearanceSeed,
      pos,
      hp: 15,
    });
    zombie.presentation = presentation;
    this.zombies.set(zombie.id, {
      corpseId: info.corpseId,
      characterId: info.characterId,
      ownerCharacterId: conn.character.id,
      expiresAtTick: this.world.tick + this.zombieDurationTicks,
    });
    await this.store.updateCorpse(info.corpseId, {
      state: 'animated',
      ticksLeft: this.zombieDurationTicks,
    });
    for (const other of this.connsByArea.get(conn.areaId) ?? []) {
      if (!other.character || other.entityId === null) continue;
      if (this.world.getEntity(other.entityId)?.ghost !== false) continue;
      this.send(other, {
        t: 'delta',
        tick: this.world.tick,
        events: [{ type: 'entity_entered', entity: toWireEntity(zombie, await this.descriptorFor(other, zombie)) }],
      });
    }
    // If the dead player is watching from the grey country, they feel it.
    const deadConn = this.findConnByCharacter(info.characterId);
    if (deadConn && deadConn.entityId !== null && this.world.getEntity(deadConn.entityId)?.ghost) {
      this.send(deadConn, {
        t: 'narrate',
        text: 'Far away, something drags your body to its feet. You could ride along, if you can bear it.',
      });
    }
    await this.store.appendEvent('corpse_animated', {
      corpseId: info.corpseId,
      characterId: info.characterId,
      owner: conn.character.id,
      areaId: conn.areaId,
    });
  }

  /** D-224: the dead owner chooses to ride the walking body — hearing what it
   * hears, speaking through it in the undead register. Never forced. */
  private async handleObserveBody(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'observe_body' }>,
  ): Promise<void> {
    if (conn.entityId === null || !conn.character) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    if (!msg.on) {
      if (this.bodyObservers.delete(conn)) this.send(conn, { t: 'observing', on: false });
      return;
    }
    const self = this.world.getEntity(conn.entityId)!;
    if (!self.ghost) return this.fail(conn, 'not_dead', 'you are still wearing your body');
    const zombieEntry = [...this.zombies.entries()].find(
      ([, z]) => z.characterId === conn.character!.id,
    );
    if (!zombieEntry) return this.fail(conn, 'bad_target', 'your body does not walk');
    this.bodyObservers.set(conn, zombieEntry[0]);
    this.send(conn, { t: 'observing', on: true });
    await this.store.appendEvent('body_observed', {
      characterId: conn.character.id,
      corpseId: zombieEntry[1].corpseId,
    });
  }

  private async handleDisconnect(conn: ConnState): Promise<void> {
    if (!this.conns.has(conn)) return;
    this.conns.delete(conn);
    this.endSeanceInvolving(conn, 'departed');
    this.bodyObservers.delete(conn);
    this.endgameConfirms.delete(conn);
    // Logging out while bleeding out in an endgame zone is not an escape.
    if (conn.downed) await this.finalizeEndgameDeath(conn, 'abandoned to the dark');
    if (conn.entityId !== null && conn.areaId !== null && conn.character) {
      const entity = this.world.getEntity(conn.entityId);
      const event = this.world.despawn(conn.entityId);
      this.entityCharacter.delete(conn.entityId);
      this.connsByArea.get(conn.areaId)?.delete(conn);
      this.onlineCharacters.delete(conn.character.id);
      if (event && entity) {
        this.broadcastPlane(conn.areaId, entity.ghost, { t: 'delta', tick: this.world.tick, events: [event] });
      }
      if (entity) {
        // Immediate write on logout (D-106).
        this.dirtyCharacters.delete(conn.character.id);
        try {
          if (conn.vitals) {
            await this.store.saveCharacterVitals(conn.character.id, {
              hp: entity.ghost ? 0 : conn.vitals.hp,
              xp: conn.vitals.xp,
              deathDebt: conn.vitals.deathDebt,
              deeds: conn.character.deeds + this.deedsDelta(conn),
            });
            this.deedsBuffer.delete(conn);
          }
          await this.store.saveCharacterPosition(
            conn.character.id,
            conn.areaId,
            entity.pos.x,
            entity.pos.y,
          );
          await this.store.appendEvent('logout', {
            characterId: conn.character.id,
            areaId: conn.areaId,
            x: entity.pos.x,
            y: entity.pos.y,
          });
        } catch (err) {
          this.log(`logout persist failed: ${(err as Error).message}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private async handleRegister(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'register' }>,
  ): Promise<void> {
    const passHash = await hashPassword(msg.password);
    const account = await this.store.createAccount(msg.username, passHash);
    if (account === 'username_taken') {
      this.fail(conn, 'username_taken', 'that username is taken');
      return;
    }
    await this.store.appendEvent('account_created', { accountId: account.id, username: account.username });
    await this.finishAuth(conn, account.id);
  }

  private async handleLogin(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'login' }>,
  ): Promise<void> {
    const account = await this.store.getAccountByUsername(msg.username);
    if (!account || !(await verifyPassword(msg.password, account.passHash))) {
      this.fail(conn, 'auth_failed', 'bad username or password');
      return;
    }
    await this.store.appendEvent('login', { accountId: account.id });
    await this.finishAuth(conn, account.id);
  }

  private async handleResume(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'resume' }>,
  ): Promise<void> {
    const session = await this.store.getSession(msg.token);
    if (!session) {
      this.fail(conn, 'auth_failed', 'session invalid or expired');
      return;
    }
    await this.finishAuth(conn, session.accountId, msg.token);
  }

  private async finishAuth(conn: ConnState, accountId: string, existingToken?: string): Promise<void> {
    conn.accountId = accountId;
    let token = existingToken;
    if (!token) {
      token = newSessionToken();
      await this.store.createSession({ token, accountId, expiresAt: Date.now() + SESSION_TTL_MS });
    }
    const characters = await this.store.getCharactersByAccount(accountId);
    this.send(conn, {
      t: 'auth_ok',
      accountId,
      token,
      // The retired are memories, not options.
      characters: characters.filter((c) => !c.retired).map(toSummary),
      legacyPoints: await this.store.getLegacyPoints(accountId),
    });
  }

  // -------------------------------------------------------------------------
  // Characters and world entry
  // -------------------------------------------------------------------------

  /**
   * Lifting a body (stakeholder, 2026-08-18). Whether you CAN is a question
   * of build against build: a corpse's burden comes from the dead
   * character's own bulk, and your capacity from Athletics. Carrying a
   * brute takes a trained back.
   */
  private async handleCarryBody(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'carry_body' }>,
  ): Promise<void> {
    if (conn.entityId === null || !conn.character || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const self = this.world.getEntity(conn.entityId)!;
    if (self.ghost) return this.fail(conn, 'dead', 'the dead lift nothing');
    const body = this.world.getEntity(msg.targetEntityId);
    if (!body || body.objectKind !== 'corpse' ||
        this.world.getEntityAreaId(body.id) !== conn.areaId) {
      return this.fail(conn, 'bad_target', 'there is no body there');
    }
    if (body.carriedBy !== null) {
      return this.fail(conn, 'bad_target', 'someone already has it');
    }
    if (chebyshev(self.pos, body.pos) > INTERACT_RANGE) {
      return this.fail(conn, 'not_adjacent', 'too far to reach');
    }
    // Already carrying something? A body takes both arms.
    for (const other of this.world.entitiesIn(conn.areaId)) {
      if (other.carriedBy === self.id) {
        return this.fail(conn, 'bad_target', 'your arms are already full');
      }
    }
    const burden = corpseBurden(body.appearanceSeed);
    const capacity = CARRY_BASE_CAPACITY + (conn.character.skills.athletics ?? 0);
    if (burden > capacity) {
      return this.fail(conn, 'lacks_ability', 'too heavy — you cannot get it off the ground');
    }
    this.setCarried(body, self.id, conn.areaId);
    await this.store.appendEvent('body_carried', {
      characterId: conn.character.id,
      entityId: body.id,
      areaId: conn.areaId,
      burden,
      capacity,
    });
  }

  private async handleDropBody(conn: ConnState): Promise<void> {
    if (conn.entityId === null || !conn.character || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const carried = this.world
      .entitiesIn(conn.areaId)
      .find((e) => e.carriedBy === conn.entityId);
    if (!carried) return this.fail(conn, 'bad_target', 'you are carrying nothing');
    this.setCarried(carried, null, conn.areaId);
    await this.store.appendEvent('body_dropped', {
      characterId: conn.character.id,
      entityId: carried.id,
      areaId: conn.areaId,
      x: carried.pos.x,
      y: carried.pos.y,
    });
  }

  /** The creation catalogue, straight from content (D-110). */
  private async handleGetCreationContent(conn: ConnState): Promise<void> {
    if (!conn.accountId) return this.fail(conn, 'not_authenticated', 'log in first');
    this.send(conn, {
      t: 'creation_content',
      classes: [...this.content.classes.values()],
      skills: this.content.skills,
      feats: this.content.feats,
      spells: this.content.spells,
      budget: {
        skillPoints: CREATION_SKILL_POINTS,
        skillStep: CREATION_SKILL_STEP,
        skillMax: CREATION_SKILL_MAX,
        feats: CREATION_FEAT_PICKS,
        spells: CREATION_SPELL_PICKS,
      },
      legacyPoints: await this.store.getLegacyPoints(conn.accountId),
    });
  }

  private async handleCreateCharacter(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'create_character' }>,
  ): Promise<void> {
    if (!conn.accountId) return this.fail(conn, 'not_authenticated', 'log in first');
    const area = this.content.areas.get(this.defaultAreaId)!;
    const seed = msg.appearanceSeed ?? Math.floor(Math.random() * 2 ** 31);
    // Class selection (D-208/D-511). Legacy-locked classes require Legacy
    // Points on the account. PLACEHOLDER GATE: ≥1 point and no deduction —
    // real pricing awaits stakeholder ratification (flagged in D-512).
    if (msg.classId !== undefined) {
      const classDef = this.content.classes.get(msg.classId);
      if (!classDef) return this.fail(conn, 'invalid_message', 'no such class');
      if (classDef.legacyLocked) {
        const points = await this.store.getLegacyPoints(conn.accountId);
        if (points < 1) {
          return this.fail(conn, 'lacks_ability', 'that path must be earned — it is bought with a life');
        }
      }
    }
    // The build is validated HERE, against content, before anything is
    // written (D-102): the client's own check is convenience only.
    const build = msg.build ?? { skills: {}, feats: [], spells: [] };
    if (msg.build) {
      if (msg.classId === undefined) {
        return this.fail(conn, 'invalid_message', 'a build requires a class');
      }
      const problems = validateBuild(
        {
          classes: [...this.content.classes.values()],
          skills: this.content.skills,
          feats: this.content.feats,
          spells: this.content.spells,
        },
        msg.classId,
        build,
      );
      if (problems.length > 0) {
        return this.fail(conn, 'invalid_message', `illegal build: ${problems.join('; ')}`);
      }
    }
    const character = await this.store.createCharacter({
      accountId: conn.accountId,
      name: msg.name,
      appearanceSeed: seed,
      areaId: area.id,
      x: area.spawn.x,
      y: area.spawn.y,
      classId: msg.classId ?? null,
      skills: build.skills,
      feats: build.feats,
      spells: build.spells,
    });
    if (character === 'character_name_taken') {
      return this.fail(conn, 'character_name_taken', 'that name is taken');
    }
    await this.store.appendEvent('character_created', {
      characterId: character.id,
      accountId: conn.accountId,
      name: character.name,
      ...(character.classId ? { classId: character.classId } : {}),
    });
    this.send(conn, { t: 'character_created', character: toSummary(character) });
  }

  private async handleEnterWorld(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'enter_world' }>,
  ): Promise<void> {
    if (!conn.accountId) return this.fail(conn, 'not_authenticated', 'log in first');
    if (conn.entityId !== null) return this.fail(conn, 'already_in_world', 'already in world');
    const character = await this.store.getCharacter(msg.characterId);
    if (!character || character.accountId !== conn.accountId || character.retired) {
      return this.fail(conn, 'no_such_character', 'no such character on this account');
    }
    if (this.onlineCharacters.has(character.id)) {
      return this.fail(conn, 'already_in_world', 'character is already online');
    }
    const areaId = this.world.hasArea(character.areaId) ? character.areaId : this.defaultAreaId;
    // Ghosts do not persist across sessions: leaving as a ghost means waking
    // at the respawn point, debt already on the books (recorded call, D-509).
    if (character.hp <= 0) {
      character.hp = character.maxHp;
      await this.store.saveCharacterVitals(character.id, { hp: character.hp });
      await this.store.downgradeInjuries(character.id);
    }
    const { entity } = this.world.spawn(areaId, {
      characterId: character.id,
      name: character.name,
      appearanceSeed: character.appearanceSeed,
      pos: { x: character.x, y: character.y },
    });
    conn.character = character;
    conn.entityId = entity.id;
    conn.areaId = areaId;
    conn.vitals = {
      hp: character.hp,
      maxHp: character.maxHp,
      xp: character.xp,
      deathDebt: character.deathDebt,
    };
    conn.injuries = await this.store.listInjuries(character.id);
    this.entityCharacter.set(entity.id, character.id);
    this.onlineCharacters.add(character.id);
    // entity_entered is personalized: each observer gets the arrival under
    // the descriptor THEY know (D-219) — a name if learned, else what they see.
    for (const other of this.connsByArea.get(areaId) ?? []) {
      if (other === conn || !other.character || other.entityId === null) continue;
      if (this.world.getEntity(other.entityId)?.ghost !== entity.ghost) continue;
      const descriptor = await this.descriptorFor(other, entity);
      this.send(other, {
        t: 'delta',
        tick: this.world.tick,
        events: [{ type: 'entity_entered', entity: toWireEntity(entity, descriptor) }],
      });
    }
    let byArea = this.connsByArea.get(areaId);
    if (!byArea) this.connsByArea.set(areaId, (byArea = new Set()));
    byArea.add(conn);
    await this.store.appendEvent('enter_world', { characterId: character.id, areaId });
    await this.sendSnapshot(conn);
    this.sendStatus(conn);
    this.send(conn, {
      t: 'catalogue',
      items: [...this.content.itemTemplates.values()].map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        category: i.category,
        stackable: i.stackable,
      })),
      recipes: [...this.content.recipes.values()].map((r) => ({
        id: r.id,
        name: r.name,
        output: r.output,
        outputQuantity: r.outputQuantity,
        inputs: r.inputs,
        station: r.station,
        effortTicks: r.effortTicks,
      })),
    });
    this.onAreaEnter?.(areaId, entity.id);
  }

  private async handleResync(conn: ConnState): Promise<void> {
    if (conn.entityId === null) return this.fail(conn, 'not_in_world', 'enter the world first');
    await this.sendSnapshot(conn);
  }

  private async sendSnapshot(conn: ConnState): Promise<void> {
    const areaId = conn.areaId!;
    const def = this.world.getAreaDef(areaId);
    const items = await this.store.getItemsByCharacter(conn.character!.id);
    const coin = await this.store.getCoin(conn.character!.id);
    // Your snapshot contains only your plane: ghosts see ghosts, the living
    // see the living, and neither can prove the other exists (D-203).
    const selfGhost = this.world.getEntity(conn.entityId!)?.ghost ?? false;
    const entities = this.world.entitiesIn(areaId).filter((e) => e.ghost === selfGhost);
    const descriptors = await this.descriptorsFor(conn, entities);
    this.send(conn, {
      t: 'snapshot',
      tick: this.world.tick,
      you: conn.entityId!,
      area: {
        id: def.id,
        name: def.name,
        lighting: this.lightingOverrides.get(areaId) ?? def.lighting,
        width: def.width,
        height: def.height,
        legend: def.legend,
        tiles: def.tiles,
        transitions: this.transitionsFor(areaId).map(({ x, y }) => ({ x, y })),
      },
      entities: entities.map((e) => toWireEntity(e, descriptors.get(e.id)!)),
      inventory: items.map(toWireItem),
      coin,
    });
  }

  // -------------------------------------------------------------------------
  // Recognition (D-201, D-218, D-219)
  // -------------------------------------------------------------------------

  /** What `observer` calls each entity: own name for self, a learned name if
   * known, else a generated description of what they see. */
  private async descriptorsFor(
    observer: ConnState,
    entities: WorldEntity[],
  ): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    // Knowledge is per observed identity: character × presentation (D-219).
    const strangersByPresentation = new Map<string, WorldEntity[]>();
    for (const e of entities) {
      if (e.objectKind === 'pile') {
        // Gear on the ground carries no identity — the body is gone.
        out.set(e.id, 'a scatter of abandoned belongings');
      } else if (e.objectKind === 'corpse' || e.objectKind === 'zombie') {
        // The dead resolve through the same per-observer knowledge as the
        // living (D-219): you recognise a corpse only if you knew the face.
        out.set(e.id, await this.describeDead(observer, e));
      } else if (e.characterId === null) {
        // NPCs wear one public face for everyone (D-507).
        out.set(e.id, e.npcDescriptor ?? describeAppearance(generateAppearance(e.appearanceSeed)));
      } else if (e.characterId === observer.character!.id) {
        out.set(e.id, observer.character!.name);
      } else {
        let group = strangersByPresentation.get(e.presentation);
        if (!group) strangersByPresentation.set(e.presentation, (group = []));
        group.push(e);
      }
    }
    for (const [presentation, group] of strangersByPresentation) {
      const knowledge = await this.store.getKnowledge(
        observer.character!.id,
        group.map((e) => e.characterId!),
        presentation,
      );
      for (const e of group) {
        const known = knowledge.get(e.characterId!);
        const appearance = generateAppearance(e.appearanceSeed);
        out.set(
          e.id,
          known?.knownName ??
            (presentation === 'hooded' ? describeHooded(appearance) : describeAppearance(appearance)),
        );
      }
    }
    return out;
  }

  private async descriptorFor(observer: ConnState, entity: WorldEntity): Promise<string> {
    return (await this.descriptorsFor(observer, [entity])).get(entity.id)!;
  }

  /** "the corpse of ⟨what you knew them as⟩" — or of a stranger's face. */
  private async describeDead(observer: ConnState, e: WorldEntity): Promise<string> {
    const deadId = e.corpseOfCharacterId!;
    let base: string;
    if (observer.character && deadId === observer.character.id) {
      base = observer.character.name; // your own body knows its name
    } else {
      const knowledge = observer.character
        ? await this.store.getKnowledge(observer.character.id, [deadId], e.presentation)
        : new Map();
      const appearance = generateAppearance(e.appearanceSeed);
      base =
        knowledge.get(deadId)?.knownName ??
        (e.presentation === 'hooded' ? describeHooded(appearance) : describeAppearance(appearance));
    }
    return e.objectKind === 'zombie' ? `the walking corpse of ${base}` : `the corpse of ${base}`;
  }

  // -------------------------------------------------------------------------
  // Intents
  // -------------------------------------------------------------------------

  private handleMove(conn: ConnState, msg: Extract<ClientMessage, { t: 'move' }>): void {
    if (conn.entityId === null) return this.fail(conn, 'not_in_world', 'enter the world first');
    this.world.setMoveIntent(conn.entityId, msg.dir);
  }

  /**
   * Speech (M2): proximity channels with line of sight; asterisk emotes
   * animate (D-202); an explicit declareAs flag propagates a name — true or
   * false — to everyone in earshot, contested per listener by Insight against
   * Bluff (D-218, D-219). Nothing in any outbound message reveals that the
   * declaration mechanic fired.
   */
  private async handleSay(conn: ConnState, msg: Extract<ClientMessage, { t: 'say' }>): Promise<void> {
    if (conn.entityId === null || !conn.character || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const speaker = this.world.getEntity(conn.entityId)!;
    const areaDef = this.world.getAreaDef(conn.areaId);

    // Riding the body (D-224): while observing, your words leave the zombie's
    // mouth in the undead register — nothing sounds in the grey country.
    if (speaker.ghost && this.bodyObservers.has(conn)) {
      return this.speakThroughBody(conn, msg.text);
    }

    // Emotes: postures persist on the entity, transients play once. Objective
    // within the speaker's plane (D-203 — the living never see a ghost move).
    const emotes = this.emoteParser.parse(msg.text);
    if (emotes.posture || emotes.transients.length > 0) {
      if (emotes.posture) speaker.posture = emotes.posture;
      this.broadcastPlane(conn.areaId, speaker.ghost, {
        t: 'delta',
        tick: this.world.tick,
        events: [
          {
            type: 'entity_emote',
            id: speaker.id,
            posture: emotes.posture ?? undefined,
            transients: emotes.transients,
          },
        ],
      });
    }

    // Language: the speaker must know the tongue they are using.
    const languageId = msg.language ?? 'common';
    const language = this.content.languages.get(languageId);
    if (!language) return this.fail(conn, 'invalid_message', 'no such language');
    if (!conn.character.languages.includes(languageId)) {
      return this.fail(conn, 'invalid_message', 'you do not speak that tongue');
    }

    // Third-party introduction target must be present in the area.
    const introTarget = msg.introduce ? this.world.getEntity(msg.introduce.entityId) : null;
    if (msg.introduce && (!introTarget || this.world.getEntityAreaId(introTarget.id) !== conn.areaId)) {
      return this.fail(conn, 'bad_target', 'they are not here to introduce');
    }

    await this.deliverSpeech({
      speaker,
      areaId: conn.areaId,
      speakerConn: conn,
      channel: msg.channel,
      text: msg.text,
      languageId,
      declareAs: msg.declareAs,
      introduce: msg.introduce && introTarget ? { target: introTarget, name: msg.introduce.name } : undefined,
    });
    this.countDeed(conn);
    await this.seanceRelays(conn, speaker, msg.text, languageId, msg.channel);
  }

  /** The observing dead speak through the zombie, garbled into the undead
   * register by the language scrambler (D-224). Logged in the original. */
  private async speakThroughBody(conn: ConnState, text: string): Promise<void> {
    const zombieId = this.bodyObservers.get(conn)!;
    const zombie = this.world.getEntity(zombieId);
    const areaId = zombie ? this.world.getEntityAreaId(zombieId) : undefined;
    if (!zombie || !areaId) {
      this.bodyObservers.delete(conn);
      this.send(conn, { t: 'observing', on: false });
      return this.fail(conn, 'bad_target', 'your body no longer walks');
    }
    const languageId = this.content.languages.has('undead') ? 'undead' : 'common';
    await this.deliverSpeech({ speaker: zombie, areaId, channel: 'say', text, languageId });
    // You hear what the body made of your words.
    this.send(conn, {
      t: 'speech',
      speakerId: zombieId,
      channel: 'say',
      text: scrambleSpeech(text, 'undead'),
      language: 'unknown',
      speakerDescriptor: 'your own dead mouth',
    });
    this.countDeed(conn);
  }

  /**
   * The sanctioned crossing (D-204): a séance bridges exactly one caster and
   * one spirit. Questions cross to the grey country; answers come back out of
   * the corpse's mouth for anyone nearby to hear. Both directions are logged.
   */
  private async seanceRelays(
    conn: ConnState,
    speaker: WorldEntity,
    text: string,
    languageId: string,
    channel: Channel,
  ): Promise<void> {
    const asCaster = this.seancesByCaster.get(conn);
    if (asCaster && !speaker.ghost) {
      const corpse = this.world.getEntity(asCaster.corpseEntityId);
      if (!corpse || this.world.getEntityAreaId(corpse.id) !== conn.areaId ||
          chebyshev(speaker.pos, corpse.pos) > CHANNEL_RANGE.say) {
        this.endSeance(asCaster, 'the circle was broken');
      } else if (asCaster.questionsLeft > 0) {
        asCaster.questionsLeft--;
        const spirit = asCaster.spirit;
        const understands = spirit.character!.languages.includes(languageId);
        const language = this.content.languages.get(languageId)!;
        this.send(spirit, {
          t: 'speech',
          speakerId: speaker.id,
          channel: 'say',
          text: understands ? text : scrambleSpeech(text, languageId),
          language: understands ? language.name : 'unknown',
          speakerDescriptor: await this.descriptorFor(spirit, speaker),
        });
        this.send(conn, { t: 'seance', role: 'caster', active: true, questionsLeft: asCaster.questionsLeft });
        this.send(spirit, { t: 'seance', role: 'spirit', active: true, questionsLeft: asCaster.questionsLeft });
        await this.store.appendEvent('seance_question', {
          corpseId: asCaster.corpseId,
          caster: conn.character!.id,
          text,
        });
      }
      return;
    }
    const asSpirit = this.seancesBySpirit.get(conn);
    if (asSpirit && speaker.ghost && channel !== 'whisper') {
      const corpse = this.world.getEntity(asSpirit.corpseEntityId);
      const corpseAreaId = corpse ? this.world.getEntityAreaId(corpse.id) : undefined;
      if (corpse && corpseAreaId) {
        // The corpse speaks with the dead player's words — under no oath.
        await this.deliverSpeech({ speaker: corpse, areaId: corpseAreaId, channel: 'say', text, languageId });
        await this.store.appendEvent('seance_answer', {
          corpseId: asSpirit.corpseId,
          characterId: conn.character!.id,
          text,
        });
      }
      if (asSpirit.questionsLeft <= 0) {
        this.endSeance(asSpirit, 'the five questions are spent');
      }
    }
  }

  /**
   * The speech pipeline, shared by players, possessed NPCs (DM console) and
   * scripts. Declarations and introductions require a speaking character —
   * NPC speech carries neither.
   */
  private async deliverSpeech(opts: {
    speaker: WorldEntity;
    areaId: string;
    speakerConn?: ConnState;
    channel: Channel;
    text: string;
    languageId: string;
    declareAs?: string;
    introduce?: { target: WorldEntity; name: string };
  }): Promise<void> {
    const { speaker, areaId, speakerConn, channel, text, languageId } = opts;
    const language = this.content.languages.get(languageId)!;
    const areaDef = this.world.getAreaDef(areaId);
    const speakerCharacter = speakerConn?.character ?? null;
    const range = CHANNEL_RANGE[channel];
    const declaring = opts.declareAs !== undefined && speakerCharacter !== null;
    const truthful = declaring
      ? opts.declareAs!.toLowerCase() === speakerCharacter!.name.toLowerCase()
      : true;
    const introTarget = opts.introduce?.target ?? null;

    for (const listener of this.connsByArea.get(areaId) ?? []) {
      if (!listener.character || listener.entityId === null) continue;
      const listenerEntity = this.world.getEntity(listener.entityId)!;
      if (listenerEntity.ghost !== speaker.ghost) continue; // planes never overhear
      const isSelf = listener === speakerConn;
      let seen = true;
      if (!isSelf) {
        if (chebyshev(speaker.pos, listenerEntity.pos) > range) continue;
        seen = hasLineOfSight(areaDef, listenerEntity.pos, speaker.pos);
        // Whispers and speech need sight; a shout carries around walls.
        if (!seen && channel !== 'shout') continue;
      }

      // Comprehension: unknown tongues arrive scrambled — the real words
      // never reach that client. Names only propagate through understanding.
      const understands = isSelf || listener.character.languages.includes(languageId);
      const heardText = understands ? text : scrambleSpeech(text, languageId);

      // Resolve the descriptor BEFORE any knowledge update: the line reads as
      // the listener knew the speaker at the moment of hearing.
      const descriptor = isSelf
        ? speakerCharacter!.name
        : seen
          ? await this.descriptorFor(listener, speaker)
          : 'a voice from somewhere unseen';

      let impression: 'rings_false' | 'certain_false' | undefined;
      if (declaring && !isSelf && seen && understands) {
        const result = resolveNameContest({
          truthful,
          speakerBluff: speakerCharacter!.bluff,
          listenerInsight: listener.character.insight,
          rng: this.contestRng,
        });
        impression = result ?? undefined;
        // The name attaches to the speaker AS PRESENTED — a name given while
        // hooded belongs to the hooded thread (D-219).
        await this.store.upsertKnowledge({
          observerCharacterId: listener.character.id,
          subjectCharacterId: speakerCharacter!.id,
          presentation: speaker.presentation,
          knownName: opts.declareAs!,
          provenance: 'self_claimed',
          impression: result,
        });
      }

      // "This is X": attaches to the target's presented identity, provenance
      // third_party, never overwriting a name the listener already holds.
      if (opts.introduce && introTarget && introTarget.characterId !== null && !isSelf && seen &&
          understands && listener.character.id !== introTarget.characterId) {
        const existing = await this.store.getKnowledge(
          listener.character.id,
          [introTarget.characterId],
          introTarget.presentation,
        );
        if (!existing.get(introTarget.characterId)?.knownName) {
          await this.store.upsertKnowledge({
            observerCharacterId: listener.character.id,
            subjectCharacterId: introTarget.characterId,
            presentation: introTarget.presentation,
            knownName: opts.introduce.name,
            provenance: 'third_party',
            impression: null,
          });
        }
      }

      this.send(listener, {
        t: 'speech',
        speakerId: speaker.id,
        channel,
        text: heardText,
        language: understands ? language.name : 'unknown',
        speakerDescriptor: descriptor,
        ...(impression ? { impression } : {}),
      });
    }

    // The dead may ride their walking bodies (D-224): whatever the zombie
    // hears within earshot, its owner hears through dead ears.
    if (!speaker.ghost) {
      for (const [obsConn, zombieId] of this.bodyObservers) {
        if (!obsConn.character || speaker.id === zombieId) continue;
        const zombie = this.world.getEntity(zombieId);
        if (!zombie || this.world.getEntityAreaId(zombieId) !== areaId) continue;
        if (chebyshev(speaker.pos, zombie.pos) > range) continue;
        const seen = hasLineOfSight(areaDef, zombie.pos, speaker.pos);
        if (!seen && channel !== 'shout') continue;
        const understands = obsConn.character.languages.includes(languageId);
        this.send(obsConn, {
          t: 'speech',
          speakerId: speaker.id,
          channel,
          text: understands ? text : scrambleSpeech(text, languageId),
          language: understands ? language.name : 'unknown',
          speakerDescriptor: seen
            ? await this.descriptorFor(obsConn, speaker)
            : 'a voice from somewhere unseen',
        });
      }
    }

    // Chat is logged in full and in the original tongue (D-215).
    await this.store.appendEvent('speech', {
      ...(speakerCharacter ? { characterId: speakerCharacter.id } : { npcEntityId: speaker.id }),
      areaId,
      channel,
      language: languageId,
      text,
      ...(declaring ? { declaredAs: opts.declareAs, truthful } : {}),
      ...(opts.introduce && introTarget
        ? { introduced: introTarget.characterId, asName: opts.introduce.name }
        : {}),
    });
  }

  // -------------------------------------------------------------------------
  // DM & script surface (D-109, D-216) — used by the Lua host and the admin
  // console. Everything here is server-authoritative narration and staging.
  // -------------------------------------------------------------------------

  spawnNpc(
    areaId: string,
    opts: { x: number; y: number; descriptor: string; appearanceSeed?: number },
  ): number {
    if (!this.world.hasArea(areaId)) throw new Error(`no such area '${areaId}'`);
    const { entity } = this.world.spawn(areaId, {
      characterId: null,
      name: opts.descriptor,
      npcDescriptor: opts.descriptor,
      appearanceSeed: opts.appearanceSeed ?? Math.abs((opts.x * 7919) ^ (opts.y * 104729)),
      pos: { x: opts.x, y: opts.y },
    });
    this.broadcastPlane(areaId, false, {
      t: 'delta',
      tick: this.world.tick,
      events: [{ type: 'entity_entered', entity: toWireEntity(entity, opts.descriptor) }],
    });
    return entity.id;
  }

  despawnEntity(entityId: number): boolean {
    const entity = this.world.getEntity(entityId);
    if (!entity || entity.characterId !== null) return false; // players leave by disconnecting
    const areaId = this.world.getEntityAreaId(entityId)!;
    const event = this.world.despawn(entityId);
    if (event) this.broadcastPlane(areaId, entity.ghost, { t: 'delta', tick: this.world.tick, events: [event] });
    return true;
  }

  /** Possessed or scripted speech: the NPC speaks through the same pipeline
   * players use — earshot, sight, and languages all apply (D-216 puppeteering). */
  async speakAs(entityId: number, text: string, channel: Channel = 'say'): Promise<boolean> {
    const speaker = this.world.getEntity(entityId);
    const areaId = this.world.getEntityAreaId(entityId);
    if (!speaker || !areaId || speaker.characterId !== null) return false;
    const emotes = this.emoteParser.parse(text);
    if (emotes.posture || emotes.transients.length > 0) {
      if (emotes.posture) speaker.posture = emotes.posture;
      // NPCs live on the living plane — ghosts must not see them move (D-203).
      this.broadcastPlane(areaId, false, {
        t: 'delta',
        tick: this.world.tick,
        events: [{ type: 'entity_emote', id: speaker.id, posture: emotes.posture ?? undefined, transients: emotes.transients }],
      });
    }
    await this.deliverSpeech({ speaker, areaId, channel, text, languageId: 'common' });
    return true;
  }

  moveEntity(entityId: number, dir: Parameters<World['setMoveIntent']>[1]): void {
    this.world.setMoveIntent(entityId, dir);
  }

  /** Accepts a character uuid, or the name of a character currently online. */
  private async resolveCharacterRef(ref: string): Promise<CharacterRecord | null> {
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ref)) {
      const direct = await this.store.getCharacter(ref);
      if (direct) return direct;
    }
    for (const conn of this.conns) {
      if (conn.character && conn.character.name.toLowerCase() === ref.toLowerCase()) {
        return conn.character;
      }
    }
    return null;
  }

  /** DM faucet (admin/testing only — production goods enter via play, D-220).
   * Grants an item and refreshes the holder's client if online. */
  async adminGrantItem(
    ref: string,
    templateId: string,
    qty: number,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.content.itemTemplates.has(templateId)) {
      return { ok: false, error: `no such item template '${templateId}'` };
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
      return { ok: false, error: 'qty must be an integer 1-1000' };
    }
    const character = await this.resolveCharacterRef(ref);
    if (!character) {
      return { ok: false, error: 'no such character (offline characters need the uuid)' };
    }
    await this.store.grantItem(character.id, templateId, qty);
    await this.store.appendEvent('dm_grant_item', { characterId: character.id, templateId, qty });
    const conn = this.findConnByCharacter(character.id);
    if (conn) await this.sendInventory(conn);
    return { ok: true };
  }

  /** DM skill tuning (bluff/insight/necromancy), live-applied when online. */
  async adminSetSkills(
    ref: string,
    skills: { bluff?: number; insight?: number; necromancy?: number },
  ): Promise<{ ok: boolean; error?: string }> {
    for (const v of Object.values(skills)) {
      if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 100)) {
        return { ok: false, error: 'skills are integers 0-100' };
      }
    }
    const character = await this.resolveCharacterRef(ref);
    if (!character) {
      return { ok: false, error: 'no such character (offline characters need the uuid)' };
    }
    await this.store.setCharacterSkills(character.id, skills);
    const conn = this.findConnByCharacter(character.id);
    if (conn?.character) {
      if (skills.bluff !== undefined) conn.character.bluff = skills.bluff;
      if (skills.insight !== undefined) conn.character.insight = skills.insight;
      if (skills.necromancy !== undefined) conn.character.necromancy = skills.necromancy;
    }
    await this.store.appendEvent('dm_set_skills', { characterId: character.id, ...skills });
    return { ok: true };
  }

  /** Scene narration with no in-world speaker (D-216). */
  narrate(scope: 'global' | 'area', text: string, areaId?: string): void {
    const message = { t: 'narrate' as const, text };
    if (scope === 'global') {
      for (const conn of this.conns) {
        if (conn.entityId !== null) this.send(conn, message);
      }
    } else if (areaId) {
      this.broadcast(areaId, message);
    }
  }

  /** DM mood/weather control: overrides the area's authored lighting live. */
  setAreaLighting(areaId: string, lighting: AreaDef['lighting']): void {
    if (!this.world.hasArea(areaId)) throw new Error(`no such area '${areaId}'`);
    this.lightingOverrides.set(areaId, lighting);
    this.broadcast(areaId, { t: 'area_lighting', lighting });
  }

  playerCountIn(areaId: string): number {
    return this.connsByArea.get(areaId)?.size ?? 0;
  }

  private transitionsFor(areaId: string): AreaDef['transitions'] {
    const def = this.world.getAreaDef(areaId);
    const overlay = this.runtimeTransitions.get(areaId);
    return overlay ? [...def.transitions, ...overlay] : def.transitions;
  }

  getAreaLightingOverride(areaId: string): AreaDef['lighting'] | null {
    return this.lightingOverrides.get(areaId) ?? null;
  }

  /** Reverts to the authored profile (rollback path). */
  clearAreaLighting(areaId: string): void {
    this.lightingOverrides.delete(areaId);
    if (this.world.hasArea(areaId)) {
      this.broadcast(areaId, { t: 'area_lighting', lighting: this.world.getAreaDef(areaId).lighting });
    }
  }

  /**
   * Spawns a temporary area cloned from a content area, linked by a runtime
   * way-marker in a host area (D-216). Travellers arrive at the clone's
   * spawn; a back-exit sits beside it, returning next to the host marker.
   */
  async spawnTempArea(
    fromAreaId: string,
    tempId: string,
    name: string,
    link: { areaId: string; x: number; y: number },
  ): Promise<void> {
    const source = this.content.areas.get(fromAreaId);
    if (!source) throw new Error(`no such source area '${fromAreaId}'`);
    if (this.world.hasArea(tempId)) throw new Error(`area id '${tempId}' already exists`);
    if (!this.world.hasArea(link.areaId)) throw new Error(`no such host area '${link.areaId}'`);

    const walkable = (def: AreaDef, x: number, y: number) =>
      x >= 0 && y >= 0 && x < def.width && y < def.height &&
      def.legend[def.tiles[y]![x]!]!.walkable;
    const neighborOf = (def: AreaDef, x: number, y: number) => {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (walkable(def, x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
      return { x: def.spawn.x, y: def.spawn.y };
    };

    const hostDef = this.world.getAreaDef(link.areaId);
    if (!walkable(hostDef, link.x, link.y)) {
      throw new Error(`link tile (${link.x},${link.y}) in '${link.areaId}' is not walkable`);
    }
    const backExit = neighborOf(source, source.spawn.x, source.spawn.y);
    const returnTo = neighborOf(hostDef, link.x, link.y);
    const def: AreaDef = {
      ...source,
      id: tempId,
      name,
      transitions: [{ x: backExit.x, y: backExit.y, toArea: link.areaId, toX: returnTo.x, toY: returnTo.y }],
      scripts: [],
    };
    this.world.addArea(def);
    this.tempAreaDefs.set(tempId, def);
    let overlay = this.runtimeTransitions.get(link.areaId);
    if (!overlay) this.runtimeTransitions.set(link.areaId, (overlay = []));
    overlay.push({ x: link.x, y: link.y, toArea: tempId, toX: source.spawn.x, toY: source.spawn.y });
    // Host-area players see the new way-marker via a fresh snapshot.
    for (const conn of this.connsByArea.get(link.areaId) ?? []) await this.sendSnapshot(conn);
  }

  /** Tears a temporary area down: evacuate players, unlink, remove (rollback). */
  async removeTempArea(tempId: string): Promise<void> {
    if (!this.tempAreaDefs.has(tempId)) return;
    for (const conn of [...(this.connsByArea.get(tempId) ?? [])]) {
      const home = this.world.hasArea(this.defaultAreaId) ? this.defaultAreaId : tempId;
      const spawn = this.world.getAreaDef(home).spawn;
      await this.transferToArea(conn, home, spawn.x, spawn.y);
    }
    this.connsByArea.delete(tempId);
    for (const entity of this.world.entitiesIn(tempId)) this.world.despawn(entity.id);
    this.world.removeArea(tempId);
    this.tempAreaDefs.delete(tempId);
    this.lightingOverrides.delete(tempId);
    for (const [hostId, overlay] of this.runtimeTransitions) {
      const kept = overlay.filter((t) => t.toArea !== tempId);
      if (kept.length !== overlay.length) {
        this.runtimeTransitions.set(hostId, kept);
        for (const conn of this.connsByArea.get(hostId) ?? []) await this.sendSnapshot(conn);
      }
    }
  }

  /** Hood up, hood down (D-219). Lowering the hood in view IS the pierce:
   * everyone watching merges the hooded thread into the real one. */
  private async handleSetPresentation(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'set_presentation' }>,
  ): Promise<void> {
    if (conn.entityId === null || !conn.character || !conn.areaId) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const entity = this.world.getEntity(conn.entityId)!;
    if (entity.presentation === msg.state) return;
    const wasHooded = entity.presentation === 'hooded';
    entity.presentation = msg.state;
    const areaDef = this.world.getAreaDef(conn.areaId);

    // Plane-partitioned (D-203): the living must not see a ghost's hood move.
    this.broadcastPlane(conn.areaId, entity.ghost, {
      t: 'delta',
      tick: this.world.tick,
      events: [{ type: 'entity_presentation', id: entity.id, state: msg.state }],
    });

    for (const other of this.connsByArea.get(conn.areaId) ?? []) {
      if (other === conn || !other.character || other.entityId === null) continue;
      const otherEntity = this.world.getEntity(other.entityId)!;
      if (otherEntity.ghost !== entity.ghost) continue;
      const sees = hasLineOfSight(areaDef, otherEntity.pos, entity.pos);
      if (wasHooded && msg.state === 'normal' && sees) {
        await this.store.mergeKnowledge(other.character.id, conn.character.id, 'hooded');
      }
      // Refresh what this observer calls them, post-merge.
      this.send(other, {
        t: 'descriptor',
        entityId: entity.id,
        descriptor: await this.descriptorFor(other, entity),
      });
    }
    await this.store.appendEvent('presentation_change', {
      characterId: conn.character.id,
      state: msg.state,
      areaId: conn.areaId,
    });
  }

  /** Writing consumes parchment and produces a note carrying its words —
   * a physical, givable, stealable object (M2; D-213 rides this later). */
  private async handleWrite(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'write' }>,
  ): Promise<void> {
    if (conn.entityId === null || !conn.character) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const consumed = await this.store.consumeOneItem(conn.character.id, 'parchment');
    if (!consumed) return this.fail(conn, 'no_such_item', 'nothing to write on');
    await this.store.grantItem(conn.character.id, 'written-note', 1, {
      title: msg.title,
      text: msg.text,
    });
    await this.store.appendEvent('item_written', {
      characterId: conn.character.id,
      title: msg.title,
      text: msg.text,
    });
    await this.sendInventory(conn);
  }

  private async handleReadItem(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'read_item' }>,
  ): Promise<void> {
    if (conn.entityId === null || !conn.character) {
      return this.fail(conn, 'not_in_world', 'enter the world first');
    }
    const item = await this.store.getItem(msg.itemId);
    if (!item || item.ownerCharacterId !== conn.character.id) {
      return this.fail(conn, 'no_such_item', 'you do not hold that');
    }
    if (!item.data?.text) return this.fail(conn, 'no_such_item', 'nothing is written on it');
    this.send(conn, {
      t: 'item_text',
      itemId: item.id,
      title: item.data.title ?? '',
      text: item.data.text,
    });
  }

  private async handleGive(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'give' }>,
  ): Promise<void> {
    const target = this.interactionTarget(conn, msg.toEntityId);
    if (!target) return;
    const ok = await this.store.transferItem(msg.itemId, conn.character!.id, target.characterId);
    if (!ok) return this.fail(conn, 'no_such_item', 'you do not hold that item');
    await this.store.appendEvent('item_transfer', {
      itemId: msg.itemId,
      from: conn.character!.id,
      to: target.characterId,
      areaId: conn.areaId,
    });
    await this.sendInventory(conn);
    if (target.conn) await this.sendInventory(target.conn);
  }

  private async handlePay(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'pay' }>,
  ): Promise<void> {
    const target = this.interactionTarget(conn, msg.toEntityId);
    if (!target) return;
    const ok = await this.store.transferCoin(conn.character!.id, target.characterId, msg.amount);
    if (!ok) return this.fail(conn, 'insufficient_funds', 'not enough coin');
    await this.store.appendEvent('coin_transfer', {
      from: conn.character!.id,
      to: target.characterId,
      amount: msg.amount,
      areaId: conn.areaId,
    });
    await this.sendInventory(conn);
    if (target.conn) await this.sendInventory(target.conn);
  }

  /** Resolves an interaction target: in-world, same area, adjacent, not self. */
  private interactionTarget(
    conn: ConnState,
    toEntityId: number,
  ): { characterId: string; conn: ConnState | null } | null {
    if (conn.entityId === null || !conn.character) {
      this.fail(conn, 'not_in_world', 'enter the world first');
      return null;
    }
    const self = this.world.getEntity(conn.entityId);
    const target = this.world.getEntity(toEntityId);
    if (!self || !target || toEntityId === conn.entityId) {
      this.fail(conn, 'bad_target', 'no such entity');
      return null;
    }
    if (this.world.getEntityAreaId(toEntityId) !== conn.areaId) {
      this.fail(conn, 'bad_target', 'they are not here');
      return null;
    }
    if (chebyshev(self.pos, target.pos) > INTERACT_RANGE) {
      this.fail(conn, 'not_adjacent', 'too far away');
      return null;
    }
    if (target.characterId === null) {
      // NPCs have no inventory or purse yet — trade with them arrives in M5.
      this.fail(conn, 'bad_target', 'they cannot take that');
      return null;
    }
    const targetConn =
      [...(this.connsByArea.get(conn.areaId!) ?? [])].find((c) => c.entityId === toEntityId) ?? null;
    return { characterId: target.characterId, conn: targetConn };
  }

  private async sendInventory(conn: ConnState): Promise<void> {
    if (!conn.character) return;
    const items = await this.store.getItemsByCharacter(conn.character.id);
    const coin = await this.store.getCoin(conn.character.id);
    this.send(conn, { t: 'inventory', items: items.map(toWireItem), coin });
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private send(conn: ConnState, msg: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private broadcast(areaId: string, msg: ServerMessage, except?: ConnState): void {
    const conns = this.connsByArea.get(areaId);
    if (!conns) return;
    const payload = JSON.stringify(msg);
    for (const conn of conns) {
      if (conn !== except && conn.ws.readyState === conn.ws.OPEN) conn.ws.send(payload);
    }
  }

  private fail(conn: ConnState, code: ErrorCode, message: string): void {
    this.send(conn, { t: 'error', code, message });
  }
}

/** Greedy step direction from movement signs (screen-space: +x e, +y s). */
function directionFrom(dx: number, dy: number): Direction {
  if (dy < 0) return dx < 0 ? 'nw' : dx > 0 ? 'ne' : 'n';
  if (dy > 0) return dx < 0 ? 'sw' : dx > 0 ? 'se' : 's';
  return dx < 0 ? 'w' : 'e';
}

function toWireItem(i: {
  id: string;
  templateId: string;
  qty: number;
  data: { title?: string } | null;
}): { id: string; templateId: string; qty: number; label?: string } {
  return {
    id: i.id,
    templateId: i.templateId,
    qty: i.qty,
    ...(i.data?.title ? { label: i.data.title } : {}),
  };
}

function toSummary(c: CharacterRecord): CharacterSummary {
  return {
    id: c.id,
    name: c.name,
    areaId: c.areaId,
    x: c.x,
    y: c.y,
    appearanceSeed: c.appearanceSeed,
    ...(c.classId ? { classId: c.classId } : {}),
  };
}
