import {
  DIRECTION_VECTORS,
  DIRECTIONS,
  Nav,
  TICK_RATE,
  speedFor,
  areaCollision,
  canStandAt,
  distance,
  stepTo,
  type AppearanceOverride,
  type CharacterLook,
  type AreaDef,
  type Direction,
  type WornLook,
  type Posture,
  type Presentation,
  type SimEvent,
  type Vec2,
  type WireEntity,
} from '@rc/shared';

/**
 * The authoritative simulation (D-102, D-103, D-104). Pure and deterministic:
 * no wall clock, no Math.random, no I/O. Advancing is explicit via step(), so
 * the harness can run it headlessly and reproduce any sequence exactly.
 */

export interface WorldEntity {
  id: number;
  /** Null for NPCs — they have no character record or connection. */
  characterId: string | null;
  /** The character's true name — server-side knowledge only. What observers
   * see is resolved per observer via identity knowledge (D-219). */
  name: string;
  /** NPCs carry a fixed public descriptor, the same for every observer.
   * (NPC identity mechanics deferred — see D-507.) */
  npcDescriptor?: string;
  /** The built character this is drawn as (D-594), when its content says. */
  model?: string;
  /**
   * Which `content/npcs/` definition put this person here (D-598).
   *
   * ⚠ Server-side only and never on the wire: what a player learns about
   * somebody is the descriptor, and an id beside it would be a name the
   * game hands out for free. It exists so the spawner can tell whether a
   * declared NPC is already standing there, which matching on descriptor
   * would only approximate.
   */
  npcType?: string;
  /**
   * World objects born of death (D-224/D-511): a lying corpse, a scatter of
   * dropped gear, or a walking corpse. Null for everything else. Zombies go
   * out on the wire as 'npc'; corpse and pile have wire kinds of their own.
   */
  objectKind?: 'corpse' | 'pile' | 'zombie' | 'node' | 'station' | null;
  /**
   * Visibly a thing that attacks people (D-550). Set for roamers, dungeon
   * dwellers and the animated dead; NEVER for a player, whatever they have
   * done. It is the one switch auto-attack reads, so that clicking a tavern
   * keeper — an NPC, and somebody's objective — cannot start a fight.
   */
  hostile?: boolean;
  /**
   * What this character is visibly wearing (D-554). Null until somebody
   * equips something, which is what keeps every NPC and roamer looking
   * exactly as its seed draws it.
   */
  worn?: WornLook | null;
  /** This body or heap holds something (D-554). Set by the gateway, which is
   * the only thing that knows what the store contains. */
  lootable?: boolean;
  /** For stations (D-530): which facility this is. */
  stationType?: string;
  /** The mesh this facility is drawn as (D-583), from its definition. */
  stationArt?: { pack: string; asset: string; rotation: number; scale: number };
  /** For nodes (MR2): which ResourceNodeDef this is, and what it has left. */
  nodeType?: string;
  nodeCharges?: number;
  /** Tick a spent node refills. Null while it still has charges. */
  nodeRefillsAt?: number | null;
  /** The dead character this corpse/pile/zombie belongs to — descriptors for
   * the dead resolve through the same per-observer knowledge as the living. */
  corpseOfCharacterId?: string | null;
  appearanceSeed: number;
  /** Player-authored deviations from the seed (D-539); null for everything
   * the world generates for itself. */
  appearance: AppearanceOverride | null;
  /**
   * The face a player chose (D-574). Null for NPCs, roamers, corpses and
   * every character made before the face step — the renderer then falls back
   * to picking a body from the seed, exactly as it did.
   */
  look?: CharacterLook | null;
  pos: Vec2;
  /** Metres above the ground plane. Set by the collision layer, never by hand. */
  z: number;
  facing: Direction;
  posture: Posture;
  /** On a real seat, not the ground (D-615). Only `sit` sets it. */
  seated: boolean;
  presentation: Presentation;
  /** NPC hit points (players keep theirs on the character record). */
  hp: number;
  /**
   * The dead walk apart (D-203): ghosts see and hear ONLY other ghosts, and
   * the living never perceive ghosts. Every delivery path partitions on this
   * flag — relaxing it turns dead players into free scouts.
   */
  ghost: boolean;
  /** Tick at which the next attack may be made. */
  attackReadyAt: number;
  /**
   * The combat ROUND this entity has been swinging in, and how many swings it
   * has spent (D-550). Both are needed: the count caps the round's budget and
   * `attackReadyAt` spaces the swings inside it, so neither a burst at a round
   * boundary nor an over-spend is possible.
   */
  attackRound: number;
  attacksThisRound: number;
  /**
   * Combat state (stakeholder, 2026-08-18): weapon drawn and held ready.
   * Entered on an attack or a hostility declaration either way; left only
   * when `combatHotUntil` has passed AND no hostile stands within
   * COMBAT_PROXIMITY_TILES. Server-owned so every observer agrees.
   */
  combat: boolean;
  /** Tick before which combat cannot be left, whatever the proximity. */
  combatHotUntil: number;
  /** For corpses: the entity carrying this body, if any. */
  carriedBy: number | null;
  diedAtTick: number | null;
  /** Tick at which the next tile step may be taken. */
  readyAtTick: number;
  /** Latest movement intent; overwritten by newer intents, cleared when applied. */
  intent: Direction | null;
  /**
   * The route being walked, in metres, nearest waypoint first (D-567).
   *
   * The client used to run A* and send one direction per tile, so the client
   * chose the route and the server only vetted each step; around a continuous
   * obstacle the two disagree constantly. Now the client says where and the
   * server decides how.
   */
  route: Vec2[] | null;
}

