import { AreaSchema, canStandAt, tileProblems, type AreaDef } from '@rc/shared';
import { unreachableTiles } from './validate-content';

/**
 * What must be true before the map editor writes a file (D-543).
 *
 * Split out of `editor-server.ts` so it can be imported without starting an
 * HTTP listener — the guard on the save button is the thing most worth
 * testing about the editor, and a test that has to boot a server to reach it
 * is a test nobody runs.
 *
 * This is deliberately the same reasoning CI uses, not a lighter version of
 * it: the reachability flood blocks on solid props (D-542), so a barrel in a
 * doorway is refused here for exactly the reason it would fail the build.
 */
export function checkAreaForSave(
  doc: unknown,
  /**
   * Every OTHER area, so the check can see the doors pointing this way
   * (D-544). Shrinking a map is the move that orphans them: the tavern going
   * from 64x64 to 32x32 leaves the yard's door aimed at a tile that no longer
   * exists, and the area on its own has no way to know.
   */
  others: readonly AreaDef[] = [],
): { errors: string[]; area?: AreaDef } {
  const parsed = AreaSchema.safeParse(doc);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const area = parsed.data;
  const errors: string[] = [];

  // Tiles are not walls and an unpainted area has no floor (D-638): the
  // editor refuses what the build refuses.
  errors.push(...tileProblems(area));

  const missing = unreachableTiles(area);
  if (missing.length > 0) {
    const sample = missing.slice(0, 4).map((t) => `(${t.x},${t.y})`).join(', ');
    errors.push(
      `${missing.length} walkable tile(s) cannot be reached from the spawn, e.g. ${sample}. `
      + 'Something is walled or crated off.',
    );
  }

  // A transition you cannot stand on is a door that does not open.
  for (const tr of area.transitions) {
    const ch = area.tiles[tr.y]?.[tr.x];
    if (ch === undefined || !area.legend[ch]!.walkable) {
      errors.push(`the exit at (${tr.x},${tr.y}) to '${tr.toArea}' is not on a walkable tile`);
    }
    if (!canStandAt(area, { x: tr.x, y: tr.y })) {
      errors.push(`the exit at (${tr.x},${tr.y}) is blocked by something placed on it`);
    }
  }

  // A facility nobody can stand beside cannot be used (D-530 allows 2 tiles).
  for (const st of area.stations) {
    let usable = false;
    for (let dx = -2; dx <= 2 && !usable; dx++) {
      for (let dy = -2; dy <= 2 && !usable; dy++) {
        const x = st.x + dx;
        const y = st.y + dy;
        const ch = area.tiles[y]?.[x];
        if (ch === undefined || !area.legend[ch]!.walkable) continue;
        if (!canStandAt(area, { x, y })) continue;
        usable = true;
      }
    }
    if (!usable) {
      errors.push(`the ${st.type} at (${st.x},${st.y}) has nowhere to stand within reach`);
    }
  }

  for (const node of area.nodes) {
    if (area.tiles[node.y]?.[node.x] === undefined) {
      errors.push(`the ${node.type} at (${node.x},${node.y}) is off the map`);
    }
  }

  // Doors pointing INTO this area, from everywhere else.
  for (const other of others) {
    if (other.id === area.id) continue;
    for (const tr of other.transitions) {
      if (tr.toArea !== area.id) continue;
      const ch = area.tiles[tr.toY]?.[tr.toX];
      if (ch === undefined) {
        errors.push(
          `'${other.id}' has a door at (${tr.x},${tr.y}) that arrives at `
          + `(${tr.toX},${tr.toY}) — outside this area now. Move that door's `
          + 'target, or keep the map big enough for it.',
        );
      } else if (!area.legend[ch]!.walkable) {
        errors.push(
          `'${other.id}' has a door arriving at (${tr.toX},${tr.toY}), which is `
          + 'no longer a tile anybody can stand on',
        );
      } else if (!canStandAt(area, { x: tr.toX, y: tr.toY })) {
        errors.push(
          `'${other.id}' has a door arriving at (${tr.toX},${tr.toY}), where you `
          + 'have just put solid scenery',
        );
      }
    }
  }

  return { errors, area };
}
