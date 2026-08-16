import { randomUUID } from 'node:crypto';
import type { Channel, LightingProfile } from '@rc/shared';
import { TICKS_PER_GAME_HOUR } from '../script/host';
import { TICK_RATE } from '@rc/shared';
import type { Store } from '../store/types';
import { EventDocSchema, type EventAction, type EventDoc, type EventTrigger } from './schema';

/**
 * The EventEngine (D-216): interprets DM event documents. Stages arm in
 * order; a stage's trigger is watched only while armed, so "19:00 → spawn
 * the camp → 5 players there → spawn the warband → warlord dies → reward"
 * reads exactly as written.
 *
 * Every run records what it spawned and changed. Rollback undoes it:
 * despawn NPCs, evacuate and remove temp areas, restore lighting. Rehearsal
 * is a normal run that announces itself and expects to be rolled back.
 */

export interface EventEngineGateway {
  spawnNpc(
    areaId: string,
    opts: { x: number; y: number; descriptor: string; appearanceSeed?: number },
  ): number;
  despawnEntity(entityId: number): boolean;
  speakAs(entityId: number, text: string, channel?: Channel): Promise<boolean>;
  narrate(scope: 'global' | 'area', text: string, areaId?: string): void;
  setAreaLighting(areaId: string, lighting: LightingProfile): void;
  getAreaLightingOverride(areaId: string): LightingProfile | null;
  clearAreaLighting(areaId: string): void;
  spawnTempArea(
    fromAreaId: string,
    tempId: string,
    name: string,
    link: { areaId: string; x: number; y: number },
  ): Promise<void>;
  removeTempArea(tempId: string): Promise<void>;
  playerCountIn(areaId: string): number;
}

export interface RunState {
  runId: string;
  eventId: string;
  eventName: string;
  /** Parsed at start — a run is immutable against later edits of the event. */
  doc: EventDoc;
  rehearsal: boolean;
  stageIndex: number;
  armedAtTick: number;
  done: boolean;
  aliases: Map<string, { kind: 'npc'; id: number } | { kind: 'area'; id: string }>;
  spawnedNpcs: number[];
  spawnedAreas: string[];
  /** areaId → previous override (null = authored profile was active). */
  lightingTouched: Map<string, LightingProfile | null>;
}

export class EventEngine {
  private runs: RunState[] = [];
  private currentTick = 0;
  private lastHour = -1;

  constructor(
    private gateway: EventEngineGateway,
    private store: Store,
    private log: (msg: string) => void = () => {},
  ) {}

  listRuns(): { runId: string; eventName: string; stageIndex: number; done: boolean; rehearsal: boolean }[] {
    return this.runs.map((r) => ({
      runId: r.runId,
      eventName: r.eventName,
      stageIndex: r.stageIndex,
      done: r.done,
      rehearsal: r.rehearsal,
    }));
  }

  /** Starts a run at stage 0. Immediate triggers fire before this returns. */
  async start(eventId: string, opts: { rehearsal?: boolean } = {}): Promise<RunState> {
    const record = await this.store.getDmEvent(eventId);
    if (!record) throw new Error(`no such event ${eventId}`);
    const doc = EventDocSchema.parse(record.doc);
    const run: RunState = {
      runId: randomUUID(),
      eventId,
      eventName: doc.name,
      doc,
      rehearsal: opts.rehearsal ?? false,
      stageIndex: 0,
      armedAtTick: this.currentTick,
      done: false,
      aliases: new Map(),
      spawnedNpcs: [],
      spawnedAreas: [],
      lightingTouched: new Map(),
    };
    this.runs.push(run);
    if (run.rehearsal) {
      this.gateway.narrate('global', `[rehearsal] "${doc.name}" begins.`);
    }
    await this.store.appendEvent('dm_event_started', {
      runId: run.runId,
      eventId,
      name: doc.name,
      rehearsal: run.rehearsal,
    });
    await this.pump(run, doc);
    return run;
  }

  /** Advances armed runs; call every server tick. */
  async tick(tick: number): Promise<void> {
    this.currentTick = tick;
    const hour = Math.floor(tick / TICKS_PER_GAME_HOUR) % 24;
    const hourStruck = hour !== this.lastHour;
    this.lastHour = hour;
    for (const run of this.runs) {
      if (run.done) continue;
      const stage = run.doc.stages[run.stageIndex];
      if (!stage) continue;
      if (this.triggerReady(run, stage.trigger, { hour, hourStruck })) {
        await this.fire(run, run.doc);
      }
    }
  }

  /** M4 will call this when entities die; the trigger type exists today. */
  async entityDied(entityId: number): Promise<void> {
    for (const run of this.runs) {
      if (run.done) continue;
      const stage = run.doc.stages[run.stageIndex];
      if (!stage || stage.trigger.type !== 'entity_death') continue;
      const bound = run.aliases.get(stage.trigger.alias);
      if (bound?.kind === 'npc' && bound.id === entityId) await this.fire(run, run.doc);
    }
  }