interface AreaRuntime {
  def: AreaDef;
  entities: Map<number, WorldEntity>;
  /**
   * The navigation index, baked when the area is first walked (D-567).
   *
   * Lazily, and cached: it costs real time on a 100m area and most areas in a
   * test are never walked. Rebuilding it per request would put a hundred
   * milliseconds inside a hundred-millisecond tick.
   */
  nav?: Nav;
}

/** Wire form for a specific observer — the descriptor is their knowledge. */
export function toWireEntity(e: WorldEntity, descriptor: string): WireEntity {
  const kind =
    e.objectKind === 'corpse' ||
    e.objectKind === 'pile' ||
    e.objectKind === 'node' ||
    e.objectKind === 'station'
      ? e.objectKind
      : e.characterId === null
        ? 'npc'
        : 'player';
  return {
    id: e.id,
    descriptor,
    kind,
    x: e.pos.x,
    z: e.z,
    y: e.pos.y,
    facing: e.facing,
    posture: e.posture,
    seated: e.seated,
    presentation: e.presentation,
    appearanceSeed: e.appearanceSeed,
    appearance: e.appearance,
    look: e.look ?? null,
    // What it IS, when it is a thing rather than a person (D-542).
    ...(e.model ? { model: e.model } : {}),
    ...(e.nodeType ? { variant: e.nodeType } : {}),
    ...(e.stationType ? { variant: e.stationType } : {}),
    ...(e.stationArt ? { art: e.stationArt } : {}),
    combat: e.combat,
    worn: e.worn ?? null,
    lootable: e.lootable === true,
    hostile: e.hostile === true && e.characterId === null,
    carriedBy: e.carriedBy,
  };
}

export class World {
  tick = 0;
  private areas = new Map<string, AreaRuntime>();
  private entityArea = new Map<number, string>();
  private nextEntityId = 1;

  addArea(def: AreaDef): void {
    if (this.areas.has(def.id)) throw new Error(`duplicate area '${def.id}'`);
    this.areas.set(def.id, { def, entities: new Map() });
  }

  hasArea(areaId: string): boolean {
    return this.areas.has(areaId);
  }

