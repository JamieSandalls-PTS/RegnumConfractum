import { LuaFactory, type LuaEngine } from 'wasmoon';
import { TICK_RATE, type Channel, type Direction, type LightingProfile } from '@rc/shared';

/**
 * The sandboxed Lua layer (D-109) — the NWScript analogue. Scripts attach to
 * areas via content and speak to the world only through the API bound here;
 * os/io/require and friends are stripped before any script runs. A script
 * error is logged and contained — it can never take the server down.
 *
 * Time is TICKS, never the wall clock: `delay`/`every`/`on_hour` all derive
 * from the server tick, so scripted worlds replay deterministically in the
 * harness (D-114).
 */

/** 2 real minutes per game hour — a 48-minute day/night cycle. */
export const TICKS_PER_GAME_HOUR = 2 * 60 * TICK_RATE;

export interface ScriptGateway {
  spawnNpc(
    areaId: string,
    opts: { x: number; y: number; descriptor: string; appearanceSeed?: number },
  ): number;
  despawnEntity(entityId: number): boolean;
  speakAs(entityId: number, text: string, channel?: Channel): Promise<boolean>;
  moveEntity(entityId: number, dir: Direction): void;
  narrate(scope: 'global' | 'area', text: string, areaId?: string): void;
  setAreaLighting(areaId: string, lighting: LightingProfile): void;
  playerCountIn(areaId: string): number;
}

type LuaCallback = (...args: unknown[]) => unknown;

interface Timer {
  atTick: number;
  everyTicks: number | null;
  fn: LuaCallback;
  areaId: string;
}

interface CountTrigger {
  areaId: string;
  threshold: number;
  fn: LuaCallback;
  armed: boolean;
}

const BANNED_GLOBALS = [
  'os', 'io', 'package', 'require', 'dofile', 'loadfile', 'load', 'loadstring', 'debug',
];

export class ScriptHost {
  private factory = new LuaFactory();
  private engines: { areaId: string; engine: LuaEngine }[] = [];
  private timers: Timer[] = [];
  private enterHandlers = new Map<string, LuaCallback[]>();
  private hourHandlers: { hour: number; fn: LuaCallback; areaId: string }[] = [];
  private countTriggers: CountTrigger[] = [];
  private currentTick = 0;
  private lastHour = -1;

  constructor(
    private gateway: ScriptGateway,
    private log: (msg: string) => void = () => {},
  ) {}

