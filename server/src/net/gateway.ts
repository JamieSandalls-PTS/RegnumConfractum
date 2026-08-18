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
} from '@rc/shared';
import { hashPassword, newSessionToken, verifyPassword } from '../auth';
import type { Content } from '../content';
import type { CharacterRecord, InjuryRecord, Store } from '../store/types';
import { World, toWireEntity, type WorldEntity } from '../game/world';
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
  log?: (msg: string) => void;
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
            if (conn && this.confirmEndgameEntry(conn, areaId, event.x, event.y, tr.toArea)) {
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
    this.onTickHook?.(this.world.tick);
    if (this.world.tick % FLUSH_INTERVAL_TICKS === 0) {
      await this.flushDirty();
    }
  }

  /**
   * The unmissable warning (D-206): the first step onto a way-marker into an
   * endgame area does NOT cross — it warns. Stepping off and back on within
   * the window confirms. Ghosts pass freely; they have nothing left to lose.
   */
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
      injuries: conn.injuries.map((i) => ({
        id: i.id,
        location: i.location,
        kind: i.kind,
        severity: i.severity,
      })),
    });
  }

  /** XP pays down death debt before it advances the character (D-203). */
  private gainXp(conn: ConnState, amount: number): void {
    if (!conn.vitals) return;
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
    // Zone rules (D-206): NPCs are fair game; players are protected in
    // settled zones unless hostility was declared and the window has passed.
    if (target.characterId !== null) {
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
    this.broadcastPlane(conn.areaId, false, {
      t: 'delta',
      tick: this.world.tick,
      events: [{ type: 'entity_attacked', attackerId: self.id, targetId: target.id, damage }],
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
      this.gainXp(conn, 25);
      this.countDeed(conn, 5);
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
    conn.vitals.deathDebt += DEATH_DEBT_PER_DEATH;
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