  /** Removes a (temporary) area. Callers must evacuate entities first. */
  removeArea(areaId: string): void {
    const area = this.areas.get(areaId);
    if (!area) return;
    if (area.entities.size > 0) {
      throw new Error(`removeArea '${areaId}': ${area.entities.size} entities remain`);
    }
    this.areas.delete(areaId);
  }

  getAreaDef(areaId: string): AreaDef {
    return this.mustArea(areaId).def;
  }

  areaIds(): string[] {
    return [...this.areas.keys()];
  }

  entitiesIn(areaId: string): WorldEntity[] {
    return [...this.mustArea(areaId).entities.values()];
  }

  getEntity(entityId: number): WorldEntity | undefined {
    const areaId = this.entityArea.get(entityId);
    if (areaId === undefined) return undefined;
    return this.areas.get(areaId)?.entities.get(entityId);
  }

  getEntityAreaId(entityId: number): string | undefined {
    return this.entityArea.get(entityId);
  }

  /**
   * Spawns at `pos` if walkable, else at the area spawn point. Returns the
   * entity plus the entity_entered event for broadcast.
   */
  spawn(
    areaId: string,
    opts: {
      characterId: string | null;
      name: string;
      npcDescriptor?: string;
      model?: string;
      npcType?: string;
      objectKind?: 'corpse' | 'pile' | 'zombie' | 'node' | 'station';
      hostile?: boolean;
      nodeType?: string;
      nodeCharges?: number;
      stationType?: string;
      stationArt?: { pack: string; asset: string; rotation: number; scale: number };
      corpseOfCharacterId?: string;
      appearanceSeed?: number;
      appearance?: AppearanceOverride | null;
      look?: CharacterLook | null;
      pos: Vec2;
      facing?: Direction;
      hp?: number;
      ghost?: boolean;
    },
  ): { entity: WorldEntity } {
    const area = this.mustArea(areaId);
    // Spawning INTO something is the one case a body may not be moved out of by
    // walking, so it is checked here rather than left to the first step.
    const at = canStandAt(area.def, opts.pos) ? opts.pos : area.def.spawn;
    const entity: WorldEntity = {
      id: this.nextEntityId++,
      characterId: opts.characterId,
      name: opts.name,
      ...(opts.npcDescriptor ? { npcDescriptor: opts.npcDescriptor } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.npcType ? { npcType: opts.npcType } : {}),
      ...(opts.objectKind ? { objectKind: opts.objectKind } : {}),
      ...(opts.hostile ? { hostile: true } : {}),
      ...(opts.corpseOfCharacterId ? { corpseOfCharacterId: opts.corpseOfCharacterId } : {}),
      ...(opts.nodeType ? { nodeType: opts.nodeType, nodeCharges: opts.nodeCharges ?? 1, nodeRefillsAt: null } : {}),
      ...(opts.stationType ? { stationType: opts.stationType } : {}),
      ...(opts.stationArt ? { stationArt: opts.stationArt } : {}),
      appearanceSeed: opts.appearanceSeed ?? 0,
      appearance: opts.appearance ?? null,
      look: opts.look ?? null,
      pos: { ...at },
      z: 0,
      facing: opts.facing ?? 's',
      posture: 'standing',
      seated: false,
      presentation: 'normal',
      hp: opts.hp ?? 10,
      ghost: opts.ghost ?? false,
      attackReadyAt: this.tick,
      attackRound: -1,
      attacksThisRound: 0,
      combat: false,
      combatHotUntil: 0,
      carriedBy: null,
      diedAtTick: null,
      readyAtTick: this.tick,
      intent: null,
      route: null,
    };
    area.entities.set(entity.id, entity);
    this.entityArea.set(entity.id, areaId);
    return { entity };
  }

