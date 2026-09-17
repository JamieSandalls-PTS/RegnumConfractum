import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Which atlas a player-chosen face is painted with (D-602).
 *
 * ⚠ The bug this exists to stop: the palette was taken from an outfit drawn
 * out of the appearance SEED. Ten of the twelve built outfits are monsters, so
 * a player's face was textured from a goblin, a skeleton or a rock golem
 * depending on a number nobody chose. It did not read as a wrong texture — the
 * atlases are all the same size and full of plausible colours — it read as
 * "the skin tones do nothing", because the recolour substitutes the four exact
 * colours of the HERO atlas (D-560) and against any other atlas it matched
 * nothing at all.
 *
 * ⚠ Asserted on the MANIFEST rather than on the renderer, because the renderer
 * needs a GPU and this is a fact about what the build produced: how many
 * outfits could answer for a look, and whether they agree about the atlas.
 */

const models = fileURLToPath(new URL('../../client/public/models/', import.meta.url));
const manifestPath = `${models}manifest.json`;

interface Outfit {
  id: string;
  palette: string | null;
  parts: { pack: string } | null;
}

const built = existsSync(manifestPath);
const outfits: Outfit[] = built
  ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { outfits: Outfit[] }).outfits
  : [];

const LOOK_PACK = 'modular-fantasy-hero';

describe.skipIf(!built)('the atlas a chosen face is painted with', () => {
  it('has at least one outfit that can answer for a look', () => {
    // ⚠ If this is ever empty the fallback is the seed again, silently — and
    // the symptom is the one that took four reports to pin down.
    const answerable = outfits.filter((o) => o.parts?.pack === LOOK_PACK);
    expect(answerable.length).toBeGreaterThan(0);
  });

  it('gives every answerable outfit a palette', () => {
    for (const o of outfits.filter((x) => x.parts?.pack === LOOK_PACK)) {
      expect(o.palette).toBeTruthy();
      expect(existsSync(`${models}${o.palette}`)).toBe(true);
    }
  });

  it('never lets a whole-mesh creature answer for a player face', () => {
    // A creature built from one mesh (D-594) has no parts, so it can never be
    // matched by pack — which is what keeps a goblin's atlas off a player.
    const creatures = outfits.filter((o) => !o.parts);
    expect(creatures.length).toBeGreaterThan(0);
    for (const c of creatures) expect(c.parts?.pack).not.toBe(LOOK_PACK);
  });

  it('records how many outfits the old rule could have picked', () => {
    // Not a threshold — a statement of the size of the hole. Ten of twelve
    // were wrong, so this failed for most players most of the time and looked
    // like a feature that did nothing rather than a texture that was wrong.
    const answerable = outfits.filter((o) => o.parts?.pack === LOOK_PACK).length;
    expect(answerable).toBeLessThan(outfits.length);
  });
});