  async rollback(runId: string): Promise<boolean> {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run) return false;
    for (const npcId of run.spawnedNpcs) this.gateway.despawnEntity(npcId);
    for (const areaId of run.spawnedAreas) await this.gateway.removeTempArea(areaId);
    for (const [areaId, previous] of run.lightingTouched) {
      if (run.spawnedAreas.includes(areaId)) continue; // gone with the area
      if (previous === null) this.gateway.clearAreaLighting(areaId);
      else this.gateway.setAreaLighting(areaId, previous);
    }
    run.done = true;
    if (run.rehearsal) {
      this.gateway.narrate('global', `[rehearsal] "${run.eventName}" rolled back.`);
    }
    await this.store.appendEvent('dm_event_rolled_back', { runId, eventId: run.eventId });
    return true;
  }

  // -------------------------------------------------------------------------

  private triggerReady(
    run: RunState,
    trigger: EventTrigger,
    clock: { hour: number; hourStruck: boolean },
  ): boolean {
    switch (trigger.type) {
      case 'immediate':
        return true;
      case 'at_hour':
        return clock.hourStruck && clock.hour === trigger.hour;
      case 'after_seconds':
        return this.currentTick >= run.armedAtTick + trigger.seconds * TICK_RATE;
      case 'player_count':
        return this.gateway.playerCountIn(this.resolveArea(run, trigger.area)) >= trigger.count;
      case 'entity_death':
        return false; // fires via entityDied() from M4
    }
  }

  /** Fires the current stage's actions, then arms the next stage. */
  private async fire(run: RunState, doc: EventDoc): Promise<void> {
    const stage = doc.stages[run.stageIndex]!;
    for (const action of stage.actions) {
      try {
        await this.execute(run, action);
      } catch (err) {
        this.log(`event '${doc.name}' stage ${run.stageIndex}: ${(err as Error).message}`);
      }
    }
    await this.store.appendEvent('dm_event_stage_fired', {
      runId: run.runId,
      eventId: run.eventId,
      stage: run.stageIndex,
    });
    run.stageIndex += 1;
    run.armedAtTick = this.currentTick;
    if (run.stageIndex >= doc.stages.length) {
      run.done = true;
      if (run.rehearsal) {
        this.gateway.narrate('global', `[rehearsal] "${doc.name}" complete — roll back when done.`);
      }
      return;
    }
    // Chained immediates cascade without waiting a tick.
    const next = doc.stages[run.stageIndex]!;
    if (next.trigger.type === 'immediate') await this.fire(run, doc);
  }

  private async execute(run: RunState, action: EventAction): Promise<void> {
    switch (action.type) {
      case 'narrate': {
        const text = run.rehearsal ? `[rehearsal] ${action.text}` : action.text;
        if (action.scope === 'global') this.gateway.narrate('global', text);
        else this.gateway.narrate('area', text, this.resolveArea(run, action.area ?? ''));
        return;
      }
      case 'spawn_npc': {
        const areaId = this.resolveArea(run, action.area);
        const id = this.gateway.spawnNpc(areaId, {
          x: action.x,
          y: action.y,
          descriptor: action.descriptor,
          ...(action.seed !== undefined ? { appearanceSeed: action.seed } : {}),
        });
        run.spawnedNpcs.push(id);
        if (action.alias) run.aliases.set(action.alias, { kind: 'npc', id });
        return;
      }
      case 'npc_say': {
        const bound = run.aliases.get(action.alias);
        if (bound?.kind !== 'npc') throw new Error(`alias '${action.alias}' is not an npc`);
        await this.gateway.speakAs(bound.id, action.text, action.channel ?? 'say');
        return;
      }
      case 'set_lighting': {
        const areaId = this.resolveArea(run, action.area);
        if (!run.lightingTouched.has(areaId)) {
          run.lightingTouched.set(areaId, this.gateway.getAreaLightingOverride(areaId));
        }
        this.gateway.setAreaLighting(areaId, action.lighting);
        return;
      }
      case 'spawn_area': {
        const tempId = `ev-${run.runId.slice(0, 8)}-${action.alias}`;
        await this.gateway.spawnTempArea(action.from, tempId, action.name, {
          areaId: this.resolveArea(run, action.link.area),
          x: action.link.x,
          y: action.link.y,
        });
        run.spawnedAreas.push(tempId);
        run.aliases.set(action.alias, { kind: 'area', id: tempId });
        return;
      }
      case 'despawn': {
        const bound = run.aliases.get(action.alias);
        if (bound?.kind === 'npc') this.gateway.despawnEntity(bound.id);
        else if (bound?.kind === 'area') await this.gateway.removeTempArea(bound.id);
        return;
      }
    }
  }

  /** `$alias` → the run's spawned area; anything else is a literal areaId. */
  private resolveArea(run: RunState, ref: string): string {
    if (ref.startsWith('$')) {
      const bound = run.aliases.get(ref.slice(1));
      if (bound?.kind !== 'area') throw new Error(`area alias '${ref}' is not bound`);
      return bound.id;
    }
    return ref;
  }

  private async pump(run: RunState, doc: EventDoc): Promise<void> {
    const stage = doc.stages[run.stageIndex];
    if (stage && stage.trigger.type === 'immediate') await this.fire(run, doc);
  }
}