  /** Applies an emote's posture change; returns the broadcast event. */
  setPosture(entityId: number, posture: Posture): SimEvent | null {
    // ⚠ Leaving `sitting` leaves the SEAT (D-615). Without this a
    // character who stood up off a chair and later sat down in a field
    // was still flagged as seated, and sat in mid-air at chair height.
    const entity = this.getEntity(entityId);
    if (!entity || entity.posture === posture) return null;
    entity.posture = posture;
    if (posture !== 'sitting') entity.seated = false;
    return { type: 'entity_emote', id: entityId, posture, seated: false, transients: [] };
  }

  despawn(entityId: number): SimEvent | null {
    const areaId = this.entityArea.get(entityId);
    if (areaId === undefined) return null;
    this.mustArea(areaId).entities.delete(entityId);
    this.entityArea.delete(entityId);
    return { type: 'entity_left', id: entityId };
  }

  /**
   * Records intent (D-102). Applied on subsequent steps.
   *
   * A DIRECTION is now a short destination -- one stride that way -- rather
   * than a tile hop. That is the bridge that let movement go continuous
   * without rewriting the client and the bots in the same change: they still
   * send a direction and still watch for arrival, and what they get is a metre
   * of smooth walking instead of a teleport to the next tile.
   */
  setMoveIntent(entityId: number, dir: Direction): void {
    const entity = this.getEntity(entityId);
    if (!entity) return;
    entity.intent = dir;
    // Facing is set NOW, not on arrival: turning to look at a wall you cannot
    // walk into is the feedback that tells a player the wall is there, and it
    // is what the tile version did.
    entity.facing = dir;
    const v = DIRECTION_VECTORS[dir];
    // WARNING: the direction vector's OWN length, not a normalised stride. A
    // diagonal covers 1.41m because that is what a diagonal tile step covered,
    // so a caller stepping in eights still lands exactly where it did and
    // arrival checks still fire. Normalising it looks tidier and quietly moves
    // every diagonal destination off the lattice its caller is counting in --
    // the bots then walk forever towards a place they never quite reach.
    //
    // It also makes a diagonal take longer than a cardinal, which is correct
    // and which the grid version got wrong for free.
    entity.route = [{ x: entity.pos.x + v.x * STRIDE, y: entity.pos.y + v.y * STRIDE }];
  }

  /** Walk to a point, by whatever route the area allows (D-567). */
  moveTo(entityId: number, to: Vec2): boolean {
    const entity = this.getEntity(entityId);
    const areaId = entity && this.entityArea.get(entity.id);
    if (!entity || areaId === undefined) return false;
    const route = this.navFor(areaId).path(entity.pos, to);
    if (!route) {
      entity.route = null;
      return false;
    }
    entity.route = route;
    return true;
  }

  /** Abandon the route and stand still. */
  stopMoving(entityId: number): void {
    const entity = this.getEntity(entityId);
    if (!entity) return;
    entity.route = null;
    entity.intent = null;
  }

  private navFor(areaId: string): Nav {
    const area = this.mustArea(areaId);
    area.nav ??= new Nav(areaCollision(area.def));
    return area.nav;
  }

  /**
   * Advances one tick. Entities are processed in id order — deterministic by
   * construction. Returns per-area events for broadcast.
   */
  step(): Map<string, SimEvent[]> {
    this.tick++;
    const out = new Map<string, SimEvent[]>();
    for (const [areaId, area] of this.areas) {
      let events: SimEvent[] | undefined;
      for (const entity of area.entities.values()) {
        if (entity.route === null || entity.route.length === 0) continue;
        if (this.tick < entity.readyAtTick) continue;
        if (!this.advance(area, entity)) continue;
        entity.posture = 'standing'; // moving implies standing (protocol rule)
        entity.seated = false; // and walking away leaves the seat (D-615)
        (events ??= []).push({
          type: 'entity_moved',
          id: entity.id,
          x: entity.pos.x,
          y: entity.pos.y,
          z: entity.z,
          facing: entity.facing,
        });
      }
      if (events) out.set(areaId, events);
    }
    return out;
  }

