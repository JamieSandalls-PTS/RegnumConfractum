import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { curatedPartNames } from '@rc/shared';
import { loadContent } from '@rc/server/content';

/**
 * The names a player is shown for the parts they choose (D-560, D-576).
 *
 * ⚠ This test exists because the names were authored, valid, schema-checked in
 * CI, and read by NOTHING the game could see. `content/parts/` was loaded by
 * the naming tool, the studio server and the validator — every one of them an
 * authoring tool — so the creation screen fell back to file stems and offered
 * a face the stakeholder had called "Scarred mouth" as `Head Female 05`.
 *
 * Nothing threw and nothing logged. The only symptom is a player reading
 * filenames, which is exactly the thing D-560 said nothing downstream may do.
 * So the assertion is against the REAL content, end to end: the server loads
 * the file, and every part a race offers arrives named.
 */

const content = loadContent(fileURLToPath(new URL('../../content', import.meta.url)));

describe('the game loads the names, not only the tools (D-576)', () => {
  it('loads content/parts at all', () => {
    expect(content.partNames.size).toBeGreaterThan(0);
  });

  it('names every part the authored races actually offer', () => {
    // ⚠ The property that matters to a player. A curated part with no name is
    // rendered as its stem — legible, but a filename — and today every one of
    // them is named, so any part that arrives unnamed here is either a new
    // curation nobody has named or a name that failed to load.
    const races = [...content.races.values()];
    expect(races.length).toBeGreaterThan(0);
    const named = curatedPartNames(races, content.partNames);
    const offered = new Set(races.flatMap((r) => Object.values(r.parts).flat()));
    const unnamed = [...offered].filter((stem) => named[stem] === undefined);
    expect(unnamed).toEqual([]);
  });

  it('carries the stakeholder\'s own wording through unchanged', () => {
    // A spot check with a name no algorithm would produce from the filename,
    // so this fails if something ever "helpfully" derives labels again.
    expect(content.partNames.get('SK_Chr_Head_Male_03')).toBe('Scarred mouth');
  });
});
