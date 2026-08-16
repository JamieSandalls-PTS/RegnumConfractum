import { WebSocketServer, type WebSocket } from 'ws';
import {
  FLUSH_INTERVAL_TICKS,
  INTERACT_RANGE,
  Rng,
  SESSION_TTL_MS,
  TICK_MS,
  chebyshev,
  describeAppearance,
  describeHooded,
  generateAppearance,
  parseClientMessage,
  type AreaDef,
  type Channel,
  type CharacterSummary,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '@rc/shared';
import { hashPassword, newSessionToken, verifyPassword } from '../auth';
import type { Content } from '../content';
import type { CharacterRecord, Store } from '../store/types';
import { World, toWireEntity, type WorldEntity } from '../game/world';
import { EmoteParser } from '../game/emotes';
import { hasLineOfSight } from '../game/los';
import { resolveNameContest } from '../game/contest';
import { scrambleSpeech } from '../game/language';

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
  log?: (msg: string) => void;
}

interface ConnState {
  ws: WebSocket;
  accountId: string | null;
  character: CharacterRecord | null;
  entityId: number | null;
  areaId: string | null;
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
  /** Script-host hooks — wired by the entrypoint, no-ops otherwise. */
  onAreaEnter: ((areaId: string, entityId: number) => void) | null = null;
  onTickHook: ((tick: number) => void) | null = null;

  constructor(opts: GameServerOptions) {
    this.store = opts.store;
    this.content = opts.content;
    this.tickIntervalMs = opts.tickIntervalMs ?? TICK_MS;
    this.log = opts.log ?? (() => {});
    this.emoteParser = new EmoteParser(opts.content.emoteLexicon);
    this.contestRng = new Rng(opts.rngSeed ?? Math.floor(Math.random() * 2 ** 31));
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
          const tr = def.transitions.find((t) => t.x === event.x && t.y === event.y);
          if (tr) {
            const conn = [...(this.connsByArea.get(areaId) ?? [])].find(
              (c) => c.entityId === event.id,
            );
            if (conn) transfers.push({ conn, toArea: tr.toArea, toX: tr.toX, toY: tr.toY });
          }
        }
      }
      this.broadcast(areaId, { t: 'delta', tick: this.world.tick, events });
    }
    for (const t of transfers) {
      await this.transferToArea(t.conn, t.toArea, t.toX, t.toY);
    }
    this.onTickHook?.(this.world.tick);
    if (this.world.tick % FLUSH_INTERVAL_TICKS === 0) {
      await this.flushDirty();
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
      this.broadcast(oldAreaId, { t: 'delta', tick: this.world.tick, events: [leftEvent] });
    }
    const { entity } = this.world.spawn(toAreaId, {
      characterId: conn.character.id,
      name: conn.character.name,
      appearanceSeed: conn.character.appearanceSeed,
      pos: { x, y },
      facing: oldEntity.facing,
    });
    entity.presentation = oldEntity.presentation; // the hood survives the door
    conn.entityId = entity.id;
    conn.areaId = toAreaId;
    this.entityCharacter.set(entity.id, conn.character.id);
    for (const other of this.connsByArea.get(toAreaId) ?? []) {
      if (!other.character) continue;
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
    switch (msg.t) {
      case 'register':
        return this.handleRegister(conn, msg);
      case 'login':
        return this.handleLogin(conn, msg);
      case 'resume':
        return this.handleResume(conn, msg);
      case 'create_character':
        return this.handleCreateCharacter(conn, msg);
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
      case 'resync':
        return this.handleResync(conn);
      case 'ping':
        this.send(conn, { t: 'pong', nonce: msg.nonce, tick: this.world.tick });
        return;
    }
  }

  private async handleDisconnect(conn: ConnState): Promise<void> {
    if (!this.conns.has(conn)) return;
    this.conns.delete(conn);
    if (conn.entityId !== null && conn.areaId !== null && conn.character) {
      const entity = this.world.getEntity(conn.entityId);
      const event = this.world.despawn(conn.entityId);
      this.entityCharacter.delete(conn.entityId);
      this.connsByArea.get(conn.areaId)?.delete(conn);
      this.onlineCharacters.delete(conn.character.id);
      if (event) this.broadcast(conn.areaId, { t: 'delta', tick: this.world.tick, events: [event] });
      if (entity) {
        // Immediate write on logout (D-106).
        this.dirtyCharacters.delete(conn.character.id);
        try {
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
      characters: characters.map(toSummary),
    });
  }

  // -------------------------------------------------------------------------
  // Characters and world entry
  // -------------------------------------------------------------------------

  private async handleCreateCharacter(
    conn: ConnState,
    msg: Extract<ClientMessage, { t: 'create_character' }>,
  ): Promise<void> {
    if (!conn.accountId) return this.fail(conn, 'not_authenticated', 'log in first');
    const area = this.content.areas.get(this.defaultAreaId)!;
    const seed = msg.appearanceSeed ?? Math.floor(Math.random() * 2 ** 31);
    const character = await this.store.createCharacter({
      accountId: conn.accountId,
      name: msg.name,
      appearanceSeed: seed,
      areaId: area.id,
      x: area.spawn.x,
      y: area.spawn.y,
    });
    if (character === 'character_name_taken') {
      return this.fail(conn, 'character_name_taken', 'that name is taken');
    }
    await this.store.appendEvent('character_created', {
      characterId: character.id,
      accountId: conn.accountId,
      name: character.name,
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
    if (!character || character.accountId !== conn.accountId) {
      return this.fail(conn, 'no_such_character', 'no such character on this account');
    }
    if (this.onlineCharacters.has(character.id)) {
      return this.fail(conn, 'already_in_world', 'character is already online');
    }
    const areaId = this.world.hasArea(character.areaId) ? character.areaId : this.defaultAreaId;
    const { entity } = this.world.spawn(areaId, {
      characterId: character.id,
      name: character.name,
      appearanceSeed: character.appearanceSeed,
      pos: { x: character.x, y: character.y },
    });
    conn.character = character;
    conn.entityId = entity.id;
    conn.areaId = areaId;
    this.entityCharacter.set(entity.id, character.id);
    this.onlineCharacters.add(character.id);
    // entity_entered is personalized: each observer gets the arrival under
    // the descriptor THEY know (D-219) — a name if learned, else what they see.
    for (const other of this.connsByArea.get(areaId) ?? []) {
      if (other === conn || !other.character) continue;
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
    const entities = this.world.entitiesIn(areaId);
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
        transitions: def.transitions.map(({ x, y }) => ({ x, y })),
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
      if (e.characterId === null) {
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

    // Emotes: postures persist on the entity, transients play once. Objective
    // and broadcast to the whole area.
    const emotes = this.emoteParser.parse(msg.text);
    if (emotes.posture || emotes.transients.length > 0) {
      if (emotes.posture) speaker.posture = emotes.posture;
      this.broadcast(conn.areaId, {
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
    this.broadcast(areaId, {
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
    if (event) this.broadcast(areaId, { t: 'delta', tick: this.world.tick, events: [event] });
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
      this.broadcast(areaId, {
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

    this.broadcast(conn.areaId, {
      t: 'delta',
      tick: this.world.tick,
      events: [{ type: 'entity_presentation', id: entity.id, state: msg.state }],
    });

    for (const other of this.connsByArea.get(conn.areaId) ?? []) {
      if (other === conn || !other.character || other.entityId === null) continue;
      const otherEntity = this.world.getEntity(other.entityId)!;
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
  };
}
