import {
  DIRECTION_VECTORS,
  MOVE_COOLDOWN_TICKS,
  isDiagonal,
  isTileWalkable,
  type AreaDef,
  type Direction,
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
  appearanceSeed: number;
  pos: Vec2;
  facing: Direction;
  posture: Posture;
  presentation: Presentation;
  /** Tick at which the next tile step may be taken. */
  readyAtTick: number;
  /** Latest movement intent; overwritten by newer intents, cleared when applied. */
  intent: Direction | null;
}

interface AreaRuntime {
  def: AreaDef;
  entities: Map<number, WorldEntity>;
}

/** Wire form for a specific observer — the descriptor is their knowledge. */
export function toWireEntity(e: WorldEntity, descriptor: string): WireEntity {
  return {
    id: e.id,
    descriptor,
    kind: e.characterId === null ? 'npc' : 'player',
    x: e.pos.x,
    y: e.pos.y,
    facing: e.facing,
    posture: e.posture,
    presentation: e.presentation,
    appearanceSeed: e.appearanceSeed,
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
      appearanceSeed?: number;
      pos: Vec2;
      facing?: Direction;
    },
  ): { entity: WorldEntity } {
    const area = this.mustArea(areaId);
    const at = isTileWalkable(area.def, opts.pos) ? opts.pos : area.def.spawn;
    const entity: WorldEntity = {
      id: this.nextEntityId++,
      characterId: opts.characterId,
      name: opts.name,
      ...(opts.npcDescriptor ? { npcDescriptor: opts.npcDescriptor } : {}),
      appearanceSeed: opts.appearanceSeed ?? 0,
      pos: { ...at },
      facing: opts.facing ?? 's',
      posture: 'standing',
      presentation: 'normal',
      readyAtTick: this.tick,
      intent: null,
    };
    area.entities.set(entity.id, entity);
    this.entityArea.set(entity.id, areaId);
    return { entity };
  }

  /** Applies an emote's posture change; returns the broadcast event. */
  setPosture(entityId: number, posture: Posture): SimEvent | null {
    const entity = this.getEntity(entityId);
    if (!entity || entity.posture === posture) return null;
    entity.posture = posture;
    return { type: 'entity_emote', id: entityId, posture, transients: [] };
  }

  despawn(entityId: number): SimEvent | null {
    const areaId = this.entityArea.get(entityId);
    if (areaId === undefined) return null;
    this.mustArea(areaId).entities.delete(entityId);
    this.entityArea.delete(entityId);
    return { type: 'entity_left', id: entityId };
  }

  /** Records intent (D-102). Applied on a subsequent step() when off cooldown. */
  setMoveIntent(entityId: number, dir: Direction): void {
    const entity = this.getEntity(entityId);
    if (entity) entity.intent = dir;
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
        if (entity.intent === null || this.tick < entity.readyAtTick) continue;
        const dir = entity.intent;
        entity.intent = null;
        entity.facing = dir;
        const target = this.moveTarget(area.def, entity.pos, dir);
        if (target === null) continue; // blocked: face the direction, stay put
        entity.pos = target;
        entity.posture = 'standing'; // moving implies standing (protocol rule)
        entity.readyAtTick = this.tick + MOVE_COOLDOWN_TICKS;
        (events ??= []).push({
          type: 'entity_moved',
          id: entity.id,
          x: entity.pos.x,
          y: entity.pos.y,
          facing: entity.facing,
        });
      }
      if (events) out.set(areaId, events);
    }
    return out;
  }

  /**
   * One-tile step in `dir`, or null if blocked. Diagonals require both
   * orthogonal neighbours walkable — no cutting wall corners.
   */
  private moveTarget(def: AreaDef, from: Vec2, dir: Direction): Vec2 | null {
    const v = DIRECTION_VECTORS[dir];
    const to = { x: from.x + v.x, y: from.y + v.y };
    if (!isTileWalkable(def, to)) return null;
    if (isDiagonal(dir)) {
      if (!isTileWalkable(def, { x: from.x + v.x, y: from.y })) return null;
      if (!isTileWalkable(def, { x: from.x, y: from.y + v.y })) return null;
    }
    return to;
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
        `${areaId}/${e.id}:${e.characterId ?? 'npc'}:${e.pos.x},${e.pos.y}:${e.facing}:${e.posture}:${e.presentation}:${e.readyAtTick}:${e.intent ?? '-'}`,
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