  /**
   * Move one tick's worth along the route. Returns whether anything moved.
   *
   * Every step goes through `stepTo`, the same function the editor's overlay
   * and CI's flood use, so a body never ends up somewhere the map says it
   * cannot be.
   *
   * When a step is refused the route is ABANDONED rather than retried: the
   * world has changed under it -- a door shut, somebody stopped in the way --
   * and grinding against an obstacle forever is the judder every player
   * recognises. Whoever wanted to go there can ask again.
   */
  private advance(area: AreaRuntime, entity: WorldEntity): boolean {
    const route = entity.route!;
    // ⚠ A weapon up means a run (D-619). It is read off the entity's own
    // combat flag, which the gateway owns and broadcasts, so the speed a
    // client GLIDES at and the speed the server MOVES at come from one fact.
    let budget = speedFor(entity.combat) / TICK_RATE;
    const layer = areaCollision(area.def);
    let moved = false;
    while (budget > 1e-9 && route.length > 0) {
      const target = route[0]!;
      const gap = distance(entity.pos, target);
      if (gap <= 1e-6) {
        route.shift();
        continue;
      }
      const take = Math.min(budget, gap);
      const to = {
        x: entity.pos.x + ((target.x - entity.pos.x) / gap) * take,
        y: entity.pos.y + ((target.y - entity.pos.y) / gap) * take,
      };
      const next = stepTo(layer, { pos: entity.pos, z: entity.z }, to);
      if (!next) {
        entity.route = null;
        return moved;
      }
      entity.facing = facingOf(entity.pos, to) ?? entity.facing;
      entity.pos = next.pos;
      entity.z = next.z;
      moved = true;
      budget -= take;
      if (take >= gap - 1e-9) route.shift();
    }
    if (route.length === 0) {
      entity.route = null;
      entity.intent = null;
    }
    return moved;
  }

  private mustArea(areaId: string): AreaRuntime {
    const area = this.areas.get(areaId);
    if (!area) throw new Error(`no such area '${areaId}'`);
    return area;
  }
}

/**
 * Stable digest of simulation state, for determinism assertions: two runs
 * from the same seed and intent script must produce identical hashes.
 */
export function hashWorld(world: World): string {
  const parts: string[] = [`tick:${world.tick}`];
  for (const areaId of [...world.areaIds()].sort()) {
    for (const e of world.entitiesIn(areaId).sort((a, b) => a.id - b.id)) {
      parts.push(
        `${areaId}/${e.id}:${e.characterId ?? 'npc'}:${e.pos.x.toFixed(4)},${e.pos.y.toFixed(4)},${e.z.toFixed(3)}:${e.facing}:${e.posture}:${e.presentation}:${e.hp}:${e.ghost ? 'g' : 'l'}:${e.readyAtTick}:${e.intent ?? '-'}`,
      );
    }
  }
  // FNV-1a 64-bit over the canonical string.
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * How far one `move` intent carries. A metre -- what a tile used to be.
 *
 * Held at the old tile size ON PURPOSE, so that converting movement to metres
 * did not silently re-tune every distance in the game at the same time. D-567
 * says range constants are re-measured against play, not converted by
 * arithmetic, and this is the thing that keeps the two changes separable.
 */
const STRIDE = 1;

/**
 * The eight-way facing that best matches a movement.
 *
 * Facing stays a compass direction even though movement no longer is: it picks
 * which animation plays and which way the mesh points, and the art is cut for
 * eight directions (D-561). Null when the movement is too small to mean
 * anything, so a character standing still does not spin.
 */
export function facingOf(from: Vec2, to: Vec2): Direction | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  let best: Direction | null = null;
  let bestDot = -Infinity;
  for (const dir of DIRECTIONS) {
    const v = DIRECTION_VECTORS[dir];
    const len = Math.hypot(v.x, v.y);
    const dot = (dx * v.x + dy * v.y) / len;
    if (dot > bestDot) {
      bestDot = dot;
      best = dir;
    }
  }
  return best;
}
