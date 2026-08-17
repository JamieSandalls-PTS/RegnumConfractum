/**
 * Legacy Point award (D-207, D-222). Scales with what the character DID —
 * xp earned and deeds performed (meaningful actions, never wall-clock time,
 * so idling overnight earns nothing). Square roots give diminishing returns
 * within a life; the prior-retirement factor gives diminishing returns on
 * repeat sacrifice, so grinding retirements is a losing strategy.
 *
 * Renown weighting (D-222) joins the formula when renown exists (M5+).
 * The hard rule stands regardless: points buy access and flavour, never
 * raw power (D-207).
 */
export function computeLegacyAward(input: {
  xp: number;
  deeds: number;
  priorRetirements: number;
}): number {
  const base = Math.floor(Math.sqrt(Math.max(0, input.xp))) +
    Math.floor(Math.sqrt(Math.max(0, input.deeds)));
  const repeatFactor = 1 / (1 + 0.5 * Math.max(0, input.priorRetirements));
  return Math.max(1, Math.floor(base * repeatFactor));
}
