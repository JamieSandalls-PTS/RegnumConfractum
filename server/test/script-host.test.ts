import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptHost, type ScriptGateway } from '@rc/server/script/host';
import { TICK_RATE } from '@rc/shared';

/**
 * The Lua sandbox (D-109), tested headlessly against a recording gateway:
 * scripts drive the world only through the bound API, time is ticks, errors
 * are contained, and the dangerous stdlib is stripped.
 */

interface Call {
  fn: string;
  args: unknown[];
}

function fakeGateway(calls: Call[]): ScriptGateway {
  let nextId = 100;
  return {
    spawnNpc: (areaId, opts) => {
      calls.push({ fn: 'spawnNpc', args: [areaId, opts] });
      return nextId++;
    },
    despawnEntity: (id) => {
      calls.push({ fn: 'despawn', args: [id] });
      return true;
    },
    speakAs: async (id, text, channel) => {
      calls.push({ fn: 'speakAs', args: [id, text, channel] });
      return true;
    },
    moveEntity: (id, dir) => calls.push({ fn: 'move', args: [id, dir] }),
    narrate: (scope, text, areaId) => calls.push({ fn: 'narrate', args: [scope, text, areaId] }),
    setAreaLighting: (areaId, lighting) =>
      calls.push({ fn: 'lighting', args: [areaId, lighting] }),
    playerCountIn: () => currentCount,
  };
}

let currentCount = 0;
let calls: Call[];
let logs: string[];
let host: ScriptHost;

beforeEach(() => {
  currentCount = 0;
  calls = [];
  logs = [];
  host = new ScriptHost(fakeGateway(calls), (m) => logs.push(m));
});

afterEach(() => host.dispose());

describe('sandboxed Lua host (D-109)', () => {
  it('spawns NPCs at load and fires on_enter handlers', async () => {
    await host.loadAreaScripts('test-area', [
      {
        id: 'warden',
        source: `
          npc = spawn_npc{ x = 3, y = 3, descriptor = "a test warden", seed = 7 }
          on_enter(function(id) say(npc, "halt, " .. id .. "!") end)
        `,
      },
    ]);
    expect(calls).toContainEqual({
      fn: 'spawnNpc',
      args: ['test-area', { x: 3, y: 3, descriptor: 'a test warden', appearanceSeed: 7 }],
    });
    host.onAreaEntered('test-area', 42);
    expect(calls).toContainEqual({ fn: 'speakAs', args: [100, 'halt, 42!', 'say'] });
    // Handlers are area-scoped: another area's arrival does nothing.
    const before = calls.length;
    host.onAreaEntered('elsewhere', 43);
    expect(calls.length).toBe(before);
  });

  it('delay and every run on ticks, deterministically', async () => {
    await host.loadAreaScripts('test-area', [
      {
        id: 'timers',
        source: `
          delay(1, function() narrate("once") end)
          every(2, function() narrate("pulse") end)
        `,
      },
    ]);
    const narrations = () => calls.filter((c) => c.fn === 'narrate').map((c) => c.args[1]);
    for (let t = 1; t <= TICK_RATE * 5; t++) host.tick(t);
    // 5 seconds: "once" fired once; "pulse" at 2s and 4s.
    expect(narrations().filter((n) => n === 'once')).toHaveLength(1);
    expect(narrations().filter((n) => n === 'pulse')).toHaveLength(2);
  });

  it('player-count triggers fire on the crossing and re-arm after', async () => {
    await host.loadAreaScripts('test-area', [
      { id: 'crowd', source: `on_player_count(2, function(c) narrate("crowd " .. c) end)` },
    ]);
    currentCount = 1;
    host.onAreaEntered('test-area', 1);
    expect(calls.filter((c) => c.fn === 'narrate')).toHaveLength(0);
    currentCount = 2;
    host.onAreaEntered('test-area', 2);
    currentCount = 3;
    host.onAreaEntered('test-area', 3); // still over threshold: no re-fire
    expect(calls.filter((c) => c.fn === 'narrate')).toHaveLength(1);
    currentCount = 1; // crowd thins → re-arms
    host.onAreaEntered('test-area', 4);
    currentCount = 2;
    host.onAreaEntered('test-area', 5);
    expect(calls.filter((c) => c.fn === 'narrate')).toHaveLength(2);
  });

  it('strips os/io/require and friends from the sandbox', async () => {
    await host.loadAreaScripts('test-area', [
      {
        id: 'probe',
        source: `
          if os == nil and io == nil and require == nil and dofile == nil
             and loadfile == nil and load == nil and debug == nil and package == nil then
            log("sandbox holds")
          else
            log("SANDBOX LEAK")
          end
        `,
      },
    ]);
    expect(logs.some((l) => l.includes('sandbox holds'))).toBe(true);
    expect(logs.some((l) => l.includes('SANDBOX LEAK'))).toBe(false);
  });

  it('a broken script is contained, and later scripts still load', async () => {
    await host.loadAreaScripts('test-area', [
      { id: 'broken', source: `this is not lua at all (` },
      { id: 'fine', source: `narrate("still alive")` },
    ]);
    expect(logs.some((l) => l.includes("'broken' failed to load"))).toBe(true);
    expect(calls).toContainEqual({ fn: 'narrate', args: ['area', 'still alive', 'test-area'] });
  });

  it('a handler that throws is logged, not fatal', async () => {
    await host.loadAreaScripts('test-area', [
      { id: 'thrower', source: `on_enter(function() error("scripted tantrum") end)` },
    ]);
    expect(() => host.onAreaEntered('test-area', 1)).not.toThrow();
    expect(logs.some((l) => l.includes('on_enter handler error'))).toBe(true);
  });

  it('game_hour advances with ticks and on_hour fires on the crossing', async () => {
    await host.loadAreaScripts('test-area', [
      { id: 'clock', source: `on_hour(1, function() narrate("the bell tolls one") end)` },
    ]);
    const TICKS_PER_HOUR = 2 * 60 * TICK_RATE;
    host.tick(TICKS_PER_HOUR - 1);
    expect(calls.filter((c) => c.fn === 'narrate')).toHaveLength(0);
    host.tick(TICKS_PER_HOUR);
    expect(calls.filter((c) => c.fn === 'narrate')).toHaveLength(1);
    host.tick(TICKS_PER_HOUR + 1); // same hour: no re-fire
    expect(calls.filter((c) => c.fn === 'narrate')).toHaveLength(1);
  });
});