  /** Loads and runs an area's scripts inside a fresh sandboxed engine. */
  async loadAreaScripts(areaId: string, sources: { id: string; source: string }[]): Promise<void> {
    if (sources.length === 0) return;
    const engine = await this.factory.createEngine();
    this.engines.push({ areaId, engine });

    // Stripped from within Lua — wasmoon's marshaller rejects JS null.
    await engine.doString(BANNED_GLOBALS.map((name) => `${name} = nil`).join('\n'));

    engine.global.set('spawn_npc', (opts: { x: number; y: number; descriptor: string; seed?: number }) =>
      this.guard(areaId, 'spawn_npc', () =>
        this.gateway.spawnNpc(areaId, {
          x: Number(opts.x),
          y: Number(opts.y),
          descriptor: String(opts.descriptor),
          ...(opts.seed !== undefined ? { appearanceSeed: Number(opts.seed) } : {}),
        }),
      ),
    );
    engine.global.set('despawn', (id: number) =>
      this.guard(areaId, 'despawn', () => this.gateway.despawnEntity(Number(id))),
    );
    engine.global.set('say', (id: number, text: string, channel?: string) => {
      this.guard(areaId, 'say', () => {
        void this.gateway
          .speakAs(Number(id), String(text), (channel as Channel) ?? 'say')
          .catch((err) => this.log(`[script ${areaId}] say failed: ${(err as Error).message}`));
      });
    });
    engine.global.set('move', (id: number, dir: string) =>
      this.guard(areaId, 'move', () => this.gateway.moveEntity(Number(id), dir as Direction)),
    );
    engine.global.set('narrate', (text: string) =>
      this.guard(areaId, 'narrate', () => this.gateway.narrate('area', String(text), areaId)),
    );
    engine.global.set('narrate_global', (text: string) =>
      this.guard(areaId, 'narrate_global', () => this.gateway.narrate('global', String(text))),
    );
    engine.global.set('set_lighting', (profile: string) =>
      this.guard(areaId, 'set_lighting', () =>
        this.gateway.setAreaLighting(areaId, profile as LightingProfile),
      ),
    );
    engine.global.set('player_count', () => this.gateway.playerCountIn(areaId));
    engine.global.set('game_hour', () =>
      Math.floor(this.currentTick / TICKS_PER_GAME_HOUR) % 24,
    );
    engine.global.set('log', (msg: string) => this.log(`[script ${areaId}] ${String(msg)}`));

    engine.global.set('on_enter', (fn: LuaCallback) => {
      let handlers = this.enterHandlers.get(areaId);
      if (!handlers) this.enterHandlers.set(areaId, (handlers = []));
      handlers.push(fn);
    });
    engine.global.set('on_player_count', (threshold: number, fn: LuaCallback) => {
      this.countTriggers.push({ areaId, threshold: Number(threshold), fn, armed: true });
    });
    engine.global.set('on_hour', (hour: number, fn: LuaCallback) => {
      this.hourHandlers.push({ hour: Number(hour) % 24, fn, areaId });
    });
    engine.global.set('delay', (seconds: number, fn: LuaCallback) => {
      this.timers.push({
        atTick: this.currentTick + Math.max(1, Math.round(Number(seconds) * TICK_RATE)),
        everyTicks: null,
        fn,
        areaId,
      });
    });
    engine.global.set('every', (seconds: number, fn: LuaCallback) => {
      const ticks = Math.max(1, Math.round(Number(seconds) * TICK_RATE));
      this.timers.push({ atTick: this.currentTick + ticks, everyTicks: ticks, fn, areaId });
    });

    for (const { id, source } of sources) {
      try {
        await engine.doString(source);
        this.log(`[script ${areaId}] loaded '${id}'`);
      } catch (err) {
        this.log(`[script ${areaId}] '${id}' failed to load: ${(err as Error).message}`);
      }
    }
  }

  /** A player entered an area (fresh spawn or transition). */
  onAreaEntered(areaId: string, entityId: number): void {
    for (const fn of this.enterHandlers.get(areaId) ?? []) {
      this.call(areaId, 'on_enter', fn, entityId);
    }
    this.checkCountTriggers(areaId);
  }

  /** Advances script time; called every server tick. */
  tick(tick: number): void {
    this.currentTick = tick;
    for (const timer of [...this.timers]) {
      if (tick >= timer.atTick) {
        this.call(timer.areaId, 'timer', timer.fn);
        if (timer.everyTicks !== null) timer.atTick = tick + timer.everyTicks;
        else this.timers.splice(this.timers.indexOf(timer), 1);
      }
    }
    const hour = Math.floor(tick / TICKS_PER_GAME_HOUR) % 24;
    if (hour !== this.lastHour) {
      this.lastHour = hour;
      for (const h of this.hourHandlers) {
        if (h.hour === hour) this.call(h.areaId, 'on_hour', h.fn);
      }
    }
  }

  private checkCountTriggers(areaId: string): void {
    const count = this.gateway.playerCountIn(areaId);
    for (const trigger of this.countTriggers) {
      if (trigger.areaId !== areaId) continue;
      if (trigger.armed && count >= trigger.threshold) {
        trigger.armed = false; // re-arms when the crowd thins
        this.call(areaId, 'on_player_count', trigger.fn, count);
      } else if (!trigger.armed && count < trigger.threshold) {
        trigger.armed = true;
      }
    }
  }

  /** Every Lua entry point is guarded: a script error is logged, never thrown. */
  private call(areaId: string, what: string, fn: LuaCallback, ...args: unknown[]): void {
    try {
      fn(...args);
    } catch (err) {
      this.log(`[script ${areaId}] ${what} handler error: ${(err as Error).message}`);
    }
  }

  private guard<T>(areaId: string, what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.log(`[script ${areaId}] ${what} error: ${(err as Error).message}`);
      return undefined;
    }
  }

  dispose(): void {
    for (const { engine } of this.engines) engine.global.close();
    this.engines = [];
    this.timers = [];
    this.enterHandlers.clear();
    this.hourHandlers = [];
    this.countTriggers = [];
  }
}
