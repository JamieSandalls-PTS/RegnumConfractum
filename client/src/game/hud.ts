import {
  NEED_STAGES,
  type NeedStage,
  ROUND_DAWN_HOUR,
  ROUND_DUSK_HOUR,
} from '@rc/shared';

/**
 * HUD arithmetic (D-548): the compass, the clock face, and the three bars.
 *
 * All of it is pure and lives apart from the DOM for the usual reason — this
 * is the layer that turns server facts into things a player reads at a
 * glance, and a compass that points the wrong way or a bar that fills
 * backwards is a bug nobody would catch by staring at a screenshot.
 */

// ---------------------------------------------------------------------------
// The compass
// ---------------------------------------------------------------------------

/**
 * Where to point the needle, in CSS degrees (clockwise from straight up).
 *
 * Takes the CAMERA-SPACE direction of world north rather than the camera's
 * azimuth, and that is deliberate. Deriving the angle from the azimuth means
 * re-deriving the renderer's handedness by hand — which axis is screen-right,
 * whether tile y runs north or south — and getting it subtly wrong produces a
 * compass that is correct at one rotation and mirrored at another. The scene
 * already knows how to project a world direction; ask it, and the answer is
 * right at every azimuth by construction.
 */
export function compassRotationDeg(cameraSpace: { x: number; y: number }): number {
  if (Math.abs(cameraSpace.x) < 1e-6 && Math.abs(cameraSpace.y) < 1e-6) return 0;
  return (Math.atan2(cameraSpace.x, cameraSpace.y) * 180) / Math.PI;
}

/** Eight-point label for a heading in CSS degrees. Used for the readout. */
export function compassLabel(deg: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const normalized = ((deg % 360) + 360) % 360;
  return points[Math.round(normalized / 45) % 8]!;
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * Hand angles for a classic twelve-hour face, in CSS degrees.
 *
 * `fraction` is how far through the current game hour we are. The server
 * sends only the whole hour (round_state, about once a second), so the minute
 * hand is interpolated client-side — it is cosmetic, its error is bounded by
 * a single game hour, and a minute hand that only ever jumps in twelve-degree
 * steps reads as a broken clock rather than a coarse one.
 *
 * A twelve-hour face cannot tell noon from midnight, which is why `isNight`
 * comes back with it: the caller shades the dial and shows a sun or a moon.
 * That is the honest fix. Squeezing twenty-four hours onto the dial instead
 * would be unambiguous and would stop it being a clock anybody recognises.
 */
export function clockHands(
  hour: number,
  fraction = 0,
): { hourDeg: number; minuteDeg: number; isNight: boolean } {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  const f = Math.max(0, Math.min(1, fraction));
  return {
    hourDeg: ((h % 12) + f) * 30,
    minuteDeg: f * 360,
    isNight: h >= ROUND_DUSK_HOUR || h < ROUND_DAWN_HOUR,
  };
}

/** 24-hour text, for the readout beside the face. */
export function clockText(hour: number): string {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  return `${h.toString().padStart(2, '0')}:00`;
}

// ---------------------------------------------------------------------------
// The bars
// ---------------------------------------------------------------------------

/** 0..1, clamped, and safe when the maximum is zero (a caster with no will). */
export function barFraction(current: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, current / max));
}

/**
 * A need stage as a bar.
 *
 * ⚠ This is a PRESENTATION of a coarse stage, not a continuous value, and the
 * distinction is D-526's: needs are stages precisely so a player watches the
 * room instead of a draining number. The bar therefore moves in visible
 * steps rather than creeping, and the stage's NAME is shown beside it — what
 * is being communicated is "you are getting hungry", not "you are at 61%".
 *
 * `starving` is drawn nearly empty rather than empty, because an empty bar
 * reads as "this mechanic has finished with you" at exactly the point
 * starvation starts doing damage (D-534).
 */
export function needFraction(stage: NeedStage): number {
  const steps = [1, 0.66, 0.33, 0.06];
  return steps[NEED_STAGES.indexOf(stage)] ?? 1;
}

/** What to call the state, beside the bar. */
export function needLabel(need: 'hunger' | 'thirst', stage: NeedStage): string {
  if (stage === 'sated') return need === 'hunger' ? 'fed' : 'watered';
  return stage;
}

/**
 * How urgent a bar looks. Three bands rather than a gradient: a colour that
 * shifts continuously tells a player something is changing when nothing has,
 * and the only question a health bar has to answer at a glance is whether
 * this is fine, bad, or nearly over.
 */
export function barState(fraction: number): 'ok' | 'low' | 'critical' {
  if (fraction <= 0.2) return 'critical';
  if (fraction <= 0.45) return 'low';
  return 'ok';
}
