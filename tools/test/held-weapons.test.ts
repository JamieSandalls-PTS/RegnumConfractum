import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AssetFileSchema, ItemTemplateSchema, type CharacterItem } from '@rc/shared';

/**
 * A weapon a player is holding is actually drawn (D-614).
 *
 * ⚠ D-564 fitted 163 weapons into hands by measurement and recorded the grip
 * for each. Nothing in the GAME ever read one: the meshes were never exported
 * for the client, the wire said only `weapon: 'sword'` — the same word for
 * every blade in the game — and `ImportedVisual` had a hand socket it used
 * solely to work out where a projectile leaves from. A player with a sword
 * equipped fought empty-handed, and had done since the imported cast shipped.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const itemDir = `${root}/content/items`;
const assetDir = `${root}/content/assets`;

/** Every fitted grip, by `pack/asset`. */
const grips = new Map<string, CharacterItem>();
for (const file of readdirSync(assetDir)) {
  if (!file.endsWith('.character-item.json')) continue;
  const parsed = AssetFileSchema.parse(JSON.parse(readFileSync(`${assetDir}/${file}`, 'utf8')));
  for (const asset of parsed.assets) {
    if (asset.kind === 'character-item') grips.set(`${parsed.pack}/${asset.id}`, asset);
  }
}

const items = readdirSync(itemDir).map((f) =>
  ItemTemplateSchema.parse(JSON.parse(readFileSync(`${itemDir}/${f}`, 'utf8'))));

describe('every weapon that names art can be put in a hand', () => {
  it('⚠ has a fitted grip for each one', () => {
    // An item naming art nobody has fitted draws NOTHING — silently, exactly
    // like having no weapon. That is the failure this whole decision is about,
    // so it must not be reachable by adding an item.
    const missing = items
      .filter((i) => i.art)
      .map((i) => ({ id: i.id, key: `${i.art!.pack}/${i.art!.asset}` }))
      .filter((r) => !grips.has(r.key));
    expect(missing.map((m) => `${m.id} → ${m.key}`)).toEqual([]);
  });

  it('⚠ hangs each from a bone the rigs actually have', () => {
    // ⚠ Measured against the built characters: every rig here carries Hand_R,
    // Hand_L and lowerarm_l, and none carries `prop_r`. A grip naming a bone
    // that does not exist attaches to nothing and draws nothing — the same
    // silent nothing again.
    const known = new Set(['Hand_R', 'Hand_L', 'lowerarm_l', 'lowerarm_r', 'prop_r']);
    const strays = items
      .filter((i) => i.art)
      .map((i) => ({ id: i.id, grip: grips.get(`${i.art!.pack}/${i.art!.asset}`)! }))
      .filter((r) => r.grip && !known.has(r.grip.attach))
      .map((r) => `${r.id} attaches to '${r.grip.attach}'`);
    expect(strays).toEqual([]);
  });

  it('⚠ gives every fitted weapon a rotation somebody set, not a default', () => {
    // D-564: "a weapon can be wrong in a way no geometric test sees — an
    // un-rotated blade stands upright out of the fist, hits nothing, and
    // measures right." The only defence is that a person turned it.
    const held = items.filter((i) => i.art).map((i) => grips.get(`${i.art!.pack}/${i.art!.asset}`)!);
    // ⚠ The exception is the LEFT HAND, stated as the rule D-564 gives
    // rather than as a list of names: "a shield needs NO rotation -- the left
    // hand's bone frame is the world's at rest". The longbow is held there
    // too and is unrotated for the same reason. Anything in the RIGHT hand
    // must have been turned by somebody.
    const unturned = held
      .filter((g) => g && !/_l$|_L$/.test(g.attach))
      .filter((g) => g.transform.rotation.every((r) => r === 0))
      .map((g) => g.id);
    expect(unturned).toEqual([]);
  });
});

describe('the client is given the meshes', () => {
  const manifest = JSON.parse(
    readFileSync(`${root}/client/public/models/env/manifest.json`, 'utf8'),
  ) as { meshes: Record<string, string> };

  it('⚠ builds a mesh for every weapon an item names', () => {
    // `build:environment` collected only what AREAS, stations and nodes place.
    // An item's art was in no list, so not one weapon was ever built and the
    // client reported "no built mesh" to a console nobody was reading.
    const unbuilt = items
      .filter((i) => i.art)
      .map((i) => `${i.art!.pack}/${i.art!.asset}`)
      .filter((key) => !manifest.meshes[key]);
    expect(unbuilt).toEqual([]);
  });
});
