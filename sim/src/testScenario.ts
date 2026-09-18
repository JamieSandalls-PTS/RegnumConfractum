import type { loadContent } from '@rc/server/content';

/**
 * Open the round somewhere other than where the shipped scenario says (D-636).
 *
 * The Ashfold scenario opens in the taproom now, because the stakeholder's
 * ruling is that everyone starts in the tavern. A fixture that is ABOUT the
 * town — its watch, its keeper, its storehouse — wants the cast standing in
 * the square when the round begins, and says so here rather than relying on
 * `defaultAreaId`, which stopped deciding where a round opens in D-627.
 */
export function opensIn<C extends ReturnType<typeof loadContent>>(content: C, areaId: string): C {
  for (const sc of content.scenarios) sc.opensIn = areaId;
  return content;
}
