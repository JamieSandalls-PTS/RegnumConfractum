import type { BotClient } from './botClient';

/**
 * Walking, for tests (D-542, re-cut by D-567).
 *
 * ⚠ This used to run the CLIENT's A* over the tile grid and send one direction
 * per tile. Both halves of that are gone: there is no tile grid, and the route
 * is no longer the caller's to choose. A walker now says where it wants to be
 * and the server finds the way (D-102 — the client sends intent and renders
 * what it is told; deciding the route was always the odd one out).
 *
 * What survives is the reason the A* version existed at all: suites used to
 * greedy-walk — press the direction of the target and hope — and a barrel in
 * the way wedged the walker for four hundred ticks, reported as "never reached
 * (2,28)" rather than "there is a barrel there". Server pathing fixes that
 * properly, and a route it cannot find is now reported as exactly that.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How close counts as arrived, when a caller does not say.
 *
 * ⚠ Exact arrival is not a thing that happens any more, and a caller asking
 * for `within: 0` is speaking tiles. A route ends at the centre of the nearest
 * standable navigation cell, which is within 0.18m of the goal; demanding
 * equality would time out every walk in the suite.
 *
 * ⚠ It also has to be TIGHTER than a doorway's trigger radius. A walker that
 * stops 0.6m short of where it was sent is still standing on a transition it
 * was asked to step off — which is how "step off the marker and step on again"
 * became impossible and the crypt could not be entered.
 */
const ARRIVED = 0.35;

export interface WalkOptions {
  /** Milliseconds between checks. */
  stepMs?: number;
  /** Give up after this long. */
  timeoutMs?: number;
  /** Stop once within this many METRES of the goal (1 = stand beside it). */
  within?: number;
}

function positionOf(bot: BotClient): { x: number; y: number } {
  const me = bot.entities.get(bot.you!);
  if (!me) throw new Error('walker has no self');
  return { x: me.x, y: me.y };
}

const gap = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** Walks the bot to (x, y) — or to within `within` metres of it. */
export async function walkTo(
  bot: BotClient,
  x: number,
  y: number,
  opts: WalkOptions = {},
): Promise<void> {
  const stepMs = opts.stepMs ?? 40;
  const within = Math.max(opts.within ?? 0, ARRIVED);
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  // Crossing a threshold ENDS the walk. A goal is a point in one area, and the
  // same coordinates in the next area are a different place entirely — a
  // walker that carries on after a transition marches across the new map
  // toward a spot it never meant, which is how a test aiming at the tavern
  // ended up stepping onto the crypt's warning marker.
  const startedIn = bot.area?.id ?? null;
  const crossed = (): boolean => startedIn !== null && bot.area?.id !== startedIn;
  /**
   * ⚠ Arriving means STOPPING, and forgetting that cost an hour.
   *
   * A walk finishes when the caller is close enough, which is usually before
   * the route's last waypoint. The server does not know that and keeps walking
   * — so the caller starts harvesting, the character strolls on, and the work
   * cancels because the worker moved (D-529). The test reported "timed out
   * waiting for the work to complete", which points at gathering and not at
   * the walker.
   */
  const arrive = (): void => {
    bot.send({ t: 'move_stop' });
  };

  let last = positionOf(bot);
  let still = 0;
  bot.send({ t: 'move_to', x, y });
  while (Date.now() < deadline) {
    if (crossed()) return;
    const me = positionOf(bot);
    if (gap(me, { x, y }) <= within) return arrive();
    // ⚠ A stall is the only signal that the server found no route: `move_to`
    // refuses silently, because a click on an unreachable spot is an ordinary
    // thing to do with a mouse. One re-ask covers a route abandoned because
    // somebody stood in it; a second stall is a real answer.
    if (gap(me, last) < 1e-3) {
      still++;
      if (still === 8) bot.send({ t: 'move_to', x, y });
      if (still > 20) {
        throw new Error(
          `no route to (${x},${y}) from (${me.x.toFixed(1)},${me.y.toFixed(1)})`,
        );
      }
    } else {
      still = 0;
    }
    last = me;
    await sleep(stepMs);
  }
  const me = positionOf(bot);
  throw new Error(
    `never reached (${x},${y}); stalled at (${me.x.toFixed(1)},${me.y.toFixed(1)})`,
  );
}

/** Walks until standing next to the given point. */
export function walkAdjacentTo(
  bot: BotClient,
  x: number,
  y: number,
  opts: WalkOptions = {},
): Promise<void> {
  return walkTo(bot, x, y, { ...opts, within: 1 });
}

/**
 * Closes on a moving entity until within `within` metres. Returns false if it
 * got away or vanished.
 *
 * ⚠ Re-asks as the target moves, rather than pathing once. A route to where
 * somebody was standing is worth very little by the time you get there.
 */
export async function closeOn(
  bot: BotClient,
  entityId: number,
  within = 1,
  timeoutMs = 12_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const startedIn = bot.area?.id ?? null;
  const reach = Math.max(within, ARRIVED);
  let sinceReask = 0;
  while (Date.now() < deadline) {
    if (startedIn !== null && bot.area?.id !== startedIn) return false;
    const me = bot.entities.get(bot.you!);
    const target = bot.entities.get(entityId);
    if (!me || !target) return false;
    if (gap(me, target) <= reach) {
      bot.send({ t: 'move_stop' });
      return true;
    }
    if (sinceReask <= 0) {
      bot.send({ t: 'move_to', x: target.x, y: target.y });
      sinceReask = 6;
    }
    sinceReask--;
    await sleep(40);
  }
  return false;
}
